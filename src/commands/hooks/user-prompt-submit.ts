// UserPromptSubmit: open the turn, baseline it, start the write journal.
//
// Moved out of commands/hooks.ts mechanically: the text is unchanged, only its
// home is. Shared helpers still live in hooks.ts and are imported from there.
import { discoverCodexSessionData, isKnownCodexInternalPrompt } from '../../agents/codex.js';
import { findCursorTranscriptJsonl } from '../../agents/cursor.js';
import { discoverGeminiTranscriptPath, readGeminiModel } from '../../agents/gemini.js';
import { isSpecificModel, sessionMatchesAgent } from '../../agents/registry.js';
import { api, readAuthStatus } from '../../api.js';
import { buildAttributionContext } from '../../attribution.js';
import { BUDGET_BLOCKING_AGENTS, buildBudgetWarningBanner } from '../../budget-breach.js';
import { contentionAdvice, detectContention } from '../../checkout-contention.js';
import { ensureConfigDir, isConnectedMode, loadAgentConfig, loadConfig, loadRepoConfig, saveAgentConfig } from '../../config.js';
import { assembleRepoContext } from '../../context-injection.js';
import { debugLog } from '../../debug-log.js';
import { retagDevinFromProcess } from '../../devin-cli.js';
import { capDiff } from '../../diff-budget.js';
import { MAX_PROMPT_DIFF_LEN, captureGitState, createShadowCommit, getDirtyFiles } from '../../git-capture.js';
import { combineApplyableTurnDiff } from '../../applyable-turn-diff.js';
import { syncNotesForSessionStart } from '../../git-notes.js';
import { buildHandoffContext } from '../../handoff.js';
import { listRecentShas } from '../../history-backfill.js';
import { matchIgnoredRepo } from '../../ignore-repos.js';
import { buildMemoryBriefContext, buildMemoryContext, buildMemoryEscalationContext, buildMemoryPointerContext, buildPromptScopedMemoryContext, buildStartupCheckContext } from '../../memory.js';
import { samePath as samePathNormalized } from '../../paths.js';
import { redactSecrets } from '../../redaction.js';
import { buildRepoBriefContext } from '../../repo-brief.js';
import { carryForwardTurnState, findDuplicateStateForSession } from '../../session-dedup.js';
import { isEmptyWorktreeBootstrap, restampWorktreeBootstrap } from '../../worktree-bootstrap.js';
import { buildDurationBlockMessage, parseSessionLimits } from '../../session-limits.js';
import { clearSessionState, closeTurn, discoverGitRoot, findPriorStateForConversation, getBranch, getCanonicalRepoPath, getGitCommonDir, getGitRoot, getHeadSha, getStatePath, getWorkingGitRoot, isHeartbeatAlive, isPendingReservation, isProvisionalSessionId, listActiveSessions, loadSessionState, markSkippedPromptBaselines, promptHistoryFromPriorState, recordPromptShadow, resolveSessionBranch, samePromptText, saveSessionState, sessionTagFor, stampCaptured, startHeartbeat } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import { openTurnLiveness } from '../../turn-liveness.js';
import { samePath, sessionWorkTree } from '../../session-worktree.js';
import { detectTools } from '../../tools-detector.js';
import { estimateCost, extractPromptFileMappings, formatTranscriptForDisplay, isKnownCursorInternalPrompt, parseTranscript, promptTextForEntry, readCopilotModel } from '../../transcript.js';
import type { ParsedTranscript, PromptFileMapping } from '../../transcript.js';
import { persistUpdateBeforeWork } from '../../update-queue.js';
import { markTurn } from '../../write-journal-watch.js';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { turnIdForServerRow } from '../../turn-index.js';
import { STABLE_SESSION_ID_AGENTS, captureStamp, currentSessionWorkTree, dropForeignCommitsFromCapture, durableUpdate, ensureServerSession, ensureWriteJournal, filterUncommittedDiff, findStateForHook, getWorkingTreeSha, hookLookupSessionId, journalHasMark, normalizeWorkspaceRoot, resolveAutoAgentSessionId, resumeEndedConversationState, serverRowForLocalTurn, sessionRepoRoots, sessionScopedCommittedDiff, summarizePromptPayload, turnIdFor, uncommittedExcludeUnion } from '../hooks.js';


export function retroactiveTurnFiles(
  sessionCommitted: string,
  rawRangeDiff: string,
  foreignFiles: string[] | null | undefined,
): string[] {
  const out = new Set<string>();
  const foreign = foreignFiles || [];
  const isForeign = (f: string) => foreign.some(
    (own) => own === f || own.endsWith(`/${f}`) || f.endsWith(`/${own}`),
  );
  for (const m of (sessionCommitted || '').matchAll(/^diff --git a\/(.*?) b\//gm)) {
    if (m[1]) out.add(m[1]);
  }
  for (const m of (rawRangeDiff || '').matchAll(/^diff --git a\/(.*?) b\//gm)) {
    if (m[1] && !isForeign(m[1])) out.add(m[1]);
  }
  return [...out];
}

/**
 * A UserPromptSubmit hook runs after arbitrary shell activity, including a
 * checkout. `HEAD` alone therefore says nothing about the turn we are
 * closing: using it as a commit stamp made a branch's pre-existing tip appear
 * as if the active prompt had authored it.
 *
 * A post-commit attestation is the one observation that binds a SHA to a
 * stable turn id. Keep the convenient retroactive commit badge when that
 * exact SHA is attested to this row; otherwise leave ownership to the
 * post-commit/Stop paths instead of guessing from the checkout's HEAD.
 */
export function attestedHeadForPrompt(
  state: Pick<SessionState, 'commitTurns' | 'promptTurnIds' | 'promptIndexBase'>,
  promptIndex: number,
  headSha: string | null | undefined,
): string | null {
  const sha = headSha?.trim();
  const turnId = turnIdForServerRow(state, promptIndex);
  if (!sha || !turnId) return null;
  return state.commitTurns?.some((commit) =>
    commit.sha.toLowerCase() === sha.toLowerCase() && commit.turnId === turnId,
  ) ? sha : null;
}

// ─── Per-agent context injection ──────────────────────────────────────────
//
// Build the stdout payload that delivers Origin's session context (policies,
// repo attribution, handoff/memory, and the authoring framework) to an
// agent. The channel differs per agent because each one's hook protocol
// surfaces hook output differently — getting this wrong means the model
// silently never sees the context:
//
//   • claude-code — a top-level `systemMessage` is shown to the HUMAN only;
//     the MODEL receives context exclusively via
//     hookSpecificOutput.additionalContext. We emit BOTH so the user sees
//     the banner (parity with Gemini) AND the model actually gets the
//     framework/policies. (This was the bug: Claude only ever got
//     `systemMessage`, so the model never received any of it.)
//   • cursor — reads `additional_context`.
//   • gemini / windsurf / others — read `systemMessage`.
//   • codex — renders hook stdout as warnings, so a full block spams the
//     warning area; it reads everything from AGENTS.md instead. Returns
//     null (callers keep their codex-only budget-banner branch).
//
// Returns the JSON string to write to stdout, or null when nothing should be
// written (codex, or empty context).
export function buildContextInjectionPayload(
  agentSlug: string | undefined,
  hookEventName: 'SessionStart' | 'UserPromptSubmit',
  systemMsg: string,
): string | null {
  if (!systemMsg) return null;
  if (agentSlug === 'codex') return null;
  if (agentSlug === 'claude-code') {
    return JSON.stringify({
      systemMessage: systemMsg,
      hookSpecificOutput: { hookEventName, additionalContext: systemMsg },
    });
  }
  if (agentSlug === 'cursor') {
    return JSON.stringify({ additional_context: systemMsg });
  }
  return JSON.stringify({ systemMessage: systemMsg });
}

// ─── Full-context injection dedupe ───────────────────────────────────────────
//
// The consolidated repo-context block (brief + AI% + memory digest + handoff)
// has TWO writers: handleSessionStart, and handleUserPromptSubmit for the turn
// that had to auto-create the session because no sessionStart ever fired
// (Cursor's common case — it fires sessionStart about once per app launch).
//
// Both firing for the SAME conversation delivers the identical ~450-word digest
// twice in one turn, which is what it does today whenever sessionStart ran but
// its state wasn't found by the time the first prompt arrived.
//
// Dedupe on the CONVERSATION, not on elapsed time. A time window would have to
// choose between re-injecting into the same conversation (waste) and staying
// silent on a second chat opened moments later (the exact blindness the
// auto-create path exists to fix). The conversation anchor — Cursor's
// conversation_id, else the hook session_id — separates those two cases
// exactly: same anchor means the block is already in this context window and
// will stay there; a different anchor is a fresh context that needs its own copy.
export function contextInjectionStampPath(repoPath: string): string {
  const key = crypto.createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.origin', 'context-injection', `${key}.json`);
}

/** Record that the full repo-context block reached `conversationKey`'s context. */
export function recordFullContextInjection(repoPath: string, conversationKey: string | undefined): void {
  if (!repoPath || !conversationKey) return;
  try {
    const stamp = contextInjectionStampPath(repoPath);
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, JSON.stringify({ conversationKey, at: new Date().toISOString() }));
  } catch {
    // Best-effort: a missing stamp costs a duplicate injection, never a miss.
  }
}

/** True when this conversation already received the full block. */
export function fullContextAlreadyInjected(repoPath: string, conversationKey: string | undefined): boolean {
  if (!repoPath || !conversationKey) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(contextInjectionStampPath(repoPath), 'utf-8'));
    return raw?.conversationKey === conversationKey;
  } catch {
    return false;
  }
}

/**
 * Cursor's per-chat identity for detach / reuse.
 *
 * `conversation_id` is the stable chat (agent-transcripts/<id>/). `session_id`
 * rotates every turn, so treating it as the chat id is what made a second
 * prompt look like a NEW conversation and mint a twin Origin session (prod:
 * locked 6f636f7d, incoming c49a1512, auto-created 562314d8 beside the
 * session-start row). Only a PRESENT conversation_id can prove a mismatch.
 */
export function cursorIncomingChatId(input: Record<string, unknown>): string {
  return (typeof input.conversation_id === 'string' && input.conversation_id.trim()) || '';
}

/**
 * The id that identifies this CONVERSATION on stdin.
 *
 * Cursor's `conversation_id` is the stable per-chat anchor and its `session_id`
 * can rotate per turn, so Cursor leads with the conversation; every other agent
 * leads with `session_id`. Extracted because session-start and the prompt
 * hook's auto-create both need the SAME answer — deriving it twice, slightly
 * differently, is what let one chat become two sessions.
 */
export function conversationAnchorId(
  agentSlug: string | undefined,
  conversationId: unknown,
  sessionId: unknown,
): string {
  const conv = (typeof conversationId === 'string' && conversationId) || '';
  const sess = (typeof sessionId === 'string' && sessionId) || '';
  return agentSlug === 'cursor' ? (conv || sess) : (sess || conv);
}

/**
 * Recover the conversation that existed before a missing SessionStart hook.
 *
 * A late UserPromptSubmit is still able to read Claude's complete JSONL.  The
 * old fallback created a state with only the newly-submitted prompt, which
 * made every older commit look like work for that one live turn and told the
 * server it had joined mid-stream.  Transcript edits are real evidence, so
 * retain them; git baselines for the older turns are gone, so mark those turns
 * explicitly unanchored rather than reconstructing a cumulative diff.
 */
export function recoverLateAttachTranscript(
  transcriptPath: unknown,
  incomingPrompt: string,
  repoRoots: string[],
): { prompts: string[]; mappings: PromptFileMapping[]; startedAt?: string } {
  if (typeof transcriptPath !== 'string' || !transcriptPath || !fs.existsSync(transcriptPath)) {
    return { prompts: [], mappings: [] };
  }
  try {
    const mappings = extractPromptFileMappings(transcriptPath, { repoRoots });
    const prompts = mappings.map((m) => m.promptText);
    // Claude normally invokes UserPromptSubmit before it appends the new user
    // entry. If a build wrote it first, leave it for the ordinary hook path so
    // it still gets this turn's journal mark and start shadow.
    if (prompts.length > 0 && samePromptText(prompts[prompts.length - 1], incomingPrompt)) {
      prompts.pop();
      mappings.pop();
    }
    let startedAt: string | undefined;
    for (const line of fs.readFileSync(transcriptPath, 'utf-8').split('\n')) {
      try {
        const timestamp = JSON.parse(line)?.timestamp;
        if (typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))) {
          startedAt = new Date(timestamp).toISOString();
          break;
        }
      } catch { /* malformed transcript entries are already ignored by the parser */ }
    }
    return { prompts, mappings, startedAt };
  } catch {
    return { prompts: [], mappings: [] };
  }
}

// How many recent HEAD SHAs a session-creating call advertises so the
// server's basename-fallback repo gate can corroborate by SHA overlap (the
// only rung available to a local-only repo whose checkout moved paths). Far
// smaller than the ingest advertisement (RECENT_SHAS_LIMIT = 500): one shared
// SHA already proves shared history, and this runs on every session start.
export const SESSION_START_RECENT_SHAS = 20;

/**
 * Whether a candidate active session may be REUSED for an incoming Cursor
 * session-start. Cursor's conversation_id (stored as agentSessionId) is the
 * stable per-chat anchor; a NEW chat must start a fresh Origin session rather
 * than gluing its prompts onto a prior chat's still-open session (which also
 * mis-dated the new prompt under the old session's start time). Mirrors the
 * detach handleUserPromptSubmit performs on a changed conversation_id.
 *
 * Only blocks reuse on a PROVEN mismatch — both ids known and different. A
 * candidate with no recorded id is adopted (same best-effort as
 * user-prompt-submit). Non-Cursor agents (e.g. Codex, whose stdin id rotates
 * per turn) always reuse by agent, so this returns true for them.
 */
export function cursorSessionReusable(
  agentSlug: string | undefined,
  incomingChatId: string | undefined | null,
  candidateChatId: string | undefined | null,
): boolean {
  // Both Cursor's conversation_id and Codex's rollout thread_id are stored as
  // agentSessionId and are the stable per-chat anchor. A NEW chat/thread must
  // NOT reuse a prior chat's still-open session — otherwise a fresh Codex
  // conversation glues its prompts onto the previous conversation's RUNNING
  // session (and ending that session on the web doesn't help, since the local
  // state file is still RUNNING and gets reused). Only block reuse on a PROVEN
  // mismatch — both ids known and different; an unknown id is adopted.
  // NOTE: this requires the incoming Codex thread_id to be resolved BEFORE the
  // reuse check (see resolveCodexThreadId, called in handleSessionStart) — the
  // stdin session_id rotates per turn and is useless as an anchor.
  if ((agentSlug !== 'cursor' && agentSlug !== 'codex') || !incomingChatId || !candidateChatId) return true;
  return candidateChatId === incomingChatId;
}

/**
 * Pick the best archived session to RECOVER for an incoming user-prompt-submit
 * whose live `.git` state file is gone (deleted by a stale sweep). Recovery is
 * Cursor-only (it reuses sessions per chat); other agents create a session per
 * conversation, so recovering an old one there shows stale diffs.
 *
 * CRITICAL: never recover a session belonging to a DIFFERENT Cursor chat. The
 * user-prompt-submit detach sets `state = null` when the incoming conversation_id
 * disagrees with the locked one, precisely to force a fresh session for the new
 * chat. Without the `cursorSessionReusable` guard here, recovery immediately
 * re-selects that SAME old chat's archived session (it matches repo + recency),
 * undoing the detach and gluing the new chat's prompt onto the prior session —
 * the prod symptom on conversation 047e67ca vs 21a72a0e (session 67d97041): the
 * new chat spawned no session and its prompt landed on the old one.
 *
 * Pure over its inputs (caller reads/parses the archive JSON); exported for test.
 */
export function selectRecoverableArchiveSession(
  states: Array<any>,
  opts: {
    repoPath: string;
    canonicalRepoPath: string;
    agentSlug: string | undefined;
    incomingChatId: string;
    nowMs: number;
    maxAgeMs: number;
  },
): any | null {
  let best: any | null = null;
  let bestAge = Infinity;
  for (const s of states) {
    if (!s?.sessionId || !s?.startedAt) continue;
    const age = opts.nowMs - new Date(s.startedAt).getTime();
    // An archive that names THIS chat is the conversation the prompt came from
    // — the agent handing us its own id, not a guess from repo + recency. That
    // is the one case an ENDED row is resumable: the heartbeat retires a
    // Cursor session after 20 idle minutes (and, before the open-turn veto,
    // in the middle of a long generation), the user keeps typing in the same
    // chat, and the next prompt used to land here, find nothing, and mint a
    // twin. Prod 2026-09-08: conversation 7b2b1608 became 49b1c722 (ended
    // 23:04) and then c1e361a4 (auto-created 23:13), the second replaying the
    // first's prompts. The server already reopens the row on a genuinely new
    // prompt turn; resuming the LOCAL state is what keeps the numbering and
    // the ledger continuous instead of restarting at prompt 0.
    //
    // Same rule as the server's identity ladder: age caps and the ENDED skip
    // exist for rows the client cannot NAME. Positive identity relaxes both.
    const sameChat = !!opts.incomingChatId && !!s.agentSessionId && s.agentSessionId === opts.incomingChatId;
    if (!(age >= 0) || (age > opts.maxAgeMs && !sameChat)) continue;
    if (s.status === 'ENDED' && s.endedAt && !sameChat) continue;
    // ...but never a row the user archived or deleted on the web. The
    // heartbeat marks those when it drops them (dropLocalSessionAndExit).
    if (s.serverTerminal === true) continue;
    if (s.repoPath !== opts.repoPath && s.repoPath !== opts.canonicalRepoPath) continue;
    if (opts.agentSlug && !sessionMatchesAgent(s, opts.agentSlug)) continue;
    // Don't recover a different Cursor chat's session (see note above).
    if (!cursorSessionReusable(opts.agentSlug, opts.incomingChatId, s.agentSessionId)) continue;
    if (age < bestAge) { best = s; bestAge = age; }
  }
  return best;
}

// Does `candidate` belong to the chat this prompt actually came from?
//
// findStateForHook is workspace-scoped, so in a workspace that has hosted more
// than one chat it can hand back a sibling chat's state. The detach guards in
// handleUserPromptSubmit already reject that on the FIRST lookup; this is the
// same rule with the mutation lifted out, so the post-notes-sync re-lookup can
// apply it too. Without it that second lookup re-adopted the very state the
// first one had just detached from — the prompt, and the whole turn's diff,
// landed on the previous chat's session.
//
// Only agents whose stdin carries a stable per-chat id are checked. Codex is
// deliberately absent: its stdin rotates per turn, so any equality test here
// would detach every prompt from its own session.
export function stateMatchesIncomingChat(
  candidate: SessionState,
  agentSlug: string | undefined,
  input: Record<string, any>,
): boolean {
  if (agentSlug === 'cursor') {
    const incomingChatId = cursorIncomingChatId(input);
    // No id to compare, or a state that hasn't locked one yet, is not evidence
    // of a mismatch — the first guard adopts in both cases, so must this.
    // A rotating session_id with no conversation_id is also not a mismatch:
    // that used to detach the second prompt of the SAME chat.
    if (!incomingChatId || !candidate.agentSessionId) return true;
    return candidate.agentSessionId === incomingChatId;
  }
  if (agentSlug === 'gemini') {
    const incomingTranscriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
    if (!incomingTranscriptPath || !candidate.transcriptPath) return true;
    // samePath, not `===`: the same transcript reaches us spelled two ways
    // (Windows C:/… vs C:\…, macOS /var vs /private/var), and a raw compare
    // would read one chat as two and detach Gemini from its own session.
    return samePathNormalized(candidate.transcriptPath, incomingTranscriptPath);
  }
  return true;
}

// ─── Budget Lockout (layer-1 hard-cap enforcement) ─────────────────────────
//
// When the org breaches a hard (block:true) budget cap, the server reports
// it on session PATCH responses and heartbeat pings; the flag is persisted
// in session state. These helpers turn it into hook decisions: user-prompt-
// submit blocks new prompts and pre-tool-use blocks tool calls via exit 2
// (honored by Claude Code and Gemini CLI). Cursor/Codex hook protocols
// don't honor blocking exits, so they get a stderr warning — their commits
// are still gated by the policy pre-commit hook, and new sessions are
// refused server-side. Client-side enforcement is a guardrail, not a
// security boundary; ORIGIN_BUDGET_OVERRIDE=1 bypasses for emergencies.

// BUDGET_BLOCKING_AGENTS (agents whose hook protocol honors exit-2
// blocking) now lives in budget-breach.ts — shared with the heartbeat,
// which keeps non-blockable agents' sessions ALIVE on a breach so their
// continued burn stays tracked.

/** Pure decision: block, warn, or pass. Exported for tests. */
export function budgetLockoutDecision(opts: {
  budgetBlocked?: boolean;
  budgetBlockReason?: string;
  agentSlug?: string;
  overrideEnv?: string;
}): { block: boolean; warn: boolean; reason: string } {
  if (!opts.budgetBlocked) return { block: false, warn: false, reason: '' };
  const reason =
    `[Origin Budget] ${opts.budgetBlockReason || 'Hard budget cap exceeded'} — ` +
    `new AI work is blocked until the cap resets or an admin raises it. ` +
    `Emergency override: export ORIGIN_BUDGET_OVERRIDE=1`;
  if (opts.overrideEnv === '1') return { block: false, warn: true, reason };
  const slug = (opts.agentSlug || 'claude-code').toLowerCase();
  const canBlock = BUDGET_BLOCKING_AGENTS.has(slug);
  return { block: canBlock, warn: !canBlock, reason };
}

/**
 * Hook-time gate. Re-checks the server while locked out (so the block
 * lifts the moment the period resets or an admin raises the cap — only
 * runs in the blocked state, so no steady-state API load), then blocks
 * or warns per the agent's capabilities. On re-check failure we keep
 * blocking: the last confirmed server state was "blocked", and the
 * override env is the documented escape hatch.
 */
export async function enforceBudgetLockout(
  state: SessionState,
  agentSlug: string | undefined,
  saveCwd: string,
  hookName: string,
): Promise<void> {
  if (!state.budgetBlocked) return;
  if (isConnectedMode()) {
    try {
      const status = await api.getBudgetStatus(
        state.sessionId && !state.sessionId.startsWith('local-') ? state.sessionId : undefined,
      );
      if (!status.blocked) {
        state.budgetBlocked = false;
        state.budgetBlockReason = undefined;
        state.budgetBlockReported = undefined;
        try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
        debugLog(hookName, 'budget lockout lifted by server re-check');
        return;
      }
      if (status.message) state.budgetBlockReason = status.message;
    } catch { /* keep blocking on re-check failure */ }
  }
  const decision = budgetLockoutDecision({
    budgetBlocked: state.budgetBlocked,
    budgetBlockReason: state.budgetBlockReason,
    agentSlug: agentSlug || state.agentSlug,
    overrideEnv: process.env.ORIGIN_BUDGET_OVERRIDE,
  });
  // Audit the lockout — once per episode, not per blocked call (a single
  // breach can block dozens of tool calls in one turn; one audit row +
  // admin notification carries the signal without the spam). The flag
  // clears with the lockout, so the next episode reports again.
  if ((decision.block || decision.warn) && !state.budgetBlockReported && isConnectedMode()) {
    try {
      const agentCfg = loadConfig();
      await api.reportViolation({
        machineId: agentCfg?.machineId || 'unknown',
        policyType: 'BUDGET_CAP',
        policyName: 'Hard budget cap',
        description: `[${hookName}] ${state.budgetBlockReason || 'Hard budget cap exceeded'} — ${decision.block ? 'blocked' : 'warned (agent cannot block)'}`,
        sessionId: state.sessionId && !state.sessionId.startsWith('local-') ? state.sessionId : undefined,
      });
      state.budgetBlockReported = true;
      try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
    } catch { /* never block the block on reporting */ }
  }
  if (decision.block) {
    debugLog(hookName, 'BLOCKED by budget lockout', { reason: decision.reason });
    process.stderr.write(decision.reason + '\n');
    process.exit(2);
  }
  if (decision.warn) {
    debugLog(hookName, 'budget lockout warning (agent cannot block)', { reason: decision.reason });
    process.stderr.write(decision.reason + '\n');
  }
}

// ─── SESSION_LIMITS max-duration gate ───────────────────────────────────────
//
// Counterpart to the heartbeat's timer-side checks (see session-limits.ts
// for the full policy contract). Called from user-prompt-submit only:
// blocking at prompt boundaries forces the restart without ever cutting an
// in-flight turn. Same agent-capability gating as the budget lockout —
// exit 2 is honored by Claude Code and Gemini; other agents get a stderr
// warning and rely on the heartbeat notifications.
export function enforceSessionDurationLimit(
  state: SessionState,
  agentSlug: string | undefined,
  hookName: string,
): void {
  const cfg = parseSessionLimits(state.enforcementRules);
  if (!cfg?.enforce || cfg.maxDurationMinutes === undefined || !state.startedAt) return;
  const ageMinutes = (Date.now() - new Date(state.startedAt).getTime()) / 60_000;
  if (!isFinite(ageMinutes) || ageMinutes < cfg.maxDurationMinutes) return;

  const message = buildDurationBlockMessage(cfg.maxDurationMinutes, ageMinutes);
  const slug = (agentSlug || state.agentSlug || 'claude-code').toLowerCase();
  if (BUDGET_BLOCKING_AGENTS.has(slug)) {
    debugLog(hookName, 'BLOCKED by SESSION_LIMITS max duration', {
      ageMinutes: Math.round(ageMinutes),
      maxDurationMinutes: cfg.maxDurationMinutes,
      sessionId: state.sessionId,
    });
    process.stderr.write(message + '\n');
    process.exit(2);
  }
  debugLog(hookName, 'SESSION_LIMITS max duration exceeded (agent cannot block)', {
    ageMinutes: Math.round(ageMinutes),
    maxDurationMinutes: cfg.maxDurationMinutes,
  });
  process.stderr.write(message + '\n');
}

export async function handleUserPromptSubmit(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('user-prompt-submit', 'begin', { hasPrompt: !!input.prompt, cwd: input.cwd, workspace_roots: input.workspace_roots });

  let hookCwd = normalizeWorkspaceRoot(input.cwd) || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = normalizeWorkspaceRoot(input.workspace_roots[0]);
    // Resolve ONCE — the debug line used to call getGitRoot and then the `if`
    // called it again, i.e. two `git rev-parse` spawns on a blocking path just
    // to log the first one's answer.
    const wsGitRoot = wsRoot ? getGitRoot(wsRoot) : null;
    debugLog('user-prompt-submit', 'workspace_roots check', { wsRoot, gitRoot: wsGitRoot });
    if (wsRoot && wsGitRoot) {
      hookCwd = wsRoot;
    }
  }
  debugLog('user-prompt-submit', 'cwd resolved', { hookCwd });

  // Set when this invocation just created the session-start shadow. The
  // next-prompt baseline block near the end of this function would otherwise
  // create a SECOND shadow moments later over an identical tree (nothing between
  // them touches files — only API calls and the heartbeat spawn), burning four
  // more git spawns for a different sha wrapping the same tree. ~1s of the
  // 11.4s hook, every time a session auto-creates.
  let freshSessionStartShadow: string | null = null;

  // Codex internal meta-call prompts (ambient-suggestion safety filter, title
  // generation, output summarizer) fire real user-prompt-submit hooks. Their
  // threads never land in Codex's SQLite, so the discovery-time filter
  // (isCodexInternalSubroutine in discoverCodexSessionData) never sees them —
  // the prompt would be recorded straight from stdin. Two failure modes this
  // blocks: (a) cwd="/" runs auto-create a repo-less junk session for the
  // meta-prompt (the session-start root guard skips registration, but this
  // hook would re-create it), and (b) a meta-call fired with a REPO cwd would
  // reuse the repo's live Codex session and splice the meta-prompt into a
  // real conversation. Anchored-match only (isKnownCodexInternalPrompt) — a
  // prompt merely MENTIONING the meta-prompt text is kept, and the mini-model
  // heuristic is deliberately NOT applied to live prompts.
  if (agentSlug === 'codex' && isKnownCodexInternalPrompt(input.prompt)) {
    debugLog('user-prompt-submit', 'skip: codex internal subroutine prompt', {
      model: input.model, promptPreview: String(input.prompt || '').slice(0, 80),
    });
    return;
  }

  // Cursor injects Task-tool / subagent-completion follow-ups as a user_query.
  // They fire this hook and land in agent-transcripts, so without this they
  // splice into the real conversation (session 562314d8). Anchored-match only
  // — a prompt that merely mentions the instruction is kept.
  if (agentSlug === 'cursor' && isKnownCursorInternalPrompt(input.prompt)) {
    debugLog('user-prompt-submit', 'skip: cursor harness follow-up prompt', {
      promptPreview: String(input.prompt || '').slice(0, 80),
    });
    return;
  }

  // ── Find session state using concurrent-aware lookup ────────────────────────
  // For agents with unstable session_id (Cursor, Codex), don't use it for lookup
  const stableAgents = STABLE_SESSION_ID_AGENTS;
  const lookupSessionId = hookLookupSessionId(input.session_id, agentSlug, input.conversation_id);
  // Reassigned when a concurrent session-start publishes its reservation while
  // this hook is doing its slow pre-mint work — see the re-check before
  // auto-create below, which needs `saveCwd` to follow the adopted session.
  let found = findStateForHook(hookCwd, lookupSessionId, agentSlug);
  let state = found?.state || null;
  // True when THIS turn had to mint the session because no sessionStart hook
  // ever fired. Such a turn IS the session's start, so the context injection at
  // the end of this handler owes it the full repo context, not just attribution.
  let sessionJustAutoCreated = false;

  if (state) {
    // Update Claude session ID and transcript path if they changed
    // (agent subprocesses may have different session_id)
    const incomingSessionId = input.session_id || '';
    if (incomingSessionId && stableAgents.includes(agentSlug || '') && state.claudeSessionId !== incomingSessionId) {
      debugLog('user-prompt-submit', 'updating claudeSessionId', {
        old: state.claudeSessionId,
        new: incomingSessionId,
        originSession: state.sessionId,
        tag: state.sessionTag,
      });
      state.claudeSessionId = incomingSessionId;
    }
    // Cursor specifically: `conversation_id` is the stable per-chat id
    // (matches `agent-transcripts/<id>/` and persists across the
    // chat's prompts). `session_id` rotates per turn. When the user
    // opens a NEW chat in the same workspace, the workspace-scoped
    // findStateForHook would otherwise attach this prompt to the OLD
    // chat's session — mixing prompts and orphaning the new chat's
    // capture. Detach when locked agentSessionId disagrees with the
    // incoming conversation_id, forcing the auto-create branch below
    // to spin up a fresh Origin session for the new chat.
    //
    // Codex is NOT detached here — its stdin rotates per turn.
    if (agentSlug === 'cursor') {
      const incomingChatId = cursorIncomingChatId(input);
      if (incomingChatId) {
        if (!state.agentSessionId) {
          state.agentSessionId = incomingChatId;
        } else if (state.agentSessionId !== incomingChatId) {
          // Cursor sessionStart fires on the MAIN checkout (composer id),
          // then the harness moves the agent into a linked worktree and the
          // first prompt carries a NEW conversation_id. That is the same
          // session, not a second chat — detaching here minted a twin row
          // (main + cursor/<id>) that the empty-session sweep later hid.
          const incomingWorking = getWorkingGitRoot(hookCwd) || hookCwd;
          const incomingCanonical = getCanonicalRepoPath(incomingWorking);
          if (isEmptyWorktreeBootstrap({
            promptCount: state.prompts?.length || 0,
            startedAt: state.startedAt,
            priorWorkingRoot: state.repoPath,
            priorCanonicalRoot: state.canonicalRepoPath || state.repoPath,
            incomingWorkingRoot: incomingWorking,
            incomingCanonicalRoot: incomingCanonical,
            nowMs: Date.now(),
          })) {
            debugLog('user-prompt-submit', 'cursor: adopting empty worktree-bootstrap session', {
              locked: state.agentSessionId,
              incoming: incomingChatId,
              priorOriginSession: state.sessionId,
            });
            restampWorktreeBootstrap(state, {
              agentSessionId: incomingChatId,
              lastCwd: hookCwd,
              repoPath: incomingWorking,
              canonicalRepoPath: incomingCanonical,
              branch: resolveSessionBranch(state, hookCwd),
            });
            // The server row was registered by session-start under the
            // composer id Cursor sent THEN (the main-checkout handshake), and
            // it kept that id after the restamp — only the branch was pushed.
            // Every server rung that reopens a closed row keys on
            // agentSessionId, so a later prompt in this chat (after the idle
            // reap) sent the real conversation id, matched nothing, and got a
            // twin (prod 49b1c722: server id dad65359, chat 7b2b1608). Push
            // the corrected id along with the branch.
            if (isConnectedMode() && state.sessionId && !state.sessionId.startsWith('local-')) {
              durableUpdate(state.sessionId, {
                ...(state.branch && { branch: state.branch }),
                agentSessionId: incomingChatId,
              }).catch(() => {});
            }
          } else {
            debugLog('user-prompt-submit', 'cursor: new chat id — detaching from prior state', {
              locked: state.agentSessionId,
              incoming: incomingChatId,
              priorOriginSession: state.sessionId,
            });
            state = null;
          }
        }
      }
    } else if (agentSlug === 'gemini') {
      // Gemini: each chat has its own transcript JSON at
      // `~/.gemini/...chats/session-<id>.json` and Gemini's stdin
      // sends transcript_path on every hook. When the user opens a
      // NEW chat in the same workspace, the workspace-scoped
      // findStateForHook returns the OLD Gemini session's state and
      // we'd silently append the new chat's prompt to it.
      // Detach when stdin's transcript_path doesn't match state's,
      // forcing the auto-create branch to start a fresh Origin
      // session for the new chat. transcript_path is the most
      // reliable signal here — Gemini's session_id field is
      // inconsistent across CLI versions but the transcript file
      // is always per-chat.
      const incomingTranscriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
      if (incomingTranscriptPath) {
        if (!state.transcriptPath) {
          state.transcriptPath = incomingTranscriptPath;
        } else if (state.transcriptPath !== incomingTranscriptPath) {
          debugLog('user-prompt-submit', 'gemini: new transcript_path — detaching from prior state', {
            locked: state.transcriptPath,
            incoming: incomingTranscriptPath,
            priorOriginSession: state.sessionId,
          });
          state = null;
        }
      }
    } else {
      // Other agents: just record stdin id when state has none (useful
      // for downstream discovery hooks that anchor on it).
      const stdinAgentId =
        (typeof input.session_id === 'string' && input.session_id) ||
        (typeof input.conversation_id === 'string' && input.conversation_id) ||
        '';
      if (state && !state.agentSessionId && stdinAgentId) {
        state.agentSessionId = stdinAgentId;
      }
    }
    if (state) {
      if (input.transcript_path) state.transcriptPath = input.transcript_path;
      const heldProvisional = isProvisionalSessionId(state.sessionId);
      saveSessionState(state, found!.saveCwd, state.sessionTag);
      // The save re-reads a pending reservation and takes the id session-start
      // registered meanwhile. The identity pushes above were skipped while the
      // id was provisional, so the row on the server still carries what
      // session-start registered — main's branch and, for Cursor, the
      // handshake's composer id — and every server rung that reopens a row
      // keys on that id. Push what this hook knows now.
      if (heldProvisional && !isProvisionalSessionId(state.sessionId)) {
        debugLog('user-prompt-submit', 'session-start registered the reservation meanwhile — continuing on its id', {
          sessionId: state.sessionId, tag: state.sessionTag, agentSlug,
          branch: state.branch, agentSessionId: state.agentSessionId,
        });
        if (isConnectedMode() && (state.branch || state.agentSessionId)) {
          durableUpdate(state.sessionId, {
            ...(state.branch && { branch: state.branch }),
            ...(state.agentSessionId && { agentSessionId: state.agentSessionId }),
          }).catch(() => {});
        }
      }
      // Self-heal a local-only session here too — every prompt is a retry
      // point, so a transient server outage at start no longer hides the
      // whole session from Origin until (or unless) stop runs.
      await ensureServerSession(state, found!.saveCwd, agentSlug, 'user-prompt-submit');
    }
  }
  if (!state && stableAgents.includes(agentSlug || '') && typeof input.session_id === 'string' && input.session_id) {
    // This conversation's own state, ended by the heartbeat's idle reap while
    // the conversation was still open. Auto-creating here made a SECOND state
    // file for the same session and left the turn history in the first (this
    // session, 2026-09-09) — resume the row instead.
    const resumed = resumeEndedConversationState(hookCwd, input.session_id, agentSlug, 'user-prompt-submit');
    if (resumed) {
      found = resumed;
      state = resumed.state;
      if (input.transcript_path) state.transcriptPath = input.transcript_path;
    }
  }
  if (!state) {
    // Before auto-creating, try to recover from archive (session state file may have been
    // deleted by a stale cleanup or heartbeat, but the archive still has the session).
    // Only for agents that REUSE sessions (Cursor). For Codex and others that create
    // new sessions per conversation, recovering old sessions causes stale headShaAtStart
    // which makes diffs show old changes.
    const agentsWithArchiveRecovery = ['cursor'];
    if (agentsWithArchiveRecovery.includes(agentSlug || '')) {
      try {
        const recoveryRepoPath = getWorkingGitRoot(hookCwd) || discoverGitRoot(hookCwd) || hookCwd;
        // Archives written before the worktree fix carry the CANONICAL path
        // as repoPath; new ones carry the working root. Match either.
        const recoveryCanonical = getCanonicalRepoPath(recoveryRepoPath);
        const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
        const archiveEntries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
        const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
        // The incoming Cursor chat id — recovery must not re-attach this prompt
        // to a DIFFERENT chat's archived session (which would undo the detach
        // above). Resolve it exactly as the detach + session-start paths do.
        const incomingChatId =
          (typeof input.conversation_id === 'string' && input.conversation_id) ||
          (typeof input.session_id === 'string' && input.session_id) ||
          '';
        const states: any[] = [];
        for (const entry of archiveEntries) {
          try { states.push(JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'))); } catch { /* skip */ }
        }
        const bestCandidate = selectRecoverableArchiveSession(states, {
          repoPath: recoveryRepoPath,
          canonicalRepoPath: recoveryCanonical,
          agentSlug,
          incomingChatId,
          nowMs: Date.now(),
          maxAgeMs: MAX_RECOVERY_AGE_MS,
        });
        if (bestCandidate) {
          const bestAge = Date.now() - new Date(bestCandidate.startedAt).getTime();
          const wasEnded = bestCandidate.status === 'ENDED' || !!bestCandidate.endedAt;
          debugLog('user-prompt-submit', wasEnded ? 'resuming ended session from archive (same chat)' : 'recovered session from archive', {
            sessionId: bestCandidate.sessionId,
            tag: bestCandidate.sessionTag,
            ageMin: Math.round(bestAge / 60000),
            endedAt: bestCandidate.endedAt,
          });
          // An ENDED row is dead to every liveness check (isSessionAlive,
          // listActiveSessions) for as long as `endedAt` stands, and the
          // heartbeat restart below keys on the same. Reopen it here; the
          // prompt PATCH carries a new turn, which is what the server accepts
          // as a genuine resume (COMPLETED → RUNNING, endedAt cleared).
          if (wasEnded) {
            bestCandidate.status = 'RUNNING';
            delete bestCandidate.endedAt;
          }
          // Restore the .git state file so subsequent hooks can find it
          saveSessionState(bestCandidate, recoveryRepoPath, bestCandidate.sessionTag);
          state = bestCandidate;
        }
      } catch { /* no archive dir — fall through to auto-create */ }
    }
  }
  if (!state) {
    // No existing session at all — auto-create one (first prompt without SessionStart)
    debugLog('user-prompt-submit', 'no session state — attempting auto-create', { hookCwd });
    const autoConfig = loadConfig();
    let autoAgentConfig = loadAgentConfig();
    // Working root for git capture (worktree-aware); canonical for the
    // server payload — same split as the session-start path.
    const repoPath = getWorkingGitRoot(hookCwd) || discoverGitRoot(hookCwd);
    const canonicalRepoPath = repoPath ? getCanonicalRepoPath(repoPath) : repoPath;
    // Same repo-ignore gate as session-start: a first prompt with no prior state
    // (session-start skipped, or never fired) must NOT auto-create a session for
    // an ignored repo. Without this the ignore would leak — the prompt hook would
    // re-mint exactly the session the user excluded.
    const autoIgnoredMatch = matchIgnoredRepo(canonicalRepoPath || repoPath, loadConfig()?.ignoredRepos);
    if (repoPath && autoIgnoredMatch) {
      debugLog('user-prompt-submit', 'skip auto-create: repo is on the ignore list (origin ignore repo)', { repoPath, ignoredMatch: autoIgnoredMatch });
      return;
    }
    if (repoPath) {
      // Pull the repo's Origin metadata down before minting the session, the
      // same way handleSessionStart does — this path IS session start for any
      // agent whose sessionStart hook didn't fire.
      //
      // Cursor is the case that forced this: it fires sessionStart roughly once
      // per app launch, not per chat (measured on a real log: 2 sessionStart
      // against 10 user-prompt-submit / 10 stop). Every chat after the first
      // landed here, so an agent could run a whole session on memory that was
      // hours stale while a teammate's had been on the remote the entire time.
      // Codex/Devin/Copilot share the shape whenever their start hook is missed.
      //
      // Throttled and time-boxed, so the common case is a stat() and the worst
      // case is a bounded stall rather than an unbounded one.
      try {
        syncNotesForSessionStart(repoPath);
      } catch { /* never block a prompt on the network */ }

      // Look again before minting. The lookup that sent us down this path ran
      // at the top of the hook, and everything since — the notes sync above,
      // repo resolution, config loading — is slow enough for a session-start
      // firing alongside us to have published its reservation in the meantime.
      // Cursor starts both hooks within 5ms of each other, so this is the
      // common ordering, not a rare interleaving: in the prod trace the first
      // lookup missed by 400ms and the mint landed 8.9s later, by which point
      // the session had existed for most of that time.
      //
      // Creating here anyway is what produced two sessions for one chat.
      // Re-lookup is workspace-scoped, so it can return a SIBLING chat's state
      // — including the one the detach guard above just rejected. Adopting that
      // files this prompt, and the turn's whole diff, onto the previous chat's
      // session. Re-apply the same chat-id rule before adopting.
      const racedCandidate = findStateForHook(hookCwd, lookupSessionId, agentSlug);
      const racedIncomingWorking = getWorkingGitRoot(hookCwd) || hookCwd;
      const racedIncomingCanonical = getCanonicalRepoPath(racedIncomingWorking);
      const racedIsBootstrap = !!(racedCandidate && isEmptyWorktreeBootstrap({
        promptCount: racedCandidate.state.prompts?.length || 0,
        startedAt: racedCandidate.state.startedAt,
        priorWorkingRoot: racedCandidate.state.repoPath,
        priorCanonicalRoot: racedCandidate.state.canonicalRepoPath || racedCandidate.state.repoPath,
        incomingWorkingRoot: racedIncomingWorking,
        incomingCanonicalRoot: racedIncomingCanonical,
        nowMs: Date.now(),
      }));
      const raced =
        racedCandidate && (stateMatchesIncomingChat(racedCandidate.state, agentSlug, input) || racedIsBootstrap)
          ? racedCandidate
          : null;
      if (racedCandidate && !raced) {
        debugLog('user-prompt-submit', 'race re-lookup returned a different chat — not adopting', {
          locked: racedCandidate.state.agentSessionId,
          incoming: input.conversation_id || input.session_id || '',
          priorOriginSession: racedCandidate.state.sessionId,
          agentSlug,
        });
      }
      if (raced && racedIsBootstrap) {
        const incomingChatId = cursorIncomingChatId(input) || (typeof input.session_id === 'string' ? input.session_id : '');
        restampWorktreeBootstrap(raced.state, {
          agentSessionId: incomingChatId || undefined,
          lastCwd: hookCwd,
          repoPath: racedIncomingWorking,
          canonicalRepoPath: racedIncomingCanonical,
          branch: resolveSessionBranch(raced.state, hookCwd),
        });
        // Same as the first adoption site: the server row still carries the
        // handshake's composer id until told otherwise.
        if (isConnectedMode() && raced.state.sessionId && !raced.state.sessionId.startsWith('local-') && (raced.state.branch || incomingChatId)) {
          durableUpdate(raced.state.sessionId, {
            ...(raced.state.branch && { branch: raced.state.branch }),
            ...(incomingChatId && { agentSessionId: incomingChatId }),
          }).catch(() => {});
        }
      }
      if (raced) {
        found = raced;
        state = raced.state;
        if (input.transcript_path) state.transcriptPath = input.transcript_path;
        const pending = isPendingReservation(state);
        debugLog('user-prompt-submit', 'session-start won the race — adopting its session instead of auto-creating', {
          sessionId: state.sessionId, tag: state.sessionTag, agentSlug, pendingRegistration: pending,
        });
        try { saveSessionState(state, raced.saveCwd, state.sessionTag); } catch { /* non-fatal */ }
        // A fresh reservation means session-start is mid-`session/start` right
        // now, and it registers with the fuller payload (repoUrl, recentShas,
        // additionalRepoPaths). Racing it with our own registration is how one
        // chat ends up as two rows. Once the reservation goes stale — the start
        // hook died, or never got there — every prompt is a retry point again.
        if (!pending) {
          await ensureServerSession(state, raced.saveCwd, agentSlug, 'user-prompt-submit');
        }
      }

      // Derived exactly as session-start derives its tag, from the same
      // conversation anchor. Using `session_id` here while session-start used
      // `claudeSessionId` is what put one Cursor chat in two files — Cursor
      // has no claudeSessionId, so session-start fell through to a timestamp
      // (`smtfv1cat`) while this path used the conversation (`ceb22e9b-221`).
      // Same string on both sides means the loser of the race finds the
      // winner's file instead of creating a second session.
      //
      // Declared OUTSIDE the try below, not inside it: the catch builds the
      // local fallback session from both of these, and a `const` in a `try` is
      // not in scope in its `catch`. Inside, the fallback did not compile.
      const autoAgentSessionId = resolveAutoAgentSessionId(agentSlug, input.conversation_id, input.session_id);
      const autoTag = sessionTagFor(
        '', conversationAnchorId(agentSlug, input.conversation_id, input.session_id),
      );

      if (!state) try {
        // Auto-create agent config in standalone mode
        if (!autoAgentConfig) {
          autoAgentConfig = {
            machineId: crypto.randomUUID(),
            hostname: os.hostname(),
            detectedTools: detectTools(),
            orgId: 'local',
          };
          ensureConfigDir();
          saveAgentConfig(autoAgentConfig);
        }
        // Canonical first — see the session-start note: `origin link` writes
        // .origin.json untracked at the main root only.
        const repoConfig = loadRepoConfig(canonicalRepoPath || repoPath) || (canonicalRepoPath !== repoPath ? loadRepoConfig(repoPath) : null);
        const baseSlug = agentSlug || repoConfig?.agent || autoAgentConfig.agentSlug || undefined;
        const autoSlugs = autoConfig?.agentSlugs || {};
        const slugOverride = (agentSlug && autoSlugs[agentSlug]) || (baseSlug && autoSlugs[baseSlug]) || undefined;
        let finalAgentSlug = slugOverride || baseSlug;
        // Devin CLI reuses Claude Code's hooks, so this auto-create path fires
        // as 'claude-code' too. handleSessionStart already re-tags, but when its
        // state file isn't found here (a fresh Devin conversation whose
        // session-start state didn't resolve) we land in auto-create and would
        // mint a CLAUDE-labeled session for a Devin run — the reported
        // "Devin still captured as Claude". Re-tag with the same process probe.
        const retaggedAutoSlug = retagDevinFromProcess(finalAgentSlug);
        if (retaggedAutoSlug !== finalAgentSlug) {
          debugLog('user-prompt-submit', 're-tagging claude-code hook as devin (running under devin process)', {
            from: finalAgentSlug,
          });
          finalAgentSlug = retaggedAutoSlug;
        }
        const branch = getBranch(hookCwd);
        // Model default follows the RESOLVED slug — a re-tagged Devin session
        // must not default to "claude".
        let model = input.model || (finalAgentSlug === 'devin' ? 'devin'
          : agentSlug === 'gemini' ? 'gemini' : agentSlug === 'codex' ? 'codex' : 'claude');
        // Override bare "gemini" with the real model identifier from
        // the transcript metadata when available (Gemini CLI doesn't
        // include `model` in hook stdin, so the fallback above lands
        // on the brand name instead of e.g. "gemini-2.5-pro").
        if ((model === 'gemini' || !model) && agentSlug === 'gemini') {
          const tp =
            (typeof input.transcript_path === 'string' && input.transcript_path) ||
            discoverGeminiTranscriptPath({
              sessionId: typeof input.session_id === 'string' ? input.session_id : undefined,
            }) ||
            '';
          if (tp) {
            const gm = readGeminiModel(tp);
            if (gm) model = gm;
          }
        }
        // Same for Copilot — its stdin has no model, so the fallback above lands
        // on the bare "claude" brand. Read the real model from events.jsonl when
        // it already has an assistant turn (self-heals from turn 2 onward).
        if (agentSlug === 'copilot' && !isSpecificModel(model) && typeof input.transcript_path === 'string' && input.transcript_path) {
          const cm = readCopilotModel(input.transcript_path);
          if (cm) model = cm;
        }
        // Get git remote URL for better repo matching on the server
        let repoUrl = '';
        try {
          repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { windowsHide: true, cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* no remote — that's fine */ }
        // Same recent-HEAD advertisement as the session-start path: auto-create
        // is the common session-creating route for Codex (its SessionStart hook
        // is unreliable), so without it a moved local-only checkout would
        // auto-register a duplicate repo row here.
        const autoRecentShas = listRecentShas(repoPath, SESSION_START_RECENT_SHAS);

        let sessionId: string;
        let agentSystemPrompt: string | undefined;
        let activePolicies: string[] | undefined;
        let enforcementRules: any[] | undefined;
        if (isConnectedMode() && autoConfig) {
          try {
            // Pass the stable conversation id for agents that have one so the
            // server's session dedup can match this auto-create against the
            // session-start row instead of minting a duplicate that later
            // collides with an unrelated conversation on the same repo+agent.
            //
            // Cursor isn't in STABLE_SESSION_ID_AGENTS (its session_id rotates
            // per turn), but its conversation_id IS a stable per-chat anchor.
            // Without it, RESUMING an ended Cursor chat lands here with a null
            // agentSessionId, so the server's "resume a COMPLETED session via
            // agentSessionId" rung can't fire → it mints a twin into which
            // Cursor's replayed transcript re-copies every prior prompt (prod
            // 3a5328e9 duplicated e6f72dcc's 4 prompts). resolveAutoAgentSessionId
            // resolves it EXACTLY as session-start does.
            const result = await api.startSession({
              machineId: autoAgentConfig.machineId,
              prompt: input.prompt || '',
              model,
              repoPath: canonicalRepoPath || repoPath,
              repoUrl: repoUrl || undefined,
              recentShas: autoRecentShas.length > 0 ? autoRecentShas : undefined,
              agentSlug: finalAgentSlug,
              branch: branch || undefined,
              agentSessionId: autoAgentSessionId,
            });
            sessionId = result.sessionId as string;
            agentSystemPrompt = (result.agentSystemPrompt as string) || undefined;
            activePolicies = result.activePolicies && Array.isArray(result.activePolicies) ? result.activePolicies : undefined;
            enforcementRules = result.enforcementRules && Array.isArray(result.enforcementRules) ? result.enforcementRules : undefined;
            debugLog('user-prompt-submit', 'api returned policies', { sessionId, policiesCount: activePolicies?.length || 0, rulesCount: enforcementRules?.length || 0 });
          } catch (apiErr: any) {
            if (apiErr?.code === 'AGENT_DISABLED') {
              const agentName = apiErr?.body?.agent?.name || finalAgentSlug || 'this agent';
              process.stderr.write(`[origin] ${agentName} is disabled in your org — session kept local. An admin has been notified to enable it.\n`);
            } else {
              process.stderr.write(`[origin] API error (falling back to local): ${apiErr.message}\n`);
            }
            sessionId = `local-${crypto.randomUUID()}`;
          }
        } else {
          sessionId = `local-${crypto.randomUUID()}`;
        }

        debugLog('user-prompt-submit', 'auto-created session', { sessionId, sessionTag: autoTag, repoPath, repoUrl });
        // Same dirty-at-start tracking as the proper session-start path —
        // without it the heartbeat + session-snapshot filters can't exclude
        // another agent's leftover working-tree state from this session's
        // diffs (Codex's SessionStart hook is unreliable, so auto-create
        // through this path is the common case for Codex sessions).
        const autoSessionStartDirty = getDirtyFiles(hookCwd);
        let autoPrePromptSha = getHeadSha(hookCwd);
        let autoPrePromptDirtyFiles = autoSessionStartDirty;
        // FIX 3 — persist the session-start shadow SHA (was previously computed
        // here but never stored on state). This is the COMMON path for Codex,
        // whose SessionStart hook is unreliable. Without a stored
        // sessionStartShadowSha the stop handler's session-level snapshot can't
        // run its line-level shadow scoping and pre-existing uncommitted dirt
        // leaks into the session diff (read-only turn reporting phantom files).
        let autoSessionStartShadowSha: string | null = null;
        if (autoSessionStartDirty.length > 0) {
          try {
            const startShadowTag = autoTag || sessionId.slice(0, 12);
            const startShadow = createShadowCommit(hookCwd, `start-${startShadowTag}`);
            if (startShadow) {
              autoPrePromptSha = startShadow;
              autoPrePromptDirtyFiles = [];
              autoSessionStartShadowSha = startShadow;
              freshSessionStartShadow = startShadow;
              debugLog('user-prompt-submit', 'auto-create created session-start shadow', {
                shadow: startShadow.slice(0, 12), dirtyCount: autoSessionStartDirty.length,
              });
            }
          } catch (err: unknown) {
            debugLog('user-prompt-submit', 'auto-create shadow creation failed (non-fatal)', {
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // ── Re-attach: carry the accumulated history ────────────────────
        // This path also runs when a state file for this tag ALREADY exists
        // and the lookup declined it — most often because an idle sweep
        // marked the session ENDED while the user was away, and they then
        // typed again. saveSessionState writes wholesale, so starting empty
        // here does not "initialize" the session: it DESTROYS the prompt
        // history that the server's PromptChange rows are keyed on, and the
        // next turn is announced as index 0.
        //
        // Prod 0a8e2164: promptCount climbed 1→7 through the day, this path
        // fired after a 3h gap, and the next turn came back as 1 — with
        // mapping index 0 overwritten by a prompt from twenty minutes prior
        // while indices 1-3 still held the original early turns.
        //
        // Read by TAG rather than through the active-session lookup, since
        // the whole reason we are here is that the lookup rejected it.
        // `completedPromptMappings` carries promptText, so a state whose
        // prompts were already lost to an earlier reset still rebuilds.
        // By tag first. A session the desktop app started on the primary
        // checkout and Origin adopted into a worktree lives under the
        // HANDSHAKE's tag, not this conversation's — so when the tag misses,
        // find the file by the server's session id or the conversation id,
        // ENDED files included. Session 8a06aaf6 re-attached after an 11h gap
        // with nothing carried: commits, rewrite pairs, turn ids, counter.
        // (resumeEndedConversationState above is the first line of defence;
        // this is the fallback inside auto-create when it did not apply.)
        let priorState = loadSessionState(repoPath, autoTag);
        if (!priorState) {
          priorState = findPriorStateForConversation(
            hookCwd, [autoAgentSessionId, input.session_id], sessionId,
          );
          if (priorState) {
            debugLog('user-prompt-submit', 'auto-create re-attach — prior state found by conversation, not tag', {
              tag: autoTag, priorTag: priorState.sessionTag, priorStatus: (priorState as any)?.status || null,
            });
          }
        }
        const carriedPrompts = promptHistoryFromPriorState(priorState);
        // A missing SessionStart is different from a re-attach: there is no
        // state to carry, but Claude's transcript still holds the history.
        // Seed every earlier row before this hook appends the live prompt, so
        // the first API update includes index 0 and later commits cannot be
        // collapsed onto the newly-created row.
        const lateAttach = carriedPrompts.length === 0
          ? recoverLateAttachTranscript(input.transcript_path, String(input.prompt || ''), [repoPath, hookCwd])
          : { prompts: [], mappings: [] as PromptFileMapping[] };
        const initialPrompts = carriedPrompts.length > 0 ? carriedPrompts : lateAttach.prompts;
        if (carriedPrompts.length > 0) {
          debugLog('user-prompt-submit', 'auto-create re-attach — carrying prompt history', {
            tag: autoTag,
            carried: carriedPrompts.length,
            priorMappings: priorState?.completedPromptMappings?.length || 0,
            priorStatus: (priorState as any)?.status || null,
          });
        } else if (lateAttach.prompts.length > 0) {
          debugLog('user-prompt-submit', 'auto-create recovered transcript history after missing SessionStart', {
            tag: autoTag,
            recovered: lateAttach.prompts.length,
            mappings: lateAttach.mappings.length,
          });
        }
        state = {
          sessionId,
          claudeSessionId: autoAgentSessionId || input.session_id || '',
          agentSessionId: autoAgentSessionId || undefined,
          transcriptPath: input.transcript_path || '',
          model,
          startedAt: priorState?.startedAt || lateAttach.startedAt || new Date().toISOString(),
          prompts: initialPrompts,
          // Written out rather than routed through a local:
          // `reattach-carries-index-base.test.ts` reads this object literal as
          // TEXT and asserts `<field>: priorState?.<field>` for each field
          // whose loss renumbers or re-mints turns. That guard cannot follow a
          // variable, and it is protecting the exact failure this PR is near —
          // so satisfy it in place instead of loosening it.
          completedPromptMappings: priorState?.completedPromptMappings
            || (lateAttach.mappings.length > 0 ? lateAttach.mappings : undefined),
          promptResponses: priorState?.promptResponses,
          promptShadows: priorState?.promptShadows,
          // The transcript proves these prompts existed, but no hook observed
          // their start trees. Never let a later Stop borrow today's baseline
          // and falsely assign their cumulative git range to the new turn.
          promptsWithoutBaseline: priorState?.promptsWithoutBaseline
            || (lateAttach.prompts.length > 0 ? lateAttach.prompts.map((_, i) => i) : undefined),
          sessionCommitShas: priorState?.sessionCommitShas,
          // The (orphan → rewrite) pairs. Without them the next Stop re-sends
          // the originals' attestation and the server counts a squash on top
          // of the commits it replaced.
          rewrittenCommits: priorState?.rewrittenCommits,
          // Carry the local→server offset and the turn IDENTITIES with it.
          //
          // This literal is an explicit field list, and every field missing
          // from it is silently reset. `promptIndexBase` was one of them, so a
          // re-attach renumbered the whole conversation back to row 0: prod
          // f7881a6e held base 6, re-attached, and its next two turns were
          // written onto rows 0 and 1 — on top of turn one's real work and a
          // chat-only question — while rows 6 and 7 got the same content again.
          // That is also what silently undid a hand-repair of row 1: not a
          // heal, not the read-time anchoring, just this turn's diff landing on
          // someone else's row.
          //
          // `promptTurnIds` travels with it because every writer keys rows by
          // turnId now; a re-minted id makes an existing row unaddressable, so
          // the base alone would fix the arithmetic and still strand the rows.
          // `lastClosedTurnIndex` is what the next capture binds after
          // (lastClosed + 1), and `commitTurns` is observed sha→turn evidence
          // that is positional-free and expensive to lose.
          promptIndexBase: priorState?.promptIndexBase,
          promptTurnIds: priorState?.promptTurnIds,
          lastClosedTurnIndex: priorState?.lastClosedTurnIndex,
          commitTurns: priorState?.commitTurns,
          // NOT activeTurn. A turn left open by a missed close survives the
          // re-attach as "still running" and attests the next commit to a turn
          // that ended long ago — the stale-attestation half of #1334. Leaving
          // it null makes the next capture bind lastClosedTurnIndex + 1, which
          // is the turn that is actually starting.
          repoPath,
          lastCwd: hookCwd,
          canonicalRepoPath: canonicalRepoPath || undefined,
          // The session's baseline is where the CONVERSATION started. Re-set
          // to today's HEAD, the header's committed walk starts after the
          // work it should count.
          headShaAtStart: priorState?.headShaAtStart || getHeadSha(hookCwd),
          headShaAtLastStop: null,
          prePromptSha: autoPrePromptSha,
          prePromptDirtyFiles: autoPrePromptDirtyFiles,
          sessionStartDirtyFiles: autoSessionStartDirty,
          sessionStartShadowSha: autoSessionStartShadowSha,
          branch,
          sessionTag: autoTag,
          agentSlug: finalAgentSlug || agentSlug,
          agentSystemPrompt,
          activePolicies,
          enforcementRules,
        };
        // ONE state file per server session — the same guard session-start
        // runs, which this path lacked entirely.
        //
        // We are here because the lookup found no state a moment ago. But
        // session-start is racing us for the same conversation: it calls
        // startSession too, the server's dedup ladder hands BOTH of us the same
        // sessionId, and it writes its own minted tag while we write one
        // derived from the conversation id. Two files, one session.
        //
        // Cursor loses this race routinely (session eebcce84: session-start
        // saved `smta56mxu` at 13:41:08.184, we saved `0e340a60-bc0` at
        // 13:41:08.7). The damage is not the numbering collision session-start
        // guards against — it is that the OTHER file has no prompts, and
        // whichever one `findStateForHook` happens to pick is the one every
        // later hook uses. It picked the empty one: 23 of 23 `after-file-edit`
        // fires aborted "no current prompt" and the session's entire live
        // capture was lost. Nothing surfaced it, because Stop rebuilt the
        // session from the transcript and the finished result looked correct.
        //
        // Scanning HERE rather than earlier is the point: the duplicate is
        // written during the window we spent in startSession, so a check
        // before that call is exactly the one that misses it.
        try {
          const dup = findDuplicateStateForSession(listActiveSessions(repoPath), sessionId, autoTag);
          if (dup?.sessionTag) {
            carryForwardTurnState(state, dup);
            clearSessionState(repoPath, dup.sessionTag);
            debugLog('user-prompt-submit', 'merged duplicate state file for same sessionId', {
              sessionId, keptTag: autoTag, removedTag: dup.sessionTag,
              carriedPrompts: state.prompts?.length || 0,
            });
          }
        } catch { /* best-effort — never block the prompt on dedup */ }

        saveSessionState(state, repoPath, autoTag);
        sessionJustAutoCreated = true;

        // Start heartbeat for auto-created sessions so they don't get cleaned up as stale
        const connected = isConnectedMode();
        if (connected && autoConfig) {
          const stateFile = getStatePath(repoPath, autoTag);
          startHeartbeat(sessionId, autoConfig.apiUrl || 'https://getorigin.io', autoConfig.apiKey, stateFile, finalAgentSlug);
          debugLog('user-prompt-submit', 'heartbeat started for auto-created session', { sessionId, stateFile, agentSlug: finalAgentSlug });
        }
      } catch (err: any) {
        debugLog('user-prompt-submit', 'auto-create failed, falling back to local', { message: err.message });
        const status = err.status || 0;
        if (status === 401) {
          process.stderr.write(`[origin] API key invalid — session tracked locally. Run \`origin login\`.\n`);
        } else if (status === 403) {
          process.stderr.write(`[origin] ${err.message} — session tracked locally.\n`);
        } else if (status === 429) {
          process.stderr.write(`[origin] Budget limit reached — session tracked locally.\n`);
        }
        // Always create a local fallback session so tracking continues
        if (!state && repoPath) {
          const fbId = `local-${crypto.randomUUID()}`;
          const fbModel = input.model || agentSlug || 'unknown';
          const fbBranch = getBranch(hookCwd);
          const fbTag = autoTag || (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;
          const fbSessionStartDirty = getDirtyFiles(hookCwd);
          state = {
            sessionId: fbId,
            claudeSessionId: autoAgentSessionId || input.session_id || '',
            agentSessionId: autoAgentSessionId || undefined,
            transcriptPath: input.transcript_path || '',
            model: fbModel,
            startedAt: new Date().toISOString(),
            prompts: [],
            repoPath,
            lastCwd: hookCwd,
            headShaAtStart: getHeadSha(hookCwd),
            headShaAtLastStop: null,
            prePromptSha: getHeadSha(hookCwd),
            prePromptDirtyFiles: getDirtyFiles(hookCwd),
            sessionStartDirtyFiles: fbSessionStartDirty,
            branch: fbBranch,
            sessionTag: fbTag,
          };
          // Hard cap refused the session server-side (429) — carry the
          // lockout into the fallback state so the budget gate below
          // blocks this very prompt instead of letting work continue
          // merely because tracking degraded to local.
          if (status === 429) {
            state.budgetBlocked = true;
            state.budgetBlockReason = err?.message || 'Budget limit exceeded';
          }
          saveSessionState(state, repoPath, fbTag);
          debugLog('user-prompt-submit', 'local fallback session created', { sessionId: fbId, sessionTag: fbTag });
        }
      }
    }
  }

  if (!state) {
    debugLog('user-prompt-submit', 'ABORT: no session state', { hookCwd });
    return;
  }

  // ── Budget lockout gate ──────────────────────────────────────────────
  // Blocks the prompt (exit 2) when a hard cap is breached, BEFORE any
  // bookkeeping — a blocked prompt never reaches the model, so it must
  // not be recorded as a turn either.
  if (state) {
    await enforceBudgetLockout(state, agentSlug, hookCwd, 'user-prompt-submit');
  }

  // ── SESSION_LIMITS max-duration gate ─────────────────────────────────
  // Team policy: sessions older than max_duration_minutes stop accepting
  // prompts (action: block). Enforced ONLY at prompt boundaries — never
  // mid-turn — so in-flight work is never cut off; the user finishes the
  // current turn, then the next prompt is refused with a message telling
  // them to start a fresh session. The heartbeat handles the time-based
  // notifications (idle notify, approaching-cap warning, max-idle auto-end).
  if (state) {
    enforceSessionDurationLimit(state, agentSlug, 'user-prompt-submit');
  }

  const rawPrompt = input.prompt || '';
  // Same cleaner the transcript parser uses. The hook used to unwrap only
  // `<user_query>` and leave Cursor's `<timestamp>` / `<image_files>` /
  // leading `[Image]` line in the stored row. Stop then parsed the inner
  // text, `samePromptText` could not match them, and the dashboard showed
  // every illustrated turn twice (session 562314d8). promptTextForEntry is
  // also how captionless screenshots stay a turn (`[image]` placeholder).
  const prompt = promptTextForEntry({
    type: 'user',
    message: { role: 'user', content: rawPrompt },
  }) || '';
  const isSystemMsg = !prompt;
  if (prompt && !isSystemMsg) {
    // ── Dual-hook dedup ──────────────────────────────────────────────────
    // The Devin CLI reads BOTH ~/.claude (claude-code) and ~/.devin (devin)
    // hook configs, so ONE user prompt fires this hook twice — once per
    // config — with the SAME payload against the SAME session. Left
    // unguarded, the prompt is saved twice (two identical turns) and the
    // duplicate pushes the native prompt index to 1, which the server reads
    // as "capture started mid-stream" and shows a false Partial-capture
    // banner. Same prompt_id landing back-to-back on the same session is the
    // collision, not a new turn — skip the second fire entirely (its context
    // injection is redundant too; the first fire already injected).
    //
    // Codex is now a dual-SOURCE agent too: `origin enable` registers its hooks
    // in BOTH ~/.codex/hooks.json AND inline in ~/.codex/config.toml, and Codex
    // "loads all matching hooks" from every source it discovers — so on builds
    // that see both, one user prompt fires this hook twice. Codex sends no
    // `prompt_id`; its stable per-turn id is `turn_id`. Fall back to it so the
    // second fire is recognised as a duplicate, not a new turn.
    const incomingPromptId =
      (typeof input.prompt_id === 'string' && input.prompt_id) ? input.prompt_id
      : (typeof input.turn_id === 'string' && input.turn_id) ? input.turn_id
      : '';
    if (incomingPromptId && state.lastPromptId === incomingPromptId && state.prompts.length > 0) {
      debugLog('user-prompt-submit', 'SKIP duplicate prompt (dual-hook double-fire)', {
        promptId: incomingPromptId, agentSlug, promptCount: state.prompts.length,
      });
      return;
    }
    // Cursor fires this hook twice for one illustrated turn (envelope vs
    // inner text) and sometimes twice with no prompt_id at all. After
    // promptTextForEntry they are the same sentence. Other agents can
    // genuinely re-send "try again"; only Cursor is known to double-fire.
    const lastStored = state.prompts[state.prompts.length - 1];
    if (agentSlug === 'cursor' && lastStored && samePromptText(prompt, lastStored)) {
      debugLog('user-prompt-submit', 'SKIP duplicate prompt (same text as last Cursor turn)', {
        promptCount: state.prompts.length,
      });
      return;
    }
    // Write-ahead copy of the prompt list, BEFORE the git work below. Cursor
    // kills this hook when the next prompt overlaps a slow captureGitState /
    // shadow commit — session e24477e2: submit matched the session at 02:41
    // and never logged "prompt saved", so prompt 3 never reached the API.
    // Only the queue entry is written here; the state file keeps its single
    // save after the turn boundary is complete (shadow, journal mark, turn
    // id), so a kill leaves either the whole turn or none of it on disk. The
    // real send at the end of this hook supersedes the entry.
    let prePersisted: string | null = null;
    if (isConnectedMode() && state.sessionId && !String(state.sessionId).startsWith('local-')) {
      try {
        const earlyRedact = loadConfig()?.secretRedaction !== false;
        const earlyPrompts = [...state.prompts, prompt].map((p) => (earlyRedact ? redactSecrets(p).redacted : p));
        const earlyPayload = { prompt: earlyPrompts.join('\n\n---\n\n') || undefined };
        prePersisted = persistUpdateBeforeWork(state.sessionId, earlyPayload, (e, m, d) => debugLog(e, m, d));
        debugLog('user-prompt-submit', 'prompts persisted before git capture', { promptCount: earlyPrompts.length });
      } catch { /* never block the prompt on a queue write */ }
    }
    // ── Per-prompt diff: capture previous prompt's changes before recording new prompt ──
    const repoPath = state.repoPath || hookCwd;
    const currentHead = getHeadSha(repoPath);
    if (state.prePromptSha && currentHead && state.prompts.length > 0) {
      try {
        // The turn whose work this is: the one currently OPEN. Identical to
        // the list tail when prompts arrive one at a time, but not when this
        // submit is a queued interjection — then the open turn is still the
        // earlier one, and its work must not be filed under the prompt that
        // has only just been typed.
        // LOCAL turn number, then converted to the SERVER row it belongs to.
        // Both `activeTurn.index` and the list tail count from 0 within this
        // launch only; without the base a resumed conversation writes this
        // turn's diff and commit sha onto row 0, which belongs to turn one
        // (session 2e58a848).
        const prevLocalIdx = state.activeTurn?.index ?? (state.prompts.length - 1); // the prompt that just finished
        const prevPromptIdx = serverRowForLocalTurn(prevLocalIdx, state.promptIndexBase);
        // Prefer the per-prompt shadow recorded by the heartbeat daemon at
        // the moment this prompt was detected in the rollout. That shadow
        // represents the working tree state at the START of this prompt
        // (= end of the previous prompt's work). Using it as the baseline
        // for `captureGitState` produces a per-prompt diff that contains
        // ONLY this prompt's work, even when no prompt-submit hook fired
        // (Codex auto-trust gating, Gemini IDE plug-in, etc.).
        // promptShadows are written by this same hook from the LOCAL counter,
        // so they are looked up in local space — unlike completedPromptMappings
        // below, which Stop fills with SERVER row indices.
        const promptShadow = (state.promptShadows || []).find(
          (s) => s.promptIndex === prevLocalIdx,
        );
        const captureBaseline = promptShadow?.shadowSha || state.prePromptSha;
        // fullContext: per-prompt pc.diff feeds the blame route's
        // fallback path when sessionDiff doesn't cover the file (typical
        // for uncommitted work). Full-file context lets the replay
        // anchor every editsJson edit at an exact position instead of
        // falling through to content-keyed guessing.
        const prevGitCapture = captureGitState(repoPath, captureBaseline, { fullContext: true });
        // Scope `committedDiff` to commits THIS session authored. Walking
        // the session's own commit list keeps concurrent agents isolated:
        // a heartbeat in this session no longer picks up a foreign agent's
        // commits even when HEAD has moved past ours.
        // Scoped to THIS TURN's window — `captureBaseline` is the prompt's
        // own shadow. Session-wide here is what made turns duplicate each
        // other's diffs (see sessionScopedCommittedDiff).
        const sessionCommitted = sessionScopedCommittedDiff(repoPath, state, captureBaseline);
        // Extract filesChanged from the TURN-SCOPED committed diff + diff
        // headers. `commitDetails` used to seed this, but that is the whole
        // commit's file list — on a `git commit -a` it names every file that
        // happened to be dirty, so a turn that touched 7 files reported the
        // commit's 13 (prod 7a0a9efc turn 1).
        // A CONCURRENT session's commits can sit in `baseline..HEAD` in a
        // shared checkout, and `prevGitCapture.diff` is that raw range. Stop
        // drops them before anything reads it; this path never did, so it
        // re-derived the previous turn from a range holding another session's
        // work and OVERWROTE the good mapping Stop had just written.
        //
        // Session b0c86852: Stop stored turn 3 as 2 files, then this hook
        // re-captured it as 9 / +307 on the next prompt — the extra 5 were
        // #1380, which Stop had correctly dropped seconds earlier and logged
        // (`dropped: [aab018ef]`). The stored `diff` stayed clean because it is
        // built from `sessionCommitted`; only the FILE LIST was polluted, so
        // the row claimed five files whose changes it did not contain.
        const prevForeignFiles = dropForeignCommitsFromCapture(
          repoPath, state, prevGitCapture as any, 'user-prompt-submit',
        );
        const prevFilesSet = new Set<string>(
          retroactiveTurnFiles(sessionCommitted, prevGitCapture.diff || '', prevForeignFiles),
        );
        // Filter uncommitted diff against the prompt-baseline + session-start
        // pre-existing dirt union (see uncommittedExcludeUnion).
        const filteredUncommitted = filterUncommittedDiff(
          prevGitCapture.uncommittedDiff || '', uncommittedExcludeUnion(state),
        );
        if (filteredUncommitted) {
          for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
            if (m[1]) prevFilesSet.add(m[1]);
          }
        }
        const prevFilesChanged = Array.from(prevFilesSet);
        if (prevGitCapture.diff || filteredUncommitted || prevFilesChanged.length > 0) {
          // Get the current checkout SHA + working-tree SHA for restore
          // support. A checkout SHA is not, by itself, proof that this prompt
          // authored that commit; only retain it when post-commit bound it to
          // this stable turn id (see attestedHeadForPrompt).
          let prevCommitSha: string | null = null;
          let currentHeadSha: string | null = null;
          let prevTreeSha: string | null = null;
          try {
            currentHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: state.repoPath || hookCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          } catch { /* ignore */ }
          prevCommitSha = attestedHeadForPrompt(state, prevPromptIdx, currentHeadSha);
          prevTreeSha = getWorkingTreeSha(state.repoPath || hookCwd);
          const diffText = combineApplyableTurnDiff({
            committedDiff: sessionCommitted,
            uncommittedDiff: filteredUncommitted,
            workingTreeDiff: prevGitCapture.workingTreeDiff || '',
          });
          const prevMapping = {
            promptIndex: prevPromptIdx,
            // …but the TEXT comes out of our own list, which is local-space.
            promptText: (state.prompts[prevLocalIdx] || '').slice(0, 1000),
            filesChanged: prevFilesChanged,
            diff: diffText.slice(0, 200_000),
            uncommittedDiff: filteredUncommitted.slice(0, 200_000),
            commitSha: prevCommitSha,
            treeSha: prevTreeSha,
          };
          if (!state.completedPromptMappings) state.completedPromptMappings = [];
          // Replace if same promptIndex exists, else append.
          // BUT: don't overwrite a non-empty existing diff with an empty
          // one — that happens when STOP already captured the previous
          // prompt's work and then set prePromptDirtyFiles to those files,
          // which causes filterUncommittedDiff here to strip everything
          // back out, leaving us with prevMapping.diff="" that would clobber
          // the good mapping STOP saved a second earlier.
          const existingIdx = state.completedPromptMappings.findIndex(m => m.promptIndex === prevPromptIdx);
          if (existingIdx >= 0) {
            const existing = state.completedPromptMappings[existingIdx];
            const newHasDiff = !!(prevMapping.diff || prevMapping.uncommittedDiff);
            const existingHasDiff = !!(existing.diff || (existing as any).uncommittedDiff);
            // Stop already marked this prompt as chat-only (no commits + no
            // transcript edits). Don't let the retroactive capture re-attribute
            // pre-existing dirty working-tree state to a turn the agent didn't
            // actually touch code on.
            const existingIsChatOnly = (existing as any).chatOnly === true;
            if (existingIsChatOnly) {
              debugLog('user-prompt-submit', 'kept existing chat-only mapping', {
                promptIndex: prevPromptIdx,
              });
            } else if (newHasDiff || !existingHasDiff) {
              state.completedPromptMappings[existingIdx] = stampCaptured(prevMapping);
            } else {
              debugLog('user-prompt-submit', 'kept existing previous-prompt mapping (new diff was empty)', {
                promptIndex: prevPromptIdx,
              });
            }
          } else {
            state.completedPromptMappings.push(stampCaptured(prevMapping));
          }
          debugLog('user-prompt-submit', 'captured per-prompt diff for previous prompt', {
            promptIndex: prevPromptIdx, filesChanged: prevFilesChanged.length,
            linesAdded: prevGitCapture.linesAdded, linesRemoved: prevGitCapture.linesRemoved,
            hadEmptyDiff: !(prevMapping.diff || prevMapping.uncommittedDiff),
            // BOTH index spaces, because they can disagree: prevPromptIdx is
            // transcript-space and prevLocalIdx indexes our own prompt list.
            // A mismatch here puts the previous turn's work on another row.
            prevLocalIdx,
            // sessionScopedCommittedDiff replays EVERY commit this session
            // made, so this mapping's diff is not necessarily scoped to the
            // one turn the index names. Record how much of each it carried.
            sessionCommittedBytes: sessionCommitted.length,
            uncommittedBytes: filteredUncommitted.length,
            sessionCommitShas: (state.sessionCommitShas || []).map((x: string) => String(x).slice(0, 8)),
            payload: summarizePromptPayload([prevMapping as any]),
          });
        }
      } catch (err: any) {
        debugLog('user-prompt-submit', 'per-prompt diff capture failed (non-fatal)', { message: err.message });
      }
    }
    // Record baseline for the NEW prompt. If the working tree is dirty at
    // this point, create a per-prompt shadow commit capturing the current
    // state. The next prompt's retroactive capture will then compute its
    // diff against THIS shadow — isolating only the new prompt's work and
    // excluding everything that was uncommitted before it started.
    //
    // Without this, multiple prompts share `prePromptSha = HEAD` while the
    // working tree accumulates uncommitted edits across prompts; the
    // resulting per-prompt `uncommittedDiff` for each prompt is cumulative
    // (= "all changes since HEAD"), which means prompt N's mapping
    // appears to include prompt N-1's, N-2's, ... work too.
    if (freshSessionStartShadow && state.prePromptSha === freshSessionStartShadow) {
      // This same invocation created the session-start shadow a moment ago and
      // nothing since has touched the working tree, so it IS the correct
      // baseline for this prompt. Re-snapshotting would spend four git spawns
      // producing a new sha over a byte-identical tree.
      debugLog('user-prompt-submit', 'reusing session-start shadow as prompt baseline', {
        shadow: freshSessionStartShadow.slice(0, 12),
      });
    } else {
      const repo = state.repoPath || hookCwd;
      // If this session is writing in a linked worktree, snapshot a baseline
      // THERE too. prePromptSha stays anchored to repoPath (other paths diff
      // it against that tree), so the worktree pair is carried separately and
      // used only by the shell-window capture, which needs both halves from
      // the same tree. See session-worktree.ts.
      recordWorkTreeBaseline(state, hookCwd);
      const dirty = getDirtyFiles(repo);
      if (dirty.length > 0) {
        try {
          const shadowTag = state.sessionTag || state.sessionId.slice(0, 12);
          const shadow = createShadowCommit(repo, `prompt-${shadowTag}`);
          if (shadow) {
            state.prePromptSha = shadow;
            state.prePromptDirtyFiles = [];
            debugLog('user-prompt-submit', 'anchored next-prompt baseline to shadow', {
              shadow: shadow.slice(0, 12), dirtyCount: dirty.length,
            });
          } else {
            // Shadow creation failed — fall back to HEAD + dirty list.
            state.prePromptSha = currentHead;
            state.prePromptDirtyFiles = dirty;
          }
        } catch {
          state.prePromptSha = currentHead;
          state.prePromptDirtyFiles = dirty;
        }
      } else {
        state.prePromptSha = currentHead;
        state.prePromptDirtyFiles = [];
      }
    }

    state.prompts.push(prompt);
    // Stamp the turn's start so the write journal can scope its records to it.
    // Without a boundary the journal is just a session-long list and claims
    // every write for every turn.
    state.currentTurnStartedAt = Date.now();
    // Agents with no tool hooks have only the turn window; give them a write
    // journal so their turns rest on observed writes instead.
    ensureWriteJournal(state, agentSlug);
    // Record who else is writing here, so this turn's numbers can be presented
    // for what they are.
    noteCheckoutContention(state);
    // Record that baseline AGAINST THIS PROMPT'S INDEX, not just as the
    // rolling `prePromptSha`. The rolling value only ever describes the most
    // recent turn, so any consumer that needs an ARBITRARY turn's start-state
    // — Stop, which processes every capture in one pass — had nothing to look
    // up and fell back to session-start. A file two turns both touched then
    // re-counted the earlier turn's lines against the later one.
    //
    // `promptShadows` already carries exactly this meaning ("the working tree
    // at the START of prompt i") and is already preferred over `prePromptSha`
    // by the per-prompt capture above; until now only the heartbeat daemon
    // (Codex/Gemini) ever populated it, so it was empty for every hook-driven
    // session on disk.
    // Prompts that arrived since the last hook run were never anchored, and a
    // baseline cannot be reconstructed for them after the fact. Record the
    // absence so they stop borrowing the session's start-state and re-stating
    // every turn before them.
    const unanchored = markSkippedPromptBaselines(state, state.prompts.length - 1);
    if (unanchored.length > 0) {
      debugLog('user-prompt-submit', 'prompts arrived without a hook run — no baseline for them', {
        promptIndexes: unanchored, throughIndex: state.prompts.length - 1,
      });
    }
    recordPromptShadow(state, state.prompts.length - 1, state.prePromptSha);
    // Stable identity for this turn, assigned once and never renumbered. The
    // server keys the PromptChange row on it, so a later reshuffle of the
    // prompt LIST cannot slide one turn's diff onto another turn's row.
    if (!state.promptTurnIds) state.promptTurnIds = [];
    const newTurnIdx = state.prompts.length - 1;
    if (!state.promptTurnIds[newTurnIdx]) {
      state.promptTurnIds[newTurnIdx] = `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }
    // Put the boundary in the JOURNAL too, not just on the state file.
    //
    // Once it is there, a turn's writes are the entries between its mark and
    // the next one — decided by POSITION in one append-only log. Today they are
    // decided by comparing a write's timestamp to a window held in a different
    // file, and that window has a known soft edge: the watcher polls, so a
    // baseline can be taken after the turn really began and turn N swallows
    // turn N+1's first writes (transcript-attribution.ts documents that exact
    // failure). Two clocks and two files can disagree; one ordered log cannot.
    // ONLY if the id is not already marked. `turnSpan` honours the LAST mark
    // for an id, so re-marking a turn the foreground pre-marked (Copilot) would
    // move its start past every write that landed while the background
    // process was getting here — the exact writes the pre-mark exists to keep.
    if (state.writeJournalPath && !journalHasMark(state.writeJournalPath, state.promptTurnIds[newTurnIdx])) {
      markTurn(state.writeJournalPath, state.promptTurnIds[newTurnIdx], state.currentTurnStartedAt);
    }
    // Deliberately NOT opening a turn here. If one is already open this prompt
    // is queued behind it and must wait its turn; the next capture after Stop
    // binds it. Treating submit as "the current turn is now this one" is
    // exactly the bug this replaced.
    //
    // But when NOTHING is open, every earlier turn is over — a turn that used
    // a tool is open until its Stop closes it, and one that used none never
    // opened. Recording that here is what keeps the sequence pointer honest
    // when a chat-only turn's Stop was missed (an interrupt, a crash): without
    // it the next tool call binds "next after closed", which is still the
    // chat-only turn, and this prompt's work is filed one turn back.
    //
    // And a turn that is open but DEAD is over too. A turn that ends in an
    // API error or an interrupt fires no Stop, so nothing closes it, and the
    // retry typed a minute later is treated as queued behind it — its every
    // write and its commit filed under the turn that died. Prod vodka
    // a219d616: turn 2 died on ECONNRESET at 14:11; the retry at 15:01 wrote
    // eight files and committed, all attested to turn 2. The transcript knows
    // (see turn-liveness.ts); ask it before deciding the new prompt must wait.
    if (state.activeTurn && Number.isInteger(state.activeTurn.index)) {
      const liveness = openTurnLiveness(state.transcriptPath, state.activeTurn.openedAt);
      if (liveness === 'dead') {
        debugLog('user-prompt-submit', 'open turn is dead in the transcript — closing it', {
          index: state.activeTurn.index, openedAt: state.activeTurn.openedAt,
        });
        closeTurn(state, state.activeTurn.index);
      }
    }
    if (!state.activeTurn && newTurnIdx > 0) {
      state.lastClosedTurnIndex = Math.max(state.lastClosedTurnIndex ?? -1, newTurnIdx - 1);
    }
    // Remember this prompt's id so a dual-hook second fire (Devin CLI) is
    // recognized as a duplicate on the next invocation, not a new turn.
    if (incomingPromptId) state.lastPromptId = incomingPromptId;

    // Update transcript path if provided (may change between turns)
    if (input.transcript_path) {
      state.transcriptPath = input.transcript_path;
    }

    // ── Mid-session branch tracking ─────────────────────────────────────
    // Agents that don't fire PostToolUse (Codex) otherwise never get a
    // branch refresh until session-end, so sessions look stuck on the
    // branch they started on even after the agent `git checkout`s a new one.
    // getBranch() just reads .git/HEAD so it's cheap to do on every prompt.
    try {
      const currentBranch = resolveSessionBranch(state, hookCwd);
      if (currentBranch && currentBranch !== state.branch) {
        debugLog('user-prompt-submit', 'branch changed', { from: state.branch, to: currentBranch });
        state.branch = currentBranch;
        if (isConnectedMode() && state.sessionId && !state.sessionId.startsWith('local-')) {
          api.updateSession(state.sessionId, { branch: currentBranch }).catch(() => {});
        }
      }
    } catch {
      // non-fatal
    }

    // Cursor doesn't route its agent-transcript JSONL through
    // input.transcript_path, so store the discovered path in state — the
    // heartbeat reads state.transcriptPath to detect a stale (closed/idle)
    // conversation and end the session (Part A of robust session-end). Every
    // other agent already carries transcriptPath from input/discovery, so this
    // makes the universal transcript-mtime liveness signal work for Cursor too.
    if (agentSlug === 'cursor' && !state.transcriptPath) {
      try {
        const cursorId = state.agentSessionId || state.claudeSessionId;
        const tp = cursorId ? findCursorTranscriptJsonl(cursorId) : null;
        if (tp) {
          state.transcriptPath = tp;
          debugLog('user-prompt-submit', 'cursor transcript path stored for liveness', { tp });
        }
      } catch { /* non-fatal */ }
    }

    // Ensure session stays RUNNING (may have been auto-expired by listAllActiveSessions)
    state.status = 'RUNNING';
    saveSessionState(state, state.repoPath || hookCwd, state.sessionTag);
    debugLog('user-prompt-submit', 'prompt saved', { promptCount: state.prompts.length, sessionId: state.sessionId, tag: state.sessionTag });

    // ── Heartbeat: send incremental update to API on every prompt (connected mode only) ──
    // Not on a session-start reservation still being registered: the id is a
    // placeholder the server has never seen, so the PATCH and ping below 404,
    // and a daemon started on it would sit on the state file that session-start
    // is about to settle under the real id (it starts the daemon itself). The
    // prompt is on disk; Stop sends it once the id is real.
    const registrationInFlight = isPendingReservation(state) && isProvisionalSessionId(state.sessionId);
    if (registrationInFlight) {
      debugLog('user-prompt-submit', 'reservation still registering — no server update or daemon on the placeholder id', {
        sessionId: state.sessionId, tag: state.sessionTag, agentSlug,
      });
    }
    try {
      const config = loadConfig();
      if (config && isConnectedMode() && !registrationInFlight) {
        const durationMs = Date.now() - new Date(state.startedAt).getTime();

        // Try to parse transcript for live token/cost data
        let parsed: ParsedTranscript | null = null;
        let displayTranscript = '';
        try {
          if (state.transcriptPath) {
            parsed = parseTranscript(state.transcriptPath, { since: state.startedAt, repoRoots: sessionRepoRoots(state) });
            displayTranscript = formatTranscriptForDisplay(state.transcriptPath, { verbose: !!state.verboseCapture });
          }
        } catch {
          // Transcript may not be readable mid-session for all agents
        }

        // For Codex: try reading the rollout JSONL for full transcript + token data
        if ((agentSlug === 'codex' || (state as any).agentSlug === 'codex')) {
          try {
            const codexData = discoverCodexSessionData(state.repoPath || hookCwd, {
              verbose: !!state.verboseCapture,
              threadId: state.agentSessionId || state.claudeSessionId || undefined,
            });
            if (codexData) {
              if (!displayTranscript && codexData.transcript) displayTranscript = codexData.transcript;
              if (!parsed && codexData.tokensUsed > 0) {
                parsed = {
                  prompts: [], filesChanged: [], summary: '', transcript: '',
                  model: codexData.model, tokensUsed: codexData.tokensUsed,
                  inputTokens: codexData.inputTokens, outputTokens: codexData.outputTokens,
                  // Codex now splits cached prompt tokens out of input.
                  // Carry through so estimateCost can bill them at the
                  // model's cached rate ($0.50/M on gpt-5.5).
                  cacheReadTokens: codexData.cacheReadTokens ?? 0,
                  cacheCreationTokens: 0,
                  // OpenAI has no second cache tier, so there is nothing to split.
                  cacheCreation1hTokens: 0,
                  // Codex rollouts are read whole-file, so no turns precede.
                  promptIndexBase: 0,
                  toolCalls: 0,
                  subagentTokens: 0,
                  subagentEdits: [],
                  toolBreakdown: [],
                  filesRead: [],
                };
              }
              // Sync state.prompts from the rollout so the dashboard sees
              // every prompt — not just the ones our hook captured. Codex's
              // UserPromptSubmit hook is unreliable (auto-trust gating), so
              // mirroring the rollout is the only way to guarantee the
              // prompt list grows turn-by-turn.
              const rolloutPrompts = codexData.prompts || [];
              if (rolloutPrompts.length > state.prompts.length) {
                state.prompts = rolloutPrompts;
                debugLog('user-prompt-submit', 'synced state.prompts from Codex rollout', {
                  rolloutCount: rolloutPrompts.length,
                });
              }
            }
          } catch { /* best effort */ }
        }

        // For Gemini: auto-discover the chat checkpoint file mid-session so
        // heartbeats upload the assistant text + tool I/O instead of just
        // user prompts. Stop-hook does the same lookup; running it here too
        // means the Session tab shows real content while the session is
        // still RUNNING (not just after it ends).
        if (!displayTranscript && agentSlug === 'gemini') {
          try {
            if (!state.transcriptPath) {
              const discovered = discoverGeminiTranscriptPath({
                sessionId: state.agentSessionId || state.claudeSessionId || undefined,
              });
              if (discovered) {
                state.transcriptPath = discovered;
                debugLog('user-prompt-submit', 'gemini transcript auto-discovered', { discovered });
              }
            }
            if (state.transcriptPath && fs.existsSync(state.transcriptPath)) {
              parsed = parseTranscript(state.transcriptPath, { since: state.startedAt, repoRoots: sessionRepoRoots(state) });
              displayTranscript = formatTranscriptForDisplay(state.transcriptPath, { verbose: !!state.verboseCapture });
            }
          } catch { /* best effort */ }
        }

        // Synthesize transcript from captured prompts when no transcript file
        // exists. Interleave any assistant replies recorded on
        // state.promptResponses by the stop hook — otherwise a heartbeat that
        // fires after one prompt completes and another starts would push a
        // prompts-only transcript and clobber the response-rich one the
        // stop hook just persisted (mainly affects Gemini, whose transcript
        // file is unflushed mid-session so we depend on stop-hook captures).
        if (!displayTranscript && state.prompts.length > 0) {
          const turns: Array<{ role: string; content: string }> = [];
          if (state.agentSystemPrompt) {
            turns.push({ role: 'system', content: state.agentSystemPrompt });
          }
          const responses = state.promptResponses || [];
          for (let i = 0; i < state.prompts.length; i++) {
            turns.push({ role: 'user', content: state.prompts[i] });
            if (responses[i]) {
              turns.push({ role: 'assistant', content: responses[i] });
            }
          }
          displayTranscript = JSON.stringify(turns);
        }

        const model = parsed?.model || state.model;
        // Estimate tokens from prompt text when no transcript data exists (Codex, etc.)
        let hbInputTokens = parsed?.inputTokens || 0;
        let hbOutputTokens = parsed?.outputTokens || 0;
        let hbTokensUsed = parsed?.tokensUsed || 0;
        if (hbTokensUsed === 0 && state.prompts.length > 0) {
          const totalChars = state.prompts.reduce((sum, p) => sum + p.length, 0);
          hbInputTokens = Math.round(totalChars / 4);
          hbOutputTokens = hbInputTokens * 3;
          hbTokensUsed = hbInputTokens + hbOutputTokens;
        }
        const costUsd = hbTokensUsed > 0
          ? estimateCost(model, hbInputTokens, hbOutputTokens, parsed?.cacheReadTokens || 0, parsed?.cacheCreationTokens || 0, { cacheCreation1hTokens: parsed?.cacheCreation1hTokens || 0 })
          : 0;

        // Redact secrets from prompts
        const shouldRedact = config.secretRedaction !== false;
        const redactedPrompts = shouldRedact
          ? state.prompts.map(p => redactSecrets(p).redacted)
          : state.prompts;
        const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

        // Fire-and-forget — Codex's user-prompt-submit hook has a 10s budget,
        // and awaiting this network call here was making the hook time out.
        // Shadow commit + state-file write already happened earlier in this
        // hook, so the per-prompt baseline is captured before we return.
        //
        // DURABLE, though. This carries the turn's prompt text, transcript and
        // per-prompt diffs on the shared 8s timeout, and it aborts whenever the
        // API is slow or restarting — 72 times in this machine's hook log,
        // every one logged "background updateSession failed (non-fatal) {\"message\":
        // \"This operation was aborted\"}". The comment above used to say the
        // heartbeat re-sends the same payload, so nothing is lost; that is only
        // true while a heartbeat is running, and it is not true for the final
        // turn of a session or when the daemon is gone.
        //
        // durableUpdate persists a retriable failure to ~/.origin/queue and a
        // later hook replays it, draining that session's backlog in order
        // first. The machinery was built and tested for exactly this and never
        // wired to this call site. Still un-awaited, so the budget is untouched
        // — and the abort's catch is demonstrably reached, since it is what
        // writes those log lines.
        durableUpdate(state.sessionId, {
          prompt: joinedPrompt || undefined,
          transcript: displayTranscript || undefined,
          model: isSpecificModel(model) ? model : undefined,
          filesChanged: parsed?.filesChanged && parsed.filesChanged.length > 0 ? parsed.filesChanged : undefined,
          tokensUsed: hbTokensUsed > 0 ? hbTokensUsed : undefined,
          inputTokens: hbInputTokens > 0 ? hbInputTokens : undefined,
          outputTokens: hbOutputTokens > 0 ? hbOutputTokens : undefined,
          toolCalls: parsed?.toolCalls ? parsed.toolCalls : undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          costUsd: costUsd > 0 ? costUsd : undefined,
          status: 'RUNNING',
          // Send accumulated per-prompt diffs so they appear immediately on the platform
          promptChanges: state.completedPromptMappings && state.completedPromptMappings.length > 0
            ? state.completedPromptMappings.map(pm => {
                const dl = (pm.diff || '').split('\n');
                return {
                  ...pm,
                  promptText: (pm.promptText || '').slice(0, 1000),
                  diff: capDiff(pm.diff, MAX_PROMPT_DIFF_LEN),
                  linesAdded: dl.filter((l: string) => l.startsWith('+') && !l.startsWith('+++')).length,
                  linesRemoved: dl.filter((l: string) => l.startsWith('-') && !l.startsWith('---')).length,
                  // Mappings are numbered by SERVER row; ids are local.
                  ...(turnIdForServerRow(state, pm.promptIndex) && { turnId: turnIdForServerRow(state, pm.promptIndex) }),
                  ...captureStamp(),
                  aiPercentage: 100,
                  checkpointType: 'auto',
                };
              })
            : undefined,
        }, { supersedes: prePersisted }).catch((err: any) => {
          debugLog('user-prompt-submit', 'background updateSession failed (non-fatal)', { message: err?.message });
        });
        debugLog('user-prompt-submit', 'heartbeat dispatched (fire-and-forget)', { sessionId: state.sessionId, promptCount: state.prompts.length, costUsd, promptChanges: state.completedPromptMappings?.length || 0, payload: summarizePromptPayload(state.completedPromptMappings as any) });

        // Restart heartbeat daemon if it died (e.g., Mac sleep killed it)
        if (!isHeartbeatAlive(state.sessionId)) {
          const saveCwd = found?.saveCwd || hookCwd;
          const stateFile = getStatePath(saveCwd, state.sessionTag);
          startHeartbeat(state.sessionId, config.apiUrl || 'https://getorigin.io', config.apiKey, stateFile, agentSlug);
          debugLog('user-prompt-submit', 'heartbeat daemon restarted (was dead)', { sessionId: state.sessionId, agentSlug });
        }
      }
    } catch (err: any) {
      debugLog('user-prompt-submit', 'heartbeat error (non-fatal)', { message: err.message });
      // Non-fatal — don't block the agent
    }
  }

  // ── Output system message for agents that read it from beforeSubmitPrompt (e.g. Cursor) ──
  // Cursor doesn't reliably consume systemMessage from sessionStart, so we also
  // inject it here on every prompt submission.
  try {
    let systemMsg = '';

    // Auth-broken warning. If a recent API call hit 401 the api.ts
    // layer writes an auth-status.json sentinel; bubble that up as
    // the first line of the systemMessage so the agent surfaces it
    // in the user's conversation instead of letting every hook
    // silently fail in hooks.log forever.
    try {
      const authStatus = readAuthStatus();
      if (authStatus?.state === 'unauthorized') {
        systemMsg +=
          '\u26a0 Origin: Your CLI API key is no longer valid (server returned 401). ' +
          'Run `origin login` in another terminal to re-authenticate \u2014 until then, ' +
          'Origin is not capturing this session.\n\n';
      } else if (authStatus?.state === 'unreachable') {
        systemMsg +=
          '\u26a0 Origin: Could not reach the API on the last call' +
          (authStatus.message ? ` (${authStatus.message})` : '') +
          '. Sessions will resume once the server is reachable again.\n\n';
      }
    } catch { /* status read is best-effort */ }

    // Mid-session scoped soft-cap warning — the heartbeat persisted it
    // from a ping payload. Surface the amber banner in the conversation
    // ONCE per distinct reason (budgetWarnShownFor records delivery), so
    // a crossing mid-session is visible without nagging every prompt.
    if (state.budgetWarnReason && state.budgetWarnShownFor !== state.budgetWarnReason) {
      systemMsg += buildBudgetWarningBanner(state.budgetWarnReason) + '\n\n';
      state.budgetWarnShownFor = state.budgetWarnReason;
      try { saveSessionState(state, state.repoPath || hookCwd, state.sessionTag); } catch { /* re-shows next prompt */ }
    }

    if (state.agentSystemPrompt) {
      systemMsg += state.agentSystemPrompt + '\n\n';
    }
    systemMsg += 'Origin: Session tracking active \u2014 prompts, files, and tokens will be captured.';
    if (!isConnectedMode()) {
      systemMsg += ' (standalone mode)';
    }
    if (state.activePolicies && Array.isArray(state.activePolicies) && state.activePolicies.length > 0) {
      systemMsg += '\n\nActive policies for this session:\n' +
        state.activePolicies.map((p: string) => `- ${p}`).join('\n');
    }

    // Inject repo-level context.
    //
    // Normally just attribution — this runs on EVERY prompt, and the memory /
    // brief / handoff blocks are large enough that repeating them each turn
    // would burn context for no new information.
    //
    // But when this turn auto-created the session, no sessionStart hook fired,
    // so nothing has EVER injected the full block for this session. Cursor
    // makes that the common case, not the edge: it fires sessionStart about
    // once per app launch, so every chat after the first landed here and ran
    // blind to memory — the agent had the notes on disk and never read them.
    // Give that turn the same consolidated block handleSessionStart builds.
    const repoPath = state.repoPath || hookCwd;
    const safeCtx = (fn: () => string | null): string | null => { try { return fn(); } catch { return null; } };
    try {
      const conversationKey = lookupSessionId || input.session_id;
      if (sessionJustAutoCreated && fullContextAlreadyInjected(repoPath, conversationKey)) {
        // sessionStart already injected the full block into THIS conversation
        // (its state just wasn't found above, so this turn auto-created a
        // session). Re-sending it would put the same digest in the same context
        // window twice in one turn. Attribution still goes out below.
        const attributionCtx = buildAttributionContext(repoPath);
        if (attributionCtx) systemMsg += '\n\n' + attributionCtx;
        debugLog('user-prompt-submit', 'full repo context SKIPPED (already injected this conversation)', { conversationKey });
      } else if (sessionJustAutoCreated) {
        const repoContext = assembleRepoContext({
          brief: safeCtx(() => buildRepoBriefContext(repoPath)),
          attribution: safeCtx(() => buildAttributionContext(repoPath)),
          memory: safeCtx(() => buildMemoryBriefContext(repoPath)) || safeCtx(() => buildMemoryContext(repoPath)),
          memoryPointer: safeCtx(() => buildMemoryPointerContext(repoPath)),
          handoff: safeCtx(() => buildHandoffContext(repoPath)),
          // Only while it is still unanswered. The directive says "do this
          // BEFORE your first substantive action", which is a statement about
          // the START of a session — but nothing scoped it to one, so a
          // session that had already read its memory kept being told to read
          // it. That is how an agent ends up re-running `origin context
          // memory` on turn 6: a ~5k-token tool call to re-fetch a digest it
          // is already carrying, because the instruction never withdraws.
          //
          // `memoryChecked` is latched at pre-tool-use the moment this session
          // runs any memory-read command, and by the prompt-scoped retrieval
          // when it HANDS the agent the records — so its absence is real
          // evidence the ask is still outstanding, not a guess.
          startupCheck: state.memoryChecked ? null : safeCtx(() => buildStartupCheckContext(repoPath)),
        });
        if (repoContext) {
          systemMsg += '\n\n' + repoContext;
          recordFullContextInjection(repoPath, conversationKey);
          debugLog('user-prompt-submit', 'full repo context injected (session auto-created, no sessionStart)', {
            length: repoContext.length,
          });
        }
      } else {
        const attributionCtx = buildAttributionContext(repoPath);
        if (attributionCtx) {
          systemMsg += '\n\n' + attributionCtx;
        }
      }
    } catch {}

    // ── Retrieve what THIS prompt needs ──────────────────────────────────
    // Everything above is a fixed slice chosen before the task was known. This
    // searches the notes with the prompt itself and injects the records that
    // match, which is the difference between telling the agent memory exists
    // and putting the relevant part of it in front of them. Deterministic and
    // local — no LLM, no network; it runs on every prompt with a user waiting.
    //
    // Runs regardless of which branch above fired: on a session-start turn the
    // digest is a summary of RECENT work, and a task-scoped hit on a six-month-
    // old session is exactly the record that digest left out.
    try {
      const scoped = buildPromptScopedMemoryContext(repoPath, prompt, state.memoryHitsInjected || []);
      if (scoped) {
        systemMsg += '\n\n' + scoped.block;
        state.memoryHitsInjected = [...(state.memoryHitsInjected || []), ...scoped.keys];
        // The agent has now been HANDED the memory, so it has no outstanding
        // instruction to go and read it — leaving the nudge armed would chase a
        // session that already has what the nudge asks for.
        state.memoryChecked = true;
        try { saveSessionState(state, state.repoPath || hookCwd, state.sessionTag); } catch { /* re-injects next prompt */ }
        debugLog('user-prompt-submit', 'prompt-scoped memory injected', { hits: scoped.keys.length, keys: scoped.keys });
      }
    } catch { /* best-effort — retrieval must never break the turn */ }

    // ── Escalate when the startup check was ignored ───────────────────────
    // The directive injected at session start is a request, and a request with
    // no follow-up is indistinguishable from a suggestion. `memoryChecked` is
    // set at pre-tool-use the moment this session runs any memory-read command,
    // so its absence after a completed turn is real evidence the agent never
    // looked — not a guess.
    //
    // From the SECOND prompt on, so the agent gets one whole turn (its tool
    // calls included) to comply before being nudged; on the first prompt the
    // directive is still unanswered rather than ignored. Once per session:
    // an agent that judged memory irrelevant to its task has made a legitimate
    // call, and repeating this every prompt would be the nagging that makes
    // injected guidance get tuned out wholesale.
    try {
      if (!state.memoryChecked && !state.memoryNudged && (state.prompts?.length || 0) >= 2) {
        const escalation = buildMemoryEscalationContext(repoPath);
        if (escalation) {
          systemMsg += '\n\n' + escalation;
          state.memoryNudged = true;
          try { saveSessionState(state, state.repoPath || hookCwd, state.sessionTag); } catch { /* re-nudges next prompt */ }
          debugLog('user-prompt-submit', 'memory escalation injected', { prompts: state.prompts?.length });
        }
      }
    } catch { /* best-effort — a nudge must never break the turn */ }

    if (systemMsg) {
      const payload = buildContextInjectionPayload(agentSlug, 'UserPromptSubmit', systemMsg);
      if (payload) process.stdout.write(payload);
      debugLog('user-prompt-submit', 'context injected', { agent: agentSlug, length: systemMsg.length });
    }
  } catch (sysErr: any) {
    debugLog('user-prompt-submit', 'systemMessage injection failed (non-fatal)', { message: sysErr.message });
  }
}

/**
 * Note any other live session writing into this same working tree.
 *
 * Recorded on the session rather than acted on: sharing a checkout is a normal
 * thing to do, and the point is that a turn captured under contention is a
 * weaker claim than one captured alone. Presenting both with the same
 * confidence is what let a sibling's work sit under this session's prompts for
 * an entire evening without anything looking wrong.
 *
 * Origin cannot fix this by being cleverer — no observation available to it
 * says which of two processes wrote a byte. It can only be honest about it,
 * and point at the arrangement that removes the ambiguity.
 */
export function noteCheckoutContention(state: SessionState): boolean {
  try {
    const tree = currentSessionWorkTree(state) || state.repoPath || '';
    if (!tree) return false;
    const peers = listActiveSessions(tree).map((p: any) => ({
      sessionId: p.sessionId,
      agentSlug: p.agentSlug,
      repoPath: p.repoPath,
      lastCwd: p.lastCwd,
      status: p.status,
      lastSeenMs: (() => {
        try { return fs.statSync(p.__statePath).mtimeMs; } catch { return undefined; }
      })(),
    }));
    const report = detectContention(state, tree, peers);
    if (!report.contested) return false;

    const ids = new Set(state.contendingSessionIds || []);
    let added = false;
    for (const p of report.peers) if (!ids.has(p.sessionId)) { ids.add(p.sessionId); added = true; }
    if (!added) return false;
    state.contendingSessionIds = [...ids];
    debugLog('contention', 'sharing this checkout with other live sessions', {
      tree, peers: report.peers.map((p) => p.sessionId), advice: contentionAdvice(report),
    });
    return true;
  } catch {
    return false;
  }
}

// Snapshot this turn's baseline inside the worktree, when the session is in
// one. Best-effort: without it the window falls back to the main checkout's
// pair, which is the old (under-capturing but self-consistent) behaviour.
export function recordWorkTreeBaseline(state: SessionState, hookCwd: string): void {
  try {
    const wt = sessionWorkTree(state.repoPath, state.lastCwd || hookCwd, {
      gitRoot: getWorkingGitRoot,
      gitCommonDir: getGitCommonDir,
    });
    // samePath, not ===: on Windows git answers with forward slashes and
    // repoPath carries backslashes, so === would call the main checkout a
    // worktree and anchor a pointless second baseline every turn.
    if (!wt || samePath(wt, state.repoPath)) { state.prePromptWorkTree = null; return; }
    const tag = `${state.sessionTag || state.sessionId.slice(0, 12)}-wt`;
    const sha = createShadowCommit(wt, `prompt-${tag}`) || getHeadSha(wt);
    if (!sha) { state.prePromptWorkTree = null; return; }
    state.prePromptWorkTree = { path: wt, sha, promptIndex: state.prompts?.length || 0 };
    debugLog('user-prompt-submit', 'worktree baseline anchored', {
      workTree: wt, sha: sha.slice(0, 12), promptIndex: state.prompts?.length || 0,
    });
  } catch (err: unknown) {
    state.prePromptWorkTree = null;
    debugLog('user-prompt-submit', 'worktree baseline failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
