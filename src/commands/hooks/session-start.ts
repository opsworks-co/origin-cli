// SessionStart: register or adopt the session, inject repo context.
//
// Moved out of commands/hooks.ts mechanically: the text is unchanged, only its
// home is. Shared helpers still live in hooks.ts and are imported from there.
import { findCodexRolloutByCwd } from '../../agents/codex.js';
import { getCursorModelFromDb } from '../../agents/cursor.js';
import { discoverGeminiTranscriptPath, readGeminiModel } from '../../agents/gemini.js';
import { isSpecificModel, sessionMatchesAgent } from '../../agents/registry.js';
import { api } from '../../api.js';
import { buildAttributionContext } from '../../attribution.js';
import { buildBudgetBanner, buildBudgetWarningBanner, clearBudgetLockNotice, writeBudgetLockNotice } from '../../budget-breach.js';
import { buildCodexThreadByCwdQuery } from '../../codex-thread-query.js';
import { ensureConfigDir, isConnectedMode, loadAgentConfig, loadConfig, loadRepoConfig, saveAgentConfig } from '../../config.js';
import { assembleRepoContext } from '../../context-injection.js';
import { debugLog } from '../../debug-log.js';
import { retagDevinFromProcess } from '../../devin-cli.js';
import { capDiff } from '../../diff-budget.js';
import { MAX_PROMPT_DIFF_LEN, captureGitState, createShadowCommit, getDirtyFiles } from '../../git-capture.js';
import { combineApplyableTurnDiff } from '../../applyable-turn-diff.js';
import { syncNotesForSessionStart } from '../../git-notes.js';
import { buildHandoffContext } from '../../handoff.js';
import { hasFreshFailedAttempt, listRecentShas, shouldSyncStandalone } from '../../history-backfill.js';
import { matchIgnoredRepo } from '../../ignore-repos.js';
import { buildMemoryBriefContext, buildMemoryContext, buildMemoryPointerContext, buildStartupCheckContext, isSubstantiveMemory, readAllSessionMemory, readMemoryBrief, readRecentMemory } from '../../memory.js';
import { buildRepoBriefContext, maybeSpawnBriefGeneration } from '../../repo-brief.js';
import { carryForwardTurnState, findDuplicateStateForSession, findSameTagStateForResume } from '../../session-dedup.js';
import { pickWorktreeBootstrap, restampWorktreeBootstrap, type SessionStartBaseline } from '../../worktree-bootstrap.js';
import { mergeAdoptedReservation, reservationAdoptedMeanwhile } from '../../reservation-adoption.js';
import { sendDesktopNotification } from '../../session-limits.js';
import { clearSessionState, discoverAllGitRoots, discoverGitRoot, dropSessionMirror, findSessionByClaudeId, getBranch, getCanonicalRepoPath, getGitRoot, getHeadSha, getStatePath, getWorkingGitRoot, isProvisionalSessionId, isSessionAlive, listActiveSessions, loadSessionState, markSessionEnded, preferRegisteredSessionId, readStateAtTag, saveSessionState, sessionTagFor, stampCaptured, startHeartbeat, stopHeartbeat } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import { memorySummaryMode } from '../../session-summary.js';
import { makeSyncBlock } from '../../sync-block.js';
import { detectTools } from '../../tools-detector.js';
import { extractPromptFileMappings, readCopilotModel, setActivePricing } from '../../transcript.js';
import { querySqlite } from '../../utils/sqlite.js';
import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PREAMBLE_VISIBLE_ANCHOR, SESSION_START_RECENT_SHAS, agentRulesTarget, buildContextInjectionPayload, buildOriginFrameworkGuidance, conversationAnchorId, cursorSessionReusable, durableUpdate, filterUncommittedDiff, getWorkingTreeSha, hookLookupSessionId, normalizeWorkspaceRoot, recordFullContextInjection, serverRowForLocalTurn, sessionScopedCommittedDiff, spawnMemoryBriefChild, uncommittedExcludeUnion, writeAgentRulesFile } from '../hooks.js';
import { newCaptureStamp } from '../../capture-stamp.js';


/**
 * Write Origin's session context to the agent rules/instructions files this
 * repo carries.
 *
 * TWO passes, and the second one is the point:
 *
 *  1. The RUNNING agent's own file (CLAUDE.md for claude-code, AGENTS.md for
 *     codex, …) — created when absent, so a first session in a fresh repo
 *     still gets a context surface.
 *  2. Every OTHER origin-managed file ALREADY present in the repo. Without
 *     this the refresh only ever landed on whichever agent happened to be
 *     running, so a repo that had collected CLAUDE.md + AGENTS.md + GEMINI.md
 *     ended up with one current block and N frozen at whenever that agent
 *     last ran — in this very repo, AGENTS.md was 5 months stale and GEMINI.md
 *     4 months, both still advertising policies and "recent AI activity" that
 *     no longer existed. Repo-resident context is only worth anything if it's
 *     true no matter which agent opens the repo.
 *
 * Pass 2 only touches files that ALREADY carry the marker — Origin never
 * creates a context file for an agent this repo doesn't use.
 */
/**
 * True when this agent receives the session-start repo-context block over the
 * hook's stdout channel, AND reads a rules file on every turn — i.e. writing
 * the block into that file duplicates what the hook already delivered.
 *
 * Observed on one Claude Code turn: the same ~450-word digest arrived three
 * times — once in the SessionStart hook payload, once in the UserPromptSubmit
 * payload, and once more as the CLAUDE.md the harness loads into every
 * request. Three copies of one fact, on every turn, is the single most
 * expensive thing Origin does to a context window.
 *
 * Deliberately a short allowlist rather than `payload !== null`. Getting this
 * wrong in the other direction is much worse than a duplicate: for Devin
 * Desktop the rules file is the ONLY surface Origin has (no third-party
 * hooks), and Copilot/Antigravity vary by host. Those keep the full text.
 */
export function agentReadsContextFromHook(agentSlug: string | undefined): boolean {
  return agentSlug === 'claude-code' || agentSlug === 'cursor' || agentSlug === 'gemini';
}

/**
 * Is the authoring framework ALREADY in the always-loaded rules file this agent
 * will have read before the hook ran?
 *
 * The framework has two homes: the hook payload, and the agent's own rules file
 * (which the harness loads into every request). For an agent whose file we have
 * written before, that is the same ~1,050 characters twice in one context — the
 * file copy sits in the cached prefix and costs almost nothing to keep, so the
 * hook copy is the one worth dropping.
 *
 * Gated on the file actually existing and already carrying the block, because
 * the ordering is the whole risk: on the FIRST session in a repo the file is
 * written by this very hook, AFTER the harness has already loaded its context.
 * Dropping the hook copy unconditionally would leave that session with no
 * framework at all. Checked against the marker line rather than the full text
 * so a wording change doesn't silently start double-sending.
 */
export function agentFileCarriesFramework(agentSlug: string | undefined, repoPath: string): boolean {
  if (!agentSlug || !agentReadsContextFromHook(agentSlug)) return false;
  const own = agentRulesTarget(agentSlug, repoPath);
  if (!own) return false;
  try {
    return fs.readFileSync(own.target, 'utf-8').includes(ORIGIN_FRAMEWORK_MARKER);
  } catch {
    return false; // missing or unreadable — send it over the hook
  }
}

/** First line of the framework block — its stable identity in a rules file. */
export const ORIGIN_FRAMEWORK_MARKER = 'Origin authoring framework —';

/**
 * The rules-file copy of the session preamble, with the volatile repo-context
 * block removed — the durable half (tracking notice, active policies, the
 * authoring framework) that a rules file is actually for.
 *
 * Separated out and exported because this subtraction is the whole dedupe: get
 * it wrong by a newline and the block stays in the file, and the digest keeps
 * arriving twice per turn with nothing to show it failed.
 *
 * Returns undefined when there is nothing to subtract (no block was injected,
 * or this agent reads its context from the file rather than the hook), which
 * tells writeAgentRulesFile to write the full text as before.
 */
export function durableRulesFileMessage(
  systemMsg: string,
  injectedRepoContext: string | null,
  agentSlug: string | undefined,
): string | undefined {
  if (!injectedRepoContext || !agentReadsContextFromHook(agentSlug)) return undefined;
  const without = systemMsg.split('\n\n' + injectedRepoContext).join('');
  // If the block wasn't found verbatim, leave the message alone rather than
  // writing something subtly different from what the hook delivered.
  if (without === systemMsg) return undefined;
  return without.replace(/\n{3,}/g, '\n\n').trim();
}

// Mirror the Origin context block to STDERR so it's VISIBLE on the agent's
// initial screen. Gemini renders the stdout `systemMessage` as a banner, so
// the user sees the preamble there — but Claude Code, Codex, and Cursor do
// NOT render SessionStart stdout as a banner; they only surface hook STDERR
// (the same channel the budget banner already uses and which ships visibly
// today). Without this, the preamble reaches the model but never the human on
// those three. Gemini is skipped to avoid printing it twice. Additive: the
// stdout model-delivery payload (buildContextInjectionPayload) is unchanged.
export function emitVisiblePreamble(agentSlug: string | undefined, systemMsg: string): void {
  if (!systemMsg || agentSlug === 'gemini') return;
  const at = systemMsg.indexOf(PREAMBLE_VISIBLE_ANCHOR);
  const block = (at >= 0 ? systemMsg.slice(at) : systemMsg).trim();
  if (!block) return;
  const bold = '\x1b[1m', indigo = '\x1b[38;5;111m', dim = '\x1b[2m', reset = '\x1b[0m';
  const body = block.split('\n').map((l) => `${dim}│${reset} ${l}`).join('\n');
  process.stderr.write(`\n${bold}${indigo}◆ Origin${reset}\n${body}\n\n`);
}

/** Max age at which an id-less session may still be adopted (see below). */
export const ADOPT_IDLESS_MAX_AGE_MS = 15 * 60 * 1000;
 // 15 min

/**
 * Pick the session (if any) that an incoming Cursor/Codex conversation should
 * reuse, from candidates already filtered to the right agent + repo.
 *
 * Rules, in order:
 *  1. EXACT thread-id match wins — that's unambiguously the same conversation,
 *     even if an id-less row appears earlier in the list.
 *  2. Otherwise adopt per cursorSessionReusable, BUT never adopt a STALE
 *     id-less session when we have a concrete incoming id. An old id-less
 *     session is a magnet: once one exists, every later conversation in the
 *     repo folds onto it (the b7a2e816 bug — a 22h Windows session swallowing
 *     a fresh Mac conversation, inflating its diff). Only adopt an id-less
 *     candidate recent enough to plausibly be this same conversation whose id
 *     hadn't resolved yet.
 */
export function selectReusableSession<T extends { agentSessionId?: string | null; startedAt?: string }>(
  candidates: T[],
  agentSlug: string | undefined,
  incomingChatId: string | undefined | null,
  nowMs: number,
): T | null {
  if (incomingChatId) {
    const exact = candidates.find(s => s.agentSessionId && s.agentSessionId === incomingChatId);
    if (exact) return exact;
  }
  return candidates.find(s => {
    if (!cursorSessionReusable(agentSlug, incomingChatId, s.agentSessionId)) return false;
    if (incomingChatId && !s.agentSessionId) {
      const startedMs = s.startedAt ? new Date(s.startedAt).getTime() : 0;
      if (!startedMs || nowMs - startedMs > ADOPT_IDLESS_MAX_AGE_MS) return false;
    }
    return true;
  }) || null;
}

/**
 * Resolve Codex's stable per-conversation thread_id for a repo from the Codex
 * UI app's state SQLite. Codex's stdin session_id rotates per turn, so the
 * durable per-chat anchor is the rollout thread whose cwd EXACTLY matches the
 * repo. Returns the most-recently-updated matching thread id, or null.
 *
 * This is the SAME query the (later) discovery step runs; it's lifted into a
 * helper so session-start can resolve the thread_id BEFORE deciding whether to
 * reuse an existing session — the reuse decision hinges on this id.
 */
export function resolveCodexThreadId(repoPath: string): string | null {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    const stateFiles = fs.existsSync(codexDir)
      ? fs.readdirSync(codexDir)
          .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
          .map(f => ({ path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
      : [];
    if (stateFiles.length > 0) {
      const out = querySqlite(
        stateFiles[0].path,
        buildCodexThreadByCwdQuery('id', repoPath),
        { timeoutMs: 3000 },
      ).trim();
      if (out) return out;
    }
    // SQLite unreadable (native Windows: Codex holds state_*.sqlite open in WAL
    // mode → sql.js reports "database disk image is malformed") or no row yet.
    // Resolve the current conversation's thread id from the append-only rollout
    // files on disk, so the session-reuse check (cursorSessionReusable) can
    // still tell one Codex conversation from the next and rotate the session
    // instead of gluing a new conversation onto the previous one.
    const disk = findCodexRolloutByCwd(codexDir, repoPath);
    return disk ? disk.threadId : null;
  } catch {
    return null;
  }
}

// (parseCodexRollout / findLatestRollout moved to ../agents/codex.ts)

// ─── Session-start history sync ────────────────────────────────────────────
// The post-commit hook heals a local repo's missing history, but only when a
// NEW commit is made — a repo used read-only or pull-only (reviewing agents'
// branches, pulling teammates' work) never fires it, so "12 commits in git,
// 3 in Origin" persisted there. Session start is the other natural trigger:
// gate cheaply in-process (two git queries + a marker read), and when the
// marker says history may be out of sync, hand the actual round to a
// DETACHED child. An in-process fire-and-forget fetch would NOT be free
// here: the pending socket keeps Node's event loop alive, and Claude Code
// waits for the hook process to exit — so session start would stall for the
// whole backfill. (git post-commit dodges this because the installed shell
// hook backgrounds the CLI with `&`.)
export function maybeSpawnHistorySync(repoPath: string, workRoot: string): void {
  try {
    // Strict standalone gate (marker keyed by the WORKING root, matching
    // syncRepoHistory): the post-commit gate's +1-commit slack would let a
    // single pulled commit read as "in-sync" here, where no live ingest
    // covers it. A fresh failed-attempt stamp (permanently 403ing repo,
    // API outage) suppresses the spawn for the backoff window — post-commit
    // and forced `origin sync` still heal it.
    const gate = shouldSyncStandalone(workRoot, workRoot);
    if (!gate.sync || !gate.head) return;
    if (hasFreshFailedAttempt(workRoot)) {
      debugLog('session-start', 'history sync skipped — recent failed attempt (backoff)', { workRoot });
      return;
    }
    const bin = process.argv[1];
    if (!bin) return;
    const child = spawn(process.execPath, [bin, 'hooks', 'git-history-sync'], {
      detached: true,
      stdio: 'ignore',
      // See the heartbeat spawn in session-state.ts — without this a detached
      // console app pops its own terminal window on Windows.
      windowsHide: true,
      env: {
        ...process.env,
        ORIGIN_HISTORY_REPO: repoPath,
        ORIGIN_HISTORY_CWD: workRoot,
      },
    });
    child.unref();
    debugLog('session-start', 'history sync child spawned', { repoPath, count: gate.count });
  } catch (err: any) {
    debugLog('session-start', 'history sync spawn failed (non-fatal)', { message: err?.message });
  }
}

/**
 * Self-heal the continuation brief for a repo that has session memory but no
 * cached brief.
 *
 * maybeRefreshMemoryBrief only runs at session-END and post-COMMIT, and
 * buildMemoryBriefContext is cache-only by design ("never generates here").
 * A repo whose sessions all pre-date the brief feature therefore has no cached
 * brief and no event that would ever mint one: every future session silently
 * falls back to the deterministic commit-list digest, forever. That is exactly
 * what a reviewing agent saw in the `oseledec` repo — it judged the brief
 * "missing" as a product when it simply had never been generated there.
 *
 * Spawned detached from session-start so it costs the hook nothing: the LLM
 * call lands out-of-band and the NEXT session picks the brief up from cache.
 * Gated on connected + llm mode + memory-exists + brief-absent, so the common
 * case is a couple of cheap local reads and no spawn at all.
 */
export function maybeSpawnMemoryBriefBackfill(repoPath: string): void {
  try {
    if (!isConnectedMode() || memorySummaryMode() !== 'llm') return;
    // bake-off / ignored repos are already refused inside write/readMemoryBrief
    if (readMemoryBrief(repoPath)) return;               // already cached — the refresh path owns it
    if (!readAllSessionMemory(repoPath).some(isSubstantiveMemory)) return; // nothing to summarize yet
    spawnMemoryBriefChild(repoPath, 'session-start');
  } catch (err: any) {
    debugLog('session-start', 'memory brief backfill spawn failed (non-fatal)', { message: err?.message });
  }
}

/**
 * Is this the shape where a re-fired SessionStart is about to restart turn
 * numbering at 0? A resume/compact/re-attach start (never a fresh `startup`)
 * that reached the save with NO prompt history of its own.
 *
 * Split out so the caller can skip parsing the transcript entirely on the
 * overwhelmingly common path where the state carried forward fine.
 */
export function resumeSeedApplies(
  startSource: string | undefined | null,
  currentPrompts: string[] | undefined | null,
): boolean {
  if (!startSource || startSource === 'startup') return false;
  return (currentPrompts?.length || 0) === 0;
}

/**
 * The base to persist when every state-file lookup missed on a re-fired start:
 * how many turns of this conversation already exist, straight from the
 * transcript. Null when it does not apply or the transcript offers nothing.
 *
 * The transcript is the right source because it cannot be missing (the agent
 * is reading from it) and because it is the SAME numbering Stop already
 * derives `parsed.promptIndexBase` from — so this is a cache of that value for
 * the hooks that cannot afford a full parse, not a second opinion.
 */
export function resumeBaseFromTranscript(
  startSource: string | undefined | null,
  currentPrompts: string[] | undefined | null,
  transcriptPromptCount: number,
): number | null {
  if (!resumeSeedApplies(startSource, currentPrompts)) return null;
  if (!Number.isFinite(transcriptPromptCount) || transcriptPromptCount <= 0) return null;
  return transcriptPromptCount;
}

/**
 * What session-start records about the tree a session begins on.
 *
 * `headShaAtStart` anchors every session-level range; the session-start
 * shadow (only when the tree is dirty) is what keeps pre-existing dirt out of
 * prompt 1 and out of the session diff. ONE assembly, used when a session is
 * created and again when a main-checkout handshake is adopted into a
 * worktree — the adoption used to keep main's baseline, and a worktree
 * fourteen commits ahead of main was credited all fourteen on its first Stop
 * (e1095412; see restampWorktreeBootstrap).
 */
export function captureSessionStartBaseline(repoPath: string, shadowTag: string): SessionStartBaseline {
  const headShaAtStart = getHeadSha(repoPath);
  const sessionStartDirtyFiles = getDirtyFiles(repoPath);
  let prePromptSha = headShaAtStart;
  let prePromptDirtyFiles = sessionStartDirtyFiles;
  // SHA of the dirty-tree snapshot taken at session start (full working
  // tree, tracked + untracked). The heartbeat diffs against this to keep
  // pre-existing dirt from being attributed to the session's prompts.
  let sessionStartShadowSha: string | null = null;
  if (sessionStartDirtyFiles.length > 0) {
    try {
      const startShadow = createShadowCommit(repoPath, `start-${shadowTag}`);
      if (startShadow) {
        prePromptSha = startShadow;
        sessionStartShadowSha = startShadow;
        prePromptDirtyFiles = [];
        debugLog('session-start', 'created session-start shadow', {
          shadow: startShadow.slice(0, 12),
          dirtyCount: sessionStartDirtyFiles.length,
        });
      }
    } catch (err: unknown) {
      debugLog('session-start', 'shadow creation failed (non-fatal)', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { headShaAtStart, sessionStartShadowSha, prePromptSha, prePromptDirtyFiles, sessionStartDirtyFiles };
}

export async function handleSessionStart(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('session-start', 'begin', { agentSlug, inputKeys: Object.keys(input) });

  const config = loadConfig();
  let agentConfig = loadAgentConfig();
  const connected = isConnectedMode();

  // In standalone mode, create minimal agent config if missing
  if (!agentConfig) {
    if (connected) {
      debugLog('session-start', 'ABORT: missing agent config (run origin enable)', { hasConfig: !!config });
      return;
    }
    // Auto-create minimal agent config for standalone
    agentConfig = {
      machineId: crypto.randomUUID(),
      hostname: os.hostname(),
      detectedTools: detectTools(),
      orgId: 'local',
    };
    ensureConfigDir();
    saveAgentConfig(agentConfig);
    debugLog('session-start', 'auto-created agent config (standalone)', { machineId: agentConfig.machineId });
  }

  // Opportunistically close zombie sessions in this repo — a new session
  // starting is a natural, frequent trigger to reap ones whose agent died
  // without a clean end (Cursor especially). Fire-and-forget; never blocks.
  if (connected) {
    const sweepRoot = getGitRoot(typeof input.cwd === 'string' ? input.cwd : process.cwd());
    if (sweepRoot) void expireStaleSessionsOnServer(sweepRoot);
  }

  // Refresh model pricing from the API. Genuinely non-blocking, as the comment
  // here always claimed: it was `await`ed, so a slow or dead API stalled the
  // whole hook in front of everything below — including the state reservation,
  // which is what lets a concurrent prompt hook find this session. In the prod
  // trace it burned ~8s across two timed-out attempts before session-start had
  // even resolved the repo, and a second session was minted inside that window.
  //
  // Nothing here needs the result: pricing is only read when a cost is computed
  // (Stop, a different process), this warms the shared ~/.origin/pricing.json
  // cache for it, and there is a bundled default when the cache is cold.
  if (connected) {
    void api.getPricing().then(({ pricing }) => {
      if (pricing && typeof pricing === 'object') {
        setActivePricing(pricing as Record<string, { input: number; output: number }>);
        debugLog('session-start', 'pricing fetched from API', { models: Object.keys(pricing).length });
      }
    }).catch((err: any) => {
      debugLog('session-start', 'pricing fetch failed, using defaults', { error: err?.message });
    });
  }

  // Skip background agents (Cursor fires session-start for background indexing agents)
  if (input.is_background_agent === true || input.is_background_agent === 'true') {
    debugLog('session-start', 'SKIP: background agent', { is_background_agent: input.is_background_agent });
    return;
  }

  // Use cwd from hook input (Claude Code passes this), or workspace_roots (Cursor),
  // or fall back to process.cwd()
  let hookCwd = normalizeWorkspaceRoot(input.cwd) || process.cwd();
  // Cursor sends workspace_roots instead of cwd — ALWAYS prefer workspace_roots
  // because Cursor runs hooks from ~/.cursor/ (not the project dir) and process.cwd()
  // may point to a completely different repo.
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = normalizeWorkspaceRoot(input.workspace_roots[0]);
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  debugLog('session-start', 'cwd resolved', { hookCwd, inputCwd: input.cwd, workspaceRoots: input.workspace_roots, processCwd: process.cwd() });

  // Use discoverGitRoot to handle cases where cwd is a parent of the actual repo
  // (e.g. Claude Code reports /project but the repo is /project/.openclaw/workspace/repo).
  // WORKING root first: when hookCwd sits inside a linked worktree
  // (<repo>/.claude/worktrees/<name> — how Claude Code runs worktree
  // sessions), every git capture must target the worktree itself. The old
  // getGitRoot-only path collapsed to the main repo, so the session's edits
  // were recorded as untracked `.claude/worktrees/<id>/…` dirt, its commits
  // were invisible (main HEAD never moves), and no SessionDiff was written
  // (production session 5606d120). Identity stays canonical via
  // state.canonicalRepoPath below.
  const discoveredRoot = getWorkingGitRoot(hookCwd) || discoverGitRoot(hookCwd);
  let repoPath: string = discoveredRoot || hookCwd; // fall back to cwd for non-git projects
  let allRepoPaths: string[] | undefined;
  let isNonGitProject = false;
  if (!discoveredRoot) {
    // Check for multi-repo workspace (multiple git repos as subdirectories)
    const discovered = discoverAllGitRoots(hookCwd);
    if (discovered.length > 1) {
      allRepoPaths = discovered;
      repoPath = hookCwd;
      debugLog('session-start', 'multi-repo session detected', { repoPaths: discovered, workspacePath: hookCwd });
    } else if (discovered.length === 0) {
      // Non-git project: track session with basic data (no diffs/branches)
      isNonGitProject = true;
      repoPath = hookCwd;
      debugLog('session-start', 'non-git project, tracking without git data', { hookCwd });
    }
  }
  // Multi-repo support: if cwd itself is NOT a git repo but discoverGitRoot found one
  // in a subdirectory, check if there are MULTIPLE git repos under cwd.
  const directGitRoot = getGitRoot(hookCwd);
  if (discoveredRoot && !directGitRoot) {
    const discovered = discoverAllGitRoots(hookCwd);
    if (discovered.length > 1) {
      allRepoPaths = discovered;
      repoPath = hookCwd;
      debugLog('session-start', 'multi-repo session detected', { repoPaths: discovered, workspacePath: hookCwd });
    }
  }

  // Openclaw cowork harness: skip the empty-container probe launches. Something
  // in the ~/.openclaw/workspace harness relaunches a bare `claude` AT the
  // container (no git repo, no repos inside) roughly every 40s as
  // warm-up/health-check runs that send no prompt and touch no file. Each one
  // used to register a throwaway non-git "workspace" session (0 prompts /
  // tokens / tools), flooding the Sessions list ~90×/hour (user-reported). Real
  // work in the harness launches from a repo SUBDIR (…/.openclaw/workspace/
  // <repo>) which resolves to that repo (getGitRoot / discoverAllGitRoots ≥ 1)
  // and is tracked normally — so dropping ONLY the bare, empty, non-git
  // container launch removes the noise without losing a real session. (The
  // server-side empty-session sweep still archives any a pre-guard CLI made.)
  //
  // GIT-REPO REQUIRED: a session may ONLY be tracked from inside a git
  // repository. Origin is git-native — a non-git directory has no commits,
  // diff, branch, or repo identity to attribute, so tracking one only ever
  // produced junk "repos" (`/`, the openclaw `workspace` container,
  // filesystem-root Codex/agent meta-calls that fire the hook trio with cwd="/"
  // or an ambient container) and empty 0-prompt sessions on the dashboard. If
  // cwd is not a git repo AND has no git repos beneath it, drop the whole
  // session lifecycle up front, for ANY agent. (A multi-repo workspace sets
  // allRepoPaths and is tracked normally; real work under a container launches
  // from a repo SUBDIR that resolves to that repo.) This generalizes the
  // earlier openclaw-container / filesystem-root special cases into the one
  // rule the user asked for: no git repo → no session.
  if (isNonGitProject && !allRepoPaths) {
    debugLog('session-start', 'skip: directory is not a git repository (no session)', { repoPath, agentSlug });
    return;
  }

  // User-configured repo ignore list (`origin ignore repo add`). A repo the user
  // explicitly excluded — or any path nested under one — creates NO session for
  // ANY agent. This is how a headless scratch workspace that runs a real agent
  // CLI (e.g. a Claude Desktop cowork project at ~/.openclaw/workspace, which
  // trips the global claude-code hooks) stops flooding the org, while genuine
  // local repos — even remote-less ones — keep tracking. Checked AFTER the
  // git-repo guard so repoPath is fully resolved; mirrored at every other
  // session-creation site (auto-create, local→server migration).
  {
    const ignoredMatch = matchIgnoredRepo(repoPath, loadConfig()?.ignoredRepos);
    if (ignoredMatch) {
      debugLog('session-start', 'skip: repo is on the ignore list (origin ignore repo)', { repoPath, ignoredMatch, agentSlug });
      return;
    }
  }

  // Canonical (main-repo) identity for the server: repo naming, session
  // start, commit ingest. For a linked worktree this differs from repoPath
  // (the working root); everywhere git RUNS uses repoPath, everywhere the
  // repo is NAMED uses canonicalRepoPath.
  const canonicalRepoPath: string = (!isNonGitProject && !allRepoPaths && repoPath)
    ? getCanonicalRepoPath(repoPath)
    : repoPath;
  debugLog('session-start', 'repo path resolved', { repoPath, canonicalRepoPath, hookCwd, multiRepo: !!allRepoPaths });

  // Ensure the git pre-commit hook is installed in this repo so
  // CONTENT_FILTER / secret-scan policies actually block commits.
  // User-reported (PR #156): a CONTENT_FILTER policy was configured
  // in the dashboard but Codex committed forbidden content because
  // the repo had never been `origin enable`'d — the per-repo
  // `.git/hooks/pre-commit` was missing, so the policy evaluator
  // never ran. The agent-level hooks (which DO fire because they
  // live in `~/.codex/hooks.json` or `~/.claude/settings.json`)
  // handle attribution but not enforcement. Auto-installing here
  // closes the gap for any agent the first time a session touches
  // a repo. Idempotent + silent — skips when already installed or
  // when `core.hooksPath` already routes through Origin's global
  // dir.
  if (!isNonGitProject && repoPath && !allRepoPaths) {
    try {
      const { ensurePolicyHookInstalled } = await import('../enable.js');
      // Canonical: hooks live in the MAIN repo's .git/hooks, shared by every
      // linked worktree (whose own `.git` is a file — the join inside would
      // break, and installing per-worktree would be redundant anyway).
      const result = ensurePolicyHookInstalled(canonicalRepoPath);
      if (result.installed) {
        debugLog('session-start', 'auto-installed policy pre-commit hook', { repoPath, reason: result.reason });
      } else {
        debugLog('session-start', 'policy hook not auto-installed', { repoPath, reason: result.reason });
      }
    } catch (err: any) {
      debugLog('session-start', 'policy hook auto-install failed (non-fatal)', { message: err?.message });
    }
    // Heal missing local history from session start too (see
    // maybeSpawnHistorySync). Canonical path names the repo (and keys the
    // sync marker — same key the post-commit hook uses); the WORKING root is
    // where git reads run, so a worktree session advertises its own HEAD.
    if (connected) {
      maybeSpawnHistorySync(canonicalRepoPath, repoPath);
      maybeSpawnMemoryBriefBackfill(canonicalRepoPath);
    }
  } else if (allRepoPaths) {
    // Multi-repo workspace — install in each discovered repo so
    // policies enforce on every commit regardless of which sub-repo
    // the agent edits.
    try {
      const { ensurePolicyHookInstalled } = await import('../enable.js');
      for (const r of allRepoPaths) {
        try {
          const result = ensurePolicyHookInstalled(r);
          if (result.installed) {
            debugLog('session-start', 'auto-installed policy pre-commit hook (multi-repo)', { repoPath: r, reason: result.reason });
          }
        } catch { /* per-repo failure non-fatal */ }
      }
    } catch (err: any) {
      debugLog('session-start', 'multi-repo policy hook auto-install failed (non-fatal)', { message: err?.message });
    }
  }

  // Resolve agent slug: .origin.json → agentSlugs override → hook command slug → saved default → undefined
  // Canonical first: `origin link` writes .origin.json UNTRACKED at the main
  // repo root, so a worktree checkout doesn't have it. Fall back to the
  // worktree's own copy (a committed .origin.json travels with checkouts).
  const repoConfig = loadRepoConfig(canonicalRepoPath) || (canonicalRepoPath !== repoPath ? loadRepoConfig(repoPath) : null);
  const baseSlug = agentSlug || repoConfig?.agent || agentConfig.agentSlug || undefined;
  // Apply per-tool slug override from config (e.g. agentSlugs.claude-code = "claude-front")
  // Check both the hook command slug and the resolved base slug as override keys
  const slugOverrides = config?.agentSlugs || {};
  const slugOverride = (agentSlug && slugOverrides[agentSlug]) || (baseSlug && slugOverrides[baseSlug]) || undefined;
  let finalAgentSlug = slugOverride || baseSlug;
  // Devin CLI reuses Claude Code's hooks and reads ~/.claude/settings.json, so
  // when only the claude-code hook is installed a Devin run fires as
  // agentSlug='claude-code' and gets mislabeled "Claude". The hook's session_id
  // does NOT match the ATIF transcript filename, so detect Devin by the process
  // tree instead — this claude-code hook runs as a descendant of the `devin`
  // binary. Correct at SessionStart so the chip reads Devin while RUNNING; the
  // Stop/SessionEnd handlers re-check (devin may spawn each hook fresh).
  const retaggedStartSlug = retagDevinFromProcess(finalAgentSlug);
  if (retaggedStartSlug !== finalAgentSlug) {
    debugLog('session-start', 're-tagging claude-code hook as devin (running under devin process)', {
      sessionId: input.session_id, from: finalAgentSlug,
    });
    finalAgentSlug = retaggedStartSlug;
  }
  debugLog('session-start', 'agent resolved', {
    fromRepoConfig: repoConfig?.agent,
    fromHookCommand: agentSlug,
    fromSavedDefault: agentConfig.agentSlug,
    baseSlug,
    configAgentSlugs: slugOverrides,
    slugOverride: slugOverride || null,
    final: finalAgentSlug,
  });

  // Resolve the agent's session identifier from stdin. Every agent now
  // gets one — it anchors all downstream discovery (Cursor agent-transcripts
  // dir name, Gemini file basename, Codex thread_id). Per-agent rules:
  //   • claude-code / windsurf: input.session_id (stable per session)
  //   • cursor: input.session_id or input.conversation_id (matches the
  //     agent-transcripts/<id>/ directory name)
  //   • gemini: input.session_id (matches the chats/session-<id>.json file)
  //   • codex: stdin id is unreliable (it's the per-turn thread id, often
  //     rotates), so we resolve threads.id from SQLite by EXACT cwd at the
  //     END of this session-start block (after repoPath is final).
  // Antigravity (like Claude Code) fires SessionStart once per session and
  // carries a stable session_id across hook events, so it can anchor state.
  const agentsWithStableSessionId = ['claude-code', 'devin', 'antigravity', 'copilot'];
  const hasStableSessionId = agentsWithStableSessionId.includes(agentSlug || '');
  // Cursor prefers `conversation_id` — stable per-chat and matches the
  // `agent-transcripts/<id>/` directory name. Cursor's `session_id`
  // rotates per turn, so picking it as the anchor would force a "new
  // chat" lock on every prompt. Other agents fall through to whichever
  // id stdin provides first.
  const stdinSessionId = conversationAnchorId(agentSlug, input.conversation_id, input.session_id);
  // claudeSessionId stays as the legacy field for findSessionByClaudeId
  // and serialized state compat — only populated for agents with truly
  // stable IDs that can be safely used for cross-hook state lookup.
  const claudeSessionId = hasStableSessionId ? (input.session_id || '') : '';
  // agentSessionId is the new authoritative-discovery anchor. Populated
  // for EVERY agent below. Cursor/Gemini get it from stdin; Codex gets it
  // from a SQLite exact-cwd query once repoPath is finalized.
  let agentSessionId: string = claudeSessionId || stdinSessionId || '';
  let transcriptPath = input.transcript_path || '';

  // ── Concurrent session support ─────────────────────────────────────────────
  // Each Claude Code window gets its own tagged state file so multiple sessions
  // on the same repo don't overwrite each other.
  // Generate a stable session tag from this Claude session ID.
  // Anchored on the CONVERSATION, not just the stable-id agents. The tag is the
  // state file's path, so it is what makes a concurrent user-prompt-submit
  // write to this session instead of creating a second one — see sessionTagFor.
  const sessionTag = sessionTagFor(claudeSessionId, agentSessionId);
  // Claude Code says WHY this hook fired: 'startup' | 'resume' | 'clear' |
  // 'compact'. Everything except 'startup' means the conversation already
  // exists, and the CLI never read this field — so a resume looked exactly
  // like a cold start and overwrote the conversation's accumulated state.
  // Logged for diagnosis; the carry-forward below does not depend on it,
  // because a re-fired 'startup' must be just as safe.
  const startSource = typeof input.source === 'string' ? input.source : '';
  debugLog('session-start', 'session tag', { sessionTag, claudeSessionId, source: startSource || '(none)' });

  // ── Deduplicate: skip if we already have an active session for this Claude session ──
  if (claudeSessionId) {
    const existing = findSessionByClaudeId(claudeSessionId, repoPath);
    if (existing && existing.sessionId) {
      // Claude-compatible CLIs (Devin CLI reads ~/.claude/settings.json too)
      // fire BOTH the claude-code hooks AND their own hooks for the SAME
      // session. The claude-code hook usually wins the create, mislabeling the
      // session "Claude Code". When the more-specific agent's own hook arrives
      // for that same session, re-tag it to the truth instead of skipping.
      const incoming = finalAgentSlug || agentSlug || '';
      const existingSlug = (existing as any).agentSlug || '';
      if (incoming && incoming !== 'claude-code' && existingSlug !== incoming &&
          (existingSlug === 'claude-code' || existingSlug === '')) {
        try {
          (existing as any).agentSlug = incoming;
          if (!isSpecificModel((existing as any).model)) (existing as any).model = incoming;
          saveSessionState(existing, (existing as any).repoPath || repoPath, (existing as any).sessionTag);
          api.updateSession(existing.sessionId, { agentSlug: incoming, model: (existing as any).model }).catch(() => {});
          debugLog('session-start', 're-tagged mislabeled claude-code session to specific agent', {
            sessionId: existing.sessionId, from: existingSlug || '(none)', to: incoming, claudeSessionId,
          });
        } catch (err: any) {
          debugLog('session-start', 're-tag failed (non-fatal)', { message: err?.message });
        }
        return;
      }
      debugLog('session-start', 'SKIP: session already exists for this Claude session', {
        existingSessionId: existing.sessionId,
        claudeSessionId,
      });
      return;
    }
  }

  // ── Clean up prior sessions for the SAME agent only ──────────────────────
  // NEVER touch sessions from other agents. If agentSlug is unknown, skip cleanup.
  // For Cursor/Codex (per-prompt session-start), skip this — they reuse below.
  const agentsWithPerPromptSessionStart = ['cursor', 'codex'];

  // Everything a reused (or adopted) session owes the agent before this hook
  // returns: a live heartbeat, the budget/policy banners, the notes sync, the
  // attribution block, the framework guidance, the rules file. Shared by the
  // Cursor/Codex reuse path and the worktree-bootstrap adopt below — the adopt
  // used to `return` bare, and an agent starting in a fresh worktree began
  // with no context at all.
  const finishReusedSession = (existing: SessionState): void => {
    // Restart heartbeat to keep session alive between prompts
    const stateFileReuse = getStatePath(repoPath, existing.sessionTag);
    startHeartbeat(existing.sessionId, config?.apiUrl || 'https://getorigin.io', config?.apiKey || '', stateFileReuse, finalAgentSlug);

    // Output system message
    let systemMsg = '';
    // Budget banner FIRST \u2014 a resumed session under a breached cap must
    // open with the warning, same as a fresh one. The flag comes from
    // the persisted state (stamped by session-start / heartbeat pings).
    if (existing.budgetBlocked) {
      systemMsg += buildBudgetBanner(existing.budgetBlockReason || 'Hard budget cap exceeded') + '\n\n';
    }
    if (existing.agentSystemPrompt) systemMsg += existing.agentSystemPrompt + '\n\n';
    systemMsg += 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
    if (existing.activePolicies && Array.isArray(existing.activePolicies) && existing.activePolicies.length > 0) {
      systemMsg += '\n\nActive policies for this session:\n' +
        existing.activePolicies.map((p: string) => `- ${p}`).join('\n');
    }
    try {
      syncNotesForSessionStart(repoPath);
    } catch {}
    try {
      const attributionCtx = buildAttributionContext(repoPath);
      if (attributionCtx) systemMsg += '\n\n' + attributionCtx;
    } catch {}
    // Framework guidance — same as the fresh-session path. Resumed
    // sessions still benefit from the [Origin: …] marker convention,
    // and re-emitting on resume is harmless (the model will see the
    // same guidance whether or not it saw it earlier).
    systemMsg += '\n\n' + buildOriginFrameworkGuidance();
    const reusePayload = buildContextInjectionPayload(agentSlug, 'SessionStart', systemMsg);
    if (reusePayload) {
      process.stdout.write(reusePayload);
    } else if (agentSlug === 'codex' && existing.budgetBlocked) {
      // Codex shows hook stdout as warnings — surface the banner there.
      process.stdout.write(buildBudgetBanner(existing.budgetBlockReason || 'Hard budget cap exceeded') + '\n');
    }
    // Visible preamble on resume too (parity with Gemini) — see emitVisiblePreamble.
    emitVisiblePreamble(agentSlug, systemMsg);

    // Write rules file for reused sessions too
    try {
      writeAgentRulesFile(finalAgentSlug || '', systemMsg, repoPath);
    } catch {}
  };

  const effectiveSlug = finalAgentSlug || agentSlug || '';
  if (!claudeSessionId && effectiveSlug && !agentsWithPerPromptSessionStart.includes(effectiveSlug)) {
    const sameAgentSessions = listActiveSessions(repoPath).filter(s => sessionMatchesAgent(s, effectiveSlug));
    for (const stale of sameAgentSessions) {
      debugLog('session-start', 'cleaning up prior session for same agent', {
        staleSessionId: stale.sessionId,
        staleTag: stale.sessionTag,
        newAgent: effectiveSlug,
      });
      stopHeartbeat(stale.sessionId);
      if (connected && stale.sessionId) {
        try {
          const durationMs = Date.now() - new Date(stale.startedAt).getTime();
          await api.endSession({
            sessionId: stale.sessionId,
            prompt: stale.prompts.join('\n\n---\n\n') || undefined,
            durationMs: durationMs > 0 ? durationMs : undefined,
            branch: stale.branch || undefined,
          });
        } catch (err: any) {
          debugLog('session-start', 'stale session end failed (non-fatal)', { message: err.message });
        }
      }
      clearSessionState(repoPath, stale.sessionTag);
      if (repoPath !== hookCwd) clearSessionState(hookCwd, stale.sessionTag);
    }
  }

  // Resolve Codex's stable per-conversation thread_id BEFORE the reuse decision
  // below. Codex's stdin session_id rotates per turn, so without this the reuse
  // check compared an empty/rotating id and always reused the latest RUNNING
  // session — gluing a NEW Codex conversation's prompts onto the previous
  // conversation (the reported bug). With the real thread_id in hand,
  // cursorSessionReusable can block reuse when the thread differs.
  if (agentSlug === 'codex' && !agentSessionId) {
    const codexThread = resolveCodexThreadId(repoPath);
    if (codexThread) {
      agentSessionId = codexThread;
      debugLog('session-start', 'codex thread_id resolved before reuse', {
        threadId: codexThread.slice(0, 12), repoPath,
      });
    } else {
      // Codex's SQLite returned no thread for this cwd — the rollout row isn't
      // written yet, or was momentarily locked/unreadable during a mid-session
      // git/account switch. Leaving the id empty makes the server miss every
      // agentSessionId-keyed reuse rung and spawn a TWIN (user-reported: two
      // identical Codex rows after a "switched GitHub account" turn). Recover
      // the stable id from a still-alive Codex session in THIS repo so the
      // conversation id survives the drift. (Only the transient-null case —
      // a genuinely different thread id is left to the server's drift guard so
      // we never glue two distinct Codex conversations together here.)
      const liveCodexId = listActiveSessions(repoPath)
        .filter((s) => sessionMatchesAgent(s, finalAgentSlug || '') && !!s.agentSessionId)
        .map((s) => s.agentSessionId as string)[0];
      if (liveCodexId) {
        agentSessionId = liveCodexId;
        debugLog('session-start', 'codex thread_id recovered from live session state (SQLite drift)', {
          threadId: liveCodexId.slice(0, 12), repoPath,
        });
      }
    }
  }

  // For Cursor/Codex: session-start fires on every prompt, so reuse existing session.
  // First, clean up orphaned sessions whose heartbeats died (e.g. Mac sleep).
  const agentsWithSessionReuse = ['cursor', 'codex']; // Reuse active sessions — prevent duplicates from rapid session-start fires
  if (agentsWithPerPromptSessionStart.includes(agentSlug || '')) {
    const allActive = listActiveSessions(repoPath).filter(s => sessionMatchesAgent(s, finalAgentSlug || ''));
    for (const s of allActive) {
      const hbPidFile = path.join(os.homedir(), '.origin', 'heartbeats', `${s.sessionId}.pid`);
      let heartbeatAlive = false;
      try {
        const hbPid = parseInt(fs.readFileSync(hbPidFile, 'utf-8').trim(), 10);
        if (hbPid > 0) { process.kill(hbPid, 0); heartbeatAlive = true; }
      } catch { /* pid file missing or process dead */ }
      // Don't kill sessions whose state file was recently updated — the session
      // is still active even if the heartbeat PID can't be verified (common for
      // Codex/Cursor where heartbeat may not have started yet or died briefly).
      if (!heartbeatAlive) {
        try {
          const stateFilePath = getStatePath(repoPath, s.sessionTag);
          const stat = fs.statSync(stateFilePath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs < 2 * 60 * 60 * 1000) { // state file updated < 2 hours ago — don't treat as orphan
            heartbeatAlive = true; // treat as alive
            debugLog('session-start', 'session state file still fresh, skipping orphan cleanup', {
              sessionId: s.sessionId, ageMs,
            });
          }
        } catch { /* state file missing — proceed with cleanup */ }
      }
      if (!heartbeatAlive) {
        debugLog('session-start', 'ending orphaned session (heartbeat dead)', {
          sessionId: s.sessionId, tag: s.sessionTag, agent: finalAgentSlug,
        });
        stopHeartbeat(s.sessionId);
        if (connected && s.sessionId) {
          try {
            const durationMs = Date.now() - new Date(s.startedAt).getTime();
            await api.endSession({
              sessionId: s.sessionId,
              prompt: s.prompts.join('\n\n---\n\n') || undefined,
              durationMs: durationMs > 0 ? durationMs : undefined,
              branch: s.branch || undefined,
            });
          } catch {}
        }
        clearSessionState(repoPath, s.sessionTag);
        if (repoPath !== hookCwd) clearSessionState(hookCwd, s.sessionTag);
      }
    }

    // For Cursor/Codex: look for a valid active session to reuse
    let existing: SessionState | null = null;
    // Cursor's conversation_id (agentSessionId) is the stable per-chat anchor.
    // A NEW Cursor chat must NOT reuse a prior chat's still-open session —
    // mirror the detach handleUserPromptSubmit already does on a changed
    // conversation_id. Without this, opening a fresh Cursor chat in the same
    // repo glued today's prompt onto yesterday's RUNNING session (and the
    // prompt then displayed under that session's older start time). Only block
    // reuse when we can PROVE a mismatch (both ids known and different); a
    // session with no recorded id is adopted, same as user-prompt-submit.
    // Codex is exempt — its stdin id rotates per turn, so it reuses by agent.
    const pickReusable = (list: SessionState[]): SessionState | null =>
      selectReusableSession(
        list.filter(s => sessionMatchesAgent(s, finalAgentSlug || agentSlug || '')),
        agentSlug,
        agentSessionId,
        Date.now(),
      );
    if (agentsWithSessionReuse.includes(agentSlug || '')) {
      existing = pickReusable(listActiveSessions(repoPath));
      // Also check global archive — the .git/ file might have been cleaned up
      if (!existing) {
        try {
          const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
          const entries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
          const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
          const archived: SessionState[] = [];
          for (const entry of entries) {
            try {
              const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
              if (!s?.sessionId || !s?.startedAt) continue;
              if (Date.now() - new Date(s.startedAt).getTime() > MAX_AGE_MS) continue;
              if (s.status === 'ENDED' && s.endedAt) continue;
              if (s.repoPath !== repoPath) continue;
              archived.push(s);
            } catch { /* skip corrupt file */ }
          }
          existing = pickReusable(archived);
        } catch { /* no archive dir */ }
      }
    }
    if (!existing) {
      // Cursor sessionStart fires on the main checkout, then the harness
      // moves the agent into a linked worktree. The worktree start carries a
      // new conversation id so pickReusable misses — without this the
      // dashboard shows main + cursor/<id> for a few seconds.
      const boot = pickWorktreeBootstrap(
        listActiveSessions(repoPath).filter(s => sessionMatchesAgent(s, finalAgentSlug || agentSlug || '')),
        repoPath,
        canonicalRepoPath,
        Date.now(),
      );
      if (boot) {
        restampWorktreeBootstrap(boot, {
          agentSessionId: agentSessionId || undefined,
          claudeSessionId: claudeSessionId || undefined,
          lastCwd: hookCwd,
          repoPath,
          canonicalRepoPath,
          branch: getBranch(hookCwd) || getBranch(repoPath) || undefined,
          // The handshake's baseline is main's tree; this session works here.
          baseline: captureSessionStartBaseline(repoPath, boot.sessionTag || boot.sessionId.slice(0, 12)),
        });
        existing = boot;
        debugLog('session-start', 'adopting empty worktree-bootstrap session', {
          sessionId: boot.sessionId, tag: boot.sessionTag, branch: boot.branch, agent: finalAgentSlug,
          headShaAtStart: boot.headShaAtStart?.slice(0, 12), shadow: boot.sessionStartShadowSha?.slice(0, 12) ?? null,
        });
        try { saveSessionState(boot, repoPath, boot.sessionTag); } catch { /* non-fatal */ }
        // Branch AND the conversation id: the row was registered under the
        // handshake's composer id, and the server's resume rungs key on
        // agentSessionId (see the same push in user-prompt-submit).
        if (connected && boot.sessionId && !boot.sessionId.startsWith('local-') && (boot.branch || agentSessionId)) {
          durableUpdate(boot.sessionId, {
            ...(boot.branch && { branch: boot.branch }),
            ...(agentSessionId && { agentSessionId }),
          }).catch(() => {});
        }
      }
    }
    if (existing) {
      // Stamp the resolved thread id onto an adopted id-less session so it can
      // never be reused by a DIFFERENT conversation later — the next
      // conversation will see a concrete, non-matching id and rotate instead of
      // folding in (belt-and-suspenders with the recency guard above).
      if (agentSessionId && !existing.agentSessionId) {
        existing.agentSessionId = agentSessionId;
      }
      debugLog('session-start', 'reusing existing session for per-prompt agent', {
        sessionId: existing.sessionId,
        tag: existing.sessionTag,
        agent: finalAgentSlug,
        promptCount: existing.prompts.length,
        stampedThreadId: agentSessionId ? agentSessionId.slice(0, 12) : undefined,
      });

      // ── Per-prompt diff: capture previous prompt's changes ──
      const currentHead = getHeadSha(repoPath);
      // Capture when HEAD changed (commits) OR when HEAD is same (uncommitted-only changes).
      //
      // Cross-launch safety: if the previous prompt already has a
      // saved mapping (its own Stop hook captured it before the
      // previous Codex window quit), DON'T re-capture here. The
      // recovered prePromptSha can be hours old at this point and
      // any manual commits the user made between launches would
      // otherwise get attributed to that prompt — which is what
      // showed up as "diff for create-a-file-shit.txt includes 4
      // unrelated files" on the dashboard. Skip the retro capture
      // in that case; prePromptSha gets reset below either way.
      // Local turn number → server row, same reason as the user-prompt-submit
      // retro capture: `prompts` counts this launch only, so on a resumed
      // conversation a raw 0 here lands on turn one's row.
      const prevLocalIdx = existing.prompts.length - 1;
      const prevPromptIdx = serverRowForLocalTurn(prevLocalIdx, existing.promptIndexBase);
      const prevAlreadyCaptured = !!(existing.completedPromptMappings || []).find(
        (m: any) => m.promptIndex === prevPromptIdx && (m.diff || m.uncommittedDiff),
      );
      if (existing.prePromptSha && currentHead && existing.prompts.length > 0 && !prevAlreadyCaptured) {
        try {
          const prevCapture = captureGitState(repoPath, existing.prePromptSha, { fullContext: true });
          // Scope committed side to commits this session authored (see
          // sessionScopedCommittedDiff), AND to THIS TURN's window — the
          // capture above is already baselined at `existing.prePromptSha`,
          // so replaying every session commit here hands the turn work an
          // earlier turn already reported.
          const reuseSessionCommitted = sessionScopedCommittedDiff(
            repoPath, existing, existing.prePromptSha,
          );
          // Files come from the turn-scoped committed diff, not from
          // `commitDetails` — that is the whole commit's file list, which on a
          // `git commit -a` names every file that merely happened to be dirty.
          const prevFilesSet = new Set<string>();
          for (const m of reuseSessionCommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
            if (m[1]) prevFilesSet.add(m[1]);
          }
          if (prevCapture.diff) {
            for (const m of prevCapture.diff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) prevFilesSet.add(m[1]);
            }
          }
          // Filter uncommitted diff against the prompt-baseline + session-start
          // pre-existing dirt union.
          const filteredUncommitted = filterUncommittedDiff(
            prevCapture.uncommittedDiff || '', uncommittedExcludeUnion(existing),
          );
          // Also include uncommitted file paths (filtered)
          if (filteredUncommitted) {
            for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) prevFilesSet.add(m[1]);
            }
          }
          const prevFiles = Array.from(prevFilesSet);
          if (prevCapture.diff || filteredUncommitted || prevFiles.length > 0) {
            if (!existing.completedPromptMappings) existing.completedPromptMappings = [];
            const existingIdx = existing.completedPromptMappings.findIndex(m => m.promptIndex === prevPromptIdx);
            // Get current HEAD + working-tree SHA for restore support.
            // getWorkingTreeSha() returns the dirty working-tree's tree
            // when present (Cursor mid-turn case), HEAD's tree otherwise.
            let mappingCommitSha: string | null = null;
            let mappingTreeSha: string | null = null;
            try {
              mappingCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            } catch { /* ignore */ }
            mappingTreeSha = getWorkingTreeSha(repoPath);
            const reuseDiff = combineApplyableTurnDiff({
              committedDiff: reuseSessionCommitted,
              uncommittedDiff: filteredUncommitted,
              workingTreeDiff: prevCapture.workingTreeDiff || '',
            });
            const mapping = {
              promptIndex: prevPromptIdx,
              promptText: (existing.prompts[prevLocalIdx] || '').slice(0, 1000),
              filesChanged: prevFiles,
              diff: reuseDiff.slice(0, 200_000),
              uncommittedDiff: filteredUncommitted.slice(0, 200_000),
              commitSha: mappingCommitSha,
              treeSha: mappingTreeSha,
            };
            if (existingIdx >= 0) {
              // Don't clobber a non-empty mapping with an empty diff —
              // STOP from the previous launch already captured it.
              const prevExisting = existing.completedPromptMappings[existingIdx];
              const newHasDiff = !!(mapping.diff || mapping.uncommittedDiff);
              const existingHasDiff = !!(prevExisting.diff || (prevExisting as any).uncommittedDiff);
              if (newHasDiff || !existingHasDiff) {
                existing.completedPromptMappings[existingIdx] = stampCaptured(mapping);
              }
            } else {
              existing.completedPromptMappings.push(stampCaptured(mapping));
            }
            debugLog('session-start', 'captured per-prompt diff for previous prompt (reuse)', {
              promptIndex: prevPromptIdx, filesChanged: prevFiles.length,
            });
          }
        } catch (err: any) {
          debugLog('session-start', 'per-prompt diff capture failed (non-fatal)', { message: err.message });
        }
      }
      existing.prePromptSha = currentHead;
      existing.prePromptDirtyFiles = getDirtyFiles(repoPath);

      // ── Send accumulated data to API ──
      if (connected && existing.completedPromptMappings && existing.completedPromptMappings.length > 0) {
        try {
          // Session-level filesChanged: full session baseline
          const sessionCapture = captureGitState(repoPath, existing.headShaAtStart, { committedOnly: true });
          const sessionFilesSet = new Set<string>();
          for (const c of sessionCapture.commitDetails) {
            for (const f of c.filesChanged) sessionFilesSet.add(f);
          }
          const sessionFiles = Array.from(sessionFilesSet);
          const durationMs = Date.now() - new Date(existing.startedAt).getTime();
          await durableUpdate(existing.sessionId, {
            filesChanged: sessionFiles.length > 0 ? sessionFiles : undefined,
            durationMs: durationMs > 0 ? durationMs : undefined,
            // These rows are what an EARLIER capture stored locally; nothing here
            // observed anything new. Stamped at the session's start so the server
            // reads them as older than any real capture: a row it lacks is filled,
            // a row a later Stop or watcher wrote is left alone. Unstamped, they
            // were exempt from that ordering and overwrote fresher content.
            promptChanges: existing.completedPromptMappings.map(pm => {
              const dl = (pm.diff || '').split('\n');
              const startedAtMs = Date.parse(existing.startedAt || '');
              const reattachStamp = { ...newCaptureStamp('ss'), capturedAt: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : 1 };
              return {
                ...reattachStamp,
                ...pm,
                promptText: (pm.promptText || '').slice(0, 1000),
                diff: capDiff(pm.diff, MAX_PROMPT_DIFF_LEN),
                uncommittedDiff: capDiff(pm.uncommittedDiff, MAX_PROMPT_DIFF_LEN),
                linesAdded: dl.filter((l: string) => l.startsWith('+') && !l.startsWith('+++')).length,
                linesRemoved: dl.filter((l: string) => l.startsWith('-') && !l.startsWith('---')).length,
                aiPercentage: 100,
                checkpointType: 'auto',
                commitSha: (pm as any).commitSha || null,
                treeSha: (pm as any).treeSha || null,
              };
            }),
            status: 'RUNNING',
          });
          debugLog('session-start', 'sent accumulated promptChanges (reuse)', {
            count: existing.completedPromptMappings.length, sessionFiles: sessionFiles.length,
          });
        } catch (err: any) {
          debugLog('session-start', 'accumulated update failed (non-fatal)', { message: err.message });
        }
      }

      // Touch the state file to keep it fresh
      saveSessionState(existing, repoPath, existing.sessionTag);

      // Pre-prompt snapshots removed on purpose. The user-facing rule is
      // "snapshots only for prompts that change code AND get committed",
      // so capturing the pre-prompt working tree (no changes possible yet)
      // produced empty rows the user couldn't act on. The post-commit hook
      // condenses the latest stop-snapshot for each commit, which is the
      // right anchor for "what did this prompt change?"

      finishReusedSession(existing);
      return;
    }
  }

  // Claude Code (and any agent whose session-start is once-per-conversation)
  // has the same main→worktree move: the first start registered on the
  // primary checkout, the second fires in the worktree with a new id. Adopt
  // the empty handshake rather than minting a twin.
  if (!agentsWithPerPromptSessionStart.includes(agentSlug || '')) {
    const boot = pickWorktreeBootstrap(
      listActiveSessions(repoPath).filter(s => sessionMatchesAgent(s, finalAgentSlug || agentSlug || '')),
      repoPath,
      canonicalRepoPath,
      Date.now(),
    );
    if (boot) {
      restampWorktreeBootstrap(boot, {
        agentSessionId: agentSessionId || undefined,
        claudeSessionId: claudeSessionId || undefined,
        lastCwd: hookCwd,
        repoPath,
        canonicalRepoPath,
        branch: getBranch(hookCwd) || getBranch(repoPath) || undefined,
        // The handshake's baseline is main's tree; this session works here.
        baseline: captureSessionStartBaseline(repoPath, boot.sessionTag || boot.sessionId.slice(0, 12)),
      });
      debugLog('session-start', 'adopting empty worktree-bootstrap session', {
        sessionId: boot.sessionId, tag: boot.sessionTag, branch: boot.branch, agent: finalAgentSlug,
        headShaAtStart: boot.headShaAtStart?.slice(0, 12), shadow: boot.sessionStartShadowSha?.slice(0, 12) ?? null,
      });
      try { saveSessionState(boot, repoPath, boot.sessionTag); } catch { /* non-fatal */ }
      if (connected && boot.sessionId && !boot.sessionId.startsWith('local-') && (boot.branch || agentSessionId)) {
        durableUpdate(boot.sessionId, {
          ...(boot.branch && { branch: boot.branch }),
          ...(agentSessionId && { agentSessionId }),
        }).catch(() => {});
      }
      finishReusedSession(boot);
      return;
    }
  }

  // Clean up legacy untagged state file if it exists (one-time migration).
  // This prevents old untagged files from confusing concurrent lookups.
  const legacyState = loadSessionState(hookCwd) || loadSessionState(repoPath);
  if (legacyState && !legacyState.sessionTag) {
    debugLog('session-start', 'migrating legacy untagged session', {
      oldSessionId: legacyState.sessionId,
    });
    if (connected) {
      try {
        const durationMs = Date.now() - new Date(legacyState.startedAt).getTime();
        await api.endSession({
          sessionId: legacyState.sessionId,
          prompt: legacyState.prompts.join('\n\n---\n\n') || undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          branch: legacyState.branch || undefined,
        });
      } catch (err: any) {
        debugLog('session-start', 'legacy session end failed (non-fatal)', { message: err.message });
      }
    }
    clearSessionState(hookCwd);
    if (repoPath !== hookCwd) clearSessionState(repoPath);
  }

  // Auto-discover Gemini transcript if not provided via stdin. Anchor
  // on stdin session_id when available so we don't pick up a different
  // open Gemini chat whose file just happens to be newer.
  if (!transcriptPath && agentSlug === 'gemini') {
    transcriptPath = discoverGeminiTranscriptPath({
      sessionId: typeof input.session_id === 'string' ? input.session_id : undefined,
    }) || '';
    if (transcriptPath) debugLog('session-start', 'auto-discovered transcript path', { transcriptPath });
  }

  // Resolve model: use stdin value, fall back to Cursor DB, then agent default
  let model = input.model || '';
  if (!model || model === 'unknown' || model === 'default') {
    // Cursor always sends model:"default" — try to read real model from its SQLite DB
    if (agentSlug === 'cursor' && input.conversation_id) {
      const cursorModel = getCursorModelFromDb(input.conversation_id);
      if (cursorModel) {
        model = cursorModel;
        debugLog('session-start', 'model from Cursor DB', { model: cursorModel, conversationId: input.conversation_id });
      } else {
        debugLog('session-start', 'cursor model fallback (DB lookup failed)', { conversationId: input.conversation_id });
      }
    }
    // Gemini's hook stdin never includes `model` (Gemini CLI doesn't
    // expose it), so we'd fall back to the bare "gemini" string and
    // every commit row would display "Gemini" instead of the real
    // model (e.g. "Gemini 2.5 Pro"). Scan the transcript file for the
    // actual model identifier — Gemini writes it on the session
    // metadata line at the top of the chat file and/or on each
    // model-response event.
    if (agentSlug === 'gemini' && transcriptPath) {
      const geminiModel = readGeminiModel(transcriptPath);
      if (geminiModel) {
        model = geminiModel;
        debugLog('session-start', 'model from Gemini transcript', { model: geminiModel, transcriptPath });
      }
    }
    // Copilot's hook stdin carries no model (selectedModel:"auto") — read the
    // real model from its events.jsonl so the session isn't stamped bare "claude".
    if (agentSlug === 'copilot' && transcriptPath) {
      const copilotModel = readCopilotModel(transcriptPath);
      if (copilotModel) {
        model = copilotModel;
        debugLog('session-start', 'model from Copilot transcript', { model: copilotModel, transcriptPath });
      }
    }
  }
  if (!model || model === 'unknown' || model === 'default') {
    const AGENT_DEFAULT_MODELS: Record<string, string> = {
      'gemini': 'gemini',
      'claude-code': 'claude',
      'cursor': 'cursor',
      'devin': 'devin',
      'codex': 'codex',
      'aider': 'aider',
      // Antigravity is multi-model; its flagship is Gemini 3 Pro. The hook's
      // stdin `model` (preferred above) carries the REAL per-session model when
      // present — this is only the fallback, and it must be a real, priced
      // model id (not the slug "antigravity", which has no pricing).
      'antigravity': 'gemini-3-pro',
    };
    model = AGENT_DEFAULT_MODELS[finalAgentSlug || ''] || 'unknown';
  }

  // Extract git remote origin URL for smarter repo matching on the API side
  let repoUrl = '';
  try {
    repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { windowsHide: true, cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }).trim();
    debugLog('session-start', 'git remote origin url', { repoUrl });
  } catch {
    debugLog('session-start', 'no git remote origin (non-fatal)');
  }

  // Recent HEAD SHAs for the server's basename-fallback repo gate. A
  // local-only repo has no remote for the gate's agreement rung, so when its
  // checkout moves to a new path this advertisement is the only proof that
  // ties the session to the existing row — without it session/start
  // auto-registered a duplicate while ingest kept SHA-corroborating to the
  // old one, splitting sessions from their commits. hookCwd first: a worktree
  // shares the canonical repo's history and repoPath may be the collapsed
  // main checkout.
  let sessionRecentShas = listRecentShas(hookCwd, SESSION_START_RECENT_SHAS);
  if (sessionRecentShas.length === 0) sessionRecentShas = listRecentShas(repoPath, SESSION_START_RECENT_SHAS);
  debugLog('session-start', 'recent HEAD shas advertised', { count: sessionRecentShas.length });

  // Worktree-first: hookCwd is the agent's actual working dir (the linked
  // worktree), repoPath is collapsed to the main repo. Reading repoPath first
  // returned the main checkout's branch ("main") for every worktree session.
  const branch = getBranch(hookCwd) || getBranch(repoPath);
  debugLog('session-start', 'branch resolved', { branch, repoPath, hookCwd });

  // ── Re-detect tools on every session start ─────────────────────────────────
  try {
    const freshTools = detectTools();
    const oldTools = agentConfig.detectedTools || [];
    const changed = freshTools.length !== oldTools.length ||
      freshTools.some(t => !oldTools.includes(t)) ||
      oldTools.some(t => !freshTools.includes(t));

    if (changed) {
      debugLog('session-start', 'tools changed', { old: oldTools, new: freshTools });
      agentConfig.detectedTools = freshTools;
      agentConfig.lastToolDetection = new Date().toISOString();
      saveAgentConfig(agentConfig);
      // Update server with new tool list (only in connected mode)
      if (connected) {
        try {
          await api.registerMachine({
            hostname: agentConfig.hostname,
            machineId: agentConfig.machineId,
            detectedTools: freshTools,
          });
          debugLog('session-start', 'machine re-registered with updated tools');
        } catch (regErr: any) {
          debugLog('session-start', 'machine re-registration failed (non-fatal)', { message: regErr.message });
        }
      }
    } else {
      debugLog('session-start', 'tools unchanged', { tools: freshTools });
    }
  } catch (detectErr: any) {
    debugLog('session-start', 'tool detection failed (non-fatal)', { message: detectErr.message });
  }

  // ── Reserve the state file BEFORE the network call ────────────────────────
  //
  // `api.startSession` below decides `sessionId`, and nothing was written to
  // disk until it returned. On a slow or failing API that is a multi-second
  // hole in which this session does not exist as far as any other hook is
  // concerned. Cursor fires session-start and user-prompt-submit at the same
  // instant, so the prompt hook lands in that hole, finds nothing, and mints a
  // SECOND session for the same chat.
  //
  // Prod, Cursor on `baton` (2026-08-30 13:43 UTC), the two hooks 5ms apart:
  //   13:43:41.366  [session-start] calling api.startSession
  //   13:43:42.031  [user-prompt-submit] auto-created session local-6e7a8d14…
  //   13:43:49.368  [session-start] API failed, falling back to local
  //   13:43:49.609  [session-start] state saved  local-9adc70bd…   ← 8.2s later
  //   13:43:49.897  [user-prompt-submit] background updateSession failed:
  //                 "Session not found"
  // Two state files, two local sessions, one conversation.
  //
  // Writing a provisional row here closes the hole: a concurrent hook finds
  // this session and adopts it instead of creating its own. The id is
  // provisional (`local-`) and is replaced with the server's below — the same
  // local→server promotion `ensureServerSession` already performs, and the
  // reason `preferRegisteredSessionId` refuses to demote a real id back to a
  // provisional one when the two paths race to save.
  //
  // Deliberately after every early-return guard above (background agent, not a
  // git repo, ignored repo, dedup hit) so a skipped start never leaves a file.
  let reservedSessionId = `local-${crypto.randomUUID()}`;
  // Only a row THIS hook reserved can have been adopted mid-registration. A
  // re-fired start over an existing file takes the carry-forward paths below.
  let reservedHere = false;
  try {
    const reservationCwd = allRepoPaths ? hookCwd : repoPath;
    // NEVER overwrite state that already exists at this tag. A re-fired
    // session-start (resume, compact, re-attach) lands here with the SAME tag
    // and a live file holding the conversation's prompts; writing a bare row
    // over it would destroy that history, and the carry-forward at the end of
    // this handler — which reads the file back — would then find only the row
    // we just wrote and restore nothing. There is also nothing to reserve in
    // that case: a discoverable session already exists, which is the entire
    // point of reserving.
    // readStateAtTag, not loadSessionState: the latter rejects a row whose
    // claudeSessionId is empty, which every Cursor row is, so this guard
    // never saw a Cursor file and reserved straight over it.
    const existingAtTag = readStateAtTag(reservationCwd, sessionTag);
    if (existingAtTag?.sessionId) {
      // Adopt its id as our local fallback too, so a failed `session/start`
      // below keeps the conversation on the id it already has instead of
      // renaming it.
      reservedSessionId = existingAtTag.sessionId;
      debugLog('session-start', 'not reserving — state already exists at this tag', {
        sessionTag, existing: existingAtTag.sessionId,
        prompts: (existingAtTag.prompts as unknown[] | undefined)?.length || 0,
      });
    } else {
      saveSessionState({
        sessionId: reservedSessionId,
        sessionTag,
        claudeSessionId,
        agentSessionId: agentSessionId || undefined,
        transcriptPath: transcriptPath || undefined,
        model,
        agentSlug: finalAgentSlug,
        repoPath,
        canonicalRepoPath,
        lastCwd: hookCwd,
        branch: branch || undefined,
        startedAt: new Date().toISOString(),
        prompts: [],
        status: 'RUNNING',
        // Marks the row as not-yet-registered so the promotion below (and any
        // hook that adopts it meanwhile) knows the id is a placeholder.
        pendingRegistration: true,
      } as unknown as SessionState, reservationCwd, sessionTag);
      debugLog('session-start', 'reserved state before registering', {
        sessionId: reservedSessionId, sessionTag, repoPath, agentSlug: finalAgentSlug,
      });
      reservedHere = true;
    }
  } catch (reserveErr: unknown) {
    // A reservation is an optimisation, never a precondition — a repo whose
    // `.git` we cannot write (Codex's sandbox) must still start a session.
    debugLog('session-start', 'reservation failed (non-fatal)', {
      message: reserveErr instanceof Error ? reserveErr.message : String(reserveErr),
    });
  }

  try {
    let sessionId: string;
    // Set when the server refused session/start with a 429 (hard budget
    // cap). The local fallback session is created anyway but flagged
    // budgetBlocked so every enforcement layer sees the lockout.
    let budgetRefusedReason: string | undefined;
    // Scoped SOFT-cap breach — warn-only (amber banner, no lockout).
    let budgetWarnReason: string | undefined;
    // Why session/start failed and the session stayed local (persisted on the
    // state so `origin status` reports the REAL reason, not a canned string).
    let syncBlock: import('../../sync-block.js').SyncBlock | undefined;
    let agentSystemPrompt: string | undefined;
    let activePolicies: string[] | undefined;
    let enforcementRules: any[] | undefined;
    let verboseCapture = false;
    let apiStartedAt: string | undefined;

    if (connected) {
      // ── Connected mode: register session with Origin platform ──
      try {
        debugLog('session-start', 'calling api.startSession', { machineId: agentConfig.machineId, model, repoPath, repoUrl, agentSlug: finalAgentSlug, branch, multiRepo: !!allRepoPaths });
        const result = await api.startSession({
          machineId: agentConfig.machineId,
          prompt: '',
          model,
          // Canonical: the server names/dedupes the repo off this path — a
          // worktree session must attribute to the real project, not a repo
          // called "zen-margulis-c0587a".
          repoPath: canonicalRepoPath,
          repoUrl: repoUrl || undefined,
          recentShas: sessionRecentShas.length > 0 ? sessionRecentShas : undefined,
          agentSlug: finalAgentSlug,
          branch: branch || undefined,
          hostname: agentConfig.hostname || undefined,
          additionalRepoPaths: allRepoPaths ? allRepoPaths.filter(p => p !== repoPath) : undefined,
          // Use the unified `agentSessionId` (= claudeSessionId || stdinSessionId
          // || cursor conversation_id) rather than `claudeSessionId` alone.
          // For Cursor this is the conversation_id captured from
          // input.conversation_id earlier; without it every new Cursor
          // thread on the same machine+repo collided into whatever prior
          // Cursor session was still RUNNING (user-reported May 27: new
          // Cursor thread reused session 5bd449fb, accumulating 7 prompts
          // across two distinct conversations on the same row).
          agentSessionId: agentSessionId || undefined,
        });
        sessionId = result.sessionId as string;
        agentSystemPrompt = (result.agentSystemPrompt as string) || undefined;
        activePolicies = result.activePolicies && Array.isArray(result.activePolicies) ? result.activePolicies : undefined;
        enforcementRules = result.enforcementRules && Array.isArray(result.enforcementRules) ? result.enforcementRules : undefined;
        verboseCapture = result.verboseCapture === true;
        // Use server startedAt if returned (deduped sessions preserve original start time)
        if (result.startedAt) {
          apiStartedAt = result.startedAt as string;
        }
        // Over-budget sessions are TRACKED with a warning, not refused —
        // the server creates the row (badged on the dashboard) and ships
        // the breach here so client-side gates lock work from prompt #1.
        const startBudget = (result as any).budget;
        if (startBudget?.blocked) {
          budgetRefusedReason = startBudget.message || 'Budget limit exceeded';
          process.stderr.write(
            `[origin] Budget limit reached — ${budgetRefusedReason}. This session is tracked but ` +
            `new AI work (including commits) is locked until the cap resets or an admin raises it.\n`,
          );
        } else if (startBudget?.warning) {
          // Scoped SOFT cap exceeded (this developer's user/agent/repo
          // limit). Purely informational: amber banner on the initial
          // screen + a desktop notification — nothing is locked.
          budgetWarnReason = startBudget.message || 'Soft budget cap exceeded';
          process.stderr.write(`[origin] Budget warning — ${budgetWarnReason}.\n`);
          sendDesktopNotification(
            'Origin — budget warning',
            `${budgetWarnReason}. Work continues (soft limit) — mind the spend.`,
          );
        }
        debugLog('session-start', 'api returned', { sessionId, deduped: !!result.startedAt, verboseCapture, budgetBlocked: !!startBudget?.blocked, budgetWarning: !!startBudget?.warning });
      } catch (apiErr: any) {
        // API failed — fall back to local session instead of aborting entirely.
        // AGENT_DISABLED is the expected response when an admin hasn't
        // toggled the agent on yet; in that case the platform also fired
        // notifications to the developer + admins, so the CLI just needs to
        // explain why the session stayed local.
        // Record WHY this session stayed local so `origin status` can report
        // the real reason instead of always blaming "agent disabled".
        syncBlock = makeSyncBlock(apiErr, repoPath || '', new Date().toISOString());
        if (apiErr?.code === 'AGENT_DISABLED') {
          const agentName = apiErr?.body?.agent?.name || finalAgentSlug || 'this agent';
          debugLog('session-start', 'agent disabled, keeping session local', { agentName });
          process.stderr.write(`[origin] ${agentName} is disabled in your org — session kept local. An admin has been notified to enable it.\n`);
        } else if (apiErr?.code === 'REPO_NOT_REGISTERED' || apiErr?.serverError === 'Repository not registered') {
          // Team keys don't auto-register repos (only solo does). Tell the user
          // exactly which repo and how to fix it — never a silent/mislabeled loss.
          const repoName = path.basename(repoPath || '') || (repoPath || 'this repo');
          debugLog('session-start', 'repo not registered, keeping session local', { repoPath });
          process.stderr.write(
            `[origin] "${repoName}" isn't registered in your org — session kept local (not lost). ` +
            `An owner can add it: Repositories → Add Repo, or \`origin repo:add --name ${repoName} --path ${repoPath || '.'}\`. ` +
            `Then run \`origin sessions sync\`.\n`,
          );
        } else if (apiErr?.status === 429) {
          // Hard budget cap refused the session. The fallback below still
          // creates a LOCAL session — that's deliberate (tracking should
          // degrade, not vanish) — but it must carry the lockout, or
          // agents whose hook protocols can't block (Codex, Cursor) sail
          // on with nothing in their way: user-reported, codex edited and
          // committed while all three hard caps sat at 110%. The flag
          // below feeds the prompt/tool gates AND the git pre-commit
          // gate, which blocks the commit for every agent.
          budgetRefusedReason = apiErr?.message || 'Budget limit exceeded';
          debugLog('session-start', 'budget 429 — local session will carry the lockout', { reason: budgetRefusedReason });
          process.stderr.write(
            `[origin] Session blocked — budget limit reached. ${budgetRefusedReason} ` +
            `New AI work (including commits) is locked until the cap resets or an admin raises it.\n`,
          );
        } else {
          debugLog('session-start', 'API failed, falling back to local', { message: apiErr.message });
          process.stderr.write(`[origin] API error (falling back to local): ${apiErr.message}\n`);
        }
        // Keep the id the reservation already published. Minting a fresh one
        // here would orphan the row a concurrent hook may already have adopted
        // — the second of the two local sessions in the prod trace above.
        sessionId = reservedSessionId;
      }
    } else {
      // ── Standalone mode: generate local session ID ──
      sessionId = reservedSessionId;
      debugLog('session-start', 'standalone session', { sessionId });
    }

    // Look up the most recent session in this repo so we can record a
    // previousSessionId pointer in this session's git notes. Lets future
    // agents walk the chain of sessions across commits. We also stash the
    // prior session's startedAt so the acceptance backfill at session-end
    // can scope its commit scan instead of reading notes on every recent
    // commit in the repo.
    let previousSessionId: string | undefined;
    let previousSessionStartedAt: string | undefined;
    try {
      const recent = readRecentMemory(repoPath, 1);
      if (recent.length > 0 && recent[0].sessionId && recent[0].sessionId !== sessionId) {
        previousSessionId = recent[0].sessionId;
        previousSessionStartedAt = recent[0].startedAt;
      }
    } catch { /* non-fatal */ }

    // If the working tree is dirty at session-start, create a shadow commit
    // capturing that state. Using the shadow as `prePromptSha` (instead of
    // HEAD) means per-prompt `workingTreeDiff(prePromptSha → working tree)`
    // correctly EXCLUDES the pre-existing dirty content from prompt 1's
    // attribution — only edits the agent makes AFTER session-start show up
    // as added lines for prompt 1. Without this, the user-prompt-submit
    // retroactive capture for prompt 1 conflates pre-existing dirty edits
    // with the agent's actual prompt-1 work and attributes them all to P1.
    const {
      headShaAtStart: sessionStartHead,
      sessionStartShadowSha,
      prePromptSha: initialPrePromptSha,
      prePromptDirtyFiles: initialPrePromptDirtyFiles,
      sessionStartDirtyFiles: sessionStartDirty,
    } = captureSessionStartBaseline(repoPath, sessionTag || sessionId.slice(0, 12));

    // Codex thread_id is normally resolved earlier, BEFORE the reuse check (see
    // resolveCodexThreadId above). Kept here as a fallback for any path that
    // reaches session creation without it. If we can't resolve one, leave
    // agentSessionId empty — downstream discovery then bails rather than guess
    // across threads.
    if (agentSlug === 'codex' && !agentSessionId) {
      const codexThread = resolveCodexThreadId(repoPath);
      if (codexThread) {
        agentSessionId = codexThread;
        debugLog('session-start', 'codex thread_id resolved from sqlite (fallback)', {
          threadId: codexThread.slice(0, 12), repoPath,
        });
      } else {
        debugLog('session-start', 'codex thread_id not found for repo — will rely on stdin per-hook', { repoPath });
      }
    }

    const state: SessionState = {
      sessionId,
      claudeSessionId,
      agentSessionId: agentSessionId || undefined,
      transcriptPath,
      model,
      startedAt: apiStartedAt || new Date().toISOString(),
      prompts: [],
      repoPath,
      canonicalRepoPath,
      lastCwd: hookCwd,
      headShaAtStart: sessionStartHead,
      sessionStartShadowSha,
      headShaAtLastStop: null,
      prePromptSha: initialPrePromptSha,
      prePromptDirtyFiles: initialPrePromptDirtyFiles,
      // Preserve the original dirty-at-start list separately. The per-prompt
      // tracking (prePromptDirtyFiles) gets reset on every prompt boundary
      // and zeroed by shadow creation, but we still need the start-time
      // snapshot at session-end to keep pre-existing pollution from another
      // agent's leftover working-tree edits out of THIS session's sessionDiff.
      sessionStartDirtyFiles: sessionStartDirty,
      branch,
      sessionTag,
      agentSlug: finalAgentSlug || agentSlug,
      agentSystemPrompt,
      activePolicies,
      enforcementRules,
      verboseCapture,
      previousSessionId,
      previousSessionStartedAt,
    };

    // Hard budget cap breached at start (server-reported budget payload,
    // or a legacy 429 refusal) — the session still tracks, but flagged
    // blocked so the prompt/tool gates (Claude Code / Gemini) and the git
    // pre-commit gate (every agent, incl. Codex/Cursor whose hooks can't
    // block) all enforce the lockout. The AGENTS.md notice is the
    // model-facing layer: Codex/Cursor read it natively and stop working
    // on their own instead of failing mysteriously at commit time.
    // Stamp the real block reason (agent-disabled / repo-not-registered / …)
    // so `origin status` reports it accurately instead of a canned string.
    if (syncBlock) state.syncBlock = syncBlock;

    if (budgetRefusedReason) {
      state.budgetBlocked = true;
      state.budgetBlockReason = budgetRefusedReason;
      writeBudgetLockNotice(repoPath, budgetRefusedReason);
    } else {
      // Not breached — clear any notice left by a previous lockout so a
      // lifted cap doesn't keep scaring agents in this repo.
      clearBudgetLockNotice(repoPath);
    }

    // Multi-repo: store all repo paths and per-repo git state
    if (allRepoPaths && allRepoPaths.length > 1) {
      state.repoPaths = allRepoPaths;
      state.perRepoState = {};
      for (const rp of allRepoPaths) {
        state.perRepoState[rp] = {
          headShaAtStart: getHeadSha(rp),
          headShaAtLastStop: null,
          prePromptSha: getHeadSha(rp),
          prePromptDirtyFiles: getDirtyFiles(rp),
          branch: getBranch(rp),
        };
      }
      debugLog('session-start', 'multi-repo state initialized', {
        repoPaths: allRepoPaths,
        perRepoState: Object.fromEntries(
          Object.entries(state.perRepoState).map(([k, v]) => [path.basename(k), { head: v.headShaAtStart?.slice(0, 8), branch: v.branch }])
        ),
      });
    }

    // Save to tagged file — each concurrent session gets its own state file
    // For multi-repo sessions, save to hookCwd (parent dir) since it's not a git repo
    const saveCwd = allRepoPaths ? hookCwd : repoPath;

    // ONE state file per server session. The server's session-start dedup
    // ladder can return an EXISTING sessionId for what the CLI treated as a new
    // conversation (Codex fires session-start on every launch and its per-turn
    // thread id rotates, so the CLI mints a fresh tag while the server matches
    // the live session). Writing a second tagged file then leaves TWO state
    // files for ONE session, each with its own prompts[]/promptShadows — so the
    // new file's turn numbering restarts at 0 and collides with indices the
    // first file already recorded. Server-side promptText is append-only
    // (first write wins), so those re-sent indices keep the OLD text and the
    // new turns are silently dropped: the user-visible "it stopped capturing"
    // on Codex/Windows, with findStateForHook reporting candidateCount:2.
    //
    // Carry the existing file's accumulated turn state forward and remove it,
    // so numbering continues instead of restarting. The old file's heartbeat
    // exits on its own when its state file disappears (it re-checks existence
    // each tick and exits WITHOUT ending the session), and this hook starts a
    // fresh one below. Baselines (headShaAtStart) are deliberately NOT copied —
    // the just-computed ones belong to this launch.
    try {
      const dup = findDuplicateStateForSession(listActiveSessions(saveCwd), sessionId, sessionTag);
      if (dup?.sessionTag) {
        carryForwardTurnState(state, dup);
        clearSessionState(saveCwd, dup.sessionTag);
        debugLog('session-start', 'merged duplicate state file for same sessionId', {
          sessionId, keptTag: sessionTag, removedTag: dup.sessionTag,
          carriedPrompts: state.prompts?.length || 0,
        });
      }
    } catch { /* best-effort — never block session start on dedup */ }

    // Same-tag resume: this hook fired again for a conversation we are ALREADY
    // tracking (Claude Code does this on resume / compaction / re-attach). The
    // tag comes from the conversation id, so the file about to be written is
    // the SAME path — an overwrite, not a duplicate, which is why the check
    // above never saw it. The dedup guard earlier in this handler normally
    // returns before we get here, but it is a freshness-gated scan; when it
    // misses, this is what stops the conversation's prompt history from being
    // destroyed. Carrying it forward keeps turn numbering continuous, so the
    // resumed turn is index N+1 rather than index 0 landing on the first
    // turn's row (prod 0c65017f: 6 transcript prompts, 1 in state, the newest
    // turn's +399/-24 filed under prompt 1).
    try {
      // Deterministic: the tag fully determines the path, so this needs no
      // scan and no mtime heuristic — the two things the earlier guard
      // depends on and that let this slip through.
      // readStateAtTag, not loadSessionState — see the reservation above.
      const onDisk = readStateAtTag(saveCwd, sessionTag);
      const prior = findSameTagStateForResume(
        onDisk ? [onDisk as any] : [], sessionTag, claudeSessionId,
      );
      if (prior && (prior.prompts?.length || 0) > (state.prompts?.length || 0)) {
        carryForwardTurnState(state, prior);
        debugLog('session-start', 'carried turn history forward across a re-fired session-start', {
          sessionId, sessionTag, source: startSource || '(none)',
          carriedPrompts: state.prompts?.length || 0,
        });
      }
    } catch { /* best-effort — never block session start */ }

    // LAST LINE OF DEFENCE: the agent's own transcript.
    //
    // Everything above recovers the prompt count from a STATE FILE, and every
    // one of those lookups can come up empty — a missed mtime-gated scan, a
    // path that resolved elsewhere, two session-starts racing in one repo, a
    // file cleared between the two launches. When they all miss, `prompts` is
    // [] and the length counter `promptIndexBase + prompts.length - 1` restarts
    // at 0, so the resumed conversation's next turn is written onto server row
    // 0 — a row that already holds the FIRST turn, with different text and
    // different work. The server keeps promptText first-write-wins, so the row
    // keeps the old prompt and silently acquires the new turn's files, diff and
    // commit stamp. That is how session 2e58a848's turn 1 — aborted nine
    // seconds in, no files — came to hold 27 lines of a test file written seven
    // hours later, plus that turn's commit sha.
    //
    // The transcript cannot go missing (the agent is reading from it right now)
    // and it is the SAME index space the Stop path already homes against via
    // homePromptIndexByText, so adopting it puts the counter back exactly where
    // the homing pass expects it. Only on a re-fired start (resume / compact /
    // re-attach) and only when we have NO history of our own — a genuine fresh
    // `startup` keeps starting at 0.
    try {
      const transcriptTurns = transcriptPath && resumeSeedApplies(startSource, state.prompts)
        ? extractPromptFileMappings(transcriptPath).length
        : 0;
      const base = resumeBaseFromTranscript(startSource, state.prompts, transcriptTurns);
      if (base !== null) {
        state.promptIndexBase = base;
        debugLog('session-start', 'seeded promptIndexBase from the transcript (no prior state found)', {
          sessionId, sessionTag, source: startSource, promptIndexBase: base,
        });
      }
    } catch (seedErr: unknown) {
      debugLog('session-start', 'transcript base seed failed (non-fatal)', {
        message: seedErr instanceof Error ? seedErr.message : String(seedErr),
      });
    }

    // The reservation may have been adopted while `api.startSession` was in
    // flight: a concurrent user-prompt-submit can call `ensureServerSession`
    // on it and promote the provisional id to a real one. If our own call then
    // failed, `sessionId` is still the placeholder — saving it would demote a
    // registered session back to local and strand the prompt already filed
    // against the real row. A registered id always wins.
    //
    // The same hook may also have USED the reservation: filed its prompt,
    // restamped the row onto the worktree it runs in under the chat's real
    // conversation id, opened a turn. Saving our row over that keeps only the
    // id and throws the rest away — main checkout, composer id, no prompts —
    // so the worktree's next hook finds a row that no longer matches its chat
    // and the chat becomes two sessions (prod 2026-09-09: 5431ff0f on main,
    // e24477e2 on cursor/f9213cfd, one Cursor chat). Fold the adopter's row
    // into ours instead, and tell the server the identity it registered under
    // has moved.
    //
    // readStateAtTag, not loadSessionState — see the reservation above.
    try {
      const onDisk = readStateAtTag(saveCwd, sessionTag);
      const promoted = preferRegisteredSessionId(state.sessionId, onDisk?.sessionId);
      if (promoted !== state.sessionId) {
        debugLog('session-start', 'a concurrent hook registered this session first — keeping its id', {
          ours: state.sessionId, theirs: promoted, sessionTag,
        });
        state.sessionId = promoted;
      }
      if (reservedHere && onDisk && reservationAdoptedMeanwhile(state, onDisk)) {
        const registeredBranch = state.branch;
        const registeredChatId = state.agentSessionId;
        const merge = mergeAdoptedReservation(state, onDisk);
        if (merge.needsBaseline && state.repoPath) {
          // Moved to a tree we never captured; anchor it there, not on main.
          const fresh = captureSessionStartBaseline(state.repoPath, sessionTag);
          state.headShaAtStart = fresh.headShaAtStart;
          state.sessionStartShadowSha = fresh.sessionStartShadowSha;
          state.sessionStartDirtyFiles = fresh.sessionStartDirtyFiles;
          if (!state.prePromptSha) {
            state.prePromptSha = fresh.prePromptSha;
            state.prePromptDirtyFiles = fresh.prePromptDirtyFiles;
          }
        }
        debugLog('session-start', 'a concurrent hook adopted the reservation while session/start was in flight — keeping its turn and identity', {
          sessionId: state.sessionId, sessionTag,
          prompts: state.prompts?.length || 0,
          repoPath: state.repoPath, movedTree: merge.movedTree, rebaselined: merge.needsBaseline,
          agentSessionId: state.agentSessionId, branch: state.branch,
        });
        const identity = {
          ...(state.branch && state.branch !== registeredBranch && { branch: state.branch }),
          ...(state.agentSessionId && state.agentSessionId !== registeredChatId && { agentSessionId: state.agentSessionId }),
        };
        if (connected && !isProvisionalSessionId(state.sessionId) && Object.keys(identity).length > 0) {
          durableUpdate(state.sessionId, identity).catch(() => {});
        }
      }
    } catch { /* best-effort — never block session start */ }
    // Registration is settled by here (real id, or local after a failed call),
    // so the row is no longer a placeholder.
    delete (state as unknown as { pendingRegistration?: boolean }).pendingRegistration;

    // One last read immediately before the atomic save closes the other
    // interleaving: session-start's first read can see its untouched
    // reservation, then user-prompt-submit saves the first turn while this
    // handler is preparing its final write. Without this retry the stale
    // session-start row overwrites that prompt. This occurred intermittently
    // on Windows, where process scheduling makes the interval wide enough to
    // hit in the concurrent-start E2E.
    try {
      const justAdopted = readStateAtTag(saveCwd, sessionTag);
      if (reservedHere && justAdopted && reservationAdoptedMeanwhile(state, justAdopted)) {
        const merge = mergeAdoptedReservation(state, justAdopted);
        if (merge.needsBaseline && state.repoPath) {
          const fresh = captureSessionStartBaseline(state.repoPath, sessionTag);
          state.headShaAtStart = fresh.headShaAtStart;
          state.sessionStartShadowSha = fresh.sessionStartShadowSha;
          state.sessionStartDirtyFiles = fresh.sessionStartDirtyFiles;
          if (!state.prePromptSha) {
            state.prePromptSha = fresh.prePromptSha;
            state.prePromptDirtyFiles = fresh.prePromptDirtyFiles;
          }
        }
        // `mergeAdoptedReservation` does `Object.assign(ours, onDisk, keep)`,
        // and `pendingRegistration` is not one of REGISTRATION_FIELDS — so the
        // adopter's still-provisional row copies the flag straight back over
        // the `delete` a few lines above. Re-clear it: registration HAS
        // happened, and a row that says otherwise is treated as a placeholder
        // by every later reader.
        delete (state as unknown as { pendingRegistration?: boolean }).pendingRegistration;
        debugLog('session-start', 'a concurrent hook adopted the reservation just before its final save — keeping its turn', {
          sessionId: state.sessionId, sessionTag, prompts: state.prompts?.length || 0,
        });
      }
    } catch { /* best-effort — never block session start */ }

    saveSessionState(state, saveCwd, sessionTag);
    // The reservation's mirror is keyed by the provisional id, so the save
    // above (keyed by the real one) does not replace it — drop it, or it stays
    // listed as a live local session for good.
    if (reservedSessionId !== state.sessionId) dropSessionMirror(reservedSessionId);
    debugLog('session-start', 'state saved', {
      sessionId: state.sessionId, sessionTag,
      // A resume that saves ZERO prompts is the shape that overwrites row 0.
      // Logged so the next occurrence is visible in hooks.log instead of only
      // showing up days later as a turn holding another turn's work.
      prompts: state.prompts?.length || 0,
      source: startSource || '(none)',
    });

    // Trail auto-attach is now server-side (session/end matches the session
    // to repo-scoped Feature Trails by repo + branch) — the CLI no longer
    // maintains a parallel per-repo git-ref trail store. The Origin dashboard
    // is the single source of truth for trails.

    // Start background heartbeat daemon (both connected and standalone mode)
    // In standalone: heartbeat detects parent process death + state file staleness → auto-ends session
    {
      const stateFile = getStatePath(saveCwd, sessionTag);
      const hbApiUrl = (connected && config) ? (config.apiUrl || 'https://getorigin.io') : '';
      const hbApiKey = (connected && config) ? config.apiKey : '';
      // state.sessionId, not the local `sessionId`: when a concurrent hook
      // registered the reservation first, the file carries ITS id and a
      // daemon started on ours would ping a session that does not exist.
      startHeartbeat(state.sessionId, hbApiUrl, hbApiKey, stateFile, finalAgentSlug);
      debugLog('session-start', 'heartbeat started', { sessionId: state.sessionId, stateFile, agentSlug: finalAgentSlug, standalone: !connected });
    }

    // Build system message: agent system prompt first, then tracking notice + policies + attribution
    let systemMsg = '';
    // Budget banner goes FIRST \u2014 a breached hard cap must be the very
    // first thing on the agent's initial screen, before any prompt or
    // tracking notice. Scoped soft-cap breaches get the amber warn-only
    // variant instead.
    if (budgetRefusedReason) {
      systemMsg += buildBudgetBanner(budgetRefusedReason) + '\n\n';
    } else if (budgetWarnReason) {
      systemMsg += buildBudgetWarningBanner(budgetWarnReason) + '\n\n';
    }
    if (agentSystemPrompt) {
      systemMsg += agentSystemPrompt + '\n\n';
    }
    systemMsg += 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
    if (!connected) {
      systemMsg += ' (standalone mode)';
    }
    if (activePolicies && Array.isArray(activePolicies) && activePolicies.length > 0) {
      systemMsg += '\n\nActive policies for this session:\n' +
        activePolicies.map((p: string) => `- ${p}`).join('\n');
    }

    // Pull remote notes down first (throttled) so the attribution/memory
    // blocks below reflect work done on OTHER clones — the fresh-clone
    // teammate case. Without this, a just-cloned repo shows almost no AI
    // context until the user runs `origin link`/`blame`. No-op after the
    // first sync until the backoff window elapses; never fatal.
    try {
      syncNotesForSessionStart(repoPath);
    } catch {
      // Non-fatal — attribution below still renders whatever notes are local.
    }

    // Assemble Origin's repo-context blocks into ONE deduplicated section:
    // what the repo IS (brief) → AI-authorship % → what past sessions DID
    // (memory) → in-progress (handoff). Memory supersedes attribution's
    // commit-level activity/file lists, so the agent no longer has to reconcile
    // two near-duplicate "recent work" + "hot files" lists. Each builder is
    // independently non-fatal; the repo brief is a cache-only read (never runs
    // the LLM in this hot path).
    const safeCtx = (fn: () => string | null): string | null => { try { return fn(); } catch { return null; } };
    // Held outside the try so the rules-file write below can subtract it — see
    // agentReadsContextFromHook.
    let injectedRepoContext: string | null = null;
    try {
      const repoContext = assembleRepoContext({
        brief: safeCtx(() => buildRepoBriefContext(repoPath)),
        attribution: safeCtx(() => buildAttributionContext(repoPath)),
        // Prefer the LLM continuation brief (what recent sessions DID + what's
        // in flight); fall back to the deterministic distillation offline.
        memory: safeCtx(() => buildMemoryBriefContext(repoPath)) || safeCtx(() => buildMemoryContext(repoPath)),
        // Both of the above are capped digests. Tell the agent where the rest
        // lives so it can PULL detail instead of assuming the digest is all
        // there is — or, worse, that there is no memory at all.
        memoryPointer: safeCtx(() => buildMemoryPointerContext(repoPath)),
        handoff: safeCtx(() => buildHandoffContext(repoPath)),
        // The directive that turns the digest above from something the agent
        // MAY consult into something it is told to consult first.
        startupCheck: safeCtx(() => buildStartupCheckContext(repoPath)),
      });
      if (repoContext) {
        systemMsg += '\n\n' + repoContext;
        injectedRepoContext = repoContext;
        // Tell the user-prompt-submit path this conversation already has it, so
        // the first prompt doesn't deliver a second copy — see
        // fullContextAlreadyInjected.
        recordFullContextInjection(repoPath, hookLookupSessionId(input.session_id, agentSlug, input.conversation_id) || input.session_id);
        debugLog('session-start', 'repo context injected (consolidated)', { length: repoContext.length });
      }
    } catch {
      // Non-fatal — repo context is best-effort.
    }
    // P1: if the brief is missing/stale, generate it in the BACKGROUND for the
    // next session (debounced, gated, non-blocking — never runs the LLM here).
    try { maybeSpawnBriefGeneration(repoPath); } catch { /* best-effort */ }

    // Inject the Origin authoring framework — short prompt telling the
    // agent to emit structured `[Origin: …]` markers as it works so the
    // post-PR reviewer can scan intent / decisions / open questions /
    // verification steps without round-tripping through synthesis. Path
    // A of "GitHub for agents" (server-side synthesis is the Path B
    // fallback on existing PR detail; agent-emitted text takes
    // precedence when present). Goes LAST so it's the most recent
    // thing the agent reads — models tend to weight tail context more.
    const frameworkGuidance = buildOriginFrameworkGuidance();
    systemMsg += '\n\n' + frameworkGuidance;

    // The file keeps the framework; the HOOK copy drops it once the file has
    // it. `systemMsg` stays canonical for what we write to disk below —
    // subtracting it there too would delete the copy we are choosing to keep.
    const frameworkInFile = agentFileCarriesFramework(finalAgentSlug || agentSlug, repoPath);
    const hookMsg = frameworkInFile
      ? systemMsg.split('\n\n' + frameworkGuidance).join('').replace(/\n{3,}/g, '\n\n').trim()
      : systemMsg;
    debugLog('session-start', 'framework guidance injected', {
      overHook: !frameworkInFile, savedChars: systemMsg.length - hookMsg.length,
    });

    // Deliver the context through each agent's correct channel (see
    // buildContextInjectionPayload). Codex gets null here — it reads from
    // AGENTS.md — but we still surface the budget banner in its warning
    // area: "your cap is breached" belongs on the initial screen.
    const payload = buildContextInjectionPayload(agentSlug, 'SessionStart', hookMsg);
    if (payload) {
      process.stdout.write(payload);
    } else if (agentSlug === 'codex' && budgetRefusedReason) {
      process.stdout.write(buildBudgetBanner(budgetRefusedReason) + '\n');
    } else if (agentSlug === 'codex' && budgetWarnReason) {
      process.stdout.write(buildBudgetWarningBanner(budgetWarnReason) + '\n');
    }
    // Make the preamble VISIBLE for the agents that don't render stdout as a
    // banner (everyone but Gemini) — see emitVisiblePreamble.
    // Same copy the hook delivered — the visible preamble must not show a
    // framework block the payload deliberately omitted.
    emitVisiblePreamble(agentSlug, hookMsg);
    debugLog('session-start', 'system prompt injected', { agent: agentSlug, length: hookMsg.length, budgetBanner: !!budgetRefusedReason, budgetWarnBanner: !!budgetWarnReason });

    // Write rules files so agents natively see Origin policies.
    //
    // For an agent that already got the repo-context block over the hook
    // channel, its OWN rules file gets everything EXCEPT that block — the
    // durable half (tracking notice, active policies, the authoring
    // framework), which is what a rules file is for. The volatile half
    // (memory digest, brief, attribution, handoff) is per-session and was
    // already delivered this turn; repeating it in an always-loaded file is
    // what made the digest arrive three times per turn. Sibling files still
    // get the full text — see writeAgentRulesFile.
    if (systemMsg) {
      try {
        writeAgentRulesFile(
          finalAgentSlug || '',
          systemMsg,
          repoPath,
          durableRulesFileMessage(systemMsg, injectedRepoContext, finalAgentSlug || ''),
        );
      } catch {
        // Non-fatal
      }
    }
  } catch (err: any) {
    debugLog('session-start', 'ERROR', { message: err.message, stack: err.stack });
    const status = err.status || 0;
    if (status === 401) {
      process.stderr.write(`[origin] Session blocked — invalid or expired API key. Run \`origin login\` to re-authenticate.\n`);
    } else if (status === 403) {
      process.stderr.write(`[origin] Session blocked — ${err.message}\n`);
    } else if (status === 429) {
      process.stderr.write(`[origin] Session blocked — budget limit reached. ${err.message}\n`);
      // The refusal must leave a LOCAL trace. Codex/Cursor ignore hook
      // exit-2 blocking and don't reliably fire user-prompt-submit (whose
      // own 429 fallback would persist the lockout) — so without a state
      // file carrying budgetBlocked here, the agent kept editing and
      // committing past a breached hard cap with nothing in its way
      // (user-reported: codex committed while all three caps sat at
      // 110%). Persist a minimal local-only session flagged blocked so
      // the git pre-commit gate — which git enforces for EVERY agent —
      // has something to read.
      try {
        const scHookCwd = input.cwd || process.cwd();
        const scRepoPath = getWorkingGitRoot(scHookCwd) || discoverGitRoot(scHookCwd) || '';
        if (scRepoPath) {
          const fbId = `local-${crypto.randomUUID()}`;
          const fbTag = (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;
          const fbState: SessionState = {
            sessionId: fbId,
            claudeSessionId: input.session_id || fbId,
            agentSessionId: input.session_id || undefined,
            transcriptPath: input.transcript_path || '',
            model: input.model || agentSlug || 'unknown',
            startedAt: new Date().toISOString(),
            prompts: [],
            repoPath: scRepoPath,
            // Identity for a later ensureServerSession upgrade — without it
            // the server would name the repo after the worktree basename.
            canonicalRepoPath: getCanonicalRepoPath(scRepoPath),
            lastCwd: scHookCwd,
            headShaAtStart: getHeadSha(scHookCwd),
            headShaAtLastStop: null,
            prePromptSha: getHeadSha(scHookCwd),
            branch: getBranch(scHookCwd),
            sessionTag: fbTag,
            agentSlug,
            budgetBlocked: true,
            budgetBlockReason: err?.message || 'Budget limit exceeded',
          };
          saveSessionState(fbState, scRepoPath, fbTag);
          writeBudgetLockNotice(scRepoPath, fbState.budgetBlockReason || 'Budget limit exceeded');
          debugLog('session-start', '429 — persisted local blocked state for the git-hook budget gate', {
            sessionTag: fbTag, repoPath: scRepoPath,
          });
        }
      } catch { /* stderr warning above already delivered */ }
    } else if (err.message?.includes('Unknown agent') || err.message?.includes('not registered')) {
      process.stderr.write(`[origin] Agent not registered. Ask your admin to add it in the Origin dashboard.\n`);
    } else {
      process.stderr.write(`[origin] session-start error: ${err.message}\n`);
    }
  }
}

/**
 * Pick the single active session for this commit.
 * Mirrors the logic in handlePostCommit — kept separate to avoid coupling
 * that function's many other responsibilities.
 */
// Auto-close zombie sessions on the SERVER too (the local ENDED mark happens
// lazily in listSessionsForGitHook). Best-effort: any non-alive session in the
// repo gets marked ENDED on disk and ended on the dashboard. Only fires a
// network call for sessions that were actually stale (usually zero).
export async function expireStaleSessionsOnServer(repoPath: string): Promise<void> {
  try {
    for (const s of listActiveSessions(repoPath)) {
      if (isSessionAlive(s)) continue;
      if (markSessionEnded(s)) {
        try { await api.endSessionById(s.sessionId); } catch { /* unknown id / offline — local mark still applied */ }
      }
    }
  } catch { /* non-fatal */ }
}
