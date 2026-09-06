// PreToolUse / PostToolUse: the per-tool-call evidence path.
//
// Moved out of commands/hooks.ts mechanically: the text is unchanged, only its
// home is. Shared helpers still live in hooks.ts and are imported from there.
import { api } from '../../api.js';
import { buildFileAttributionContext } from '../../attribution.js';
import { isConnectedMode, loadConfig } from '../../config.js';
import { debugLog } from '../../debug-log.js';
import { createShadowCommit, getDirtyFiles } from '../../git-capture.js';
import { normalizeToolHookPayload } from '../../hook-payload.js';
import { isMemoryReadCommand, isMemoryReadToolName } from '../../memory.js';
import { anchorEditPositions, extractEditsFromToolCall } from '../../prompt-capture/index.js';
import { redactSecrets } from '../../redaction.js';
import { currentTurnIndex, getBranch, getGitCommonDir, getGitRoot, getHeadSha, getWorkingGitRoot, resolveSessionBranch, saveSessionState } from '../../session-state.js';
import type { SessionState, ToolCallRecord } from '../../session-state.js';
import { candidateDirsFromCommand, samePath, worktreesAmongCandidates } from '../../session-worktree.js';
import { probeTree, touchedSince } from '../../shell-command-probe.js';
import type { TreeProbe } from '../../shell-command-probe.js';
import { commandWritesFiles, isShellTool, shellCommandText } from '../../shell-write-capture.js';
import { isSubagentSpawnTool } from '../../subagent-tools.js';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { LIVE_EDIT_CONTENT_MAX, LIVE_EDIT_MAX_TOTAL_BYTES, PENDING_WRITE_TTL_MS, baselineShaForTree, currentSessionWorkTree, editContentBytes, enforceBudgetLockout, findStateForHook, hookLookupSessionId, isInsideRepo, liveCaptureEnabled, liveLedgerBytes, recordProbedShellEdits } from '../hooks.js';


/** Cap so a long session cannot grow the claim list without bound. */
export const PENDING_WRITE_MAX = 500;

// ─── Pre-Tool-Use / Post-Tool-Use (F7: Subagent Tracking) ─────────────────

// ── Policy Enforcement Helpers ────────────────────────────────────────────

export function matchGlob(pattern: string, filepath: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(filepath);
}

/**
 * Extract file paths from tool input across different agents.
 * Claude: { file_path, command (grep for paths) }
 * Gemini: { path, file_path, command }
 */
export function extractFilePaths(toolName: string, toolInput: Record<string, any>): string[] {
  const paths: string[] = [];

  // Direct file path fields (Read, Write, Edit tools)
  for (const key of ['file_path', 'path', 'filePath', 'filename', 'file']) {
    if (typeof toolInput[key] === 'string' && toolInput[key]) {
      paths.push(toolInput[key]);
    }
  }

  // Bash/shell commands — extract paths from common file operations
  const cmd = toolInput.command || toolInput.cmd || toolInput.script || '';
  if (typeof cmd === 'string' && cmd) {
    // Match common file access patterns: cat, less, head, tail, vim, nano, code, read, source
    const fileOps = /(?:cat|less|head|tail|vim|nano|code|source|rm|mv|cp|chmod|chown)\s+(?:-[a-zA-Z]*\s+)*([^\s|>&;]+)/g;
    let m;
    while ((m = fileOps.exec(cmd)) !== null) {
      if (m[1] && !m[1].startsWith('-')) paths.push(m[1]);
    }
  }

  return paths;
}

export function enforceFileRestrictions(
  rules: Array<{
    type: string; condition: string; action: string; severity: string;
    policyId?: string; ruleId?: string; policyName?: string;
  }>,
  filePaths: string[],
  repoPath: string,
): { blocked: boolean; reason: string; file: string; policyId?: string; policyName?: string } | null {
  if (!rules || rules.length === 0 || filePaths.length === 0) return null;

  for (const rule of rules) {
    if (rule.type !== 'FILE_RESTRICTION') continue;
    if (rule.action.toUpperCase() !== 'BLOCK') continue;

    let cond: Record<string, unknown>;
    try { cond = JSON.parse(rule.condition); } catch { continue; }
    const pattern = cond.path as string | undefined;
    if (!pattern) continue;

    for (const fp of filePaths) {
      // Normalize: try both absolute and relative-to-repo
      const relPath = fp.startsWith('/') && repoPath
        ? fp.replace(repoPath + '/', '').replace(repoPath, '')
        : fp;
      const candidates = [fp, relPath, relPath.replace(/^\//, '')];

      for (const candidate of candidates) {
        if (matchGlob(pattern, candidate)) {
          return {
            blocked: true,
            reason: `[Origin Policy] Blocked: file "${candidate}" matches restricted pattern "${pattern}"`,
            file: candidate,
            policyId: rule.policyId,
            policyName: rule.policyName,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Lazy multi-repo attribution.
 *
 * Resolves each file path to its containing git repo. If any path lives in
 * a repo that isn't yet attached to this session, notifies the API to attach
 * it and tracks per-repo git state locally. This is how we pick up sibling
 * repos the agent actually touches — without blindly attaching every repo
 * under the cwd at session-start.
 */
export async function attachReposForFiles(
  state: SessionState,
  filePaths: string[],
  saveCwd: string,
): Promise<void> {
  if (!filePaths.length) return;
  if (!state.sessionId || state.sessionId.startsWith('local-')) return;
  if (!isConnectedMode()) return;

  const attached = new Set<string>();
  if (state.repoPath) attached.add(state.repoPath);
  // A worktree session's files resolve (via getGitRoot's collapse) to the
  // CANONICAL repo path, which differs from state.repoPath (the worktree) —
  // without this the session's own repo would be "attached" a second time.
  if (state.canonicalRepoPath) attached.add(state.canonicalRepoPath);
  for (const rp of state.repoPaths || []) attached.add(rp);

  const newRoots = new Set<string>();
  for (const fp of filePaths) {
    if (!fp) continue;
    const abs = path.isAbsolute(fp) ? fp : path.resolve(state.repoPath || saveCwd, fp);
    let dir: string;
    try {
      dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      dir = path.dirname(abs);
    }
    const root = getGitRoot(dir);
    if (!root || attached.has(root) || newRoots.has(root)) continue;
    newRoots.add(root);
  }
  if (newRoots.size === 0) return;

  let mutated = false;
  for (const root of newRoots) {
    try {
      await api.attachRepo(state.sessionId, root);
    } catch (err: any) {
      debugLog('attach-repo', 'failed (non-fatal)', { root, error: err?.message });
      continue;
    }
    if (!state.repoPaths) state.repoPaths = state.repoPath ? [state.repoPath] : [];
    state.repoPaths.push(root);
    if (!state.perRepoState) state.perRepoState = {};
    state.perRepoState[root] = {
      headShaAtStart: getHeadSha(root),
      headShaAtLastStop: null,
      prePromptSha: getHeadSha(root),
      prePromptDirtyFiles: getDirtyFiles(root),
      branch: getBranch(root),
    };
    mutated = true;
    debugLog('attach-repo', 'attached', { root, sessionId: state.sessionId });
  }
  if (mutated) saveSessionState(state, saveCwd, state.sessionTag);
}

export async function handlePreToolUse(rawInput: Record<string, any>, agentSlug?: string): Promise<void> {
  // Every agent names these fields differently; normalise before anything
  // reads them, or the handler quietly no-ops for agents it was not written
  // against — which is indistinguishable from "this agent has no tool hooks".
  const input = normalizeToolHookPayload(rawInput);
  debugLog('pre-tool-use', 'begin', { tool_name: input.tool_name, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  if (!found) {
    debugLog('pre-tool-use', 'ABORT: no session state');
    return;
  }
  const { state, saveCwd } = found;

  // Track the session's last-seen cwd. The harness can move a session into a
  // linked git worktree after session-start; bare git hooks (prepare-commit-msg,
  // post-commit) then rely on lastCwd to match the worktree commit back to
  // this session. Persisted by the unconditional save at the end of this hook.
  if (hookCwd && state.lastCwd !== hookCwd) {
    debugLog('pre-tool-use', 'lastCwd updated', { from: state.lastCwd, to: hookCwd });
    state.lastCwd = hookCwd;
  }

  // A shell command can name a worktree the harness never told us about
  // (`cd /path/to/wt && …`). Snapshot a baseline there BEFORE the command
  // runs, so its writes are attributable instead of invisible.
  discoverWorkTreesFromCommand(state, input);
  // Fingerprint the trees BEFORE the command runs — the other half is taken at
  // post-tool-use, and the difference is what this command provably wrote.
  beginShellProbe(state, input);

  // Extract file paths once — used for both lazy repo attach and policy enforcement.
  const toolInput = input.tool_input || {};
  const filePaths = extractFilePaths(input.tool_name || '', toolInput);
  if (filePaths.length > 0) {
    debugLog('pre-tool-use', 'extracted paths', { filePaths, toolName: input.tool_name });
  }

  // ── Did this session read its memory? ───────────────────────────────────
  // Session-start hands the agent a directive to read the repo's Origin memory
  // before doing anything substantive (buildStartupCheckContext). This is where
  // we find out whether it did. A tool call is the only evidence that survives:
  // the agent's prose acknowledgement is not visible from a hook, and the
  // absence of a memory read is exactly what the escalation at user-prompt-
  // submit triggers on. Latch-once — never cleared for the life of the session.
  if (!state.memoryChecked) {
    const probeCmd = toolInput.command || toolInput.cmd || toolInput.script || '';
    if (isMemoryReadToolName(input.tool_name) || isMemoryReadCommand(typeof probeCmd === 'string' ? probeCmd : '')) {
      state.memoryChecked = true;
      debugLog('pre-tool-use', 'origin memory read observed', { tool: input.tool_name });
    }
  }

  // ── Claim the write BEFORE it happens ───────────────────────────────────
  // The live ledger is written at POST-tool-use, i.e. after the bytes are on
  // disk. In a shared checkout that leaves a window where the file is dirty
  // and unattributed, and a concurrent session diffing right then takes it.
  // Recording the intent here puts the claim on disk first. Best-effort and
  // never blocking: a missed claim just returns us to the old race.
  try {
    // Same work-tree scoping as recordLiveEdits, and for the same reasons —
    // this claim and that ledger entry describe the SAME write, so if they
    // disagree on the path shape the claim protects a name the ledger never
    // uses. A worktree session claimed `.claude/worktrees/<name>/pkg/x.ts`
    // while its own ledger recorded `pkg/x.ts`.
    const claimRoot = currentSessionWorkTree(state) || state.repoPath || saveCwd;
    const claimedRaw = extractEditsFromToolCall(
      input.tool_name || '', toolInput, claimRoot,
      state.agentSlug === 'cursor' ? 'cursor' : 'claude', false,
    );
    // A write OUTSIDE the tree is not ours to claim. recordLiveEdits has
    // filtered these since 81d65cb5; this path never did, so a scratch file
    // in /tmp or a note under ~/.claude became a pending claim and then, via
    // ownEditedFiles, part of this session's ownership set.
    const claimed = claimedRaw.filter((e) => e?.file && isInsideRepo(claimRoot, e.file));
    if (claimed.length > 0) {
      const now = Date.now();
      // Prune expired claims on write as well as on read, so the list cannot
      // grow across a long session of edits to the same handful of files.
      const kept = (state.pendingWrites || []).filter((w) => {
        const t = Date.parse(w?.at || '');
        return Number.isFinite(t) && now - t <= PENDING_WRITE_TTL_MS;
      });
      const at = new Date(now).toISOString();
      const seen = new Set(kept.map((w) => w.file));
      for (const e of claimed) {
        if (e?.file && !seen.has(e.file)) { kept.push({ file: e.file, at }); seen.add(e.file); }
      }
      state.pendingWrites = kept.slice(-PENDING_WRITE_MAX);
      debugLog('pre-tool-use', 'claimed pending write', {
        tool: input.tool_name, files: claimed.map((e) => e.file).slice(0, 5),
      });
      // Persist NOW — the unconditional save at the end of this hook runs
      // after policy checks that can exit the process, and a claim that is
      // still in memory when the tool runs is a claim that never existed.
      try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
    }
  } catch { /* claiming is best-effort — never block a tool call on it */ }

  // ── Lazy multi-repo attach ──────────────────────────────────────────────
  // If the agent touches a file in a sibling repo, attach it now instead of
  // attaching every repo under cwd upfront (the old behavior bundled unrelated
  // projects into a single session).
  if (filePaths.length > 0) {
    try {
      await attachReposForFiles(state, filePaths, saveCwd);
    } catch {
      // non-fatal — attribution is best-effort
    }
  }

  // ── Live policy refresh (A) ───────────────────────────────────────────
  // Before enforcing on a file op, pull the current rule set if our cached
  // copy is stale. The heartbeat already refreshes rules from its ping, but
  // it isn't always running (Codex/Cursor, or a just-started session), so we
  // backstop here — TTL-throttled so a burst of tool calls doesn't hammer the
  // API. This is what makes a policy created AFTER the session started take
  // effect: a session that began with zero policies has empty enforcementRules
  // and would otherwise never re-check. Best-effort — a failed refresh falls
  // back to the cached rules and never blocks the agent.
  const POLICY_REFRESH_TTL_MS = 30_000;
  if (
    filePaths.length > 0 &&
    isConnectedMode() &&
    state.sessionId && !state.sessionId.startsWith('local-') &&
    Date.now() - (state.enforcementRulesFetchedAt || 0) > POLICY_REFRESH_TTL_MS
  ) {
    try {
      const fresh = await api.refreshSessionPolicies(state.sessionId);
      state.enforcementRules = fresh.enforcementRules;
      if (fresh.activePolicies) state.activePolicies = fresh.activePolicies;
      state.enforcementRulesFetchedAt = Date.now();
      saveSessionState(state, saveCwd, state.sessionTag);
    } catch { /* keep cached rules — never block the agent on a refresh blip */ }
  }

  // ── Policy Enforcement: FILE_RESTRICTION ──────────────────────────────
  if (state.enforcementRules && state.enforcementRules.length > 0 && filePaths.length > 0) {
    const result = enforceFileRestrictions(state.enforcementRules, filePaths, state.repoPath);
    if (result?.blocked) {
      debugLog('pre-tool-use', 'BLOCKED by policy', { reason: result.reason });
      // Report to the audit pipeline before exiting — these blocks used
      // to be enforced silently, leaving no trace for admins. Awaited
      // (with catch) since process.exit below would drop an in-flight
      // request; the tool is blocked either way, so the latency is paid
      // only on violations.
      if (isConnectedMode()) {
        try {
          const agentCfg = loadConfig();
          await api.reportViolation({
            machineId: agentCfg?.machineId || 'unknown',
            policyId: result.policyId,
            policyType: 'FILE_RESTRICTION',
            policyName: result.policyName,
            description: `[pre-tool-use] ${result.reason.replace(/^\[Origin Policy\] /, '')}`,
            filepath: result.file,
            sessionId: state.sessionId && !state.sessionId.startsWith('local-') ? state.sessionId : undefined,
          });
        } catch { /* never block the block on reporting */ }
      }
      // Exit code 2 + stderr blocks the tool for both Claude Code and Gemini CLI
      process.stderr.write(result.reason + '\n');
      process.exit(2);
    }
  }

  // ── Budget lockout gate ────────────────────────────────────────────────
  // Blocks tool calls mid-session once a hard cap is breached (the flag
  // is set by the heartbeat ping or the previous turn's stop PATCH), so
  // a running session stops doing work instead of overshooting the cap
  // until the next session start.
  await enforceBudgetLockout(state, agentSlug, saveCwd, 'pre-tool-use');

  // ── Auto-Snapshot: save working tree before file-modifying tools ────────
  const toolNameLower = (input.tool_name || '').toLowerCase();
  if (['edit', 'write', 'patch', 'create', 'insert', 'replace', 'notebook_edit'].some(t => toolNameLower.includes(t))) {
    try {
      const cfg = loadConfig();
      if (cfg?.autoSnapshot && state.repoPath) {
        const { createAutoSnapshot } = await import('../snapshot.js');
        const snapId = createAutoSnapshot(state.repoPath, state.sessionTag);
        if (snapId) {
          debugLog('pre-tool-use', 'auto-snapshot created', { snapId, toolName: input.tool_name });
          // Fire-and-forget upload so the dashboard timeline can mark a dot.
          // Non-fatal — snapshots stay locally even if upload fails.
          if (isConnectedMode() && state.sessionId && !state.sessionId.startsWith('local-')) {
            api.uploadSnapshot(state.sessionId, {
              snapshotId: snapId,
              type: 'auto',
              takenAt: new Date().toISOString(),
              promptIndex: Math.max(0, (state.prompts?.length || 1) - 1),
              commitSha: getHeadSha(state.repoPath) || undefined,
            }).catch(() => { /* non-fatal */ });
          }
        }
      }
    } catch {
      // Non-fatal — never block the agent for snapshot failures
    }
  }

  // ── File Attribution Context ─────────────────────────────────────────────
  // When an agent reads or edits a file, inject per-file attribution so
  // the agent knows who wrote each part before modifying it.
  const toolName = (input.tool_name || '').toLowerCase();
  const isReadStyle = ['read', 'view', 'open', 'cat', 'grep', 'glob'].some(t => toolName.includes(t));
  const isWriteStyle = ['edit', 'write', 'patch', 'create', 'insert', 'replace', 'notebook_edit'].some(t => toolName.includes(t));
  if (isReadStyle || isWriteStyle) {
    const toolInput = input.tool_input || {};
    const filePath = toolInput.file_path || toolInput.path || toolInput.filePath || toolInput.filename || '';
    if (filePath && state.repoPath) {
      try {
        const fileCtx = buildFileAttributionContext(state.repoPath, filePath);
        if (fileCtx) {
          // Output as JSON system message — Claude Code reads this from stdout
          const output = JSON.stringify({ systemMessage: fileCtx });
          process.stdout.write(output);
          debugLog('pre-tool-use', 'file attribution injected', { filePath, length: fileCtx.length });
        }
      } catch {
        // Non-fatal
      }
    }
  }

  // ── Track files the agent has loaded into context ────────────────────────
  // Persisted into git notes at session-end as `filesRead` so the next
  // agent can see what the prior agent looked at, not just what it changed.
  // Dedup on the *normalized* (repo-relative) form so we don't double-count
  // when the same file is read via both absolute and relative paths across
  // pre-tool-use invocations.
  if (isReadStyle && filePaths.length > 0) {
    if (!state.filesRead) state.filesRead = [];
    const cap = 100;
    const seen = new Set(state.filesRead);
    for (const fp of filePaths) {
      if (!fp) continue;
      const rel = state.repoPath && fp.startsWith(state.repoPath + '/')
        ? fp.slice(state.repoPath.length + 1)
        : fp;
      if (seen.has(rel)) continue;
      state.filesRead.push(rel);
      seen.add(rel);
      if (state.filesRead.length >= cap) break;
    }
  }

  // Initialize tool-call ring if needed
  if (!state.subagents) state.subagents = [];

  // Prefer the agent-provided ID so post-tool-use can match unambiguously
  // even when tool calls run in parallel (R1 in SUBAGENT_AUDIT.md).
  const toolCallId = input.tool_call_id || input.tool_use_id ||
    `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const record: ToolCallRecord = {
    toolCallId,
    toolName: input.tool_name || 'unknown',
    startedAt: new Date().toISOString(),
    prompt: input.tool_input ? JSON.stringify(input.tool_input).slice(0, 500) : undefined,
  };

  state.subagents.push(record);

  // Real sub-agent spawn: the `Task` tool launches a child agent. Record it
  // separately (not every tool call) so "N sub-agents" is a true statement.
  // tool_input carries { subagent_type, description, prompt } for Claude Code.
  if (isSubagentSpawnTool(input.tool_name)) {
    if (!state.subagentSpawns) state.subagentSpawns = [];
    const ti = (input.tool_input || {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    state.subagentSpawns.push({
      toolCallId,
      subagentType: str(ti.subagent_type) ?? str(ti.subagentType),
      description: str(ti.description),
      prompt: str(ti.prompt) ? redactSecrets(String(ti.prompt)).redacted.slice(0, 2000) : null,
      promptIndex: Math.max(0, (state.prompts?.length || 1) - 1),
      startedAt: record.startedAt,
    });
    debugLog('pre-tool-use', 'sub-agent spawn recorded', {
      toolCallId, subagentType: state.subagentSpawns[state.subagentSpawns.length - 1].subagentType,
    });
  }

  saveSessionState(state, saveCwd, state.sessionTag);
  debugLog('pre-tool-use', 'recorded', { toolCallId, toolName: record.toolName });
}

export const LIVE_EDIT_MAX_ENTRIES = 2000;

/**
 * Did the tool call this hook payload describes FAIL?
 *
 * Agents disagree on the shape, so check the ones seen in the wild rather than
 * one field: Claude Code's PostToolUse carries the result under
 * `tool_response` (an object with `is_error`/`error`, or a bare string that
 * begins with "Error:"); some agents put a `success: false` or a top-level
 * `error` alongside it. Unknown shapes are treated as SUCCESS — a capture we
 * wrongly keep is a wrong number, but a capture we wrongly drop is lost work,
 * and the second is unrecoverable.
 */
export function toolCallFailed(input: Record<string, any>): boolean {
  if (!input || typeof input !== 'object') return false;
  if (input.success === false) return true;
  const res = (input as any).tool_response ?? (input as any).toolResponse;
  if (typeof res === 'string') return /^\s*(error|tool error)\b[:\s]/i.test(res);
  if (res && typeof res === 'object') {
    if (res.is_error === true || res.isError === true) return true;
    if (res.success === false) return true;
    if (typeof res.error === 'string' && res.error.trim()) return true;
  }
  return false;
}

export function recordLiveEdits(state: SessionState, input: Record<string, any>, repoPath: string): boolean {
  if (!liveCaptureEnabled()) return false;
  try {
    // Relativise against the tree this session is WRITING IN, not the
    // canonical repo. For a linked worktree (<repo>/.claude/worktrees/<name>,
    // how Claude Code and the Agent tool run isolated sessions) those differ,
    // and using repoPath breaks the ledger in three compounding ways:
    //
    //   1. The tool-call path is stored as
    //      `.claude/worktrees/<name>/packages/cli/src/x.ts` while every
    //      git-derived path for the SAME file is `packages/cli/src/x.ts`, so
    //      one file occupies two rows that never match each other.
    //   2. `**/.claude/worktrees/**` is a deliberate ignore rule — a sibling
    //      worktree's files are not the main checkout's work — so the
    //      tool-call form is then DISCARDED downstream. A worktree session's
    //      only proof-grade evidence, thrown away by a rule aimed at someone
    //      else's worktree.
    //   3. `isInsideRepo(repoPath, …)` waves through the whole main checkout,
    //      so a sibling agent's file in the main tree looks local to us.
    //
    // Measured on session 6e9947a5 turn 1: `inferred-ledger-not-ownership.test.ts`
    // appeared TWICE in filesChanged, once in each shape, while `hooks.ts` —
    // edited through the shell and therefore caught repo-relative by the probe
    // — appeared correctly. Scoping to the work tree fixes all three at once,
    // and for a non-worktree session it is exactly repoPath.
    const workRoot = currentSessionWorkTree(state) || repoPath;
    const toolName = String(input.tool_name || '');
    if (!toolName) return false;
    // Claude Code PostToolUse → tool_input; other agents vary, so fall back.
    const toolInput =
      (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input
        : (input.toolInput && typeof input.toolInput === 'object') ? input.toolInput
          : (input.tool_response && typeof input.tool_response === 'object' && input.tool_response.input) ? input.tool_response.input
            : {};
    // The turn that is RUNNING — not the tail of the prompt list. A prompt
    // typed while this turn is still working appends to `prompts` the moment
    // the user hits enter, so the tail names the QUEUED prompt and every
    // remaining edit of the running turn gets filed under it.
    // currentTurnIndex() returns null when the open turn can no longer be
    // found by its text (the list renumbered under us); dropping the capture
    // is the honest outcome — the transcript pass at Stop still covers the
    // edit, whereas a wrong row is not recoverable.
    const promptIndex = currentTurnIndex(state);
    if (promptIndex == null || promptIndex < 0) return false;
    const agentLabel = state.agentSlug === 'cursor' ? 'cursor' : 'claude';
    // warnUnknown=false: this fires for EVERY tool (Read/Grep/Bash…) in a
    // fresh per-call process, so the unknown-tool note would spam stderr.
    // A tool that FAILED wrote nothing — its input describes an edit that does
    // not exist on disk. Claude Code still fires PostToolUse for a rejected
    // Edit ("String to replace not found", a denied permission), and the
    // transcript pass has the same blind spot (see failedToolUseIds in
    // prompt-capture/index.ts). Session cb853c02 turn 2 read +240 on a file
    // git says gained +124: one failed 5→121-line Edit, captured, plus the
    // successful retry of the same block.
    if (toolCallFailed(input)) {
      debugLog('post-tool-use', 'live edit skipped — tool reported an error', { tool: toolName });
      return false;
    }
    const extractedRaw = extractEditsFromToolCall(toolName, toolInput, workRoot, agentLabel, false);
    if (extractedRaw.length === 0) return false;
    // A file OUTSIDE the repo is not this repo's diff. Agents write plenty of
    // them — Origin's own memory notes under ~/.claude, scratch files in /tmp,
    // a sibling project — and toRepoRelative hands back the absolute path
    // unchanged when it cannot relativise, so they flowed into filesChanged
    // and were rendered as repo files. Session 81d65cb5's first turn showed
    // exactly ONE "changed file": Origin's own memory .md in ~/.claude, while
    // the six source files of the commit it made were nowhere.
    const extracted = extractedRaw.filter((e) => isInsideRepo(workRoot, e.file));
    if (extracted.length === 0) {
      debugLog('post-tool-use', 'live edit skipped — all targets outside the repo', {
        tool: toolName, files: extractedRaw.map((e) => e.file).slice(0, 3),
      });
      return false;
    }
    // Drop oversized edits (see LIVE_EDIT_CONTENT_MAX) — the transcript owns
    // those at full fidelity. Keeping a clamped copy would break merge dedup.
    const edits = extracted.filter((e) => editContentBytes(e) <= LIVE_EDIT_CONTENT_MAX);
    if (edits.length === 0) {
      debugLog('post-tool-use', 'live edit too large, deferring to transcript', { tool: toolName });
      return false;
    }
    // Stamp each edit with its real file line BEFORE storing. PostToolUse
    // fires after the tool wrote the file, so the on-disk content reflects
    // the edit and we can read the true position the blame gutter shows.
    // Without this the server synthesizes line numbers from line 1.
    for (const e of edits) e.evidence = 'tool_call';
    anchorEditPositions(edits, repoPath);
    if (!state.liveEdits) state.liveEdits = [];
    if (state.liveEdits.length >= LIVE_EDIT_MAX_ENTRIES || liveLedgerBytes(state) >= LIVE_EDIT_MAX_TOTAL_BYTES) {
      // Ledger full — fall back to the transcript capture for this edit (it
      // records the same tool call, so nothing is actually lost).
      debugLog('post-tool-use', 'live ledger full, deferring to transcript', { entries: state.liveEdits.length });
      return false;
    }
    state.liveEdits.push({
      promptIndex,
      toolName,
      capturedAt: new Date().toISOString(),
      edits,
    });
    debugLog('post-tool-use', 'live edit captured', { promptIndex, tool: toolName, edits: edits.length });
    return true;
  } catch (err: any) {
    debugLog('post-tool-use', 'live capture failed (non-fatal)', { message: err?.message });
    return false;
  }
}

export async function handlePostToolUse(rawInput: Record<string, any>, agentSlug?: string): Promise<void> {
  // Same normalisation as pre-tool-use — see normalizeToolHookPayload.
  const input = normalizeToolHookPayload(rawInput);
  debugLog('post-tool-use', 'begin', { tool_name: input.tool_name, cwd: input.cwd });

  const hookCwd = input.cwd || process.cwd();
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  if (!found) {
    debugLog('post-tool-use', 'ABORT: no session state');
    return;
  }
  const { state, saveCwd } = found;

  // Keep lastCwd current for bare git hooks (see handlePreToolUse). Saved
  // immediately — the saves below only fire when a record matched or the
  // branch changed, and a commit's prepare-commit-msg hook may run before
  // either happens again.
  if (hookCwd && state.lastCwd !== hookCwd) {
    debugLog('post-tool-use', 'lastCwd updated', { from: state.lastCwd, to: hookCwd });
    state.lastCwd = hookCwd;
    saveSessionState(state, saveCwd, state.sessionTag);
  }

  if (state.subagents && state.subagents.length > 0) {
    // Match the post-use to its pre-use record.
    //
    // Prefer toolCallId (R1 fix — parallel tool calls with the same toolName
    // used to race through the reverse-find-by-name path). Fall back to the
    // name-based reverse-find for agents that don't propagate an ID through
    // both hooks (e.g., some older Gemini / Aider builds).
    const toolName = input.tool_name || 'unknown';
    const toolCallId = input.tool_call_id || input.tool_use_id;
    const record = toolCallId
      ? state.subagents.find((r) => r.toolCallId === toolCallId)
      : [...state.subagents].reverse().find((r) => r.toolName === toolName && !r.endedAt);

    if (record) {
      record.endedAt = new Date().toISOString();
      if (input.tool_result) {
        record.result = typeof input.tool_result === 'string'
          ? input.tool_result.slice(0, 500)
          : JSON.stringify(input.tool_result).slice(0, 500);
      }
      saveSessionState(state, saveCwd, state.sessionTag);
      debugLog('post-tool-use', 'updated', { toolCallId: record.toolCallId, toolName });
    }

    // Close out the matching sub-agent spawn so its duration is known. Match by
    // toolCallId only — a spawn call always carries one. The tool NAME lives in
    // subagent-tools.ts: it was hard-coded to 'task' here and in the open site
    // above, and when Claude Code renamed the spawner to 'Agent' both stopped
    // matching and sub-agent capture silently recorded nothing for weeks.
    if (toolCallId && isSubagentSpawnTool(toolName) && state.subagentSpawns) {
      const spawn = state.subagentSpawns.find((s) => s.toolCallId === toolCallId && !s.endedAt);
      if (spawn) {
        spawn.endedAt = new Date().toISOString();
        saveSessionState(state, saveCwd, state.sessionTag);
      }
    }
  }

  // ── Mid-session branch tracking ──────────────────────────────────────────
  // Check branch on every tool use — different agents use different tool names
  // (Claude: Bash, Gemini: shell/run_terminal_command, etc.)
  // getBranch() just reads .git/HEAD so it's cheap
  try {
    const currentBranch = resolveSessionBranch(state, hookCwd);
    if (currentBranch && currentBranch !== state.branch) {
      debugLog('post-tool-use', 'branch changed', { from: state.branch, to: currentBranch });
      state.branch = currentBranch;
      saveSessionState(state, saveCwd, state.sessionTag);
      // Update server (connected mode only)
      if (isConnectedMode() && state.sessionId) {
        api.updateSession(state.sessionId, { branch: currentBranch }).catch(() => {});
      }
    }
  } catch {
    // non-fatal
  }

  // ── Live edit ledger ──────────────────────────────────────────────────────
  // Capture this tool call's edits in real time, tagged with the active
  // prompt. Authoritative source for per-prompt blame at Stop/end.
  // Resolve the probe first: it closes the pre/post pair opened before this
  // command ran, and its result is EVIDENCE, unlike the window Stop falls back
  // to. Both can be true — a turn that used Edit and a heredoc did both.
  const probed = endShellProbe(state, input);
  if (recordLiveEdits(state, input, state.repoPath || saveCwd) || probed) {
    // The shell-write flag still goes up even when the probe captured
    // something: the window is the backstop for what a probe cannot see (a
    // write outside the probed trees, or a tree too dirty to fingerprint), and
    // Stop skips files the ledger already covers.
    noteShellWriteTurn(state, input);
    saveSessionState(state, saveCwd, state.sessionTag);
  } else if (noteShellWriteTurn(state, input)) {
    // Not an edit tool — but a shell command that could have written files.
    // Stop turns this flag into real edits from the turn's git window.
    saveSessionState(state, saveCwd, state.sessionTag);
  }
}

/**
 * Flag the active turn when a shell tool ran a command that could have
 * written to the working tree. Returns true when the flag was newly set
 * (caller persists).
 *
 * Only the FLAG is stored, never the command text: a turn can run dozens of
 * shell calls and the state file is rewritten on every hook, so keeping the
 * commands would put megabytes of heredoc bodies in the agent's hot path.
 * Stop needs one bit per turn — did anything here plausibly write? — and git
 * supplies the rest.
 */
export function noteShellWriteTurn(state: SessionState, input: Record<string, any>): boolean {
  try {
    if (!liveCaptureEnabled()) return false;
    const toolName = String(input.tool_name || '');
    if (!isShellTool(toolName)) return false;
    const toolInput =
      (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input
        : (input.toolInput && typeof input.toolInput === 'object') ? input.toolInput
          : {};
    if (!commandWritesFiles(shellCommandText(toolInput))) return false;
    // The turn that is RUNNING — not the tail of the prompt list. A prompt
    // typed while this turn is still working appends to `prompts` the moment
    // the user hits enter, so the tail names the QUEUED prompt and every
    // remaining edit of the running turn gets filed under it.
    // currentTurnIndex() returns null when the open turn can no longer be
    // found by its text (the list renumbered under us); dropping the capture
    // is the honest outcome — the transcript pass at Stop still covers the
    // edit, whereas a wrong row is not recoverable.
    const promptIndex = currentTurnIndex(state);
    if (promptIndex == null || promptIndex < 0) return false;
    if (!state.shellWriteTurns) state.shellWriteTurns = [];
    if (state.shellWriteTurns.includes(promptIndex)) return false;
    state.shellWriteTurns.push(promptIndex);
    debugLog('post-tool-use', 'shell write-shaped command noted', { promptIndex, tool: toolName });
    return true;
  } catch (err: any) {
    debugLog('post-tool-use', 'shell write note failed (non-fatal)', { message: err?.message });
    return false;
  }
}

// Trees this session may be writing in right now: its working tree plus every
// worktree this turn revealed. Probed as a set, because a single command can
// touch more than one of them.
export function treesToProbe(state: SessionState, promptIndex: number): string[] {
  const out: string[] = [];
  const add = (t: string): void => {
    if (!t) return;
    if (out.some((x) => samePath(x, t))) return;
    out.push(t);
  };
  add(currentSessionWorkTree(state));
  add(state.repoPath || '');
  for (const w of state.discoveredWorkTrees || []) {
    if (w.promptIndex === promptIndex) add(w.path);
  }
  return out.filter(Boolean);
}

export function probeDepsFor(): { listDirty: (t: string) => string[]; stat: (t: string, f: string) => { mtimeMs: number; size: number } | null } {
  return {
    listDirty: (t: string) => getDirtyFiles(t),
    stat: (t: string, f: string) => {
      try {
        const st = fs.statSync(path.join(t, f));
        return { mtimeMs: st.mtimeMs, size: st.size };
      } catch { return null; }
    },
  };
}

/**
 * Fingerprint every tree BEFORE a write-shaped shell command runs.
 *
 * This is the evidence half of shell capture: what changes between here and
 * post-tool-use is what the command did. The turn window cannot make that
 * statement — it only knows what was dirty, which in a shared checkout
 * includes other agents' work that was already sitting there.
 */
export function beginShellProbe(state: SessionState, input: Record<string, any>): void {
  try {
    if (!liveCaptureEnabled()) return;
    const toolName = String(input.tool_name || '');
    if (!isShellTool(toolName)) return;
    const toolInput = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
    if (!commandWritesFiles(shellCommandText(toolInput))) return;
    const promptIndex = currentTurnIndex(state);
    if (promptIndex == null || promptIndex < 0) return;

    const deps = probeDepsFor();
    const probes: NonNullable<SessionState['shellProbes']> = [];
    // Keep the command text alongside the fingerprint. What changes between
    // here and post-tool-use is what the command did — but on a shared
    // checkout a sibling can write inside that same window, and turn 0 of
    // session 6e9947a5 is exactly that: the probe attributed a sibling's
    // reconstructed-commits.ts to us. The command's own text is the
    // discriminator no concurrent writer can forge.
    const cmdText = shellCommandText(toolInput).slice(0, SHELL_COMMAND_MAX);
    // The tool call this probe belongs to, so post-tool-use can resolve its OWN
    // window. Same id the subagent ring already keys on for the same reason
    // ("R1": parallel tool calls with one toolName raced through a find-by-name).
    const toolCallId: string | undefined = input.tool_call_id || input.tool_use_id || undefined;
    for (const tree of treesToProbe(state, promptIndex)) {
      const p = probeTree(tree, deps);
      probes.push({
        toolCallId, promptIndex, tree, stamps: p.stamps, skipped: p.skipped,
        baselineSha: baselineShaForTree(state, tree, promptIndex) || undefined,
        command: cmdText || undefined,
      });
    }
    // APPEND, never replace. Agents issue tool calls in parallel, and this used
    // to assign `state.shellProbes = probes`, so with two concurrent Bash calls:
    // begin(A) armed A, begin(B) DISCARDED A and armed B, end(A) then resolved
    // B's snapshot against the tree at A's finish and cleared the list, and
    // end(B) found nothing. A's window vanished; B's counted whatever A wrote
    // after B was armed. This is the mechanism that most plausibly left the
    // undrained probe behind #1322 — that fix stops such a probe crossing a
    // turn boundary, this one stops it being orphaned in the first place.
    //
    // Probes from an earlier turn are dropped here rather than carried: their
    // window closed at the turn boundary and endShellProbe would refuse them
    // anyway (#1322). Pruning at arm time is what keeps the list from growing
    // once a turn's probe is never drained.
    const pending = (state.shellProbes || []).filter((p) => p.promptIndex === promptIndex);
    const merged = [...pending, ...probes];
    // Bounded: a run of undrained probes must not grow the state file without
    // limit. Oldest go first — the newest window is the one most likely to
    // still be resolvable.
    state.shellProbes = merged.length > SHELL_PROBE_MAX_PENDING
      ? merged.slice(merged.length - SHELL_PROBE_MAX_PENDING)
      : merged;
  } catch (err: unknown) {
    debugLog('pre-tool-use', 'shell probe failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Command text is kept only to answer "did this command name this file?", so
// a couple of KB is plenty and keeps the state file small.
export const SHELL_COMMAND_MAX = 4096;

// Undrained probes a turn may hold at once. Parallel tool calls arm several
// legitimately; beyond this the oldest are dropped, so a run of missing
// post-tool-use hooks cannot grow the session state without bound.
export const SHELL_PROBE_MAX_PENDING = 8;

/**
 * Resolve the probe after the command ran, recording what it PROVABLY wrote.
 *
 * Content is baseline→now for each touched file, upserted per file so a file
 * written by several commands in one turn stays a single edit spanning the
 * turn rather than a pile of fragments.
 */
export function endShellProbe(state: SessionState, input: Record<string, any>): boolean {
  const all = state.shellProbes || [];
  if (all.length === 0) return false;
  // Resolve THIS tool call's probes, not everyone's. Draining the whole list on
  // every post-tool-use is what let a read-only command close a window it never
  // opened — including across a turn boundary (#1322). With ids, only the call
  // that armed a probe can resolve it.
  //
  // The fallback matters: an agent that sends no id on either hook (older
  // Gemini / Aider builds, per the subagent ring's note) would otherwise never
  // drain anything and leak probes for the whole turn. When the incoming end
  // carries no id, or nothing pending carries one, keep the old drain-all
  // behaviour — no worse than before, and still fenced by the turn check below.
  const endId: string | undefined = input.tool_call_id || input.tool_use_id || undefined;
  // Gate on whether ids are in play AT ALL, not on whether this one matched. A
  // non-matching id is the case that matters most — an unrelated tool call
  // whose window is somebody else's — and treating it as "unmatched, so drain
  // everything" would reinstate the exact behaviour this removes.
  const keyed = all.some((p) => p.toolCallId);
  const byId = Boolean(endId) && keyed;
  const probes = byId ? all.filter((p) => p.toolCallId === endId) : all;
  const keep = byId ? all.filter((p) => p.toolCallId !== endId) : [];
  // Anything held over is pruned to the open turn, so an unresolved probe
  // cannot survive into the next one even if its end never arrives.
  const openNow = currentTurnIndex(state);
  state.shellProbes = openNow == null ? [] : keep.filter((p) => p.promptIndex === openNow);
  let changed = false;
  try {
    if (!liveCaptureEnabled()) return false;
    // The turn that is running NOW, not the one `probes[0]` happens to name.
    const openIndex = currentTurnIndex(state);
    const deps = probeDepsFor();
    for (const before of probes) {
      if (before.skipped) continue;
      // A probe belongs to the turn that OPENED it, and its window is only
      // evidence while that turn is still the open one.
      //
      // `beginShellProbe` only arms a probe for a command that can write, but
      // `endShellProbe` runs on EVERY post-tool-use. So a probe armed by the
      // last write-capable command of one turn, whose own post-tool-use never
      // drained it, sits in the state until some read-only command in a LATER
      // turn resolves it — against a tree that has since moved. Every file the
      // next turn wrote then reads as "changed inside that command's window".
      //
      // Prod session 7f3776c8 turn 0 was pure investigation — the CLI reported
      // `f:0, d:0` on every Stop — yet its row carried an 88KB editsJson
      // holding one `command_probe` whole-file write of
      // packages/cli/src/commands/sessions.ts, 42,605 → 43,793 bytes: turn 1's
      // edit, filed under turn 0. The page rendered it as +0/-2, because the
      // read path synthesizes from that editsJson and then correctly hands the
      // ADDED lines to turn 1, leaving turn 1's two deletions behind on a turn
      // that authored nothing.
      //
      // Dropped rather than re-filed under the open turn: the `before` snapshot
      // was taken before a turn boundary, so the delta spans two turns and is
      // evidence for neither. The open turn's own capture (edit hooks, shadow
      // diff) already covers what it really wrote.
      if (openIndex == null || before.promptIndex !== openIndex) {
        debugLog('post-tool-use', 'shell probe dropped — armed by an earlier turn', {
          probeIndex: before.promptIndex, openIndex, tree: before.tree,
        });
        continue;
      }
      const after: TreeProbe = probeTree(before.tree, deps);
      const touched = touchedSince(
        { tree: before.tree, stamps: before.stamps, skipped: before.skipped }, after,
      );
      if (touched.length === 0) continue;
      // Each probe's OWN index — pairing it with `probes[0]`'s was the same
      // mismatch by another route, since the baseline below is already
      // per-probe.
      if (recordProbedShellEdits(
        state, before.tree, before.baselineSha, before.promptIndex, touched,
        { command: before.command },
      )) changed = true;
    }
  } catch (err: unknown) {
    debugLog('post-tool-use', 'shell probe resolve failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return changed;
}

// Worktrees this turn revealed through a shell command's text, each baselined
// at the moment we first saw it. Bounded to a handful per turn: every entry
// costs a shadow commit, and an agent that really works in more than a few
// worktrees in one turn is not a case worth paying for on every Bash call.
export const MAX_DISCOVERED_WORKTREES = 4;

export function discoverWorkTreesFromCommand(state: SessionState, input: Record<string, any>): void {
  try {
    const toolInput = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
    const command = String((toolInput as any).command || (toolInput as any).cmd || '');
    if (!command || !state.repoPath) return;
    const promptIndex = state.prompts?.length ? state.prompts.length - 1 : 0;
    const already = (state.discoveredWorkTrees || []).filter((w) => w.promptIndex === promptIndex);
    if (already.length >= MAX_DISCOVERED_WORKTREES) return;

    const found = worktreesAmongCandidates(
      state.repoPath, candidateDirsFromCommand(command),
      { gitRoot: getWorkingGitRoot, gitCommonDir: getGitCommonDir },
    );
    if (found.length === 0) return;

    const kept = state.discoveredWorkTrees || [];
    for (const wt of found) {
      if (kept.some((w) => w.promptIndex === promptIndex && samePath(w.path, wt))) continue;
      if (kept.filter((w) => w.promptIndex === promptIndex).length >= MAX_DISCOVERED_WORKTREES) break;
      // createShadowCommit returns null on a CLEAN tree — pair with HEAD, as
      // every other baseline site does, or the window has nothing to diff.
      const sha = createShadowCommit(wt, `discovered-${(state.sessionTag || state.sessionId).slice(0, 12)}`) || getHeadSha(wt);
      if (!sha) continue;
      kept.push({ path: wt, sha, promptIndex });
      debugLog('pre-tool-use', 'worktree discovered from command', { workTree: wt, sha: sha.slice(0, 12), promptIndex });
    }
    state.discoveredWorkTrees = kept;
  } catch (err: unknown) {
    debugLog('pre-tool-use', 'worktree discovery failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
