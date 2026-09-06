// Git hook handlers: pre-commit, prepare-commit-msg, pre-push, post-merge, post-checkout.
//
// Moved out of commands/hooks.ts mechanically: the text is unchanged, only its
// home is. Shared helpers still live in hooks.ts and are imported from there.
import { attributionPgrepChecks, resolveAgentDisplayName, sessionMatchesAgent } from '../../agents/registry.js';
import { api } from '../../api.js';
import { clearBudgetLockNotice } from '../../budget-breach.js';
import { isConnectedMode, loadAgentConfig, loadConfig, loadRepoConfig, saveConfig } from '../../config.js';
import { debugLog } from '../../debug-log.js';
import { foldStagedNotes, pushAcceptanceNotes, pushMemoryNotes, shouldIncludePromptText, syncNotesFromRemoteThrottled } from '../../git-notes.js';
import { reconcileSessionBranchWithRemote } from '../../local-entrypoint.js';
import { decidePushBlock } from '../../push-block.js';
import { isNonSecretAssignmentValue, isSkippedScanPath } from '../../secret-rules.js';
import { getGitRoot, gitDirFilePath, listActiveSessions, saveSessionState } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import { listSnapshots } from '../snapshot.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import { RECENCY_TIEBREAK_MARGIN_MS, inFlightEditedFiles, listSessionsForGitHook, safePgrep } from '../hooks.js';


// ─── Git Hook: Pre-Commit (Secret Scan) ──────────────────────────────────

/**
 * Decide whether a policy applies to the commit being made, based on its
 * per-agent assignments. Mirrors shouldSkipPolicy in the server's
 * policy-engine (inverted: returns true when the policy SHOULD enforce):
 *   - no assignments → org-wide, applies to every commit
 *   - assigned → applies only when one of the assigned agents has an
 *     active session in this repo; human commits (no active agent
 *     session) skip agent-scoped policies
 * Exported for tests.
 */
export function policyAppliesToCommit(
  assignedAgents: Array<{ slug?: string | null }> | undefined,
  activeAgentSlugs: Set<string>,
): boolean {
  const assigned = assignedAgents || [];
  if (assigned.length === 0) return true;
  return assigned.some((a) => !!a.slug && activeAgentSlugs.has(a.slug.toLowerCase()));
}

/**
 * Called by .git/hooks/pre-commit.
 * Scans staged diff for hardcoded secrets, API keys, and credentials.
 * Exits with code 1 to block the commit if secrets are found.
 */
/**
 * Pure decision for the pre-commit budget gate. Exported for tests.
 *
 * Blocks when any candidate Origin session for this repo/worktree is
 * flagged budgetBlocked. Sessions only exist for AI agents, so a plain
 * human commit in a repo with no locked AI session passes untouched.
 * ORIGIN_BUDGET_OVERRIDE=1 is the documented emergency escape hatch
 * (same as the prompt/tool gates).
 */
export function preCommitBudgetDecision(
  sessions: Array<Pick<SessionState, 'sessionId' | 'budgetBlocked' | 'budgetBlockReason'>>,
  overrideEnv: string | undefined,
): { block: boolean; reason: string } {
  if (overrideEnv === '1') return { block: false, reason: '' };
  const locked = sessions.find((s) => s.budgetBlocked);
  if (!locked) return { block: false, reason: '' };
  return {
    block: true,
    reason:
      `[Origin Budget] Commit blocked — ${locked.budgetBlockReason || 'hard budget cap exceeded'}. ` +
      `New AI work is locked until the cap resets or an admin raises it. ` +
      `Emergency override: ORIGIN_BUDGET_OVERRIDE=1 git commit ...`,
  };
}

/** A clone passes an all-zero previous HEAD (40 hex chars for sha1, 64 for sha256). */
export function isNullRef(ref: string): boolean {
  return /^0+$/.test(ref) && ref.length >= 40;
}

/**
 * git post-checkout. Two jobs, told apart by the previous HEAD:
 *
 *  - **Fresh clone** (previous HEAD is the null ref) → fetch attribution notes.
 *    `git clone` fetches refs/heads/* and refs/tags/* and nothing else, so
 *    refs/notes/origin never comes down with it and a new teammate — or an agent
 *    cloning the repo — sees no attribution at all. Git does run post-checkout
 *    after a clone, and Origin's hooks are global (core.hooksPath), so this fires
 *    even in a repo nobody ran `origin enable` in.
 *
 *  - **Any other branch checkout** → the pre-existing stash/attribution
 *    preservation. Note this only reaches machines with global hooks now that the
 *    global dir has a post-checkout at all: `core.hooksPath` makes git ignore
 *    .git/hooks entirely, so the repo-local hook history-preservation installs
 *    never ran for them.
 *
 * Git passes flag=1 for ordinary branch switches, not just clones, so the flag
 * alone can't distinguish them — the null-ref previous HEAD is the clone tell.
 *
 * Never throws: this runs inside someone's `git clone`/`git checkout`, and a hook
 * that fails or hangs makes git look broken in a repo unrelated to Origin.
 */
/**
 * post-merge: fold the Origin metadata that this `git pull` just brought down.
 *
 * By the time git runs post-merge, the fetch half of the pull is already done —
 * and because ORIGIN_NOTES_GLOB_REFSPEC is a configured fetchspec, that fetch
 * carried every refs/notes/origin* into the staging namespace with it. So this
 * hook does NOT touch the network; it only merges staging onto the live refs,
 * which is what makes the data visible to `origin blame`, `origin context
 * memory` and the SessionStart context block.
 *
 * If the glob refspec isn't configured yet (a repo whose last sync predates this
 * release), fall back to the throttled full sync so the repo self-heals on the
 * first pull instead of waiting for a SessionStart.
 *
 * Never throws: this runs inside someone's `git pull`.
 */
export async function handleGitPostMerge(): Promise<void> {
  try {
    const repoPath = getGitRoot(process.cwd());
    if (!repoPath) return;

    // Fold first: purely local, and with the glob fetchspec configured the pull
    // has already staged everything this needs.
    const changed = foldStagedNotes(repoPath);

    // Nothing folded? Two cases, both fixed by the throttled sync:
    //   - The pull NAMED a refspec (`git pull origin main`). Git then uses that
    //     refspec INSTEAD of the configured fetchspecs, so the glob never ran
    //     and nothing was staged. Agents write this form constantly.
    //   - The repo predates this release and has no glob refspec yet.
    // The sync is 6h-throttled per repo, so the steady state costs one stat().
    if (!changed) syncNotesFromRemoteThrottled(repoPath);

    debugLog('post-merge', 'notes folded', { repoPath, changed });
  } catch {
    // Never fail a pull.
  }
}

export async function handleGitPostCheckout(prevHead: string, newHead: string, flag: string): Promise<void> {
  try {
    if (flag !== '1') return; // file checkout — neither job applies

    const repoPath = getGitRoot(process.cwd());
    if (!repoPath) return;

    if (isNullRef(prevHead || '')) {
      debugLog('post-checkout', 'fresh clone detected — syncing notes', { repoPath });
      // Installs the persistent (staging) refspec, fetches, and merges -s ours.
      // Throttled so this and a SessionStart moments later don't both fetch.
      syncNotesFromRemoteThrottled(repoPath);
      return;
    }

    const { handlePostCheckout } = await import('../../history-preservation.js');
    handlePostCheckout(repoPath, prevHead, newHead);
  } catch {
    // Never fail a checkout.
  }
}

export async function handlePreCommit(): Promise<void> {
  debugLog('pre-commit', '=== GIT HOOK INVOKED ===', { pid: process.pid, cwd: process.cwd() });

  const config = loadConfig();
  const hookCwd = process.cwd();
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('pre-commit', 'SKIP: not a git repo');
    return;
  }

  // ── 0. Budget hard-cap gate — the agent-agnostic choke point ─────────
  // Hook-protocol blocking (exit 2 on prompt/tool hooks) only works for
  // Claude Code and Gemini; Codex and Cursor ignore it. Git itself,
  // however, honors a non-zero pre-commit exit no matter which agent is
  // driving — so this is where a breached hard cap actually stops work
  // from landing for EVERY agent. The lockout flag comes from session
  // state (stamped by the heartbeat ping, the session PATCH path, or the
  // 429-refused session-start fallback). Worktree-aware lookup so an
  // agent committing from a sibling worktree is still matched.
  try {
    const candidates = listSessionsForGitHook(hookCwd);
    const lockedCandidate = candidates.find((s) => s.budgetBlocked);
    if (lockedCandidate && isConnectedMode()) {
      // Re-check the server while locked (mirrors enforceBudgetLockout):
      // the block must lift the moment an admin raises the cap or the
      // period resets — a stale flag in a lingering state file must not
      // keep blocking commits. On re-check failure keep blocking; the
      // last confirmed server state was "blocked".
      try {
        const status = await api.getBudgetStatus(
          lockedCandidate.sessionId && !lockedCandidate.sessionId.startsWith('local-')
            ? lockedCandidate.sessionId
            : undefined,
        );
        if (!status.blocked) {
          lockedCandidate.budgetBlocked = false;
          lockedCandidate.budgetBlockReason = undefined;
          try { saveSessionState(lockedCandidate, lockedCandidate.repoPath || repoPath, lockedCandidate.sessionTag); } catch { /* non-fatal */ }
          clearBudgetLockNotice(lockedCandidate.repoPath || repoPath);
          debugLog('pre-commit', 'budget lockout lifted by server re-check');
        } else if (status.message) {
          lockedCandidate.budgetBlockReason = status.message;
        }
      } catch { /* keep blocking on re-check failure */ }
    }
    const decision = preCommitBudgetDecision(candidates, process.env.ORIGIN_BUDGET_OVERRIDE);
    if (decision.block) {
      debugLog('pre-commit', 'BLOCKED by budget lockout', { reason: decision.reason });
      process.stderr.write('\n' + decision.reason + '\n\n');
      process.exit(1);
    }
  } catch (gateErr: any) {
    // The gate must never break commits on its own bugs — fall through
    // to the normal policy checks.
    debugLog('pre-commit', 'budget gate check failed (non-fatal)', { message: gateErr?.message });
  }

  const repoConfig = loadRepoConfig(repoPath);

  const execOpts = {
    encoding: 'utf-8' as const,
    // hookCwd, NOT repoPath: git runs pre-commit from the top of the working
    // tree where the commit is happening. For a linked-worktree commit,
    // repoPath (getGitRoot collapses to the MAIN repo) has a different
    // index — reading `git diff --cached` there scanned the wrong (usually
    // empty) staged set, so CONTENT_FILTER/secret policies never ran on
    // worktree commits.
    cwd: hookCwd,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
  };

  // Get staged diff (full context for CONTENT_FILTER matching)
  let stagedDiff: string;
  try {
    stagedDiff = execFileSync('git', ['diff', '--cached'], execOpts).trim();
  } catch (err: any) {
    debugLog('pre-commit', 'ERROR: cannot read staged diff', { message: err.message });
    return; // Don't block on error
  }

  if (!stagedDiff) {
    debugLog('pre-commit', 'SKIP: empty staged diff');
    return;
  }

  // Get staged file list
  let stagedFiles: string[] = [];
  try {
    const raw = execFileSync('git', ['diff', '--cached', '--name-only'], execOpts).trim();
    stagedFiles = raw ? raw.split('\n') : [];
  } catch { /* ignore */ }

  // Get the commit message (from COMMIT_EDITMSG if available — works for commit-msg hook chain)
  // gitDirFilePath: a worktree commit's COMMIT_EDITMSG lives in the
  // per-worktree git dir, not at <mainRepo>/.git/.
  let commitMessage = '';
  try {
    const msgFile = gitDirFilePath(hookCwd, 'COMMIT_EDITMSG');
    if (fs.existsSync(msgFile)) {
      commitMessage = fs.readFileSync(msgFile, 'utf-8').trim();
    }
  } catch { /* ignore */ }

  // ── Collect all violations from all policy checkers ──
  interface PolicyViolation {
    policyName: string;
    policyType: string;
    policyId?: string;
    ruleId?: string;
    action: string;
    severity: string;
    message: string;
  }
  const violations: PolicyViolation[] = [];

  // ── 1. Secret scanning (built-in, always runs unless disabled) ──
  if (config?.secretScan !== false && repoConfig?.secretScan !== false) {
    const addedLines = parseStagedDiffLines(stagedDiff);
    const seen = new Set<string>();

    for (const entry of addedLines) {
      // Skip build artifacts and vendor bundles
      if (isSkippedScanPath(entry.file)) continue;
      const trimmed = entry.content.trim();
      if (trimmed.length < 5) continue;
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) continue;

      for (const pattern of PRE_COMMIT_PATTERNS) {
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(entry.content);
        if (match) {
          const matchedValue = match[1] || match[0];
          // Generic name-based rules only — see isNonSecretAssignmentValue.
          if (GENERIC_ASSIGNMENT_RULES.has(pattern.name)
              && isNonSecretAssignmentValue(matchedValue, pattern.name === 'Password Assignment')) continue;
          const key = `${entry.file}:${entry.line}:${matchedValue}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const redacted = matchedValue.length <= 8
            ? '****'
            : matchedValue.slice(0, 4) + '****' + matchedValue.slice(-4);

          violations.push({
            policyName: 'Secret Detection',
            policyType: 'SECRET_SCAN',
            action: 'BLOCK',
            severity: mapFindingSeverity(pattern.name).toUpperCase(),
            message: `${pattern.name} in ${entry.file}:${entry.line} — ${redacted}`,
          });
        }
      }
    }
  }

  // ── 2. Fetch org policies from Origin API and enforce locally ──
  const connected = isConnectedMode();
  if (connected) {
    try {
      const policies = await api.getPolicies() as Array<{
        id: string;
        name: string;
        type: string;
        assignedAgents?: Array<{ id: string; name: string; slug: string }>;
        rules: Array<{
          id: string;
          condition: string;
          action: string;
          severity: string;
          agentId: string | null;
          machineId: string | null;
          repoId: string | null;
        }>;
      }>;

      // Active AI session agent(s) in this repo — the scope context for
      // per-agent policy assignments. Empty set = human commit (no agent
      // session running here).
      const activeAgentSlugs = new Set(
        listActiveSessions(repoPath)
          .map((s) => (s.agentSlug || '').toLowerCase())
          .filter(Boolean),
      );

      for (const policy of policies) {
        // Honor per-agent assignments — mirrors shouldSkipPolicy in the
        // server's policy-engine. No assignments = org-wide, enforce for
        // every commit. Assigned = enforce only when one of the assigned
        // agents has an active session in this repo; human commits (no
        // active agent session) skip agent-scoped policies. Without this
        // filter, a policy scoped to specific agents blocked EVERY commit
        // in the org, including hand-typed ones.
        if (!policyAppliesToCommit(policy.assignedAgents, activeAgentSlugs)) {
          debugLog('pre-commit', 'skipping agent-scoped policy (no assigned agent active)', {
            policy: policy.name,
            assigned: (policy.assignedAgents || []).map((a) => a.slug),
            active: [...activeAgentSlugs],
          });
          continue;
        }

        for (const rule of policy.rules) {
          let cond: Record<string, any> = {};
          try { cond = JSON.parse(rule.condition); } catch { continue; }

          switch (policy.type) {
            case 'FILE_RESTRICTION': {
              const pathPattern = cond.path as string | undefined;
              if (pathPattern) {
                for (const file of stagedFiles) {
                  if (matchGlobPreCommit(pathPattern, file)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `File "${file}" matches restricted pattern "${pathPattern}"`,
                    });
                    break; // one match per rule is enough
                  }
                }
              }
              break;
            }

            case 'CONTENT_FILTER': {
              const pattern = cond.pattern as string | undefined;
              if (pattern) {
                try {
                  const flags = (cond.caseSensitive === false) ? 'gi' : 'g';
                  const regex = new RegExp(pattern, flags);
                  const matches = stagedDiff.match(regex);
                  if (matches && matches.length > 0) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `Diff content matches "${pattern}" (${matches.length} match${matches.length !== 1 ? 'es' : ''})`,
                    });
                  }
                } catch { /* invalid regex */ }
              }
              break;
            }

            case 'COMMIT_MESSAGE': {
              if (!commitMessage) break;
              const requiredPattern = cond.pattern as string | undefined;
              const blockedPattern = cond.blocked_pattern as string | undefined;

              if (requiredPattern) {
                try {
                  const regex = new RegExp(requiredPattern);
                  if (!regex.test(commitMessage)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `Commit message does not match required format "${requiredPattern}"`,
                    });
                  }
                } catch { /* invalid regex */ }
              }

              if (blockedPattern) {
                try {
                  const flags = (cond.caseSensitive === false) ? 'i' : '';
                  const regex = new RegExp(blockedPattern, flags);
                  if (regex.test(commitMessage)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: rule.action,
                      severity: rule.severity,
                      message: `Commit message matches blocked pattern "${blockedPattern}"`,
                    });
                  }
                } catch { /* invalid regex */ }
              }
              break;
            }

            case 'REQUIRE_REVIEW': {
              // Check file path patterns only at pre-commit (cost/duration not available yet)
              const pathPattern = cond.path as string | undefined;
              if (pathPattern) {
                for (const file of stagedFiles) {
                  if (matchGlobPreCommit(pathPattern, file)) {
                    violations.push({
                      policyName: policy.name,
                      policyType: policy.type,
                      policyId: policy.id,
                      ruleId: rule.id,
                      action: 'REQUIRE_REVIEW',
                      severity: rule.severity,
                      message: `File "${file}" matches review pattern "${pathPattern}" — manual review required`,
                    });
                    break;
                  }
                }
              }
              break;
            }

            // COST_LIMIT and MODEL_ALLOWLIST not applicable at pre-commit time
          }
        }
      }
    } catch (err: any) {
      debugLog('pre-commit', 'Policy fetch failed (non-fatal)', { message: err.message });
      // Don't block on API failure — just skip policy checks
    }
  }

  // ── No violations? Pass. ──
  if (violations.length === 0) {
    debugLog('pre-commit', 'PASS: no violations');
    return;
  }

  // ── Report violations to API (Security tab) ──
  if (connected) {
    try {
      const sessions = listActiveSessions(repoPath);
      const activeSession = sessions[0];
      const sessionId = activeSession?.sessionId;

      // Report secret findings
      const secretFindings = violations.filter(v => v.policyType === 'SECRET_SCAN');
      if (sessionId && secretFindings.length > 0) {
        await api.reportSecrets(sessionId, secretFindings.map(f => ({
          type: 'GENERIC_SECRET',
          severity: f.severity.toLowerCase(),
          filePath: f.message.split(' in ')[1]?.split(' —')[0] || '',
          lineNumber: 0,
          match: f.message,
          ruleName: f.policyName,
        }))).catch(() => {});
      }

      // Report policy violations. policyType rides along so the stats
      // violations-by-type histogram attributes these correctly — without
      // it, every pre-commit report landed in the "UNKNOWN" bucket.
      const policyViolations = violations.filter(v => v.policyId);
      for (const v of policyViolations) {
        await api.reportViolation({
          machineId: config?.machineId || 'unknown',
          policyId: v.policyId!,
          policyType: v.policyType,
          policyName: v.policyName,
          description: `[pre-commit] ${v.message}`,
          filepath: stagedFiles[0] || undefined,
          sessionId: sessionId && !sessionId.startsWith('local-') ? sessionId : undefined,
        }).catch(() => {});
      }
    } catch (err: any) {
      debugLog('pre-commit', 'API report failed (non-fatal)', { message: err.message });
    }
  }

  // ── Check if any violations have BLOCK action ──
  const blockingViolations = violations.filter(
    v => v.action.toUpperCase() === 'BLOCK' || v.policyType === 'SECRET_SCAN'
  );
  const warningViolations = violations.filter(
    v => v.action.toUpperCase() !== 'BLOCK' && v.policyType !== 'SECRET_SCAN'
  );

  // Show warnings (non-blocking)
  if (warningViolations.length > 0) {
    process.stderr.write('\n');
    process.stderr.write('\x1b[1;33m  ⚠ Origin: policy warnings\x1b[0m\n');
    process.stderr.write('\n');
    for (const v of warningViolations) {
      process.stderr.write(`\x1b[33m    [${v.policyType}] ${v.policyName}\x1b[0m\n`);
      process.stderr.write(`    ${v.message}\n\n`);
    }
  }

  // Block commit if any blocking violations
  if (blockingViolations.length > 0) {
    process.stderr.write('\n');
    process.stderr.write('\x1b[1;31m  ✗ Origin: commit blocked by policy\x1b[0m\n');
    process.stderr.write('\n');

    for (const v of blockingViolations) {
      process.stderr.write(`\x1b[31m    [${v.policyType}] ${v.policyName}\x1b[0m\n`);
      process.stderr.write(`    ${v.message}\n\n`);
    }

    process.stderr.write(`\x1b[33m  ${blockingViolations.length} violation${blockingViolations.length !== 1 ? 's' : ''} found. Commit blocked.\x1b[0m\n`);
    process.stderr.write('\n');
    process.stderr.write('\x1b[2m  To bypass: git commit --no-verify\x1b[0m\n');
    process.stderr.write('\n');

    process.exit(1);
  }
}

export function mapFindingSeverity(name: string): string {
  const critical = ['AWS Access Key', 'AWS Secret Key', 'Private Key', 'GitHub Token', 'GitHub PAT', 'Connection String'];
  const high = ['OpenAI Key', 'Anthropic Key', 'Stripe Key', 'Slack Token', 'JWT Token', 'API Key', 'Hardcoded Password'];
  if (critical.includes(name)) return 'critical';
  if (high.includes(name)) return 'high';
  return 'medium';
}

// The four GENERIC assignment rules below (`*_KEY=`, `*_TOKEN=`, `*_SECRET=`,
// `*_PASSWORD=`) match on the NAME of the thing being assigned, so they fire on
// any 10+ character value. The predicate that filters those is shared with the
// server-side scanner — see ../secret-rules.js for the reasoning and for why it
// is a generated copy rather than a shared package.
export const GENERIC_ASSIGNMENT_RULES = new Set([
  'Token Assignment', 'Secret Assignment', 'Key Assignment', 'Password Assignment',
]);

// Patterns for pre-commit scanning (non-global flags for single match per line)
// Patterns are exported as a named const so the test file can iterate them and
// so the README's advertised count can be regenerated with a one-liner:
//   node -e "console.log(require('./dist/commands/hooks').PRE_COMMIT_PATTERNS.length)"
export const PRE_COMMIT_PATTERNS = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Key', regex: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})/i },
  { name: 'Private Key', regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/ },
  { name: 'GitHub Token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/ },
  { name: 'GitHub PAT', regex: /github_pat_[A-Za-z0-9_]{50,}/ },
  { name: 'OpenAI Key', regex: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'Anthropic Key', regex: /sk-ant-[A-Za-z0-9-]{32,}/ },
  { name: 'Stripe Key', regex: /sk_(?:live|test)_[A-Za-z0-9]{24,}/ },
  { name: 'Slack Token', regex: /xox[bpors]-[0-9]{10,}-[a-zA-Z0-9-]+/ },
  { name: 'JWT Token', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/ },
  { name: 'Connection String', regex: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s'"]{10,}/i },
  { name: 'API Key', regex: /(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*['"]([a-zA-Z0-9_\-]{20,})['"]/ },
  { name: 'Hardcoded Password', regex: /(?:password|passwd|pwd|db_password)\s*[:=]\s*['"]?([^'"\s]{8,})['"]?/i },
  { name: 'npm Token', regex: /npm_[A-Za-z0-9]{36,}/ },
  { name: 'Bearer Token', regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
  // Generic *_TOKEN=, *_SECRET=, *_KEY=, *_PASSWORD= assignments
  { name: 'Token Assignment', regex: /\w+_TOKEN\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{10,})['"]?/i },
  { name: 'Secret Assignment', regex: /\w+_SECRET\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{10,})['"]?/i },
  { name: 'Key Assignment', regex: /\w+_(?:API_?)?KEY\s*[:=]\s*['"]?([A-Za-z0-9_\-/.+=]{10,})['"]?/i },
  { name: 'Password Assignment', regex: /\w+_PASSWORD\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/i },
  // ── Cloud provider credentials ──
  { name: 'GCP Service Account', regex: /"type"\s*:\s*"service_account"[\s\S]{0,500}"private_key"\s*:/ },
  { name: 'GCP API Key', regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Azure Storage Key', regex: /(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/=]{64,})/ },
  { name: 'Cloudflare API Token', regex: /(?:cloudflare[_-]?api[_-]?token|CF_API_TOKEN)\s*[:=]\s*['"]?([A-Za-z0-9_-]{40})['"]?/i },
  // ── Comms / messaging ──
  { name: 'Twilio Account SID', regex: /\bAC[a-f0-9]{32}\b/ },
  { name: 'Twilio Auth Token', regex: /\bSK[a-f0-9]{32}\b/ },
  { name: 'SendGrid API Key', regex: /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{43,}/ },
  { name: 'Mailgun Key', regex: /\bkey-[a-f0-9]{32}\b/ },
  { name: 'Discord Bot Token', regex: /[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/ },
  { name: 'Telegram Bot Token', regex: /\b\d{9,10}:[A-Za-z0-9_-]{35}\b/ },
  // ── Infrastructure / PaaS ──
  { name: 'DigitalOcean Token', regex: /\bdop_v1_[a-f0-9]{64}\b/ },
  { name: 'Heroku API Key', regex: /(?:heroku[_-]?api[_-]?key|HEROKU_API_KEY)\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/i },
  { name: 'Firebase Server Key', regex: /AAAA[A-Za-z0-9_-]{7}:APA91b[A-Za-z0-9_-]{100,}/ },
  // ── Payments ──
  { name: 'Square Token', regex: /\bsq0(?:atp|csp|idp)-[A-Za-z0-9_-]{22,}\b/ },
  { name: 'PayPal Access Token', regex: /access_token\$production\$[a-z0-9]{16}\$[a-f0-9]{32}/ },
  // ── Observability / APM ──
  { name: 'Datadog API Key', regex: /(?:dd[_-]?api[_-]?key|DATADOG_API_KEY)\s*[:=]\s*['"]?([a-f0-9]{32})['"]?/i },
  { name: 'Datadog App Key', regex: /(?:dd[_-]?app[_-]?key|DATADOG_APP_KEY)\s*[:=]\s*['"]?([a-f0-9]{40})['"]?/i },
  { name: 'New Relic Key', regex: /\bNRAK-[A-Z0-9]{27}\b/ },
  { name: 'PagerDuty Key', regex: /(?:pagerduty[_-]?api[_-]?key|PAGERDUTY_API_KEY)\s*[:=]\s*['"]?([yuzn][A-Za-z0-9_-]{19,})['"]?/i },
  // ── Dev tools ──
  { name: 'Snyk Token', regex: /(?:snyk[_-]?token|SNYK_TOKEN)\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/i },
  { name: 'npmrc Auth', regex: /\/\/[^/\s]+\/:_authToken=([A-Za-z0-9_+=-]{16,})/ },
  // ── Generic high-value ──
  { name: 'Password Hash', regex: /\w+_PASSWORD_HASH\s*[:=]\s*['"]?(\$2[aby]?\$[0-9]{2}\$[A-Za-z0-9./]{53}|[A-Za-z0-9+/=]{40,})['"]?/i },
];

// Glob pattern matching for pre-commit policy checks
export function matchGlobPreCommit(pattern: string, filepath: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(filepath);
}

// Parse staged diff into file + line + content entries
export function parseStagedDiffLines(diff: string): Array<{ file: string; line: number; content: string }> {
  const lines = diff.split('\n');
  const result: Array<{ file: string; line: number; content: string }> = [];
  let currentFile = '';
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('Binary ')) continue;

    if (line.startsWith('+') && !line.startsWith('++')) {
      result.push({ file: currentFile, line: currentLine, content: line.slice(1) });
      currentLine++;
      continue;
    }

    if (!line.startsWith('-')) {
      currentLine++;
    }
  }

  return result;
}

// ─── Git Hook: Pre-Push (F14) ─────────────────────────────────────────────

// ─── Git Hook: Prepare-Commit-Msg ────────────────────────────────────────
//
// Fires BEFORE the commit is made, so the trailer is part of the commit from
// the start. Replaces the old post-commit `--amend --no-verify` dance which
// mutated commit SHAs, bypassed the secret scanner, and invalidated GPG
// signatures. See docs/notes/SUBAGENT_AUDIT.md for the amend rationale and
// its removal.
//
// Invocation: `origin hooks git-prepare-commit-msg <msgFile> [source] [sha]`
//   msgFile — path to .git/COMMIT_EDITMSG
//   source  — one of: message, template, merge, squash, commit (optional)
//   sha     — commit SHA when source=commit (rebase/amend) (optional)
//
// Skip conditions:
//   • source=merge  — merge commit; user didn't write this message
//   • source=squash — squash merge; combining existing commits
//   • source=commit — rebase or --amend; already has trailers if applicable

/**
 * Resolve an agent display name from a model identifier.
 * Kept alongside the legacy post-commit block for consistency.
 */
// (resolveAgentDisplayName moved to agents/registry.ts)

/**
 * Build the Origin trailer lines for a session. Returns array of
 * "Name: Value" strings (no trailing newlines). Each line is suitable for
 * `git interpret-trailers --trailer=<line>`.
 *
 * Exported for testing.
 */
export function buildOriginTrailers(
  sessionId: string,
  model: string | undefined,
  promptCount: number,
  latestSnapshotId?: string | null,
  agentSlug?: string,
  subagentCount = 0,
): string[] {
  const shortId = sessionId.slice(0, 12);
  const agentName = resolveAgentDisplayName(model, agentSlug);
  const parts = [shortId, agentName];
  if (promptCount > 0) parts.push(promptCount === 1 ? '1 prompt' : `${promptCount} prompts`);
  if (subagentCount > 0) parts.push(subagentCount === 1 ? '1 sub-agent' : `${subagentCount} sub-agents`);
  const trailers: string[] = [`Origin-Session: ${parts.join(' | ')}`];
  if (latestSnapshotId) trailers.push(`Origin-Snapshot: ${latestSnapshotId}`);
  return trailers;
}

// Files staged for the in-flight commit — the ground truth for "what is being
// committed", used to attribute the commit to the session that produced them.
export function stagedCommitFiles(repoPath: string): string[] {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only'], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }
}

// The set of files a session changed — from its recorded per-prompt mappings
// and/or a name-only diff against its baseline (the session-start shadow, or
// the session-start HEAD). Used to match a commit to the session that made it.
export function sessionTouchedFiles(state: SessionState, repoPath: string): Set<string> {
  const files = new Set<string>();
  // Prefer the precise per-session file list the agent's own capture recorded.
  for (const pm of (state.completedPromptMappings || [])) {
    for (const f of (pm?.filesChanged || [])) if (typeof f === 'string') files.add(f);
  }
  // The turn that is running RIGHT NOW is the one most likely committing, and
  // its writes are not in any completed mapping yet.
  for (const f of inFlightEditedFiles(state as any)) files.add(f);
  if (files.size > 0) return files;
  // A session that has not had a single prompt has done no work; the
  // working-tree fallback below would hand it every dirty file in the tree.
  // Prod vodka 2c82b8a: the previous Claude conversation was re-opened nine
  // seconds after the real one started, recorded no prompt, and its "touched
  // files" — the other session's uncommitted work — tied the overlap score,
  // which sent the decision to process detection and a Codex zombie.
  if ((state.prompts || []).length === 0) return files;
  // Fallback (no recorded mappings): diff the working tree against the session's
  // baseline. Only meaningful when the baseline is the session's OWN start
  // shadow — a shared clean HEAD would sweep in other sessions' edits.
  const base = state.sessionStartShadowSha || state.headShaAtStart;
  if (base && /^[a-f0-9]{7,40}$/i.test(base)) {
    try {
      const out = execFileSync('git', ['diff', '--name-only', base], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 });
      for (const f of out.trim().split('\n').filter(Boolean)) files.add(f);
    } catch { /* baseline unreachable */ }
  }
  return files;
}

export function pickActiveSessionForCommit(hookCwd: string): SessionState | null {
  // Read the staged list up front: besides scoring overlap between several live
  // sessions (below), it's the evidence that lets an idle-but-unended session be
  // reconsidered when staleness would otherwise leave no candidate at all.
  let stagedFiles: string[] = [];
  try { stagedFiles = stagedCommitFiles(hookCwd); } catch { /* fall through unscored */ }
  // Worktree-aware lookup: falls back to the main repo's sessions when the
  // hook runs inside a linked worktree (whose own git dir holds no session
  // files), then narrows multiple candidates by last-seen lifecycle cwd.
  const activeSessions = listSessionsForGitHook(hookCwd, { commitFiles: stagedFiles });
  activeSessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  if (activeSessions.length === 0) return null;
  if (activeSessions.length === 1) return activeSessions[0];

  // Strongest signal: attribute the commit to the session whose OWN changes
  // overlap the files being committed. This beats process-name guessing when
  // several agents are live, and refuses to credit a session that didn't touch
  // these files (the root of the "agy commit shown as Cursor" bug).
  try {
    // hookCwd, NOT the collapsed getGitRoot: git runs commit hooks from the
    // top of the working tree where the commit happens. For a linked
    // worktree, reading the staged list at the MAIN repo returned the wrong
    // (usually empty) set — so worktree commits never scored an overlap,
    // fell through to process detection, and mostly went unattributed
    // (production session 5606d120: zero FK-linked commits).
    const staged = new Set(stagedFiles);
    if (staged.size > 0) {
      // A session MID-TURN whose in-flight writes are being committed is the
      // one committing. Completed mappings say who wrote these files at some
      // point; an open turn with these files in its ledger says who is
      // writing them now, which is the question `git commit` asks.
      const midTurn = activeSessions.filter((s) =>
        inFlightEditedFiles(s as any).some((f) => staged.has(f)));
      if (midTurn.length === 1) {
        debugLog('prepare-commit-msg', 'attributed by in-flight turn', {
          session: midTurn[0].sessionId.slice(0, 12), staged: staged.size,
        });
        return midTurn[0];
      }
      const scored = activeSessions
        .map((s) => {
          const touched = sessionTouchedFiles(s, s.repoPath || hookCwd);
          let overlap = 0;
          for (const f of staged) if (touched.has(f)) overlap++;
          return { s, overlap };
        })
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap);
      // Clear winner only: the best overlap must strictly beat the runner-up.
      if (scored.length === 1 || (scored.length > 1 && scored[0].overlap > scored[1].overlap)) {
        debugLog('prepare-commit-msg', 'attributed by staged-file overlap', {
          session: scored[0].s.sessionId.slice(0, 12), overlap: scored[0].overlap, staged: staged.size,
        });
        return scored[0].s;
      }
      // A tie is decided AMONG THE TIED, never outside them. Falling through
      // to process detection over the whole pool handed prod vodka's commit
      // to a Codex session with half the overlap, because a Codex process
      // happened to be running: two Claude sessions tied on four files and
      // the zombie with two won.
      if (scored.length > 1) {
        const top = scored[0].overlap;
        const tied = scored.filter((x) => x.overlap === top).map((x) => x.s);
        const picked = breakTie(tied);
        if (picked) {
          debugLog('prepare-commit-msg', 'attributed among tied overlap', {
            session: picked.sessionId.slice(0, 12), overlap: top, tied: tied.length,
          });
          return picked;
        }
        debugLog('prepare-commit-msg', 'tied overlap could not be broken', {
          overlap: top, tied: tied.map((s) => s.sessionId.slice(0, 12)),
        });
        return null;
      }
    }
  } catch { /* fall through to process detection */ }

  // Multiple sessions, no file evidence at all — disambiguate via process
  // detection.
  return breakTie(activeSessions);
}

/**
 * Among sessions that file evidence could not separate: the agent whose
 * process is running, then the one with a turn OPEN, then the clearly more
 * recent one. Null when none of that separates them — don't guess.
 */
function breakTie(pool: SessionState[]): SessionState | null {
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  for (const check of attributionPgrepChecks()) {
    try {
      if (safePgrep(check.cmd)) {
        const matched = pool.filter((s) => sessionMatchesAgent(s, check.slug));
        if (matched.length === 1) return matched[0];
      }
    } catch { /* no match */ }
  }
  const open = pool.filter((s) => s.activeTurn && Number.isInteger(s.activeTurn.index));
  if (open.length === 1) return open[0];
  const recency = (s: SessionState): number => Math.max(
    s.lastStopAt ? Date.parse(s.lastStopAt) || 0 : 0,
    s.startedAt ? Date.parse(s.startedAt) || 0 : 0,
  );
  const sorted = [...pool].sort((a, b) => recency(b) - recency(a));
  if (recency(sorted[0]) - recency(sorted[1]) >= RECENCY_TIEBREAK_MARGIN_MS) return sorted[0];
  return null;
}

/**
 * Called by .git/hooks/prepare-commit-msg.
 * Adds Origin-Session and Origin-Snapshot trailers to COMMIT_EDITMSG
 * before the commit is created. Never throws.
 */
export async function handlePrepareCommitMsg(
  msgFile: string,
  source?: string,
): Promise<void> {
  debugLog('prepare-commit-msg', '=== GIT HOOK INVOKED ===', { msgFile, source });

  // Skip cases where we shouldn't be adding trailers:
  //   merge   — merge commit, author didn't write this
  //   squash  — squash merge, user is combining commits
  //   commit  — amend or rebase, existing message already has trailers if applicable
  if (source === 'merge' || source === 'squash' || source === 'commit') {
    debugLog('prepare-commit-msg', 'skip — source excluded', { source });
    return;
  }

  try {
    if (!msgFile || !fs.existsSync(msgFile)) {
      debugLog('prepare-commit-msg', 'skip — msgFile missing', { msgFile });
      return;
    }

    const hookCwd = process.cwd();
    const repoPath = getGitRoot(hookCwd);
    if (!repoPath) {
      debugLog('prepare-commit-msg', 'skip — not a git repo');
      return;
    }

    // Respect commitLinking config
    const config = loadConfig();
    const commitLinkingConfig = config?.commitLinking || 'always';
    if (commitLinkingConfig === 'never') {
      debugLog('prepare-commit-msg', 'skip — commitLinking=never');
      return;
    }

    const state = pickActiveSessionForCommit(hookCwd);
    if (!state) {
      debugLog('prepare-commit-msg', 'skip — no unambiguous active session');
      return;
    }

    // Check existing message for Origin-Session trailer. If present AND the
    // session ID matches, we're done (interpret-trailers addIfDifferent would
    // also handle this but a fast-path avoids the subprocess).
    let existing: string;
    try {
      existing = fs.readFileSync(msgFile, 'utf-8');
    } catch (readErr: any) {
      debugLog('prepare-commit-msg', 'could not read msg file (non-fatal)', { message: readErr.message });
      return;
    }
    const shortId = state.sessionId.slice(0, 12);
    if (existing.includes(`Origin-Session: ${shortId}`)) {
      debugLog('prepare-commit-msg', 'trailer already present for this session');
      return;
    }

    // Find latest snapshot for the Origin-Snapshot trailer.
    let latestSnapshotId: string | undefined;
    if (state.sessionTag) {
      try {
        const snapshots = listSnapshots(repoPath, state.sessionTag);
        if (snapshots.length > 0) latestSnapshotId = snapshots[snapshots.length - 1].id;
      } catch { /* no snapshots is fine */ }
    }

    const trailers = buildOriginTrailers(
      state.sessionId,
      state.model,
      state.prompts?.length || 0,
      latestSnapshotId,
      state.agentSlug,
      state.subagentSpawns?.length || 0,
    );

    // Use git interpret-trailers to add the trailers in-place. This handles:
    //   • Placing trailers after existing Co-Authored-By / Signed-off-by lines
    //   • Adding the blank line separator if needed
    //   • De-duplication via --if-exists=addIfDifferent (if a trailer with the
    //     same name+value already exists, it's not added again)
    const args = [
      'interpret-trailers',
      '--in-place',
      '--if-exists=addIfDifferent',
      '--if-missing=add',
    ];
    for (const t of trailers) args.push(`--trailer=${t}`);
    args.push(msgFile);

    try {
      execFileSync('git', args, {
        windowsHide: true,
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      debugLog('prepare-commit-msg', 'trailers written', {
        sessionId: shortId,
        snapshotId: latestSnapshotId,
        trailerCount: trailers.length,
      });
    } catch (trailerErr: any) {
      debugLog('prepare-commit-msg', 'interpret-trailers failed (non-fatal)', { message: trailerErr.message });
    }
  } catch (err: any) {
    // Never fail the commit because of Origin's trailer hook.
    debugLog('prepare-commit-msg', 'top-level error (non-fatal)', { message: err.message });
  }
}

/**
 * Called by .git/hooks/pre-push.
 * Pushes origin-sessions branch and refs/notes/origin alongside the user's push.
 */
export async function handlePrePush(): Promise<void> {
  debugLog('pre-push', '=== GIT HOOK INVOKED ===');

  const hookCwd = process.cwd();
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('pre-push', 'SKIP: not a git repo');
    return;
  }

  const execOpts = {
    windowsHide: true,
    encoding: 'utf-8' as const,
    cwd: repoPath,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    timeout: 15_000,
  };

  // Check if remote exists
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], execOpts);
  } catch {
    debugLog('pre-push', 'SKIP: no remote');
    return;
  }

  // In connected mode, session data goes to the API — don't push
  // origin-sessions branch to repo remote (may be public).
  const config = loadConfig();
  const connected = !!(config?.apiKey && config?.apiUrl);
  const strategy = config?.pushStrategy || 'auto';

  // ── Agent-disabled push gate ──────────────────────────────────────
  // When the org opted in (Org.pushBlockMode) and the developer's coding
  // agent is disabled in Origin, abort the push. Team connected keys only —
  // solo keys self-manage their auto-enabled agents (the server also
  // bypasses them). Best-effort + fail policy lives in decidePushBlock:
  // a blocked decision exits non-zero so git aborts the push.
  if (config && connected && config.keyType !== 'solo' && config.accountType !== 'developer') {
    // The whole gate is wrapped so an internal bug (config read, etc.) can
    // NEVER abort a legitimate push — only the deliberate process.exit(1)
    // below blocks, and process.exit isn't catchable. Governance must fail
    // open on its own errors; the real backstop is the PR merge gate.
    try {
      const repoConfig = loadRepoConfig(repoPath);
      const agentCfg = loadAgentConfig();
      const slug = repoConfig?.agent || agentCfg?.agentSlug || undefined;

      let reachable = true;
      let allowed: boolean | undefined;
      let agentName: string | null = null;
      let serverMode: string | undefined;
      // Bound the check — a slow/down API must never stall the developer's
      // push; on timeout we treat it as unreachable and apply the fail policy.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const r = (await api.pushCheck(slug, controller.signal)) as { allowed?: boolean; agentName?: string | null; mode?: string };
        allowed = r?.allowed;
        agentName = r?.agentName ?? null;
        serverMode = r?.mode;
      } catch {
        reachable = false; // network/API error/timeout — apply cached fail policy
      } finally {
        clearTimeout(timeout);
      }

      // Refresh the cached mode whenever we reached the server, so a later
      // offline push applies the org's real fail policy.
      if (reachable && serverMode && serverMode !== config.pushBlockMode) {
        try { saveConfig({ ...config, pushBlockMode: serverMode }); } catch { /* cache is best-effort */ }
      }

      const decision = decidePushBlock({ reachable, allowed, agentName, cachedMode: config.pushBlockMode });
      if (decision.block) {
        console.error(`\n  ✖ Origin: push blocked — ${decision.reason}.`);
        console.error('    Ask an admin to enable your agent in Origin, then push again.');
        console.error('    To override this one push: git push --no-verify\n');
        debugLog('pre-push', 'BLOCKED', { reason: decision.reason, slug, reachable });
        process.exit(1);
      }
      debugLog('pre-push', 'push gate passed', { reachable, allowed, slug });
    } catch (err: any) {
      // Fail open on any unexpected internal error — never block a push due
      // to a gate bug.
      debugLog('pre-push', 'push gate errored — allowing push', { message: err?.message });
    }
  }

  // Push the origin-sessions branch whenever prompt portability is on (the
  // default) — connected OR standalone. The branch carries the full per-prompt
  // payloads (+ diffs) that let AI blame survive a clone or a re-connect to a
  // DIFFERENT Origin org: the server imports it on connect. This used to be
  // skipped in connected mode ("data goes to the API"), which meant a repo
  // connected to another org had no branch to import → no cross-org prompts/
  // blame, and developers had to `git push origin origin-sessions` by hand.
  // Privacy opt-out is the SAME flag that governs notes: notesIncludePrompts
  // = false (per repo/machine) suppresses both. snapshotRepo / pushStrategy
  // 'always' stay as explicit escape hatches.
  const pushSessionsBranch =
    shouldIncludePromptText(repoPath) || config?.snapshotRepo || strategy === 'always';
  if (pushSessionsBranch) {
    try {
      execFileSync('git', ['rev-parse', 'refs/heads/origin-sessions'], execOpts);
      // Every other clone's sessions live on the same branch. Without this
      // the first clone to push won and every later push from every other
      // clone was rejected non-fast-forward — silently, in this very catch —
      // for as long as the repo lived.
      const reconciled = reconcileSessionBranchWithRemote(repoPath, 'origin');
      execFileSync('git', ['push', 'origin', 'origin-sessions', '--no-verify', '--quiet'], execOpts);
      debugLog('pre-push', 'pushed origin-sessions', { reconciled });
    } catch (err: any) {
      debugLog('pre-push', 'origin-sessions push skipped', { message: err.message });
    }
  } else {
    debugLog('pre-push', 'SKIP origin-sessions push: prompt portability opted out');
  }

  // Push refs/notes/origin if they exist
  let hasLocalNotes = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/notes/origin'], execOpts);
    hasLocalNotes = true;
  } catch {
    debugLog('pre-push', 'SKIP notes push: no local refs/notes/origin');
  }
  if (hasLocalNotes) {
    const pushNotes = () =>
      execFileSync('git', ['push', 'origin', 'refs/notes/origin', '--no-verify', '--quiet'], execOpts);
    try {
      pushNotes();
      debugLog('pre-push', 'pushed refs/notes/origin');
    } catch (err: any) {
      // Almost always a non-fast-forward rejection: another worktree or
      // machine pushed newer notes since we last synced (each post-commit
      // appends to the shared notes ref). Fetch the remote notes, merge them
      // into ours, and retry the push ONCE. Strategy `ours` keeps the local
      // note when both sides annotated the SAME commit — notes are per-commit
      // JSON written by the committing machine, so ours is the authoritative
      // one here and line-level strategies (cat_sort_uniq) would corrupt it.
      try {
        execFileSync('git', ['fetch', '--no-tags', 'origin', '+refs/notes/origin:refs/notes/origin-remote'], execOpts);
        execFileSync('git', ['notes', '--ref=refs/notes/origin', 'merge', '-s', 'ours', 'refs/notes/origin-remote'], execOpts);
        pushNotes();
        debugLog('pre-push', 'pushed refs/notes/origin after merging remote notes');
      } catch (retryErr: any) {
        debugLog('pre-push', 'notes push skipped', { message: err.message, retryMessage: retryErr.message });
      }
    }
  }

  // Memory notes (refs/notes/origin-memory + its continuation brief). Same
  // trigger, same privacy gate as the attribution notes above — pushMemoryNotes
  // handles the non-fast-forward retry itself, with a payload-level merge
  // instead of `notes merge` (the payload is one note on the root commit, so a
  // git-level strategy would drop the other machine's sessions wholesale).
  try {
    pushMemoryNotes(repoPath, 'origin');
    debugLog('pre-push', 'pushed memory notes');
  } catch (err: any) {
    debugLog('pre-push', 'memory notes push skipped', { message: err?.message });
  }

  // Acceptance notes (refs/notes/origin-acceptance). Session-end pushes these
  // too, but only right after a backfill actually wrote something — this is the
  // catch-all for a machine that annotated commits and then pushed later.
  // Separate try so a memory failure above doesn't strand them.
  try {
    pushAcceptanceNotes(repoPath, 'origin');
    debugLog('pre-push', 'pushed acceptance notes');
  } catch (err: any) {
    debugLog('pre-push', 'acceptance notes push skipped', { message: err?.message });
  }

  debugLog('pre-push', '=== GIT HOOK COMPLETE ===');
}
