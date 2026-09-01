import { loadConfig, saveConfig, loadAgentConfig, saveAgentConfig, loadRepoConfig, isConnectedMode, ensureConfigDir } from '../config.js';
import { isRepoIgnored, matchIgnoredRepo } from '../ignore-repos.js';
import { decidePushBlock } from '../push-block.js';
import crypto from 'crypto';
import { detectTools } from '../tools-detector.js';
import { api, readAuthStatus } from '../api.js';
import { isSkippedScanPath, isNonSecretAssignmentValue } from '../secret-rules.js';
import { parseTranscript, estimateCost, formatTranscriptForDisplay, extractPromptFileMappings, extractPromptImages, setActivePricing, readCopilotModel, stripCopilotEnvelopes, scopeCapturedPath, buildDiffFromEdits } from '../transcript.js';
import { findDuplicateStateForSession, carryForwardTurnState, findSameTagStateForResume, preferRicherSameSessionState } from '../session-dedup.js';
import {
  saveSessionState,
  loadSessionState,
  clearSessionState,
  findSessionByClaudeId,
  listActiveSessions,
  isSessionAlive,
  markSessionEnded,
  listAllActiveSessions,
  getGitDir,
  getGitRoot,
  getWorkingGitRoot,
  getGitCommonDir,
  getCanonicalRepoPath,
  gitDirFilePath,
  discoverGitRoot,
  discoverAllGitRoots,
  getHeadSha,
  getBranch,
  resolveSessionBranch,
  startHeartbeat,
  stopHeartbeat,
  isHeartbeatAlive,
  getStatePath,
  reconcilePromptHistory,
  homePromptIndexByText,
  promptHistoryFromPriorState,
  type SessionState,
  type ToolCallRecord,
  currentTurnIndex,
  closeTurn,
  recordPromptShadow,
  turnBaseline,
} from '../session-state.js';
import { capCommitMessage, captureGitState, captureAgyDiff, getDirtyFiles, createShadowCommit, commitDiffScopedToPrompt, filesChangedSinceShadow, readFileAtRev, MAX_PROMPT_DIFF_LEN } from '../git-capture.js';
import { finalHunksForCaptures } from '../final-state-blame.js';
import { parseAntigravityTranscript, estimateAntigravityUsage, agyArgs } from '../antigravity-transcript.js';
import { claudeSessionName, cursorSessionName } from '../agent-session-name.js';
import { outOfRepoWrites, samePath as samePathNormalized, isInsideRepo as isInsideRepoNormalized } from '../paths.js';

/**
 * The agent's own name for this conversation, or null when the agent doesn't
 * name conversations.
 *
 * Deliberately slug-gated rather than "try every extractor": Devin and Cursor
 * both fire claude-code's hooks (see the dual-hook handling elsewhere in this
 * file), so a slug-blind claudeSessionName() would read a Claude transcript
 * that has nothing to do with a Cursor chat and title it wrongly. Silence is
 * correct for anything not listed.
 */
function resolveAgentSessionName(state: SessionState): string | null {
  switch (state.agentSlug) {
    case 'claude-code':
      return claudeSessionName(state.transcriptPath);
    case 'cursor':
      return cursorSessionName(state.agentSessionId || '', querySqlite);
    default:
      return null;
  }
}
import { backfillCodexPromptMappings } from '../codex-prompt-mapping.js';
import { buildCodexThreadByCwdQuery } from '../codex-thread-query.js';
import {
  durableUpdateSession, durableEndSession, drainUpdateQueue,
  enqueueFailedUpdate, isRetriableApiError,
} from '../update-queue.js';
import { debugLog } from '../debug-log.js';
import {
  listRecentShas,
  backfillUnknownCommits,
  shouldAdvertiseHistory,
  writeSyncMarker,
  acquireBackfillLock,
  releaseBackfillLock,
  extractCommitDiff,
  mergeOwnDiff,
  mergeAbsorbedFiles,
  commitChangedFiles,
  syncRepoHistory,
  shouldSyncStandalone,
  hasFreshFailedAttempt,
  RECENT_SHAS_LIMIT,
  BACKFILL_TIMEOUT_MS,
  COMMIT_INGEST_TIMEOUT_MS,
} from '../history-backfill.js';
import {
  discoverCodexSessionData, findCodexRolloutPath, readCodexRolloutFile,
  getCodexPromptsTimeline, parseCodexRollout, isCodexInternalSubroutine,
  isKnownCodexInternalPrompt, findCodexRolloutByCwd,
  type PromptTimelineEntry, type CodexSessionData,
} from '../agents/codex.js';
import { maybeAutoSyncBenchmark } from '../benchmark-auto-sync.js';
import { readGeminiModel, discoverGeminiTranscriptPath, getGeminiPromptsTimeline } from '../agents/gemini.js';
import { getCursorModelFromDb, findCursorTranscriptJsonl, discoverCursorTranscript, type CursorTranscriptData } from '../agents/cursor.js';
// Re-exported: tests and external callers import these from hooks historically.
export { parseCodexRollout, isCodexInternalSubroutine } from '../agents/codex.js';
import {
  isSpecificModel, sessionMatchesAgent, isCodexLikeModel,
  attributionPgrepChecks, standalonePgrepChecks, resolveAgentDisplayName,
} from '../agents/registry.js';
import { isProcessRunning, uniqueMatchingId } from '../utils/process-detect.js';
import { ensureSqlite, querySqlite } from '../utils/sqlite.js';
import { attachOrphanCommitFiles } from '../prompt-completeness.js';
import { writeSessionFiles, pushSessionBranch, type PromptEntry, type PromptChange, type SessionWriteData } from '../local-entrypoint.js';
import { writeGitNotes, shouldIncludePromptText, syncNotesFromRemoteThrottled, syncNotesForSessionStart, pushMemoryNotes, pushAcceptanceNotes, foldStagedNotes, resolvePushRemote, type PromptNoteEntry } from '../git-notes.js';
import { parseMarkersFromTranscript, parseMarkersFromTranscriptPath, type OriginMarkers } from '../origin-markers.js';
import { redactSecrets } from '../redaction.js';
import { makeSyncBlock } from '../sync-block.js';
import { buildAttributionContext, buildFileAttributionContext } from '../attribution.js';
import { readDevinDesktopSessions, selectDevinSessionForRepo, type DevinDesktopSession } from '../devin-desktop.js';
import { discoverDevinCliSessionDataByPrompt, retagDevinFromProcess } from '../devin-cli.js';
import { queueDevinBackfill, drainDevinBackfills } from '../devin-backfill.js';
import { readDevinLiveSession } from '../devin-sessions-db.js';
import { maybeSyncDevinDesktop } from './devin.js';
import { writeHandoff, buildHandoffContext, extractTodosFromPrompts, handoffRepresentsWork } from '../handoff.js';
import { assembleRepoContext } from '../context-injection.js';
import { editSourceForAgent } from '../prompt-capture/types.js';
import { synthesizeSessionSummary, memorySummaryMode } from '../session-summary.js';
import { writeSessionMemory, writeCommitMemory, enrichDecisionsForSession, buildMemoryContext, buildMemoryPointerContext, buildStartupCheckContext, buildMemoryEscalationContext, buildPromptScopedMemoryContext, isMemoryReadCommand, isMemoryReadToolName, readRecentMemory, readAllSessionMemory, memoryUpdateTrigger, shouldWriteMemoryOnCommit, shouldWriteMemoryOnSessionEnd, summarizeFromCommitSubjects, isSubstantiveMemory, buildMemoryBriefContext, readMemoryBrief, writeMemoryBrief, memoryBriefSignature, type SessionMemoryEntry } from '../memory.js';
import { buildRepoBriefContext, maybeSpawnBriefGeneration } from '../repo-brief.js';
import { backfillAcceptanceForSession } from '../acceptance.js';
import { addTodosFromSession } from '../todo.js';
import {
  capturePromptEdits,
  dropOutOfRepoEdits,
  extractEditsFromToolCall,
  anchorEditPositions,
  backfillWriteBaselines,

  buildCapturesFromLedger,
  mergeLedgerWithTranscript,
} from '../prompt-capture/index.js';
import type { PromptCapture, PromptEdit } from '../prompt-capture/index.js';
import {
  isShellTool,
  shellCommandText,
  commandWritesFiles,
  shellWindowEdits,
  SHELL_WINDOW_SOURCE,
} from '../shell-write-capture.js';
import { isOriginAutoManagedPath, shouldIgnoreFile } from '../ignore-patterns.js';
import { normalizeToolHookPayload } from '../hook-payload.js';
import {
  listMirroredSessionsForTree,
  preferRegisteredSessionId,
  isPendingReservation,
  sessionTagFor,
} from '../session-state.js';
import { sessionWorkTree, shellWindowTarget, samePath, candidateDirsFromCommand, worktreesAmongCandidates } from '../session-worktree.js';
import { probeTree, touchedSince, type TreeProbe } from '../shell-command-probe.js';
import { readJournal, compactJournal, startWriteJournal } from '../write-journal-watch.js';
import { detectContention, contentionAdvice } from '../checkout-contention.js';
import { filesWrittenDuring } from '../write-journal.js';
import { parseSessionLimits, buildDurationBlockMessage, sendDesktopNotification } from '../session-limits.js';
import {
  BUDGET_BLOCKING_AGENTS,
  writeBudgetLockNotice,
  clearBudgetLockNotice,
  buildBudgetBanner,
  buildBudgetWarningBanner,
} from '../budget-breach.js';
import { createSnapshot, condenseSnapshot, listSnapshots, condenseAndCleanupSession, cleanupSessionShadowBranch, type SnapshotMeta } from './snapshot.js';
import { execFileSync, spawn } from 'child_process';
import { toRepoRelative } from '../transcript-watch.js';
import { countDiffLines } from '../transcript-adapters.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as fzstd from 'fzstd';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the tree SHA that represents the WORKING TREE state right now,
 * not just HEAD's committed tree. For Cursor mid-turn prompts the agent
 * edits files in the IDE without committing — `HEAD^{tree}` then points
 * at the pre-edit state, and the Restore button in the UI ends up with
 * no usable tree ref.
 *
 * `git stash create` writes the working tree to the object store as a
 * commit (without touching the stash list or the working tree itself).
 * Its tree IS the dirty working-tree state. Returns null when the tree
 * is clean (stash create returns empty) and we fall back to HEAD's
 * tree — same SHA the legacy code path would have used.
 */
function getWorkingTreeSha(repoPath: string): string | null {
  const HEX = /^[a-f0-9]{40}$/;
  try {
    const stashSha = execFileSync('git', ['stash', 'create'], {
      windowsHide: true,
      cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (stashSha && HEX.test(stashSha)) {
      const treeSha = execFileSync('git', ['rev-parse', `${stashSha}^{tree}`], {
        windowsHide: true,
        cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (HEX.test(treeSha)) return treeSha;
    }
  } catch { /* fall through to HEAD's tree */ }
  try {
    const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      windowsHide: true,
      cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (HEX.test(headTree)) return headTree;
  } catch { /* ignore */ }
  return null;
}

// ─── Debug Logger ─────────────────────────────────────────────────────────

// (debug logger moved to ../debug-log.ts — imported above)
// Durable upload wrappers (update-queue.ts) bound to this file's debugLog.
// On a retriable API failure the payload is persisted to ~/.origin/queue/
// and replayed by a later hook — capture data is never silently lost.
const durableUpdate = (sessionId: string, data: any) =>
  durableUpdateSession(sessionId, data, (e, m, d) => debugLog(e, m, d));
const durableEnd = (sessionId: string, data: any) =>
  durableEndSession(sessionId, data, (e, m, d) => debugLog(e, m, d));

/**
 * Detect whether a process matching a registry pgrep pattern is running,
 * filtering out our own process tree to avoid false positives when the
 * pattern appears in our own argv. Cross-platform (pgrep on Unix, Win32_Process
 * command-line scan on Windows) — see utils/process-detect.ts.
 *
 * Accepts either a bare pattern or a legacy `pgrep -f "…"` command string
 * (what the registry stores), so existing call sites pass their `.cmd` verbatim.
 */
function safePgrep(pgrepCmd: string): boolean {
  return isProcessRunning(pgrepCmd);
}

/**
 * The ONE agent whose process pattern matches, or null when zero or several do.
 * Abstaining on ambiguity is deliberate — see uniqueMatchingId.
 */
function uniquePgrepMatch(
  checks: Array<{ cmd: string; id: string }>,
  logScope: string,
): string | null {
  const { id, matched } = uniqueMatchingId(checks, safePgrep);
  if (!id && matched.length > 1) {
    debugLog(logScope, 'multiple agent processes running — not guessing', { matched });
  }
  return id;
}

// ─── Diff Filtering ─────────────────────────────────────────────────────
// Filter a unified diff to exclude files that were already dirty before the prompt.

export function filterUncommittedDiff(diffText: string, prePromptDirtyFiles: string[]): string {
  if (!diffText || prePromptDirtyFiles.length === 0) return diffText;
  const excludeSet = new Set(prePromptDirtyFiles);
  // Split on diff boundaries, keeping the delimiter
  const parts = diffText.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  for (const part of parts) {
    const match = part.match(/^diff --git a\/(.*?) b\//);
    if (match && match[1] && excludeSet.has(match[1])) continue;
    kept.push(part);
  }
  return kept.join('').trim();
}

/**
 * Scope an Antigravity per-prompt capture to files THIS session actually EDITED,
 * dropping concurrent-agent dirt.
 *
 * A read-only agy turn (no tool call) is seen only by the watcher, which is
 * barred from refreshing the per-prompt baseline — so captureAgyDiff diffs a
 * STALE end-of-previous-prompt shadow against the live tree. In a working tree
 * shared with OTHER agents, an untracked file a DIFFERENT agent just created then
 * surfaces as this turn's work (the "did you commit it?" question showing
 * "+22 lines, 1 file" of a file it never touched). `filesEditedAbs` are the
 * ABSOLUTE paths this conversation's transcript records it editing/writing (never
 * another agent's files); `filesChanged`/`diff` are repo-relative from
 * captureAgyDiff. Any changed file not in the session's edited set is dropped from
 * the diff and the line counts are recomputed from what remains.
 *
 * No-op when the session recorded no edits (a parser miss must never zero a real
 * turn) or when nothing foreign is present.
 */
export function scopeAgyDiffToSessionEdits(
  repoPath: string,
  filesChanged: string[],
  diff: string,
  linesAdded: number,
  linesRemoved: number,
  filesEditedAbs: string[],
): { filesChanged: string[]; diff: string; linesAdded: number; linesRemoved: number; dropped: string[] } {
  const unchanged = { filesChanged, diff, linesAdded, linesRemoved, dropped: [] as string[] };
  const editedRel = new Set<string>();
  for (const abs of (filesEditedAbs || [])) {
    if (typeof abs !== 'string' || !abs) continue;
    const rel = path.relative(repoPath, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) editedRel.add(rel);
  }
  if (editedRel.size === 0 || filesChanged.length === 0) return unchanged;
  const dropped = filesChanged.filter((f) => !editedRel.has(f));
  if (dropped.length === 0) return unchanged;
  const keptFiles = filesChanged.filter((f) => editedRel.has(f));
  const keptDiff = filterUncommittedDiff(diff, dropped);
  let a = 0, r = 0;
  for (const l of keptDiff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) a++;
    else if (l.startsWith('-') && !l.startsWith('---')) r++;
  }
  return { filesChanged: keptFiles, diff: keptDiff, linesAdded: a, linesRemoved: r, dropped };
}

export interface AgyPromptCorrection {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  diff: string;
  uncommittedDiff: string;
  linesAdded: number;
  linesRemoved: number;
  authoritative: true;
  dropped: string[];              // the foreign files removed (for reporting)
  commitSha?: string;
  createdAt?: number;
}

/**
 * Backfill helper: given a session's STORED promptChanges and the ABSOLUTE paths
 * this agy conversation actually EDITED (from its transcript), compute the
 * authoritative per-prompt corrections needed to retroactively drop
 * concurrent-agent dirt that a stale watcher baseline swept in before the fix
 * shipped. Applies the same scoping as the live path (scopeAgyDiffToSessionEdits)
 * to each prompt and returns ONLY the prompts that actually shed a file, so the
 * caller writes the minimum. PURE (no IO) — the backfill script does the IO.
 *
 * `filesChanged` on a stored promptChange may be an array or a JSON string
 * (the server serializes it), so both are accepted.
 */
export function computeAgySessionCorrections(
  promptChanges: Array<{ promptIndex: number; promptText?: string; filesChanged?: unknown; diff?: string; linesAdded?: number; linesRemoved?: number; commitSha?: string | null; createdAt?: number }>,
  filesEditedAbs: string[],
  repoPath: string,
): AgyPromptCorrection[] {
  const asArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } }
    return [];
  };
  const out: AgyPromptCorrection[] = [];
  for (const pc of (promptChanges || [])) {
    const files = asArray(pc.filesChanged);
    if (files.length === 0) continue;
    const scoped = scopeAgyDiffToSessionEdits(repoPath, files, pc.diff || '', pc.linesAdded || 0, pc.linesRemoved || 0, filesEditedAbs);
    if (scoped.dropped.length === 0) continue;   // nothing foreign on this prompt
    out.push({
      promptIndex: pc.promptIndex,
      promptText: pc.promptText || '',
      filesChanged: scoped.filesChanged,
      diff: scoped.diff,
      // A committed prompt is no longer uncommitted; an uncommitted one keeps its
      // (now-scoped) diff. Mirrors the live path's uncommittedDiff derivation.
      uncommittedDiff: pc.commitSha ? '' : scoped.diff,
      linesAdded: scoped.linesAdded,
      linesRemoved: scoped.linesRemoved,
      authoritative: true,
      dropped: scoped.dropped,
      ...(pc.commitSha ? { commitSha: pc.commitSha } : {}),
      ...(typeof pc.createdAt === 'number' ? { createdAt: pc.createdAt } : {}),
    });
  }
  return out;
}

export interface AgyEmptyTurnRepair {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  diff: string;
  uncommittedDiff: string;
  linesAdded: number;
  linesRemoved: number;
  authoritative: true;
  // The ground-truth capture record. The read path renders a turn from THIS
  // (synthesizePromptDiff), not from a hand-rolled diff string — see below.
  editsJson: string;
  commitSha?: string;
  createdAt?: number;
}

/**
 * Backfill helper for turns captured as EMPTY by the pre-#1226 agy path.
 *
 * When agy ran in its own worktree, capture diffed the canonical checkout —
 * a tree that never saw the edit — so the turn stored 0 files / +0 −0. Nothing
 * on the read side can heal that: the diff was never taken. But the transcript
 * still holds the edits WITH their content (write_to_file → CodeContent,
 * replace_file_content → TargetContent/ReplacementContent), so the turn can be
 * reconstructed from `promptEditRecords` — the same records the live path feeds
 * to buildDiffFromEdits.
 *
 * FILL-ONLY, deliberately. A prompt is repaired only when it RENDERS NOTHING
 * — both diff columns empty — and the transcript recorded edits for it. A
 * prompt that renders real content is never touched, so re-running this can't
 * degrade a good row, and a prompt the parser has no records for is left alone
 * rather than zeroed (absence of records is "unknown", not "nothing happened").
 *
 * The emptiness test is the DIFF, not `filesChanged`. A row can carry a file
 * list and still render "(no diff captured)" with +0/-0 — that is precisely the
 * half-repaired state a files-only backfill leaves behind, and keying on
 * filesChanged would make those rows permanently unrepairable. The read path
 * synthesizes the rendered diff from editsJson, so an empty diff here really
 * does mean nothing is on screen.
 *
 * PURE (no IO) — the backfill script does the IO.
 */
export function computeAgyEmptyTurnRepairs(
  promptChanges: Array<{ promptIndex: number; promptText?: string; filesChanged?: unknown; diff?: string; uncommittedDiff?: string; commitSha?: string | null; createdAt?: number }>,
  promptEditRecords: Array<Array<{ file: string; toolName: string; input: Record<string, unknown> }>>,
  workRoot: string,
): AgyEmptyTurnRepair[] {
  const asArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } }
    return [];
  };
  const out: AgyEmptyTurnRepair[] = [];
  for (const pc of (promptChanges || [])) {
    // Only fill blanks — never overwrite a turn that renders something.
    if ((pc.diff || '').trim()) continue;
    if ((pc.uncommittedDiff || '').trim()) continue;
    const records = promptEditRecords[pc.promptIndex] || [];
    if (records.length === 0) continue;   // no evidence → leave as-is

    // Rebuild against repo-relative paths so the stored files match what every
    // read surface (AI Blame, file lists, commit overlap) expects. An edit that
    // escaped the worktree is dropped rather than stored as an absolute path.
    const rel: Array<{ file: string; toolName: string; input: Record<string, unknown> }> = [];
    const files = new Set<string>();
    for (const r of records) {
      const p = path.relative(workRoot, r.file);
      if (!p || p.startsWith('..') || path.isAbsolute(p)) continue;
      const norm = p.split(path.sep).join('/');
      rel.push({ ...r, file: norm });
      files.add(norm);
    }
    if (rel.length === 0) continue;

    // Emit `editsJson`, NOT a hand-rolled diff string.
    //
    // The obvious move is to store buildDiffFromEdits() output in `diff`, and
    // it silently does not work. Reproduced twice against prod: PATCH a turn
    // with a well-formed diff built by that helper, and it reads back with
    // `diff` EMPTY while filesChanged and linesAdded persist — the turn then
    // renders "1 file changed +0 -0 … (no diff captured)". The write reports
    // success; only the screen is wrong, which is why this needs saying.
    //
    // The exact mechanism is NOT established. The first guess — that the
    // helper's placeholder `@@ @@` hunk header defeats the read path's line
    // scanners — is wrong: `countByFile` only requires a line starting with
    // `@@`, and `extractByFile` does not need a hunk header at all. Whatever
    // blanks it lives elsewhere in the session-detail read path, and the
    // control trial (same diff, real hunk header) was never completed because
    // prod started timing out. Do not repeat the "it's the @@ @@" claim
    // without running that trial.
    //
    // editsJson sidesteps the question: it is the first-class capture record,
    // the server synthesizes the rendered diff from it (synthesizePromptDiff)
    // with real hunk headers, and a non-empty edits array marks the row
    // authoritative on its own. Verified rendering correctly in the browser.
    const edits = rel.map((r) => ({
      file: r.file,
      op: r.toolName === 'Write' ? 'write' : 'edit',
      oldContent: r.toolName === 'Write' ? '' : String(r.input.old_string ?? ''),
      newContent: r.toolName === 'Write' ? String(r.input.content ?? '') : String(r.input.new_string ?? ''),
      source: 'transcript',
      // The transcript recorded the tool call itself, so the write was
      // OBSERVED — never the weaker `turn_window` guess.
      evidence: 'tool_call',
    }));

    // Line counts still come from the unified diff, which is the honest count
    // of changed lines; it is used for the numbers only, never stored.
    const counted = buildDiffFromEdits(rel as Array<{ file: string; toolName: string; input: Record<string, any> }>);
    if (!counted.trim()) continue;
    let linesAdded = 0, linesRemoved = 0;
    for (const l of counted.split('\n')) {
      if (l.startsWith('+') && !l.startsWith('+++')) linesAdded++;
      else if (l.startsWith('-') && !l.startsWith('---')) linesRemoved++;
    }
    out.push({
      promptIndex: pc.promptIndex,
      promptText: pc.promptText || '',
      filesChanged: [...files],
      diff: '',
      uncommittedDiff: '',
      linesAdded,
      linesRemoved,
      authoritative: true,
      editsJson: JSON.stringify({ edits }),
      ...(pc.commitSha ? { commitSha: pc.commitSha } : {}),
      ...(typeof pc.createdAt === 'number' ? { createdAt: pc.createdAt } : {}),
    });
  }
  return out;
}

// FIX 3 — SESSION-LEVEL pre-existing-dirt exclusion.
//
// The per-prompt path already drops files that were dirty before a turn (the
// #822 fix). The session-level snapshot (built at Stop for Codex/Cursor/Gemini)
// is a SEPARATE gitCapture, and its shadow branch can hand back a raw
// working-tree diff that never went through the file-level dirt filter — so
// pre-existing uncommitted files a PRIOR session left in the tree (leftover
// fixtures like eight-rows.txt / thirty-two-rows.txt) could resurface and make a
// READ-ONLY "check whats in this repo" turn falsely report N files / +M lines.
//
// Drop every file that was ALREADY dirty at SESSION START and that this session
// never recorded touching. A file the session actually changed appears in some
// prompt mapping's filesChanged, so it is NOT excluded (its real work is kept);
// when that file was ALSO dirty at start, the caller's line-level shadow scoping
// has already trimmed it to only this session's lines. A chat-only / read-only
// turn touches nothing → all pre-existing dirt is dropped → 0 files / 0 lines.
export function excludeUntouchedSessionStartDirt(
  diff: string,
  sessionStartDirtyFiles: string[] | undefined,
  promptMappings: Array<{ filesChanged?: string[] }>,
): string {
  if (!diff) return diff;
  const touchedBySession = new Set<string>();
  for (const m of promptMappings) {
    for (const f of (m.filesChanged || [])) touchedBySession.add(f);
  }
  const exclude = (sessionStartDirtyFiles || []).filter((f) => !touchedBySession.has(f));
  return exclude.length > 0 ? filterUncommittedDiff(diff, exclude) : diff;
}

// Files we should NEVER attribute to this session in uncommitted-diff output:
// the union of (a) what was dirty at THIS prompt's baseline, (b) what was
// dirty when the session started, and (c) what ANOTHER concurrently-running
// session has touched (committed or uncommitted) that we have NOT touched
// ourselves. Per-prompt state (a) gets zeroed by the shadow trick on each
// prompt boundary; (b) survives the whole session; (c) is the mid-session
// concurrent-agent isolation — a file Agent B starts editing while Agent A
// is alive shouldn't leak into A's uncommittedDiff just because both
// sessions watch the same working tree.
// Build the per-prompt attribution rows that go inside the git note.
// One entry per prompt that produced ANY captured work this session.
// Pulls text from state.prompts, files/timestamp from
// state.completedPromptMappings (set by the stop hook for each turn),
// and agent/model from the session-level state — these don't change
// per prompt. Capped + redacted inside writeGitNotes; here we just
// build the raw shape.
// Compact, metadata-only summary of the session's REAL sub-agent spawns (Task
// tool) for the git note + API update payload: the configured type, the parent
// turn each ran under, and — when the parsed transcript is available — the files
// each sub-agent edited. Files are attributed by EXECUTION-TIME WINDOW (a
// sidechain edit belongs to the spawn whose [startedAt, endedAt] contains its
// timestamp): exact for sequential sub-agents, ambiguous only for truly
// parallel ones. No prompt text. Empty array → callers send undefined.
export function buildSubagentSummary(
  state: SessionState,
  parsed?: { subagentEdits?: Array<{ file: string; ts: number }> },
): Array<{ type: string | null; promptIndex: number; files?: string[] }> | undefined {
  const spawns = state.subagentSpawns || [];
  if (spawns.length === 0) return undefined;
  const edits = parsed?.subagentEdits || [];
  return spawns.map((s) => {
    const start = Date.parse(s.startedAt) || 0;
    const end = s.endedAt ? (Date.parse(s.endedAt) || Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const files = start && edits.length
      ? [...new Set(edits.filter((e) => e.ts >= start && e.ts <= end).map((e) => e.file))].slice(0, 50)
      : [];
    return { type: s.subagentType, promptIndex: s.promptIndex, ...(files.length ? { files } : {}) };
  });
}

function buildPromptNoteEntries(
  state: SessionState,
  agentSlug: string | undefined,
  model: string | undefined,
  editsByIndex?: Map<number, string> | null,
): PromptNoteEntry[] {
  const out: PromptNoteEntry[] = [];
  const mappings = state.completedPromptMappings || [];
  const prompts = state.prompts || [];
  const seen = new Set<number>();
  // Walk completedPromptMappings first (has files for each prompt that
  // actually touched the working tree), then add chat-only prompts from
  // state.prompts so the note records every turn. Author info is at
  // session level (already in commit's Co-Authored-By trailer) so we
  // don't repeat it per-entry. editsJson + tree/commit refs are pulled
  // from the same maps the stop hook populates; lets a different Origin
  // org pulling notes drive AI Blame via LCS replay instead of having
  // to fall back to block-matching pc.diff.
  for (const m of mappings) {
    if (seen.has(m.promptIndex)) continue;
    seen.add(m.promptIndex);
    out.push({
      index: m.promptIndex,
      text: m.promptText || prompts[m.promptIndex] || '',
      agent: agentSlug || state.agentSlug,
      model,
      files: m.filesChanged && m.filesChanged.length > 0 ? m.filesChanged : undefined,
      editsJson: editsByIndex?.get(m.promptIndex) || undefined,
      treeSha: (m as any).treeSha || undefined,
      commitSha: (m as any).commitSha || undefined,
    });
  }
  for (let i = 0; i < prompts.length; i++) {
    if (seen.has(i)) continue;
    if (!prompts[i]) continue;
    out.push({
      index: i,
      text: prompts[i],
      agent: agentSlug || state.agentSlug,
      model,
      editsJson: editsByIndex?.get(i) || undefined,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * How recently another session must have been seen for its files to subtract
 * from ours. A state file is rewritten on every hook fire, so its mtime is a
 * live-ness proxy.
 *
 * Bounded because `listActiveSessions` returns everything not explicitly
 * ENDED — in a long-lived repo that includes months of sessions whose agent is
 * long gone. Letting those subtract would be worse than the bug being fixed:
 * a turn that edits through the SHELL leaves no tool-call mapping to protect
 * it, so any file some dead session once touched would vanish from it.
 */
const CONCURRENT_SESSION_WINDOW_MS = 30 * 60 * 1000;

/** How long a pre-tool-use write claim stays credible. Comfortably longer than
 *  the gap between a tool call starting and its post-tool-use ledger entry
 *  landing, short enough that a blocked or crashed call cannot hold a file
 *  hostage — and a claim that expires early is harmless, because by then the
 *  ledger has the file. */
const PENDING_WRITE_TTL_MS = 5 * 60 * 1000;
/** Cap so a long session cannot grow the claim list without bound. */
const PENDING_WRITE_MAX = 500;

/** Live (unexpired) pending-write claims, repo-relative. */
function pendingWriteFiles(state: SessionState, rel: (f: string) => string): Set<string> {
  const out = new Set<string>();
  const now = Date.now();
  for (const w of state.pendingWrites || []) {
    if (!w || typeof w.file !== 'string' || !w.file) continue;
    const t = Date.parse(w.at || '');
    if (Number.isFinite(t) && now - t > PENDING_WRITE_TTL_MS) continue;
    out.add(rel(w.file));
  }
  return out;
}

/**
 * Files this session's live ledger proves IT edited — the post-tool-use hook's
 * real-time record of each Edit/Write/MultiEdit. Repo-relative.
 *
 * Deliberately not sourced from completedPromptMappings: those are the surface
 * a leak corrupts, so trusting them to define ownership lets one bad
 * attribution disable the guard that would have caught the next one.
 *
 * TOOL CALLS ONLY, and that filter is the whole point of this function.
 *
 * The ledger stopped being a pure record of our own tool calls once the shell
 * paths started writing to it: `__shell_probe__`, `origin:shell-window` and
 * `origin:write-journal` all INFER their file lists from a bare
 * baseline..working-tree diff. On a shared checkout that diff is exactly the
 * other agents' in-progress work — it is the thing `uncommittedExcludeUnion`
 * exists to subtract, not evidence about who wrote what. `evidence:
 * 'command_probe'` reads like proof and is not: it means the tree moved while
 * one of our commands ran, which with five sibling agents on the same
 * checkout says nothing about authorship.
 *
 * Counting those entries as ours re-armed the precise feedback loop the
 * comment in `uncommittedExcludeUnion` claims is impossible, just through a
 * different door: a sibling's file lands in our ledger by inference (its own
 * mapping is not written until ITS Stop, so nothing excluded it yet) -> it is
 * now "ours" -> the exclusion's `if (!ours.has(r))` stops excluding it -> it
 * re-lands on every later turn, permanently. Measured on session 6e9947a5:
 * `apps/api/src/services/reconstructed-commits.ts`, a file this session never
 * opened, sat in its ledger under both inferred toolNames while the sibling
 * that actually wrote it held it in a commit of its own.
 *
 * Only `source === 'uncommitted'` is dropped, which is narrower than the
 * `!e.source || e.source === 'tool_call'` test the shell-window capture uses
 * for its `coveredFiles`. `'commit'` edits stay ours on purpose: they are
 * appended for a sha that `dropForeignCommitsFromCapture` already vetted by
 * trailer and committer identity, which is a real ownership check, whereas a
 * tree diff is none. Widening this to drop `'commit'` too would go past what
 * the measurement shows.
 *
 * A session whose writes ALL went through the shell therefore reports an
 * empty set and falls through to the `ownEditedFiles` fallback, which is the
 * behaviour that path was written for and already documents.
 */
function liveEditedFiles(state: SessionState, rel: (f: string) => string): Set<string> {
  const out = new Set<string>();
  for (const block of state.liveEdits || []) {
    for (const e of block?.edits || []) {
      if (!e || typeof e.file !== 'string' || !e.file) continue;
      // `command_named` is an exception to the source test below: the file
      // changed inside ONE command's before/after window AND that command's
      // own text named it. A sibling writing concurrently satisfies the
      // window but can never satisfy the naming, so this is proof, not
      // inference — and without it a shell-written file that any sibling also
      // claims gets excluded from the turn that really wrote it. Thirteen
      // sessions claim packages/cli/src/commands/hooks.ts in this repo, which
      // is why it never appeared on a single turn of session 6e9947a5.
      if (e.evidence === 'command_named') { out.add(rel(e.file)); continue; }
      if (e.source === 'uncommitted') continue;
      out.add(rel(e.file));
    }
  }
  return out;
}

/**
 * Our own edited-file set for the exclusion above.
 *
 * Prefers the live ledger. Falls back to completedPromptMappings ONLY when the
 * ledger is empty — a session running with ORIGIN_LIVE_CAPTURE=0, a state file
 * written by an older CLI, or a turn that has edited nothing yet. Without that
 * fallback those sessions would report `ours` as empty and hand every
 * sibling-claimed file to the exclusion, so a shell-only session would watch
 * its own work disappear. The fallback restores the previous behaviour exactly
 * where the previous behaviour was all we had, and nowhere else: once the
 * ledger has a single TOOL-CALL entry it wins, and the feedback loop stays
 * broken. "Tool-call" is load-bearing — see liveEditedFiles: the ledger also
 * carries tree-inferred shell entries, and letting those satisfy this test is
 * what re-armed the loop, because an inferred entry is the exclusion's own
 * output fed back in as its input.
 *
 * Known gap either way: a file written through the SHELL never reaches the
 * ledger as a tool call, so in a ledger-bearing session a sibling that also
 * claims it will get it excluded from ours. That is the safe direction — a turn missing a
 * contested file is a smaller lie than a turn claiming another agent's work.
 */
function ownEditedFiles(state: SessionState, rel: (f: string) => string): Set<string> {
  const live = liveEditedFiles(state, rel);
  // Our own in-flight claims are ours too — otherwise a sibling that touched
  // the same file first would take a write we are in the middle of making.
  for (const f of pendingWriteFiles(state, rel)) live.add(f);
  if (live.size > 0) return live;
  const fallback = new Set<string>();
  for (const m of state.completedPromptMappings || []) {
    for (const f of m.filesChanged || []) fallback.add(rel(f));
  }
  return fallback;
}

export function uncommittedExcludeUnion(state: SessionState): string[] {
  const set = new Set<string>();
  for (const f of state.prePromptDirtyFiles || []) set.add(f);
  for (const f of state.sessionStartDirtyFiles || []) set.add(f);
  // (c) Other-session-touched files. Iterate the active session registry on
  // this repo, gather their filesChanged / commit-derived filename lists,
  // and add any file we ourselves haven't touched. "Touched by us" is
  // defined as appearing in one of OUR completedPromptMappings.
  //
  // Paths are normalized to repo-relative FIRST. Mappings hold a mix: a tool
  // call records the absolute path it was handed, a git capture records the
  // repo-relative one. `filterUncommittedDiff` keys on
  // `diff --git a/<repo-relative>`, so every absolute entry added here matched
  // nothing and this exclusion quietly did half its job — the half covering
  // git-derived names, never the tool-derived ones that make up most agent
  // edits. Prod 0a8e2164 shared a checkout with a second Claude session and
  // was credited with its PublicLayout.tsx and Landing.tsx while this code was
  // already "excluding" them.
  try {
    const repoPath = state.repoPath;
    if (repoPath) {
      const rel = (f: string) => toRepoRelative(repoPath, f);
      // OUR files resolve against the tree we are writing in; a sibling's
      // resolve against the canonical repo they recorded them from. One
      // function cannot serve both roots, and using the canonical one for
      // ours is why a worktree session's ownership never matched: our
      // absolute paths came back as `.claude/worktrees/<name>/pkg/x.ts` while
      // every sibling and every git-derived name is `pkg/x.ts`.
      //
      // The two roots agree on the STRING for the same logical file, which is
      // the point — a worktree and its main checkout share a file layout, so
      // `pkg/x.ts` in either tree is the same name here. For a non-worktree
      // session workRoot IS repoPath and relOwn is rel.
      const workRoot = currentSessionWorkTree(state) || repoPath;
      const relOwn = (f: string) => toRepoRelative(workRoot, f);
      const now = Date.now();
      const others = listActiveSessions(repoPath).filter((s) => {
        if (s.sessionId === state.sessionId) return false;
        // Only a session seen recently is plausibly editing the tree we are
        // about to diff.
        const p = (s as any).__statePath;
        if (!p) return false;
        try {
          return now - fs.statSync(p).mtimeMs <= CONCURRENT_SESSION_WINDOW_MS;
        } catch { return false; }
      });
      if (others.length > 0) {
        // What counts as OURS is the live per-edit ledger — the post-tool-use
        // hook recording each Edit/Write as it fires. NOT completedPromptMappings.
        //
        // Deriving ownership from our own mappings made the leak permanent:
        // the moment a foreign file landed in one of our rows, it became
        // "ours", which switched this exclusion OFF for that file, so it
        // landed again on the next turn, and the next. Measured on b629d2cb —
        // `packages/cli/src/commands/hooks.ts` belonged to session 97ad4482,
        // had leaked into our mappings hours earlier, and was still being
        // re-attributed to every one of our turns while sitting in the
        // exclusion's own blind spot. The ledger cannot feed that loop back:
        // it only ever records a tool call WE made.
        const ours = ownEditedFiles(state, relOwn);
        for (const other of others) {
          // A sibling's COMPLETED turns…
          for (const m of other.completedPromptMappings || []) {
            for (const f of m.filesChanged || []) {
              const r = rel(f);
              if (!ours.has(r)) set.add(r);
            }
          }
          // …and its turn IN FLIGHT. Its mappings are only written at ITS
          // Stop, so while it is mid-turn its edits are invisible here — and
          // mid-turn is exactly when our own turn is diffing the tree it is
          // writing to. b629d2cb was credited with 97ad4482's
          // commit-attribution.test.ts for precisely this reason: no sibling
          // mapping claimed it yet, so nothing excluded it.
          for (const f of liveEditedFiles(other, rel)) {
            if (!ours.has(f)) set.add(f);
          }
          // …and the write it has ANNOUNCED but not yet completed. Its ledger
          // entry lands after the bytes do, so between those two moments this
          // claim is the only thing that says the file is theirs.
          for (const f of pendingWriteFiles(other, rel)) {
            if (!ours.has(f)) set.add(f);
          }
        }
      }
    }
  } catch { /* listActiveSessions is best-effort */ }
  return Array.from(set);
}

// Scope a session-level gitCapture's diff to ONLY what this session changed,
// by diffing against the session-start dirty snapshot (a shadow commit that
// captured the working tree — including pre-existing uncommitted dirt — at
// session start). `git diff <start-shadow>` is LINE-level, so a file that was
// already dirty AND edited this session keeps only this session's lines (the
// older file-level filter dropped the whole file). Commit metadata is left
// untouched — it comes from the HEAD-at-start capture, not this diff. No-op
// (returns the capture unchanged) when the start tree was clean or anything
// fails. This is what stops a 1-line session reading "+16 −6" / a 100%-AI
// file reading 85% once the inherited dirt is excluded at the source.
export function scopeSessionDiffToStart(
  gitCapture: ReturnType<typeof captureGitState>,
  repoPath: string,
  shadowSha: string | null | undefined,
): ReturnType<typeof captureGitState> {
  if (!shadowSha) return gitCapture;
  try {
    const clean = captureGitState(repoPath, shadowSha, { fullContext: true });
    if (clean.baselineIsShadow && typeof clean.workingTreeDiff === 'string') {
      gitCapture.diff = clean.workingTreeDiff;
      // Also re-scope uncommittedDiff — the server folds it into the Full
      // Session Diff fallback, so leaving the raw `git diff HEAD` here let
      // PRE-EXISTING uncommitted files (a prior session's dirt) resurface even
      // after `diff` was cleaned. captureGitState now sets clean.uncommittedDiff
      // to the shadow-scoped working-tree diff for no-commit sessions.
      gitCapture.uncommittedDiff = clean.uncommittedDiff;
      gitCapture.linesAdded = clean.linesAdded;
      gitCapture.linesRemoved = clean.linesRemoved;
      debugLog('session-diff', 'scoped to session-start shadow', {
        shadow: shadowSha.slice(0, 12),
        linesAdded: clean.linesAdded,
        linesRemoved: clean.linesRemoved,
      });
    }
  } catch (err: unknown) {
    debugLog('session-diff', 'shadow scoping failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return gitCapture;
}

// Session-aware amend rescue. For each SHA already in
// state.sessionCommitShas (post-commit hook recorded these — so they
// genuinely belong to THIS session), check if it's still reachable
// from HEAD. If NOT — typical signal of `git commit --amend`, which
// orphans the pre-amend SHA and creates a new commit with the same
// parent — find the replacement (same parent, reachable from HEAD)
// and substitute it in place.
//
// Critically: this NEVER adds a SHA we didn't already own. The
// previous helper walked `git log session-start..HEAD` and added
// every reachable commit, which silently picked up concurrent
// sessions' work and polluted pc.diff. This version only ever
// MUTATES entries; it never inflates the list.
/** Order-preserving, case-insensitive sha dedupe. First occurrence wins so the
 *  session's commit ORDER (oldest-first) survives. */
function dedupeShas(shas: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of shas || []) {
    const k = String(s).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** One commit's patch-id — stable across a rebase, because it hashes the DIFF,
 *  not the parent pointers or the sha. Empty when git cannot answer (a merge,
 *  a pruned orphan). */
function commitPatchId(repoPath: string, sha: string): string {
  try {
    const show = execFileSync('git', ['show', '--no-color', sha], {
      windowsHide: true, cwd: repoPath, encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 64 * 1024 * 1024,
    }).toString();
    const out = execFileSync('git', ['patch-id', '--stable'], {
      windowsHide: true, cwd: repoPath, encoding: 'utf-8', input: show,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 16 * 1024 * 1024,
    }).toString().trim();
    return out.split(/\s+/)[0] || '';
  } catch { return ''; }
}

/** Subject line + the set of paths a commit touches. The fallback identity for
 *  a rebase copy whose patch-id MOVED: this repo bumps the CLI version on every
 *  rebase, so the rewritten commit carries two extra changed lines and hashes
 *  differently while being the same piece of work. */
function commitShape(repoPath: string, sha: string): { subject: string; files: string } | null {
  try {
    const out = execFileSync(
      'git', ['show', '--no-renames', '--name-only', '--format=%s', sha],
      { windowsHide: true, cwd: repoPath, encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
    ).toString().split('\n');
    const subject = (out[0] || '').trim();
    const files = out.slice(1).map((l) => l.trim()).filter(Boolean).sort().join('\n');
    if (!subject) return null;
    return { subject, files };
  } catch { return null; }
}

/**
 * Is `orphan` the pre-rebase copy of `candidate`?
 *
 * Identical patch-id is proof — `git patch-id --stable` hashes the diff, so a
 * rebase that only moves a commit onto a new base leaves it unchanged.
 *
 * When the patch-id MOVED we fall back to subject + changed-path set, because
 * a rebase here is rarely pure: resolving the version-file conflict re-bumps
 * `packages/cli/package.json`, so the rewritten commit differs by exactly the
 * version lines. Requiring BOTH the subject and the full path set to match
 * keeps that from collapsing two genuinely different commits — they would have
 * to share a subject AND touch exactly the same files.
 */
function isRewriteOf(repoPath: string, orphan: string, candidate: string): boolean {
  // Shape first, patch-id second — same OR semantics, but the cheap test runs
  // on every candidate and the expensive one only on the survivors. The search
  // below scans a whole branch window, so computing a patch-id per candidate
  // would mean a full `git show` per commit.
  const sa = commitShape(repoPath, orphan);
  const sb = commitShape(repoPath, candidate);
  if (sa && sb && sa.subject === sb.subject && sa.files === sb.files && sa.files) return true;
  const a = commitPatchId(repoPath, orphan);
  const b = commitPatchId(repoPath, candidate);
  return !!a && !!b && a === b;
}

/**
 * Is every commit in this turn's window a REWRITE of a commit an EARLIER turn
 * of this session already produced?
 *
 * A rebase moves work it did not author. `git rebase` replaces sha A with a new
 * sha B carrying the same change, and B is created inside whatever turn ran the
 * rebase — so `baseline..HEAD` for that turn reports a diff, a file list and a
 * commit, none of which the turn wrote. Session b0c86852 turn 3 did nothing but
 * rebase, push and merge, and was billed turn 1's +99/-11 a second time under
 * the rewritten sha f9f7557d.
 *
 * `commitTurns` is what makes this answerable: it records every commit this
 * session produced against the turn that produced it, and it keeps the
 * PRE-rebase entry (21bd0037) alongside the rewrite (f9f7557d) — `git` itself
 * has forgotten the first, but we have not. A window commit that matches an
 * earlier turn's commit is that turn's work wearing a new sha.
 *
 * `isRewriteOf` is the same test the commit-identity rescue uses, and it is the
 * right one here for the reason its own docstring gives: on the real pair above
 * the patch-ids DIFFER (rebasing onto a new base moved them) while subject and
 * changed-path set match exactly.
 *
 * Deliberately ALL-or-nothing. A window holding one rewrite and one genuinely
 * new commit is a turn that really did author something, and must keep its
 * capture. This only answers "the whole window is somebody else's turn, moved".
 *
 * Requires a non-empty window: with nothing to explain there is no rebase to
 * find, and returning true would silence turns for the wrong reason.
 */
export function windowIsRebaseOfEarlierTurns(
  isRewrite: (priorSha: string, windowSha: string) => boolean,
  windowShas: string[],
  commitTurns: Array<{ sha?: string; turnId?: string }> | null | undefined,
  currentTurnId: string | null | undefined,
): boolean {
  const window = (windowShas || []).map((s) => (s || '').trim()).filter(Boolean);
  if (window.length === 0) return false;
  // Commits this session recorded against some OTHER turn. Same-turn entries
  // are excluded because the rewrite itself is one of them: post-commit files
  // the new sha under the turn the rebase ran in, so matching a commit against
  // its own row would let any commit explain itself.
  const prior = (commitTurns || [])
    .filter((c) => c && typeof c.sha === 'string' && c.sha
      && (!currentTurnId || c.turnId !== currentTurnId))
    .map((c) => (c.sha as string).trim());
  if (prior.length === 0) return false;
  return window.every((sha) =>
    prior.some((p) => p !== sha && isRewrite(p, sha)));
}

/** Commits reachable from HEAD in this session's window, newest-first — the
 *  pool a rebase's rewrites actually live in. Bounded: a long-lived branch
 *  should not turn the rescue into a full-history walk. */
function reachableWindowShas(repoPath: string, state: SessionState, gitOpts: any): string[] {
  const start = state.sessionStartShadowSha || state.headShaAtStart || '';
  const range = /^[a-fA-F0-9]{7,40}$/.test(start) ? `${start}..HEAD` : 'HEAD';
  for (const spec of [range, 'HEAD']) {
    try {
      const args = spec === 'HEAD'
        ? ['rev-list', '-n', '200', 'HEAD']
        : ['rev-list', '-n', '200', spec];
      const out = execFileSync('git', args, gitOpts).toString().trim();
      const list = out ? out.split('\n').map((l: string) => l.trim()).filter(Boolean) : [];
      if (list.length > 0) return list;
    } catch { /* range unreadable (rebased-away start) — fall through to HEAD */ }
  }
  return [];
}

function rescueAmendedCommitShas(repoPath: string, state: SessionState): void {
  if (!state.sessionCommitShas || state.sessionCommitShas.length === 0) return;
  const gitOpts = {
    windowsHide: true,
    cwd: repoPath,
    encoding: 'utf-8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  };
  const replacements = new Map<string, string>();
  // Computed once: the rescue may examine every orphan against this pool.
  const reachablePool = reachableWindowShas(repoPath, state, gitOpts);
  // Starts EMPTY. Seeding it with every recorded sha would block the case
  // #1360 exists for — where BOTH the orphan and its rewrite were recorded and
  // the rewrite is the correct target. It only records targets already taken.
  const claimed = new Set<string>();
  for (const sha of state.sessionCommitShas) {
    if (!/^[a-fA-F0-9]{7,40}$/.test(sha)) continue;
    // Is the recorded sha still reachable from HEAD? merge-base
    // --is-ancestor exits 0 = ancestor, 1 = not ancestor, 2+ = error.
    let reachable = true;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], gitOpts);
    } catch (err: any) {
      // execFileSync throws on non-zero exit. Status 1 = not reachable
      // (likely amended/rebased). Any other status (commit missing
      // from object DB, repo corrupt) — skip; we have nothing to do.
      reachable = false;
      if (err?.status !== undefined && err.status !== 1) continue;
    }
    if (reachable) continue;
    // Orphaned commit. Look for the amend replacement: same parent,
    // reachable from HEAD. We can still read the orphan's parent from
    // the object DB until git gc prunes it.
    let parent = '';
    try {
      parent = execFileSync('git', ['rev-parse', `${sha}^`], gitOpts).toString().trim();
    } catch { continue; }
    if (!parent || !/^[a-fA-F0-9]{7,40}$/.test(parent)) continue;
    // Walk first-parent history from parent..HEAD and take the first
    // commit whose parent matches `parent`. `--first-parent` keeps us
    // on the main line (avoids picking up merge-side commits as
    // amend candidates). If multiple amends stacked, the rescue
    // walks one step; subsequent calls would walk further if state
    // is persisted between captures.
    try {
      const out = execFileSync(
        'git',
        ['log', `${parent}..HEAD`, '--first-parent', '--format=%H %P'],
        gitOpts,
      ).toString().trim();
      for (const line of out.split('\n')) {
        const [candidate, ...parents] = line.split(' ');
        if (!/^[a-fA-F0-9]{7,40}$/.test(candidate || '')) continue;
        // Same parent is NECESSARY but not sufficient. After a rebase the
        // commit now sitting on the orphan's old parent is usually somebody
        // else's — the very commit main moved forward by — and mapping our
        // orphan onto it credits this session with another session's work.
        // Confirm it is actually a rewrite of ours before substituting.
        if (parents[0] === parent && isRewriteOf(repoPath, sha, candidate)) {
          replacements.set(sha, candidate);
          break;
        }
      }
    } catch { /* parent unreachable — orphan irrecoverable */ }

    // ── Rebase, not amend ──────────────────────────────────────────────
    // The walk above matches on SAME PARENT, which is what an amend
    // preserves. A rebase moves the whole branch onto a new base, so every
    // rewritten commit has a different parent and the walk finds nothing —
    // the orphan stayed in the list while the rewritten copy was recorded
    // separately, and the session counted the same work twice.
    //
    // Measured on session 92e45049: three rebases onto a moving main turned
    // 4 real commits into 14 rows, four of them sharing one patch-id
    // (81e24d414357). The page then showed a turn reading +46/-14 above
    // "2 commits total +313/-13" — badges for work already counted under
    // earlier turns.
    //
    // Candidates are drawn ONLY from shas this session already owns and that
    // are still reachable. That keeps the rescue's founding rule intact: it
    // never adds a sha we did not already have, so a concurrent session's
    // commit can never be pulled in as a "replacement".
    if (!replacements.has(sha)) {
      // Search the BRANCH, not just our own recorded shas.
      //
      // #1360 looked for the replacement among `sessionCommitShas`. That can
      // never find a rebase's rewrite: after a rebase the session still holds
      // the PRE-rebase shas and never recorded the rewritten ones, so the pool
      // it searched contained only other orphans. Session a77105c0 had 6 of its
      // 7 recorded commits orphaned and the rescue collapsed nothing — the
      // rewrites were sitting on the branch, unlooked-at, while the orphans'
      // patches kept being concatenated into the session diff (five blocks of
      // one version bump, +12/-12 of pure re-count).
      //
      // Candidates are reachable commits in this session's own window, so the
      // pool is the branch this session worked on rather than all of history.
      // `claimed` keeps two orphans from mapping onto one rewrite — after a
      // rebase the mapping is 1:1, and letting two collapse onto the same
      // commit would delete a real one.
      for (const candidate of reachablePool) {
        if (candidate === sha || claimed.has(candidate)) continue;
        if (isRewriteOf(repoPath, sha, candidate)) {
          replacements.set(sha, candidate);
          claimed.add(candidate);
          break;
        }
      }
    }
  }
  if (replacements.size === 0) {
    // Still worth collapsing exact repeats: the same sha can be recorded by
    // both the post-commit hook and a later git-capture walk.
    const deduped = dedupeShas(state.sessionCommitShas);
    if (deduped.length !== state.sessionCommitShas.length) {
      state.sessionCommitShas = deduped;
      try { saveSessionState(state, state.repoPath || '', state.sessionTag); } catch { /* best-effort */ }
    }
    return;
  }
  // Dedupe AFTER mapping. An amend rescue could always collapse two entries
  // onto one sha, and a rebase rescue always does — both the orphan and its
  // rewrite were in the list, which is the duplication itself.
  state.sessionCommitShas = dedupeShas(
    state.sessionCommitShas.map((s) => replacements.get(s) ?? s),
  );
  try {
    saveSessionState(state, state.repoPath || '', state.sessionTag);
  } catch { /* best-effort persistence */ }
}

/** Added (`+`) or removed (`-`) lines in a unified diff, file headers excluded. */
function countDiffSignLines(diff: string, sign: '+' | '-'): number {
  let n = 0;
  for (const line of diff.split('\n')) {
    if (line[0] === sign && line.slice(0, 3) !== sign + sign + sign) n++;
  }
  return n;
}

/** One commit's own authored content, in a format the downstream parsers read.
 *  A merge is asked the narrower question — what it RESOLVED, not what it
 *  absorbed — because `git show <merge>` emits an unparseable `--cc` diff and
 *  the first-parent view is the whole other branch. See mergeOwnDiff. */
function commitOwnDiff(repoPath: string, sha: string): string {
  const merge = mergeOwnDiff(repoPath, sha);
  if (merge) return merge.diff;
  try {
    return execFileSync(
      'git',
      ['show', sha, '--format=', '--no-color'],
      { windowsHide: true, cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
    ).toString().trim();
  } catch { return ''; /* commit may have been removed by a rebase */ }
}

/** Every path the given commits touch, BOTH sides of a rename included.
 *  `--no-renames` is what makes a rename list as delete+add here; the caller's
 *  `git diff` then has both paths in its pathspec and re-detects the rename
 *  itself, instead of reporting the new path as a whole-file insertion.
 *  A merge contributes only the paths it resolved — `--name-only` on one lists
 *  nothing at all, which used to leave the pathspec silently short. */
function ownedCommitPaths(repoPath: string, shas: string[]): string[] {
  const paths = new Set<string>();
  for (const sha of shas) {
    if (!/^[a-fA-F0-9]{7,40}$/.test(sha)) continue;
    const merge = mergeOwnDiff(repoPath, sha);
    if (merge) {
      for (const p of merge.filesChanged) paths.add(p);
      continue;
    }
    try {
      const out = execFileSync(
        'git',
        ['show', '--no-renames', '--name-only', '--format=', sha],
        { windowsHide: true, cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
      ).toString();
      for (const line of out.split('\n')) {
        const p = line.trim();
        if (p) paths.add(p);
      }
    } catch { /* commit may have been removed by a rebase; skip */ }
  }
  return [...paths];
}

// Compute the committed-side diff scoped to commits THIS session authored.
// Replaces `git diff prePromptSha...HEAD`, which picks up commits made by
// concurrently-running sessions once HEAD moves past this session's commits.
// Returns empty string when the session hasn't committed anything yet.
//
// rescueAmendedCommitShas runs FIRST so `git commit --amend` doesn't
// silently drop the session's committed work from blame. It only mutates
// SHAs we already owned; it never adds unrelated commits (that was the
// 3153d3b pollution mistake that broke every multi-session repo).
// `sinceSha` narrows the walk to the commits that landed in ONE TURN'S window
// (sinceSha..HEAD) instead of the whole session.
//
// Without it every per-turn mapping got the CUMULATIVE session diff. Prod
// session 0f3b1e69: capture c_04135e01 wrote the same 82,367-byte, 4-file diff
// onto rows 1, 2 AND 13; rows 6/7 shared one, 4/5 shared another. Each turn was
// handed everything the session had committed so far, so turns duplicated each
// other and every one of them overstated its own work.
//
// Keeping the SESSION-owned sha list as the source (rather than a plain
// baseline..HEAD range) is what still keeps a concurrently-running agent's
// commits out — the reason this function exists at all.
function sessionScopedCommittedDiff(
  repoPath: string,
  state: SessionState,
  sinceSha?: string | null,
): string {
  rescueAmendedCommitShas(repoPath, state);
  let shas = state.sessionCommitShas || [];
  if (shas.length === 0) return '';
  // The newest commit of the turn's window, and whether EVERY commit in that
  // window is one of ours — both needed by the baseline-relative render below.
  let windowHead: string | null = null;
  let windowIsAllOurs = false;
  if (sinceSha && /^[a-fA-F0-9]{7,40}$/.test(sinceSha)) {
    try {
      const list = execFileSync('git', ['rev-list', `${sinceSha}..HEAD`], {
        windowsHide: true, cwd: repoPath, encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
      }).toString().split('\n').map((l) => l.trim()).filter(Boolean);
      const inWindow = new Set(list);
      // Prefix match in both directions: sessionCommitShas may be short.
      shas = shas.filter((sha) =>
        [...inWindow].some((full) => full === sha || full.startsWith(sha) || sha.startsWith(full)));
      const owned = shas.map((s) => s.toLowerCase());
      windowIsAllOurs = list.length > 0 && list.every((full) =>
        owned.some((o) => full.toLowerCase().startsWith(o) || o.startsWith(full.toLowerCase())));
      windowHead = list[0] || null; // rev-list is newest-first
    } catch {
      // Range unreadable (shallow clone, rebased baseline) — fall back to the
      // whole session rather than silently emptying the turn.
    }
  }
  if (shas.length === 0) return '';
  // ── Baseline-relative render ───────────────────────────────────────────
  // `git show <sha>` is the commit against its PARENT, which is the wrong
  // question for a turn: a `git commit -a` sweeps up everything that was
  // already dirty — an earlier turn's uncommitted work, and dirt that
  // predates the session entirely — and hands all of it to whichever turn
  // happened to run the commit.
  //
  // Prod 7a0a9efc (baton, Cursor): turn 1 wrote +68/-2, then committed. Its
  // row was re-captured at the next user-prompt-submit as the whole of
  // e2d4842 — 13 files, +256/-2 — which is turn 1's own 68 lines plus turn
  // 0's 68 uncommitted lines plus ~120 lines of pre-session dirt. Turn 0
  // still carried its own +68, so the two turns double-counted it.
  //
  // The turn's baseline (`sinceSha`) is a shadow commit whose tree IS the
  // working tree at turn start, so diffing FROM it subtracts exactly what
  // the turn did not author. Restricted to the paths our own commits touched
  // so a file left dirty in some OTHER file can't show up as a phantom
  // reversal, and gated on the window holding none but our commits so a
  // concurrent agent's work still can't leak in — the reason this function
  // walks an owned sha list in the first place.
  if (sinceSha && windowIsAllOurs && windowHead) {
    const paths = ownedCommitPaths(repoPath, shas);
    // An enormous commit would blow the argv limit; the per-commit walk below
    // is the safe answer there.
    if (paths.length > 0 && paths.length <= 500) {
      try {
        return execFileSync(
          'git',
          ['diff', '--no-color', sinceSha, windowHead, '--', ...paths],
          {
            windowsHide: true, cwd: repoPath, encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 64 * 1024 * 1024,
          },
        ).toString().trim();
      } catch { /* fall through to the per-commit walk */ }
    }
  }
  const parts: string[] = [];
  for (const sha of shas) {
    if (!/^[a-fA-F0-9]{7,40}$/.test(sha)) continue;
    const out = commitOwnDiff(repoPath, sha);
    if (out) parts.push(out);
  }
  return parts.join('\n').trim();
}

/** Test seam for the shell-window capture. The turn-0 erasure it guards
 *  against is only observable against a real repo with real dirt. */
export function __testRecordShellWindowEdits(
  state: any, repoPath: string, promptIndex: number, baselineSha: string,
): boolean {
  return recordShellWindowEdits(state as SessionState, repoPath, promptIndex, baselineSha);
}

/** Test seam for the amend/rebase rescue. A rebase can only be exercised
 *  against real git — mocking it would test the mock. */
export function __testRescueCommitShas(repoPath: string, state: any): string[] {
  rescueAmendedCommitShas(repoPath, state as SessionState);
  return state.sessionCommitShas;
}

/**
 * The file list for the retroactive per-prompt capture in user-prompt-submit.
 *
 * Two sources, and only one of them is scoped. `sessionCommitted` is
 * `sessionScopedCommittedDiff` — already restricted to commits THIS session
 * authored. `rawRangeDiff` is `captureGitState(baseline..HEAD).diff`, the whole
 * window, which in a shared checkout also holds whatever a concurrent session
 * committed while we were mid-turn.
 *
 * Stop drops those commits before anything reads its capture. This path never
 * did, and it OVERWRITES the mapping Stop wrote — so the exclusion Stop had
 * just computed was undone on the next prompt.
 *
 * Session b0c86852: Stop stored turn 3 as 2 files; the next prompt-submit
 * re-captured it as 9 / +307. The five extra were #1380 (`aab018ef`), dropped
 * by Stop seconds earlier and logged. The stored DIFF stayed clean, because it
 * is built from `sessionCommitted` alone — only the file list was polluted, so
 * the row claimed five files whose changes it did not contain.
 *
 * Only the raw range is filtered: subtracting foreign paths from the scoped
 * diff would be a no-op at best, and at worst would drop a file that a
 * concurrent commit and our own turn both touched.
 */
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

/** Test seam for the rebase-window check, wired to the REAL `isRewriteOf` the
 *  Stop path uses. Injecting a stub would prove only that the loop iterates:
 *  the thing worth pinning is that git's own view of a rebased commit still
 *  identifies it, which needs a real rebase. */
export function __testWindowIsRebaseOfEarlierTurns(
  repoPath: string, windowShas: string[],
  commitTurns: Array<{ sha?: string; turnId?: string }>,
  currentTurnId?: string | null,
): boolean {
  return windowIsRebaseOfEarlierTurns(
    (prior, cand) => isRewriteOf(repoPath, prior, cand),
    windowShas, commitTurns, currentTurnId,
  );
}

/** Test seam for sessionScopedCommittedDiff — the window scoping is the whole
 *  point of the function and is otherwise only reachable through a live hook. */
export function __testSessionScopedCommittedDiff(
  repoPath: string, state: any, sinceSha?: string | null,
): string {
  return sessionScopedCommittedDiff(repoPath, state as SessionState, sinceSha);
}

/** True when a commit's `Origin-Session` trailer id belongs to `state`
 *  (or the session it chained from). Trailers are truncated ("7bfbac34-0cd"),
 *  so match by prefix in either direction. */
export function commitTrailerBelongsToSession(commitBody: string, state: { sessionId?: string; previousSessionId?: string }): 'self' | 'other' | 'none' {
  const m = commitBody.match(/^Origin-Session:\s*([^\s|]+)/mi);
  if (!m) return 'none';
  const owner = m[1].trim();
  const selves = [state.sessionId, state.previousSessionId].filter(Boolean) as string[];
  for (const id of selves) {
    if (id === owner || id.startsWith(owner) || owner.startsWith(id)) return 'self';
  }
  return 'other';
}

const GIT_READ_OPTS = {
  windowsHide: true, encoding: 'utf-8' as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 5000,
};

/**
 * The repo's configured committer email, lowercased — the identity a local
 * `git commit` in this checkout stamps. Empty when nothing is configured.
 */
export function localCommitterEmail(repoPath: string): string {
  try {
    return execFileSync('git', ['config', '--get', 'user.email'], { ...GIT_READ_OPTS, cwd: repoPath })
      .toString().trim().toLowerCase();
  } catch { return ''; }
}

/**
 * Does this commit belong to THIS session? The single ownership predicate —
 * both the per-turn capture and the session-level range use it, because they
 * were answering the same question two different ways and only one of them
 * had the full answer.
 *
 * Ours when the post-commit hook recorded it on this session, or when the
 * `Origin-Session` trailer names us. A trailer naming a DIFFERENT session is
 * decisive the other way.
 *
 * The NO-TRAILER case is where this gets interesting. Treating it as ours is
 * right for the reason that default exists — a commit our own hook missed
 * (sandboxed Codex) carries no trailer — but it also waves through everything
 * that arrived by `git pull`, which is not local work at all. So an untrailered
 * commit is ours only when its COMMITTER is the local git identity: a
 * hook-missed local commit was committed by us, while a pulled one was
 * committed by GitHub (`noreply@github.com`) on squash-merge, or by whoever
 * authored it upstream. AUTHOR is not the signal — a squash-merge of your own
 * PR keeps you as author. With no local identity configured there is nothing
 * to compare against, so the generous default stands.
 */
export function commitBelongsToSession(
  repoPath: string,
  sha: string,
  state: SessionState,
  localEmail: string,
): boolean {
  let body = '';
  let committerEmail = '';
  try {
    body = execFileSync('git', ['show', '-s', '--format=%B', sha], { ...GIT_READ_OPTS, cwd: repoPath }).toString();
    committerEmail = execFileSync('git', ['show', '-s', '--format=%ce', sha], { ...GIT_READ_OPTS, cwd: repoPath })
      .toString().trim().toLowerCase();
  } catch { return true; } // unreadable — keep it rather than guess work away

  const ownership = commitTrailerBelongsToSession(body, state);
  if (ownership === 'self') return true;

  const recorded = (state.sessionCommitShas || []).map((c) => c.toLowerCase());
  const weRecordedIt = recorded.includes((sha || '').toLowerCase());

  // When our own record and a foreign trailer disagree, WHICH id the trailer
  // names decides it — a blanket priority either way gets one case wrong:
  //
  //   - Amend/rebase leaves a STALE trailer naming an id nothing on this
  //     machine answers to. The commit is ours, our record says so, and
  //     disowning it loses real work. (This is why the record used to win
  //     outright.)
  //   - A trailer naming a REAL, different session is not stale, it is the
  //     owner saying so at commit time. Our record is the weaker witness here
  //     because the post-commit hook has to guess which of several live
  //     sessions a commit belongs to, and it guesses wrong: session 81d65cb5
  //     held 7998ece8, trailered `Origin-Session: de0785ac-812`, and showed it
  //     under a prompt that had made no commit at all.
  if (ownership === 'other') {
    if (!weRecordedIt) return false;
    return !trailerNamesAKnownSession(repoPath, body, state);
  }
  // No trailer at all. Our own record does NOT settle it, and used to:
  // `if (weRecordedIt) return true;` stood here and short-circuited both
  // checks below.
  //
  // That made the record its own proof. `sessionCommitShas` is written by the
  // post-commit hook, which has to GUESS which of several live sessions a
  // commit belongs to — the guess this predicate exists to audit. Letting it
  // return early meant a wrong guess could never be corrected by the two
  // signals that are not guesses.
  //
  // Measured on session 6e9947a5, which recorded bc324e14 — a GitHub
  // squash-merge of PR #1214 that arrived by `git pull`. Both guards below
  // catch it: session 3b276b1f had also recorded it, and its committer is
  // `noreply@github.com`, which is precisely the pulled-commit signature the
  // committer check was written for. Neither ran. The turn was credited with
  // nine files it never touched.
  //
  // Nothing is lost for a commit we really made: a hook-missed local commit
  // (sandboxed Codex, a shell `git commit`) carries no trailer but IS
  // committed by the local identity, so it still returns true below.
  if (anotherSessionRecordedCommit(repoPath, sha, state)) return false;
  if (!localEmail || !committerEmail) return true;
  return committerEmail === localEmail;
}

/**
 * Does this commit's trailer name a session that actually EXISTS on this
 * machine, other than us?
 *
 * Separates the two ways a foreign trailer arises. A stale one — left by an
 * amend or rebase, naming an id no session answers to — must not disown work
 * our own record claims. A trailer naming a live sibling is the real owner
 * speaking, and outranks a record the post-commit hook had to guess.
 *
 * Ids in trailers are truncated (`Origin-Session: de0785ac-812`), so matching
 * is by prefix in both directions. Best-effort: if nothing can be read, we
 * report "not known", which keeps the previous record-wins behaviour.
 */
function trailerNamesAKnownSession(repoPath: string, commitBody: string, state: SessionState): boolean {
  const m = commitBody.match(/^Origin-Session:\s*([^\s|]+)/mi);
  const id = (m?.[1] || '').toLowerCase();
  if (!id) return false;
  try {
    for (const other of allSessionStatesForRepo(repoPath)) {
      if (!other?.sessionId) continue;
      const oid = String(other.sessionId).toLowerCase();
      const tag = String(other.sessionTag || '').toLowerCase();
      if (oid === String(state.sessionId || '').toLowerCase()) continue;
      if (oid.startsWith(id) || id.startsWith(oid) || (tag && (tag.startsWith(id) || id.startsWith(tag)))) {
        return true;
      }
    }
  } catch { /* best-effort */ }
  return false;
}

/**
 * Every session state on this repo, ENDED ones included.
 *
 * `listActiveSessions` filters ENDED out, which is right for "who is running"
 * and wrong for "who owns this commit" — a session that has since finished
 * still owns what it committed.
 */
function allSessionStatesForRepo(repoPath: string): SessionState[] {
  const out: SessionState[] = [];
  try {
    const gitDir = getGitCommonDir(repoPath);
    if (!gitDir) return out;
    for (const entry of fs.readdirSync(gitDir)) {
      if (!entry.startsWith('origin-session') || !entry.endsWith('.json')) continue;
      try {
        const st = JSON.parse(fs.readFileSync(path.join(gitDir, entry), 'utf-8'));
        if (st && typeof st === 'object' && st.sessionId) {
          if (!st.sessionTag) {
            const tm = entry.match(/^origin-session-(.+)\.json$/);
            if (tm) st.sessionTag = tm[1];
          }
          out.push(st);
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* best-effort */ }
  return out;
}

/**
 * True when a DIFFERENT session's state file already recorded this commit.
 *
 * The untrailered-commit default ("committed by the local identity, so ours")
 * is right for a lone session whose hook missed a commit, and wrong the moment
 * the same human has two agents running: both match the committer, so both
 * claim it. Session 81d65cb5 took ff844650 — a pipe-stall test commit from a
 * sibling session — exactly this way.
 *
 * Best-effort and deliberately one-directional: it only ever REMOVES a claim,
 * never adds one, so a failed read or a missing state file leaves the previous
 * behaviour untouched.
 */
function anotherSessionRecordedCommit(repoPath: string, sha: string, state: SessionState): boolean {
  const target = (sha || '').toLowerCase();
  if (!target) return false;
  try {
    // listActiveSessions skips ENDED sessions, so a commit whose owner has
    // already finished is not caught here — the trailer check above is what
    // covers that case, and it is the decisive one.
    for (const other of listActiveSessions(repoPath)) {
      if (!other || other.sessionId === state.sessionId) continue;
      const shas = (other.sessionCommitShas || []).map((c) => String(c).toLowerCase());
      if (shas.some((c) => c === target || (c.length >= 7 && target.startsWith(c)) || target.length >= 7 && c.startsWith(target))) {
        return true;
      }
    }
  } catch { /* best-effort */ }
  return false;
}

/**
 * Commits in (headShaAtStart .. HEAD] that THIS session owns. Used as the
 * fallback when the post-commit hook didn't record sessionCommitShas.
 * Without this, a session scoping to `git diff session-start..HEAD` sweeps in
 * commits made by OTHER agents running concurrently in the same repo — e.g. a
 * Codex session showing a Devin commit + its lines (the reported bug).
 *
 * This feeds sessionDiff.commitShas, which is what LINKS a Commit row to the
 * session server-side. Its old trailer-only rule let every pulled commit
 * through: prod 97ad4482 had bc7d68da — a GitHub squash-merge of an unrelated
 * PR — attached to it, and the session-detail badge path has no way to undo
 * that (the server never stores a committer to check).
 */
function ownedRangeCommitShas(repoPath: string, state: SessionState): string[] {
  const start = state.headShaAtStart;
  if (!start) return [];
  const end = getHeadSha(repoPath);
  if (!end || end === start) return [];
  let list: string[] = [];
  try {
    const out = execFileSync('git', ['rev-list', `${start}..${end}`], { ...GIT_READ_OPTS, cwd: repoPath }).toString().trim();
    list = out ? out.split('\n').map(s => s.trim()).filter(s => /^[a-fA-F0-9]{7,40}$/.test(s)) : [];
  } catch { return []; }
  const localEmail = localCommitterEmail(repoPath);
  return list.filter((sha) => commitBelongsToSession(repoPath, sha, state, localEmail));
}

/**
 * The files ONE turn shows it authored — its transcript mapping plus its live
 * ledger, which covers tool calls the transcript has not flushed yet.
 *
 * Its caller uses this to decide which files a concurrent commit may NOT be
 * excluded from: touch a file yourself and a sibling's commit to it cannot
 * erase your work. That rule is only sound per TURN. It used to be evaluated
 * against `parsed.filesChanged` — `parseTranscript(..., { since:
 * state.startedAt })`, the whole SESSION — so a path any earlier turn had
 * touched stayed exempt for the rest of the session, and the exclusion that
 * had just been computed was handed straight back.
 *
 * Session 3dbff831: the drop fired correctly (`dropped: [3ea12b50, 18ea4f98],
 * files: 6`), #1377's +31/-2 on apps/api/src/routes/sessions.ts was in it, an
 * earlier turn of ours had edited that path, and the release turn — which
 * authored nothing — was billed +31/-2 for another PR's work.
 *
 * Empty is a real answer: a turn with no evidence it wrote anything exempts
 * nothing.
 *
 * THE TWO SOURCES ARE NUMBERED IN DIFFERENT SPACES, so each index is named and
 * both are required. `promptMappings` comes from `extractPromptFileMappings`,
 * which documents its own numbering: `since` drops the rows of turns before the
 * session but never renumbers the survivors, so `promptIndex` is the turn's
 * NATIVE position — server space. `state.liveEdits` is written by
 * `currentTurnIndex`, which indexes `state.prompts` — a list holding only the
 * turns THIS launch saw, so it is local space.
 *
 * They coincide only while `promptIndexBase` is 0, which is every ordinary
 * session — the same reason `serverRowForLocalTurn` exists and the same reason
 * writers that skipped the conversion looked correct for a long time. Resume,
 * compact or adopt a conversation and the base becomes B: a local index L then
 * selects native row L, which is local turn L − B — an EARLIER turn of ours —
 * and the exemption is back to handing a concurrent commit's files to a turn
 * that did not author them, which is the defect this function was extracted to
 * fix. Below B there is no such row at all and the transcript half goes silent,
 * leaving only the ledger, which is capped and empty for agents with no tool
 * hooks.
 *
 * Taking one index and using it against both is what made that invisible, so
 * the signature no longer allows it.
 */
export function filesOwnedByTurn(
  state: { liveEdits?: Array<{ promptIndex: number; edits?: Array<{ file: string }> }> },
  promptMappings: Array<{ promptIndex: number; filesChanged?: string[] }> | null | undefined,
  // Server space — the turn's native position in the transcript.
  serverIndex: number,
  // Local space — the turn's position in `state.prompts`.
  localIndex: number,
): string[] {
  const out = new Set<string>();
  for (const pm of promptMappings || []) {
    if (pm.promptIndex !== serverIndex) continue;
    for (const f of pm.filesChanged || []) if (f) out.add(f);
  }
  for (const entry of state.liveEdits || []) {
    if (entry.promptIndex !== localIndex) continue;
    for (const e of entry.edits || []) if (e?.file) out.add(e.file);
  }
  return [...out];
}

/**
 * Strip commits made by a CONCURRENT session out of a per-turn git capture.
 *
 * `captureGitState` returns `commitDetails` as a bare `baseline..HEAD` range.
 * On a shared checkout that range contains whatever OTHER agents committed
 * while this turn was running, and three separate decisions downstream read it
 * without ever asking whose commits those are: the chat-only gate
 * (`commitDetails.length === 0`), the `filesChanged` fallback for turns whose
 * transcript shows no edits, and the safety net's `sawNewCommit` test — which
 * then stamps current HEAD as this turn's commitSha.
 *
 * Prod session 97ad4482 (user-reported): a read-only turn that answered a
 * question was credited with commit 4024a3ec, 12 files and +929/-32. The
 * commit was made three minutes earlier by session ff3ac057 in the same
 * checkout, whose `Origin-Session` trailer says so plainly. The turn's own
 * `sawNewCommit` guard passed because a commit HAD landed since its baseline —
 * the guard asks "did a commit happen", never "was it mine".
 *
 * Ownership follows `ownedRangeCommitShas`: ours if the post-commit hook
 * recorded it on this session, or if its trailer is ours. A commit stamped to
 * a DIFFERENT session is dropped, so a solo session is unaffected.
 *
 * The NO-TRAILER case needs one extra test. Treating it as ours is right for
 * the reason that default exists — a commit our own hook missed (sandboxed
 * Codex) carries no trailer — but it also waves through every commit that
 * arrived by `git pull`, which is not local work at all. Caught live on this
 * very fix's session: bc7d68da, a GitHub squash-merge of somebody else's PR,
 * fast-forwarded into the shared checkout mid-turn and landed its two files on
 * the turn that was writing this function. So an untrailered commit counts as
 * ours only when its COMMITTER is the local git identity: a hook-missed local
 * commit is committed by us, while a pulled one is committed by GitHub
 * (`noreply@github.com`) or by whoever authored it upstream.
 *
 * Returns the file paths carried by the dropped commits, so the caller can
 * also keep their content out of a shadow-baseline diff (the shadow predates
 * the foreign commit, so `workingTreeDiff` contains it too).
 */
export function dropForeignCommitsFromCapture(
  repoPath: string,
  state: SessionState,
  capture: { commitShas: string[]; commitDetails: Array<{ sha: string; filesChanged: string[] }> },
  // Which hook is asking. hooks.log forensics is read by time window across
  // every hook, so a drop logged from user-prompt-submit under `[stop]` sends
  // the next reader to the wrong producer.
  hookName: string = 'stop',
): string[] {
  const details = capture.commitDetails || [];
  if (details.length === 0) return [];
  const localEmail = localCommitterEmail(repoPath);
  const foreignFiles = new Set<string>();
  const foreignShas = new Set<string>();
  for (const d of details) {
    const sha = (d.sha || '').trim();
    if (!sha || commitBelongsToSession(repoPath, sha, state, localEmail)) continue;
    foreignShas.add(sha);
    for (const f of d.filesChanged || []) foreignFiles.add(f);
  }
  if (foreignShas.size === 0) return [];
  capture.commitDetails = details.filter((d) => !foreignShas.has((d.sha || '').trim()));
  capture.commitShas = (capture.commitShas || []).filter((s) => !foreignShas.has((s || '').trim()));
  debugLog(hookName, 'dropped concurrent session commits from turn capture', {
    dropped: Array.from(foreignShas).map((s) => s.slice(0, 8)),
    files: foreignFiles.size,
  });
  return Array.from(foreignFiles);
}

// (Cursor model detection moved to ../agents/cursor.ts)


/**
 * Read Cursor conversation summary from its SQLite DB.
 * Returns { title, tldr, overview, summaryBullets } or null.
 * Used to populate session output when no transcript is available.
 */
function getCursorConversationSummary(conversationId: string): { title: string; tldr: string; overview: string; summaryBullets: string } | null {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
    const dbPath = path.join(os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
    if (!fs.existsSync(dbPath)) return null;

    const escapedId = conversationId.replace(/'/g, "''");
    const result = querySqlite(dbPath, `SELECT title, tldr, overview, summaryBullets FROM conversation_summaries WHERE conversationId='${escapedId}' LIMIT 1`, { separator: '|||', timeoutMs: 2000 }).trim();
    if (!result) return null;
    const parts = result.split('|||');
    return {
      title: (parts[0] || '').trim(),
      tldr: (parts[1] || '').trim(),
      overview: (parts[2] || '').trim(),
      summaryBullets: (parts[3] || '').trim(),
    };
  } catch {
    return null;
  }
}

// ─── Session Write Helper ─────────────────────────────────────────────────

import type { ParsedTranscript, PromptFileMapping } from '../transcript.js';

/**
 * Assemble SessionWriteData from hook state + parsed transcript + git capture.
 * Shared by handleStop, handleSessionEnd, and handlePostCommit.
 */
export function buildSessionWriteData(opts: {
  state: SessionState;
  parsed: ParsedTranscript;
  promptMappings: PromptFileMapping[];
  gitCapture: { headBefore: string; headAfter: string; commitShas: string[]; linesAdded: number; linesRemoved: number; commitDetails?: Array<{ sha: string; filesChanged: string[] }> };
  status: 'running' | 'ended';
  apiUrl: string;
  extraFiles?: string[];
  // Per-prompt PromptCapture JSON (apply_patch / Edit / replace payload),
  // keyed by promptIndex. Travels into changes.json so a different Origin
  // org importing this repo can drive AI Blame from the authoritative
  // edits instead of falling back to block-matching against pc.diff.
  promptEditsByIndex?: Map<number, string>;
}): SessionWriteData {
  const { state, parsed, promptMappings, gitCapture, status, apiUrl, extraFiles, promptEditsByIndex } = opts;

  // Reconciled, never shrinking — see reconcilePromptHistory. A rolled
  // transcript otherwise renumbers every turn under it.
  const prompts = reconcilePromptHistory(state.prompts, parsed.prompts);
  const model = parsed.model || state.model;
  const durationMs = Date.now() - new Date(state.startedAt).getTime();
  const branch = resolveSessionBranch(state) || state.branch || '';

  // Merge file lists and make paths relative to repo root
  // Fall back to git-captured files if transcript parsing found none
  const repoRoot = state.repoPath || '';
  let transcriptFiles = parsed.filesChanged;
  if (transcriptFiles.length === 0 && gitCapture.commitDetails) {
    const gitFiles = new Set<string>();
    for (const commit of gitCapture.commitDetails) {
      for (const f of commit.filesChanged) gitFiles.add(f);
    }
    transcriptFiles = Array.from(gitFiles);
  }
  const allFiles = Array.from(new Set([
    ...transcriptFiles,
    ...(extraFiles || []),
  ])).map(f => f.startsWith(repoRoot) ? f.slice(repoRoot.length + 1) : f);

  // Helper to make paths relative to repo root
  const rel = (f: string) => f.startsWith(repoRoot) ? f.slice(repoRoot.length + 1) : f;

  // Build PromptEntry[] — match prompts to their file changes
  const promptEntries: PromptEntry[] = prompts.map((text, i) => {
    const mapping = promptMappings.find(m => m.promptIndex === i);
    return {
      index: i + 1,
      text: typeof text === 'string' ? text : String(text),
      filesChanged: (mapping?.filesChanged || []).map(rel),
    };
  });

  // How many prompts map to each commit? A commit owned by exactly ONE prompt
  // is that prompt's authoritative committed work, so we can rebuild its diff
  // straight from the commit. (When several prompts share a commit we can't
  // attribute the commit's lines to an individual prompt, so we keep the live
  // per-prompt capture and only fill in when it's empty.)
  // A prompt's committed SHA: its own commitSha if the stop hook attached one,
  // else the current HEAD — but ONLY when the prompt actually has COMMITTED
  // work. A prompt with NO files, or whose edits are still UNCOMMITTED, must not
  // inherit HEAD: doing so leaked the current commit onto no-change turns and
  // onto turns whose work wasn't committed yet, and the server's FILL-ONLY rule
  // then froze that wrong SHA forever (session 34f90cb5: "check repo" (no
  // changes) and "add 10 (not commit)" both showed an unrelated commit). Leaving
  // it null lets the correct commit fill in on a later capture, once the work is
  // actually committed. The immediate-commit case (files touched + committed in
  // one turn, clean tree) still inherits HEAD via `hasFiles && !hasUncommitted`.
  const resolvePromptCommitSha = (m: PromptFileMapping): string | null => {
    if (m.commitSha) return m.commitSha;
    const hasFiles = Array.isArray(m.filesChanged) && m.filesChanged.length > 0;
    const hasUncommitted = !!(m.uncommittedDiff && m.uncommittedDiff.trim());
    return hasFiles && !hasUncommitted ? (gitCapture.headAfter ?? null) : null;
  };

  const promptsPerCommit = new Map<string, number>();
  for (const mm of promptMappings) {
    const sha = resolvePromptCommitSha(mm);
    if (sha) promptsPerCommit.set(sha, (promptsPerCommit.get(sha) ?? 0) + 1);
  }

  // Build PromptChange[] from mappings with snapshot metadata. Pulls the
  // per-prompt commit/tree/uncommitted refs straight off the mapping when
  // the stop hook attached them (typical for Claude/Cursor/Gemini); falls
  // back to gitCapture.headAfter for legacy synth paths. editsJson comes
  // from the parallel `promptEditsByIndex` map populated by
  // capturePromptEdits — same shape that ships to the API.
  const changes: PromptChange[] = promptMappings.map(m => {
    const commitSha = resolvePromptCommitSha(m);
    let diff = m.diff || '';
    let filesChanged = m.filesChanged;
    // Immediate-commit recovery. When a prompt CREATES files and COMMITS them
    // in the same turn, the live `git diff HEAD` capture races the commit — by
    // the time the stop hook runs the working tree can be clean OR only PARTIALLY
    // staged (Cursor/Codex commit some files a beat before the hook sees the
    // rest). That left the turn with a commitSha but an empty OR undercounted
    // diff — the dashboard then showed fewer files/lines than the actual commit
    // (e.g. turn "+20 / 3 files" vs commit "+33 / 4 files"), and #466 only
    // recovered the fully-EMPTY case.
    //
    // Fix: when this prompt is the SOLE prompt for the commit, the commit IS its
    // committed work — rebuild the diff from the commit itself (authoritative,
    // no heartbeat race), not just when the live capture was empty. Many:1
    // commits keep the live per-prompt diff (empty-only fill, as before), since
    // the commit's lines can't be split across prompts. --unified=2000 mirrors
    // the heartbeat so AI-Blame replay has full-file context to anchor edits.
    const soleForCommit = !!commitSha && promptsPerCommit.get(commitSha) === 1;
    if ((!diff.trim() || soleForCommit) && commitSha && /^[0-9a-f]{7,40}$/i.test(commitSha) && repoRoot) {
      try {
        const out = execFileSync(
          'git',
          ['show', commitSha, '--format=', '--no-color', '--unified=2000'],
          { windowsHide: true, cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
        ).toString().trim();
        if (out) {
          diff = out;
          // Rebuild filesChanged from the authoritative commit — for the partial
          // case the live list is a subset of the commit's files, so always
          // re-derive when we took the commit diff (not only when it was empty).
          const names = new Set<string>();
          for (const mm of out.matchAll(/^diff --git a\/(.*?) b\//gm)) {
            if (mm[1]) names.add(mm[1]);
          }
          if (names.size > 0) filesChanged = Array.from(names);
        }
      } catch { /* commit unreachable (rebased/amended) — keep the live capture */ }
    }
    // Compute per-prompt line counts from the (possibly reconstructed) diff
    const diffLines = diff.split('\n');
    const added = diffLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = diffLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
    return {
      promptIndex: m.promptIndex + 1,
      promptText: m.promptText.slice(0, 200),
      filesChanged: filesChanged.map(rel),
      diff,
      linesAdded: added,
      linesRemoved: removed,
      aiPercentage: 100, // All auto-captured prompts are AI-generated changes
      checkpointType: 'auto',
      commitSha,
      treeSha: m.treeSha ?? null,
      uncommittedDiff: m.uncommittedDiff ?? null,
      editsJson: promptEditsByIndex?.get(m.promptIndex) ?? null,
      ...(outOfRepoFilesFromEditsJson(promptEditsByIndex?.get(m.promptIndex))),
    };
  });

  // Completeness invariant (root-cause fix). The per-mapping reconstruction
  // above handles the empty diff and the SOLE-prompt commit. But when a commit
  // spans MULTIPLE prompts, a file that fell out of every live per-prompt
  // capture is still missing from all of them — it survives only in the commit.
  // Attach such orphan files to their committing prompt so pc.diff is the
  // authoritative record. Every consumer (turn diff, AI%, By-File blame) derives
  // from pc.diff, so this fixes the whole class at the source instead of adding
  // another per-surface fallback. See prompt-completeness.ts.
  if (repoRoot && Array.isArray(gitCapture.commitDetails) && gitCapture.commitDetails.length > 0) {
    attachOrphanCommitFiles(
      changes,
      gitCapture.commitDetails,
      (sha, file) => {
        try {
          return execFileSync(
            'git',
            ['show', sha, '--format=', '--no-color', '--unified=2000', '--', file],
            { windowsHide: true, cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
          ).toString();
        } catch { return ''; }
      },
      rel,
    );
  }

  return {
    sessionId: state.sessionId,
    model,
    startedAt: state.startedAt,
    endedAt: new Date().toISOString(),
    durationMs,
    status,
    costUsd: estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens, { cacheCreation1hTokens: parsed.cacheCreation1hTokens }),
    tokensUsed: parsed.tokensUsed,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheCreationTokens: parsed.cacheCreationTokens,
    cacheCreation1hTokens: parsed.cacheCreation1hTokens,
    toolCalls: parsed.toolCalls,
    linesAdded: gitCapture.linesAdded,
    linesRemoved: gitCapture.linesRemoved,
    prompts: promptEntries,
    filesChanged: allFiles,
    git: {
      branch,
      headBefore: gitCapture.headBefore || '',
      headAfter: gitCapture.headAfter || '',
      commitShas: gitCapture.commitShas,
    },
    summary: parsed.summary,
    originUrl: `${apiUrl}/sessions/${state.sessionId}`,
    changes,
  };
}

/**
 * Last-line normalisation for a turn's file list, applied once at Stop after
 * every producer and every re-capture merge have had their say.
 *
 * The per-producer scoping fixes are the real repair; this is the choke point
 * that makes a miss by ANY of them non-fatal, and the only thing that can heal
 * rows already written. Three jobs:
 *
 *  1. Collapse `.claude/worktrees/<ours>/pkg/x.ts` → `pkg/x.ts`. A worktree
 *     session's own files kept arriving under that prefix from producers
 *     relativising against the canonical repo, so ONE file occupied TWO rows —
 *     turns 1-4 of session 6e9947a5 each list the same test file twice, once
 *     in each shape. Only OUR worktree's name is collapsed.
 *  2. Drop `.claude/worktrees/<theirs>/…` — a different worktree really is
 *     somebody else's work, which is what that ignore rule always meant.
 *  3. Drop anything outside every session root. `scopeCapturedPath` fails OPEN
 *     when handed no roots, so an absolute path from a caller that forgot them
 *     sails through: every turn of 6e9947a5 carried
 *     `/private/tmp/claude-501/…/scratchpad/msgN.txt`, the scratch file this
 *     agent writes its commit messages into, rendered as a repo file.
 *
 * Order-preserving and de-duplicating, so the collapsed form takes the slot of
 * whichever shape was seen first and its twin disappears.
 */
export function normalizeTurnFiles(
  files: string[] | undefined,
  opts: { roots: string[]; workTree?: string | null },
): string[] {
  if (!Array.isArray(files) || files.length === 0) return [];
  const roots = (opts.roots || []).filter(Boolean);
  // The `.claude/worktrees/<name>` segment naming OUR tree, if we are in one.
  let ourPrefix: string | null = null;
  const wt = (opts.workTree || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /\.claude\/worktrees\/([^/]+)$/.exec(wt);
  if (m) ourPrefix = `.claude/worktrees/${m[1]}/`;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    if (typeof raw !== 'string' || !raw) continue;
    let f = raw.replace(/\\/g, '/');

    if (path.isAbsolute(raw)) {
      const scoped = scopeCapturedPath(roots, raw);
      if (!scoped) continue;                 // outside every root — not our work
      f = scoped.replace(/\\/g, '/');
    }

    if (f.startsWith('.claude/worktrees/')) {
      if (ourPrefix && f.startsWith(ourPrefix)) f = f.slice(ourPrefix.length);
      else continue;                         // a DIFFERENT worktree's file
    }
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/**
 * Every repo root this session owns — the worktree it runs in, plus the extra
 * checkouts of a multi-repo session. `extractPromptFileMappings` scopes every
 * captured path to these, so a file the agent wrote outside all of them (its
 * own memory notes under ~/.claude, a scratch file in /tmp) never becomes one
 * of the turn's changed files.
 *
 * The linked worktree goes FIRST, and until now it was not here at all —
 * the sentence above described an intent this function never implemented.
 *
 * `scopeCapturedPath` returns on the first root the file is inside, so order
 * decides the RECORDED NAME, not just membership. A worktree lives at
 * `<repo>/.claude/worktrees/<name>`, which is textually inside repoPath, so
 * with only repoPath present every file a worktree session touched was
 * relativised to `.claude/worktrees/<name>/pkg/x.ts` — a name that matches no
 * git-derived path, and that `**\/.claude/worktrees/**` then discards
 * downstream as "some other worktree's files". Putting the work tree first
 * yields `pkg/x.ts`, which is what git, the shell probe, and every sibling
 * session already use.
 *
 * Resolved fresh and defensively: a session can move between turns, and this
 * runs on every transcript pass, so a git failure here must degrade to the
 * old behaviour rather than throw.
 */
export function sessionRepoRoots(
  state: { repoPath?: string; repoPaths?: string[]; lastCwd?: string },
): string[] {
  const roots = new Set<string>();
  try {
    const wt = sessionWorkTree(state.repoPath, state.lastCwd, {
      gitRoot: getWorkingGitRoot,
      gitCommonDir: getGitCommonDir,
    });
    if (wt) roots.add(wt);
  } catch { /* fall through to repoPath — never block a capture on this */ }
  if (state.repoPath) roots.add(state.repoPath);
  for (const rp of state.repoPaths || []) if (rp) roots.add(rp);
  return [...roots];
}

/**
 * A turn may be captured MORE THAN ONCE — a re-capture may only ADD to it.
 *
 * Claude Code fires Stop at the end of every assistant response, and a
 * background task reporting back re-invokes the model, so ONE user prompt
 * produces N Stop fires. Each re-captures the SAME promptIndex against a
 * baseline that has since moved forward (the shadow baseline is re-anchored at
 * the end of every Stop), so the window keeps shrinking — and the normal merge
 * policy, "the current prompt's data wins over saved", then writes the smaller
 * record over the bigger one.
 *
 * Prod 97c78829, one prompt, four Stops:
 *   22:55:48   5 files, shadow baseline 985d440e, commit 76456b99
 *   23:00:08   3 files
 *   23:00:36   0 files — recorded as "chat-only prompt"
 * A turn that wrote 5 files and made 2 commits ended up recorded as having
 * done nothing, and that is what shipped to the dashboard.
 *
 * File lists union. For the diff we keep whichever text describes more of the
 * turn: a later capture that genuinely saw more is longer, one that saw a
 * shrunken window is not. `chatOnly` is cleared once anything survives — the
 * turn demonstrably wasn't. Only indices present in BOTH lists are touched, so
 * in practice this is the current turn and nothing else.
 *
 * `excludeFiles` is this Stop's exclusion union (pre-existing dirt, other live
 * sessions' files, and files a concurrent commit moved under us). A later
 * capture can legitimately DROP a file for being foreign — on a shared
 * checkout that is the whole point of the exclusion pass — so the rescue must
 * not hand it back. Matched by path suffix, the same way the exclusion list is
 * built, because prior captures can hold a bare name where this one holds a
 * repo-relative path.
 *
 * The rescue also has to survive a prior capture that is not a capture of this
 * turn at all. When a turn boundary went unannounced — Cursor folds a prompt
 * typed mid-generation into the running turn and fires no hook for it — the
 * live path kept widening the PREVIOUS turn's window across the boundary, so
 * the saved mapping for turn i holds turn i+1's files too. Rescuing those puts
 * the later turn's work back on the earlier turn, and on session e2c3508a that
 * is exactly what happened: the transcript split turn 1 at 7 files, the prior
 * capture claimed 12, "a re-capture may only ADD" kept 12, and the turn that
 * wrote the other 4 and made the commit shipped as chat-only. So a prior file
 * that THIS turn's fresh capture doesn't list, while a LATER turn's does, is
 * left where the transcript put it — and the prior diff, which describes those
 * files, is not adopted either.
 */
export function keepRicherTurnCapture<
  T extends { promptIndex: number; filesChanged?: string[]; diff?: string; chatOnly?: boolean },
>(
  current: T[],
  previous: Array<{ promptIndex: number; filesChanged?: string[]; diff?: string }>,
  excludeFiles: string[] = [],
): T[] {
  if (previous.length === 0) return current;
  const samePath = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  const isExcluded = (f: string) => excludeFiles.some((x) => samePath(x, f));
  const priorByIdx = new Map(previous.map((pm) => [pm.promptIndex, pm]));
  // Files this pass attributes to some LATER turn — the signal that a prior
  // capture ran past a turn boundary nobody announced.
  const claimedLater = (file: string, index: number) => current.some(
    (other) => other.promptIndex > index
      && (other.filesChanged || []).some((f) => samePath(f, file)),
  );
  return current.map((pm) => {
    const prior = priorByIdx.get(pm.promptIndex);
    if (!prior) return pm;
    const curFiles = Array.isArray(pm.filesChanged) ? pm.filesChanged : [];
    const claimedFiles = Array.isArray(prior.filesChanged) ? prior.filesChanged : [];
    const kept = claimedFiles.filter((f) => !isExcluded(f));
    const priorFiles = kept.filter(
      (f) => curFiles.some((c) => samePath(c, f)) || !claimedLater(f, pm.promptIndex),
    );
    // The prior diff describes every file the prior capture claimed, so it is
    // only usable when we are taking all of them.
    const priorDiff = priorFiles.length === kept.length ? (prior.diff || '') : '';
    // Every file the prior capture claimed is excluded now, so its diff
    // describes only foreign work — there is nothing here to carry forward.
    if (claimedFiles.length > 0 && kept.length === 0) return pm;
    if (priorFiles.length === 0 && !priorDiff) return pm; // nothing to rescue
    const curDiff = pm.diff || '';
    const filesChanged = Array.from(new Set([...priorFiles, ...curFiles]));
    const diff = curDiff.length >= priorDiff.length ? curDiff : priorDiff;
    if (filesChanged.length === curFiles.length && diff === curDiff) return pm;
    const merged = { ...pm, filesChanged, diff };
    if (filesChanged.length > 0 || diff) delete (merged as { chatOnly?: boolean }).chatOnly;
    return merged;
  });
}

/**
 * Should this turn get an auto-snapshot?
 *
 * createSnapshot's dedup is NOT the "did anything change?" test it looks like:
 * it returns null only when the whole working tree is clean, or when the tree is
 * byte-identical to the previous snapshot. On a repo carrying pre-existing dirt
 * the first can never fire, so any unrelated tree movement mints a snapshot and
 * stamps it on whatever prompt is current — a chat-only turn ends up wearing a
 * green dot in the Session view next to an empty diff.
 *
 * Stop already reaches a verdict on exactly this question. `chatOnly` is set on
 * a prompt mapping only when there were no commits AND no transcript edits AND
 * no working-tree changes. That last clause is what the old
 * `linesAdded + linesRemoved > 0` gate lacked, and why that gate had to be
 * removed: a Cursor mid-turn prompt edits files in the IDE without committing,
 * so its tree is dirty, so it is never chatOnly and keeps its tree ref.
 */
export function shouldAutoSnapshot(
  promptMappings: Array<{ promptIndex: number; chatOnly?: boolean }>,
  promptCount: number,
): boolean {
  const current = promptMappings.find((pm) => pm.promptIndex === promptCount - 1);
  return current?.chatOnly !== true;
}

// ─── Stdin Reader ──────────────────────────────────────────────────────────

// Cursor on Windows writes its hook payload as UTF-8 *with BOM*, and JSON.parse
// rejects a leading U+FEFF outright. Every Cursor hook on this platform was
// silently no-oping: beforeSubmitPrompt never created the session, so the
// poll-based transcript watcher noticed it only after the turn ended and took
// its headShaAtStart from a HEAD that already contained the agent's commit —
// the commit then fell outside the session walk and the turn read "uncommitted".
// Strip the BOM (and surrounding whitespace) before parsing. Written as a code
// point rather than a literal so the character stays visible in this source.
const BOM = 0xfeff;
export function stripBom(s: string): string {
  const t = s.trim();
  return t.charCodeAt(0) === BOM ? t.slice(1).trim() : t;
}

async function readStdin(): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(stripBom(data));
        debugLog('stdin', 'parsed', { keys: Object.keys(parsed), cwd: parsed.cwd, session_id: parsed.session_id, model: parsed.model });
        resolve(parsed);
      } catch {
        debugLog('stdin', 'parse-failed', { dataLength: data.length, preview: data.slice(0, 200) });
        resolve({});
      }
    });
    // If stdin is already closed or not a TTY, resolve after a short timeout
    if (process.stdin.isTTY) {
      debugLog('stdin', 'isTTY=true, resolving empty');
      resolve({});
    }
  });
}

// Read the hook payload. Normally it comes on stdin, but the detached
// background hook (spawnBackgroundHook) can't inherit a stdin pipe, so it hands
// the already-parsed payload to its child via a temp file named in
// ORIGIN_HOOK_INPUT_FILE. The child reads (and deletes) it instead of blocking
// on a closed stdin.
export async function readHookInput(): Promise<Record<string, any>> {
  const file = process.env.ORIGIN_HOOK_INPUT_FILE;
  if (file) {
    try {
      const input = JSON.parse(stripBom(fs.readFileSync(file, 'utf-8')));
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return input;
    } catch {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return {};
    }
  }
  return readStdin();
}

// Re-dispatch a hook event to a DETACHED background process and return
// immediately. Used for Copilot's user-prompt-submit: Copilot runs its hooks
// synchronously and blocks the user's prompt until the hook process exits, so
// the 6-14s capture path (session auto-create, shadow commit, policy fetch,
// context build) froze Copilot on every message. The background child performs
// the identical capture with no one waiting on it — the same off-to-the-side
// model the Codex/Cursor watchers already use. The payload is passed via a temp
// file (a detached child has no stdin), and ORIGIN_HOOK_BG=1 stops it from
// re-backgrounding. Throws on spawn failure so the caller can fall back to
// running inline.
function spawnBackgroundHook(agentSlug: string, event: string, input: Record<string, any>): void {
  const bin = process.argv[1];
  if (!bin) throw new Error('no cli entry (process.argv[1])');
  const tmp = path.join(os.tmpdir(), `origin-hook-${agentSlug}-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(input), { mode: 0o600 });
  const child = spawn(process.execPath, [bin, 'hooks', agentSlug, event], {
    detached: true,
    stdio: 'ignore',
    // See the heartbeat spawn in session-state.ts — without this a detached
    // console app pops its own terminal window on Windows.
    windowsHide: true,
    env: { ...process.env, ORIGIN_HOOK_BG: '1', ORIGIN_HOOK_INPUT_FILE: tmp },
  });
  child.unref();
}

// ─── Shell Escape ─────────────────────────────────────────────────────────

// escapeShellArg removed — execFileSync handles argument escaping safely

// ─── Agent-Model Mapping ──────────────────────────────────────────────────

/**
 * Bare agent-brand strings we stamp on a session at session-start when the
 * real model isn't known yet (e.g. claude-code's hook stdin has no `model`
 * field, so we fall back to "claude"). These are NOT real model identifiers.
 */
// (BARE_BRAND_MODELS / isSpecificModel moved to agents/registry.ts)



// (AGENT_MODEL_PATTERNS moved to agents/registry.ts as AgentDefinition.modelPattern)

/**
 * Check if a session's model field matches the given agent slug.
 */
// (sessionMatchesAgent moved to agents/registry.ts)

export const ORIGIN_MANAGED_MARKER = '<!-- origin-managed -->';

/**
 * Every repo-resident context file Origin manages with an
 * `<!-- origin-managed -->` block, relative to the repo root.
 *
 * Each agent reads its own file natively (Codex/Antigravity → AGENTS.md,
 * Gemini → GEMINI.md, …), but the block Origin owns inside each one is
 * IDENTICAL — it's the same session context rendered for whoever opens the
 * repo next. So they are refreshed together: see writeAgentRulesFile.
 *
 * `.windsurfrules` is legacy (pre-Devin rebrand) and is no longer a write
 * target for any agent, but repos still carry one — keep it refreshed rather
 * than leaving a file full of months-old "recent activity" behind.
 *
 * Cursor's `~/.cursor/rules/origin.md` is deliberately absent: it lives in
 * $HOME, not the repo, and Origin owns the whole file (no marker).
 */
export const MANAGED_REPO_CONTEXT_PATHS: string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  path.join('.devin', 'rules', 'origin.md'),
  path.join('.github', 'copilot-instructions.md'),
  '.windsurfrules',
];

/**
 * The context file a given agent reads natively, or null for agents that get
 * their context over the hook's stdout channel instead.
 */
function agentRulesTarget(
  agentSlug: string,
  repoPath: string,
): { target: string; useMarker: boolean } | null {
  switch (agentSlug) {
    case 'claude-code':
      // Claude Code reads .claude/settings.local.json instructions, but the most
      // reliable way to inject rules is via the project-level CLAUDE.md file.
      // Use a marker to manage our section without clobbering user content.
      return { target: path.join(repoPath, 'CLAUDE.md'), useMarker: true };
    case 'cursor':
      // Home-dir rules file — Origin owns it outright, so no marker.
      return { target: path.join(os.homedir(), '.cursor', 'rules', 'origin.md'), useMarker: false };
    case 'codex':
    case 'antigravity':
      // Codex and Antigravity both read AGENTS.md from the project root.
      return { target: path.join(repoPath, 'AGENTS.md'), useMarker: true };
    case 'devin':
      // Devin (formerly Windsurf) reads always-on rules from .devin/rules/.
      // Devin Desktop has no third-party hooks, so this rules file is Origin's
      // only context-injection surface there; the Devin CLI reads it too.
      return { target: path.join(repoPath, '.devin', 'rules', 'origin.md'), useMarker: true };
    case 'gemini':
      return { target: path.join(repoPath, 'GEMINI.md'), useMarker: true };
    case 'copilot':
      // Copilot CLI + VS Code read repo custom instructions from
      // .github/copilot-instructions.md. Managed-marker section keeps user content.
      return { target: path.join(repoPath, '.github', 'copilot-instructions.md'), useMarker: true };
    default:
      return null;
  }
}

/**
 * Replace (or append) the `<!-- origin-managed -->` block in `target`,
 * preserving anything the user wrote outside it. Returns true if the file
 * changed on disk.
 */
/**
 * Compute the new contents of an origin-managed context file. Pure + exported
 * for testing; writeManagedBlock does the IO around it.
 *
 * The managed region is delimited by a PAIR of `<!-- origin-managed -->`
 * markers. Three shapes have to be handled, and the third is the one that used
 * to fail silently:
 *
 *  - No marker → append the block (or become the file, when it is empty).
 *  - Two or more markers → replace from the FIRST to the LAST, so the file
 *    always converges on exactly one well-formed block. The old code replaced
 *    each lazily-matched PAIR instead, which left a third marker in place
 *    indefinitely.
 *  - Exactly ONE marker → the block was damaged (a user deleting half of it, or
 *    a torn write — this file is written whole, not atomically). The old code
 *    took the replace branch, the pair regex matched nothing, the result was
 *    byte-identical to the input, and writeManagedBlock returned false. Nothing
 *    logged it, because the sibling-refresh loop only reports a `true`. That
 *    file's Origin context was then frozen forever: never refreshed, never
 *    repaired, and reporting no error while the agent read stale memory.
 *
 * Repairing the one-marker case means deciding what the text after the orphan
 * is. If it carries Origin's own preamble it is unambiguously ours, so we
 * replace from the orphan to end-of-file. If it does not, it may be the user's
 * prose and must not be touched: drop the orphan marker line alone and append a
 * fresh block. Deleting a user's notes to fix our own bookkeeping would be a
 * far worse failure than the stale block we are repairing.
 */
export function renderManagedFile(existing: string, systemMsg: string): string {
  const content = `${ORIGIN_MANAGED_MARKER}\n${systemMsg}\n${ORIGIN_MANAGED_MARKER}`;
  const first = existing.indexOf(ORIGIN_MANAGED_MARKER);

  if (first < 0) return existing.trim() ? existing + '\n\n' + content : content;

  const last = existing.lastIndexOf(ORIGIN_MANAGED_MARKER);
  if (last !== first) {
    // Well-formed (or over-marked): everything between the outermost markers is
    // the managed region.
    return existing.slice(0, first) + content + existing.slice(last + ORIGIN_MANAGED_MARKER.length);
  }

  // Exactly one marker — damaged block.
  const tail = existing.slice(first + ORIGIN_MANAGED_MARKER.length);
  if (tail.includes(PREAMBLE_VISIBLE_ANCHOR)) {
    // The tail is demonstrably Origin's own text; reclaim it.
    return existing.slice(0, first) + content;
  }
  // Ambiguous: keep every line the user might have written, drop only the
  // orphan marker, and append a fresh block.
  const withoutOrphan = existing
    .split('\n')
    .filter((line) => line.trim() !== ORIGIN_MANAGED_MARKER)
    .join('\n');
  return withoutOrphan.trim() ? withoutOrphan.trimEnd() + '\n\n' + content : content;
}

function writeManagedBlock(target: string, systemMsg: string): boolean {
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
  const next = renderManagedFile(existing, systemMsg);
  if (next === existing) return false;
  fs.writeFileSync(target, next);
  return true;
}

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
 * Does the agent that natively reads this managed file get its context over
 * the hook channel instead?
 *
 * The mirror of agentReadsContextFromHook, keyed by FILE rather than by agent —
 * because the sibling refresh knows the path it is about to write and not who
 * will open it. Only the repo-root files with a hook-reading owner qualify:
 * CLAUDE.md (claude-code) and GEMINI.md (gemini). AGENTS.md is Codex and
 * Antigravity, whose file IS their only channel; .devin, copilot-instructions
 * and legacy .windsurfrules likewise.
 *
 * Cursor's own file is absent from MANAGED_REPO_CONTEXT_PATHS entirely — it
 * lives in $HOME — so it is never reached by that loop.
 */
export function siblingReadsContextFromHook(rel: string): boolean {
  return rel === 'CLAUDE.md' || rel === 'GEMINI.md';
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
const ORIGIN_FRAMEWORK_MARKER = 'Origin authoring framework —';

export function writeAgentRulesFile(
  agentSlug: string,
  systemMsg: string,
  repoPath: string,
  ownFileMsg?: string,
): void {
  if (!systemMsg) return;

  const written = new Set<string>();

  // `ownFileMsg` is what the RUNNING agent's own file gets, when that differs
  // from what the siblings get. It exists to stop double-delivery: an agent
  // that already receives the repo-context block over the hook channel would
  // otherwise read the very same block again out of its own always-loaded
  // rules file (CLAUDE.md et al), paying twice for one copy of the
  // information. Siblings keep the FULL text — those files are the ONLY
  // delivery channel for the file-driven agents that read them (Codex reads
  // AGENTS.md and gets no hook payload at all), so trimming them would be a
  // real loss rather than a dedupe.
  const own = agentSlug ? agentRulesTarget(agentSlug, repoPath) : null;
  if (own) {
    const ownMsg = ownFileMsg || systemMsg;
    try {
      fs.mkdirSync(path.dirname(own.target), { recursive: true });
      if (own.useMarker) writeManagedBlock(own.target, ownMsg);
      else fs.writeFileSync(own.target, ownMsg);
      written.add(path.resolve(own.target));
      debugLog('session-start', 'agent rules file written', { agent: agentSlug, path: own.target });
    } catch (err: any) {
      // Non-fatal — a failure here must not stop the sibling refresh below.
      debugLog('session-start', 'agent rules file write failed', { path: own.target, message: err?.message });
    }
  }

  for (const rel of MANAGED_REPO_CONTEXT_PATHS) {
    const target = path.join(repoPath, rel);
    if (written.has(path.resolve(target))) continue;
    try {
      if (!fs.existsSync(target)) continue;
      if (!fs.readFileSync(target, 'utf-8').includes(ORIGIN_MANAGED_MARKER)) continue;
      // A sibling whose owner reads its context over the HOOK gets the durable
      // half too — the same subtraction its own session would have applied.
      //
      // This loop used to write the full text everywhere, which quietly undid
      // the dedupe across agents: when a Cursor session ran, CLAUDE.md was a
      // SIBLING, so it received the whole volatile digest. The next Claude
      // session then loaded that file as always-on context and read a digest
      // written for someone else's task — and, because the file is only
      // rewritten once this hook gets that far, a digest that is now stale.
      //
      // Observed: a claude-code session opened carrying "93% of recent commits
      // (28/30)" and "19 sessions, 183 commit records" from CLAUDE.md while
      // the hook block delivered "97% (29/30)" and "182 commit records" for
      // the same repo in the same turn. Two disagreeing digests, one context.
      //
      // File-driven agents (Codex/Antigravity via AGENTS.md, Devin, Copilot,
      // legacy .windsurfrules) still get the FULL text: their file is the only
      // delivery channel Origin has, so trimming it is a real loss.
      const durable = ownFileMsg && siblingReadsContextFromHook(rel) ? ownFileMsg : systemMsg;
      if (writeManagedBlock(target, durable)) {
        debugLog('session-start', 'refreshed sibling origin-managed file', {
          agent: agentSlug, path: target, durable: durable !== systemMsg,
        });
      }
      written.add(path.resolve(target));
    } catch (err: any) {
      // One unreadable/read-only file must not block the rest.
      debugLog('session-start', 'sibling refresh failed', { path: target, message: err?.message });
    }
  }
}

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

// ─── Origin authoring framework guidance ──────────────────────────────────
//
// Short instruction block appended to every agent's system prompt
// (and to AGENTS.md / GEMINI.md / .windsurfrules for file-driven
// agents) telling the model to emit structured [Origin: …] markers
// as it works. Path A of "GitHub for agents" — agents EMIT the
// reviewer-facing structure inline; the server-side synthesis
// (pr-reviewer-brief.ts) remains as a fallback for sessions whose
// agents didn't comply.
//
// Kept terse on purpose. Verbose instructions get diluted in long
// contexts; this fits in ~150 tokens. The marker names match the
// section headers on the reviewer's brief UI so the agent's mental
// model maps 1:1 to what the reviewer will see.
function buildOriginFrameworkGuidance(): string {
  return [
    'Origin authoring framework — when there is real signal worth surfacing to the human reviewer, emit these markers inline in your responses. Don\'t force one per turn; skip a marker entirely if you have nothing real for it.',
    '',
    'REPLACE each <…> below with your own words. Never emit a marker with the angle-bracket placeholder still in it, and never copy this template block verbatim — a marker whose content is still a <…> placeholder is discarded as noise.',
    '',
    '  [Origin: Intent] <one sentence on WHY you\'re making this change>',
    '  [Origin: Decision] <choice you made> — <why>',
    '  [Origin: Open] <something you didn\'t finish, or aren\'t sure about>',
    '  [Origin: Verify] <something a human reviewer should check>',
    '',
    'Filled example: [Origin: Decision] used bcrypt over argon2 — broader Node compatibility.',
    '',
    'Markers are parsed verbatim — keep the bracket format exact. Multi-line content is fine; the marker line itself must stay on one line. Be honest: do not claim verifications you didn\'t do. These appear on the PR review surface alongside Origin\'s server-synthesized summary; agent-emitted markers take precedence.',
  ].join('\n');
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

// Anchor where the human-facing portion of the preamble begins. Everything
// before it (budget banner, agent system prompt) is either already surfaced
// on its own stderr line or is model-only config, not a user banner.
const PREAMBLE_VISIBLE_ANCHOR = 'Origin: Session tracking active';

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
function contextInjectionStampPath(repoPath: string): string {
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

// ─── Concurrent Session State Lookup ──────────────────────────────────────

/**
 * Find the correct session state for a hook invocation.
 *
 * With concurrent session support, each Claude Code window has its own
 * state file (tagged by sessionTag). This helper finds the right one by:
 * 1. Exact match on claudeSessionId (current or stored in state)
 * 2. Agent-filtered match using model patterns (when agentSlug is provided)
 * 3. Single active session (unambiguous — safe to use)
 * 4. Returns null when multiple sessions exist and no reliable match is found,
 *    to avoid misattributing commits to the wrong session.
 *
 * Returns the state and the resolved cwd to use for saving.
 */

// Agents whose stdin `session_id` is STABLE for the whole conversation
// (Claude Code, Windsurf). For every other agent the id is per-turn (Codex)
// or changes when the conversation is RESUMED in a new launch (Gemini), so
// passing it to findStateForHook forces an exact match that fails on resume.
// For those agents we pass `undefined`, which makes findStateForHook resolve
// via the agent-filtered fallback (the still-active same-agent session) instead
// of aborting.
//
// Bug this fixes: a resumed Gemini session stopped capturing per-prompt diffs.
// UserPromptSubmit already gated the id this way, but Stop / SessionEnd /
// PreToolUse passed the raw id — so after resume (new Gemini id) Stop hit
// "no exact match for stable claudeSessionId — new session needed" and
// ABORTed, never writing completedPromptMappings / advancing prePromptSha.
// Prompts kept growing (UserPromptSubmit worked) while diffs froze.
const STABLE_SESSION_ID_AGENTS = ['claude-code', 'devin', 'copilot'];
export function hookLookupSessionId(sessionId: string | undefined, agentSlug?: string): string | undefined {
  return STABLE_SESSION_ID_AGENTS.includes(agentSlug || '') ? sessionId : undefined;
}

/**
 * The stable per-chat `agentSessionId` to advertise when a hook AUTO-CREATES a
 * session (no prior session-start row to anchor on). Resolves EXACTLY as
 * handleSessionStart does so the server's dedup can match a resumed chat to its
 * existing session instead of minting a twin:
 *   • cursor  → conversation_id (stable per chat), falling back to session_id.
 *               Cursor's session_id ROTATES per turn, so it alone can't anchor a
 *               resume — omitting the id entirely (the old bug) forked a twin that
 *               re-copied the chat's prior prompts (prod 3a5328e9 vs e6f72dcc).
 *   • stable agents (claude-code/devin/copilot) → their session_id is stable.
 *   • everything else → undefined (no reliable per-chat anchor).
 */
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

export function resolveAutoAgentSessionId(
  agentSlug: string | undefined,
  conversationId: unknown,
  sessionId: unknown,
): string | undefined {
  const conv = typeof conversationId === 'string' && conversationId ? conversationId : undefined;
  const sess = typeof sessionId === 'string' && sessionId ? sessionId : undefined;
  if (agentSlug === 'cursor') return conv || sess;
  if (STABLE_SESSION_ID_AGENTS.includes(agentSlug || '')) return sess;
  return undefined;
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
    if (!(age >= 0) || age > opts.maxAgeMs) continue;
    if (s.status === 'ENDED' && s.endedAt) continue;
    if (s.repoPath !== opts.repoPath && s.repoPath !== opts.canonicalRepoPath) continue;
    if (opts.agentSlug && !sessionMatchesAgent(s, opts.agentSlug)) continue;
    // Don't recover a different Cursor chat's session (see note above).
    if (!cursorSessionReusable(opts.agentSlug, opts.incomingChatId, s.agentSessionId)) continue;
    if (age < bestAge) { best = s; bestAge = age; }
  }
  return best;
}

/** Max age at which an id-less session may still be adopted (see below). */
export const ADOPT_IDLESS_MAX_AGE_MS = 15 * 60 * 1000; // 15 min

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

/**
 * Compare two directory paths for identity, tolerating symlinks (macOS
 * /var → /private/var) and trailing-slash/relative differences. Used to
 * match a session's lastCwd against a git hook's cwd.
 */
/**
 * Does this directory path name the given session?
 *
 * Agent harnesses put a session's worktrees under a session-scoped directory —
 * Claude Code uses `…/<agentSessionId>/scratchpad/<name>` — so an id appearing
 * as (or inside) a path segment is ownership, not coincidence. Segment-scoped
 * and length-gated so a short tag can't match a substring of an unrelated
 * directory name.
 */
/**
 * The session's own files from a `session-start..HEAD` range capture.
 *
 * Two sources, and only one of them is safe on its own. `commitDetails` has
 * already had other sessions' commits filtered out of it by
 * dropForeignCommitsFromCapture, so its file lists are ours. The range's raw
 * `.diff` has NOT — it is the whole range's text — so a file is taken from it
 * only when it isn't one of the foreign commits' files, or when the transcript
 * shows we genuinely edited it too (a file can be touched by us AND a
 * concurrent agent).
 *
 * That second source is only meaningful when there ARE commits to judge
 * against. `git log A..B` comes back empty whenever HEAD is not a descendant of
 * the session's start sha — a branch switch, a rebase, a reset — while
 * `git diff A B` still produces a full diff of two unrelated points. With no
 * commits, dropForeignCommitsFromCapture returns [] meaning "nothing to judge",
 * the exclusion set is empty, and the diff harvest then credited the session
 * with EVERY file in the range.
 *
 * Prod d0cec15e, working on `main` in the shared checkout:
 *   23:34  session-level filesChanged  count:10  foreignDropped:2
 *   23:48  session-level filesChanged  count:18  foreignDropped:0   ←
 *   00:59  session-level filesChanged  count:13  foreignDropped:12
 * The 18 swept in four other sessions' merged PRs. Its header read "26 files
 * changed" for a session whose own turns touched 12 — and the server unions
 * this list, so the leak never washed back out.
 *
 * A range with no commits is unattributable, so we claim nothing from it and
 * the caller keeps the per-turn file list.
 *
 * Exported for testing.
 */
export function sessionFilesFromRangeCapture(
  capture: { commitDetails?: Array<{ filesChanged?: string[] }>; diff?: string },
  foreignFiles: Set<string>,
  ownFiles: string[],
): string[] {
  const details = capture.commitDetails || [];
  const files = new Set<string>();
  for (const c of details) {
    for (const f of c.filesChanged || []) files.add(f);
  }
  if (details.length === 0) return [...files];
  for (const m of (capture.diff || '').matchAll(/^diff --git a\/(.*?) b\//gm)) {
    const f = m[1];
    if (!f) continue;
    if (foreignFiles.has(f) && !ownFiles.some(
      (own) => own === f || own.endsWith(`/${f}`) || f.endsWith(`/${own}`),
    )) continue;
    files.add(f);
  }
  return [...files];
}

/**
 * Every working tree a session is in. One entry for the normal case; a
 * multi-repo session lists each checkout it spans. Used to answer "is this
 * session working in the tree this git hook fired in", which `lastCwd` cannot
 * answer — that records a subdirectory as often as a root.
 */
function sessionTrees(s: { repoPath?: string | null; repoPaths?: string[] | null }): string[] {
  const trees = new Set<string>();
  if (s.repoPath) trees.add(s.repoPath);
  for (const p of s.repoPaths || []) if (p) trees.add(p);
  return [...trees];
}

/**
 * True when we KNOW this session's working tree and it is not `hookTree`.
 *
 * Distinct from "we don't know where it is working": a session with no recorded
 * repoPath returns false and stays a candidate.
 */
function worksInAnotherTree(
  s: { repoPath?: string | null; repoPaths?: string[] | null },
  hookTree: string,
): boolean {
  const trees = sessionTrees(s);
  if (trees.length === 0) return false;
  return !trees.some((t) => sameDir(t, hookTree));
}

function pathNamesSession(
  s: { agentSessionId?: string | null; sessionId?: string | null; sessionTag?: string | null },
  dir: string,
): boolean {
  let segs: string[];
  try { segs = path.resolve(dir).split(path.sep).filter(Boolean); } catch { return false; }
  for (const id of [s.agentSessionId, s.sessionId, s.sessionTag]) {
    if (!id || id.length < 12) continue;
    if (segs.some((seg) => seg === id || seg.includes(id))) return true;
  }
  return false;
}

// Every narrowing rule in listSessionsForGitHook routes through this, and it
// compares two strings from DIFFERENT sources: `hookTree` is whatever
// `git rev-parse --show-toplevel` said, while `lastCwd`/`repoPath` are whatever
// the agent's own process reported. Cross-source is exactly where a hand-rolled
// path comparison breaks — `fs.realpathSync` resolves symlinks but leaves 8.3
// SHORT components alone, so `C:\Users\RUNNER~1\…` and the long form git
// answers with stayed two directories. Then `exact`, `inHookTree` AND
// `unknownCwd` all come back empty at once and the function returns [] — the
// same "commit credited to nobody" outcome the three cases below exist to
// prevent, arriving by a route none of them checks for. Windows-only, and
// git-hook-session-candidates.test.ts caught it there.
//
// samePath (paths.ts) is the repo's one path comparison: .native short-name
// expansion, separator normalisation, case folding where the filesystem is
// case-insensitive. session-worktree.ts's copy of this same helper was already
// converged onto it; this was the last one left.
function sameDir(a?: string | null, b?: string | null): boolean {
  return samePath(a, b);
}

/**
 * List candidate sessions for a BARE git hook (prepare-commit-msg,
 * post-commit, pre-push) — invocations that get no session_id/cwd on stdin
 * and must resolve the session from process.cwd() alone.
 *
 * Two worktree problems this solves (multi-session, parallel-worktree repos):
 *   1. A linked worktree has its own git dir (.git/worktrees/<name>) with no
 *      origin-session-*.json — the session registered its state under the
 *      MAIN repo's .git before the harness created the worktree. Fall back
 *      to repo-level sessions so the hook sees them at all.
 *   2. Several sessions are active at repo level. Narrow by each session's
 *      last-seen lifecycle-hook cwd (state.lastCwd): sessions whose lastCwd
 *      matches the hook's cwd exactly win; otherwise sessions known to be
 *      working elsewhere are dropped, keeping only those with unknown cwd
 *      (pre-upgrade state files). Worktrees are one-session-by-design, so an
 *      exact lastCwd match is the strongest signal we have.
 *
 * Exported for testing.
 */
/**
 * Among sessions the staleness filter rejected, find the one whose OWN recorded
 * work is what's being committed. Used only when the filter left no live
 * candidate at all — see the call site for why idle ≠ dead.
 *
 * Deliberately strict, because this is the one path that can credit a session
 * the liveness check already refused:
 *   • never revives a session that ended properly (explicit ENDED / endedAt) —
 *     only ones that merely went quiet;
 *   • requires the caller to supply the commit's files (no files, no revival);
 *   • scores ONLY the session's own recorded per-prompt capture, never
 *     sessionTouchedFiles' baseline-diff fallback. "The tree differs from where
 *     I started" is satisfied by any bystander session in the repo, so it would
 *     revive exactly the zombies this filter exists to bury;
 *   • requires a CLEAR winner on overlap, so two quiet sessions that both touched
 *     the file fall through to nobody rather than a coin flip.
 *
 * Exported for testing.
 */
export function pickIdleOwnerByFileEvidence(
  staleSessions: SessionState[],
  commitFiles?: string[],
): SessionState | null {
  if (!commitFiles || commitFiles.length === 0) return null;
  const wanted = new Set(commitFiles);
  const scored = staleSessions
    .filter((s) => !((s as any).status === 'ENDED' || s.endedAt))
    .map((s) => {
      const recorded = new Set<string>();
      for (const pm of (s.completedPromptMappings || [])) {
        for (const f of (pm?.filesChanged || [])) if (typeof f === 'string') recorded.add(f);
      }
      let overlap = 0;
      for (const f of wanted) if (recorded.has(f)) overlap++;
      return { s, overlap };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].overlap === scored[1].overlap) return null;
  return scored[0].s;
}

export function listSessionsForGitHook(
  hookCwd: string,
  opts?: { commitFiles?: string[] },
): SessionState[] {
  let sessions = listActiveSessions(hookCwd);
  if (sessions.length === 0) {
    const mainRepo = getGitRoot(hookCwd); // collapses linked worktree → main repo
    if (mainRepo && !sameDir(mainRepo, hookCwd)) {
      sessions = listActiveSessions(mainRepo);
      if (sessions.length > 0) {
        debugLog('git-hook-sessions', 'worktree fallback to repo-level sessions', {
          hookCwd, mainRepo, count: sessions.length,
        });
      }
    }
  }
  // Last resort: the durable mirror outside `.git`.
  //
  // Both lookups above read state stored INSIDE the repo, which is writable by
  // the agents being captured — and they delete it. Prod a5c2570c: an agent ran
  // `git init` in the work tree root, the fresh `.git` took the session state
  // with it, and the worktree fallback could not help either because after the
  // re-init the tree IS its own main repo. post-commit logged "no active
  // sessions" and the commit was ingested as a new repo row.
  //
  // The mirror lives in ~/.origin/sessions and survives that.
  if (sessions.length === 0) {
    sessions = listMirroredSessionsForTree(hookCwd);
    if (sessions.length > 0) {
      debugLog('git-hook-sessions', 'recovered session from the durable mirror — repo state was missing', {
        hookCwd, count: sessions.length, sessionIds: sessions.map((s) => s.sessionId),
      });
    }
  }
  // Drop zombie sessions — ones whose agent process died without a clean end
  // (no fresh git-state write, no live heartbeat, stale state file). Without
  // this a never-ended Cursor/Codex session lingers "RUNNING" forever and gets
  // its name stamped onto commits made by a different, live agent. Auto-close
  // each zombie locally (mark ENDED on disk) so it stops lingering, rather than
  // re-detecting it on every hook.
  if (sessions.length > 0) {
    const live: SessionState[] = [];
    const stale: SessionState[] = [];
    for (const s of sessions) {
      if (isSessionAlive(s)) { live.push(s); continue; }
      stale.push(s);
    }
    // Second chance for an IDLE-but-not-dead session, on file evidence only.
    // Liveness here is "was this state file touched in the last 3h", which
    // conflates idle with dead for an agent that fires no per-turn lifecycle
    // hook. Antigravity is the clearest case — it emits only Pre/PostToolUse
    // plus a Stop at process exit, so a session whose last tool call was hours
    // ago looks stale while its agent is still very much running.
    //
    // Prod agy session 168c6ab6: turn 2 wrote surprise.md at 18:58 and left it
    // uncommitted. The commit landed 5h37m later, past the 3h window, so every
    // candidate was filtered out — no trailer, no updateTargets, and the row
    // reached the server with sessionId null. Three minutes on, turn 3's tool
    // calls refreshed the file and ITS commit attributed fine. Same session,
    // same repo, opposite outcomes, decided purely by mtime.
    //
    // The gate is evidence, not recency: revive only when this session's own
    // recorded work IS what's being committed, and only when that's
    // unambiguous. A zombie that never touched these files scores zero overlap
    // and stays dead, so the "commit stamped with a dead Cursor session"
    // failure this filter exists to prevent can't come back through here.
    let revived: SessionState | null = null;
    if (live.length === 0 && stale.length > 0) {
      revived = pickIdleOwnerByFileEvidence(stale, opts?.commitFiles);
      if (revived) {
        live.push(revived);
        debugLog('git-hook-sessions', 'revived idle session on file evidence', {
          session: revived.sessionId.slice(0, 12),
          commitFiles: (opts?.commitFiles || []).length,
        });
      }
    }
    const closed: string[] = [];
    for (const s of stale) {
      if (s === revived) continue; // don't bury a session we just credited
      try { if (markSessionEnded(s)) closed.push(s.sessionId.slice(0, 12)); } catch { /* best effort */ }
    }
    if (closed.length) {
      debugLog('git-hook-sessions', 'auto-closed stale sessions', { closed, kept: live.map((s) => s.sessionId.slice(0, 12)) });
    }
    sessions = live;
  }
  if (sessions.length > 1) {
    // Git runs hooks from the working-tree root; this is the tree being
    // committed in. Needed by both narrowing rules below.
    const hookTree = getWorkingGitRoot(hookCwd) || hookCwd;
    const exact = sessions.filter(s => sameDir(s.lastCwd, hookCwd));
    // A session with NO lastCwd is not evidence it's working elsewhere — some
    // agents (Cursor) never record one. Keep those candidates alongside the
    // exact matches instead of deleting them here.
    //
    // Returning only `exact` silently dropped the live session BEFORE
    // pickActiveSessionForCommit could weigh its staged-file overlap (the
    // strongest attribution signal), so a stale-but-still-"alive" session that
    // happened to have a matching lastCwd won by default and stamped its name
    // onto another agent's commit. Real case (repo `popok`): a Codex session
    // whose heartbeat daemon never exited kept `status: RUNNING` for hours;
    // a later Cursor commit — Cursor writes no lastCwd — was trailered
    // `Origin-Session: 88c6190f | Codex`, so the Cursor session owned no
    // commit and every turn rendered "uncommitted" with a +0/-0 session diff.
    //
    // "No lastCwd" is not a licence to keep a session whose WORKTREE we do know
    // and which is not this one. Copilot never records a lastCwd, and it runs
    // every chat in its own linked worktree — so a commit in worktree A kept
    // every sibling chat's session as a candidate, and the branch/filesChanged
    // loop in post-commit then stamped A's branch, files, lines and commit
    // count onto them. Prod, 2026-08-25: session 2f31a7fe (worktree
    // dolobanko-jubilant-meme) was restamped `dolobanko-polished-ui-feature`
    // by a commit made in dolobanko-urban-journey. A session with no recorded
    // tree at all is still unknown, and still kept.
    const unknownCwd = sessions.filter(s =>
      !s.lastCwd && !worksInAnotherTree(s, hookTree));
    if (exact.length > 0) {
      debugLog('git-hook-sessions', 'narrowed by lastCwd', {
        hookCwd,
        matched: exact.map(s => s.sessionId.slice(0, 12)),
        keptUnknownCwd: unknownCwd.map(s => s.sessionId.slice(0, 12)),
      });
      return [...exact, ...unknownCwd];
    }
    // Git runs its hooks from the WORKING TREE ROOT, but a session's lastCwd is
    // wherever its last lifecycle hook fired — routinely a SUBDIRECTORY, because
    // agents `cd apps/web && npm test` all day. sameDir is strict equality, so
    // `…/origin/apps/web` never matches hookCwd `…/origin`; `exact` comes back
    // empty, and with every candidate carrying a lastCwd `unknownCwd` is empty
    // too — so the narrowing returned NOTHING and the commit was credited to
    // nobody.
    //
    // Prod d0cec15e made two commits one turn apart in the same session. The
    // first landed while lastCwd happened to be the repo root and attributed
    // fine; by the second the agent had cd'd into apps/web, so post-commit
    // logged "no active sessions, skipped API update" and prepare-commit-msg
    // wrote no trailer. No Commit row was ever created, so the commit was not
    // merely unattributed — it was ABSENT: the session read +262/-28 while its
    // own PR read +287/-28.
    //
    // Compare WORKING TREES instead. A session whose tree is the tree this hook
    // fired in is working here, whatever subdirectory it happened to sit in.
    // This does not re-merge parallel worktrees: each records its own worktree
    // as repoPath, and hookCwd's root IS the worktree being committed in, so
    // exactly one still matches. Sessions in a different tree stay dropped.
    //
    // Both halves are required. The tree check alone would keep a session whose
    // lastCwd says it has moved to another repo entirely — the case the
    // drop-sessions-working-elsewhere rule below exists for. The containment
    // check alone would keep a linked worktree's session when the MAIN checkout
    // commits, because a worktree under `.claude/worktrees/` is textually
    // inside it; that session's tree is the worktree, so the tree check
    // excludes it.
    const inHookTree = sessions.filter((s) =>
      sessionTrees(s).some((t) => sameDir(t, hookTree))
      && (!s.lastCwd || isInsideRepo(hookTree, s.lastCwd)));
    if (inHookTree.length > 0) {
      const merged = [...inHookTree, ...unknownCwd.filter((s) => !inHookTree.includes(s))];
      debugLog('git-hook-sessions', 'narrowed by working tree', {
        hookCwd, hookTree,
        matched: inHookTree.map((s) => s.sessionId.slice(0, 12)),
        keptUnknownCwd: merged.length - inHookTree.length,
      });
      return merged;
    }
    // A commit made INSIDE a linked worktree can never match by lastCwd: the
    // agent runs from the main checkout, so every session records THAT path
    // while hookCwd is the worktree. `exact` is empty by construction, and
    // since those sessions do have a lastCwd, `unknownCwd` is empty too — so
    // this returned nothing, post-commit logged "no active sessions, skipped
    // API update", prepare-commit-msg logged "skip — no unambiguous active
    // session", and the commit reached neither the API nor a trailer while its
    // session sat RUNNING (repo `origin`, 2026-08-22). Only bites with 2+ live
    // sessions; a lone session never reaches this narrowing, which is why
    // worktree commits attribute correctly some of the time.
    //
    // Resolved only where the answer is unambiguous: when the worktree path
    // itself names a session. Keeping every main-checkout session instead
    // would be a guess — and a wrong one for the case the sibling test pins,
    // where each parallel session owns its own worktree.
    const owning = sessions.filter((s) => pathNamesSession(s, hookCwd));
    if (owning.length === 1) {
      debugLog('git-hook-sessions', 'worktree path names its session', {
        hookCwd, owner: owning[0].sessionId.slice(0, 12),
        keptUnknownCwd: unknownCwd.map(s => s.sessionId.slice(0, 12)),
      });
      return [...owning, ...unknownCwd];
    }
    // No exact match — drop sessions demonstrably working elsewhere; keep
    // only those whose cwd is unknown (state files predating lastCwd).
    return unknownCwd;
  }
  return sessions;
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
    const incomingChatId =
      (typeof input.conversation_id === 'string' && input.conversation_id) ||
      (typeof input.session_id === 'string' && input.session_id) ||
      '';
    // No id to compare, or a state that hasn't locked one yet, is not evidence
    // of a mismatch — the first guard adopts in both cases, so must this.
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

// Exported for tests only (same reason as hookLookupSessionId): every hook that
// captures work routes through here, and its failure mode is silent — an ABORT
// in the log and a turn that never reaches the dashboard.
export function findStateForHook(hookCwd: string, claudeSessionId?: string, agentSlug?: string): { state: SessionState; saveCwd: string } | null {
  const repoPath = discoverGitRoot(hookCwd) || hookCwd;

  // Scan ONCE and reuse. This used to call listActiveSessions twice purely to
  // log the counts, then step 2 below called it a third time for the real work.
  // Each call resolves the git dir via `git rev-parse`, so on this blocking path
  // that was three redundant git round-trips before any decision was made —
  // measured at 3.15s of the 11.4s hook on a loaded Windows box.
  const sessionsInHookCwd = listActiveSessions(hookCwd);
  const sessionsInRepoPath = hookCwd !== repoPath ? listActiveSessions(repoPath) : [];
  // Last resort: the durable mirror outside `.git` — same recovery the git-hook
  // lookup already does, which this path was missing.
  //
  // listActiveSessions returns EARLY from its git-dir branch, so a session whose
  // state never reached `.git` is invisible here even though ~/.origin/sessions
  // holds it. That is not hypothetical: a Cursor session on `baton` (13:43:41,
  // prod unreachable) had its state written to the mirror and not to `.git`
  // until 13:45:55 — the file's birthtime. For those two minutes every
  // after-file-edit hook logged
  //   scanning {"sessionsInHookCwd":0,"sessionsInRepoPath":0,"tags":[]}
  //   ABORT: no session state
  // and the whole turn (src/index.js, src/parseArgs.test.js, README.md) was
  // dropped. The mirror had the session the entire time.
  //
  // Only consulted when BOTH repo-scoped scans are empty, so a healthy `.git`
  // still wins and this can never pull in a session the repo state disagrees
  // with. listMirroredSessionsForTree is itself strict about ownership — it
  // matches on repoPath/lastCwd/canonicalRepoPath for THIS tree only.
  let sessionsInMirror: SessionState[] = [];
  if (sessionsInHookCwd.length === 0 && sessionsInRepoPath.length === 0) {
    sessionsInMirror = listMirroredSessionsForTree(repoPath);
    if (sessionsInMirror.length === 0 && !samePathNormalized(hookCwd, repoPath)) {
      sessionsInMirror = listMirroredSessionsForTree(hookCwd);
    }
  }
  debugLog('findStateForHook', 'scanning', {
    hookCwd, repoPath,
    sessionsInHookCwd: sessionsInHookCwd.length,
    sessionsInRepoPath: sessionsInRepoPath.length,
    sessionsInMirror: sessionsInMirror.length,
    tags: [...sessionsInHookCwd, ...sessionsInRepoPath, ...sessionsInMirror].map(s => s.sessionTag),
  });

  // 1. If we have a claude session ID, try exact match.
  // The caller only passes claudeSessionId for agents with STABLE per-conversation
  // ids (Claude Code, Windsurf). If exact match fails for a stable agent, the
  // conversation is genuinely new — DO NOT fall through to "most recent active",
  // which silently merges unrelated Claude Code windows into one platform session.
  //
  // Codex 0.130 is special: its stdin `session_id` is the PER-TURN thread id,
  // which differs between SessionStart and Stop for the same codex launch. So
  // when codex's stop hook fires with an ID that doesn't match what
  // SessionStart saved, that's NOT a new conversation — it's the same codex
  // window's next turn. Fall through to agent-filtered match instead of
  // dropping the hook (which used to abort handleStop with "no exact match",
  // leaving the session's tool calls / diffs unattached on the dashboard).
  if (claudeSessionId) {
    const inRepo = findSessionByClaudeId(claudeSessionId, hookCwd)
      || (repoPath !== hookCwd ? findSessionByClaudeId(claudeSessionId, repoPath) : null);
    // findSessionByClaudeId reads the same repo-scoped state listActiveSessions
    // does, so it is blind in exactly the same way. Match the mirror on the
    // unified agent id too — otherwise a stable-id agent whose `.git` state is
    // missing returns null below ("new session needed") and starts a duplicate.
    const found = inRepo
      || sessionsInMirror.find(
        (s) => s.claudeSessionId === claudeSessionId
          || (s as { agentSessionId?: string }).agentSessionId === claudeSessionId,
      )
      || null;
    if (found) {
      debugLog('findStateForHook', 'exact match', { claudeSessionId, sessionId: found.sessionId, tag: found.sessionTag });
      return { state: found, saveCwd: found.repoPath || repoPath };
    }
    if (agentSlug === 'codex') {
      debugLog('findStateForHook', 'codex per-turn id mismatch — falling through to agent-filtered match', {
        claudeSessionId,
      });
      // intentionally NOT returning here; let the agent-filtered branch below run
    } else {
      debugLog('findStateForHook', 'no exact match for stable claudeSessionId — new session needed', { claudeSessionId, agentSlug });
      return null;
    }
  }

  // 2. Fall back to active sessions for this repo — reusing the scan above.
  let sessions = sessionsInHookCwd;
  if (sessions.length === 0 && repoPath !== hookCwd) {
    sessions = sessionsInRepoPath;
  }
  if (sessions.length === 0 && sessionsInMirror.length > 0) {
    sessions = sessionsInMirror;
    debugLog('findStateForHook', 'recovered session from the durable mirror — repo state was missing', {
      hookCwd, repoPath, count: sessions.length, sessionIds: sessions.map((s) => s.sessionId),
    });
  }

  if (sessions.length > 0) {
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    // Whenever the caller knows the agent slug, ONLY accept a session whose
    // own slug matches. Previously a single-active-session shortcut returned
    // the existing session unconditionally — that caused a fresh Cursor hook
    // to attach its prompt to a still-active Gemini session in the same repo
    // and the new turn ended up rendered as Gemini.
    if (agentSlug) {
      let matching = sessions.filter(s => sessionMatchesAgent(s, agentSlug));
      if (matching.length > 1) {
        // Same-agent tie (e.g. two Gemini windows): prefer the session whose
        // last-seen lifecycle cwd matches this hook's cwd — disambiguates
        // parallel worktrees, where each session works in its own directory.
        const cwdMatched = matching.filter(s => sameDir(s.lastCwd, hookCwd));
        if (cwdMatched.length > 0) matching = cwdMatched;
        // Two files for ONE session survived the merge guards (they race) —
        // take the one holding the turns, not whichever sorted first.
        matching = preferRicherSameSessionState(matching);
      }
      if (matching.length > 0) {
        const best = matching[0]; // already sorted by startedAt desc
        debugLog('findStateForHook', 'agent-filtered match', {
          agentSlug,
          model: best.model,
          sessionId: best.sessionId,
          tag: best.sessionTag,
          candidateCount: matching.length,
          totalSessions: sessions.length,
        });
        return { state: best, saveCwd: best.repoPath || repoPath };
      }
      // No matching-agent session — fall through to legacy path / auto-create.
      // Returning the most-recent session of a *different* agent would cause
      // cross-agent prompt mixing (the bug we just fixed).
      debugLog('findStateForHook', 'no matching-agent session', {
        agentSlug,
        totalSessions: sessions.length,
        sessionAgents: sessions.map(s => ({ id: s.sessionId, slug: s.agentSlug, model: s.model })),
      });
      return null;
    }

    // No agent slug from the caller. Single session with unknown agent is
    // safe to use; multiple is ambiguous and bails so the caller can decide.
    if (sessions.length === 1) {
      const best = sessions[0];
      debugLog('findStateForHook', 'single active session (no agent slug)', { sessionId: best.sessionId, model: best.model, tag: best.sessionTag });
      return { state: best, saveCwd: best.repoPath || repoPath };
    }

    // Multiple sessions, no agent slug: a session whose last-seen lifecycle
    // cwd matches this hook's cwd is unambiguous (parallel-worktree case —
    // each session works in its own directory).
    const cwdMatched = sessions.filter(s => sameDir(s.lastCwd, hookCwd));
    if (cwdMatched.length === 1) {
      const best = cwdMatched[0];
      debugLog('findStateForHook', 'disambiguated by lastCwd', {
        hookCwd, sessionId: best.sessionId, model: best.model, tag: best.sessionTag,
      });
      return { state: best, saveCwd: best.repoPath || repoPath };
    }

    debugLog('findStateForHook', 'ambiguous: multiple sessions, no agent slug', {
      claudeSessionId,
      totalSessions: sessions.length,
      sessionModels: sessions.map(s => ({ id: s.sessionId, model: s.model })),
    });
    return null;
  }

  // 3. Legacy: try untagged state file (backward compat before concurrent support)
  const legacy = loadSessionState(hookCwd) || (repoPath !== hookCwd ? loadSessionState(repoPath) : null);
  if (legacy) {
    debugLog('findStateForHook', 'legacy untagged match', { sessionId: legacy.sessionId });
    return { state: legacy, saveCwd: legacy.repoPath || repoPath };
  }

  debugLog('findStateForHook', 'no state found', { hookCwd, repoPath, claudeSessionId });
  return null;
}

// ─── Gemini Transcript Discovery ──────────────────────────────────────────

// (Gemini transcript discovery moved to ../agents/gemini.ts)

// (Cursor transcript discovery moved to ../agents/cursor.ts)

// (Codex session discovery moved to ../agents/codex.ts)

// (getGeminiPromptsTimeline moved to ../agents/gemini.ts)

/**
 * Pick the prompt that most likely produced this commit.
 *
 * 1. If we have explicit prompts in state (Claude path), use the latest one.
 * 2. Else discover the agent's prompts from its transcript (Codex/Gemini)
 *    and find the latest prompt whose timestamp ≤ the commit's timestamp.
 *    Falls back to the last prompt if no usable timestamps are present.
 */
function resolvePromptForCommit(
  state: SessionState | null,
  repoPath: string,
  commitTimestampMs: number,
): { promptIndex: number; promptText: string; total: number } {
  const fromState = state?.prompts || [];
  if (fromState.length > 0) {
    const idx = fromState.length - 1;
    return { promptIndex: idx, promptText: fromState[idx], total: fromState.length };
  }

  // Codex — anchored on the thread_id we locked at session-start so
  // concurrent codex threads in sibling repos can't pollute this timeline.
  const isCodex = isCodexLikeModel(state?.model);
  const codexThreadId = (state as any)?.agentSessionId || (state as any)?.claudeSessionId || undefined;
  let timeline: PromptTimelineEntry[] = isCodex ? getCodexPromptsTimeline(repoPath, codexThreadId) : [];

  // Gemini fallback
  if (timeline.length === 0 && state?.transcriptPath && fs.existsSync(state.transcriptPath)) {
    timeline = getGeminiPromptsTimeline(state.transcriptPath);
  }

  if (timeline.length === 0) {
    return { promptIndex: 0, promptText: '', total: 0 };
  }

  // Match commit to the latest prompt at-or-before commitTimestamp.
  let pickIdx = -1;
  for (let i = 0; i < timeline.length; i++) {
    const ts = timeline[i].timestamp;
    if (ts > 0 && ts <= commitTimestampMs) pickIdx = i;
    else if (ts === 0) pickIdx = i; // unknown timestamp — fall through
  }
  if (pickIdx < 0) pickIdx = timeline.length - 1;

  return {
    promptIndex: pickIdx,
    promptText: timeline[pickIdx].text,
    total: timeline.length,
  };
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
function maybeSpawnHistorySync(repoPath: string, workRoot: string): void {
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
function maybeSpawnMemoryBriefBackfill(repoPath: string): void {
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
 * Run the brief's LLM call in a DETACHED child.
 *
 * `force` distinguishes the two callers: the session-start BACKFILL only wants
 * to mint a brief where none exists (the child bails if one is cached), while
 * the REFRESH has already decided the cached one is stale and must go through.
 *
 * `recentDiff` rides along in the environment — it is bounded to 8000 chars by
 * the caller, far below any ARG_MAX concern, and it is what grounds the brief
 * in real code rather than only prior summaries.
 */
function spawnMemoryBriefChild(
  repoPath: string,
  source: string,
  opts?: { force?: boolean; recentDiff?: string },
): void {
  const bin = process.argv[1];
  if (!bin) return;
  const child = spawn(process.execPath, [bin, 'hooks', 'memory-brief-backfill'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,                                  // no stray console window on Windows
    env: {
      ...process.env,
      ORIGIN_BRIEF_REPO: repoPath,
      ...(opts?.force ? { ORIGIN_BRIEF_FORCE: '1' } : {}),
      ...(opts?.recentDiff ? { ORIGIN_BRIEF_DIFF: opts.recentDiff } : {}),
    },
  });
  child.unref();
  debugLog(source, 'memory brief child spawned', { repoPath, force: !!opts?.force });
}

/**
 * Decide whether the continuation brief needs regenerating, then hand the work
 * to a detached child instead of awaiting it.
 *
 * The refresh used to be `await`ed inline at session-end AND post-commit, with
 * LLM_CALL_TIMEOUT_MS at 60s. post-commit is a GIT hook, so `git commit` sat
 * there waiting on an LLM: prod logged `POST /sessions/memory-brief 13661ms`,
 * and 13.6s is the good case — the ceiling was a minute.
 *
 * Nothing needs it synchronously. buildMemoryBriefContext is cache-only by
 * design ("never generates here"), so the brief is only ever READ from cache at
 * injection; a refresh that lands a second later is picked up by the next
 * session exactly as the backfill path already assumes.
 *
 * The gating stays here and stays cheap — local file reads and a signature
 * compare — so an unchanged repo costs a couple of reads and spawns nothing.
 */
function scheduleMemoryBriefRefresh(
  repoPath: string,
  connected: boolean,
  source: string,
  recentDiff?: string,
): void {
  try {
    if (!connected || memorySummaryMode() !== 'llm') return;
    const entries = readAllSessionMemory(repoPath);
    if (readMemoryBrief(repoPath)?.signature === memoryBriefSignature(entries)) return; // unchanged
    if (!entries.some(isSubstantiveMemory)) return;
    spawnMemoryBriefChild(repoPath, source, {
      force: true,
      recentDiff: recentDiff ? recentDiff.slice(0, 8000) : undefined,
    });
  } catch (err: any) {
    debugLog(source, 'memory brief schedule failed (non-fatal)', { message: err?.message });
  }
}

// Entrypoint for the detached child (`origin hooks memory-brief-backfill`).
// Re-checks the cache before calling out: concurrent session starts race to
// spawn, and the first one home makes the rest a no-op.
export async function handleMemoryBriefBackfill(): Promise<void> {
  const repoPath = process.env.ORIGIN_BRIEF_REPO || getGitRoot(process.cwd());
  if (!repoPath || !isConnectedMode()) return;
  // A forced run comes from the REFRESH path, which already decided the cached
  // brief is stale — bailing on "one exists" would make every refresh a no-op.
  const force = process.env.ORIGIN_BRIEF_FORCE === '1';
  if (!force && readMemoryBrief(repoPath)) return;
  await maybeRefreshMemoryBrief(
    repoPath, true, 'memory-brief-backfill', process.env.ORIGIN_BRIEF_DIFF || undefined,
  );
}

// Entrypoint for the detached child (`origin hooks git-history-sync`).
// Re-checks the gate via syncRepoHistory (concurrent session starts race to
// spawn; the backfill lock serializes them) and runs the full
// advertise-and-backfill round with the long backfill timeout.
export async function handleHistorySync(): Promise<void> {
  const hookCwd = process.env.ORIGIN_HISTORY_CWD || process.cwd();
  const repoPath = process.env.ORIGIN_HISTORY_REPO || getGitRoot(hookCwd);
  if (!repoPath || !isConnectedMode()) return;
  try {
    const outcome = await syncRepoHistory({
      repoPath,
      hookCwd,
      ingest: (data) => api.ingestCommits(data, { timeoutMs: BACKFILL_TIMEOUT_MS }),
      log: (message, data) => debugLog('history-sync', message, data),
    });
    debugLog('history-sync', 'round complete', { ...outcome });
  } catch (err: any) {
    debugLog('history-sync', 'round failed (non-fatal)', { message: err?.message });
  }
}

/**
 * Normalize a workspace path as an agent reports it into one the OS accepts.
 *
 * Cursor sends its roots URI-style, so on Windows `C:\soft\origin-demo-1`
 * arrives as `/C:/soft/origin-demo-1` — the leading slash makes every
 * `getGitRoot()` probe fail. Because Cursor also runs hooks from `~/.cursor`
 * rather than the project dir, failing that probe silently fell through to
 * `process.cwd()`, i.e. `~/.cursor` — so the hook auto-created a session against
 * the wrong repo (or none at all) instead of the workspace the user was in.
 *
 * Strips the slash only for the `/<drive>:/…` shape, so POSIX paths and plain
 * Windows paths both pass through untouched.
 */
export function normalizeWorkspaceRoot(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null;
  let out = p;
  try { out = decodeURIComponent(out); } catch { /* not percent-encoded — use as-is */ }
  out = out.replace(/^file:\/\//i, '');
  const m = out.match(/^\/([A-Za-z]:[\\/].*)$/);
  return m ? m[1] : out;
}

/**
 * LOCAL turn number → the SERVER row it belongs to.
 *
 * `state.prompts` only ever holds the turns THIS launch saw, so every local
 * counter — `prompts.length - 1`, `activeTurn.index`, `lastClosedTurnIndex` —
 * is numbered from 0 regardless of how many turns the conversation already
 * had. Server rows are numbered from the turn's NATIVE position in the
 * transcript. The two spaces coincide only while `promptIndexBase` is 0, which
 * is every ordinary session — which is why writers that skipped this
 * conversion looked correct for so long.
 *
 * They diverge the moment a conversation is resumed, compacted or adopted:
 * `prompts` restarts, the base becomes N, and a writer using the raw local
 * index aims at row 0 — a row that already belongs to turn ONE. promptText is
 * first-write-wins server-side, so that row keeps its original text and
 * silently takes on the new turn's files, diff and commit sha: one turn's row
 * describing itself while containing another's work.
 *
 * Session 2e58a848: resumed at 21:55:59 with no history recovered, so the
 * retroactive capture wrote local index 0 while Stop — which does apply the
 * base — wrote 3. Both landed, and its `completedPromptMappings` ended up
 * holding the SAME prompt text at index 0 AND index 3.
 */
export function serverRowForLocalTurn(
  localIndex: number,
  promptIndexBase: number | undefined | null,
): number {
  if (!Number.isFinite(localIndex) || localIndex < 0) return localIndex;
  const base = Number.isFinite(promptIndexBase as number) ? (promptIndexBase as number) : 0;
  return base > 0 ? base + localIndex : localIndex;
}

/**
 * SERVER row → the LOCAL turn number it corresponds to. The inverse of
 * `serverRowForLocalTurn`, for reading state that is stored in local space
 * while holding an index that came from the transcript.
 *
 * `promptShadows` is exactly that: `recordPromptShadow` is its only writer and
 * keys on `prompts.length - 1`, so it is local — but the Stop and SessionEnd
 * capture paths look a turn's baseline up with `cap.promptIndex`, which
 * `capturePromptEdits` returns in transcript-native space.
 *
 * Returns null when the row predates our prompt list. That is the honest
 * answer for a turn that ran before this launch adopted the conversation: we
 * never recorded a start-state for it, and pretending row N is our local N
 * hands back a DIFFERENT turn's shadow — a baseline that silently rebases the
 * whole diff onto the wrong start-state.
 */
export function localTurnForServerRow(
  serverIndex: number,
  promptIndexBase: number | undefined | null,
): number | null {
  if (!Number.isFinite(serverIndex) || serverIndex < 0) return null;
  const base = Number.isFinite(promptIndexBase as number) ? (promptIndexBase as number) : 0;
  if (base <= 0) return serverIndex;
  const local = serverIndex - base;
  return local >= 0 ? local : null;
}

/**
 * `turnBaseline` for an index that arrived in SERVER space.
 *
 * A row we have no local shadow for falls back to the session's start-state,
 * which is exactly what turnBaseline already does for an unrecorded turn — so
 * a pre-adoption row degrades to "the session's start" instead of borrowing
 * some other turn's.
 */
function turnBaselineForServerRow(state: SessionState, serverIndex: number): string | null {
  const local = localTurnForServerRow(serverIndex, state.promptIndexBase);
  // -1 matches no shadow, so turnBaseline takes its own fallback path.
  return turnBaseline(state, local ?? -1);
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

async function handleSessionStart(input: Record<string, any>, agentSlug?: string): Promise<void> {
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
      const { ensurePolicyHookInstalled } = await import('./enable.js');
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
      const { ensurePolicyHookInstalled } = await import('./enable.js');
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
            const reuseDiff = (reuseSessionCommitted +
              (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
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
                existing.completedPromptMappings[existingIdx] = mapping;
              }
            } else {
              existing.completedPromptMappings.push(mapping);
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
            promptChanges: existing.completedPromptMappings.map(pm => {
              const dl = (pm.diff || '').split('\n');
              return {
                ...pm,
                promptText: (pm.promptText || '').slice(0, 1000),
                diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
                uncommittedDiff: (pm.uncommittedDiff || '').slice(0, MAX_PROMPT_DIFF_LEN),
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
    const existingAtTag = loadSessionState(reservationCwd, sessionTag);
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
    let syncBlock: import('../sync-block.js').SyncBlock | undefined;
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
    const sessionStartHead = getHeadSha(repoPath);
    const sessionStartDirty = getDirtyFiles(repoPath);
    let initialPrePromptSha = sessionStartHead;
    let initialPrePromptDirtyFiles = sessionStartDirty;
    // SHA of the dirty-tree snapshot taken at session start (full working
    // tree, tracked + untracked). The heartbeat diffs against this to keep
    // pre-existing dirt from being attributed to the session's prompts.
    let sessionStartShadowSha: string | null = null;
    if (sessionStartDirty.length > 0) {
      try {
        const startShadowTag = sessionTag || sessionId.slice(0, 12);
        const startShadow = createShadowCommit(repoPath, `start-${startShadowTag}`);
        if (startShadow) {
          initialPrePromptSha = startShadow;
          sessionStartShadowSha = startShadow;
          initialPrePromptDirtyFiles = [];
          debugLog('session-start', 'created session-start shadow', {
            shadow: startShadow.slice(0, 12),
            dirtyCount: sessionStartDirty.length,
          });
        }
      } catch (err: unknown) {
        debugLog('session-start', 'shadow creation failed (non-fatal)', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
      const onDisk = loadSessionState(saveCwd, sessionTag);
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
    try {
      const adopted = loadSessionState(saveCwd, sessionTag) as SessionState | null;
      const promoted = preferRegisteredSessionId(state.sessionId, adopted?.sessionId);
      if (promoted !== state.sessionId) {
        debugLog('session-start', 'a concurrent hook registered this session first — keeping its id', {
          ours: state.sessionId, theirs: promoted, sessionTag,
        });
        state.sessionId = promoted;
      }
    } catch { /* best-effort — never block session start */ }
    // Registration is settled by here (real id, or local after a failed call),
    // so the row is no longer a placeholder.
    delete (state as unknown as { pendingRegistration?: boolean }).pendingRegistration;

    saveSessionState(state, saveCwd, sessionTag);
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
      startHeartbeat(sessionId, hbApiUrl, hbApiKey, stateFile, finalAgentSlug);
      debugLog('session-start', 'heartbeat started', { sessionId, stateFile, agentSlug: finalAgentSlug, standalone: !connected });
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
        recordFullContextInjection(repoPath, hookLookupSessionId(input.session_id, agentSlug) || input.session_id);
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

/** Persist the budget signal carried on a session PATCH response. */
function applyBudgetSignal(state: SessionState, apiResponse: unknown, saveCwd: string): void {
  const budget = (apiResponse as any)?.budget;
  if (!budget || typeof budget !== 'object') return;
  const blocked = !!budget.blocked;
  const reason = typeof budget.message === 'string' ? budget.message : undefined;
  if (!!state.budgetBlocked === blocked && state.budgetBlockReason === (blocked ? reason : undefined)) return;
  state.budgetBlocked = blocked;
  state.budgetBlockReason = blocked ? reason : undefined;
  if (!blocked) state.budgetBlockReported = undefined; // next episode reports again
  try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
  debugLog('budget', blocked ? 'budget lockout SET' : 'budget lockout cleared', { reason });
}

/**
 * Hook-time gate. Re-checks the server while locked out (so the block
 * lifts the moment the period resets or an admin raises the cap — only
 * runs in the blocked state, so no steady-state API load), then blocks
 * or warns per the agent's capabilities. On re-check failure we keep
 * blocking: the last confirmed server state was "blocked", and the
 * override env is the documented escape hatch.
 */
async function enforceBudgetLockout(
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
function enforceSessionDurationLimit(
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

// Self-heal a session that started in local-only mode. When the
// session-start API call can't reach/authenticate the server, start falls
// back to a `local-` sessionId and the session lives only on disk — it
// never appears in Origin until something re-registers it. Previously that
// only happened in the stop handler, so a session whose stop never ran
// cleanly (crash, end-before-stop, still-offline-at-stop) stayed invisible
// forever. This re-registers on the server and persists the real id back to
// state. Idempotent: no-op for server-id sessions, when disconnected, or
// when the call fails again (stays local, retried on the next hook).
// Returns true when a migration succeeded this call.
/**
 * Does this API error mean "the server no longer has that session row"?
 *
 * The PATCH scope check in the API (`where: { id, commit: { repo: { orgId } } }`)
 * answers a missing row with the literal string below — distinct from the
 * router's generic `Not found`. A session can genuinely vanish under a live
 * agent: `/session/end`'s empty-session cleanup HARD-DELETES a row that still
 * has zero prompts/tokens server-side, which is exactly the state of a session
 * whose turn is captured locally but whose first PATCH hasn't landed yet.
 *
 * This is NOT retriable (update-queue correctly refuses to queue it — the id is
 * dead forever), but it must not be terminal either: the payload in hand is a
 * fully-captured turn. Callers re-register via ensureServerSession({ remintGone })
 * and send it to a fresh row instead of throwing the work away.
 */
/**
 * The checkout's `origin` remote URL, or undefined when it has none.
 *
 * Every session/start MUST carry this when it can. The server's repo resolver
 * reaches its GitHub-identity rung only via repoUrl (matching a row the UI's
 * import registered as "github.com/owner/repo"), and the row it auto-registers
 * stamps `fullName`/`provider` from it. Omit it and you get BOTH failure modes
 * at once: the existing row isn't found, so a duplicate keyed by the local path
 * is created, and that duplicate lands with `fullName: null` — which then
 * defeats the GitHub import's own dedup, so the split persists. Prod held two
 * rows each for `vodka`, `karamba` and `origin-test-repo` exactly this way.
 */
export function repoRemoteUrl(repoPath: string | undefined | null): string | undefined {
  if (!repoPath) return undefined;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      windowsHide: true,
      cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    }).trim();
    return url || undefined;
  } catch {
    return undefined; // local-only checkout, or not a repo — both fine
  }
}

export function isSessionGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /(^|\b)Session not found\b/i.test(msg);
}

export async function ensureServerSession(
  state: SessionState,
  saveCwd: string,
  agentSlug: string | undefined,
  scope: string,
  opts: { remintGone?: boolean } = {},
): Promise<boolean> {
  if (!isConnectedMode()) return false;
  // Normally this only promotes a `local-` session to the server. With
  // `remintGone` the caller has just been told the CURRENT server id is gone,
  // so a real (non-local) id is re-minted instead of being left to 404.
  const needsMint = state.sessionId
    && (state.sessionId.startsWith('local-') || opts.remintGone === true);
  if (!needsMint) return false;
  // Never push an ignored repo's local session up to the org (a `local-` session
  // can exist if it was created before the repo was ignored, or via a path that
  // skipped session-start). Keep it local-only.
  if (isRepoIgnored(state.canonicalRepoPath || state.repoPath || saveCwd)) {
    debugLog(scope, 'skip local→server migration: repo is on the ignore list', { local: state.sessionId, repoPath: state.repoPath });
    return false;
  }
  try {
    const agentConfig = loadAgentConfig();
    if (!agentConfig?.machineId) return false;
    debugLog(
      scope,
      opts.remintGone ? 're-minting session the server no longer has' : 'migrating local session to server',
      { previous: state.sessionId },
    );
    const startRes = await api.startSession({
      machineId: agentConfig.machineId,
      prompt: (state.prompts && state.prompts[0]) || '',
      model: isSpecificModel(state.model) ? state.model : 'claude',
      repoPath: state.canonicalRepoPath || state.repoPath || saveCwd,
      repoUrl: repoRemoteUrl(state.repoPath || state.canonicalRepoPath || saveCwd),
      agentSlug,
      branch: state.branch || undefined,
      agentSessionId: (state as any).agentSessionId || state.claudeSessionId,
    } as any);
    const newId = (startRes as any)?.sessionId;
    if (typeof newId === 'string' && newId && !newId.startsWith('local-')) {
      debugLog(scope, 'local session migrated', { from: state.sessionId, to: newId });
      state.sessionId = newId;
      try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
      return true;
    }
  } catch (err: any) {
    debugLog(scope, 'local→server migration failed (non-fatal)', { message: err?.message });
  }
  return false;
}

async function handleUserPromptSubmit(input: Record<string, any>, agentSlug?: string): Promise<void> {
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

  // ── Find session state using concurrent-aware lookup ────────────────────────
  // For agents with unstable session_id (Cursor, Codex), don't use it for lookup
  const stableAgents = STABLE_SESSION_ID_AGENTS;
  const lookupSessionId = hookLookupSessionId(input.session_id, agentSlug);
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
      const incomingChatId =
        (typeof input.conversation_id === 'string' && input.conversation_id) ||
        (typeof input.session_id === 'string' && input.session_id) ||
        '';
      if (incomingChatId) {
        if (!state.agentSessionId) {
          state.agentSessionId = incomingChatId;
        } else if (state.agentSessionId !== incomingChatId) {
          debugLog('user-prompt-submit', 'cursor: new chat id — detaching from prior state', {
            locked: state.agentSessionId,
            incoming: incomingChatId,
            priorOriginSession: state.sessionId,
          });
          state = null;
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
      saveSessionState(state, found!.saveCwd, state.sessionTag);
      // Self-heal a local-only session here too — every prompt is a retry
      // point, so a transient server outage at start no longer hides the
      // whole session from Origin until (or unless) stop runs.
      await ensureServerSession(state, found!.saveCwd, agentSlug, 'user-prompt-submit');
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
          debugLog('user-prompt-submit', 'recovered session from archive', {
            sessionId: bestCandidate.sessionId,
            tag: bestCandidate.sessionTag,
            ageMin: Math.round(bestAge / 60000),
          });
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
      const raced =
        racedCandidate && stateMatchesIncomingChat(racedCandidate.state, agentSlug, input)
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
        // Derived exactly as session-start derives its tag, from the same
        // conversation anchor. Using `session_id` here while session-start used
        // `claudeSessionId` is what put one Cursor chat in two files — Cursor
        // has no claudeSessionId, so session-start fell through to a timestamp
        // (`smtfv1cat`) while this path used the conversation (`ceb22e9b-221`).
        // Same string on both sides means the loser of the race finds the
        // winner's file instead of creating a second session.
        const autoTag = sessionTagFor(
          '', conversationAnchorId(agentSlug, input.conversation_id, input.session_id),
        );

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
            const autoAgentSessionId = resolveAutoAgentSessionId(agentSlug, input.conversation_id, input.session_id);
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
        const priorState = loadSessionState(repoPath, autoTag);
        const carriedPrompts = promptHistoryFromPriorState(priorState);
        if (carriedPrompts.length > 0) {
          debugLog('user-prompt-submit', 'auto-create re-attach — carrying prompt history', {
            tag: autoTag,
            carried: carriedPrompts.length,
            priorMappings: priorState?.completedPromptMappings?.length || 0,
            priorStatus: (priorState as any)?.status || null,
          });
        }
        state = {
          sessionId,
          claudeSessionId: input.session_id || '',
          transcriptPath: input.transcript_path || '',
          model,
          startedAt: priorState?.startedAt || new Date().toISOString(),
          prompts: carriedPrompts,
          completedPromptMappings: priorState?.completedPromptMappings,
          promptResponses: priorState?.promptResponses,
          promptShadows: priorState?.promptShadows,
          sessionCommitShas: priorState?.sessionCommitShas,
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
          canonicalRepoPath: canonicalRepoPath || undefined,
          headShaAtStart: getHeadSha(hookCwd),
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
          const fbTag = (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;
          const fbSessionStartDirty = getDirtyFiles(hookCwd);
          state = {
            sessionId: fbId,
            claudeSessionId: input.session_id || '',
            transcriptPath: input.transcript_path || '',
            model: fbModel,
            startedAt: new Date().toISOString(),
            prompts: [],
            repoPath,
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
  // If the raw prompt contains the literal Origin-managed marker, it's our own
  // AGENTS.md / CLAUDE.md content round-tripping through the agent (Codex
  // reads AGENTS.md natively and re-emits it as the first user turn). Drop
  // outright — it is never a real user input.
  const isOriginManagedEcho = rawPrompt.includes('<!-- origin-managed -->') ||
    /^#\s+AGENTS\.md instructions for /m.test(rawPrompt);
  // Filter out system/hook messages and internal agent tags that aren't real user prompts
  const prompt = isOriginManagedEcho ? '' : rawPrompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<task-id>[\s\S]*?<\/task-id>/g, '')
    .replace(/<tool-use-id>[\s\S]*?<\/tool-use-id>/g, '')
    .replace(/<output-file>[\s\S]*?<\/output-file>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, '')
    // Codex wraps AGENTS.md context in <INSTRUCTIONS>...</INSTRUCTIONS> on
    // its first user turn. Strip the envelope so any actual user text that
    // follows still makes it through. Same for <environment_context>
    // (Codex's session-init blob with cwd/shell/date) and
    // <user_instructions> (Codex's wrapper for AGENTS.md and friends).
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    // Cursor wraps each user message in <user_query>...</user_query>. Keep
    // the inner text so the dashboard shows "make little change and commit"
    // instead of "<user_query> make little change and commit </user_query>".
    .replace(/<user_query>([\s\S]*?)<\/user_query>/g, '$1')
    .trim();
  const isSystemMsg = !prompt || /^Stop hook feedback:|^Stop:Callback hook blocking error|^PostToolUse:.*hook|^PreToolUse:.*hook/i.test(prompt);
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
          // Get current HEAD + working-tree SHA for restore support.
          let prevCommitSha: string | null = null;
          let prevTreeSha: string | null = null;
          try {
            prevCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: state.repoPath || hookCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          } catch { /* ignore */ }
          prevTreeSha = getWorkingTreeSha(state.repoPath || hookCwd);
          const diffText = (sessionCommitted +
            (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
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
              state.completedPromptMappings[existingIdx] = prevMapping;
            } else {
              debugLog('user-prompt-submit', 'kept existing previous-prompt mapping (new diff was empty)', {
                promptIndex: prevPromptIdx,
              });
            }
          } else {
            state.completedPromptMappings.push(prevMapping);
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
    recordPromptShadow(state, state.prompts.length - 1, state.prePromptSha);
    // Stable identity for this turn, assigned once and never renumbered. The
    // server keys the PromptChange row on it, so a later reshuffle of the
    // prompt LIST cannot slide one turn's diff onto another turn's row.
    if (!state.promptTurnIds) state.promptTurnIds = [];
    const newTurnIdx = state.prompts.length - 1;
    if (!state.promptTurnIds[newTurnIdx]) {
      state.promptTurnIds[newTurnIdx] = `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }
    // Deliberately NOT opening a turn here. If one is already open this prompt
    // is queued behind it and must wait its turn; the next capture after Stop
    // binds it. Treating submit as "the current turn is now this one" is
    // exactly the bug this replaced.
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
    try {
      const config = loadConfig();
      if (config && isConnectedMode()) {
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
                  diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
                  linesAdded: dl.filter((l: string) => l.startsWith('+') && !l.startsWith('+++')).length,
                  linesRemoved: dl.filter((l: string) => l.startsWith('-') && !l.startsWith('---')).length,
                  ...(turnIdFor(state, pm.promptIndex) && { turnId: turnIdFor(state, pm.promptIndex) }),
                  ...captureStamp(),
                  aiPercentage: 100,
                  checkpointType: 'auto',
                };
              })
            : undefined,
        }).catch((err: any) => {
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

async function handleStop(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('stop', 'begin', { cwd: input.cwd, inputModel: input.model, agentSlug });

  const config = loadConfig();
  const connected = isConnectedMode();
  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = normalizeWorkspaceRoot(input.workspace_roots[0]);
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  let found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  let state = found?.state || null;
  // Recover from archive if .git state file is missing (Cursor/Codex sessions)
  if (!state) {
    try {
      const recoveryRepoPath = discoverGitRoot(hookCwd) || hookCwd;
      const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
      const archiveEntries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
      // The stop payload's conversation anchor (Cursor's conversation_id, else
      // session_id). An EXACT match on it recovers THIS chat's own session even
      // when its state file was mis-tagged or cleaned up — without it the
      // freshest-in-repo heuristic below missed a switched-away chat's session
      // and the auto-create fabricated a DUPLICATE (prod: an empty stub session
      // appeared next to the real one). An exact match wins even when ENDED:
      // adopting/re-opening the right session beats minting a duplicate.
      const incomingChatId = (typeof (input as any).conversation_id === 'string' && (input as any).conversation_id)
        || (typeof input.session_id === 'string' && input.session_id) || '';
      let bestCandidate: SessionState | null = null;
      let bestAge = Infinity;
      let exactMatch: SessionState | null = null;
      let exactAge = Infinity;
      for (const entry of archiveEntries) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
          if (!s?.sessionId || !s?.startedAt) continue;
          const age = Date.now() - new Date(s.startedAt).getTime();
          if (age > 24 * 60 * 60 * 1000) continue;
          if (s.repoPath !== recoveryRepoPath) continue;
          if (agentSlug && !sessionMatchesAgent(s, agentSlug)) continue;
          const chatId = s.agentSessionId || s.claudeSessionId || '';
          if (incomingChatId && chatId === incomingChatId) {
            if (age < exactAge) { exactMatch = s; exactAge = age; }
            continue;
          }
          if (s.status === 'ENDED' && s.endedAt) continue;
          if (age < bestAge) { bestCandidate = s; bestAge = age; }
        } catch { /* skip */ }
      }
      bestCandidate = exactMatch || bestCandidate;
      if (bestCandidate) {
        debugLog('stop', 'recovered session from archive', { sessionId: bestCandidate.sessionId, tag: bestCandidate.sessionTag });
        saveSessionState(bestCandidate, recoveryRepoPath, bestCandidate.sessionTag);
        state = bestCandidate;
        found = { state, saveCwd: recoveryRepoPath };
      }
    } catch { /* no archive */ }
  }
  if (!state) {
    // Cursor 2.x edge case: if the user was running Cursor while their
    // hooks.json had the now-invalid `agentSessionStart` name, no session-
    // start state was created. After upgrading + restarting Cursor, the
    // first agent reply fires `stop` with valid hook config — but our
    // handler used to abort here because no in-progress state was on disk,
    // and the session never reached the dashboard. Auto-create from the
    // stop-hook payload as a last resort. Mirror the user-prompt-submit
    // auto-create path; gated on cursor + valid workspace + session_id so
    // we don't accidentally fabricate sessions for other agents.
    const canAutoCreate = agentSlug === 'cursor'
      && connected
      && typeof input.session_id === 'string'
      && Array.isArray(input.workspace_roots)
      && input.workspace_roots.length > 0;
    if (canAutoCreate) {
      try {
        const autoConfig = loadConfig();
        const autoAgentConfig = loadAgentConfig();
        if (autoConfig?.apiKey && autoAgentConfig?.machineId) {
          const wsRoot = normalizeWorkspaceRoot(input.workspace_roots[0]);
          if (!wsRoot) throw new Error('unusable workspace_roots[0]');
          // Working root for capture (the worktree itself when wsRoot is
          // one); canonical for the server payload — same split as
          // session-start.
          const repoPath = getWorkingGitRoot(wsRoot) || discoverGitRoot(wsRoot) || wsRoot;
          const canonicalRepoPath = getCanonicalRepoPath(repoPath);
          const branch = getBranch(wsRoot) || getBranch(repoPath);
          const startRes = await api.startSession({
            machineId: autoAgentConfig.machineId,
            prompt: '',
            model: (typeof input.model === 'string' && input.model !== 'cursor' && input.model !== 'default' && input.model !== 'unknown') ? input.model : 'cursor',
            repoPath: canonicalRepoPath,
            repoUrl: repoRemoteUrl(repoPath) || undefined,
            agentSlug: 'cursor',
            branch: branch || undefined,
            // Anchor on the STABLE per-chat conversation_id (matching session-start
            // and the local state written below), NOT the rotating per-turn
            // session_id — otherwise the next turn's conversation_id-anchored start
            // can't match this server row and forks a twin that re-copies the
            // chat's prior prompts.
            agentSessionId: resolveAutoAgentSessionId('cursor', input.conversation_id, input.session_id),
          } as any);
          const newSessionId = (startRes as any)?.sessionId;
          if (typeof newSessionId === 'string' && newSessionId) {
            const autoTag = (input.session_id as string).slice(0, 12);
            const synthesizedDirty = getDirtyFiles(repoPath);
            const synthesized: SessionState = {
              sessionId: newSessionId,
              claudeSessionId: input.session_id,
              // Anchor the chat identity so a DIFFERENT Cursor chat's
              // session-start can't adopt this session. cursorSessionReusable
              // treats a session with no agentSessionId as "unknown → adopt",
              // so omitting it let the next chat in the same repo reuse this
              // one and glue its prompts on (prod efe174db: a new "basta" chat
              // reused this auto-created session and re-sent the prior chat's
              // 6 prompts). Resolve it EXACTLY as session-start does
              // (conversation_id preferred, else session_id) so the reuse
              // guard compares like-for-like — using the raw session_id here
              // while session-start anchors on conversation_id would block the
              // SAME chat's next turn from reusing this session.
              agentSessionId: (typeof input.conversation_id === 'string' && input.conversation_id)
                || (input.session_id as string),
              transcriptPath: input.transcript_path || '',
              model: typeof input.model === 'string' ? input.model : 'cursor',
              startedAt: new Date().toISOString(),
              prompts: [],
              repoPath,
              canonicalRepoPath,
              headShaAtStart: getHeadSha(repoPath),
              headShaAtLastStop: null,
              prePromptSha: getHeadSha(repoPath),
              prePromptDirtyFiles: synthesizedDirty,
              sessionStartDirtyFiles: synthesizedDirty,
              branch: branch || null,
              sessionTag: autoTag,
              agentSlug: 'cursor',
            };
            saveSessionState(synthesized, repoPath, autoTag);
            state = synthesized;
            found = { state: synthesized, saveCwd: repoPath };
            debugLog('stop', 'auto-created cursor session from stop-hook payload', {
              sessionId: newSessionId, repoPath, agentSessionId: input.session_id,
            });
          }
        }
      } catch (err: any) {
        debugLog('stop', 'cursor auto-create failed', { message: err?.message });
      }
    }
    if (!state) {
      debugLog('stop', 'ABORT: missing state', { hasConfig: !!config, hasState: false });
      return;
    }
  }

  // ── Dual-hook stop dedup ────────────────────────────────────────────────
  // The Devin CLI reads BOTH ~/.claude (claude-code) and ~/.devin (devin)
  // hook configs, so ONE agent turn fires Stop 2-3× — same session, same
  // stdin prompt_id — each creating a redundant auto-snapshot + updateSession
  // (observed: 3 snapshots for one turn). Skip a Stop whose prompt_id matches
  // the one we just processed on this session within the last 60s. The
  // dual-fire always lands within seconds; a genuinely later re-stop of the
  // same prompt still gets through. Safe for single-hook agents: Origin's Stop
  // hook never returns a block decision, so claude-code/Cursor/etc. never
  // legitimately re-fire Stop for one prompt_id (and agents that omit prompt_id
  // skip the guard entirely). Codex omits prompt_id but sends a stable per-turn
  // `turn_id`; it too is now dual-SOURCE (hooks.json + inline config.toml), so
  // fall back to turn_id to catch its double-fired Stop.
  {
    const stopPromptId =
      (typeof input.prompt_id === 'string' && input.prompt_id) ? input.prompt_id
      : (typeof input.turn_id === 'string' && input.turn_id) ? input.turn_id
      : '';
    if (stopPromptId && state.lastStopPromptId === stopPromptId && state.lastStopAt) {
      const sinceMs = Date.now() - new Date(state.lastStopAt).getTime();
      if (sinceMs >= 0 && sinceMs < 60_000) {
        debugLog('stop', 'SKIP duplicate stop (dual-hook double-fire)', { promptId: stopPromptId, agentSlug, sinceMs });
        return;
      }
    }
    if (stopPromptId) {
      state.lastStopPromptId = stopPromptId;
      state.lastStopAt = new Date().toISOString();
      saveSessionState(state, found?.saveCwd || state.repoPath || hookCwd, state.sessionTag);
    }
  }

  // For Codex specifically: the session may have been registered with a
  // misattributed repoPath when the user launched `codex` from `~` (or any
  // non-git directory). discoverGitRoot then walks into `.openclaw/workspace`
  // or whatever sibling git repo it finds first — so the session shows up on
  // the dashboard against the wrong repo, and the diff capture below runs
  // against a directory codex never touched (→ 0 files / 0 lines even when
  // codex committed). Codex itself records the thread's actual cwd in its
  // SQLite state DB; query for it and override state.repoPath if it differs.
  if (agentSlug === 'codex') {
    try {
      const codexData = discoverCodexSessionData(state.repoPath, {
        verbose: !!state.verboseCapture,
        threadId: state.agentSessionId || state.claudeSessionId || undefined,
      });
      const actualCwd = codexData?.cwd;
      if (actualCwd && actualCwd !== state.repoPath && fs.existsSync(actualCwd)) {
        debugLog('stop', 'codex repoPath correction', { from: state.repoPath, to: actualCwd });
        state.repoPath = actualCwd;
        saveSessionState(state, found!.saveCwd, state.sessionTag);
      }
    } catch (err: any) {
      debugLog('stop', 'codex cwd lookup failed (non-fatal)', { message: err?.message });
    }
  }

  // Update model from stdin if it's a real model name (Cursor sends actual model in stop, not session-start)
  if (input.model && input.model !== 'default' && input.model !== 'unknown' && input.model !== 'cursor') {
    state.model = input.model;
    debugLog('stop', 'model updated from stdin', { model: input.model });
  }

  // Update transcript path if provided
  if (input.transcript_path) {
    state.transcriptPath = input.transcript_path;
    saveSessionState(state, found!.saveCwd, state.sessionTag);
  }

  // Auto-discover Gemini transcript path if not already set
  if (!state.transcriptPath) {
    const discovered = discoverGeminiTranscriptPath({
      sessionId: state.agentSessionId || state.claudeSessionId || undefined,
    });
    if (discovered) {
      state.transcriptPath = discovered;
      saveSessionState(state, found!.saveCwd, state.sessionTag);
      debugLog('stop', 'auto-discovered transcript path', { discovered });
    }
  }

  try {
    debugLog('stop', 'parsing transcript', { transcriptPath: state.transcriptPath });
    const parsed = parseTranscript(state.transcriptPath, { since: state.startedAt, repoRoots: sessionRepoRoots(state) });

    // Format transcript for dashboard display (converts JSONL → [{role, content}] JSON)
    let displayTranscript = formatTranscriptForDisplay(state.transcriptPath, { verbose: !!state.verboseCapture });
    debugLog('stop', 'formatted transcript', { displayLength: displayTranscript.length });

    // For Cursor: discover agent transcript JSONL for real conversation data + better token estimates
    if (agentSlug === 'cursor' && parsed.tokensUsed === 0) {
      // Prefer session_id (Cursor 2.x stop hook stdin) over conversation_id
      // (older shape). The Cursor agent-transcripts directory name IS the
      // session_id, so this is what lets the discovery find the right chat
      // instead of falling back to "the most recently modified jsonl".
      const cursorId = (typeof input.session_id === 'string' ? input.session_id : undefined)
        || (typeof input.conversation_id === 'string' ? input.conversation_id : undefined);
      const cursorData = discoverCursorTranscript(cursorId, state.repoPath, { verbose: !!state.verboseCapture });
      if (cursorData) {
        debugLog('stop', 'supplementing with Cursor transcript data', {
          tokens: cursorData.tokensUsed,
          hasTranscript: !!cursorData.transcript,
        });
        parsed.tokensUsed = cursorData.tokensUsed;
        parsed.inputTokens = cursorData.inputTokens;
        parsed.outputTokens = cursorData.outputTokens;
        if (cursorData.transcript && !displayTranscript) {
          displayTranscript = cursorData.transcript;
        }
      } else if (!displayTranscript && input.conversation_id) {
        // Fallback: use conversation_summaries DB for a minimal transcript
        const summary = getCursorConversationSummary(input.conversation_id);
        if (summary) {
          debugLog('stop', 'cursor summary from DB (fallback)', { title: summary.title });
          const turns: Array<{ role: string; content: string }> = [];
          for (const p of state.prompts) {
            turns.push({ role: 'user', content: p });
            const responseParts: string[] = [];
            if (summary.tldr) responseParts.push(summary.tldr);
            if (summary.overview && summary.overview !== summary.tldr) responseParts.push(summary.overview);
            if (summary.summaryBullets) responseParts.push(summary.summaryBullets);
            if (responseParts.length > 0) {
              turns.push({ role: 'assistant', content: responseParts.join('\n\n') });
            }
          }
          if (turns.length > 0) {
            displayTranscript = JSON.stringify(turns);
          }
        }
      }
    }

    // For Codex: supplement with data from its SQLite database / rollout JSONL.
    // Gate on agentSlug so we don't accidentally pull Codex data into a
    // different agent's session. Always run for Codex sessions — the rollout
    // is the authoritative source for both tokens AND the full transcript
    // (assistant text, reasoning, tool I/O), so even when we already have
    // tokens we still want the richer transcript.
    const codexData = (agentSlug === 'codex')
      ? discoverCodexSessionData(state.repoPath, {
          verbose: !!state.verboseCapture,
          threadId: state.agentSessionId || state.claudeSessionId || undefined,
        })
      : null;
    if (codexData) {
      debugLog('stop', 'supplementing with Codex data', {
        model: codexData.model,
        tokens: codexData.tokensUsed,
        toolCalls: codexData.toolCalls,
        hasTranscript: !!codexData.transcript,
      });
      if (!parsed.model) parsed.model = codexData.model;
      if (parsed.tokensUsed === 0) {
        parsed.tokensUsed = codexData.tokensUsed;
        parsed.inputTokens = codexData.inputTokens;
        parsed.outputTokens = codexData.outputTokens;
        // Carry through the cached portion so estimateCost picks
        // up the cached-input rate (gpt-5.5: $0.50/M vs $5/M).
        if (codexData.cacheReadTokens !== undefined) {
          parsed.cacheReadTokens = codexData.cacheReadTokens;
        }
      }
      if (codexData.toolCalls > 0 && parsed.toolCalls === 0) {
        parsed.toolCalls = codexData.toolCalls;
      }
      // Sync state.prompts with every user prompt the rollout knows about.
      // Codex's UserPromptSubmit hook is unreliable (auto-trust gating,
      // config.toml feature-flag drift), so we can't count on state.prompts
      // growing turn-by-turn from that path. The rollout JSONL is the
      // authoritative source — pull every cleaned user message in order and
      // adopt it as state.prompts when the rollout has at least as many
      // entries as we currently track. Falling back to the singleton SQLite
      // first_user_message only when no rollout prompts are available.
      const rolloutPrompts = codexData.prompts || [];
      if (rolloutPrompts.length > state.prompts.length) {
        state.prompts = rolloutPrompts;
        debugLog('stop', 'synced state.prompts from rollout', {
          rolloutCount: rolloutPrompts.length,
        });
      } else if (codexData.prompt && state.prompts.length === 0) {
        state.prompts.push(codexData.prompt);
      }
      // Prefer the rollout-parsed transcript over the synthesized-from-prompts
      // fallback — it includes assistant text, reasoning, and tool I/O.
      if (codexData.transcript) {
        displayTranscript = codexData.transcript;
        debugLog('stop', 'using Codex rollout transcript', { length: displayTranscript.length });
      }

      // Backfill per-prompt diffs from the rollout + git history. Codex's
      // user-prompt-submit hook is unreliable, so for prompts where it didn't
      // fire we have no captured diff — only prompts 0-1 typically get
      // captured. Without this, AI Blame shows only those two prompts.
      // backfillCodexPromptMappings prefers TURN-SCOPED commit attribution
      // (walks the rollout's function_call_output events for [branch sha]
      // markers and pins each commit to the turn that produced it). Falls
      // back to timestamp-based mapping only when the rollout doesn't
      // surface a SHA for a given commit. Timestamps alone race against the
      // user typing the next prompt before the agent's commit lands —
      // exactly the bug that caused prompt N's work to show up under
      // prompt N+1 in AI Blame.
      try {
        const codexThreadId = state.agentSessionId || state.claudeSessionId || undefined;
        const timeline = getCodexPromptsTimeline(state.repoPath, codexThreadId);
        if (timeline.length > 0 && state.headShaAtStart) {
          const currentHead = getHeadSha(state.repoPath) || state.headShaAtStart;
          const rolloutFile = findCodexRolloutPath(state.repoPath, codexThreadId) || undefined;
          const backfilled = backfillCodexPromptMappings({
            repoPath: state.repoPath,
            headShaAtStart: state.headShaAtStart,
            headShaAtEnd: currentHead,
            prompts: timeline.map(t => ({ text: t.text, timestamp: t.timestamp })),
            rolloutFile,
          });
          if (backfilled.length > 0) {
            if (!state.completedPromptMappings) state.completedPromptMappings = [];
            // Merge: turn-scoped backfill always wins. The previous policy
            // ("existing wins if it has any diff") preserved bad data from
            // racy user-prompt-submit captures that attributed cross-turn
            // commits to the wrong prompt — i.e. the very bug this fix is
            // for. The rollout's per-turn `[branch sha]` mapping is now the
            // authoritative source of truth; uncommittedDiff data the
            // backfill can't see is rare for Codex and not worth keeping
            // wrong attribution to recover.
            for (const bf of backfilled) {
              const existingIdx = state.completedPromptMappings.findIndex(
                m => m.promptIndex === bf.promptIndex,
              );
              if (existingIdx >= 0) {
                state.completedPromptMappings[existingIdx] = bf;
              } else {
                state.completedPromptMappings.push(bf);
              }
            }
            state.completedPromptMappings.sort((a, b) => a.promptIndex - b.promptIndex);
            debugLog('stop', 'codex per-prompt backfill', {
              timelineCount: timeline.length,
              backfilledCount: backfilled.length,
              totalMappings: state.completedPromptMappings.length,
            });
          }

          // Clean up two classes of bogus per-prompt mappings that
          // user-prompt-submit's retroactive capture path produces for
          // Codex sessions:
          //
          //   1. AGENTS.md-only mappings — the agent didn't touch any user
          //      file in this turn; the diff is just Origin's auto-created
          //      AGENTS.md being churned by the system. Counting that as
          //      "this prompt did work" misattributes a real prompt to
          //      bookkeeping noise.
          //
          //   2. Consecutive duplicates — when the user types prompt N+1
          //      before the agent finishes prompt N's work, the retroactive
          //      capture snapshots the SAME state for N and N+1, leaving
          //      pc[N+1] = pc[N]. Show as no-op so the real prompt's work
          //      doesn't get split across two attribution slots.
          //
          // Backfill's own output is unique per prompt (rollout SHAs are
          // 1:1), so neither pattern can be backfill-produced — safe to
          // clear without risking authentic data.
          if (state.completedPromptMappings && state.completedPromptMappings.length > 0) {
            const sorted = state.completedPromptMappings
              .slice()
              .sort((a, b) => a.promptIndex - b.promptIndex);
            let cleared = 0;
            const clearTarget = (idx: number) => {
              const target = state.completedPromptMappings!.find(m => m.promptIndex === idx);
              if (!target) return false;
              target.diff = '';
              (target as { uncommittedDiff?: string }).uncommittedDiff = '';
              target.filesChanged = [];
              return true;
            };
            // Pass 1 — AGENTS.md-only mappings.
            for (const m of sorted) {
              if (!m.diff) continue;
              const headers: string[] = [];
              for (const h of m.diff.matchAll(/^diff --git a\/(.+?)\s+b\/(.+)$/gm)) {
                headers.push(h[2]);
              }
              if (headers.length > 0 && headers.every(h => h === 'AGENTS.md')) {
                if (clearTarget(m.promptIndex)) cleared++;
              }
            }
            // Pass 2 — consecutive duplicates (compare pc.diff alone since
            // that's what the blame algorithm parses; uncommittedDiff is
            // metadata only).
            const sortedAfter = state.completedPromptMappings
              .slice()
              .sort((a, b) => a.promptIndex - b.promptIndex);
            for (let i = 1; i < sortedAfter.length; i++) {
              const prev = sortedAfter[i - 1];
              const curr = sortedAfter[i];
              const prevDiff = prev.diff || '';
              const currDiff = curr.diff || '';
              if (currDiff && currDiff === prevDiff) {
                if (clearTarget(curr.promptIndex)) cleared++;
              }
            }
            if (cleared > 0) {
              debugLog('stop', 'cleared bogus prompt mappings', { cleared });
            }
          }
        }
      } catch (err: unknown) {
        debugLog('stop', 'codex per-prompt backfill failed (non-fatal)', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Gemini stop hook ships the assistant's reply on stdin as
    // `prompt_response`. Claude Code's stop hook uses `last_assistant_message`
    // for the same purpose. Both agents' transcript files are sometimes empty
    // / unflushed at stop time (especially Claude Code running inside a
    // .claude/worktrees/* worktree — the JSONL hasn't been finalized when
    // the stop hook fires). Capture either onto state.promptResponses so the
    // synthesized transcript below includes the assistant turn instead of
    // only the user prompt.
    const stopHookReply =
      (typeof input.prompt_response === 'string' && input.prompt_response.trim() && input.prompt_response) ||
      (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim() && input.last_assistant_message) ||
      '';
    if (stopHookReply) {
      if (!state.promptResponses) state.promptResponses = [];
      const currentIdx = Math.max(state.prompts.length - 1, 0);
      // Replace if we already have one for this index (in case Stop fires
      // twice for the same turn — rare but observed).
      state.promptResponses[currentIdx] = stopHookReply;
      debugLog('stop', 'captured stop-hook reply from stdin', {
        promptIndex: currentIdx,
        length: stopHookReply.length,
        source: input.prompt_response ? 'prompt_response' : 'last_assistant_message',
      });
    }

    // Devin CLI: its hooks carry only the prompt (no transcript_path / tokens /
    // output), but the CLI writes a plaintext ATIF transcript at
    // ~/.local/share/devin/cli/transcripts/<devin-id>.json. Read it to recover
    // the real model (SWE-1.6, not the generic "claude"), real token metrics,
    // tool-call count, and the assistant's output — so a Devin CLI session
    // shows response + cost instead of prompt-only + $0.00.
    //
    // Re-tag first: Devin reuses Claude Code's hooks, so a Devin run with only
    // the claude-code hook installed arrives here as agentSlug='claude-code'.
    // Detect via the process tree (this hook is a descendant of `devin`), then
    // flip the slug so the enrichment below runs AND every outbound payload
    // (`agentSlug || state.agentSlug`) tags the session devin.
    if ((retagDevinFromProcess(agentSlug) === 'devin' || state.agentSlug === 'devin') && agentSlug !== 'devin') {
      debugLog('stop', 're-tagging claude-code hook as devin (process or prior state)', {});
      agentSlug = 'devin';
      state.agentSlug = 'devin';
    }
    // Real per-prompt submission times from Devin's DB (see below) — used to
    // correct the promptChange.createdAt the outbound PATCH carries.
    let devinPromptTimes: (string | undefined)[] | undefined;
    if (agentSlug === 'devin') {
      // The hook's session_id does NOT match the transcript filename, so locate
      // PRIMARY source: Devin's LIVE sessions.db, keyed by the SAME id the hook
      // received. Devin writes the ATIF transcript only when a conversation
      // ENDS, so mid-conversation there is no file — but sessions.db already
      // holds the model, every message and per-message token metrics. Reading it
      // here is what makes a Devin turn capture its response/tokens/tools at the
      // time it happens instead of never (reported: "32 tokens", "No response
      // captured"). Falls through to the transcript path when unavailable.
      const devinLiveId = state.claudeSessionId || state.agentSessionId || input.session_id;
      const devinLive = typeof devinLiveId === 'string' && devinLiveId
        ? readDevinLiveSession(devinLiveId)
        : null;
      if (devinLive) {
        debugLog('stop', 'devin live sessions.db capture', {
          sessionId: devinLiveId, model: devinLive.model, tokens: devinLive.tokensUsed,
          toolCalls: devinLive.toolCalls, hasTranscript: !!devinLive.transcript,
        });
        if (devinLive.model && isSpecificModel(devinLive.model)) parsed.model = devinLive.model;
        if (devinLive.tokensUsed > 0) {
          parsed.tokensUsed = devinLive.tokensUsed;
          parsed.inputTokens = devinLive.inputTokens;
          parsed.outputTokens = devinLive.outputTokens;
          parsed.cacheReadTokens = devinLive.cacheReadTokens;
        }
        if (devinLive.toolCalls > 0) parsed.toolCalls = devinLive.toolCalls;
        if (devinLive.transcript) displayTranscript = devinLive.transcript;
        if (devinLive.promptTimes.some(Boolean)) devinPromptTimes = devinLive.promptTimes;
      }
      // the transcript by its content — the run's prompt(s) — not by id.
      const devinData = devinLive ? null : discoverDevinCliSessionDataByPrompt(state.prompts || [], { since: state.startedAt });
      if (devinData) {
        debugLog('stop', 'supplementing with Devin CLI transcript', {
          model: devinData.model, tokens: devinData.tokensUsed,
          toolCalls: devinData.toolCalls, prompts: devinData.prompts.length,
          hasTranscript: !!devinData.transcript,
        });
        // Model / tokens / tool-calls are session-level (ATIF final_metrics is
        // cumulative), so recovering them from any matched transcript is safe.
        if (devinData.model && isSpecificModel(devinData.model)) parsed.model = devinData.model;
        if (parsed.tokensUsed === 0 && devinData.tokensUsed > 0) {
          parsed.tokensUsed = devinData.tokensUsed;
          parsed.inputTokens = devinData.inputTokens;
          parsed.outputTokens = devinData.outputTokens;
          parsed.cacheReadTokens = devinData.cacheReadTokens;
        }
        if (devinData.toolCalls > 0 && parsed.toolCalls === 0) {
          parsed.toolCalls = devinData.toolCalls;
        }
        // Output is PER-TURN: only adopt the transcript when it is THIS turn's
        // (its prompts include the current prompt). Adopting an earlier turn's
        // transcript for a later turn is exactly what made a captured response
        // "disappear" and be replaced. If the current turn's transcript isn't
        // written yet, leave displayTranscript to the prompt-synthesized fallback
        // below rather than clobbering it. Never mutate state.prompts here — the
        // hook's own per-turn prompt capture owns the turn structure.
        const currentPrompt = ((state.prompts || [])[(state.prompts || []).length - 1] || '').trim();
        const isCurrentTurn = !!currentPrompt && devinData.prompts.some((p) => {
          const t = p.trim();
          return t === currentPrompt || t.includes(currentPrompt) || currentPrompt.includes(t);
        });
        if (isCurrentTurn && devinData.transcript) {
          displayTranscript = devinData.transcript;
          debugLog('stop', 'using Devin CLI transcript (current turn)', { length: displayTranscript.length });
        }
      }
      // Devin writes its ATIF transcript only when the CONVERSATION ends, so a
      // live turn usually has nothing to read — the turn would land with no
      // response, no tool count and a prompt-text token estimate. Queue it; the
      // next Devin hook (by which time the transcript exists) backfills it.
      if (!devinLive && (!devinData || !devinData.transcript)) {
        queueDevinBackfill({
          sessionId: state.sessionId,
          prompts: state.prompts || [],
          startedAt: state.startedAt,
        });
        debugLog('stop', 'queued Devin backfill (transcript not written yet)', {
          sessionId: state.sessionId, prompts: (state.prompts || []).length,
        });
      }
    }

    // For Codex (and other agents without transcripts): synthesize displayTranscript from captured prompts
    if (!displayTranscript && state.prompts.length > 0) {
      const turns: Array<{ role: string; content: string }> = [];
      // Include the system message so users can see what context was injected
      if (state.agentSystemPrompt) {
        turns.push({ role: 'system', content: state.agentSystemPrompt });
      }
      const responses = state.promptResponses || [];
      for (let i = 0; i < state.prompts.length; i++) {
        turns.push({ role: 'user', content: state.prompts[i] });
        // Interleave the assistant reply we captured (Gemini, agents
        // without transcripts) so the dashboard shows the response.
        if (responses[i]) {
          turns.push({ role: 'assistant', content: responses[i] });
        }
      }
      displayTranscript = JSON.stringify(turns);
      debugLog('stop', 'synthesized transcript from prompts', {
        turnCount: turns.length, responseCount: responses.filter(Boolean).length,
      });
    }

    // Whether the token figures below are ESTIMATED (heuristic) rather than
    // real usage. Flagged into the payload so money/efficiency dashboards and
    // the benchmark "measured" subset can exclude/badge them — otherwise a
    // fabricated cost reads as exact spend and skews cross-agent comparisons.
    let tokensEstimated = false;

    // Estimate tokens from prompt text when no real token data exists (Codex, agents without transcripts)
    if (parsed.tokensUsed === 0 && state.prompts.length > 0) {
      const totalPromptChars = state.prompts.reduce((sum, p) => sum + p.length, 0);
      // ~4 chars per token for English, assume 3:1 output:input ratio for coding tasks
      const estimatedInputTokens = Math.round(totalPromptChars / 4);
      const estimatedOutputTokens = estimatedInputTokens * 3;
      parsed.inputTokens = estimatedInputTokens;
      parsed.outputTokens = estimatedOutputTokens;
      parsed.tokensUsed = estimatedInputTokens + estimatedOutputTokens;
      tokensEstimated = true;
      debugLog('stop', 'estimated tokens from prompt text', { totalPromptChars, estimatedInputTokens, estimatedOutputTokens });
    }

    // Cursor never exposes real token counts — its parser derives them from
    // transcript character counts (agents/cursor.ts), so ANY Cursor token
    // figure is an estimate, even when non-zero (so the chars/4 fallback above
    // didn't fire). Mark it accordingly.
    if (agentSlug === 'cursor' && parsed.tokensUsed > 0) tokensEstimated = true;

    // Prompt history, reconciled so the index space only ever grows. Taking
    // the transcript's list outright renumbered every turn once Claude Code
    // rolled the transcript out from under a long session (0a8e2164).
    const prompts = reconcilePromptHistory(state.prompts, parsed.prompts);
    if (prompts.length > (state.prompts?.length || 0)) state.prompts = [...prompts];

    // F9: Redact secrets before sending to API
    const config_ = loadConfig();
    const shouldRedact = config_?.secretRedaction !== false; // default: true
    const redactedPrompts = shouldRedact
      ? prompts.map(p => redactSecrets(p).redacted)
      : prompts;
    const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    // Prefer: stdin model → Cursor DB → transcript → state
    const stdinModel = (input.model && input.model !== 'default' && input.model !== 'unknown') ? input.model : '';
    let model = stdinModel || parsed.model || state.model;
    // If still generic, try Cursor's SQLite DB
    if ((!model || model === 'cursor' || model === 'default') && agentSlug === 'cursor' && input.conversation_id) {
      const cursorDbModel = getCursorModelFromDb(input.conversation_id);
      if (cursorDbModel) {
        model = cursorDbModel;
        debugLog('stop', 'model from Cursor DB', { model: cursorDbModel });
      } else {
        // DB read failed or returned nothing — we'll bill at sonnet (cursor key) rates
        // but the real model could be cheaper (gpt-4o-mini) or more expensive. Log it
        // so we can spot systematic mispricing in aggregate.
        debugLog('stop', 'cursor model fallback (DB lookup failed)', {
          conversationId: input.conversation_id,
          finalModel: model || 'cursor',
        });
      }
    }
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens, { cacheCreation1hTokens: parsed.cacheCreation1hTokens });

    // Extract prompt → file change mappings
    let promptMappings = extractPromptFileMappings(state.transcriptPath, { since: state.startedAt, repoRoots: sessionRepoRoots(state) });
    debugLog('stop', 'prompt mappings', { count: promptMappings.length });

    // Fall back to git-captured files if transcript parsing didn't find any
    // Use per-prompt baseline: prePromptSha (set at prompt start) > headShaAtLastStop > headShaAtStart
    const promptBaseline = state.prePromptSha || state.headShaAtLastStop || state.headShaAtStart;
    // fullContext: per-prompt diff feeds AI Blame's replay. Full-file
    // context lets every editsJson edit anchor at an exact position.
    const gitCapture = captureGitState(state.repoPath, promptBaseline, { fullContext: true });
    // A shared checkout means `promptBaseline..HEAD` can contain another
    // agent's commits. Drop them before anything downstream reads the range,
    // and remember their files so they can't reach this turn's diff either
    // (the shadow baseline predates them, so workingTreeDiff carries them too).
    // Files THIS TURN shows it edited are never excluded — if we really touched
    // a file, a concurrent commit to it doesn't erase our work.
    //
    // "This turn" has to mean this turn. The exemption used to read
    // `parsed.filesChanged`, which is `parseTranscript(..., { since:
    // state.startedAt })` — the whole SESSION — so a file ANY earlier turn had
    // touched was exempt forever after. On session 3dbff831 the drop fired
    // correctly (`dropped: [3ea12b50, 18ea4f98], files: 6`) and then this
    // filter handed one of them straight back: #1377 changed
    // apps/api/src/routes/sessions.ts by +31/-2, an earlier turn of ours had
    // edited that path, and the release turn — which edited nothing at all —
    // was billed exactly +31/-2 for another PR's work.
    //
    // The turn's own evidence is its transcript mapping plus its live ledger;
    // the ledger covers tool calls the transcript hasn't flushed yet. With no
    // evidence from either, nothing is exempt, which is the right answer for a
    // turn that did not author anything.
    //
    // Both index spaces, because the two sources are numbered differently:
    // `promptMappings` is transcript-native, the ledger is local. Handing the
    // local counter to both is the same conflation `serverRowForLocalTurn`
    // exists to prevent, and it re-opens exactly this defect on any resumed,
    // compacted or adopted conversation — where base B makes local L select
    // native row L, i.e. our own turn L − B.
    //
    // `state.promptIndexBase` is refreshed from `parsed` further down, so read
    // the authoritative parse here and take the larger of the two: the base
    // only ever grows, and a base that shrank would aim this back at row 0.
    const localTurnIdx = Math.max((state.prompts?.length || 0) - 1, 0);
    const ownFilesThisTurn = filesOwnedByTurn(
      state,
      promptMappings,
      serverRowForLocalTurn(
        localTurnIdx,
        Math.max(parsed.promptIndexBase || 0, state.promptIndexBase || 0),
      ),
      localTurnIdx,
    );
    const foreignCommitFiles = dropForeignCommitsFromCapture(state.repoPath, state, gitCapture)
      .filter((f) => !ownFilesThisTurn.some((own) => own === f || own.endsWith(`/${f}`) || f.endsWith(`/${own}`)));
    // Every diff this turn stores is filtered through this list: pre-existing
    // dirt, other live sessions' files, and now the files a concurrent commit
    // moved under us.
    const turnExcludeFiles = foreignCommitFiles.length > 0
      ? [...uncommittedExcludeUnion(state), ...foreignCommitFiles]
      : uncommittedExcludeUnion(state);
    let filesChanged = parsed.filesChanged;
    if (filesChanged.length === 0 && gitCapture.commitDetails.length > 0) {
      const gitFiles = new Set<string>();
      for (const commit of gitCapture.commitDetails) {
        for (const f of commit.filesChanged) gitFiles.add(f);
      }
      filesChanged = Array.from(gitFiles);
      debugLog('stop', 'using git-captured files (transcript had none)', { count: filesChanged.length });
    }

    // Multi-repo: capture diffs from all repos and prefix file paths with repo dir name
    if (state.repoPaths && state.repoPaths.length > 1 && state.perRepoState) {
      const multiRepoFiles = new Set<string>();
      for (const rp of state.repoPaths) {
        const rpState = state.perRepoState[rp];
        if (!rpState) continue;
        const rpBaseline = rpState.prePromptSha || rpState.headShaAtLastStop || rpState.headShaAtStart;
        const rpCapture = captureGitState(rp, rpBaseline, { fullContext: true });
        const repoDir = path.basename(rp);
        for (const c of rpCapture.commitDetails) {
          for (const f of c.filesChanged) multiRepoFiles.add(`${repoDir}/${f}`);
        }
        if (rpCapture.uncommittedDiff) {
          const filteredUncommitted = filterUncommittedDiff(rpCapture.uncommittedDiff, rpState.prePromptDirtyFiles || []);
          if (filteredUncommitted) {
            for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) multiRepoFiles.add(`${repoDir}/${m[1]}`);
            }
          }
        }
      }
      if (multiRepoFiles.size > 0) {
        filesChanged = Array.from(multiRepoFiles);
        debugLog('stop', 'multi-repo filesChanged', { count: filesChanged.length });
      }
    }

    // Build prompt→file mappings for the current prompt.
    // Always merge with previously saved mappings so the API's deleteMany+recreate
    // doesn't lose older prompts.
    {
      const previousMappings = state.completedPromptMappings || [];
      // `prompts` is session-relative; mapping rows are numbered by their
      // NATIVE position in the transcript. On an adopted session those differ
      // by exactly the turns that ran before Origin joined, so the counter has
      // to be rebased or it points at somebody else's row. The text-homing
      // guard below would usually rescue it, but not reliably: this very
      // session's prompt list contains "[Request interrupted by user]" twice
      // and "Try again", and homing on repeated text is a guess.
      const countedPromptIdx = parsed.promptIndexBase + prompts.length - 1;
      // Refresh the cached base from the authoritative parse, so the hooks that
      // cannot afford one (user-prompt-submit's retroactive capture, the
      // session-start reuse capture) convert local→server the same way this
      // line does. Never let it go backwards: those hooks run BETWEEN stops,
      // and a base that shrank would put them back on row 0.
      if (parsed.promptIndexBase > (state.promptIndexBase || 0)) {
        state.promptIndexBase = parsed.promptIndexBase;
      }
      const currentPromptText = prompts[prompts.length - 1] || '';
      // The transcript owns prompt numbering; our index is a length counter.
      // When they disagree, writing at the counter's index hands this turn's
      // diff to a DIFFERENT turn (prod: a read-only turn owning +665 lines and
      // another session's commit). Re-home to the row whose prompt text
      // matches, or write nothing this turn — the capture retries on the next
      // Stop, an overwritten row does not.
      const homedPromptIdx = homePromptIndexByText(countedPromptIdx, currentPromptText, promptMappings);
      const currentPromptIdx = homedPromptIdx ?? countedPromptIdx;
      const indexUnsafe = homedPromptIdx === null;
      if (indexUnsafe || homedPromptIdx !== countedPromptIdx) {
        debugLog('stop', 'current-prompt index disagrees with the transcript', {
          counted: countedPromptIdx,
          homed: homedPromptIdx,
          promptText: currentPromptText.slice(0, 60),
          transcriptPrompts: promptMappings.length,
        });
      }

      if (promptMappings.length === 0 && prompts.length > 0 && !indexUnsafe) {
        // No transcript-based mappings — synthesize from git for current prompt.
        // Filter uncommitted diff against the prompt-baseline + session-start
        // pre-existing dirt union.
        const filteredUncommitted = filterUncommittedDiff(
          gitCapture.uncommittedDiff || '', turnExcludeFiles,
        );
        // Hard gate: if the agent didn't commit anything AND the transcript
        // shows no Edit/Write tool calls, the user is just chatting and the
        // dirty working tree existed before this prompt. Attribute an empty
        // mapping so the dashboard reflects "no code changes" instead of
        // sweeping in unrelated uncommitted work. filteredUncommitted is the
        // backstop — when prePromptDirtyFiles missed something (path-format
        // drift, race after a stop reset, …), the absence of commits +
        // transcript edits is a stronger signal.
        const noCommits = (gitCapture.commitDetails?.length ?? 0) === 0;
        const noTranscriptEdits = parsed.filesChanged.length === 0;
        // Cursor mid-turn defense (mirrors the safety-net guard below):
        // working-tree edits without commits/transcript signal still
        // count as a code turn. filteredUncommitted is what's actually
        // attributable to THIS turn after the per-prompt exclude list
        // strips prior-turn carryover.
        // Both diffs filtered — see the note on the safety-net branch below. A
        // raw workingTreeDiff carries pre-existing dirt when the baseline is not
        // a shadow, which keeps a genuinely chat-only turn out of this branch.
        const noUncommittedChanges =
          !filteredUncommitted &&
          !(gitCapture.workingTreeDiff
            ? filterUncommittedDiff(gitCapture.workingTreeDiff, turnExcludeFiles)
            : '');
        if (noCommits && noTranscriptEdits && noUncommittedChanges) {
          const currentMapping = {
            promptIndex: currentPromptIdx,
            promptText: currentPromptText.slice(0, 1000),
            filesChanged: [] as string[],
            diff: '',
            uncommittedDiff: '',
            // Marker so the next user-prompt-submit's retroactive
            // capture path doesn't overwrite this with whatever dirty
            // working-tree state still exists.
            chatOnly: true as const,
          };
          promptMappings = [...previousMappings, currentMapping];
          debugLog('stop', 'chat-only prompt — synthesized empty mapping', {
            promptIndex: currentPromptIdx,
            uncommittedAfterFilter: filteredUncommitted.length,
          });
        } else {
          const uncommittedFiles: string[] = [];
          if (filteredUncommitted) {
            for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          // When prePromptSha is a shadow commit, use workingTreeDiff —
          // committedDiff would be the reverse-direction text against the
          // shadow's content. Apply the SAME pre-existing-dirt exclusion the
          // non-shadow branch uses: without it a shadow-baseline turn claims
          // files that were already dirty when the session started (another
          // session's leftovers, e.g. `popcorn`/`utils.js`), inflating the
          // turn's file + line counts and crediting it with foreign work.
          const useWorkingTreeDiff = gitCapture.baselineIsShadow && gitCapture.workingTreeDiff;
          const filteredWorkingTree = useWorkingTreeDiff
            ? filterUncommittedDiff(gitCapture.workingTreeDiff, turnExcludeFiles)
            : '';
          if (useWorkingTreeDiff) {
            // Pull file list out of the FILTERED working-tree diff (which is
            // what we'll actually store) so filesChanged matches the diff.
            for (const m of filteredWorkingTree.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          const allFiles = new Set([...filesChanged, ...uncommittedFiles]);
          const synthDiff = useWorkingTreeDiff
            ? filteredWorkingTree
            : (((gitCapture.committedDiff || '') + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim());
          // Capture commit/tree SHAs so the commit-detail page can link
          // this prompt to the commit it produced.
          let synthCommitSha: string | null = null;
          let synthTreeSha: string | null = null;
          try {
            synthCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            synthTreeSha = getWorkingTreeSha(state.repoPath);
          } catch { /* ignore */ }
          const currentMapping = {
            promptIndex: currentPromptIdx,
            promptText: currentPromptText.slice(0, 1000),
            filesChanged: Array.from(allFiles),
            diff: synthDiff.slice(0, 200_000),
            uncommittedDiff: filteredUncommitted.slice(0, 200_000),
            commitSha: synthCommitSha,
            treeSha: synthTreeSha,
          };
          promptMappings = [...previousMappings, currentMapping];
        }
      } else if (promptMappings.length > 0 && previousMappings.length > 0) {
        // Transcript gave us mappings for the current prompt — merge with the
        // saved ones. An EMPTY transcript mapping must not evict a saved one
        // that has content: the transcript emits an entry per prompt whether
        // or not it found files, and it cannot see shell writes at all.
        //
        // The session-end path got this fix first (#1276), but THIS is the
        // path that actually fires. Measured after that release, on this very
        // session: the stop sent 12 mappings of which indices 0-7 and 10-11
        // were empty, and the rows they landed on lost their file lists.
        promptMappings = mergePromptMappings(previousMappings as any, promptMappings as any) as any;
      }

      // A committing turn that edits via a shell command (e.g. Copilot's
      // `printf >> file && git commit`, or any `sed -i`/`echo >>`) produces NO
      // transcript edit-tool call, so extractPromptFileMappings emits an EMPTY
      // mapping for it. That empty mapping otherwise satisfies the safety net
      // below, so the turn shows +0 / no diff even though git captured its real
      // work against the per-prompt shadow baseline. Drop the empty mapping when
      // gitCapture shows this turn actually changed code, so the safety-net
      // synthesis re-derives the per-prompt diff from git.
      if (!indexUnsafe) {
        const emptyCurIdx = promptMappings.findIndex(pm =>
          pm.promptIndex === currentPromptIdx &&
          !(pm.diff || (pm as any).uncommittedDiff) &&
          !(pm.filesChanged && pm.filesChanged.length > 0) &&
          !(pm as any).chatOnly);
        if (emptyCurIdx >= 0) {
          // Uncommitted work is judged AFTER exclusions. Raw, the
          // Origin-managed context files this repo rewrites every prompt are
          // always dirty, so the raw read says "work" on every turn and the
          // rebase test below could never be reached.
          const uncommittedWork = !!(
            filterUncommittedDiff(gitCapture.workingTreeDiff || '', turnExcludeFiles).trim() ||
            filterUncommittedDiff(gitCapture.uncommittedDiff || '', turnExcludeFiles).trim()
          );
          const gitHasWork = !!((gitCapture.committedDiff || '').trim()) || uncommittedWork;
          // A REBASE is not authorship. It replaces an earlier turn's commit
          // with a new sha inside whatever turn ran it, so `baseline..HEAD`
          // reports a diff this turn did not write — and the empty transcript
          // mapping that says so is CORRECT, not the shell-edit turn this
          // guard exists for. Dropping it hands an earlier turn's work to this
          // one a second time: session b0c86852 turn 3 rebased, pushed and
          // merged, authored nothing, and was billed turn 1's +99/-11 under
          // the rewritten sha f9f7557d.
          //
          // Gated on there being NO uncommitted work, so a turn that rebased
          // AND edited still takes the shell-edit path.
          const rebaseOnly = !uncommittedWork && windowIsRebaseOfEarlierTurns(
            (prior, cand) => isRewriteOf(state.repoPath, prior, cand),
            gitCapture.commitShas || [],
            state.commitTurns,
            state.activeTurn?.turnId,
          );
          if (gitHasWork && !rebaseOnly) {
            promptMappings.splice(emptyCurIdx, 1);
            debugLog('stop', 'dropped empty current-prompt mapping — git shows work (shell-edit turn)', {
              promptIndex: currentPromptIdx,
            });
          } else if (gitHasWork) {
            debugLog('stop', 'kept empty current-prompt mapping — window is a rebase of earlier turns', {
              promptIndex: currentPromptIdx,
              windowShas: (gitCapture.commitShas || []).map((s: string) => s.slice(0, 8)),
            });
          }
        }
      }

      // Safety net: ensure the CURRENT prompt has a mapping even if transcript
      // parsing missed it. Without this, the latest prompt shows empty on the
      // platform until the NEXT prompt fires (when user-prompt-submit captures it).
      if (prompts.length > 0 && !indexUnsafe && !promptMappings.some(pm => pm.promptIndex === currentPromptIdx)) {
        const noCommits = (gitCapture.commitDetails?.length ?? 0) === 0;
        const noTranscriptEdits = parsed.filesChanged.length === 0;
        // A turn is only truly chat-only when NOTHING happened: no commits,
        // no transcript-reported edits, AND no working-tree changes the
        // CLI captured. Cursor mid-turn prompts pass `noCommits` and
        // `noTranscriptEdits` (Cursor's transcript doesn't expose
        // filesChanged), but the working tree IS dirty from its IDE
        // edits — without checking uncommittedDiff the turn falls into
        // the chat-only branch below and ends up with treeSha=null,
        // un-restorable in the UI.
        //
        // Judge that on the FILTERED diffs — the same ones the else-branch below
        // builds the mapping from. Reading the raw diffs made the verdict and the
        // payload disagree: in a repo carrying pre-existing dirt the raw diff is
        // never empty, so the turn was ruled not-chat-only and then handed a
        // mapping whose diff filtered down to nothing. A turn with an empty
        // payload that isn't marked chatOnly is exactly what mints an
        // auto-snapshot with no diff behind it — the green dot on a turn that
        // did nothing. Cursor keeps its tree ref regardless: its IDE edits are
        // new work, not pre-existing dirt, so they survive the filter.
        const filteredUncommitted = filterUncommittedDiff(
          gitCapture.uncommittedDiff || '', turnExcludeFiles,
        );
        const useWorkingTreeDiff = gitCapture.baselineIsShadow && gitCapture.workingTreeDiff;
        const filteredWorkingTree = gitCapture.workingTreeDiff
          ? filterUncommittedDiff(gitCapture.workingTreeDiff, turnExcludeFiles)
          : '';
        const noUncommittedChanges = !filteredUncommitted && !filteredWorkingTree;
        if (noCommits && noTranscriptEdits && noUncommittedChanges) {
          // Chat-only prompt — same gate as the synthesis branch above.
          promptMappings.push({
            promptIndex: currentPromptIdx,
            promptText: currentPromptText.slice(0, 1000),
            filesChanged: [] as string[],
            diff: '',
            uncommittedDiff: '',
            chatOnly: true as const,
          });
          debugLog('stop', 'safety-net empty mapping (chat-only prompt)', {
            promptIndex: currentPromptIdx,
          });
        } else {
          // filteredUncommitted / useWorkingTreeDiff / filteredWorkingTree are
          // computed above so the chat-only verdict and this payload are derived
          // from the same numbers.
          const uncommittedFiles: string[] = [];
          if (filteredUncommitted) {
            for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          if (useWorkingTreeDiff) {
            for (const m of filteredWorkingTree.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          const allFiles = new Set([...filesChanged, ...uncommittedFiles]);
          // The committed half is filtered on the FOREIGN files only, not the
          // full exclude union: session-start dirt that this turn went on to
          // commit is legitimately ours, and filtering it out here would drop
          // real committed work from the record.
          const ownedCommittedDiff = foreignCommitFiles.length > 0
            ? filterUncommittedDiff(gitCapture.committedDiff || '', foreignCommitFiles)
            : (gitCapture.committedDiff || '');
          const safetyDiff = useWorkingTreeDiff
            ? filteredWorkingTree
            : ((ownedCommittedDiff + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim());
          // Capture commitSha + treeSha so the dashboard can link this prompt
          // to its commit on the commit-detail page. Without these the
          // "Prompts in this commit" panel says "No linked prompts" even
          // when the per-prompt mapping was captured correctly.
          //
          // Stamp the commit sha ONLY when this turn's capture actually saw
          // a new commit land since its baseline. Unconditionally stamping
          // current HEAD spread a later commit's sha onto turns that never
          // committed (the cumulative-stamp class — prod petrushka 2a3a52aa),
          // and the server's fill-only guard can't help when the row is still
          // null. The boundary race (the commit's true turn not yet detected
          // by the poll) is resolved server-side by the attribution sweep
          // (#582).
          //
          // "A commit landed" is read off the OWNED commit list, not off
          // `committedDiff` and not off HEAD. Both of those answer "did the
          // repo move", which on a shared checkout is a different question
          // from "did I commit": prod 97ad4482 stamped a concurrent session's
          // HEAD onto a turn that only answered a question, because a commit
          // had indeed landed since its baseline — somebody else's. Stamping
          // the newest OWNED commit (list is `git log --reverse`, so oldest
          // first) also keeps this turn off a foreign HEAD that happens to sit
          // on top of our own commit.
          let synthCommitSha: string | null = null;
          let synthTreeSha: string | null = null;
          try {
            const ownedThisTurn = gitCapture.commitDetails || [];
            if (ownedThisTurn.length > 0) {
              synthCommitSha = ownedThisTurn[ownedThisTurn.length - 1].sha || null;
            }
            synthTreeSha = getWorkingTreeSha(state.repoPath);
          } catch { /* ignore */ }
          promptMappings.push({
            promptIndex: currentPromptIdx,
            promptText: currentPromptText.slice(0, 1000),
            filesChanged: Array.from(allFiles),
            diff: safetyDiff.slice(0, 200_000),
            uncommittedDiff: filteredUncommitted.slice(0, 200_000),
            commitSha: synthCommitSha,
            treeSha: synthTreeSha,
          } as any);
          debugLog('stop', 'synthesized current prompt mapping (safety net)', {
            promptIndex: currentPromptIdx, files: allFiles.size, shadowBaseline: gitCapture.baselineIsShadow,
            commitSha: synthCommitSha?.slice(0, 8) || null,
          });
        }
      }

      // Safety net for OLDER prompts (not just current). Codex doesn't
      // fire user-prompt-submit reliably; a rollout-sync can pop several
      // new entries into state.prompts at once (e.g. user typed 3 prompts
      // before any hook fired). Without this, state.completedPromptMappings
      // ends up with fewer entries than state.prompts and the dashboard
      // shows "3 prompts" but only N pcs. Fill every gap with a chatOnly
      // placeholder so prompt count matches mapping count — honest UI
      // ("no work captured for this turn") instead of phantom missing
      // entries that confuse the blame view.
      if (prompts.length > 0) {
        const haveIdx = new Set(promptMappings.map(pm => pm.promptIndex));
        for (let i = 0; i < prompts.length; i++) {
          if (haveIdx.has(i)) continue;
          promptMappings.push({
            promptIndex: i,
            promptText: (prompts[i] || '').slice(0, 1000),
            filesChanged: [] as string[],
            diff: '',
            uncommittedDiff: '',
            chatOnly: true as const,
          });
        }
        // Keep ordering stable for downstream consumers.
        promptMappings.sort((a, b) => a.promptIndex - b.promptIndex);
      }

      // A turn may be captured MORE THAN ONCE — a re-capture may only ADD.
      // See keepRicherTurnCapture.
      {
        const before = promptMappings.map((pm: any) => (pm.filesChanged || []).length);
        promptMappings = keepRicherTurnCapture(
          promptMappings as any, previousMappings as any, turnExcludeFiles,
        ) as any;
        promptMappings.forEach((pm: any, i: number) => {
          const after = (pm.filesChanged || []).length;
          if (after !== before[i]) {
            debugLog('stop', 'kept earlier capture of this turn (re-Stop shrank the window)', {
              promptIndex: pm.promptIndex, files: `${before[i]}→${after}`,
            });
          }
        });
      }

      // Last line: collapse worktree-prefixed duplicates and drop out-of-repo
      // paths, AFTER every producer and the re-capture merge. See
      // normalizeTurnFiles — the per-producer scoping is the real repair, this
      // is what makes a miss by any one of them non-fatal and what heals rows
      // an older build already wrote (the merge unions file lists, so a stale
      // shape would otherwise persist forever).
      {
        const nRoots = sessionRepoRoots(state);
        const nWorkTree = currentSessionWorkTree(state);
        promptMappings.forEach((pm: any) => {
          const before = (pm.filesChanged || []).length;
          pm.filesChanged = normalizeTurnFiles(pm.filesChanged, {
            roots: nRoots, workTree: nWorkTree,
          });
          if (pm.filesChanged.length !== before) {
            debugLog('stop', 'normalized turn files', {
              promptIndex: pm.promptIndex, files: `${before}→${pm.filesChanged.length}`,
            });
          }
        });
      }

      debugLog('stop', 'prompt mappings (merged)', {
        currentPromptIdx,
        previousCount: previousMappings.length,
        totalCount: promptMappings.length,
        filesChanged: filesChanged.length,
      });
    }

    // Compute session-level filesChanged from headShaAtStart (accumulated across all prompts)
    // This is separate from per-prompt filesChanged which uses promptBaseline
    let sessionFilesChanged = filesChanged; // default: per-prompt files
    if (state.repoPaths && state.repoPaths.length > 1 && state.perRepoState) {
      // Multi-repo: session-level files from all repos
      const sessionFilesSet = new Set<string>();
      for (const rp of state.repoPaths) {
        const rpState = state.perRepoState[rp];
        if (!rpState?.headShaAtStart) continue;
        try {
          const rpCapture = captureGitState(rp, rpState.headShaAtStart, { committedOnly: true });
          const repoDir = path.basename(rp);
          for (const c of rpCapture.commitDetails) {
            for (const f of c.filesChanged) sessionFilesSet.add(`${repoDir}/${f}`);
          }
        } catch { /* skip this repo */ }
      }
      if (sessionFilesSet.size > 0) {
        sessionFilesChanged = Array.from(sessionFilesSet);
        debugLog('stop', 'multi-repo session-level filesChanged', { count: sessionFilesChanged.length });
      }
    } else if (state.headShaAtStart && state.headShaAtStart !== promptBaseline) {
      try {
        const sessionCapture = captureGitState(state.repoPath, state.headShaAtStart, { committedOnly: true });
        // Same shared-checkout problem as the per-turn capture, one range
        // wider: session-start..HEAD contains every OTHER agent's commits and
        // every `git pull` since the session began. Unfiltered, this reported
        // 2146 files changed for a session that touched four (prod 97ad4482).
        const sessionForeignFiles = new Set(
          dropForeignCommitsFromCapture(state.repoPath, state, sessionCapture),
        );
        const sessionFilesSet = new Set(sessionFilesFromRangeCapture(
          sessionCapture, sessionForeignFiles, parsed.filesChanged,
        ));
        if (sessionCapture.diff && (sessionCapture.commitDetails || []).length === 0) {
          debugLog('stop', 'session range has no commits to attribute — not harvesting its diff', {
            headShaAtStart: String(state.headShaAtStart).slice(0, 12),
          });
        }
        if (sessionFilesSet.size > 0) {
          sessionFilesChanged = Array.from(sessionFilesSet);
          debugLog('stop', 'session-level filesChanged from headShaAtStart', {
            count: sessionFilesChanged.length, foreignDropped: sessionForeignFiles.size,
          });
        }
      } catch (err: any) {
        debugLog('stop', 'session-level capture failed, using per-prompt files', { message: err.message });
      }
    }

    // Hoisted out of `if (connected)` so writeSessionFiles below (which
    // runs in both connected + disconnected modes) can pass editsJson
    // through to changes.json. Populated inside the connected block;
    // stays null when offline or when capture fails.
    let promptEditsByIndex: Map<number, string> | null = null;

    if (connected) {
      // Recovery: if the session was created in local-only mode (key
      // was dead at the time → `local-` prefix) and the key has since
      // recovered, register it server-side now so the rest of the
      // update lands on a real row instead of a 404. Persist the new
      // id back to state so future hooks use it directly.
      await ensureServerSession(state, hookCwd, agentSlug, 'stop');

      debugLog('stop', 'calling api.updateSession', {
        sessionId: state.sessionId,
        promptCount: prompts.length,
        agentSlug: agentSlug || state.agentSlug,
        model,
        tokensUsed: parsed.tokensUsed,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
        cacheCreation1hTokens: parsed.cacheCreation1hTokens,
        costUsd,
        promptMappings: promptMappings.length,
        mappings: summarizePromptPayload(promptMappings),
      });
      // Build a session-level gitCapture snapshot for agents whose .git
      // hooks don't fire reliably (Codex). Without this, sessionDiff is
      // never created, the blame endpoint falls back to line-number Map
      // attribution where later prompts overwrite earlier ones, and AI
      // Blame shows prompt 1's lines as belonging to prompt 2 for any
      // file both prompts touched. headBefore = session start so the API
      // can recognise this as a SNAPSHOT and replace (not append) the
      // existing sessionDiff.
      let sessionGitCapture: {
        headBefore: string; headAfter: string; commitShas: string[];
        diff: string; linesAdded: number; linesRemoved: number;
        commitDetails: Array<{ sha: string; message: string; author: string; filesChanged: string[] }>;
        snapshot: true;
      } | undefined;
      // Cursor's git commits don't reliably fire .git/hooks/post-commit
      // (sandbox / worktree isolation — same comment as in enable.ts). On
      // top of that, `git commit --amend` orphans the pre-amend SHA so the
      // post-commit ingest for the original commit goes stale anyway. Both
      // failure modes leave sessionCommits empty even though the user
      // committed, which surfaces every committed Cursor prompt as
      // "uncommitted" on the dashboard (user-reported May 28, or-test-2
      // "make little change and commit"). Treat Cursor like Codex/Gemini
      // and ship a session-level gitCapture snapshot at session-end —
      // walking git log from session start lifts every reachable commit
      // (including post-amend SHAs) into the MCP ingest path.
      const codexLikeAgents = new Set(['codex', 'gemini', 'cursor']);
      if (codexLikeAgents.has((agentSlug || state.agentSlug || '').toLowerCase()) && state.headShaAtStart) {
        try {
          // fullContext: AI Blame renders the entire file from this diff —
          // unlimited unified context means every line ships as context or
          // added, eliminating "N lines hidden" gaps in the view.
          const snap = captureGitState(state.repoPath, state.headShaAtStart, { fullContext: true });
          if (snap.committedDiff || snap.uncommittedDiff) {
            // Scope the committed side to commits THIS session authored.
            // `git diff session-start..HEAD` (used by captureGitState) picks
            // up commits made by a concurrent session once HEAD has moved
            // past ours — sessionScopedCommittedDiff walks the post-commit-
            // recorded list and rebuilds the diff from this session's own
            // commits only, which is the right unit of "what this session
            // did" for a Full Session Diff display.
            let filteredUncommitted = filterUncommittedDiff(
              snap.uncommittedDiff || '',
              turnExcludeFiles,
            );
            // Line-level dirt exclusion for the no-commit case (the reported
            // bug: a 1-line session read "+16"). When nothing was committed
            // this session, the working tree vs the session-start shadow IS
            // exactly this session's uncommitted work — it keeps a file's own
            // edits while dropping pre-existing dirt LINES (the file-level
            // filter above drops the whole file, which is too coarse when the
            // session edited an already-dirty file). Committed sessions keep
            // the existing path so concurrent-commit scoping isn't disturbed.
            const noCommitsThisSession = !(state.sessionCommitShas && state.sessionCommitShas.length > 0);
            if (state.sessionStartShadowSha && noCommitsThisSession) {
              try {
                const shadowSnap = captureGitState(state.repoPath, state.sessionStartShadowSha, { fullContext: true });
                if (shadowSnap.baselineIsShadow && typeof shadowSnap.workingTreeDiff === 'string') {
                  filteredUncommitted = shadowSnap.workingTreeDiff;
                }
              } catch { /* keep the file-level filtered diff */ }
            }
            // FIX 3 — final session-level pre-existing-dirt guard. The shadow
            // branch above OVERWRITES filteredUncommitted with the raw
            // working-tree-vs-shadow diff, which never goes back through the
            // file-level dirt filter; and when the session-start shadow is
            // absent/stale (a box with no git identity where shadow creation
            // fails) the file-level filter is the only defense. Either way, drop
            // any file that was dirty at SESSION START and this session never
            // recorded touching — so a read-only turn in a dirty repo reports
            // 0 files / 0 lines instead of a prior session's leftover fixtures.
            filteredUncommitted = excludeUntouchedSessionStartDirt(
              filteredUncommitted, state.sessionStartDirtyFiles, promptMappings,
            );
            // Codex bypasses .git/hooks/post-commit on some installs, so
            // sessionCommitShas can be empty even when the session produced
            // real commits — sessionScopedCommittedDiff then returns "" and
            // fullDiff collapses to just the uncommitted slice, dropping every
            // committed prompt from sessionDiff (and the AI Blame view). Fall
            // back to snap.committedDiff (= git diff session-start..HEAD)
            // when the session-scoped walk produces nothing.
            let sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state);
            // Owned commit shas: recorded ones, or — when the post-commit hook
            // was missed — the trailer-owned commits in range. NEVER the raw
            // session-start..HEAD set, which sweeps in commits authored by OTHER
            // agents running concurrently in the same repo (a Codex session
            // showing a Devin commit + inflated lines — the reported bug).
            let ownedShas = (state.sessionCommitShas || []).filter(s => /^[a-fA-F0-9]{7,40}$/.test(s));
            if (!sessionCommitted) {
              ownedShas = ownedRangeCommitShas(state.repoPath, state);
              const parts: string[] = [];
              for (const sha of ownedShas) {
                try {
                  const out = execFileSync('git', ['show', sha, '--format=', '--no-color'], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).toString().trim();
                  if (out) parts.push(out);
                } catch { /* skip */ }
              }
              sessionCommitted = parts.join('\n');
            }
            const fullDiff = (sessionCommitted +
              (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
            const countDiffLines = (d: string, sign: '+' | '-'): number =>
              d.split('\n').filter(l => l[0] === sign && l.slice(0, 3) !== sign + sign + sign).length;
            // Keep only the commit details we actually own — so commitShas /
            // commitDetails / lines all agree and don't include a foreign commit.
            const ownedSet = new Set(ownedShas.map(s => s.toLowerCase()));
            const ownedDetails = (snap.commitDetails || []).filter(c =>
              [...ownedSet].some(o => o.startsWith(c.sha.toLowerCase()) || c.sha.toLowerCase().startsWith(o)),
            );
            sessionGitCapture = {
              headBefore: state.headShaAtStart,
              headAfter: snap.headAfter || state.headShaAtStart,
              commitShas: ownedShas,
              diff: fullDiff.slice(0, 500_000),
              linesAdded: countDiffLines(fullDiff, '+'),
              linesRemoved: countDiffLines(fullDiff, '-'),
              commitDetails: ownedDetails,
              snapshot: true,
            };
            debugLog('stop', 'session-level gitCapture snapshot built', {
              diffLen: sessionGitCapture.diff.length,
              commitCount: sessionGitCapture.commitShas.length,
              linesAdded: sessionGitCapture.linesAdded,
              linesRemoved: sessionGitCapture.linesRemoved,
              filteredOutFiles: (state.sessionStartDirtyFiles || []).length,
            });
          }
        } catch (snapErr: unknown) {
          debugLog('stop', 'session-level gitCapture failed (non-fatal)', {
            message: snapErr instanceof Error ? snapErr.message : String(snapErr),
          });
        }
      }

      // ─── Shell writes → real edits ────────────────────────────────────
      // A turn that wrote files through the shell has no Edit/Write tool call
      // to capture, so without this it ships `edits: []` — indistinguishable
      // on the wire from a chat-only turn. Derive those writes from the
      // turn's own git window BEFORE the capture pipeline runs, so they reach
      // the ledger in time to be merged like any other edit.
      try {
        const shellPromptIdx = (state.prompts?.length || 0) - 1;
        const wtTargetA = shellWindowTarget(
          state, shellPromptIdx, promptBaseline, currentSessionWorkTree(state),
        );
        // Journal first: it is evidence and covers agents with no tool hooks,
        // so the window below skips whatever it already claimed.
        const journalA = recordJournalEdits(state, shellPromptIdx, Date.now());
        const mainA = recordShellWindowEdits(state, wtTargetA.repoPath, shellPromptIdx, wtTargetA.baseline);
        const extraA = recordDiscoveredWorkTreeEdits(state, shellPromptIdx);
        if (journalA || mainA || extraA) {
          saveSessionState(state, found!.saveCwd, state.sessionTag);
        }
      } catch (shellErr: unknown) {
        debugLog('stop', 'shell window capture threw (non-fatal)', {
          message: shellErr instanceof Error ? shellErr.message : String(shellErr),
        });
      }

      // ─── New per-prompt PromptCapture pipeline ────────────────────────
      // Run the agent-specific extractor and produce an authoritative
      // PromptEdit[] per prompt. The server stores this JSON on
      // PromptChange.editsJson and computes the displayed per-prompt diff
      // + AI Blame attribution from it via LCS, bypassing the legacy
      // block-matching heuristics that conflate cross-prompt changes.
      // `promptEditsByIndex` is declared at function scope above so the
      // writeSessionFiles call below `if (connected)` can also pick it up.
      try {
        const slug = (agentSlug || state.agentSlug || '').toLowerCase();
        // Which extractor — if any — can read THIS agent's transcript.
        //
        // This used to end in a bare `: 'claude'`, so every agent that was not
        // codex/cursor/gemini had its transcript handed to the Claude Code JSONL
        // parser regardless of what format it actually writes. Antigravity,
        // Devin, Copilot and Aider all took that branch. The parser cannot read
        // those files, so it returned nothing — and nothing is exactly what a
        // correctly-captured chat-only turn looks like, which is why it never
        // surfaced as a failure.
        //
        // The table says per agent where edits come from, and an agent it does
        // not know is 'none' rather than 'claude'. See AGENT_EDIT_SOURCES.
        const editSource = editSourceForAgent(slug);
        const captureAgent = editSource.captureAgent;
        // Cursor's agent-transcript JSONL is never delivered via
        // `input.transcript_path`, so `state.transcriptPath` doesn't point at
        // it — resolve it the same ID-anchored way the token/display parser
        // does. Without this, capturePromptEdits reads nothing, editsJson
        // stays empty, and the API serves the cumulative working-tree
        // pc.diff (prompt N appears to include prompt N-1's changes).
        const cursorCapId = (typeof input.session_id === 'string' ? input.session_id : undefined)
          || (typeof input.conversation_id === 'string' ? input.conversation_id : undefined)
          || state.agentSessionId || state.claudeSessionId || undefined;
        const capTranscript =
          captureAgent === 'codex' ? (codexData?.rolloutPath || state.transcriptPath)
            : captureAgent === 'cursor' ? (findCursorTranscriptJsonl(cursorCapId) || state.transcriptPath)
              : state.transcriptPath;
        // For Codex, hand the extractor the pre-resolved per-prompt
        // timeline (text + ms timestamp) from the same rollout walker
        // already used elsewhere for commit attribution. Without this,
        // the extractor re-reads the rollout and falls back to "all
        // commits go to the last prompt" whenever a timestamp couldn't
        // be parsed — exactly the bug that left prompt N+1's diff
        // showing up under prompt N.
        let codexPromptsForCapture: Array<{ text: string; timestamp: number }> | undefined;
        if (captureAgent === 'codex') {
          try {
            const codexThreadId = state.agentSessionId || state.claudeSessionId || undefined;
            const timeline = getCodexPromptsTimeline(state.repoPath, codexThreadId);
            if (timeline.length > 0) {
              codexPromptsForCapture = timeline.map((t) => ({
                text: t.text || '',
                timestamp: t.timestamp || 0,
              }));
            }
          } catch (tlErr: unknown) {
            debugLog('stop', 'codex timeline fetch for capturePromptEdits failed', {
              message: tlErr instanceof Error ? tlErr.message : String(tlErr),
            });
          }
        }
        // Only agents with a transcript extractor go through it. For a
        // 'ledger' agent (Antigravity, Devin) an empty list here is the CORRECT
        // input, not a failure: applyLiveLedger below supplies its edits from
        // the PostToolUse records, and running some other agent's parser over
        // its session file could only produce noise. For 'none' there is no
        // edit source at all — see AGENT_EDIT_SOURCES.
        const transcriptCaptures = captureAgent
          ? capturePromptEdits({
            agent: captureAgent,
            repoPath: state.repoPath,
            transcriptPath: capTranscript,
            codexPrompts: codexPromptsForCapture,
            sessionCommitShas: state.sessionCommitShas || [],
            // Attestation from post-commit: which turn each commit landed under.
            // Lets the owner resolution below use what was observed instead of
            // falling back to "the highest-index turn that claims the sha".
            commitTurns: state.commitTurns || [],
            promptTurnIds: state.promptTurnIds || [],
            headShaAtStart: state.headShaAtStart || undefined,
            headShaAtEnd: gitCapture.headAfter || undefined,
          })
          : [];
        if (!captureAgent) {
          debugLog('stop', 'no transcript extractor for agent', { slug, editSource: editSource.kind });
        }
        const captures = applyLiveLedger(transcriptCaptures, state, 'stop');
        if (captures.length > 0) {
          promptEditsByIndex = new Map();
          for (const cap of captures) {
            // Anchor any edit the live ledger didn't already position
            // (transcript-only agents like Gemini) against the final
            // on-disk file. Already-anchored live edits are skipped.
            if (state.repoPath) {
              // Give whole-file writes their missing before-state FIRST, so
              // the synthesized diff is a real replace instead of a
              // whole-file insertion (see backfillWriteBaselines).
              backfillWriteBaselines(
                cap.edits,
                state.repoPath,
                // THIS turn's start-state, not the session's.
                turnBaselineForServerRow(state, cap.promptIndex),
              );
              anchorEditPositions(cap.edits, state.repoPath);
            }
            promptEditsByIndex.set(cap.promptIndex, JSON.stringify(cap));
          }
          // Per-turn attribution in FINAL-file coordinates, walked over this
          // session's own shadow commits. An edit's anchor says where it landed
          // WHEN IT RAN; these say where those lines are NOW, and drop the ones
          // a later turn deleted — which is what lets the dashboard render a
          // whole file's blame instead of one turn's window. Same helper the
          // transcript watcher uses, so both paths agree.
          try {
            // Both arguments have to be in ONE index space, and
            // promptEditsByIndex is keyed by cap.promptIndex — transcript
            // native. promptShadows is keyed local (recordPromptShadow writes
            // `prompts.length - 1`), so lift it to match rather than pairing a
            // turn's edits with another turn's baseline.
            const shadows = (state.promptShadows || [])
              .filter((s) => s && typeof s.shadowSha === 'string' && s.shadowSha)
              .map((s) => ({
                promptIndex: serverRowForLocalTurn(s.promptIndex, state.promptIndexBase),
                baselineSha: s.shadowSha as string,
              }));
            if (state.repoPath && shadows.length > 0) {
              const finalByPrompt = finalHunksForCaptures(
                state.repoPath,
                shadows,
                promptEditsByIndex,
                state.sessionStartShadowSha || state.headShaAtStart || null,
              );
              for (const [idx, hunks] of finalByPrompt) {
                const raw = promptEditsByIndex.get(idx);
                if (!raw) continue;
                try {
                  const withHunks = JSON.stringify({ ...JSON.parse(raw), finalHunks: hunks });
                  // editsJson is size-capped downstream; losing the real edits to
                  // make room for line content would be a bad trade.
                  if (withHunks.length <= 60_000) promptEditsByIndex.set(idx, withHunks);
                } catch { /* malformed payload — leave it as it was */ }
              }
              debugLog('stop', 'final-state hunks', {
                prompts: finalByPrompt.size, shadows: shadows.length,
              });
            }
          } catch (fhErr: unknown) {
            debugLog('stop', 'final-state hunks failed (non-fatal)', {
              message: fhErr instanceof Error ? fhErr.message : String(fhErr),
            });
          }
          debugLog('stop', 'capturePromptEdits ok', {
            agent: captureAgent,
            captured: captures.length,
            totalEdits: captures.reduce((n, c) => n + c.edits.length, 0),
          });
        }
      } catch (capErr: unknown) {
        debugLog('stop', 'capturePromptEdits failed (non-fatal)', {
          message: capErr instanceof Error ? capErr.message : String(capErr),
        });
      }

      // The server can HARD-DELETE this row out from under us between the
      // session's creation and this PATCH (see isSessionGoneError). The payload
      // below is the whole turn — transcript, prompts, per-prompt diffs — so a
      // 404 here used to throw straight to the handler's catch and discard a
      // fully-captured turn (observed live: a Cursor turn on `vodka` whose row
      // was deleted 420ms after session/start; every later write 404'd and the
      // work never reached the dashboard). Re-mint a session and send it there.
      const stopUpdatePayload = {
        prompt: joinedPrompt || undefined,
        transcript: displayTranscript || undefined,
        // The RESOLVED agent. Without this the Devin re-tag above never reaches
        // the server: the hook flipped its local slug but the PATCH carried no
        // agentSlug, so a Devin run stayed labeled "Claude" forever (reported).
        // The API treats an agentSlug PATCH as a re-tag of the session's agent.
        agentSlug: agentSlug || state.agentSlug || undefined,
        // Only send a specific model (mirrors session-end). When the parse
        // found nothing (resumed session, empty transcript), state.model is
        // the bare brand "claude" — sending it would overwrite a real
        // identifier (e.g. "claude-fable-5") stored by an earlier update.
        // EXCEPTION: a session re-tagged to devin must not keep the claude
        // default — "claude" on a Devin session is strictly wrong, so replace
        // it with the devin brand until the ATIF transcript yields SWE-*.
        model: isSpecificModel(model)
          ? model
          : ((agentSlug || state.agentSlug) === 'devin' && (!model || model === 'claude') ? 'devin' : undefined),
        filesChanged: sessionFilesChanged.length > 0 ? sessionFilesChanged : undefined,
        tokensUsed: parsed.tokensUsed > 0 ? parsed.tokensUsed : undefined,
        // Only assert estimated-or-not when we actually have tokens to describe
        // (send the explicit boolean so a later real-token update can clear a
        // prior estimate). Server applies it when typeof === 'boolean'.
        tokensEstimated: parsed.tokensUsed > 0 ? tokensEstimated : undefined,
        inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
        outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
        cacheReadTokens: parsed.cacheReadTokens > 0 ? parsed.cacheReadTokens : undefined,
        cacheCreationTokens: parsed.cacheCreationTokens > 0 ? parsed.cacheCreationTokens : undefined,
        cacheCreation1hTokens: parsed.cacheCreation1hTokens > 0 ? parsed.cacheCreation1hTokens : undefined,
        toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
        // Real sub-agent spawns (Task tool): count, the files each edited (by
        // execution window), and the token portion they incurred — so the
        // dashboard can show "N sub-agents", the files, and "M tokens in sub-agents".
        subagents: buildSubagentSummary(state, parsed),
        subagentTokens: parsed.subagentTokens > 0 ? parsed.subagentTokens : undefined,
        // Structured per-tool breakdown + files-read so the server stores
        // them directly instead of re-parsing the display transcript (which
        // is prompt-only for synthesized/aggregated sessions → "0 / None").
        toolBreakdown: parsed.toolBreakdown.length > 0 ? parsed.toolBreakdown : undefined,
        filesRead: mergeFilesRead(parsed.filesRead, state.filesRead),
        // The agent's OWN name for this chat, when it has one. Sent on every
        // update rather than once at start: people rename conversations
        // mid-run, and Claude Code rewrites the record each time.
        agentSessionName: resolveAgentSessionName(state) || undefined,
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        gitCapture: sessionGitCapture,
        promptChanges: promptMappings.length > 0
          ? promptMappings.map(withDerivedLineCounts).map((pm, _i, all) => ({
              ...pm,
              promptText: (pm.promptText || '').slice(0, 1000),
              diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
              editsJson: promptEditsByIndex?.get(pm.promptIndex) || undefined,
              // Nested-repo writes belong to the turn that just ended — the
              // highest index present — because the window they were measured
              // against is that turn's.
              ...(outOfRepoFilesFor(
                promptEditsByIndex?.get(pm.promptIndex),
                pm.promptIndex === Math.max(...all.map((x) => x.promptIndex))
                  ? nestedRepoWritesForOpenTurn(state)
                  : [],
              )),
              ...(turnIdFor(state, pm.promptIndex) && { turnId: turnIdFor(state, pm.promptIndex) }),
              ...captureStamp(),
              // Devin records the prompt at Stop (after the turn's work), so the
              // server's timestamp-based commit attribution sees a commit as
              // BEFORE its own prompt and credits the wrong turn. Stamp the real
              // submission time from Devin's DB so ordering is correct.
              ...(devinPromptTimes?.[pm.promptIndex]
                ? { createdAt: devinPromptTimes[pm.promptIndex] }
                : {}),
            }))
          : undefined,
      };

      // The ACTUAL wire payload — turnId, captureId and the line counts are
      // attached in the map above, so the earlier `mappings:` log (which runs
      // before it) always showed them as null. This is the one to read when
      // asking "what did the CLI actually send for turn N?".
      debugLog('stop', 'promptChanges payload', {
        sessionId: state.sessionId,
        payload: summarizePromptPayload(stopUpdatePayload.promptChanges as any),
      });

      const sendStopUpdate = (id: string) => durableUpdate(id, stopUpdatePayload);
      let updateRes: any;
      try {
        updateRes = await sendStopUpdate(state.sessionId);
      } catch (updErr: unknown) {
        if (!isSessionGoneError(updErr)) throw updErr;
        debugLog('stop', 'session gone server-side — re-minting and resending', {
          lostSessionId: state.sessionId,
        });
        const reminted = await ensureServerSession(
          state, found?.saveCwd || state.repoPath || hookCwd, agentSlug, 'stop', { remintGone: true },
        );
        if (!reminted) {
          debugLog('stop', 'session gone and re-mint failed — capture kept local', {});
          throw updErr;
        }
        updateRes = await sendStopUpdate(state.sessionId);
        debugLog('stop', 'resent capture to re-minted session', { sessionId: state.sessionId });
      }
      debugLog('stop', 'update complete');

      // Persist the budget lockout signal the PATCH response carried, so
      // the NEXT prompt / tool call gets blocked when a hard cap was
      // breached by this turn's spend.
      applyBudgetSignal(state, updateRes, hookCwd);

      // Send a heartbeat ping to keep the server-side session alive
      // (prevents the server's stale session cleanup from ending it)
      try {
        await api.pingSession(state.sessionId);
      } catch { /* non-fatal */ }

      // Image attachments (Phase 1 — Claude / Cursor pastes).
      //
      // The server gates uploads on the user's `captureImages` opt-in
      // flag (default false). We always try here and stop on the first
      // 403 — that keeps the CLI simple (no need to fetch the user's
      // preference) and means flipping the toggle in Settings takes
      // effect on the next prompt without a CLI restart.
      //
      // Caps: 5 MB per image, 50 MB per session enforced server-side.
      // We also skip locally if a base64 payload would exceed 5 MB
      // after decode, to save the roundtrip.
      try {
        const images = extractPromptImages(state.transcriptPath);
        if (images.length > 0) {
          debugLog('stop', 'image upload begin', { count: images.length });
          let optedOut = false;
          for (const img of images) {
            if (optedOut) break;
            if (img.sizeBytes > 5 * 1024 * 1024) {
              debugLog('stop', 'image too large, skip', { promptIndex: img.promptIndex, sizeBytes: img.sizeBytes });
              continue;
            }
            try {
              await api.uploadAttachment(state.sessionId, {
                promptIndex: img.promptIndex,
                mediaType: img.mediaType,
                base64: img.base64,
              });
            } catch (uploadErr: any) {
              const status = uploadErr?.status || uploadErr?.code;
              if (status === 403 || /disabled/i.test(uploadErr?.message || '')) {
                debugLog('stop', 'image capture disabled for user — stopping', {});
                optedOut = true;
              } else {
                debugLog('stop', 'image upload failed (non-fatal)', {
                  promptIndex: img.promptIndex,
                  message: uploadErr?.message || String(uploadErr),
                });
              }
            }
          }
        }
      } catch (imgErr: any) {
        debugLog('stop', 'image extraction failed (non-fatal)', { message: imgErr?.message });
      }
    }

    // Write git notes on any commits that don't have them yet
    // This is critical for agents like Codex that may bypass .git/hooks/post-commit
    try {
      const noteCommits = gitCapture.commitDetails
        .map(c => c.sha)
        .filter(sha => /^[a-fA-F0-9]+$/.test(sha));
      if (noteCommits.length > 0) {
        const execOptsNotes = {
    windowsHide: true, cwd: state.repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
        // Only write notes for commits that don't already have them
        const missingNotes = noteCommits.filter(sha => {
          try {
            execFileSync('git', ['notes', '--ref=origin', 'show', sha], execOptsNotes);
            return false; // already has a note
          } catch {
            return true; // no note yet
          }
        });
        if (missingNotes.length > 0) {
          writeGitNotes(state.repoPath, missingNotes, {
            sessionId: state.sessionId,
            model: model || state.model || 'unknown',
            agentSlug: agentSlug || state.agentSlug,
            promptCount: prompts.length,
            promptSummary: prompts[prompts.length - 1] || '',
            fullPrompt: prompts[prompts.length - 1] || undefined,
            previousSessionId: state.previousSessionId,
            filesRead: state.filesRead,
            prompts: buildPromptNoteEntries(state, agentSlug || state.agentSlug, model || state.model, promptEditsByIndex),
            markers: parseMarkersFromTranscript(parsed.transcript),
            tokensUsed: parsed.tokensUsed,
            costUsd,
            durationMs: durationMs > 0 ? durationMs : 0,
            linesAdded: gitCapture.linesAdded || 0,
            linesRemoved: gitCapture.linesRemoved || 0,
            originUrl: state.sessionId ? `${config?.apiUrl || 'https://getorigin.io'}/sessions/${state.sessionId}` : '',
          });
          debugLog('stop', 'git notes written for missing commits', { count: missingNotes.length });
        }
      }
    } catch (notesErr: any) {
      debugLog('stop', 'git notes error (non-fatal)', { message: notesErr.message });
    }

    // Update per-prompt baselines so next prompt only sees its own changes.
    //
    // CRITICAL: if the working tree is dirty at end of this prompt, we
    // can't just use HEAD as the next prompt's baseline — when the next
    // prompt commits those still-dirty files, diff(HEAD..nextHEAD) would
    // include the previous prompt's work, falsely attributing it to the
    // next prompt.
    //
    // Fix: create a shadow commit whose tree = (HEAD's tree + all dirty
    // files), and use that as prePromptSha. Then diff(shadowSha..nextHEAD)
    // only includes content the next prompt actually introduced, since
    // the previous prompt's dirty content is already in the shadow tree.
    state.headShaAtLastStop = gitCapture.headAfter;
    {
      const dirty = getDirtyFiles(state.repoPath);
      if (dirty.length > 0) {
        const shadowTag = state.sessionTag || state.sessionId.slice(0, 12);
        const shadowSha = createShadowCommit(state.repoPath, shadowTag);
        if (shadowSha) {
          state.prePromptSha = shadowSha;
          // dirty files are now captured in the shadow tree, so the next
          // prompt's filterUncommittedDiff should treat the tree as clean.
          state.prePromptDirtyFiles = [];
          debugLog('stop', 'shadow commit anchored next-prompt baseline', {
            shadowSha: shadowSha.slice(0, 12), dirtyCount: dirty.length, head: gitCapture.headAfter.slice(0, 12),
          });
        } else {
          // Shadow creation failed — fall back to old behavior (will
          // potentially double-attribute uncommitted work).
          state.prePromptSha = gitCapture.headAfter;
          state.prePromptDirtyFiles = dirty;
          debugLog('stop', 'shadow commit failed, using HEAD as baseline (next prompt may double-attribute)', {
            dirtyCount: dirty.length,
          });
        }
      } else {
        state.prePromptSha = gitCapture.headAfter;
        state.prePromptDirtyFiles = [];
      }
    }
    // Multi-repo: update per-repo baselines
    if (state.repoPaths && state.repoPaths.length > 1 && state.perRepoState) {
      for (const rp of state.repoPaths) {
        const rpState = state.perRepoState[rp];
        if (!rpState) continue;
        const rpHead = getHeadSha(rp);
        rpState.headShaAtLastStop = rpHead;
        const rpDirty = getDirtyFiles(rp);
        if (rpDirty.length > 0) {
          const rpShadowTag = `${state.sessionTag || state.sessionId.slice(0, 12)}-${path.basename(rp)}`;
          const rpShadow = createShadowCommit(rp, rpShadowTag);
          if (rpShadow) {
            rpState.prePromptSha = rpShadow;
            rpState.prePromptDirtyFiles = [];
          } else {
            rpState.prePromptSha = rpHead;
            rpState.prePromptDirtyFiles = rpDirty;
          }
        } else {
          rpState.prePromptSha = rpHead;
          rpState.prePromptDirtyFiles = [];
        }
      }
    }
    // The running turn is finished. Closing it here — rather than letting the
    // next capture infer "current" from the list tail — is what lets a prompt
    // queued mid-turn wait its turn instead of stealing this one's remaining
    // edits. The next capture binds lastClosedTurnIndex + 1, so two prompts
    // queued back to back are still captured in order.
    closeTurn(state, state.activeTurn?.index);
    // Save accumulated prompt mappings so next stop can include previous prompts' data
    if (promptMappings.length > 0) {
      state.completedPromptMappings = promptMappings.map(pm => ({
        promptIndex: pm.promptIndex,
        promptText: pm.promptText,
        filesChanged: pm.filesChanged,
        // Explicit pick, so anything not listed here is silently dropped on
        // the state round-trip — which is where the heartbeat reads from.
        ...((pm as { outOfRepoFiles?: string[] }).outOfRepoFiles?.length
          ? { outOfRepoFiles: (pm as { outOfRepoFiles?: string[] }).outOfRepoFiles }
          : {}),
        diff: pm.diff,
        uncommittedDiff: pm.uncommittedDiff,
      }));
    }
    // Auto-snapshot: save working tree state after each AI turn.
    //
    // createSnapshot() is already idempotent: it does `git stash create`
    // to capture the working tree, and returns null when the tree is
    // clean (nothing to snapshot) OR when the resulting tree SHA matches
    // the last snapshot on the session's shadow branch (no change since
    // last turn). That's the authoritative "did anything change?" test.
    //
    // We used to gate on `gitCapture.linesAdded + linesRemoved > 0` to
    // suppress chat-only turns. But that gate locks out Cursor mid-turn
    // prompts: the agent edits files in the IDE, the working tree is
    // dirty, but `linesAdded` derives from a baseline-vs-HEAD diff that
    // doesn't see uncommitted edits the same way Claude's hook does.
    // Result: every prompt after Cursor's session-start landed with
    // `treeSha: null` and "No snapshot" disabled on the Restore button.
    //
    // Removing the outer gate and trusting createSnapshot's dedup gives
    // every code-changing prompt a tree ref — for every agent — without
    // re-introducing the empty-snapshot rows the gate was meant to
    // suppress.
    //
    // Except createSnapshot's dedup is NOT that authoritative test. It returns
    // null only when the whole tree is clean, or when the tree is byte-identical
    // to the previous snapshot. On a repo carrying pre-existing dirt the first
    // can never fire, so any unrelated tree movement — the user editing a file,
    // another agent, a sibling session — mints a snapshot and stamps it on
    // whatever prompt is current, and a chat-only turn wears a green dot in the
    // Session view next to an empty diff.
    //
    // The fix is NOT to bring the line-count gate back. Stop already reaches its
    // own verdict on this exact question: `chatOnly` is set (above, in both the
    // synthesis and safety-net branches) only when there were no commits AND no
    // transcript edits AND no working-tree changes. That third clause is
    // precisely what the old gate lacked — a Cursor mid-turn prompt has a dirty
    // tree from its IDE edits, so it is never chatOnly and keeps its tree ref.
    // Reuse that verdict instead of inventing a second, weaker one.
    // 0-based, matching every other promptIndex in the system: the mappings
    // above (`currentPromptIdx = prompts.length - 1`), the two snapshot
    // uploaders, and the dashboard's turnIndex. This call used to pass
    // `prompts.length` — one past the turn it describes. Harmless so far only
    // because SnapshotMeta.promptIndex is written and never read, and because
    // Stop's snapshot is local-only (the server's copy comes from the watcher
    // or pre-tool-use, both already 0-based). Fixed before someone reads it.
    const snapshotPromptIdx = Math.max(0, prompts.length - 1);
    if (!shouldAutoSnapshot(promptMappings, prompts.length)) {
      debugLog('stop', 'auto-snapshot skipped: chat-only prompt', {
        promptIndex: snapshotPromptIdx,
      });
    } else {
      try {
        const cpId = createSnapshot(state.repoPath, {
          sessionTag: state.sessionTag,
          prompt: prompts.length > 0 ? prompts[prompts.length - 1] : undefined,
          model: model || state.model,
          tokensUsed: parsed.tokensUsed || 0,
          costUsd: costUsd || 0,
          promptIndex: snapshotPromptIdx,
          type: 'auto',
          linesAdded: gitCapture.linesAdded || 0,
          linesRemoved: gitCapture.linesRemoved || 0,
          transcriptPath: state.transcriptPath,
        });
        if (cpId) {
          debugLog('stop', 'auto-snapshot created', {
            snapshotId: cpId,
            promptIndex: snapshotPromptIdx,
            lines: (gitCapture.linesAdded || 0) + (gitCapture.linesRemoved || 0),
          });
        } else {
          debugLog('stop', 'auto-snapshot skipped by createSnapshot dedup (clean tree or unchanged from last)', {
            promptIndex: snapshotPromptIdx,
          });
        }
      } catch (cpErr: any) {
        debugLog('stop', 'auto-snapshot failed (non-fatal)', { message: cpErr.message });
      }
    }

    // Re-save state with RUNNING status FIRST so it survives any errors below
    state.status = 'RUNNING';
    saveSessionState(state, found!.saveCwd, state.sessionTag);

    // Write session files to origin-sessions branch + push on every Stop.
    // Pass promptEditsByIndex through so changes.json carries the
    // authoritative editsJson for each prompt — lets a different Origin
    // org importing this repo run AI Blame against the LCS-replay path
    // instead of falling back to block-matching pc.diff.
    try {
      const apiUrl = config?.apiUrl || 'https://getorigin.io';
      const writeData = buildSessionWriteData({
        state, parsed, promptMappings, gitCapture,
        status: 'running', apiUrl,
        promptEditsByIndex: promptEditsByIndex ?? undefined,
      });
      // Store only — no publish/push on the per-prompt path. Folding into the
      // shared origin-sessions branch rewrites its whole tree, so doing it every
      // prompt is exactly the cost (and cross-agent contention) the refs backend
      // exists to avoid. The session is durable locally the moment this returns;
      // it reaches the remote at the next publish moment — a commit, or session
      // end — which is also when another user would have reason to read it.
      writeSessionFiles(state.repoPath, writeData);
      debugLog('stop', 'session files written', { prompts: writeData.prompts.length, costUsd: writeData.costUsd });
    } catch (gitErr: any) {
      debugLog('stop', 'session files write/push failed (non-fatal)', { message: gitErr.message });
    }

    // Update handoff context after each prompt stop (always fresh for next agent)
    try {
      const todos = extractTodosFromPrompts(prompts);
      const handoffData = {
        version: 1 as const,
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model: model || state.model || 'unknown',
        endedAt: new Date().toISOString(),
        branch: getBranch(found!.saveCwd) || state.branch,
        prompts: prompts.map(p => p.slice(0, 500)),
        summary: parsed.summary || null,
        filesChanged,
        linesAdded: gitCapture.linesAdded || 0,
        linesRemoved: gitCapture.linesRemoved || 0,
        lastPrompt: (prompts[prompts.length - 1] || '').slice(0, 2000),
        lastResponse: null,
        openTodos: todos,
      };
      // Don't let a chat-only turn (no files, no line changes, no TODOs)
      // overwrite the last real handoff — its "summary" is just echoed context,
      // which is what fed the memory-about-memory loop.
      if (handoffRepresentsWork(handoffData) || todos.length > 0) {
        writeHandoff(state.repoPath, handoffData);
      }
    } catch {
      // Non-fatal
    }
  } catch (err: any) {
    debugLog('stop', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] stop error: ${err.message}\n`);
  }
}

async function handleSessionEnd(input: Record<string, any>, agentSlug?: string): Promise<void> {
  // Many agents fire sessionEnd after each prompt/task, NOT on actual exit.
  // Treat it as an update (like Stop) so the session stays RUNNING.
  // The heartbeat daemon detects when the agent actually exits and ends the session.
  // Copilot fires sessionEnd after EVERY agentStop (the agent goes idle waiting
  // for the next prompt), not on app exit — so treating it as terminal marked
  // the session COMPLETED after every prompt. Treat it as a Stop; the heartbeat
  // daemon's transcript-mtime staleness check ends the session when the Copilot
  // app actually closes.
  const agentsWithFakeSessionEnd = ['cursor', 'codex', 'claude-code', 'copilot'];
  if (agentsWithFakeSessionEnd.includes(agentSlug || '')) {
    // Capture the raw sessionEnd payload. Cursor 2.x sends a rich payload
    // (reason, final_status, duration_ms, is_background_agent, conversation_id)
    // and we currently discard it — downgrading every sessionEnd to a Stop
    // because it fires per-turn, not only on exit. If Cursor emits a DISTINCT
    // `reason`/`final_status` on an actual tab/window CLOSE, this handler can
    // end the Origin session immediately instead of waiting on the idle sweep.
    // Log the values so one real tab-close reveals the close signal to wire on.
    debugLog('session-end', 'fake sessionEnd — payload (capturing for close-detection)', {
      agentSlug,
      reason: input.reason ?? null,
      final_status: input.final_status ?? null,
      duration_ms: input.duration_ms ?? null,
      is_background_agent: input.is_background_agent ?? null,
      conversation_id: input.conversation_id ?? null,
    });
    return handleStop(input, agentSlug);
  }

  debugLog('session-end', 'begin', { cwd: input.cwd });

  const config = loadConfig();
  const connected = isConnectedMode();
  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = normalizeWorkspaceRoot(input.workspace_roots[0]);
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  const state = found?.state || null;
  if (!state) {
    debugLog('session-end', 'ABORT: missing state', { hasConfig: !!config, hasState: !!state });
    return;
  }

  debugLog('session-end', 'state loaded', { sessionId: state.sessionId, promptCount: state.prompts.length });

  // Self-heal a local-only session before we try to end it — otherwise
  // api.endSession on a `local-` id 404s and the whole session is lost
  // from Origin (the exact "I don't see this session" gap).
  await ensureServerSession(state, found!.saveCwd, agentSlug, 'session-end');

  // Update transcript path if provided
  if (input.transcript_path) {
    state.transcriptPath = input.transcript_path;
  }

  // Auto-discover Gemini transcript path if not already set
  if (!state.transcriptPath) {
    const discovered = discoverGeminiTranscriptPath({
      sessionId: state.agentSessionId || state.claudeSessionId || undefined,
    });
    if (discovered) {
      state.transcriptPath = discovered;
      debugLog('session-end', 'auto-discovered transcript path', { discovered });
    }
  }

  try {
    const parsed = parseTranscript(state.transcriptPath, { since: state.startedAt, repoRoots: sessionRepoRoots(state) });

    // Format transcript for dashboard display (converts JSONL → [{role, content}] JSON)
    let displayTranscript = formatTranscriptForDisplay(state.transcriptPath, { verbose: !!state.verboseCapture });
    debugLog('session-end', 'formatted transcript', { displayLength: displayTranscript.length });

    // Devin CLI: the ATIF transcript (~/.local/share/devin/cli/transcripts/
    // <id>.json) is finalized when the CLI exits — which lands at SessionEnd,
    // ~2s AFTER the last Stop hook, so Stop misses the final turn's data. Read
    // it here (the reliable point) to recover the real model, real tokens,
    // tool-call count and the assistant output. Same supplement as handleStop.
    //
    // Re-tag first (see handleStop): a Devin run with only the claude-code hook
    // installed arrives as agentSlug='claude-code'. SessionEnd fires as the
    // devin CLI exits, so its process may already be gone from our ancestry —
    // honor a re-tag an earlier hook (SessionStart/Stop) already persisted to
    // state.agentSlug, in addition to a fresh process probe. This is the
    // reliable capture point: the transcript is finalized by CLI exit.
    if ((retagDevinFromProcess(agentSlug) === 'devin' || state.agentSlug === 'devin') && agentSlug !== 'devin') {
      debugLog('session-end', 're-tagging claude-code hook as devin (process or prior state)', {});
      agentSlug = 'devin';
      state.agentSlug = 'devin';
    }
    let devinPromptTimes: (string | undefined)[] | undefined;
    if (agentSlug === 'devin') {
      // PRIMARY: Devin's LIVE sessions.db keyed by the hook's own session_id
      // (see handleStop). Falls through to the transcript path when absent.
      const devinLiveId = state.claudeSessionId || state.agentSessionId || input.session_id;
      const devinLive = typeof devinLiveId === 'string' && devinLiveId
        ? readDevinLiveSession(devinLiveId)
        : null;
      if (devinLive) {
        debugLog('session-end', 'devin live sessions.db capture', {
          sessionId: devinLiveId, model: devinLive.model, tokens: devinLive.tokensUsed,
          toolCalls: devinLive.toolCalls, hasTranscript: !!devinLive.transcript,
        });
        if (devinLive.model && isSpecificModel(devinLive.model)) parsed.model = devinLive.model;
        if (devinLive.tokensUsed > 0) {
          parsed.tokensUsed = devinLive.tokensUsed;
          parsed.inputTokens = devinLive.inputTokens;
          parsed.outputTokens = devinLive.outputTokens;
          parsed.cacheReadTokens = devinLive.cacheReadTokens;
        }
        if (devinLive.toolCalls > 0) parsed.toolCalls = devinLive.toolCalls;
        if (devinLive.transcript) displayTranscript = devinLive.transcript;
        if (devinLive.promptTimes.some(Boolean)) devinPromptTimes = devinLive.promptTimes;
      }
      // Locate the transcript by content (the run's prompt), not by session_id.
      const devinData = devinLive ? null : discoverDevinCliSessionDataByPrompt(state.prompts || [], { since: state.startedAt });
      if (devinData) {
        debugLog('session-end', 'supplementing with Devin CLI transcript', {
          model: devinData.model, tokens: devinData.tokensUsed,
          toolCalls: devinData.toolCalls, prompts: devinData.prompts.length,
          hasTranscript: !!devinData.transcript,
        });
        if (devinData.model && isSpecificModel(devinData.model)) parsed.model = devinData.model;
        if (parsed.tokensUsed === 0 && devinData.tokensUsed > 0) {
          parsed.tokensUsed = devinData.tokensUsed;
          parsed.inputTokens = devinData.inputTokens;
          parsed.outputTokens = devinData.outputTokens;
          parsed.cacheReadTokens = devinData.cacheReadTokens;
        }
        if (devinData.toolCalls > 0 && parsed.toolCalls === 0) {
          parsed.toolCalls = devinData.toolCalls;
        }
        // Per-turn output: only adopt this turn's transcript (see handleStop) —
        // never clobber a captured turn with an earlier turn's transcript, and
        // never mutate state.prompts.
        const currentPrompt = ((state.prompts || [])[(state.prompts || []).length - 1] || '').trim();
        const isCurrentTurn = !!currentPrompt && devinData.prompts.some((p) => {
          const t = p.trim();
          return t === currentPrompt || t.includes(currentPrompt) || currentPrompt.includes(t);
        });
        if (isCurrentTurn && devinData.transcript) displayTranscript = devinData.transcript;
      }
      // See handleStop — Devin finalizes its transcript as the CLI exits, which
      // can land after this hook. Queue so a later Devin hook backfills it.
      if (!devinLive && (!devinData || !devinData.transcript)) {
        queueDevinBackfill({
          sessionId: state.sessionId,
          prompts: state.prompts || [],
          startedAt: state.startedAt,
        });
        debugLog('session-end', 'queued Devin backfill (transcript not written yet)', {
          sessionId: state.sessionId, prompts: (state.prompts || []).length,
        });
      }
    }

    const prompts = reconcilePromptHistory(state.prompts, parsed.prompts);
    if (prompts.length > (state.prompts?.length || 0)) state.prompts = [...prompts];

    // For agents without transcripts (Codex, Gemini, etc.): synthesize
    // displayTranscript from captured prompts AND any assistant replies
    // captured at stop-time (Gemini's `prompt_response`).
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
      debugLog('session-end', 'synthesized transcript from prompts', {
        turnCount: turns.length, responseCount: responses.filter(Boolean).length,
      });
    }

    // F9: Redact secrets before sending to API
    const config_ = loadConfig();
    const shouldRedact = config_?.secretRedaction !== false; // default: true
    const redactedPrompts = shouldRedact
      ? prompts.map(p => redactSecrets(p).redacted)
      : prompts;
    const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    // Prefer: stdin model → transcript → state
    const stdinModel2 = (input.model && input.model !== 'default' && input.model !== 'unknown') ? input.model : '';
    const model = stdinModel2 || parsed.model || state.model;
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens, { cacheCreation1hTokens: parsed.cacheCreation1hTokens });

    // Capture real git state: HEAD SHA, new commits, unified diff. The
    // session-end snapshot powers AI Blame's full-file render, so capture
    // with unlimited unified context — every unchanged line ships as
    // context so the UI never has to fall back to "N lines hidden".
    const gitCapture = captureGitState(state.repoPath, state.headShaAtStart, { fullContext: true });
    // Exclude pre-existing uncommitted dirt (from earlier sessions left in the
    // working tree) so the stored sessionDiff reflects ONLY what this session
    // changed — line-level, against the session-start snapshot.
    scopeSessionDiffToStart(gitCapture, state.repoPath, state.sessionStartShadowSha);

    // Extract prompt → file change mappings from transcript
    let promptMappings = extractPromptFileMappings(state.transcriptPath, { since: state.startedAt, repoRoots: sessionRepoRoots(state) });

    // Fall back to git-captured files if transcript parsing didn't find any
    let filesChanged = parsed.filesChanged;
    if (filesChanged.length === 0 && gitCapture.commitDetails.length > 0) {
      const gitFiles = new Set<string>();
      for (const commit of gitCapture.commitDetails) {
        for (const f of commit.filesChanged) gitFiles.add(f);
      }
      filesChanged = Array.from(gitFiles);
      debugLog('session-end', 'using git-captured files (transcript had none)', { count: filesChanged.length });
    }

    // Multi-repo: capture session-level files from all repos
    if (state.repoPaths && state.repoPaths.length > 1 && state.perRepoState) {
      const multiRepoFiles = new Set<string>();
      for (const rp of state.repoPaths) {
        const rpState = state.perRepoState[rp];
        if (!rpState?.headShaAtStart) continue;
        try {
          const rpCapture = captureGitState(rp, rpState.headShaAtStart, { fullContext: true });
          const repoDir = path.basename(rp);
          for (const c of rpCapture.commitDetails) {
            for (const f of c.filesChanged) multiRepoFiles.add(`${repoDir}/${f}`);
          }
          if (rpCapture.uncommittedDiff) {
            for (const m of rpCapture.uncommittedDiff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) multiRepoFiles.add(`${repoDir}/${m[1]}`);
            }
          }
        } catch { /* skip this repo */ }
      }
      if (multiRepoFiles.size > 0) {
        filesChanged = Array.from(multiRepoFiles);
        debugLog('session-end', 'multi-repo filesChanged', { count: filesChanged.length });
      }
    }

    // Capture diff for the last prompt if prePromptSha exists
    if (state.prePromptSha && prompts.length > 0) {
      // Native, for the same reason as handleStop: this becomes a mapping row's
      // promptIndex, so it has to be in the transcript's numbering, not the
      // session-relative one.
      const lastPromptIdx = parsed.promptIndexBase + prompts.length - 1;
      const lastPromptCapture = captureGitState(state.repoPath, state.prePromptSha, { fullContext: true });
      // Scope committed side to commits this session authored (see
      // sessionScopedCommittedDiff) and to THIS TURN's window — the same
      // `state.prePromptSha` `lastPromptCapture` was baselined at, so the
      // final turn doesn't inherit commits earlier turns already carried.
      const sessionCommitted = sessionScopedCommittedDiff(
        state.repoPath, state, state.prePromptSha,
      );
      // Files from the turn-scoped committed diff, not `commitDetails` — see
      // the same change at the user-prompt-submit retro capture.
      const lastFilesSet = new Set<string>();
      for (const m of sessionCommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
        if (m[1]) lastFilesSet.add(m[1]);
      }
      if (lastPromptCapture.diff) {
        for (const m of lastPromptCapture.diff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
          if (m[1]) lastFilesSet.add(m[1]);
        }
      }
      // Filter uncommitted diff against the prompt-baseline + session-start
      // pre-existing dirt union.
      const filteredUncommitted = filterUncommittedDiff(
        lastPromptCapture.uncommittedDiff || '', uncommittedExcludeUnion(state),
      );
      if (filteredUncommitted) {
        for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
          if (m[1]) lastFilesSet.add(m[1]);
        }
      }
      if (lastPromptCapture.diff || filteredUncommitted || lastFilesSet.size > 0) {
        if (!state.completedPromptMappings) state.completedPromptMappings = [];
        // Capture commit/tree SHAs so the commit-detail page can link the
        // last prompt to the commit it produced.
        let lastCommitSha: string | null = null;
        let lastTreeSha: string | null = null;
        try {
          lastCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* ignore */ }
        lastTreeSha = getWorkingTreeSha(state.repoPath);
        const lastMapping = {
          promptIndex: lastPromptIdx,
          promptText: (prompts[prompts.length - 1] || '').slice(0, 1000),
          filesChanged: Array.from(lastFilesSet),
          diff: ((sessionCommitted + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim()).slice(0, 200_000),
          uncommittedDiff: filteredUncommitted.slice(0, 200_000),
          commitSha: lastCommitSha,
          treeSha: lastTreeSha,
        };
        const existingIdx = state.completedPromptMappings.findIndex(m => m.promptIndex === lastPromptIdx);
        if (existingIdx >= 0) {
          state.completedPromptMappings[existingIdx] = lastMapping;
        } else {
          state.completedPromptMappings.push(lastMapping);
        }
        debugLog('session-end', 'captured last prompt diff', {
          promptIndex: lastPromptIdx, filesChanged: lastFilesSet.size,
        });
      }
    }

    // Merge transcript-based mappings with git-based completedPromptMappings
    {
      const savedMappings = state.completedPromptMappings || [];
      if (promptMappings.length > 0 && savedMappings.length > 0) {
        promptMappings = mergePromptMappings(savedMappings, promptMappings);
      } else if (promptMappings.length === 0 && savedMappings.length > 0) {
        promptMappings = savedMappings;
      }
      debugLog('session-end', 'prompt mappings merged', {
        transcriptCount: extractPromptFileMappings(state.transcriptPath, { since: state.startedAt, repoRoots: sessionRepoRoots(state) }).length,
        savedCount: savedMappings.length,
        totalCount: promptMappings.length,
      });
    }

    // Hoisted so writeSessionFiles below the `if (connected)` block can
    // pass editsJson into changes.json (mirrors the stop-hook hoist).
    let promptEditsByIndex: Map<number, string> | null = null;

    if (connected) {
      debugLog('session-end', 'calling api.endSession', {
        sessionId: state.sessionId,
        promptCount: prompts.length,
        filesCount: filesChanged.length,
        tokensUsed: parsed.tokensUsed,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        durationMs,
        costUsd,
        hasDiff: !!gitCapture.diff,
        promptMappings: promptMappings.length,
        mappings: summarizePromptPayload(promptMappings),
      });

      // ─── Shell writes → real edits ────────────────────────────────────
      // Same as the Stop path: a turn whose writes went through the shell has
      // no tool call to capture, so derive them from its git window before the
      // extractor runs. Sessions that end without a final Stop (Gemini, a
      // killed agent) reach the capture pipeline only here.
      try {
        const shellPromptIdx = (prompts.length || 0) - 1;
        const wtTargetB = shellWindowTarget(
          state, shellPromptIdx, state.prePromptSha, currentSessionWorkTree(state),
        );
        const extraB = recordDiscoveredWorkTreeEdits(state, shellPromptIdx);
        if (recordShellWindowEdits(state, wtTargetB.repoPath, shellPromptIdx, wtTargetB.baseline) || extraB) {
          saveSessionState(state, found!.saveCwd, state.sessionTag);
        }
      } catch (shellErr: unknown) {
        debugLog('session-end', 'shell window capture threw (non-fatal)', {
          message: shellErr instanceof Error ? shellErr.message : String(shellErr),
        });
      }

      // ─── New per-prompt PromptCapture pipeline ────────────────────────
      // Gemini (and any other agent that hits handleSessionEnd directly)
      // runs the agent-specific extractor here so each PromptChange row
      // carries editsJson — the server-side blame computes the displayed
      // diff and attribution from this directly.
      // `promptEditsByIndex` is declared at function scope above so the
      // writeSessionFiles call below `if (connected)` can also pick it up.
      try {
        const slug = (agentSlug || state.agentSlug || '').toLowerCase();
        // Same table as handleStop — see the note there. A second hand-written
        // ternary is how these two drifted apart in the first place.
        const editSource = editSourceForAgent(slug);
        const captureAgent = editSource.captureAgent;
        // Mirror the Codex codexPrompts wiring from handleStop so this
        // entry point (Gemini-shaped session end, occasionally Codex
        // when fakeSessionEnd kicks in) also feeds the extractor a
        // reliable per-prompt timeline.
        let codexPromptsForCapture: Array<{ text: string; timestamp: number }> | undefined;
        if (captureAgent === 'codex') {
          try {
            const codexThreadId = state.agentSessionId || state.claudeSessionId || undefined;
            const timeline = getCodexPromptsTimeline(state.repoPath, codexThreadId);
            if (timeline.length > 0) {
              codexPromptsForCapture = timeline.map((t) => ({
                text: t.text || '',
                timestamp: t.timestamp || 0,
              }));
            }
          } catch { /* non-fatal */ }
        }
        // Ledger agents legitimately have no transcript extractor — see handleStop.
        const transcriptCaptures = captureAgent
          ? capturePromptEdits({
            agent: captureAgent,
            repoPath: state.repoPath,
            transcriptPath: state.transcriptPath,
            codexPrompts: codexPromptsForCapture,
            sessionCommitShas: state.sessionCommitShas || [],
            // Attestation from post-commit: which turn each commit landed under.
            // Lets the owner resolution below use what was observed instead of
            // falling back to "the highest-index turn that claims the sha".
            commitTurns: state.commitTurns || [],
            promptTurnIds: state.promptTurnIds || [],
            headShaAtStart: state.headShaAtStart || undefined,
            headShaAtEnd: gitCapture.headAfter || undefined,
          })
          : [];
        if (!captureAgent) {
          debugLog('session-end', 'no transcript extractor for agent', { slug, editSource: editSource.kind });
        }
        const captures = applyLiveLedger(transcriptCaptures, state, 'session-end');
        if (captures.length > 0) {
          promptEditsByIndex = new Map();
          for (const cap of captures) {
            // Anchor transcript-only edits (e.g. Gemini) against the
            // final on-disk file; live edits are already positioned.
            if (state.repoPath) {
              // Give whole-file writes their missing before-state FIRST, so
              // the synthesized diff is a real replace instead of a
              // whole-file insertion (see backfillWriteBaselines).
              backfillWriteBaselines(
                cap.edits,
                state.repoPath,
                // THIS turn's start-state, not the session's.
                turnBaselineForServerRow(state, cap.promptIndex),
              );
              anchorEditPositions(cap.edits, state.repoPath);
            }
            promptEditsByIndex.set(cap.promptIndex, JSON.stringify(cap));
          }
          debugLog('session-end', 'capturePromptEdits ok', {
            agent: captureAgent,
            captured: captures.length,
            totalEdits: captures.reduce((n, c) => n + c.edits.length, 0),
          });
        }
      } catch (capErr: unknown) {
        debugLog('session-end', 'capturePromptEdits failed (non-fatal)', {
          message: capErr instanceof Error ? capErr.message : String(capErr),
        });
      }

      await durableEnd(state.sessionId, {
        sessionId: state.sessionId,
        prompt: joinedPrompt || undefined,
        summary: parsed.summary || undefined,
        transcript: displayTranscript || undefined,
        // Upgrade the session's model to the real identifier resolved from
        // the transcript (e.g. "claude-opus-4-8"). session/start often only
        // had the bare brand ("claude"), so without this the commit list
        // shows "Claude · Claude" instead of "Claude · Opus 4.8". Only send
        // a specific model so we never downgrade a real value to the brand.
        model: isSpecificModel(model) ? model : undefined,
        filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
        tokensUsed: parsed.tokensUsed > 0 ? parsed.tokensUsed : undefined,
        // Cursor's tokens are always chars-estimated (agents/cursor.ts) — flag
        // so money dashboards and the benchmark measured-subset don't treat them
        // as exact. (This handler has no chars/4 fallback; Cursor is its only
        // estimated source. Antigravity flags itself on its own path.)
        tokensEstimated: parsed.tokensUsed > 0 ? (agentSlug === 'cursor') : undefined,
        inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
        outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
        cacheReadTokens: parsed.cacheReadTokens > 0 ? parsed.cacheReadTokens : undefined,
        cacheCreationTokens: parsed.cacheCreationTokens > 0 ? parsed.cacheCreationTokens : undefined,
        cacheCreation1hTokens: parsed.cacheCreation1hTokens > 0 ? parsed.cacheCreation1hTokens : undefined,
        toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
        // See the stop handler — structured tool/files data so the PR-detail
        // "behind the work" view doesn't depend on transcript-text markers.
        toolBreakdown: parsed.toolBreakdown.length > 0 ? parsed.toolBreakdown : undefined,
        filesRead: mergeFilesRead(parsed.filesRead, state.filesRead),
        // The agent's OWN name for this chat, when it has one. Sent on every
        // update rather than once at start: people rename conversations
        // mid-run, and Claude Code rewrites the record each time.
        agentSessionName: resolveAgentSessionName(state) || undefined,
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        gitCapture: gitCapture.diff ? gitCapture : undefined,
        promptChanges: promptMappings.length > 0
          ? promptMappings.map(withDerivedLineCounts).map((pm, _i, all) => ({
              ...pm,
              promptText: (pm.promptText || '').slice(0, 1000),
              diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
              editsJson: promptEditsByIndex?.get(pm.promptIndex) || undefined,
              // Nested-repo writes belong to the turn that just ended — the
              // highest index present — because the window they were measured
              // against is that turn's.
              ...(outOfRepoFilesFor(
                promptEditsByIndex?.get(pm.promptIndex),
                pm.promptIndex === Math.max(...all.map((x) => x.promptIndex))
                  ? nestedRepoWritesForOpenTurn(state)
                  : [],
              )),
              ...(turnIdFor(state, pm.promptIndex) && { turnId: turnIdFor(state, pm.promptIndex) }),
              ...captureStamp(),
              // Real Devin submission time (see handleStop) — fixes commit
              // attribution when a turn's prompt was recorded after its commit.
              ...(devinPromptTimes?.[pm.promptIndex]
                ? { createdAt: devinPromptTimes[pm.promptIndex] }
                : {}),
            }))
          : undefined,
        branch: getBranch(hookCwd) || undefined,
      });
      debugLog('session-end', 'api.endSession complete');
    }

    // Trail attachment is handled server-side at session/end now (see
    // services/trails.ts) — no CLI-side git-ref trail store to update.

    // Write session files to origin-sessions branch (directory per session).
    // Pass promptEditsByIndex so changes.json ships the authoritative
    // per-prompt edits — see the equivalent stop-hook block for rationale.
    const apiUrl = config?.apiUrl || 'https://getorigin.io';
    const writeData = buildSessionWriteData({
      state, parsed, promptMappings, gitCapture,
      status: 'ended', apiUrl,
      promptEditsByIndex: promptEditsByIndex ?? undefined,
    });
    writeSessionFiles(state.repoPath, writeData);
    // Publish moment: fold onto the origin-sessions branch and push, so the
    // finished session travels to whoever clones next.
    pushSessionBranch(state.repoPath, writeData.sessionId);
    debugLog('session-end', 'session files written + published');

    // Write Git Notes with AI attribution metadata on each commit
    if (gitCapture.commitShas.length > 0) {
      try {
        writeGitNotes(state.repoPath, gitCapture.commitShas, {
          sessionId: state.sessionId,
          model,
          agentSlug: agentSlug || state.agentSlug,
          promptCount: prompts.length,
          promptSummary: prompts[0] || '',
          fullPrompt: prompts[prompts.length - 1] || prompts[0] || undefined,
          previousSessionId: state.previousSessionId,
          filesRead: state.filesRead,
          prompts: buildPromptNoteEntries(state, agentSlug || state.agentSlug, model, promptEditsByIndex),
          // Parse the agent's own [Origin: …] markers from the transcript so
          // the "why" behind this change travels in the note (pulled per-file
          // by a later agent via get_file_context). Non-fatal on parse error.
          markers: parseMarkersFromTranscript(parsed.transcript),
          tokensUsed: parsed.tokensUsed,
          costUsd,
          durationMs,
          linesAdded: gitCapture.linesAdded,
          linesRemoved: gitCapture.linesRemoved,
          originUrl: `${apiUrl}/sessions/${state.sessionId}`,
        });
        debugLog('session-end', 'git notes written', { commitCount: gitCapture.commitShas.length });
      } catch (err: any) {
        debugLog('session-end', 'git notes error (non-fatal)', { message: err.message });
      }
    }

    // Backfill acceptance for the *previous* session's commits. Now that
    // this session has ended, any of the prior session's lines that were
    // overwritten (or kept) here will be reflected. Writes to a separate
    // ref (refs/notes/origin-acceptance) so original notes stay immutable.
    if (state.previousSessionId) {
      try {
        const written = backfillAcceptanceForSession(state.repoPath, state.previousSessionId, {
          sinceIso: state.previousSessionStartedAt,
        });
        if (written > 0) {
          debugLog('session-end', 'acceptance backfill written', {
            previousSessionId: state.previousSessionId,
            commitsAnnotated: written,
          });
          // Push here rather than in writeGitNotes: that runs EARLIER in
          // session-end, before this backfill exists, so it would ship the
          // previous run's acceptance and never this one's. Best-effort —
          // pre-push carries whatever this misses.
          try {
            const remote = resolvePushRemote(state.repoPath);
            if (remote) pushAcceptanceNotes(state.repoPath, remote);
          } catch { /* never block session-end */ }
        }
      } catch (err: any) {
        debugLog('session-end', 'acceptance backfill error (non-fatal)', { message: err.message });
      }
    }

    // The session's commit subjects — feed the LLM (as intent-of-record) AND
    // power the deterministic no-key fallback below.
    const sessionCommitSubjects = (gitCapture.commitShas || []).map((sha) => {
      try { return execFileSync('git', ['log', '-1', '--format=%s', sha], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8' }).trim(); } catch { return ''; }
    }).filter(Boolean);

    // Optionally synthesize a real one-line "what this session did" summary via
    // the LLM (config.memorySummary='llm'), grounded in the prompts + commit
    // messages + the actual code diff. Self-gating + never throws: returns null
    // when disabled, keyless, or no real work — so both the handoff and the
    // memory entry below fall back to the heuristic exactly as before.
    let synthesizedSummary: string | null = null;
    // A bounded diff of the session's code changes, so the model summarizes from
    // what CHANGED, not just prompts/messages (also fed to the continuation
    // brief below). Best-effort; only gathered in llm mode. Hoisted so both the
    // summary and the brief can use it.
    let sessionDiff = '';
    if (memorySummaryMode() === 'llm' && state.headShaAtStart) {
      try { sessionDiff = execFileSync('git', ['diff', `${state.headShaAtStart}..HEAD`], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 }); } catch { /* best-effort */ }
    }
    let synthesizedFileNotes: Record<string, string> | undefined;
    // Decisions: explicit [Origin: Decision] markers (ground truth) merged with
    // the LLM's inferred decisions — the "why" a future agent can't get from code.
    const sessionDecisions: string[] = [];
    // Keep the WHOLE marker set: intent/open/verify are parsed here too and
    // used to be dropped on the floor, which is why the memory digest could
    // only ever answer "what changed" and never "what for / what's left / how
    // to check".
    let sessionMarkers: OriginMarkers | undefined;
    try {
      sessionMarkers = parseMarkersFromTranscriptPath(state.transcriptPath);
      for (const d of sessionMarkers?.decision || []) if (d && !sessionDecisions.includes(d)) sessionDecisions.push(d);
    } catch { /* best-effort */ }
    try {
      const synth = await synthesizeSessionSummary({
        prompts,
        filesChanged,
        linesAdded: gitCapture.linesAdded,
        linesRemoved: gitCapture.linesRemoved,
        commitSubjects: sessionCommitSubjects,
        diff: sessionDiff,
      });
      if (synth) {
        synthesizedSummary = synth.summary;
        if (synth.fileNotes && Object.keys(synth.fileNotes).length > 0) synthesizedFileNotes = synth.fileNotes;
        for (const d of (synth.decisions || [])) if (d && !sessionDecisions.includes(d)) sessionDecisions.push(d);
        debugLog('session-end', 'synthesized session summary', { summary: synthesizedSummary, fileNotes: Object.keys(synth.fileNotes || {}).length, decisions: sessionDecisions.length });
      }
    } catch { /* non-fatal — fall back to heuristic */ }

    // Deterministic fallback (no key): summarize from the session's commit
    // messages — "Add calculator; Add clock" beats a vague opening prompt or an
    // empty "No summary".
    //
    // Computed whenever there's no LLM summary, and preferred OVER
    // `parsed.summary` below. `parsed.summary` is just the last assistant
    // message off the transcript, capped at 500 chars — on a short session
    // that is the agent's opening PLAN ("I'll look at the existing scripts so
    // the new one matches, then add it and commit"), i.e. what it meant to do,
    // not what it did. Commit subjects are the session's own record of what
    // actually landed, so they win; assistant prose stays as the fallback for
    // sessions that committed nothing.
    const commitSummary: string | null = !synthesizedSummary
      ? summarizeFromCommitSubjects(sessionCommitSubjects)
      : null;

    // Write cross-agent handoff context for next session
    try {
      const todos = extractTodosFromPrompts(prompts);
      const handoffData = {
        version: 1 as const,
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model,
        endedAt: new Date().toISOString(),
        branch: getBranch(hookCwd) || state.branch,
        prompts: prompts.map(p => p.slice(0, 500)),
        summary: synthesizedSummary || commitSummary || parsed.summary || null,
        filesChanged,
        linesAdded: gitCapture.linesAdded,
        linesRemoved: gitCapture.linesRemoved,
        lastPrompt: (prompts[prompts.length - 1] || '').slice(0, 2000),
        lastResponse: null, // Could extract from transcript later
        openTodos: todos,
      };
      // Skip chat-only turns (no files, no line changes, no TODOs) so a
      // "what's in my memory?" answer never overwrites the last real handoff.
      if (handoffRepresentsWork(handoffData) || todos.length > 0) {
        writeHandoff(state.repoPath, handoffData);
        debugLog('session-end', 'handoff written', { filesCount: filesChanged.length, todosCount: todos.length });
      } else {
        debugLog('session-end', 'handoff skipped (chat-only, no work) — preserving last real handoff');
      }
    } catch (err: any) {
      debugLog('session-end', 'handoff write error (non-fatal)', { message: err.message });
    }

    // Write session memory entry for repo history (gated by memoryUpdate —
    // 'session-end'/'both' write here; 'commit' relies on the post-commit hook).
    try {
      if (shouldWriteMemoryOnSessionEnd(memoryUpdateTrigger())) writeSessionMemory(state.repoPath, buildMemoryEntry(state, {
        agentSlug: agentSlug || undefined,
        model,
        branch: getBranch(hookCwd) || state.branch,
        filesChanged,
        linesAdded: gitCapture.linesAdded,
        linesRemoved: gitCapture.linesRemoved,
        summary: synthesizedSummary || commitSummary || parsed.summary || undefined,
        prompts,
        fileNotes: synthesizedFileNotes,
        decisions: sessionDecisions,
        markers: sessionMarkers,
      }));
      debugLog('session-end', 'session memory written');
    } catch (err: any) {
      debugLog('session-end', 'session memory error (non-fatal)', { message: err.message });
    }

    // Trailing decisions backfill. Agents that commit BEFORE writing their
    // response (Cursor, sometimes Codex) emit the [Origin: Decision] marker into
    // the transcript AFTER the commit-time capture already froze the rollup and
    // commit records with no decisions. By session-end the transcript is fully
    // written, so FILL those in — runs regardless of memoryUpdate (a correction,
    // not a fresh write), and covers the commit records the gated write above
    // never touches. Fill-only, so it can't clobber agy/LLM-derived decisions.
    try {
      if (sessionDecisions.length > 0) {
        const filled = enrichDecisionsForSession(state.repoPath, state.sessionId, sessionDecisions);
        if (filled) debugLog('session-end', 'backfilled late decisions', { sessionId: state.sessionId, count: sessionDecisions.length });
      }
    } catch { /* non-fatal */ }

    // Regenerate the cross-session continuation brief for the NEXT agent, using
    // the just-ended session's code diff to ground it.
    scheduleMemoryBriefRefresh(state.repoPath, connected, 'session-end', sessionDiff);

    // Extract and store TODOs from prompts
    try {
      const todosAdded = addTodosFromSession(
        state.sessionId, prompts, state.repoPath,
        getBranch(hookCwd) || state.branch,
      );
      if (todosAdded > 0) {
        debugLog('session-end', 'todos extracted', { count: todosAdded });
      }
    } catch {
      // Non-fatal
    }
  } catch (err: any) {
    debugLog('session-end', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] session-end error: ${err.message}\n`);

    // Even if transcript parsing or other steps fail, still mark the session as ended
    // so it doesn't stay RUNNING forever on the dashboard.
    if (connected) {
      try {
        const durationMs = Date.now() - new Date(state.startedAt).getTime();
        await api.endSession({
          sessionId: state.sessionId,
          prompt: state.prompts.join('\n\n---\n\n') || undefined,
          durationMs: durationMs > 0 ? durationMs : undefined,
          branch: getBranch(hookCwd) || undefined,
        });
        debugLog('session-end', 'fallback endSession succeeded');
      } catch (fallbackErr: any) {
        debugLog('session-end', 'fallback endSession also failed', { message: fallbackErr.message });
      }
    }
  } finally {
    // Final session-end snapshot removed. By the time we reach here the
    // post-commit hook has already condensed the per-commit snapshots; an
    // additional "session-end" row at this point captures whatever happens
    // to be in the working tree — which for sessions that ended without a
    // final commit is just unstaged scratch. Keeping it created the empty
    // rows the user reported in the snapshots list. The condensation /
    // shadow-cleanup below still runs.

    // Condense all session snapshots to permanent branch + clean up shadow branch
    try {
      const headSha = getHeadSha(state.repoPath) || 'unknown';
      const { condensed, cleaned } = condenseAndCleanupSession(
        state.repoPath,
        state.sessionTag || '',
        headSha,
        state.transcriptPath,
      );
      debugLog('session-end', 'snapshots condensed + shadow cleaned', { condensed, cleaned });
    } catch (cpErr: any) {
      debugLog('session-end', 'snapshot condensation failed (non-fatal)', { message: cpErr.message });
    }

    // Stop the heartbeat daemon
    stopHeartbeat(state.sessionId);
    debugLog('session-end', 'heartbeat stopped', { sessionId: state.sessionId });

    // Clear only THIS session's state file (tagged), not other concurrent sessions
    const saveCwd = found?.saveCwd || hookCwd;
    clearSessionState(saveCwd, state.sessionTag);
    debugLog('session-end', 'state cleared', { tag: state.sessionTag, saveCwd });
  }
}

// ─── Git Hook: Post-Commit ────────────────────────────────────────────────

/** A session's file evidence, whether or not its turn has finished. */
type FileEvidenceSession = {
  completedPromptMappings?: Array<{ filesChanged?: string[] }>;
  activeTurn?: { index: number } | null;
  liveEdits?: Array<{ promptIndex?: number; edits?: Array<{ file?: string }> }> | null;
  pendingWrites?: Array<{ file?: string }> | null;
};

/**
 * Files the session's OPEN turn is writing: the post-tool-use ledger entries
 * belonging to that turn, plus the pre-tool-use claims for writes announced
 * but not yet landed. Empty when no turn is open.
 *
 * `completedPromptMappings` are written at a session's OWN Stop, so for the
 * whole duration of a turn they say nothing — and a turn is exactly when
 * `git commit` runs. Every consumer that judges "whose files are these?"
 * against completed turns alone is therefore blind at the only moment the
 * question is ever asked. uncommittedExcludeUnion learned this the hard way
 * (b629d2cb, credited with a sibling's commit-attribution.test.ts because no
 * sibling MAPPING claimed it yet); the commit-owner ladder had the same blind
 * spot and this is the same repair.
 *
 * `activeTurn` is what makes it in-FLIGHT rather than merely in the ledger,
 * and it is load-bearing. `liveEdits` is the whole session's ledger, retained
 * across turns and pruned only by its size cap — 59a0fa03 carries entries for
 * prompts 17, 18 AND 19 at once, and 2e58a848 still holds prompts 1 and 2 with
 * no turn open at all. Reading it wholesale would hand the in-flight weight to
 * a file somebody edited forty minutes ago and stopped, which is the very
 * inversion this rung's recency weighting exists to prevent. `closeTurn` nulls
 * `activeTurn` at Stop, so between turns a session contributes nothing here —
 * correctly, since by then its work has moved into completedPromptMappings.
 */
function inFlightEditedFiles(session: FileEvidenceSession): string[] {
  const open = session.activeTurn;
  if (!open || !Number.isInteger(open.index)) return [];
  const out = new Set<string>();
  for (const block of session.liveEdits || []) {
    if (!block || block.promptIndex !== open.index) continue;
    for (const e of block.edits || []) {
      if (e && typeof e.file === 'string' && e.file) out.add(e.file);
    }
  }
  // Pending claims carry no turn index, but they only exist while a turn is
  // running and the guard above has already established that one is.
  for (const w of session.pendingWrites || []) {
    if (w && typeof w.file === 'string' && w.file) out.add(w.file);
  }
  return [...out];
}

/**
 * Has this session touched ANY of the committed files?
 *
 * Basename comparison for the same reason pickSessionByFileOverlap uses it:
 * mappings hold a mix of absolute and repo-relative paths, so a full-path
 * compare silently never matches (#1085).
 */
export function sessionTouchedAnyCommitFile<T extends FileEvidenceSession>(
  session: T, commitFiles: string[],
): boolean {
  if (!commitFiles || commitFiles.length === 0) return false;
  const baseOf = (f: string): string => f.split('/').pop() || f;
  const wanted = new Set(commitFiles.map(baseOf));
  for (const m of session.completedPromptMappings || []) {
    for (const f of m.filesChanged || []) {
      if (wanted.has(baseOf(f))) return true;
    }
  }
  // The in-flight turn counts too — same reason as pickSessionByFileOverlap.
  for (const f of inFlightEditedFiles(session)) {
    if (wanted.has(baseOf(f))) return true;
  }
  return false;
}

/**
 * Which sessions should receive a commit's incremental update.
 *
 * A commit has ONE author session. post-commit used to send the update to
 * every active session in the repo, handing each of them the commit's files,
 * its diff and a promptChange stamped with its SHA — so two agents sharing a
 * checkout each ended up owning the other's commits (prod 0a8e2164: three of
 * its eight commits belonged to the session next to it). The disambiguation
 * ladder was never the problem; it worked and was ignored. From hooks.log:
 *
 *   15:37:45 disambiguated by recency   {sessionId: 0a8e2164…}
 *   15:38:09 sending incremental update {sessionId: aad6cc17…}
 *   15:38:09 sending incremental update {sessionId: 0a8e2164…}
 *
 * `picked` is the ladder's answer. When it declined to guess, fall back to
 * sessions whose own edits include a committed file — a genuine two-session
 * commit still reaches its plausible owners, and a session with no connection
 * to these files is never credited. A single active session is returned
 * unchanged, ledger or not: a shell-edit turn has no mapping yet and must
 * still get its own commit.
 */
export function pickCommitUpdateTargets<
  T extends FileEvidenceSession,
>(activeSessions: T[], picked: T | null, commitFiles: string[]): T[] {
  if (activeSessions.length <= 1) return activeSessions;
  if (picked) return [picked];
  return activeSessions.filter((s) => sessionTouchedAnyCommitFile(s, commitFiles));
}

/**
 * Pick, among several concurrently-active sessions the post-commit hook
 * couldn't tell apart by agent process, the one whose recorded edits best
 * overlap the committed files. Recency-weighted: the OPEN turn's files count
 * ×4, the latest COMPLETED prompt's ×3, the last three ×2, older ×1 — so the
 * session that JUST edited what landed in the commit wins, even if an older
 * session touched the same files earlier. Returns null when no session's edits
 * overlap (caller then declines to guess). Matches on basename so repo-relative
 * vs absolute paths in the two sources still line up.
 */
export function pickSessionByFileOverlap<T extends FileEvidenceSession>(
  candidates: T[], commitFiles: string[],
): T | null {
  if (candidates.length === 0 || commitFiles.length === 0) return null;
  const baseOf = (f: string): string => f.split('/').pop() || f;
  const commitBasenames = new Set(commitFiles.map(baseOf));
  let best: T | null = null;
  let bestScore = 0;
  for (const s of candidates) {
    const mappings = s.completedPromptMappings || [];
    let score = 0;
    for (let i = 0; i < mappings.length; i++) {
      const fromEnd = mappings.length - 1 - i;
      const weight = fromEnd === 0 ? 3 : fromEnd < 3 ? 2 : 1;
      for (const f of (mappings[i].filesChanged || [])) {
        if (commitBasenames.has(baseOf(f))) score += weight;
      }
    }
    // The turn IN FLIGHT outranks the last COMPLETED one (×4 vs ×3). A commit
    // is made at the end of the turn that wrote its files, while those files
    // are still only in the live ledger — a session's mappings do not learn
    // about them until its own Stop, which has not run yet. Scoring completed
    // turns alone made the session that is at this instant writing the
    // committed file score ZERO.
    for (const f of inFlightEditedFiles(s)) {
      if (commitBasenames.has(baseOf(f))) score += 4;
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore > 0 ? best : null;
}

// Pick the ONE session that owns a commit when several are active in the repo.
// Deterministic ladder, most-specific first:
//   1. process detection (which agent binary is running) → keep same-agent sessions
//   2. commit branch → keep sessions on that branch (a stale session left
//      'RUNNING' on another branch, e.g. an old mislabeled Devin run, drops out)
//   3. file overlap → the session whose recent edits match the committed files,
//      INCLUDING the turn it has in flight — see pickSessionByFileOverlap
// Each step only narrows when it strictly reduces the set, so it never discards
// the real owner. Returns null (caller must not guess) when still ambiguous.
// Pure — the caller resolves `detectedSlug` (pgrep) and `currentBranch` (git)
// and passes them in, so this is unit-testable.
// Minimum activity gap (ms) before recency is allowed to break a tie — so two
// genuinely-concurrent sessions (stops within 2 min) are never split by a
// coin-flip; only a clearly-stale session loses.
const RECENCY_TIEBREAK_MARGIN_MS = 120_000;

export function pickSessionForCommit<
  T extends {
    sessionId?: string;
    previousSessionId?: string;
    agentSlug?: string | null;
    model?: string | null;
    branch?: string | null;
    startedAt?: string;
    lastStopAt?: string | null;
  } & FileEvidenceSession,
>(
  activeSessions: T[],
  opts: {
    detectedSlug?: string | null;
    currentBranch?: string | null;
    commitFiles?: string[];
    /**
     * The commit's FULL message, body included. Pass it and the
     * `Origin-Session:` trailer decides — see the 'trailer' rung below.
     */
    commitMessage?: string | null;
  } = {},
): { session: T | null; reason: 'trailer' | 'only' | 'process' | 'branch' | 'file-overlap' | 'recency' | 'ambiguous' | 'none' } {
  if (activeSessions.length === 0) return { session: null, reason: 'none' };

  // Rung 0 — the commit's own trailer, which outranks every rung below it.
  //
  // prepare-commit-msg wrote `Origin-Session: <id>` into this message moments
  // ago, naming the session that ran `git commit`. That is not an inference,
  // it is the answer, recorded by the party that knew it. This resolver never
  // asked: it guessed from pgrep, then branch, then file overlap. On a shared
  // checkout with two live agents that handed 35058c5d — trailered
  // `Origin-Session: 59a0fa03-dc5` — to session b05c4b43, which then showed a
  // stranger's commit on its timeline, badging a turn that had written nothing.
  //
  // Decisive only when it names exactly one session live HERE. Two sessions
  // matching one truncated trailer id is an ambiguity, not a pick; and a
  // trailer that survived an amend or rebase names an id nothing answers to
  // any more, so the rungs below should still decide that commit.
  if (opts.commitMessage) {
    const named = activeSessions.filter(
      (s) => commitTrailerBelongsToSession(opts.commitMessage as string, s) === 'self',
    );
    if (named.length === 1) return { session: named[0], reason: 'trailer' };
  }

  if (activeSessions.length === 1) return { session: activeSessions[0], reason: 'only' };

  let candidates = activeSessions;
  if (opts.detectedSlug) {
    const matched = candidates.filter((s) => sessionMatchesAgent(s, opts.detectedSlug!));
    if (matched.length > 0) candidates = matched;
  }
  if (candidates.length === 1) return { session: candidates[0], reason: 'process' };

  if (candidates.length > 1 && opts.currentBranch) {
    const onBranch = candidates.filter((s) => s.branch && s.branch === opts.currentBranch);
    if (onBranch.length >= 1 && onBranch.length < candidates.length) candidates = onBranch;
  }
  if (candidates.length === 1) return { session: candidates[0], reason: 'branch' };

  const commitFiles = opts.commitFiles || [];
  if (candidates.length > 1 && commitFiles.length > 0) {
    const best = pickSessionByFileOverlap(candidates, commitFiles);
    if (best) return { session: best, reason: 'file-overlap' };
  }

  // Last resort — recency. A fresh commit belongs to the session actively
  // working, not to a STALE one left 'RUNNING' in the same repo+branch (e.g. an
  // old Devin run that never ended — the exact case that orphaned commits). Use
  // the most recent turn completion (lastStopAt), falling back to startedAt.
  // Only decisive when the newest session leads by a clear margin, so genuine
  // concurrent sessions stay ambiguous instead of being coin-flipped.
  if (candidates.length > 1) {
    const recency = (s: T): number => Math.max(
      s.lastStopAt ? Date.parse(s.lastStopAt) || 0 : 0,
      s.startedAt ? Date.parse(s.startedAt) || 0 : 0,
    );
    const sorted = [...candidates].sort((a, b) => recency(b) - recency(a));
    if (recency(sorted[0]) - recency(sorted[1]) >= RECENCY_TIEBREAK_MARGIN_MS) {
      return { session: sorted[0], reason: 'recency' };
    }
  }
  return { session: null, reason: 'ambiguous' };
}

/**
 * Called by .git/hooks/post-commit after every commit.
 * Sends incremental session data to the API so nothing is lost
 * even if the AI session never formally ends.
 */
// Part B — live producer-pinning for Codex commits.
//
// Codex stamps `pc.commitSha` from git HEAD in its live/heartbeat capture,
// which can leak the just-made SHA onto a LATER turn (or, rarely, miss the
// producing turn when its capture ran pre-commit). The rollout's per-turn
// `[branch sha]` marker is the deterministic truth: a commit belongs to the
// turn whose tool call ran `git commit`. handleStop already backfills from it,
// but a still-RUNNING Codex session whose Stop hook is unreliable never gets
// that correction until session end. Run the SAME backfill now, on the commit,
// and PATCH the corrected per-prompt mapping so a running session attributes
// correctly immediately. Best-effort and fully guarded — it must never slow or
// break the user's commit (the commit has already succeeded by the time this
// runs; the PATCH is fire-and-forget).
async function pinCodexCommitToProducer(state: SessionState, hookCwd: string): Promise<void> {
  try {
    if (!state?.sessionId || !state.headShaAtStart) return;
    const isCodex = isCodexLikeModel(state.model);
    if (!isCodex) return;
    const repoPath = state.repoPath || hookCwd;
    const codexThreadId = (state as any).agentSessionId || (state as any).claudeSessionId || undefined;
    const timeline = getCodexPromptsTimeline(repoPath, codexThreadId);
    if (timeline.length === 0) return; // no rollout timeline — nothing to pin
    const currentHead = getHeadSha(repoPath) || state.headShaAtStart;
    const rolloutFile = findCodexRolloutPath(repoPath, codexThreadId) || undefined;
    const backfilled = backfillCodexPromptMappings({
      repoPath,
      headShaAtStart: state.headShaAtStart,
      headShaAtEnd: currentHead,
      prompts: timeline.map((t) => ({ text: t.text, timestamp: t.timestamp })),
      rolloutFile,
    });
    if (backfilled.length === 0) return;
    if (!state.completedPromptMappings) state.completedPromptMappings = [];
    // Turn-scoped backfill always wins (same merge policy as handleStop).
    for (const bf of backfilled) {
      const i = state.completedPromptMappings.findIndex((m) => m.promptIndex === bf.promptIndex);
      if (i >= 0) state.completedPromptMappings[i] = bf;
      else state.completedPromptMappings.push(bf);
    }
    state.completedPromptMappings.sort((a, b) => a.promptIndex - b.promptIndex);
    try { if (state.sessionTag) saveSessionState(state, repoPath, state.sessionTag); } catch { /* non-fatal */ }
    // PATCH the corrected per-prompt commitSha/diff. editsJson is omitted — the
    // server preserves any existing value (mcp.ts only overwrites when sent).
    await durableUpdate(state.sessionId, {
      promptChanges: state.completedPromptMappings.map(withDerivedLineCounts).map((pm) => ({
        ...pm,
        promptText: (pm.promptText || '').slice(0, 1000),
        diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
        ...(turnIdFor(state, pm.promptIndex) && { turnId: turnIdFor(state, pm.promptIndex) }),
        ...captureStamp(),
      })),
    });
    debugLog('post-commit', 'codex producer-pin PATCH sent', {
      sessionId: state.sessionId, mappings: state.completedPromptMappings.length,
    });
  } catch (err: any) {
    debugLog('post-commit', 'codex producer-pin failed (non-fatal)', { message: err?.message });
  }
}

// Devin Desktop (ex-Windsurf) fires no hooks, so a commit made from its GUI
// arrives with no Origin session. But its session list is readable from the VS
// Code state DB (see devin-desktop.ts). Pick the Cascade/Devin session that
// most recently touched THIS repo, within a short window of the commit, so the
// commit can be attributed to Devin and enriched with the session's own title
// (Devin's summary of the work) + native id. Best-effort; returns null on any
// miss so the normal pgrep detection still runs.
function pickRecentDevinSessionForRepo(repoPath: string, nowMs: number): DevinDesktopSession | null {
  try {
    return selectDevinSessionForRepo(readDevinDesktopSessions(), repoPath, nowMs);
  } catch {
    return null;
  }
}

// Build ONE session-memory entry from live session state. Shared by the
// session-end and per-commit writers (config.memoryUpdate) so both stay in
// sync; writeSessionMemory upserts by sessionId, so repeated writes collapse to
// a single, latest entry per session.
export function buildMemoryEntry(
  state: { sessionId: string; startedAt: string; prompts?: string[]; branch?: string | null; agentSlug?: string },
  opts: { agentSlug?: string; model: string; branch: string | null; filesChanged: string[]; linesAdded: number; linesRemoved: number; summary?: string | null; prompts?: string[]; fileNotes?: Record<string, string>; decisions?: string[]; markers?: OriginMarkers },
): SessionMemoryEntry {
  const prompts = opts.prompts || state.prompts || [];
  const dedupe = (xs: string[]) => Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean)));
  // INTENT = what the user asked for. Prefer explicit [Origin: Intent] markers;
  // otherwise fall back to the user's own first prompt VERBATIM. Deliberately
  // not `summary` — that is the agent's account of what it did, and on the
  // sessions we inspected it was literally the agent's plan ("I'll wire
  // constellations into the oracle, then commit"), which reads as intent and
  // misleads the next agent.
  const intent = dedupe([
    ...(opts.markers?.intent || []),
    ...((opts.markers?.intent || []).length === 0 && prompts[0] ? [prompts[0].slice(0, 200)] : []),
  ]);
  // [Origin: Open] is the agent's own "didn't finish / unsure" note; merge it
  // with the TODOs mined from prompts so both reach openTodos.
  const openTodos = dedupe([...extractTodosFromPrompts(prompts), ...(opts.markers?.open || [])]);
  const verify = dedupe(opts.markers?.verify || []);
  return {
    sessionId: state.sessionId,
    agentSlug: opts.agentSlug || state.agentSlug || 'unknown',
    model: opts.model,
    startedAt: state.startedAt,
    endedAt: new Date().toISOString(),
    branch: opts.branch,
    summary: opts.summary || prompts[0]?.slice(0, 200) || 'No summary',
    // Deduped: the same path lands here repeatedly (once per edit, plus once
    // per commit that touched it), so an untouched list ships the digest lines
    // like "wisdom.py, oracle.py, .gitignore, constellations.py,
    // constellations.py, oracle.py, wisdom.py" — 7 entries, 4 unique, in the
    // payload whose whole job is to be compact.
    filesChanged: dedupe(opts.filesChanged),
    promptCount: prompts.length,
    linesAdded: opts.linesAdded,
    linesRemoved: opts.linesRemoved,
    openTodos,
    ...(opts.fileNotes && Object.keys(opts.fileNotes).length > 0 ? { fileNotes: opts.fileNotes } : {}),
    ...(opts.decisions && opts.decisions.length > 0 ? { decisions: dedupe(opts.decisions).slice(0, 8) } : {}),
    ...(intent.length > 0 ? { intent: intent.slice(0, 3) } : {}),
    ...(verify.length > 0 ? { verify: verify.slice(0, 5) } : {}),
  };
}

// Regenerate the cross-session continuation brief for the NEXT agent — a handoff
// of what recent sessions DID + what's in flight — using the org's AI-provider
// LLM key (server-side; the key never reaches the CLI). `recentDiff` (bounded) is
// the just-ended / just-committed code so the brief is grounded in real code, not
// only prior summaries. Gated on memorySummary=llm + connected + the underlying
// sessions actually changing (signature). Non-fatal — the deterministic
// distillation is the injection fallback. Shared by session-end AND the commit
// paths, so commit-and-go agents (memoryUpdate=commit, which never reach a clean
// session end) get a fresh brief too.
async function maybeRefreshMemoryBrief(repoPath: string, connected: boolean, source: string, recentDiff?: string): Promise<void> {
  if (!connected || memorySummaryMode() !== 'llm') return;
  try {
    const entries = readAllSessionMemory(repoPath);
    const sig = memoryBriefSignature(entries);
    if (readMemoryBrief(repoPath)?.signature === sig) return; // unchanged since the last brief
    const sessionsForBrief = entries.filter(isSubstantiveMemory).slice(-12).map((e) => ({
      summary: e.summary, agentSlug: e.agentSlug, filesChanged: e.filesChanged, openTodos: e.openTodos, decisions: e.decisions, endedAt: e.endedAt,
      intent: e.intent, verify: e.verify,
    }));
    if (sessionsForBrief.length === 0) return;
    const boundedDiff = recentDiff ? recentDiff.slice(0, 8000) : undefined;
    const res = await api.generateMemoryBrief({ sessions: sessionsForBrief, recentDiff: boundedDiff }) as { brief?: string | null };
    const brief = (res?.brief || '').trim();
    if (brief) {
      writeMemoryBrief(repoPath, { version: 1, brief, signature: sig, generatedAt: new Date().toISOString() });
      debugLog(source, 'memory continuation brief refreshed', { len: brief.length });
    }
  } catch (err: any) {
    debugLog(source, 'memory brief refresh error (non-fatal)', { message: err?.message });
  }
}

/**
 * A commit's own committer date (ISO 8601), or null when git can't answer.
 *
 * Memory records used `Date.now()` for `committedAt`, which is only correct
 * when the hook fires immediately. Backfills, queued/offline writes and
 * rebase-replayed commits all land later — sometimes hours — and the record
 * then places a commit inside a session window that never contained it.
 */
function gitCommitDate(repoPath: string, commitSha: string): string | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', commitSha], {
      cwd: repoPath, encoding: 'utf-8', windowsHide: true, timeout: 5_000,
    }).trim();
    return out && !Number.isNaN(new Date(out).getTime()) ? new Date(out).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Elapsed ms since a session's start, or undefined when that can't be known.
 *
 * Never returns NaN: the git note omits fields it didn't measure, and NaN
 * survives a `typeof === 'number'` guard to serialize as `null`, which a
 * reader coerces straight back to the fabricated 0 this replaced.
 */
export function sessionDurationMs(startedAt: string | undefined): number | undefined {
  if (!startedAt) return undefined;
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return undefined;
  return Math.max(0, Date.now() - started);
}

export async function handlePostCommit(): Promise<void> {
  debugLog('post-commit', '=== GIT HOOK INVOKED ===', { pid: process.pid, cwd: process.cwd() });
  // Ready the SQLite backend for the Codex thread reader below (see hooksCommand).
  await ensureSqlite();
  // Replay any queued capture uploads (fire-and-forget; commit already done).
  drainUpdateQueue((e, m, d) => debugLog(e, m, d)).catch(() => {});

  const config = loadConfig();
  const connected = isConnectedMode();

  const hookCwd = process.cwd();
  const repoPath = getGitRoot(hookCwd);
  if (!repoPath) {
    debugLog('post-commit', 'SKIP: not a git repo');
    return;
  }

  // Get latest commit info. Run git in hookCwd, NOT repoPath: getGitRoot
  // collapses a linked worktree to the main repo, whose HEAD is a different
  // commit than the one just made in the worktree. Git runs this hook from
  // the top of the working tree where the commit happened, so hookCwd always
  // resolves the right HEAD; sha-addressed commands work from either since
  // worktrees share the object store.
  const execOpts = {
    windowsHide: true, encoding: 'utf-8' as const, cwd: hookCwd, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  let commitSha: string, commitMessage: string, commitAuthor: string;
  try {
    commitSha = execFileSync('git', ['rev-parse', 'HEAD'], execOpts).trim();
    // %B, not %s. The subject alone drops the `Origin-Session:` trailer that
    // prepare-commit-msg wrote into the body moments ago — the one piece of
    // evidence that says whose commit this is. It is what the server's
    // ownership guards read, and what the ownership check below reads.
    commitMessage = capCommitMessage(execFileSync('git', ['log', '-1', '--format=%B'], execOpts));
    commitAuthor = execFileSync('git', ['log', '-1', '--format=%an'], execOpts).trim();
  } catch (err: any) {
    debugLog('post-commit', 'ERROR: cannot read commit', { message: err.message });
    return;
  }

  // Subject only, for the log — the full body would bury every other line.
  const commitSubject = commitMessage.split('\n', 1)[0] || '';
  debugLog('post-commit', 'commit info', { commitSha, commitMessage: commitSubject, commitAuthor });

  // Validate commitSha is a hex string to prevent shell injection
  if (!/^[a-fA-F0-9]+$/.test(commitSha)) {
    debugLog('post-commit', 'SKIP: invalid commit SHA', { commitSha });
    return;
  }

  // Per-commit diff + files. Shared with the history backfill so the
  // fallback chain (empty stdout on fresh branches, root commits, merges)
  // is fixed in one place — see extractCommitDiff for the strategy notes.
  const { diff, filesChanged } = extractCommitDiff(hookCwd, commitSha);
  if (!diff) {
    debugLog('post-commit', 'WARN: empty per-commit diff after all three strategies', { commitSha });
  }

  // Count lines
  let linesAdded = 0, linesRemoved = 0;
  if (diff) {
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }
  }

  // Detect current branch (may have changed since session started)
  const currentBranch = getBranch(hookCwd);

  // Add Origin-Session trailer to commit message (like Entire's Entire-Snapshot trailer)
  const apiUrl = config?.apiUrl || 'https://getorigin.io';

  // ── Shadow-sync: post commit metadata to API regardless of session state ──
  // The session-aware path below only fires when an Origin session was active
  // for this commit. That misses: (a) commits made by AI without Origin
  // running, (b) plain human commits, (c) commits done while the heartbeat
  // process had died. Without shadow-sync the dashboard's repo view stays
  // empty until `git push` triggers the GitHub/GitLab webhook. Fire-and-
  // forget so a slow API call doesn't hold up the user's commit.
  if (connected) {
    try {
      let repoUrl: string | undefined;
      try {
        repoUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], execOpts).trim() || undefined;
      } catch { /* no remote, fine */ }
      const committedAtIso = (() => {
        try {
          return execFileSync('git', ['log', '-1', '--format=%cI'], execOpts).trim() || undefined;
        } catch { return undefined; }
      })();
      // Advertise the SHAs reachable from HEAD so the server can report
      // which of them it has never seen. For a local repo (no provider
      // webhook, no server-side git access) this hook is the ONLY ingest
      // path, so history that predates hook installation — or arrived via
      // `git pull`, which fires no post-commit — stays invisible without it.
      // Gated on a per-repo sync marker: in steady state (marker head still
      // an ancestor, exactly one commit added) nothing is advertised and the
      // server does no extra work. The marker is only written after a
      // successful server round-trip, so a failed ingest self-heals — the
      // next commit sees a stale marker and re-advertises.
      // Marker/lock key is the WORKING root (hookCwd), matching the
      // session-start path's syncRepoHistory: keying by the canonical path
      // made a main checkout and a linked worktree with divergent HEADs
      // fight over one marker. The server-facing repoPath stays canonical.
      const history = shouldAdvertiseHistory(hookCwd, hookCwd);
      const recentShas = history.advertise ? listRecentShas(hookCwd) : [];
      if (recentShas.length >= RECENT_SHAS_LIMIT) {
        debugLog('post-commit', 'history window truncated at cap — older commits stay unsynced', { cap: RECENT_SHAS_LIMIT });
      }
      const ingestCommit = {
        sha: commitSha,
        message: commitMessage,
        author: commitAuthor,
        branch: currentBranch || null,
        filesChanged,
        additions: linesAdded,
        deletions: linesRemoved,
        committedAt: committedAtIso,
        // Per-commit unified diff so commit-detail can show what THIS
        // commit changed instead of the session aggregate. Capped at
        // 500KB to stay sane on accidental large commits.
        diff: diff ? diff.slice(0, 500_000) : undefined,
      };
      // AWAITED (#1247). This was a floating promise: the hook fired the
      // request and handlePostCommit returned, so the process could exit — or
      // the API could restart under a deploy — before it landed. The commit
      // then reached Origin only via the server's discovery sweep, which knows
      // the sha but has no patch and no line counts, so the row stored
      // `patch: null, additions: null` and every read surface fell back to
      // guesses. Measured there: 20 of 46 commits in one 6-hour window had no
      // patch, across every session running at the time.
      //
      // The history backfill inside the chain is awaited along with it. It only
      // does work when the server reports unknown shas, carries its own timeout
      // and lock, and a partial run deliberately leaves the sync marker stale so
      // the next commit retries — so the common path adds one small round trip.
      //
      // COMMIT_INGEST_TIMEOUT_MS (#1250), not api.ts's 8s default — awaiting a
      // request that aborts at 8s still loses the patch. Even 30s is not a
      // guarantee: the same endpoint answered in 15.2s and in 33.5s within a
      // few minutes on a box sitting at 0% idle CPU, which is why the .catch
      // below queues the payload instead of only logging it.
      await api.ingestCommits({
        repoPath,
        repoUrl,
        recentShas: recentShas.length > 0 ? recentShas : undefined,
        commits: [ingestCommit],
      }, { timeoutMs: COMMIT_INGEST_TIMEOUT_MS })
        .then(async (r) => {
          debugLog('post-commit', 'shadow ingest ok', { ingested: r?.ingested, repoId: r?.repoId });
          if (!history.head) return;
          const unknownShas = Array.isArray(r?.unknownShas) ? (r.unknownShas as string[]) : [];
          if (recentShas.length === 0 || unknownShas.length === 0) {
            // Steady-state commit, or the server already knows everything
            // we advertised — record the confirmed position. (When the
            // gate wanted to advertise but rev-list produced nothing, skip
            // the write so the check re-runs next commit.)
            if (!history.advertise || recentShas.length > 0) {
              writeSyncMarker(hookCwd, history.head, history.count);
            }
            return;
          }
          if (!acquireBackfillLock(hookCwd)) {
            debugLog('post-commit', 'history backfill already in flight — skipping', { unknown: unknownShas.length });
            return;
          }
          try {
            debugLog('post-commit', 'history backfill start', { unknown: unknownShas.length });
            const unknownSet = new Set(unknownShas);
            const { accepted, failed } = await backfillUnknownCommits({
              repoPath,
              hookCwd,
              repoUrl,
              unknownShas,
              // Advertised SHAs the server acknowledged — lets the server's
              // repo-resolution confidence gate corroborate each batch even
              // though the batch's own commits are all unknown to it.
              knownShas: recentShas.filter((s) => !unknownSet.has(s)),
              // The hook-default 8s fetch timeout is sized for tiny live
              // calls; backfill batches carry ~1MB of patches.
              ingest: (data) => api.ingestCommits(data, { timeoutMs: BACKFILL_TIMEOUT_MS }),
              onBatchError: (err: any) => debugLog('post-commit', 'history backfill batch failed — continuing', { message: err?.message }),
            });
            debugLog('post-commit', 'history backfill done', { accepted, failed });
            // Only a fully clean run moves the marker; a partial one leaves
            // it stale so the next commit retries what's missing. Note the
            // server deliberately skips some advertised SHAs (its own
            // origin-sessions bookkeeping commits) without creating rows —
            // they'd re-report unknown forever, so the marker (not the
            // server's answer) is what ends the loop.
            if (!failed) writeSyncMarker(hookCwd, history.head, history.count);
          } catch (err: any) {
            debugLog('post-commit', 'history backfill failed (non-fatal)', { message: err?.message });
          } finally {
            releaseBackfillLock(hookCwd);
          }
        })
        .catch((err: any) => {
          debugLog('post-commit', 'shadow ingest failed (non-fatal)', { message: err?.message });
          // Durable retry, keyed by sha so one stuck commit can't block another
          // session's queued captures. The replay drops recentShas: history
          // advertisement re-runs on the next commit anyway (the sync marker is
          // only written on success), and the whole point of the retry is to
          // land THIS commit's patch and line counts.
          if (isRetriableApiError(err)) {
            enqueueFailedUpdate(
              'ingestCommits',
              `commit:${commitSha}`,
              { repoPath, repoUrl, commits: [ingestCommit] },
              err,
              (e, m, d) => debugLog(e, m, d),
            );
          }
        });
    } catch (err: any) {
      debugLog('post-commit', 'shadow ingest setup failed', { message: err?.message });
    }
  }

  // Get ALL active sessions for this repo (concurrent session support).
  // Worktree-aware: falls back to the main repo's state files when the hook
  // runs inside a linked worktree, then narrows by last-seen lifecycle cwd
  // so a sibling session in another worktree isn't credited with this commit.
  // The commit's files go in so a session that merely went QUIET — no lifecycle
  // hook for hours, which is normal for Antigravity — can still be recognised as
  // the owner when this commit is literally its own uncommitted work.
  const activeSessions = listSessionsForGitHook(hookCwd, { commitFiles: filesChanged });
  activeSessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  // Pick the correct session when multiple are active: process detection →
  // commit branch → file overlap (see pickSessionForCommit). Process detection
  // (pgrep) is side-effectful so it's resolved here and passed in.
  let state: SessionState | null = null;
  // The trailer rung inside pickSessionForCommit needs the full message, so it
  // runs even for a lone session — one active session is not evidence that the
  // commit is that session's (see commitIsAnotherSessions below).
  const trailerPick = pickSessionForCommit(activeSessions, { commitMessage });
  if (trailerPick.reason === 'trailer' && trailerPick.session) {
    state = trailerPick.session;
    debugLog('post-commit', 'disambiguated by Origin-Session trailer', {
      sessionId: state.sessionId, ofActive: activeSessions.length,
    });
  } else if (activeSessions.length === 1) {
    state = activeSessions[0];
  } else if (activeSessions.length > 1) {
    // Every matching agent, not the first — see uniquePgrepMatch. A hint that
    // silently means "whichever agent happens to sort first among the ones
    // running" is worse than no hint: it steers pickSessionForCommit onto the
    // wrong session with full confidence.
    const detectedSlug = uniquePgrepMatch(
      attributionPgrepChecks().map((c) => ({ cmd: c.cmd, id: c.slug })),
      'post-commit',
    );

    const picked = pickSessionForCommit(activeSessions, {
      detectedSlug,
      currentBranch,
      commitFiles: filesChanged,
      commitMessage,
    });
    state = picked.session;
    if (state) {
      debugLog('post-commit', `disambiguated by ${picked.reason}`, {
        detectedSlug, branch: currentBranch, sessionId: state.sessionId, model: state.model,
      });
    } else {
      // Neither process, branch, nor file overlap narrowed it down — don't guess.
      debugLog('post-commit', 'multiple sessions active, could not disambiguate', {
        totalSessions: activeSessions.length,
        currentBranch,
        sessionModels: activeSessions.map(s => ({ id: s.sessionId, model: s.model, branch: s.branch })),
      });
    }
  }

  // If no active session AND no sessions were found at all, detect AI agent process.
  // Only do this when there are truly zero sessions — if sessions exist but couldn't
  // be disambiguated, we already warned above and shouldn't guess via pgrep.
  if (!state && activeSessions.length === 0) {
    // Devin Desktop first — it fires no hooks and is deliberately absent from
    // the standalone pgrep set (desktop apps false-positive), so we identify it
    // by its readable session list instead. A recent Cascade/Devin session in
    // this repo means this commit is its work; tag it `devin` and carry the
    // session's title (its own summary) as the prompt + its native id.
    const devinSess = pickRecentDevinSessionForRepo(repoPath, Date.now());
    if (devinSess) {
      debugLog('post-commit', 'attributed commit to Devin Desktop session', {
        devinSessionId: devinSess.sessionId, title: devinSess.title, provider: devinSess.provider,
      });
      state = {
        sessionId: `devin-${devinSess.sessionId}`,
        model: 'devin',
        agentSlug: 'devin',
        agentSessionId: devinSess.sessionId,
        startedAt: devinSess.createdAt || new Date().toISOString(),
        prompts: devinSess.title ? [devinSess.title] : [],
      } as any;
    }

    let detectedModel: string | null = null;
    if (!state) {
      try {
        // Use pgrep for targeted process detection — look for CLI binaries only,
        // not desktop apps (Cursor/VS Code have many helper processes that would match)
        detectedModel = uniquePgrepMatch(
          standalonePgrepChecks().map((c) => ({ cmd: c.cmd, id: c.model })),
          'post-commit',
        );
      } catch { /* ignore */ }
    }

    if (detectedModel) {
      debugLog('post-commit', 'no active session but detected AI process', { detectedModel });
      // Create a synthetic state so notes get tagged as AI
      state = {
        sessionId: `detected-${detectedModel}-${Date.now().toString(36)}`,
        model: detectedModel,
        startedAt: new Date().toISOString(),
      } as any;
    }
  }

  // Attribute this commit to the picked session so future diff computations
  // can scope `committedDiff` to commits this session actually authored.
  // Without this, a heartbeat in session A computes `git diff prePromptSha
  // ...HEAD` and picks up commits made by concurrently-running session B
  // (HEAD has moved past A's commits), then credits B's work to A in AI
  // Blame. Persisted to state file so heartbeat / user-prompt-submit /
  // session-end snapshots can all read it.
  // …but only when the commit is actually ours. On a shared checkout several
  // sessions are live at once and this hook has to pick one, which it does on
  // proximity, not authorship — so it picked the wrong one for 35058c5d
  // (trailered `Origin-Session: 59a0fa03-dc5`, recorded on b05c4b43, then shown
  // on that session's page badging a turn that wrote nothing).
  //
  // The trailer settles it, and by post-commit time it is already in the body.
  // Only a trailer naming a session that EXISTS on this machine is decisive:
  // amend and rebase carry a STALE trailer naming an id nothing answers to any
  // more, and that commit is still ours — the same distinction
  // commitBelongsToSession draws for the per-turn capture.
  const trailerOwner = state ? commitTrailerBelongsToSession(commitMessage, state) : 'none';
  const commitIsAnotherSessions = trailerOwner === 'other'
    && trailerNamesAKnownSession(hookCwd, commitMessage, state as SessionState);
  if (commitIsAnotherSessions) {
    debugLog('post-commit', 'SKIP recording: trailer names another live session', {
      commitSha: commitSha.slice(0, 8),
      pickedSession: state?.sessionId,
    });
  }
  if (state && state.sessionTag && !commitIsAnotherSessions) {
    if (!state.sessionCommitShas) state.sessionCommitShas = [];
    if (!state.sessionCommitShas.includes(commitSha)) {
      state.sessionCommitShas.push(commitSha);
      // ATTEST the turn as well as the session.
      //
      // This hook is the only moment the answer is observed rather than
      // reconstructed: the commit is landing right now and `activeTurn` says
      // which turn is running. Recording only the sha left both the CLI and the
      // server to re-derive turn ownership later from timestamps, file overlap
      // and the wording of the prompt — two independent guesses at a fact that
      // was in hand here.
      //
      // Best-effort by design. A commit made outside any open turn (a manual
      // `git commit` between prompts, a rebase, an amend) legitimately has no
      // active turn, and inventing one would be worse than the heuristics: it
      // would give the downstream reader false attestation. No activeTurn means
      // no entry, and the existing inference still applies to that commit.
      const attestTurnId = state.activeTurn?.turnId;
      if (attestTurnId) {
        if (!state.commitTurns) state.commitTurns = [];
        if (!state.commitTurns.some((c) => c.sha === commitSha)) {
          state.commitTurns.push({ sha: commitSha, turnId: attestTurnId, at: new Date().toISOString(), via: 'post-commit' });
        }
      }
      try {
        saveSessionState(state, state.repoPath || hookCwd, state.sessionTag);
      } catch { /* non-fatal */ }
      debugLog('post-commit', 'recorded commit on session', {
        sessionId: state.sessionId, commitSha: commitSha.slice(0, 8),
        totalForSession: state.sessionCommitShas.length,
        attestedTurnId: attestTurnId || '(no active turn)',
      });
    }
  }

  // Who gets this commit's COUNTERS. A commit has one author session, and its
  // files, lines and count are that session's — the same question
  // `pickCommitUpdateTargets` already answers for the incremental API update,
  // asked with the same inputs so the two cannot disagree.
  //
  // This loop used to credit EVERY active session in the repo. Two agents
  // sharing a checkout therefore each accumulated the other's commits into
  // their own `filesChanged`/`linesAdded`/`linesRemoved`/`commitCount` — a
  // session that had written nothing all turn still ended up holding a
  // stranger's files and line totals. The header on the sibling defect
  // (#1188, cross-worktree branch bleed) called this out as the next thing to
  // go wrong here: "the post-commit loop writes more than the branch; any
  // future bug here inflates file and line counts on innocent sessions too".
  //
  // A commit the trailer says belongs to a DIFFERENT live session credits
  // nobody here — the sha is already excluded from `sessionCommitShas` above
  // for exactly that reason, and its counters should not arrive by another
  // door.
  const counterTargets = commitIsAnotherSessions
    ? []
    : pickCommitUpdateTargets(activeSessions, state, filesChanged);
  const counterSessionIds = new Set(counterTargets.map((t) => t.sessionId));
  if (filesChanged.length > 0 && counterSessionIds.size !== activeSessions.length) {
    debugLog('post-commit', 'commit counters scoped to owner', {
      credited: [...counterSessionIds].map((id) => String(id).slice(0, 8)),
      ofActive: activeSessions.length,
      commitSha: commitSha.slice(0, 8),
    });
  }

  for (const s of activeSessions) {
    let changed = false;
    // Branch, unlike the counters, really is shared: these sessions live in one
    // working tree with one HEAD, so a checkout moved all of them. Stamping
    // each is a fact, not an attribution — which is also why the branch rung in
    // pickSessionForCommit cannot separate co-located sessions.
    if (currentBranch && currentBranch !== s.branch) {
      debugLog('post-commit', 'branch changed', { from: s.branch, to: currentBranch, sessionId: s.sessionId });
      s.branch = currentBranch;
      changed = true;
    }
    // Accumulate files changed in session state so standalone sessions show
    // file counts — for the session that MADE the commit.
    if (filesChanged.length > 0 && counterSessionIds.has(s.sessionId)) {
      const existing = new Set((s as any).filesChanged || []);
      for (const f of filesChanged) existing.add(f);
      (s as any).filesChanged = Array.from(existing);
      (s as any).linesAdded = ((s as any).linesAdded || 0) + linesAdded;
      (s as any).linesRemoved = ((s as any).linesRemoved || 0) + linesRemoved;
      (s as any).commitCount = ((s as any).commitCount || 0) + 1;
      changed = true;
    }
    if (changed) {
      saveSessionState(s, s.repoPath || hookCwd, s.sessionTag);
    }
  }

  // Part B — pin this commit to the turn that produced it (Codex rollout
  // marker), correcting the racy HEAD-stamp for a still-running session.
  // Fire-and-forget: the commit already succeeded; a pending PATCH keeps the
  // process alive until it resolves, and any failure is swallowed.
  if (connected && state && state.sessionTag) {
    void pinCodexCommitToProducer(state, hookCwd);
  }

  // F13: Respect config.commitLinking setting (always|prompt|never)
  const commitLinkingConfig = config?.commitLinking || 'always';

  // Condense active snapshots to permanent storage + add bidirectional linking
  let latestSnapshotId: string | undefined;
  if (state && state.sessionTag) {
    try {
      const snapshots = listSnapshots(repoPath, state.sessionTag);
      if (snapshots.length > 0) {
        const latest = snapshots[snapshots.length - 1];
        latestSnapshotId = latest.id;
        // Condense to permanent orphan branch with transcript (like Entire's entire/snapshots/v1)
        condenseSnapshot(repoPath, latest.id, latest, commitSha, state.transcriptPath);
        debugLog('post-commit', 'condensed snapshot to permanent branch', { snapshotId: latest.id, hasTranscript: !!state.transcriptPath });
      }
    } catch (cpErr: any) {
      debugLog('post-commit', 'snapshot condensation failed (non-fatal)', { message: cpErr.message });
    }
  }

  // Trailer insertion moved to prepare-commit-msg (see handlePrepareCommitMsg).
  // Writing trailers via `git commit --amend --no-verify` was removed because:
  //   1. Amend mutates the commit SHA, which creates divergence for pushed commits.
  //   2. --no-verify skips the pre-commit secret scanner.
  //   3. Amend breaks GPG signatures unless re-signed (which --no-verify doesn't do).
  // The trailer is now part of the commit from the moment git creates it.

  // Write git notes on this commit immediately
  // If model is missing/unknown, try pgrep detection as fallback
  let noteModel = state?.model || '';
  if (!noteModel || noteModel === 'unknown') {
    try {
      const fallbackChecks = [
        { cmd: 'pgrep -f "claude.*stream-json"', model: 'claude' },
        { cmd: 'pgrep -f "gemini.*cli|/gemini "', model: 'gemini' },
        { cmd: 'pgrep -f "codex"', model: 'codex' },
        { cmd: 'pgrep -f "aider"', model: 'aider' },
        { cmd: 'pgrep -f "devin|windsurf"', model: 'devin' },
        { cmd: 'pgrep -f "copilot.*cli|github-copilot"', model: 'copilot' },
        { cmd: 'pgrep -f "amp.*cli|/amp "', model: 'amp' },
      ];
      for (const check of fallbackChecks) {
        try {
          if (safePgrep(check.cmd)) {
            noteModel = check.model;
            break;
          }
        } catch { /* no match */ }
      }
    } catch { /* ignore */ }
  }

  // ── Session telemetry for the note ─────────────────────────────────
  // The note used to omit tokens and cost as "not known here". They were
  // knowable: the transcript those totals come from is parsed in this SAME
  // hook invocation ~280 lines down, for the session write. Only the ORDER
  // made them unknown — the note is written first — so every commit note in
  // this repo reads `tokens: — cost: —` while the session row it links to
  // carries both, and `origin commit <sha>` (which is the OFFLINE reader, the
  // one used where the session row is not reachable) is the surface that loses
  // them.
  //
  // Parsed ONCE here and handed down to the session write, so the numbers are
  // not bought with a second full JSONL walk. Guarded on the same condition
  // that block uses, so a `detected-*` / `devin-*` commit — which never
  // reaches it — does not start paying for a parse nothing consumes.
  let noteMetrics: { tokensUsed?: number; costUsd?: number } = {};
  let parsedForSessionWrite: ParsedTranscript | null = null;
  if (
    state?.transcriptPath
    && !state.sessionId.startsWith('detected-')
    && !state.sessionId.startsWith('devin-')
  ) {
    try {
      parsedForSessionWrite = parseTranscript(state.transcriptPath, {
        since: state.startedAt, repoRoots: sessionRepoRoots(state),
      });
      const costModel = parsedForSessionWrite.model || state.model;
      const cost = estimateCost(
        costModel,
        parsedForSessionWrite.inputTokens,
        parsedForSessionWrite.outputTokens,
        parsedForSessionWrite.cacheReadTokens,
        parsedForSessionWrite.cacheCreationTokens,
        { cacheCreation1hTokens: parsedForSessionWrite.cacheCreation1hTokens },
      );
      // Absent, never zero, when the walk finds nothing. A zero reads as a
      // measurement — the exact false claim the old hardcoded `0` made, and
      // the reason these fields were made optional in the first place.
      noteMetrics = {
        tokensUsed: parsedForSessionWrite.tokensUsed > 0 ? parsedForSessionWrite.tokensUsed : undefined,
        costUsd: Number.isFinite(cost) && cost > 0 ? cost : undefined,
      };
    } catch {
      // An unreadable/rolled transcript leaves both absent and the session
      // write below re-tries the parse on its own terms.
      parsedForSessionWrite = null;
    }
  }

  try {
    writeGitNotes(repoPath, [commitSha], {
      sessionId: state?.sessionId || 'unknown',
      model: noteModel || 'unknown',
      agentSlug: state?.agentSlug,
      promptCount: state?.prompts?.length || 0,
      promptSummary: state?.prompts?.[state.prompts.length - 1] || '',
      fullPrompt: state?.prompts?.[state.prompts.length - 1] || undefined,
      previousSessionId: state?.previousSessionId,
      filesRead: state?.filesRead,
      prompts: state ? buildPromptNoteEntries(state, state.agentSlug, noteModel || state.model) : undefined,
      // No in-memory transcript here (post-commit hook) — read markers from
      // the session's transcript file. Matters for Codex, which routes its
      // note writes through this path.
      markers: parseMarkersFromTranscriptPath(state?.transcriptPath),
      // Read from the hoisted parse above — absent when there was no
      // transcript to walk, never zeroed.
      tokensUsed: noteMetrics.tokensUsed,
      costUsd: noteMetrics.costUsd,
      // Duration IS known: the session's start is in state. Guarded on
      // finiteness — an unparseable startedAt (older/truncated recovered state)
      // yields NaN, which passes a `typeof === 'number'` check and serializes
      // as JSON null, i.e. exactly the fabricated non-measurement this is
      // removing.
      durationMs: sessionDurationMs(state?.startedAt),
      linesAdded,
      linesRemoved,
      originUrl: state ? `${apiUrl}/sessions/${state.sessionId}` : '',
      snapshot: true,
      snapshotAt: new Date().toISOString(),
      filesChanged,
      subagents: (state?.subagentSpawns || []).map((s) => ({ type: s.subagentType, promptIndex: s.promptIndex })),
    });
    debugLog('post-commit', 'git notes written');
  } catch (err: any) {
    debugLog('post-commit', 'git notes error (non-fatal)', { message: err.message });
  }

  // Send incremental update to ALL active sessions (concurrent support).
  //
  // For the SessionDiff (what powers AI Blame "By File"), recapture the
  // session-to-date diff with full file context so the dashboard renders
  // whole files instead of "N lines hidden" gaps. Sent as snapshot:true so
  // the server REPLACES sessionDiff with this canonical state — matches what
  // the session-end stop hook already does (see line ~3808 / ~4167), just
  // refreshed every commit instead of only at session end.
  if (activeSessions.length > 0) {
    let sessionToDateDiff = '';
    let sessionLinesAdded = linesAdded;
    let sessionLinesRemoved = linesRemoved;
    if (state?.headShaAtStart && state.headShaAtStart !== commitSha) {
      try {
        // hookCwd, not repoPath: the session-to-date diff must read the
        // committing working tree's HEAD (worktree-safe, see execOpts above).
        const snap = captureGitState(hookCwd, state.headShaAtStart, { fullContext: true });
        if (snap.committedDiff) {
          sessionToDateDiff = snap.committedDiff;
          sessionLinesAdded = snap.linesAdded || linesAdded;
          sessionLinesRemoved = snap.linesRemoved || linesRemoved;
        }
      } catch (err: any) {
        debugLog('post-commit', 'fullContext snapshot failed (non-fatal)', { message: err?.message });
      }
    }
    const gitCapture: {
      headBefore: string; headAfter: string; commitShas: string[];
      commitDetails: Array<{ sha: string; message: string; author: string; filesChanged: string[] }>;
      diff: string; diffTruncated: boolean; linesAdded: number; linesRemoved: number;
      snapshot?: boolean;
    } = sessionToDateDiff
      ? {
          headBefore: state?.headShaAtStart || commitSha,
          headAfter: commitSha,
          commitShas: [commitSha],
          commitDetails: [{ sha: commitSha, message: commitMessage, author: commitAuthor, filesChanged }],
          diff: sessionToDateDiff.length > 500_000 ? sessionToDateDiff.slice(0, 500_000) : sessionToDateDiff,
          diffTruncated: sessionToDateDiff.length > 500_000,
          linesAdded: sessionLinesAdded,
          linesRemoved: sessionLinesRemoved,
          snapshot: true,
        }
      : {
          headBefore: (state?.headShaAtStart) || commitSha,
          headAfter: commitSha,
          commitShas: [commitSha],
          commitDetails: [{ sha: commitSha, message: commitMessage, author: commitAuthor, filesChanged }],
          diff: diff.length > 500_000 ? diff.slice(0, 500_000) : diff,
          diffTruncated: diff.length > 500_000,
          linesAdded,
          linesRemoved,
        };

    // Resolve the commit's timestamp once, outside the per-session loop.
    // resolvePromptForCommit() uses it to match the commit to the prompt
    // that most likely produced it (Codex/Gemini path).
    let commitTimestampMs = Date.now();
    try {
      const iso = execFileSync('git', ['log', '-1', '--format=%cI', commitSha], execOpts).trim();
      const parsed = iso ? new Date(iso).getTime() : NaN;
      if (Number.isFinite(parsed)) commitTimestampMs = parsed;
    } catch { /* fall back to wallclock */ }

    // Who gets this commit — see pickCommitUpdateTargets. `state` is the
    // owner the ladder above resolved; this loop used to ignore it and send
    // the commit to every session in the repo.
    // A commit another live session has claimed by trailer is credited to
    // nobody here — not even when it is the only session in the repo, which is
    // the case rung 0 cannot fix (the owner's state file simply isn't among the
    // ones listed). Everything in the payload below is about this commit:
    // gitCapture carries its commitDetails and perPromptUpdate stamps its sha
    // onto whichever prompt is open, so sending it credits a stranger's work.
    const updateTargets = commitIsAnotherSessions
      ? []
      : pickCommitUpdateTargets(activeSessions, state, filesChanged);
    if (commitIsAnotherSessions) {
      debugLog('post-commit', 'no incremental update — commit is another session\'s', {
        commitSha: commitSha.slice(0, 8), activeSessions: activeSessions.length,
      });
    }
    if (activeSessions.length > 1) {
      debugLog('post-commit', 'incremental update targets', {
        picked: state?.sessionId || null,
        targets: updateTargets.map((s) => s.sessionId),
        ofActive: activeSessions.length,
      });
    }
    if (connected && updateTargets.length === 0 && activeSessions.length > 0) {
      debugLog('post-commit', 'no session owns this commit — not crediting any', {
        totalSessions: activeSessions.length, commitSha, files: filesChanged.length,
      });
    }

    // A MERGE credits the turn with the branch it absorbed unless it is asked
    // the narrower question. `extractCommitDiff` gives the first-parent view —
    // right for the Commit ROW (what landed on this branch), wrong for a TURN,
    // whose work is only the conflict resolution. Prod f7881a6e turn 3 was sent
    // `{filesChanged:0, a:84, r:20}`: no files, and 84 lines of another PR's
    // `final-state-blame.ts`/`transcript-watch.ts` that the session never wrote.
    const mergeOwn = mergeOwnDiff(hookCwd, commitSha);
    const turnFiles = mergeOwn ? mergeOwn.filesChanged : filesChanged;
    const turnDiff = mergeOwn ? mergeOwn.diff : diff;
    if (mergeOwn) {
      debugLog('post-commit', 'merge commit — crediting the turn with its resolution only', {
        commitSha: commitSha.slice(0, 8),
        absorbedFiles: filesChanged.length, resolvedFiles: turnFiles.length,
      });
    }

    if (connected) {
      for (const s of updateTargets) {
        // Pick the prompt this commit belongs to. Claude path uses
        // s.prompts (populated on user-prompt-submit). Codex/Gemini have
        // no submit hook — resolvePromptForCommit walks their transcript
        // and picks the latest prompt timestamped at-or-before this
        // commit. Fixes "all commits attributed to prompt #1" for
        // Codex sessions with multiple prompts.
        const resolved = resolvePromptForCommit(s, repoPath, commitTimestampMs);
        const latestPromptIdx = resolved.promptIndex;
        const latestPromptText = resolved.promptText;
        // Scope the commit to THIS prompt's contribution. The raw commit stat
        // over-credits whichever prompt gets attributed: a file created
        // untracked with 10 lines by an earlier prompt and extended by 5 here
        // reads as +15, because the whole file is new to git. Diffing from this
        // prompt's baseline shadow yields the +5 it actually added. Falls back to
        // the commit's own stat when there's no usable baseline.
        const promptBaseline =
          s.promptShadows?.find((sh) => sh.promptIndex === latestPromptIdx)?.shadowSha
          || s.prePromptSha;
        // A merge is already scoped to what it resolved; re-diffing it from
        // the baseline tree would put the absorbed branch straight back in.
        const scoped = mergeOwn
          ? null
          : commitDiffScopedToPrompt(hookCwd, promptBaseline, commitSha, turnFiles);
        if (scoped) {
          debugLog('post-commit', 'scoped commit to prompt baseline', {
            sessionId: s.sessionId, promptIndex: latestPromptIdx,
            baseline: String(promptBaseline).slice(0, 12),
            commitLines: `+${linesAdded}/-${linesRemoved}`,
            promptLines: `+${scoped.linesAdded}/-${scoped.linesRemoved}`,
          });
        }
        // ── One answer per run ───────────────────────────────────────────
        // The attestation above read `state.activeTurn` as the commit landed;
        // this loop re-derives the turn from the commit's timestamp. When they
        // disagree, the run writes the commit onto TWO turns — the attested one
        // via `commitTurns` (which the server trusts) and the attributed one
        // via this payload.
        //
        // Prod f7881a6e, one post-commit run, 44 seconds apart:
        //   21:34:50  recorded commit on session  {attestedTurnId:"t_1f32a0c2…"}   ← turn 1
        //   21:35:32  sending incremental update  {attributedPromptIdx:2}          ← turn 3
        // t_1f32a0c2 was a chat-only question two turns earlier; it ended up
        // holding `final-state-blame.ts`, a file that arrived with the merge.
        //
        // `activeTurn` goes stale because it is only re-homed when its prompt
        // TEXT moves — a turn left open by a missed close stays "open" across
        // the next prompt. The timestamp resolver saw the newer prompt, so it
        // wins, and the stale attestation is corrected rather than left to
        // contradict the payload downstream.
        const attributedTurnId = turnIdFor(s, latestPromptIdx);
        if (attributedTurnId && s.sessionId === state?.sessionId && state.commitTurns) {
          const attested = state.commitTurns.find((c) => c.sha === commitSha);
          if (attested && attested.turnId !== attributedTurnId) {
            debugLog('post-commit', 'attested turn disagreed with the attributed one — correcting', {
              commitSha: commitSha.slice(0, 8),
              attested: attested.turnId, attributed: attributedTurnId,
              promptIndex: latestPromptIdx,
            });
            attested.turnId = attributedTurnId;
            try { saveSessionState(state, state.repoPath || hookCwd, state.sessionTag!); } catch { /* non-fatal */ }
          }
        }
        const pDiff = scoped ? scoped.diff : turnDiff;
        const perPromptUpdate = {
          promptIndex: latestPromptIdx,
          // Key the row on IDENTITY, like every other sender does. This one
          // was the last positional-only producer, and it is the one that
          // writes the commit-linked row — so a prompt list that renumbered
          // between two PATCHes landed a commit's diff on a neighbour's turn
          // with nothing to correct it.
          ...(turnIdFor(s, latestPromptIdx) && { turnId: turnIdFor(s, latestPromptIdx) }),
          ...captureStamp(),
          promptText: latestPromptText.slice(0, 1000),
          filesChanged: turnFiles,
          diff: pDiff.length > MAX_PROMPT_DIFF_LEN ? pDiff.slice(0, MAX_PROMPT_DIFF_LEN) : pDiff,
          // Counted off the diff actually being sent, so the lines and the
          // files can never describe two different things — the shape that
          // shipped `filesChanged: 0` alongside `+84/-20`.
          linesAdded: scoped ? scoped.linesAdded : countDiffSignLines(pDiff, '+'),
          linesRemoved: scoped ? scoped.linesRemoved : countDiffSignLines(pDiff, '-'),
          commitSha,
          // The SUBJECT travels with the stamp, not only inside gitCapture.
          //
          // Until now a commit's message reached the server in exactly one
          // place: `gitCapture.commitDetails[].message`. When the server has
          // to RECONSTRUCT a Commit row from the per-prompt stamp — because
          // that gitCapture was lost, or raced — the sha is all it has, so
          // the row is subject-less by construction and renders "(no
          // message)" forever (prod f4704142 and 8dfa3b2b, 4 rows).
          //
          // The hook already knows it: it is the `commitMessage` logged in
          // "commit info" a few lines above. Sending it alongside the sha
          // costs one short string and makes the subject survive on the same
          // durable path the stamp does. Subject only — the body can be
          // arbitrarily long and nothing renders it here.
          commitMessage: commitSubject ? commitSubject.slice(0, 500) : undefined,
        };
        try {
          debugLog('post-commit', 'sending incremental update', {
            sessionId: s.sessionId,
            filesChanged: filesChanged.length,
            attributedPromptIdx: latestPromptIdx,
            commitSha,
            payload: summarizePromptPayload([perPromptUpdate]),
          });
          // DURABLE, not fire-and-forget. This PATCH is the ONLY producer of
          // the Commit row for a commit that never reaches a git host: the
          // webhook backfill can't see an unpushed branch, and the stop hook's
          // session-level gitCapture is a shadow-baseline reconstruction that
          // carries `commitShas: []`. So when this one call was dropped, the
          // sha survived only as the per-prompt stamp — the turn rendered a
          // "committed" badge that led nowhere: no Commit row, no inline
          // commit card, no commit diff, and no way to ever heal it.
          //
          // That is exactly what happened to session f4704142 (Copilot,
          // unpushed worktree branch): at 18:53:34 the API was stalling on a
          // 2.3MB write from a concurrent session, the fetch aborted, and this
          // catch logged "non-fatal" and threw the gitCapture away. The stop
          // hook's payload, which goes through durableUpdateSession, was
          // queued and did land — which is why the per-turn diff and line
          // counts are all correct and only the commit is missing.
          //
          // The module header already listed post-commit as a durable caller
          // and line 8598 drains the queue here; only the send itself was
          // never converted.
          await durableUpdateSession(s.sessionId, {
            filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
            branch: currentBranch || undefined,
            gitCapture,
            promptChanges: latestPromptText ? [perPromptUpdate] : undefined,
          }, (e, m, d) => debugLog(e, m, d));
          debugLog('post-commit', 'API update complete', { sessionId: s.sessionId });
        } catch (err: any) {
          // Retriable failures no longer reach here — durableUpdateSession
          // queues those and returns null. This is now only permanent (4xx)
          // failures, which replaying could never fix.
          debugLog('post-commit', 'API update error (non-fatal)', { sessionId: s.sessionId, message: err.message });
        }
      }
    }
  } else {
    debugLog('post-commit', 'no active sessions, skipped API update');
  }

  // Write full session entrypoint to origin-sessions branch on every commit
  // Parse transcript for full metrics (if available) so we capture tokens, cost, prompts, files
  // For agents without transcripts (e.g. Gemini), still write git data (files, lines)
  // Skip the origin-sessions branch publish for commit-time SYNTHETIC sessions
  // (pgrep-detected `detected-*`, Devin-Desktop `devin-*`). They have no live
  // session record, so publishing a RUNNING shell to the branch would pre-empt
  // the git-note importer — which materializes a COMPLETE, COMPLETED session
  // from the commit note instead. The note is already written above.
  if (state && !state.sessionId.startsWith('detected-') && !state.sessionId.startsWith('devin-')) {
    const durationMs = Date.now() - new Date(state.startedAt).getTime();

    // Parse transcript for full metrics (or use empty defaults for agents without transcripts)
    // Reuses the walk the note write already did — parsing the same JSONL
    // twice per commit is what this hoist exists to avoid.
    const parsed = parsedForSessionWrite
      ?? (state.transcriptPath
        ? parseTranscript(state.transcriptPath, { since: state.startedAt, repoRoots: sessionRepoRoots(state) })
        : { prompts: [], filesChanged: [], tokensUsed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, promptIndexBase: 0, toolCalls: 0, subagentTokens: 0, subagentEdits: [], toolBreakdown: [], filesRead: [], summary: '', model: '', transcript: '' });
    const promptMappings = state.transcriptPath
      ? extractPromptFileMappings(state.transcriptPath, { since: state.startedAt, repoRoots: sessionRepoRoots(state) })
      : [];
    const writeData = buildSessionWriteData({
      state, parsed, promptMappings,
      gitCapture: {
        headBefore: state.headShaAtStart || commitSha,
        headAfter: commitSha,
        commitShas: [commitSha],
        linesAdded,
        linesRemoved,
      },
      status: 'running', apiUrl,
      extraFiles: filesChanged,
    });
    writeSessionFiles(repoPath, writeData);
    // Publish moment: a commit is when the work becomes something another user
    // will pull, so the context behind it has to be on the branch alongside it.
    pushSessionBranch(repoPath, writeData.sessionId);
    debugLog('post-commit', 'session files written + published', {
      prompts: writeData.prompts.length,
      costUsd: writeData.costUsd,
      files: writeData.filesChanged.length,
    });

    // Refresh this session's cross-session memory NOW (config.memoryUpdate =
    // 'commit'/'both') — commit-and-go agents often never reach a clean session
    // end, so their work would otherwise never be remembered. Done HERE (not at
    // commit disambiguation) so we have the parsed transcript + accumulated
    // session state: summary comes from the transcript when there is one, else
    // the originating prompt, else the commit message — never a blank "No
    // summary". Upsert-by-sessionId collapses repeated writes to one entry.
    if (shouldWriteMemoryOnCommit(memoryUpdateTrigger())) {
      // Explicit [Origin: Decision] markers from the transcript — ground truth,
      // no LLM call needed. The normal commit path doesn't LLM-synthesize, so
      // markers are the decision source here.
      let commitDecisions: string[] = [];
      let commitMarkers: OriginMarkers | undefined;
      try {
        commitMarkers = parseMarkersFromTranscriptPath(state.transcriptPath);
        commitDecisions = commitMarkers?.decision || [];
      } catch { /* best-effort */ }
      try {
        const memPrompts = (parsed.prompts && parsed.prompts.length > 0) ? parsed.prompts : (state.prompts || []);
        const accFiles: string[] = writeData.filesChanged && writeData.filesChanged.length > 0 ? writeData.filesChanged : filesChanged;
        writeSessionMemory(repoPath, buildMemoryEntry(state, {
          agentSlug: state.agentSlug,
          model: writeData.model || state.model,
          branch: currentBranch || state.branch || null,
          filesChanged: accFiles,
          linesAdded: (state as any).linesAdded || linesAdded,
          linesRemoved: (state as any).linesRemoved || linesRemoved,
          // Commit message first: it is this session's own record of what
          // LANDED. `parsed.summary` is the last assistant message, which on a
          // commit-and-go turn is the agent's plan or its sign-off chatter, and
          // `memPrompts[0]` is the raw opening prompt — both describe intent
          // rather than outcome.
          //
          // Through summarizeFromCommitSubjects, not raw, so this shares ONE
          // noise filter with the session-end path: a merge-resolution commit
          // ("Merge branch 'main' into feature") is not a summary of anything,
          // and for a commit-and-go session — which never reaches session end —
          // whatever lands here is what the next agent reads permanently.
          summary: summarizeFromCommitSubjects([commitMessage]) || parsed.summary || memPrompts[0] || undefined,
          prompts: memPrompts,
          decisions: commitDecisions,
          markers: commitMarkers,
        }));
        debugLog('post-commit', 'session memory refreshed (memoryUpdate=commit)', { sessionId: state.sessionId, decisions: commitDecisions.length });
      } catch (err: any) {
        debugLog('post-commit', 'session memory refresh error (non-fatal)', { message: err.message });
      }
      // Commit-and-go agents may never reach a clean session end, so refresh the
      // continuation brief here too — grounded in this commit's diff.
      scheduleMemoryBriefRefresh(repoPath, connected, 'post-commit', diff);

      // Record the IMMUTABLE per-commit memory entry — the granular "what THIS
      // commit did", frozen forever (add-once by SHA; distinct from the evolving
      // session rollup above).
      try {
        writeCommitMemory(repoPath, {
          commitSha, sessionId: state.sessionId, agentSlug: state.agentSlug || 'unknown',
          message: commitMessage || '', filesChanged, linesAdded, linesRemoved,
          decisions: commitDecisions.length > 0 ? commitDecisions.slice(0, 6) : undefined,
          // The COMMIT's own timestamp, not the hook's wall clock. They differ
          // whenever the hook runs late (backfill, a deferred/queued write, a
          // rebase-replayed commit) and the drift is what makes a session
          // window disagree with the commits it claims — see
          // reconcileSessionWindow. Falls back to now only if git can't answer.
          branch: currentBranch || state.branch || null,
          committedAt: gitCommitDate(repoPath, commitSha) || new Date().toISOString(),
        });
      } catch { /* non-fatal */ }
    }
  }

  // Opportunistically refresh code-survival for the benchmarking scorecard,
  // at most once/day/repo, in a detached background process (never blocks the
  // commit). No-op when not logged in. See benchmark-auto-sync.ts.
  try { maybeAutoSyncBenchmark(repoPath); } catch { /* never break the hook */ }

  debugLog('post-commit', '=== GIT HOOK COMPLETE ===');
}

// ─── Pre-Tool-Use / Post-Tool-Use (F7: Subagent Tracking) ─────────────────

// ── Policy Enforcement Helpers ────────────────────────────────────────────

function matchGlob(pattern: string, filepath: string): boolean {
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
function extractFilePaths(toolName: string, toolInput: Record<string, any>): string[] {
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

function enforceFileRestrictions(
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
async function attachReposForFiles(
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

async function handlePreToolUse(rawInput: Record<string, any>, agentSlug?: string): Promise<void> {
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
        const { createAutoSnapshot } = await import('./snapshot.js');
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
  if ((input.tool_name || '').toLowerCase() === 'task') {
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

// ─── Live edit capture (PostToolUse ledger) ───────────────────────────────
//
// Record each Edit/Write/MultiEdit the instant its PostToolUse hook fires,
// stamped with the active prompt. This is the authoritative source for
// per-prompt blame: the exact tool inputs, before the transcript can
// truncate them, drift in format, or lag behind on disk. Merged with the
// transcript capture at Stop/session-end so shell/commit edits are still
// covered. Kill-switch: ORIGIN_LIVE_CAPTURE=0.
// Largest single edit (old + new content) we keep in the ledger. Bigger
// edits are SKIPPED, not clamped: a clamped copy would no longer byte-match
// the transcript's full record of the same tool call, so the merge couldn't
// dedupe them and the file would be counted twice. Skipping lets the
// transcript capture (full content) own oversized edits cleanly.
const LIVE_EDIT_CONTENT_MAX = 96 * 1024;
const LIVE_EDIT_MAX_ENTRIES = 2000;      // hard cap on ledger entry count
// Total content-byte budget for the ledger. The state file is rewritten on
// every tool call AND re-read on every hook, so an unbounded ledger would
// drag the agent down. Past this, new edits fall back to the transcript
// capture (no data loss — the transcript still records them).
const LIVE_EDIT_MAX_TOTAL_BYTES = 6 * 1024 * 1024;

function liveCaptureEnabled(): boolean {
  return process.env.ORIGIN_LIVE_CAPTURE !== '0';
}

// Union of files-read from the transcript parse and the hook-captured
// state.filesRead (pre-tool-use records Read-style tools live). Deduped,
// capped, undefined when empty so the API payload stays clean.
function mergeFilesRead(fromTranscript: string[], fromState?: string[]): string[] | undefined {
  const set = new Set<string>();
  for (const f of fromTranscript || []) if (f) set.add(f);
  for (const f of fromState || []) if (f) set.add(f);
  if (set.size === 0) return undefined;
  return Array.from(set).slice(0, 500);
}




/**
 * Identity of THIS capture run — one id per hook invocation, shared by every
 * mapping the run sends.
 *
 * The server writes a row's content (files, diff, line counts) as ONE unit
 * tagged with this, so a row records which capture it is describing instead of
 * accumulating fields from several captures that each described a different
 * turn. `capturedAt` orders them, so a payload that lost a race can no longer
 * overwrite fresher content.
 *
 * The ID is process-scoped on purpose: each hook fires in its own process, so
 * one constant per process IS one per capture.
 *
 * `capturedAt` is NOT, and must not be. It used to be a module-load constant
 * (`CAPTURE_STARTED_AT`) on the assumption that a hook is short-lived enough
 * for start time and send time to be the same instant. The Stop hook is not:
 * it parses the transcript, captures git state, normalizes the turn windows
 * and builds shadow commits before it sends. In prod session aea8c4d1 that gap
 * was 19:29:58.8 → 19:30:03.7, about five seconds.
 *
 * The heartbeat re-sends the CURRENT turn every 30s with a FRESH stamp, so a
 * tick inside that window carried a newer `capturedAt` than the Stop already
 * in flight. The server's staleness rule then dropped the Stop's complete
 * capture — 11 files and a 67 KB diff — while `editsJson` and `turnId`, which
 * are not staleness-gated, landed anyway. That is why those rows show mid-turn
 * line counts underneath a Stop-only editsJson.
 *
 * capture-stamp.ts already warns about exactly this for long-lived producers:
 * a frozen `capturedAt` makes every later pass "look older than content it had
 * itself just written". The same trap applies to any hook that works before it
 * sends. Stamping at call time makes the field mean what the server reads it
 * to mean — when this content was captured — instead of when the process
 * happened to boot.
 */
const CAPTURE_ID = `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** Provenance every promptChange payload carries. */
export function captureStamp(): { captureId: string; capturedAt: number } {
  return { captureId: CAPTURE_ID, capturedAt: Date.now() };
}

/**
 * One-line, bounded summary of a promptChanges payload: which INDEX each entry
 * claims, whether it carries a turnId, and how much work it says that turn did.
 *
 * Every misattribution class this file guards against is a payload landing on
 * the wrong index — and until now no log recorded what any sender actually put
 * on the wire, only how many entries it sent. Session 0f3b1e69's turn 0 held
 * another turn's 10 files and +369/-4, and the producer could not be identified
 * afterwards because the payload was never written down. This is what makes the
 * next one provable instead of a guess.
 */
export function summarizePromptPayload(
  mappings: Array<{ promptIndex?: number; turnId?: string; captureId?: string; filesChanged?: unknown; diff?: string; linesAdded?: number; linesRemoved?: number; commitSha?: string | null }> | undefined,
): Array<Record<string, unknown>> {
  if (!Array.isArray(mappings)) return [];
  return mappings.slice(0, 40).map((m) => ({
    i: m?.promptIndex,
    t: m?.turnId ? String(m.turnId).slice(0, 10) : null,
    k: m?.captureId ? String(m.captureId).slice(0, 10) : null,
    f: Array.isArray(m?.filesChanged) ? m.filesChanged.length : 0,
    a: m?.linesAdded ?? null,
    r: m?.linesRemoved ?? null,
    d: (m?.diff || '').length,
    c: m?.commitSha ? String(m.commitSha).slice(0, 8) : null,
  }));
}


/**
 * Fill in a mapping's line counts from the diff it is ALREADY sending.
 *
 * The stop path sends files + diff but NEVER line counts — `completedPromptMappings`
 * entries carry no linesAdded/linesRemoved at all, so every entry in the payload
 * log reads `+None/-None`. Counts could therefore only ever arrive from
 * post-commit, while files and diff arrived from stop: two senders, two turns'
 * worth of state, one row. That is the split behind rows 1 and 6 of prod session
 * 0f3b1e69 holding +191/-5 and +92/-1 against a ZERO-byte diff.
 *
 * #1274 made the server refuse counts from a payload that supplied no content —
 * necessary, but vacuous while no payload supplies both. This makes the stop
 * path supply both, so the content unit is real rather than nominal.
 *
 * Derived from the FULL diff, before the payload truncates it for transport —
 * same semantics post-commit already uses (true counts, capped diff). An
 * explicit count on the mapping always wins; a mapping with no diff is left
 * alone rather than being handed a fabricated zero.
 */
export function withDerivedLineCounts<T extends {
  diff?: string; uncommittedDiff?: string; linesAdded?: number; linesRemoved?: number;
}>(pm: T): T {
  if (typeof pm?.linesAdded === 'number' && typeof pm?.linesRemoved === 'number') return pm;
  const text = (pm?.diff && pm.diff.trim()) ? pm.diff : (pm?.uncommittedDiff || '');
  if (!text.trim()) return pm;
  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return {
    ...pm,
    linesAdded: typeof pm.linesAdded === 'number' ? pm.linesAdded : added,
    linesRemoved: typeof pm.linesRemoved === 'number' ? pm.linesRemoved : removed,
  };
}

/** Does this mapping actually carry captured work? */
export function promptMappingHasContent(m: {
  // promptIndex is not read here, but callers pass whole mapping objects —
  // accepting it keeps an object literal from tripping excess-property checks.
  promptIndex?: number; filesChanged?: unknown; diff?: string; uncommittedDiff?: string;
} | null | undefined): boolean {
  if (!m) return false;
  if (Array.isArray(m.filesChanged) && m.filesChanged.length > 0) return true;
  if ((m.diff || '').trim().length > 0) return true;
  if ((m.uncommittedDiff || '').trim().length > 0) return true;
  return false;
}

/**
 * Merge the git-derived mappings the hooks accumulated (`saved`) with the ones
 * re-derived from the transcript at Stop.
 *
 * The transcript is the sharper source WHEN IT SAW THE WRITE, so it still wins
 * per index. But it emits a mapping for EVERY prompt whether or not it found
 * any files, and it can only see Edit/Write tool calls — a turn that edited
 * through the shell (`python - <<PY`, `cat > f <<EOF`, `sed -i`) is invisible
 * to it. The old rule was "any index the transcript names is the transcript's",
 * so in a shell-write session those empty mappings evicted every correct
 * git-derived one.
 *
 * Measured on session 0f3b1e69, where every edit was a Bash heredoc: saved held
 * idx1=5 files and idx2=10 files, the transcript held six mappings with zero
 * files each, and the merge returned six empty mappings — 100% of the per-turn
 * attribution destroyed. What survived on the server did so only because
 * post-commit had written those rows earlier and the server preserves a
 * non-empty row against an empty PATCH.
 *
 * So: an EMPTY transcript mapping never displaces a saved one that has content.
 * Everything else keeps the previous precedence.
 */
export function mergePromptMappings<T extends { promptIndex: number; filesChanged?: unknown; diff?: string; uncommittedDiff?: string }>(
  saved: T[],
  fromTranscript: T[],
): T[] {
  const byIndex = new Map<number, T>();
  for (const m of saved) byIndex.set(m.promptIndex, m);
  for (const m of fromTranscript) {
    const prev = byIndex.get(m.promptIndex);
    // Transcript wins unless it is empty and the saved mapping is not.
    if (prev && !promptMappingHasContent(m) && promptMappingHasContent(prev)) continue;
    byIndex.set(m.promptIndex, m);
  }
  return [...byIndex.values()].sort((a, b) => a.promptIndex - b.promptIndex);
}

/**
 * The stable id for a turn, if this session has one. Sent alongside
 * promptIndex so the server can key the row on identity rather than position
 * — a prompt list that renumbers between two PATCHes then updates the same
 * row instead of writing one turn's diff over its neighbour's. Undefined for
 * sessions that started before ids existed; those keep the positional path.
 */
function turnIdFor(state: SessionState, promptIndex: number): string | undefined {
  const id = state.promptTurnIds?.[promptIndex];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function editContentBytes(e: { oldContent?: string; newContent?: string }): number {
  return (e.oldContent?.length || 0) + (e.newContent?.length || 0);
}

// Rough content-byte size of the existing ledger. Bounded by the entry cap,
// so this stays cheap (a few thousand string-length reads at worst).
function liveLedgerBytes(state: SessionState): number {
  let n = 0;
  for (const entry of state.liveEdits || []) {
    for (const e of entry.edits) n += editContentBytes(e);
  }
  return n;
}

/**
 * Pull edits from a PostToolUse payload and append them to the session's
 * live ledger, tagged with the current prompt index. Returns true when the
 * ledger changed (caller persists). Never throws.
 */
/**
 * Is this path inside `repoPath`'s working tree?
 *
 * The capture paths relativise with `toRepoRelative`, which RETURNS THE INPUT
 * UNCHANGED when the file lies outside the root — so an out-of-repo absolute
 * path does not fail loudly, it just travels on as if it were repo-relative
 * and gets rendered as a changed file of the repo.
 *
 * Symlinks are resolved on both sides: a worktree under /tmp on macOS is
 * really /private/tmp, and the un-resolved comparison would call a file in the
 * session's own worktree "outside".
 */
export function isInsideRepo(repoPath: string, file: string): boolean {
  if (!repoPath || !file) return false;
  // A relative path is already expressed against the repo root.
  if (!path.isAbsolute(file)) return true;
  // Resolve against the nearest EXISTING ancestor, then re-append the rest.
  // realpath'ing the file (or even its parent) fails whenever the write is
  // creating new directories, and a failed resolve compared raw against a
  // resolved root — which called a file in the session's own tree "outside"
  // on macOS, where /var is a symlink to /private/var.
  const resolveExisting = (p: string): string => {
    let head = p;
    const tail: string[] = [];
    for (let hops = 0; hops < 40; hops++) {
      // realpathSync.native, not realpathSync: on Windows the plain version
      // resolves symlinks but leaves 8.3 SHORT components alone, so a temp
      // path stays `C:\Users\RUNNER~1\…` while the repo root is the long
      // form and the same directory compares as two.
      try { return path.join(fs.realpathSync.native(head), ...tail.reverse()); } catch { /* walk up */ }
      const parent = path.dirname(head);
      if (!parent || parent === head) return p;
      tail.push(path.basename(head));
      head = parent;
    }
    return p;
  };
  const rel = path.relative(resolveExisting(repoPath), resolveExisting(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

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

function recordLiveEdits(state: SessionState, input: Record<string, any>, repoPath: string): boolean {
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

/**
 * Lift `outOfRepoFiles` off the stringified PromptCapture onto the
 * PromptChange wire field. MCP reads `pc.outOfRepoFiles`, not a field
 * buried inside editsJson — without this copy a Cursor canvas write is
 * peeled from edits (so it doesn't become a fake +N diff) and then the
 * explanation never reaches the server.
 */
/**
 * Deletions that are an artifact of `git init`, not of anything being deleted.
 *
 * Files created loose in the work tree are ordinary untracked files — git sees
 * them, and the capture counts them. The moment a `git init` runs in a
 * directory ABOVE them, that directory becomes a submodule boundary and every
 * file under it disappears from the parent's view. The next diff renders that
 * as a deletion of every line.
 *
 * Prod b6f3cc59: turn 2 created five files inside `inventory/` at 17:27:40-45
 * and was correctly captured as +192. Turn 3 ran `git init` in `inventory/`
 * at 17:31:18 — nine seconds before its Stop — and rendered "+0 -192". Nothing
 * moved and nothing was deleted; all five files are still on disk. The turn
 * read as destroying its predecessor's work.
 *
 * A deletion is phantom when the file is STILL THERE and the nested repo that
 * hid it appeared during this turn. Both halves matter: without the
 * still-on-disk check a real `rm` inside a nested repo would be swallowed, and
 * without the window check a turn would stop reporting real deletions under a
 * nested repo that has existed for months.
 */
export function dropPhantomNestedRepoDeletions(
  workRoot: string,
  filesChanged: string[],
  diff: string,
  sinceMs: number,
): { filesChanged: string[]; diff: string; linesAdded: number; linesRemoved: number; dropped: string[] } {
  const count = (d: string) => {
    let a = 0; let r = 0;
    for (const l of d.split('\n')) {
      if (l[0] === '+' && !l.startsWith('+++')) a++;
      else if (l[0] === '-' && !l.startsWith('---')) r++;
    }
    return { linesAdded: a, linesRemoved: r };
  };
  const unchanged = () => ({ filesChanged, diff, ...count(diff), dropped: [] as string[] });
  if (!diff.trim() || !workRoot || !Number.isFinite(sinceMs)) return unchanged();

  // The nested repo that hides `file`, if one appeared during this turn.
  const hiddenByFreshNestedRepo = (file: string): boolean => {
    const abs = path.join(workRoot, file);
    try { if (!fs.existsSync(abs)) return false; } catch { return false; }
    // `samePath`/`isInsideRepo`, never raw string identity — see paths.ts and
    // the path-comparison guard. On Windows git answers with forward slashes
    // and node with backslashes, so `===` here is silently always false.
    let dir = path.dirname(abs);
    // Bound EXPLICITLY to paths.ts: hooks.ts has its own `isInsideRepo` and
    // `samePath` here resolves to session-worktree's. Same names, different
    // normalisation — exactly the ambiguity the guard exists to stop.
    while (isInsideRepoNormalized(workRoot, dir) && !samePathNormalized(dir, workRoot)) {
      try {
        const st = fs.statSync(path.join(dir, '.git'));
        // CREATION time decides, and mtime is only the fallback for platforms
        // that do not report birthtime. `birthtime >= since || mtime >= since`
        // was wrong in both directions: an old repo COMMITTED to during the
        // turn has a fresh mtime and would read as new, and on macOS backdating
        // mtime drags birthtime with it. Prefer birthtime when the platform
        // gives a real one; a `git init` sets it to now, and no later commit
        // moves it.
        const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
        return born >= sinceMs; // a nested repo, but is it THIS turn's?
      } catch { /* not a repo boundary — keep climbing */ }
      dir = path.dirname(dir);
    }
    return false;
  };

  const dropped: string[] = [];
  const kept = diff.split(/^(?=diff --git )/m).filter((sec) => {
    if (!sec.trim()) return false;
    const m = (sec.split('\n', 1)[0] || '').match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!m) return true;
    // Only whole-file DELETIONS qualify. A modification under a nested repo is
    // not expressible from the parent anyway, and dropping one would hide real
    // work rather than a phantom.
    const isDeletion = /^deleted file mode /m.test(sec) || /^\+\+\+ \/dev\/null$/m.test(sec);
    if (!isDeletion) return true;
    if (!hiddenByFreshNestedRepo(m[1])) return true;
    dropped.push(m[1]);
    return false;
  });
  if (dropped.length === 0) return unchanged();
  const nextDiff = kept.join('').trim();
  const droppedSet = new Set(dropped);
  return {
    filesChanged: filesChanged.filter((f) => !droppedSet.has(f)),
    diff: nextDiff,
    ...count(nextDiff),
    dropped,
  };
}

/** The turn's out-of-repo files from BOTH sources: edits the capture already
 *  peeled off as outside the repo, and anything it wrote into a nested repo,
 *  which git hides from the parent entirely. */
function outOfRepoFilesFor(
  raw: string | undefined | null, nested: string[],
): { outOfRepoFiles: string[] } | Record<string, never> {
  const fromEdits = outOfRepoFilesFromEditsJson(raw);
  const merged = [...new Set([
    ...(('outOfRepoFiles' in fromEdits) ? fromEdits.outOfRepoFiles : []),
    ...nested,
  ])];
  return merged.length > 0 ? { outOfRepoFiles: merged } : {};
}

/** Nested-repo writes for the turn that just ended, bounded to its own window.
 *  Returns nothing when the window is unknown — claiming a nested repo an
 *  EARLIER turn created would be a new wrong answer, not a fix for the zero. */
function nestedRepoWritesForOpenTurn(state: SessionState): string[] {
  const openedAt = state.activeTurn?.openedAt;
  const sinceMs = openedAt ? Date.parse(openedAt) : NaN;
  if (!Number.isFinite(sinceMs)) return [];
  const root = currentSessionWorkTree(state) || state.repoPath;
  if (!root) return [];
  try {
    return nestedRepoFilesWritten(root, sinceMs);
  } catch {
    return [];
  }
}

/**
 * Files a turn wrote into a NESTED git repository inside the work tree.
 *
 * `git init` inside the checkout makes a submodule boundary. From the parent,
 * git reports the directory and nothing under it — at ANY `-u` level:
 *
 *   $ git status --porcelain -uall
 *   ?? random_project/          <- dice.py never appears
 *
 * So no diff-based capture can see that work, and the turn renders exactly
 * like one that did nothing. Prod 2a8dc4d4 (kotleta, Antigravity) turn 5:
 * the agent created `random_project/` as its own repo, wrote dice.py at
 * 16:37:12 — eleven seconds before the turn's Stop — and the row read 0 files.
 * Four of that session's five turns were correct; this was the one that was
 * not, and it was indistinguishable from the three legitimate zeroes.
 *
 * Reported as out-of-repo rather than folded into the diff: a nested repo is a
 * different project, and claiming its files as this repo's work would be a
 * worse lie than the zero. The session tile already answers the question the
 * zero provokes — "N files written outside repo" — once this field is fed.
 *
 * Bounded by `sinceMs` so only what the turn actually wrote is claimed, and by
 * a file cap so a vendored node_modules-sized repo can't blow the payload.
 */
export function nestedRepoFilesWritten(
  repoPath: string,
  sinceMs: number,
  opts?: { limit?: number; statusText?: string },
): string[] {
  const limit = opts?.limit ?? 50;
  if (!repoPath || !Number.isFinite(sinceMs)) return [];
  let status = opts?.statusText;
  if (status === undefined) {
    try {
      status = execFileSync('git', ['status', '--porcelain'], {
        windowsHide: true, cwd: repoPath, encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
      }).toString();
    } catch { return []; }
  }
  const dirs = status.split('\n')
    .filter((l) => l.startsWith('?? ') && l.trimEnd().endsWith('/'))
    .map((l) => l.slice(3).trim().replace(/\/$/, ''))
    // A path that climbs out of the tree is not ours to walk.
    .filter((d) => d.length > 0 && !d.startsWith('/') && !d.split('/').includes('..'));

  const out: string[] = [];
  for (const dir of dirs) {
    const abs = path.join(repoPath, dir);
    // Only a NESTED REPO is invisible to the parent. An ordinary untracked
    // directory is already listed file-by-file under `-uall`, so reporting it
    // here would double-count work the normal capture can see.
    try { if (!fs.existsSync(path.join(abs, '.git'))) continue; } catch { continue; }
    const walk = (d: string): void => {
      if (out.length >= limit) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) return;
        if (e.name === '.git') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.isFile()) continue;
        try {
          if (fs.statSync(full).mtimeMs < sinceMs) continue;
        } catch { continue; }
        out.push(path.relative(repoPath, full));
      }
    };
    walk(abs);
  }
  return out;
}

function outOfRepoFilesFromEditsJson(raw: string | undefined | null): { outOfRepoFiles: string[] } | Record<string, never> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { outOfRepoFiles?: unknown };
    if (!Array.isArray(parsed.outOfRepoFiles) || parsed.outOfRepoFiles.length === 0) return {};
    const files = parsed.outOfRepoFiles.filter((f): f is string => typeof f === 'string' && f.length > 0);
    return files.length > 0 ? { outOfRepoFiles: files } : {};
  } catch {
    return {};
  }
}

/**
 * Layer the live ledger over a transcript capture at Stop/session-end. When
 * the ledger has entries (Claude/Cursor PostToolUse fired), its exact
 * tool-call edits win and the transcript supplies shell/commit backfill and
 * prompt text. Empty ledger (e.g. Codex, or ORIGIN_LIVE_CAPTURE=0) → the
 * transcript capture passes through unchanged.
 */
function applyLiveLedger(captures: PromptCapture[], state: SessionState, scope: string): PromptCapture[] {
  if (!liveCaptureEnabled() || !state.liveEdits || state.liveEdits.length === 0) return captures;
  const ledger = buildCapturesFromLedger(state.liveEdits);
  if (ledger.length === 0) return captures;
  const merged = mergeLedgerWithTranscript(ledger, captures);
  debugLog(scope, 'merged live ledger with transcript', {
    ledgerPrompts: ledger.length,
    transcriptPrompts: captures.length,
    mergedPrompts: merged.length,
    ledgerEdits: ledger.reduce((n, c) => n + c.edits.length, 0),
  });
  // The ledger is afterFileEdit / PostToolUse — those already skip a
  // canvas (no git diff). Re-run the gate anyway so a ledger path that
  // DID record an absolute out-of-repo write cannot put it back onto
  // editsJson after capturePromptEdits peeled it off.
  if (state.repoPath) dropOutOfRepoEdits(merged, state.repoPath);
  return merged;
}

async function handlePostToolUse(rawInput: Record<string, any>, agentSlug?: string): Promise<void> {
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

    // Close out the matching sub-agent spawn (Task tool) so its duration is
    // known. Match by toolCallId only — Task calls always carry one.
    if (toolCallId && (toolName || '').toLowerCase() === 'task' && state.subagentSpawns) {
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
function noteShellWriteTurn(state: SessionState, input: Record<string, any>): boolean {
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

/**
 * Derive this turn's SHELL writes from its git window and append them to the
 * live ledger, so the turn ships real `edits` instead of the `edits: []` that
 * every read surface has to guess about (see shell-write-capture.ts).
 *
 * Runs at Stop, which is the moment the window is exactly this turn's work:
 * `baselineSha` was snapshotted when the turn started and the tree in front
 * of us is where the turn left it. Files the ledger already covers with a
 * real tool call are never re-derived — the agent's own edit payload is more
 * precise than a whole-file pair.
 *
 * Idempotent: a re-fired Stop replaces this turn's window edits rather than
 * appending a second copy.
 */
// The working tree this session is writing in — `state.repoPath` unless it
// moved into a linked worktree of the same repo. Resolved fresh rather than
// stored: a session can move between turns, and a stale value would point the
// window at a tree the turn never touched.
function currentSessionWorkTree(state: SessionState): string {
  try {
    return sessionWorkTree(state.repoPath, state.lastCwd, {
      gitRoot: getWorkingGitRoot,
      gitCommonDir: getGitCommonDir,
    });
  } catch {
    return state.repoPath || '';
  }
}

// Trees this session may be writing in right now: its working tree plus every
// worktree this turn revealed. Probed as a set, because a single command can
// touch more than one of them.
function treesToProbe(state: SessionState, promptIndex: number): string[] {
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

function probeDepsFor(): { listDirty: (t: string) => string[]; stat: (t: string, f: string) => { mtimeMs: number; size: number } | null } {
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
const SHELL_COMMAND_MAX = 4096;
// Undrained probes a turn may hold at once. Parallel tool calls arm several
// legitimately; beyond this the oldest are dropped, so a run of missing
// post-tool-use hooks cannot grow the session state without bound.
const SHELL_PROBE_MAX_PENDING = 8;

/**
 * Did the command that just ran NAME this file?
 *
 * The probe proves a file changed inside one command's execution window. That
 * is strong on a quiet checkout and weak on a busy one — session 6e9947a5 had
 * six live agents, and a sibling's write landed inside our window and became
 * "ours". Naming closes it: our own heredoc / sed / tee writes spell the path
 * out, and a sibling's file never appears in our command text.
 *
 * Matched on the repo-relative path and on the absolute path, never on the
 * BASENAME. A basename match would let one mention of `hooks.ts` claim every
 * hooks.ts in the repo — the kind of loose matching that produced the
 * attribution bugs this is fixing.
 *
 * A read-only mention cannot cause a false claim on its own: this only ever
 * GRADES an edit the probe already observed, so a file has to have CHANGED as
 * well as been named.
 */
export function fileNamedInCommand(command: string, file: string, tree?: string): boolean {
  if (!command || !file) return false;
  const cmd = command.replace(/\\/g, '/');
  const rel = file.replace(/\\/g, '/');
  if (rel.includes('/') && cmd.includes(rel)) return true;
  if (tree) {
    const abs = path.join(tree, file).replace(/\\/g, '/');
    if (cmd.includes(abs)) return true;
  }
  return false;
}

/** The baseline this turn diffs `tree` against — its own, never another's. */
function baselineShaForTree(state: SessionState, tree: string, promptIndex: number): string | null {
  for (const w of state.discoveredWorkTrees || []) {
    if (w.promptIndex === promptIndex && samePath(w.path, tree)) return w.sha;
  }
  const wt = state.prePromptWorkTree;
  if (wt && wt.promptIndex === promptIndex && samePath(wt.path, tree)) return wt.sha;
  if (samePath(tree, state.repoPath)) return state.prePromptSha || null;
  return null;
}

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

function recordProbedShellEdits(
  state: SessionState, tree: string, baselineSha: string | undefined,
  promptIndex: number, touched: string[],
  // Which ledger slot and provenance to write. Defaults keep the shell-probe
  // behaviour; the edit-hook path passes its own so the two never overwrite
  // each other's entries for the same turn.
  opts?: { toolLabel?: string; evidence?: PromptEdit['evidence']; command?: string },
): boolean {
  if (liveLedgerBytes(state) >= LIVE_EDIT_MAX_TOTAL_BYTES) return false;
  const edits: PromptEdit[] = [];
  for (const file of touched) {
    if (isOriginAutoManagedPath(file) || shouldIgnoreFile(file)) continue;
    const abs = path.join(tree, file);
    if (!isInsideRepo(tree, abs)) continue;
    let newContent: string | null = null;
    try { newContent = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null; } catch { continue; }
    let oldContent: string | null = null;
    if (baselineSha) { try { oldContent = readFileAtRev(tree, baselineSha, file); } catch { oldContent = null; } }
    const edit: PromptEdit = {
      file,
      op: newContent === null ? 'delete' : (oldContent === null ? 'create' : 'write'),
      oldContent: oldContent ?? undefined,
      newContent: newContent ?? undefined,
      // source stays 'uncommitted' — the server's allowlist drops anything
      // else outright. The PROOF rides in `evidence`, which older servers
      // carry through untouched instead of discarding the edit.
      source: 'uncommitted',
      // Graded, not flat. A file this command NAMED and that changed inside
      // its window is ours as firmly as a tool call; one that merely changed
      // in the window is the weak signal a sibling can forge.
      evidence: opts?.evidence
        ?? (fileNamedInCommand(opts?.command || '', file, tree) ? 'command_named' : 'command_probe'),
    };
    if (editContentBytes(edit) > LIVE_EDIT_CONTENT_MAX) continue;
    edits.push(edit);
  }
  if (edits.length === 0) return false;

  // Upsert by file within this turn: one edit per file, baseline → latest.
  const slot = opts?.toolLabel ?? SHELL_PROBE_TOOL;
  const keep = (state.liveEdits || []).filter((entry) => {
    if (entry.promptIndex !== promptIndex || entry.toolName !== slot) return true;
    entry.edits = (entry.edits || []).filter((e) => !edits.some((n) => n.file === e.file));
    return (entry.edits || []).length > 0;
  });
  keep.push({
    promptIndex, toolName: slot, capturedAt: new Date().toISOString(), edits,
  });
  state.liveEdits = keep;
  debugLog('post-tool-use', 'shell command probe captured', {
    promptIndex, tree, files: edits.length,
  });
  return true;
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
function noteCheckoutContention(state: SessionState): boolean {
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

// Agents that expose a per-tool or per-edit hook. They already produce
// evidence, so the journal is redundant cost for them; everything else has
// only the turn window and is exactly who the journal exists for.
const AGENTS_WITH_TOOL_EVIDENCE = new Set(['claude-code', 'antigravity', 'gemini', 'cursor']);

/** How long a journal watcher stays alive with no session activity. */
const JOURNAL_WATCH_IDLE_MS = 30 * 60 * 1000;

/**
 * Make sure a write-journal watcher is running for this session.
 *
 * Hooks are short-lived processes, so the watcher has to be detached and
 * outlive them — the same shape as the agy transcript watcher. A lock file
 * whose mtime the watcher refreshes keeps one per session; a lock older than
 * the refresh interval is treated as a dead watcher and replaced.
 *
 * Best-effort throughout: if the spawn fails, or the platform cannot watch
 * recursively, the session simply keeps the turn window it always had.
 */
function ensureWriteJournal(state: SessionState, agentSlug: string | undefined): boolean {
  try {
    if (!liveCaptureEnabled()) return false;
    if (AGENTS_WITH_TOOL_EVIDENCE.has(agentSlug || '')) return false;
    const repoPath = currentSessionWorkTree(state) || state.repoPath;
    if (!repoPath) return false;
    if (process.env.ORIGIN_JOURNAL_IS_WATCHER === '1') return false;

    const tag = state.sessionTag || state.sessionId.slice(0, 12);
    const dir = path.join(os.homedir(), '.origin', 'journals');
    const journalPath = path.join(dir, `${tag}.jsonl`);
    const lockPath = path.join(dir, `${tag}.lock`);
    fs.mkdirSync(dir, { recursive: true });

    let mutated = false;
    // samePath, not !==: this is built from os.homedir(), which can come back
    // in short form on one run and long form on another. Raw inequality would
    // rewrite the state file every hook for no reason.
    if (!samePath(state.writeJournalPath, journalPath)) {
      state.writeJournalPath = journalPath;
      mutated = true;
    }

    // A fresh lock means a live watcher; anything older is a corpse.
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age <= JOURNAL_WATCH_LOCK_STALE_MS) return mutated;
    } catch { /* no lock — spawn */ }

    // Same as every other detached spawn here: re-invoke this very script.
    const bin = process.argv[1];
    if (!bin) return mutated;
    const child = spawn(process.execPath, [bin, 'hooks', 'journal-watch'], {
      detached: true,
      stdio: 'ignore',
      // Without this a detached console app pops a terminal window on Windows.
      windowsHide: true,
      env: {
        ...process.env,
        ORIGIN_JOURNAL_IS_WATCHER: '1',
        ORIGIN_JOURNAL_REPO: repoPath,
        ORIGIN_JOURNAL_PATH: journalPath,
        ORIGIN_JOURNAL_LOCK: lockPath,
      },
    });
    child.unref();
    debugLog('journal', 'write-journal watcher spawned', { repoPath, journalPath });
    return mutated;
  } catch (err: unknown) {
    debugLog('journal', 'write-journal watcher spawn failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** A lock this old means the watcher that wrote it is gone. */
const JOURNAL_WATCH_LOCK_STALE_MS = 60_000;

/**
 * The detached watcher itself. Refreshes its lock so a sibling hook can tell
 * it is alive, and exits once the session has been quiet long enough that
 * nothing will ask for its journal again.
 */
export async function runJournalWatcher(): Promise<void> {
  const repoPath = process.env.ORIGIN_JOURNAL_REPO || '';
  const journalPath = process.env.ORIGIN_JOURNAL_PATH || '';
  const lockPath = process.env.ORIGIN_JOURNAL_LOCK || '';
  if (!repoPath || !journalPath) return;

  const watcher = startWriteJournal(repoPath, journalPath);
  if (!watcher) {
    // No recursive watch on this platform — say so once and leave, rather than
    // holding a process open that records nothing.
    debugLog('journal-watch', 'recursive watch unavailable, exiting', { repoPath });
    return;
  }

  let lastSize = -1;
  let idleSince = Date.now();
  const timer = setInterval(() => {
    try { if (lockPath) fs.writeFileSync(lockPath, String(process.pid)); } catch { /* ignore */ }
    try {
      const size = fs.statSync(journalPath).size;
      if (size !== lastSize) { lastSize = size; idleSince = Date.now(); }
    } catch { /* ignore */ }
    if (Date.now() - idleSince > JOURNAL_WATCH_IDLE_MS) {
      clearInterval(timer);
      watcher.stop();
      try { compactJournal(journalPath); } catch { /* ignore */ }
      try { if (lockPath) fs.unlinkSync(lockPath); } catch { /* ignore */ }
      process.exit(0);
    }
  }, 15_000);
  // Keep the interval from holding a finished process open indefinitely.
  timer.unref?.();
  await new Promise(() => { /* run until the idle check exits us */ });
}

/**
 * Files this turn WROTE, according to the session's write journal.
 *
 * The journal is the only evidence path for an agent that exposes no tool
 * hooks — Codex, Devin and Copilot each attribute every file through the turn
 * window today, i.e. through whatever happened to be dirty. A journal entry
 * says the file changed at a moment inside this turn, which is a different and
 * far stronger claim.
 *
 * Returns [] when there is no journal (no watcher, unsupported platform, a
 * session that predates this) so the caller falls back to the window rather
 * than concluding the turn wrote nothing.
 */
function journalFilesForTurn(state: SessionState, endedAt?: number): string[] {
  try {
    const jp = state.writeJournalPath;
    const startedAt = state.currentTurnStartedAt;
    if (!jp || !startedAt) return [];
    const records = readJournal(jp);
    if (records.length === 0) return [];
    return filesWrittenDuring(records, { startedAt, endedAt })
      .filter((f) => !isOriginAutoManagedPath(f) && !shouldIgnoreFile(f));
  } catch {
    return [];
  }
}

/**
 * Record the journal's view of this turn as ledger evidence.
 *
 * Runs alongside the probe rather than instead of it: an agent WITH tool hooks
 * gets both, and the more precise one already covers its files, so this only
 * adds what the hooks never saw.
 */
function recordJournalEdits(state: SessionState, promptIndex: number, endedAt?: number): boolean {
  const files = journalFilesForTurn(state, endedAt);
  if (files.length === 0) return false;
  const tree = currentSessionWorkTree(state);
  const baseline = baselineShaForTree(state, tree, promptIndex) || undefined;
  const changed = recordProbedShellEdits(state, tree, baseline, promptIndex, files, {
    toolLabel: WRITE_JOURNAL_TOOL, evidence: 'write_journal',
  });
  if (changed) {
    debugLog('stop', 'write-journal evidence recorded', { promptIndex, files: files.length });
  }
  return changed;
}

// Worktrees this turn revealed through a shell command's text, each baselined
// at the moment we first saw it. Bounded to a handful per turn: every entry
// costs a shadow commit, and an agent that really works in more than a few
// worktrees in one turn is not a case worth paying for on every Bash call.
const MAX_DISCOVERED_WORKTREES = 4;

function discoverWorkTreesFromCommand(state: SessionState, input: Record<string, any>): void {
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

// Run the shell window over every worktree this turn revealed, in addition to
// the session's main tree. Each uses ITS OWN baseline — mixing a baseline from
// one tree with the files of another reports the whole branch delta.
function recordDiscoveredWorkTreeEdits(state: SessionState, promptIndex: number): boolean {
  let changed = false;
  for (const w of state.discoveredWorkTrees || []) {
    if (w.promptIndex !== promptIndex) continue;
    if (samePath(w.path, state.repoPath)) continue;
    try {
      if (recordShellWindowEdits(state, w.path, promptIndex, w.sha)) changed = true;
    } catch (err: unknown) {
      debugLog('stop', 'discovered-worktree capture threw (non-fatal)', {
        workTree: w.path, message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return changed;
}

// Snapshot this turn's baseline inside the worktree, when the session is in
// one. Best-effort: without it the window falls back to the main checkout's
// pair, which is the old (under-capturing but self-consistent) behaviour.
function recordWorkTreeBaseline(state: SessionState, hookCwd: string): void {
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

/** Owned commits inside a turn's window that are MERGES. Scoped to the
 *  session's own commit list for the same reason sessionScopedCommittedDiff is:
 *  a concurrent agent's merge is not this turn's to explain away. */
/** Every commit reachable from HEAD but not from the turn's baseline. */
function shasInWindow(repoPath: string, baselineSha: string | null | undefined): string[] {
  if (!baselineSha || !/^[a-fA-F0-9]{7,40}$/.test(baselineSha)) return [];
  try {
    return execFileSync('git', ['rev-list', `${baselineSha}..HEAD`], {
      windowsHide: true, cwd: repoPath, encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).toString().split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function mergeShasInWindow(
  repoPath: string, state: SessionState, baselineSha: string | null | undefined,
): string[] {
  const owned = state.sessionCommitShas || [];
  if (owned.length === 0) return [];
  const inWindow = shasInWindow(repoPath, baselineSha);
  if (inWindow.length === 0) return [];
  return owned.filter((sha) => inWindow.some(
    (full) => full === sha || full.startsWith(sha) || sha.startsWith(full),
  ));
}

/**
 * Files the turn's window shows as changed ONLY because someone else's commit
 * arrived in it.
 *
 * The window is `baseline..working-tree`, which answers "did the repo move",
 * not "did I write this". A `git merge` is already handled above, but a REBASE
 * or a fast-forward `git pull` brings commits in with no merge commit to find,
 * and the rebase also re-parents the turn's shadow baseline onto a lineage the
 * incoming work is not in — so every file those commits touched reads as this
 * turn's writes.
 *
 * Session 3dbff831 turn 1 ran `git rebase origin/main`, which fast-forwarded
 * PR #1371 into the window. The turn — which authored a one-line version bump
 * — was credited with 3 files and +108/-22, all of it that PR's:
 * codex-rollout-patches.test.ts +102/-20, codex-watch.test.ts +5/-1, and the
 * bump. (codex.ts escaped only because it tripped the byte cap.)
 *
 * Ownership is `commitBelongsToSession`, the single predicate the per-turn and
 * session-level commit paths already share; it is deliberately generous, so a
 * commit is treated as foreign only when it can be shown not to be ours.
 *
 * The test is per FILE and by CONTENT, not "this commit is foreign, drop
 * everything it touched": a file the turn ALSO edited must survive. #1371
 * bumped package.json too, and this turn really did bump it again — its
 * working-tree content differs from what the foreign commit left, so it stays.
 * Only a file the working tree still holds exactly as the foreign commit wrote
 * it is unexplainable as this turn's work.
 */
export function filesLeftByForeignCommits(
  repoPath: string, state: SessionState, baselineSha: string | null | undefined,
): Set<string> {
  const pulled = new Set<string>();
  const inWindow = shasInWindow(repoPath, baselineSha);
  if (inWindow.length === 0) return pulled;
  let localEmail = '';
  try { localEmail = localCommitterEmail(repoPath); } catch { localEmail = ''; }
  let budget = FOREIGN_WINDOW_FILE_BUDGET;
  for (const sha of inWindow) {
    if (budget <= 0) break;
    if (commitBelongsToSession(repoPath, sha, state, localEmail)) continue;
    for (const file of commitChangedFiles(repoPath, sha)) {
      if (budget-- <= 0) break;
      if (pulled.has(file)) continue;
      const atCommit = readFileAtRev(repoPath, sha, file);
      let working: string | null;
      try {
        const abs = path.join(repoPath, file);
        working = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
      } catch { continue; }
      if (atCommit === working) pulled.add(file);
    }
  }
  return pulled;
}

// Ceiling on the file reads the exclusion above will do in a Stop hook. A
// rebase across a long-running branch can pull in hundreds of commits; past
// this the turn keeps today's behaviour rather than stalling the hook.
const FOREIGN_WINDOW_FILE_BUDGET = 300;

/**
 * May the shell-window capture run for this turn?
 *
 * `shellWriteTurns` is a HEURISTIC — it means "a Bash command in this turn
 * looked like it wrote a file". It used to be the sole gate, and when it missed
 * the turn got no window capture at all. That is not recoverable later: the
 * Stop that ends a turn anchors the NEXT turn's baseline at the current tree,
 * so uncaptured work is inside that baseline and every subsequent diff
 * correctly reports it as unchanged.
 *
 * Prod a77105c0 turn 0 ended `final-state hunks {prompts:0, shadows:1}` while
 * the very next line logged `anchored next-prompt baseline {dirtyCount:3}` —
 * three source files (+87/-79) erased in one step. They were in no turn, and no
 * later pass could find them: turn 1 diffing from that baseline was right to
 * say nothing had changed.
 *
 * So the heuristic may VETO only a turn that already captured something. A turn
 * that captured NOTHING always gets the window, because a non-empty diff from
 * the turn's own baseline is harder evidence than a probe that did not fire.
 *
 * Safe in the two directions that matter:
 *  - PRE-SESSION dirt is already inside the turn's baseline (session start
 *    snapshots a dirty tree into `sessionStartShadowSha`), so it cannot be
 *    attributed here.
 *  - A CONCURRENT agent's work is excluded by `foreignFiles` at the call site,
 *    the same exclusion the uncommitted path uses.
 * A genuinely chat-only turn simply produces an empty window and stays empty.
 */
export function shouldRunShellWindow(
  state: { liveEdits?: Array<{ promptIndex: number; edits?: unknown[] }>; shellWriteTurns?: number[] },
  promptIndex: number,
): boolean {
  const capturedSomething = (state.liveEdits || []).some(
    (e) => e.promptIndex === promptIndex && (e.edits || []).length > 0,
  );
  if (!capturedSomething) return true;
  return (state.shellWriteTurns || []).includes(promptIndex);
}

function recordShellWindowEdits(
  state: SessionState,
  repoPath: string,
  promptIndex: number,
  baselineSha: string | null | undefined,
): boolean {
  try {
    if (!liveCaptureEnabled() || !repoPath || !baselineSha) return false;
    if (promptIndex < 0) return false;
    if (!shouldRunShellWindow(state, promptIndex)) return false;
    // Share the ledger's byte budget: the state file is re-read on every hook,
    // so a fat window would tax every subsequent tool call. Past the ceiling
    // the turn keeps the git-captured pc.diff it has always had.
    if (liveLedgerBytes(state) >= LIVE_EDIT_MAX_TOTAL_BYTES) {
      debugLog('stop', 'live ledger full, skipping shell window', { promptIndex });
      return false;
    }

    const covered: string[] = [];
    for (const entry of state.liveEdits || []) {
      if (entry.promptIndex !== promptIndex) continue;
      for (const e of entry.edits || []) {
        if (!e.source || e.source === 'tool_call') covered.push(e.file);
      }
    }
    // A `git merge` rewrites every file it absorbs, so the window below sees
    // the other branch's work as writes THIS turn made. Those land in the
    // turn's editsJson, and the session header is synthesized from exactly
    // that — prod f7881a6e read +1607/-119 when its own commits hold +1074/-69,
    // the difference being eight files three merges brought in. What a merge
    // RESOLVED stays: that part the merging turn did author.
    const absorbed = new Set<string>();
    for (const sha of mergeShasInWindow(repoPath, state, baselineSha)) {
      for (const f of mergeAbsorbedFiles(repoPath, sha)) absorbed.add(f);
    }
    if (absorbed.size > 0) {
      debugLog('stop', 'merge-absorbed files excluded from the shell window', {
        promptIndex, count: absorbed.size,
      });
    }
    // The same question a merge asks, for the commits a rebase or a
    // fast-forward pull brings in — see filesLeftByForeignCommits.
    const pulled = filesLeftByForeignCommits(repoPath, state, baselineSha);
    for (const f of pulled) absorbed.add(f);
    if (pulled.size > 0) {
      debugLog('stop', 'pulled foreign-commit files excluded from the shell window', {
        promptIndex, count: pulled.size, files: [...pulled].slice(0, 20),
      });
    }

    const { edits, skipped } = shellWindowEdits(
      {
        listChangedFiles: (sha) => filesChangedSinceShadow(repoPath, sha)
          .filter((f) => !absorbed.has(f)),
        readAtRev: (sha, file) => readFileAtRev(repoPath, sha, file),
        readWorking: (file) => {
          try {
            const abs = path.join(repoPath, file);
            if (!fs.existsSync(abs)) return null;
            return fs.readFileSync(abs, 'utf-8');
          } catch { return null; }
        },
      },
      {
        baselineSha,
        coveredFiles: covered,
        isIgnored: (file) => isOriginAutoManagedPath(file) || shouldIgnoreFile(file),
        // The window is a bare baseline..working-tree diff, so on a shared
        // checkout it holds every other agent's in-progress work too. This is
        // the same exclusion the uncommitted-diff path uses; without it, three
        // rounds of making that exclusion smarter changed nothing for a
        // shell-heavy turn, because this path never asked.
        foreignFiles: uncommittedExcludeUnion(state),
        maxFileBytes: LIVE_EDIT_CONTENT_MAX,
        maxTotalBytes: Math.max(0, LIVE_EDIT_MAX_TOTAL_BYTES - liveLedgerBytes(state)),
      },
    );
    // Drop a previous run's window edits for this turn before re-adding, so a
    // second Stop doesn't double-count the same file.
    const prior = (state.liveEdits || []).length;
    state.liveEdits = (state.liveEdits || []).filter(
      (entry) => !(entry.promptIndex === promptIndex && entry.toolName === SHELL_WINDOW_TOOL),
    );
    const replaced = prior !== state.liveEdits.length;
    if (edits.length === 0) {
      if (skipped.length > 0 || replaced) {
        debugLog('stop', 'shell window produced no edits', {
          promptIndex, skipped: skipped.length, replaced,
        });
      }
      return replaced;
    }
    state.liveEdits.push({
      promptIndex,
      toolName: SHELL_WINDOW_TOOL,
      capturedAt: new Date().toISOString(),
      edits,
    });
    // Skip REASONS, not just a count. A bare `skipped: 7` is what this line
    // used to say, and it is unreadable at exactly the moment it matters: prod
    // a77105c0 dropped three real source files here (+87/-79) and the only
    // record was that number. Four of those seven skips were correct (three
    // Origin-managed context files and a lockfile) and three were the bug —
    // indistinguishable without the reasons.
    //
    // `ignored` is the boring, expected bucket, so it is summarised as a count;
    // every other reason names its files, because those are the ones that
    // silently lose a developer's work. Capped so a pathological turn cannot
    // flood the log.
    const skipsByReason: Record<string, string[]> = {};
    for (const sk of skipped) {
      const reason = (sk as { reason?: string }).reason || 'unknown';
      const file = (sk as { file?: string }).file || '?';
      (skipsByReason[reason] ||= []).push(file);
    }
    debugLog('stop', 'shell window edits captured', {
      promptIndex,
      files: edits.length,
      skipped: skipped.length,
      source: SHELL_WINDOW_SOURCE,
      baseline: String(baselineSha).slice(0, 12),
      skipReasons: Object.fromEntries(
        Object.entries(skipsByReason).map(([reason, files]) => [
          reason,
          reason === 'ignored' ? files.length : files.slice(0, 20),
        ]),
      ),
    });
    return true;
  } catch (err: unknown) {
    debugLog('stop', 'shell window capture failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Ledger `toolName` for shell-window entries. Distinct from a real tool name
// so the entries can be found and replaced on a re-fired Stop.
const SHELL_WINDOW_TOOL = 'origin:shell-window';
// Ledger entries produced by the per-command probe (evidence), kept distinct
// from the turn window's inferred entries so each can be replaced on its own.
const SHELL_PROBE_TOOL = '__shell_probe__';
// Cursor's afterFileEdit names the file it just wrote. Its own ledger slot so
// it and the shell probe can both contribute to one turn without either
// replacing the other's entries.
const EDIT_HOOK_TOOL = 'origin:edit-hook';
// Ledger slot for write-journal evidence, separate so it never replaces what
// the more precise tool-hook paths recorded for the same turn.
const WRITE_JOURNAL_TOOL = 'origin:write-journal';

/**
 * Resolve the repo cwd for an `afterFileEdit` payload.
 *
 * Cursor's afterFileEdit stdin carries NO `cwd` key (unlike beforeSubmitPrompt
 * / stop) — only `file_path` + `workspace_roots`. The old
 * `input.cwd || process.cwd()` therefore always fell through to process.cwd(),
 * which for a Cursor-spawned hook is `~/.cursor`. findStateForHook then scanned
 * `~/.cursor` for active sessions, found none, and every single edit aborted
 * with "no session state" — a 100% drop rate, measured 10/10 on a real
 * karamba session. That silently blanked the very case this hook exists for,
 * and it hurt worst on multitask/background-agent turns: a forked Cursor
 * subagent gets a fresh per-turn `session_id` and fires NO stop hook, so
 * afterFileEdit is the ONLY signal its edits ever produce.
 *
 * The edited file itself is the most precise anchor available (it is correct
 * even in multi-root workspaces, where workspace_roots[0] may be a different
 * project than the one being edited), so prefer its git root — the same
 * derive-the-repo-from-the-edited-file rule the Antigravity adapter uses.
 *
 * WORKING root, not canonical: getWorkingGitRoot keeps a linked worktree as
 * itself, where getGitRoot would collapse it to the main repo — and a session
 * running in a worktree stores its state under the worktree path, so
 * collapsing here would abort the hook all over again for that case.
 * handleSessionStart resolves in exactly this order.
 */
export function resolveAfterFileEditCwd(input: Record<string, any>): string {
  const rootOf = (dir: string): string | null => {
    try { return getWorkingGitRoot(dir) || getGitRoot(dir); } catch { return null; }
  };

  const filePath = normalizeWorkspaceRoot(input.file_path || input.path);
  if (filePath) {
    const fileRoot = rootOf(path.dirname(filePath));
    if (fileRoot) return fileRoot;
  }

  if (Array.isArray(input.workspace_roots)) {
    for (const raw of input.workspace_roots) {
      const wsRoot = normalizeWorkspaceRoot(raw);
      if (wsRoot) {
        const wsGitRoot = rootOf(wsRoot);
        if (wsGitRoot) return wsGitRoot;
      }
    }
  }

  return normalizeWorkspaceRoot(input.cwd) || process.cwd();
}

/**
 * Adopt prompts the hooks never announced, and bind the turn an edit landing
 * right now actually belongs to.
 *
 * Cursor fires no `beforeSubmitPrompt` for a message typed while the previous
 * turn is still generating: it folds that prompt into the RUNNING generation —
 * same `requestId`, no `turn_ended` line in the transcript, and no `stop` hook
 * for the turn it interrupted either. Session e2c3508a is the whole shape:
 * three prompts, two prompt-submit hooks, two stop hooks, and not one hook
 * between turn 2's last edit and turn 3's first.
 *
 * `state.prompts` therefore still ended in "generate some code" while Cursor
 * was writing turn 3's files, so `prompts.length - 1` named turn 2 for every
 * one of them. Turn 2's mapping got rebuilt into a window spanning BOTH turns
 * (7 files → 12), turn 3's edits went into the ledger under turn 2, and the
 * server's first-author-wins de-dup then had nothing left to give turn 3: it
 * rendered as a chat-only turn sitting directly above the 11-file commit it
 * had just made.
 *
 * The transcript is the only place that mid-turn prompt is recorded, and it is
 * the same list Stop reconciles against — adopting it here keeps the live path
 * and the Stop pass on ONE numbering. When it hasn't been flushed yet the
 * reconcile is a no-op and the counter's answer stands; growth only, never a
 * renumber.
 *
 * A turn discovered late also has nobody to have anchored its baseline, so we
 * anchor one now. The new turn's window starts HERE rather than at the
 * previous turn's shadow, which is what stops it re-claiming work already
 * attributed. The edit that revealed the boundary falls inside that shadow,
 * but the caller reads it against the OLD baseline and records it as edit-hook
 * evidence first, so it is not lost.
 */
export function adoptUnannouncedPrompts(
  state: SessionState,
  parsedPrompts: string[],
  anchorShadow: () => string | null,
  opts?: { now?: () => number; newId?: () => string },
): number {
  const before = state.prompts?.length || 0;
  const merged = reconcilePromptHistory(state.prompts, parsedPrompts);
  if (merged.length <= before) return before - 1;

  state.prompts = [...merged];
  const idx = merged.length - 1;

  // The turn that was open belonged to the prompt before this one; close it so
  // any later `currentTurnIndex` binds the turn we just found instead.
  if (before > 0) closeTurn(state, before - 1);

  const newId = opts?.newId || (() => `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`);
  if (!state.promptTurnIds) state.promptTurnIds = [];
  for (let i = before; i <= idx; i++) {
    if (!state.promptTurnIds[i]) state.promptTurnIds[i] = newId();
  }

  // Re-anchor ONLY when there was a previous turn to separate this one from.
  // With `before === 0` nothing has claimed the current baseline yet — the
  // session-start shadow IS this turn's start — and cutting a fresh one here
  // would silently discard everything the turn had already written before we
  // noticed it existed.
  const shadow = before > 0 ? anchorShadow() : null;
  if (shadow) {
    state.prePromptSha = shadow;
    state.prePromptDirtyFiles = [];
    recordPromptShadow(state, idx, shadow);
  }
  state.currentTurnStartedAt = (opts?.now || (() => Date.now()))();

  debugLog('after-file-edit', 'adopted prompt the hooks never announced', {
    from: before, to: idx, shadow: shadow ? shadow.slice(0, 12) : null,
  });
  return idx;
}

/**
 * The prompt list Cursor's own transcript records for this conversation, or
 * null when there is nothing readable to compare against.
 */
function cursorTranscriptPrompts(state: SessionState): string[] | null {
  try {
    const jsonl = (state.transcriptPath && fs.existsSync(state.transcriptPath))
      ? state.transcriptPath
      : findCursorTranscriptJsonl(state.agentSessionId || undefined);
    if (!jsonl) return null;
    const parsed = parseTranscript(jsonl, { repoRoots: sessionRepoRoots(state) });
    return parsed.prompts || null;
  } catch (err: unknown) {
    debugLog('after-file-edit', 'transcript prompt sync failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The `promptChanges` payload for a mid-turn (live-edit) PATCH.
 *
 * Every mapping is counted from ITS OWN diff. This used to derive a single
 * `linesAdded`/`linesRemoved` pair from `fullDiff` — the diff of the turn that
 * had just edited a file — and spread that one pair across EVERY mapping in
 * the list. The editing turn's row was right by luck (its diff IS fullDiff);
 * every earlier turn's row got line counts describing work it never did,
 * rewritten once per edit for as long as the session ran.
 *
 * That is a cross-turn write in the same family as the ones the server refuses
 * by turnId — except it travels inside a payload whose routing looks perfectly
 * healthy, because only the numbers are wrong.
 *
 * `countDiffLines` is the shared counter for exactly this reason (see its
 * comment in transcript-adapters): two different counters are how a row's line
 * totals and its own diff body drift permanently out of step.
 */
export function buildLiveEditPromptChanges(
  mappings: Array<Record<string, any>>,
): Array<Record<string, any>> {
  return (mappings || []).map((pm) => {
    const diff = (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN);
    const { linesAdded, linesRemoved } = countDiffLines(diff);
    return {
      ...pm,
      promptText: (pm.promptText || '').slice(0, 1000),
      diff,
      uncommittedDiff: (pm.uncommittedDiff || '').slice(0, MAX_PROMPT_DIFF_LEN),
      linesAdded,
      linesRemoved,
      aiPercentage: 100,
      checkpointType: 'auto',
    };
  });
}

// ─── Cursor: afterFileEdit ───────────────────────────────────────────────
//
// Fires after every Cursor edit (StrReplace / Write / etc.). Cursor's git
// commits don't reliably trigger the global post-commit hook (sandbox /
// worktree isolation), so user-prompt-submit's retroactive capture path
// runs against an empty working tree at next-prompt time and the dashboard
// shows "0 files" for the prompt. We work around that by capturing the
// working tree against the per-prompt shadow on every file edit — same
// content as the heartbeat's pushInflightDiff, but triggered by the edit
// event so it fires even when no shell commands have run.
async function handleAfterFileEdit(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('after-file-edit', 'begin', { cwd: input.cwd, file: input.file_path || input.path });

  const hookCwd = resolveAfterFileEditCwd(input);
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  if (!found) {
    debugLog('after-file-edit', 'ABORT: no session state', { hookCwd });
    return;
  }
  const { state, saveCwd } = found;
  if (!state.repoPath || !state.prePromptSha) {
    debugLog('after-file-edit', 'ABORT: missing repoPath or prePromptSha');
    return;
  }
  const announcedIdx = (state.prompts?.length || 0) - 1;
  // The baseline this edit's before-state must be read against: the turn that
  // was open when Cursor wrote the file, whether or not it is still the turn
  // we end up filing under. With no announced turn at all this is the session
  // start, which is the correct before-state for the first turn.
  const editBaseline = (state.promptShadows || []).find((s) => s.promptIndex === announcedIdx)?.shadowSha
    || state.prePromptSha;

  // Ask the transcript BEFORE giving up on the counter — see
  // adoptUnannouncedPrompts. Two different states land here with a counter
  // that can't name a turn: a prompt Cursor never announced (the counter is a
  // turn behind), and a state file that never received one at all. The second
  // is not hypothetical — when the auto-create path raced session-start into a
  // duplicate state file, `after-file-edit` resolved the EMPTY one and aborted
  // on 23 of 23 edits, taking the whole session's live capture with it.
  const parsedPrompts = cursorTranscriptPrompts(state);
  const promptIdx = parsedPrompts
    ? adoptUnannouncedPrompts(state, parsedPrompts, () => {
      const repo = state.repoPath!;
      try {
        if (getDirtyFiles(repo).length === 0) return getHeadSha(repo);
        return createShadowCommit(repo, `prompt-${state.sessionTag || state.sessionId.slice(0, 12)}`)
          || getHeadSha(repo);
      } catch { return null; }
    })
    : announcedIdx;
  if (promptIdx < 0) {
    debugLog('after-file-edit', 'ABORT: no current prompt', {
      announcedIdx, transcriptPrompts: parsedPrompts ? parsedPrompts.length : null,
    });
    return;
  }

  try {
    // Re-capture working tree against the per-prompt shadow so the current
    // prompt's mapping reflects whatever Cursor just wrote to disk.
    const promptShadow = (state.promptShadows || []).find((s) => s.promptIndex === promptIdx);
    const captureBaseline = promptShadow?.shadowSha || state.prePromptSha;

    // EVIDENCE, before the window runs.
    //
    // This hook names the exact file Cursor just wrote. That is proof — the
    // agent is telling us, not us deducing it from what happens to be dirty —
    // and until now the path was used only as an extra NAME appended to
    // filesChanged while the attribution still came from a whole-tree diff. So
    // a Cursor turn in a shared checkout picked up a sibling agent's work the
    // same way every other window-based turn did, despite having the one
    // signal that could have prevented it.
    //
    // Recorded first so the window below skips it as already covered.
    try {
      const edited = [input.file_path, input.path]
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => toRepoRelative(state.repoPath!, p))
        .filter((p) => p && !path.isAbsolute(p));
      if (edited.length > 0) {
        // `editBaseline`, not `captureBaseline`: when this edit is the one that
        // revealed a missed turn boundary, the new turn's shadow was cut a
        // moment ago with this write already in it, so reading the before-state
        // against it yields an empty delta. The turn that was open when Cursor
        // wrote the file is the tree this content actually changed.
        if (recordProbedShellEdits(state, state.repoPath, editBaseline, promptIdx, edited, {
          toolLabel: EDIT_HOOK_TOOL, evidence: 'edit_hook',
        })) {
          debugLog('after-file-edit', 'edit-hook evidence recorded', { files: edited });
        }
      }
    } catch (evErr: unknown) {
      debugLog('after-file-edit', 'edit-hook evidence failed (non-fatal)', {
        message: evErr instanceof Error ? evErr.message : String(evErr),
      });
    }
    // Persist the turn binding and the evidence NOW, not only alongside a
    // mapping. The window below is empty for the FIRST edit of a turn we just
    // discovered — that write is already inside the shadow we cut for it — and
    // the old "no diff, skip" return would have thrown the discovery away, so
    // the next edit would rediscover the same boundary and cut another shadow
    // over it, forever.
    saveSessionState(state, saveCwd, state.sessionTag);

    const capture = captureGitState(state.repoPath, captureBaseline, { fullContext: true });

    const filteredUncommitted = filterUncommittedDiff(
      capture.uncommittedDiff || '', uncommittedExcludeUnion(state),
    );
    // Windowed to the turn's own shadow, like the capture directly above.
    // Unwindowed, this mid-turn write replayed every commit the session had
    // made: prod 192cdf12 turn 3 was sent as 13 files / +244 -4 — its own
    // +125 plus turn 1's committed +119 — and the Stop that followed just
    // re-sent that mapping.
    const sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state, captureBaseline);
    const fullDiff = (sessionCommitted + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
    if (!fullDiff) {
      debugLog('after-file-edit', 'no diff against shadow, skipping');
      return;
    }

    const filesChanged = new Set<string>();
    for (const m of fullDiff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
      if (m[1]) filesChanged.add(m[1]);
    }
    // Filesystem path the hook reported, if any — useful when the diff lags.
    if (typeof input.file_path === 'string') filesChanged.add(input.file_path);
    if (typeof input.path === 'string') filesChanged.add(input.path);

    let commitSha: string | null = null;
    let treeSha: string | null = null;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { /* ignore */ }

    if (!state.completedPromptMappings) state.completedPromptMappings = [];
    const promptText = (state.prompts?.[promptIdx] || '').slice(0, 1000);
    const mapping = {
      promptIndex: promptIdx,
      promptText,
      filesChanged: Array.from(filesChanged),
      diff: fullDiff.slice(0, 200_000),
      uncommittedDiff: filteredUncommitted.slice(0, 200_000),
      commitSha,
      treeSha,
    };
    const existingIdx = state.completedPromptMappings.findIndex((m) => m.promptIndex === promptIdx);
    if (existingIdx >= 0) {
      state.completedPromptMappings[existingIdx] = mapping;
    } else {
      state.completedPromptMappings.push(mapping);
    }
    saveSessionState(state, saveCwd, state.sessionTag);
    debugLog('after-file-edit', 'updated mapping', {
      promptIndex: promptIdx,
      filesChanged: filesChanged.size,
      diffLen: fullDiff.length,
    });

    // Push to API immediately so the dashboard reflects the edit without
    // waiting for the next heartbeat tick.
    if (isConnectedMode() && state.sessionId) {
      try {
        await api.updateSession(state.sessionId, {
          promptChanges: buildLiveEditPromptChanges(state.completedPromptMappings),
          status: 'RUNNING',
        });
        debugLog('after-file-edit', 'api updated');
      } catch (apiErr: any) {
        debugLog('after-file-edit', 'api update failed (non-fatal)', { message: apiErr?.message });
      }
    }
  } catch (err: any) {
    debugLog('after-file-edit', 'capture failed (non-fatal)', { message: err?.message });
  }
}

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
function isNullRef(ref: string): boolean {
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

    const { handlePostCheckout } = await import('../history-preservation.js');
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

// Map finding type names to API types
function mapFindingType(name: string): string {
  const map: Record<string, string> = {
    'AWS Access Key': 'AWS_SECRET', 'AWS Secret Key': 'AWS_SECRET',
    'Private Key': 'PRIVATE_KEY', 'GitHub Token': 'API_KEY', 'GitHub PAT': 'API_KEY',
    'OpenAI Key': 'API_KEY', 'Anthropic Key': 'API_KEY', 'Stripe Key': 'API_KEY',
    'Slack Token': 'API_KEY', 'JWT Token': 'JWT_TOKEN',
    'Connection String': 'CONNECTION_STRING', 'API Key': 'API_KEY',
    'Hardcoded Password': 'PASSWORD', 'npm Token': 'API_KEY', 'Bearer Token': 'API_KEY',
  };
  return map[name] || 'GENERIC_SECRET';
}

function mapFindingSeverity(name: string): string {
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
export { isNonSecretAssignmentValue } from '../secret-rules.js';

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
function matchGlobPreCommit(pattern: string, filepath: string): boolean {
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
function parseStagedDiffLines(diff: string): Array<{ file: string; line: number; content: string }> {
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

/**
 * Pick the single active session for this commit.
 * Mirrors the logic in handlePostCommit — kept separate to avoid coupling
 * that function's many other responsibilities.
 */
// Auto-close zombie sessions on the SERVER too (the local ENDED mark happens
// lazily in listSessionsForGitHook). Best-effort: any non-alive session in the
// repo gets marked ENDED on disk and ended on the dashboard. Only fires a
// network call for sessions that were actually stale (usually zero).
async function expireStaleSessionsOnServer(repoPath: string): Promise<void> {
  try {
    for (const s of listActiveSessions(repoPath)) {
      if (isSessionAlive(s)) continue;
      if (markSessionEnded(s)) {
        try { await api.endSessionById(s.sessionId); } catch { /* unknown id / offline — local mark still applied */ }
      }
    }
  } catch { /* non-fatal */ }
}

// Files staged for the in-flight commit — the ground truth for "what is being
// committed", used to attribute the commit to the session that produced them.
function stagedCommitFiles(repoPath: string): string[] {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only'], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }
}

// The set of files a session changed — from its recorded per-prompt mappings
// and/or a name-only diff against its baseline (the session-start shadow, or
// the session-start HEAD). Used to match a commit to the session that made it.
function sessionTouchedFiles(state: SessionState, repoPath: string): Set<string> {
  const files = new Set<string>();
  // Prefer the precise per-session file list the agent's own capture recorded.
  for (const pm of (state.completedPromptMappings || [])) {
    for (const f of (pm?.filesChanged || [])) if (typeof f === 'string') files.add(f);
  }
  if (files.size > 0) return files;
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
      const scored = activeSessions
        .map((s) => {
          const touched = sessionTouchedFiles(s, s.repoPath || hookCwd);
          let overlap = 0;
          for (const f of staged) if (touched.has(f)) overlap++;
          return { s, overlap };
        })
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap);
      // Clear winner only: the best overlap must strictly beat the runner-up,
      // so a tie falls through to process detection rather than guessing.
      if (scored.length === 1 || (scored.length > 1 && scored[0].overlap > scored[1].overlap)) {
        debugLog('prepare-commit-msg', 'attributed by staged-file overlap', {
          session: scored[0].s.sessionId.slice(0, 12), overlap: scored[0].overlap, staged: staged.size,
        });
        return scored[0].s;
      }
    }
  } catch { /* fall through to process detection */ }

  // Multiple sessions — disambiguate via process detection.
  const agentChecks = attributionPgrepChecks();
  for (const check of agentChecks) {
    try {
      if (safePgrep(check.cmd)) {
        const match = activeSessions.find((s) => sessionMatchesAgent(s, check.slug));
        if (match) return match;
      }
    } catch { /* no match */ }
  }
  // Ambiguous — don't guess.
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
      execFileSync('git', ['push', 'origin', 'origin-sessions', '--no-verify', '--quiet'], execOpts);
      debugLog('pre-push', 'pushed origin-sessions');
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

// ─── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Self-heal duplicate Origin hook registrations across settings layers.
 *
 * Claude Code merges hooks from ~/.claude/settings.json (user) with
 * <cwd>/.claude/settings.json and ancestor directories. When `origin enable`
 * was run at multiple layers, the same `origin hooks claude-code <event>`
 * command ended up registered in both — and Claude fired the hook once per
 * registration. Every API call doubled, every state-file write doubled,
 * every heartbeat doubled. We saw the symptom as consecutive-PID twin
 * invocations on every event in ~/.origin/hooks.log.
 *
 * Resolution: user-level wins (broader scope, what `origin enable` defaults
 * to). If the local layer also has Origin hooks, strip them and write the
 * file back. Idempotent — once cleaned, subsequent invocations skip the
 * write. Claude won't re-read settings.json mid-session, so the current
 * conversation still doubles; the next session-start picks up the cleaned
 * config.
 */
function dedupeOriginHookLayers(event: string): void {
  const userSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  // Read user-level. Bail unless it has Origin hooks — without a user-level
  // registration there's nothing to dedupe against.
  let userHasOrigin = false;
  try {
    const raw = fs.readFileSync(userSettingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    userHasOrigin = settingsHaveOriginClaudeHooks(parsed);
  } catch { /* user file missing or unreadable — skip dedupe */ }
  if (!userHasOrigin) return;

  // Walk up from cwd looking for .claude/settings.json files at the project
  // root and any intermediate worktree. Cap at 8 levels — repos don't nest
  // deeper than that in practice and infinite-loop protection is cheap.
  const visited = new Set<string>();
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (visited.has(dir)) break;
    visited.add(dir);
    const localSettingsPath = path.join(dir, '.claude', 'settings.json');
    if (localSettingsPath !== userSettingsPath && fs.existsSync(localSettingsPath)) {
      try {
        const raw = fs.readFileSync(localSettingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (settingsHaveOriginClaudeHooks(parsed)) {
          stripOriginClaudeHooksFromSettings(parsed);
          fs.writeFileSync(localSettingsPath, JSON.stringify(parsed, null, 2) + '\n');
          debugLog(event, 'AUTO-DEDUPED Origin hooks from local settings (user-level kept)', {
            removedFrom: localSettingsPath,
          });
        }
      } catch { /* unreadable — leave alone, user can fix manually */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function settingsHaveOriginClaudeHooks(parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object' || !parsed.hooks) return false;
  for (const event of Object.keys(parsed.hooks)) {
    const entries = parsed.hooks[event];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry?.hooks || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (typeof h?.command === 'string' && h.command.includes('origin hooks claude-code')) {
          return true;
        }
      }
    }
  }
  return false;
}

function stripOriginClaudeHooksFromSettings(parsed: any): void {
  if (!parsed?.hooks) return;
  for (const event of Object.keys(parsed.hooks)) {
    const entries = parsed.hooks[event];
    if (!Array.isArray(entries)) continue;
    parsed.hooks[event] = entries.filter((entry: any) => {
      if (!entry?.hooks || !Array.isArray(entry.hooks)) return true;
      return !entry.hooks.some((h: any) =>
        typeof h?.command === 'string' && h.command.includes('origin hooks claude-code')
      );
    });
    // Drop the event key entirely when nothing else lives there — keeps
    // settings.json clean rather than leaving { "SessionStart": [] }.
    if (parsed.hooks[event].length === 0) {
      delete parsed.hooks[event];
    }
  }
}

/**
 * Self-heal for agents whose hook config is a flat JSON file at a known path.
 * Cursor / Windsurf use .cursor/hooks.json and .windsurf/hooks.json respectively.
 * Both files use the same schema: { version, hooks: { eventName: [{command}] } }
 * The dedup logic is simpler than Claude's layered settings: we check if BOTH the
 * user-level file (~/<dir>/hooks.json) AND a project-level file (./<dir>/hooks.json)
 * contain Origin commands for the same agent. If so, strip the project-level copy
 * (user-level wins, same rationale as the Claude dedupe).
 */
function dedupeAgentFlatHooks(event: string, agentDir: string, agentSlug: string): void {
  const userHooksPath = path.join(os.homedir(), agentDir, 'hooks.json');
  const originCmdSubstring = `origin hooks ${agentSlug}`;

  let userHasOrigin = false;
  try {
    const raw = fs.readFileSync(userHooksPath, 'utf-8');
    const parsed = JSON.parse(raw);
    userHasOrigin = flatHooksHaveOriginCommand(parsed, originCmdSubstring);
  } catch { return; }
  if (!userHasOrigin) return;

  // Walk cwd → root looking for project-level copies.
  const visited = new Set<string>();
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (visited.has(dir)) break;
    visited.add(dir);
    const localPath = path.join(dir, agentDir, 'hooks.json');
    if (localPath !== userHooksPath && fs.existsSync(localPath)) {
      try {
        const raw = fs.readFileSync(localPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (flatHooksHaveOriginCommand(parsed, originCmdSubstring)) {
          stripFlatHooksOriginCommand(parsed, originCmdSubstring);
          fs.writeFileSync(localPath, JSON.stringify(parsed, null, 2) + '\n');
          debugLog(event, `AUTO-DEDUPED ${agentSlug} hooks from local file (user-level kept)`, {
            removedFrom: localPath,
          });
        }
      } catch { /* unreadable — skip */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function flatHooksHaveOriginCommand(parsed: any, substring: string): boolean {
  if (!parsed?.hooks || typeof parsed.hooks !== 'object') return false;
  for (const entries of Object.values(parsed.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const h of entries) {
      if (typeof h?.command === 'string' && h.command.includes(substring)) return true;
    }
  }
  return false;
}

function stripFlatHooksOriginCommand(parsed: any, substring: string): void {
  if (!parsed?.hooks) return;
  for (const eventName of Object.keys(parsed.hooks)) {
    const entries = parsed.hooks[eventName];
    if (!Array.isArray(entries)) continue;
    parsed.hooks[eventName] = entries.filter(
      (h: any) => !(typeof h?.command === 'string' && h.command.includes(substring))
    );
    if (parsed.hooks[eventName].length === 0) delete parsed.hooks[eventName];
  }
}

// ── Antigravity (agy) capture ─────────────────────────────────────────────
// agy doesn't fit the SessionStart→prompts→Stop model: it only fires Stop /
// PreToolUse / PostToolUse, and the payload carries a stable `conversationId`,
// `workspacePaths`, and a `transcriptPath` to a full JSONL transcript. So we
// run a self-contained path: ensure a server session (deduped by
// conversationId), parse the transcript for prompts + the real model, estimate
// usage (agy exposes no token counts), and sync. Stop finalizes.
// Per-conversation cache of the server's enforcement rules + budget lock, so
// PreToolUse can decide allow/deny WITHOUT a network round-trip on every tool
// call. Written on each post-tool-use/stop (when we talk to the server anyway).
function agyRulesCachePath(conversationId: string): string {
  return path.join(os.homedir(), '.origin', 'agy-rules', `${conversationId}.json`);
}
interface AgyRulesCache {
  enforcementRules?: any[]; budgetBlocked?: boolean; budgetMessage?: string;
  repoPath?: string; transcriptPath?: string; baselineSha?: string;
  // The WORKING git root (for an agy worktree session this is the worktree,
  // not the canonical repo `repoPath` points at). Every git capture operation
  // — baseline shadow, working-tree snapshot, diff, commit detection — must run
  // here or it reads a tree the session never touched. See deriveAgyRoots.
  workRoot?: string;
  // Per-prompt diff baselines: promptBaselines[i] is a shadow of the tree as it
  // was at the START of prompt i, so prompt i's diff = its OWN changes (not the
  // cumulative session diff). `lastSyncShadow` is the rolling end-of-work
  // snapshot used as the next prompt's baseline.
  promptBaselines?: Record<number, string>;
  lastSyncShadow?: string;
  // When this conversation last ran agy's stand-in for session-start (notes
  // sync + rules-file refresh). Presence is the once-per-conversation guard;
  // the timestamp is for debugging a refresh that appears not to have happened.
  contextRefreshedAt?: string;
  // Prompt indices that made uncommitted changes. When a later prompt commits
  // everything at once, the commit swept up ALL of their work, so they all get
  // linked to that commit (the "prompts in this commit" set).
  dirtyPromptIndices?: number[];
  // Last commit SHA this session already ingested to the server. agy ingests
  // detected commits itself (the sandboxed agent often disables the git
  // post-commit hook), and its post-tool-use hook fires many times per turn —
  // this skips re-ingesting the same commit on every fire.
  ingestedCommitSha?: string;
  // Subjects of the commits this session has made, accumulated across fires.
  // The heuristic memory summary is built from these (the commit messages
  // describe the actual work far better than a vague opening prompt).
  commitSubjects?: string[];
  // Per-prompt mappings captured while the API was UNREACHABLE, waiting to be
  // flushed on the next fire that reaches the server.
  //
  // Capture is entirely local (git plumbing against a shadow baseline) but the
  // handler used to `return` the moment startSession threw, so a network blip
  // meant those turns were never captured AND their baseline never advanced —
  // the next reachable turn then diffed against the pre-blip tree and claimed
  // every intervening prompt's work as its own. Observed live: a 15-minute
  // outage across turn 1 left it empty and credited all 103 of its lines to
  // turn 2, which had actually changed one line.
  pendingPromptChanges?: Array<Record<string, any>>;
}
function writeAgyRulesCache(conversationId: string, data: AgyRulesCache): void {
  try {
    const p = agyRulesCachePath(conversationId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  } catch { /* non-fatal */ }
}
function readAgyRulesCache(conversationId: string): AgyRulesCache | null {
  try { return JSON.parse(fs.readFileSync(agyRulesCachePath(conversationId), 'utf-8')); } catch { return null; }
}

// A conversation's cache used to be deleted on Stop, back when Stop meant the
// agy process had exited. It no longer does (see the stop branch), so the cache
// has to be aged out instead: a conversation untouched for this long is not
// coming back, and its baselines point at shadow commits git has long since
// been free to GC. Cheap enough to run on every Stop — one readdir over a
// directory that holds one small json per conversation.
const AGY_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
function pruneAgyRulesCaches(): void {
  try {
    const dir = path.dirname(agyRulesCachePath('x'));
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > AGY_CACHE_MAX_AGE_MS) fs.rmSync(full, { force: true });
      } catch { /* skip this one */ }
    }
  } catch { /* no dir yet — nothing to prune */ }
}

// Cap on the offline queue so a long outage can't grow the cache file without
// bound. 50 turns is far past any realistic blip; beyond it the OLDEST are
// dropped, since the newest turns are the ones a reviewer is still looking at.
const MAX_PENDING_PROMPT_CHANGES = 50;

/**
 * Merge freshly-captured per-prompt mappings into the offline pending queue.
 *
 * agy's PostToolUse fires many times within a single turn, so the same
 * promptIndex gets captured repeatedly while the API is unreachable. The LAST
 * capture of a turn is the most complete (it has seen the most edits), so
 * incoming normally wins — except when it is EMPTY and we already hold a real
 * one. Mid-turn the working tree can momentarily match the baseline (the agent
 * reverts a file, then rewrites it), and letting that transient empty capture
 * overwrite a real diff would recreate exactly the gap this queue exists to
 * close.
 *
 * Pure + exported for testing.
 */
export function mergePendingPromptChanges(
  existing: Array<Record<string, any>> | undefined,
  incoming: Array<Record<string, any>>,
): Array<Record<string, any>> {
  const byIndex = new Map<number, Record<string, any>>();
  for (const pc of existing || []) {
    if (pc && typeof pc.promptIndex === 'number') byIndex.set(pc.promptIndex, pc);
  }
  for (const pc of incoming || []) {
    if (!pc || typeof pc.promptIndex !== 'number') continue;
    const prev = byIndex.get(pc.promptIndex);
    const incomingEmpty = !((pc.filesChanged || []).length);
    const prevHasWork = !!prev && !!((prev.filesChanged || []).length);
    if (incomingEmpty && prevHasWork) continue;
    byIndex.set(pc.promptIndex, pc);
  }
  return [...byIndex.values()]
    .sort((a, b) => (a.promptIndex as number) - (b.promptIndex as number))
    .slice(-MAX_PENDING_PROMPT_CHANGES);
}

// agy's Stop event fires only on exit and may carry a minimal payload (no
// conversationId / transcriptPath). To still finalize the session — and capture
// any trailing prompt that triggered no tool call (so PostToolUse never fired) —
// recover the most-recently-active conversation from the on-disk brain dir.
function discoverLatestAgyConversation(): { conversationId: string; transcriptPath: string } | null {
  // Antigravity's brain dir moved between versions: newer builds write to
  // ~/.gemini/antigravity/brain, older ones to ~/.gemini/antigravity-cli/brain.
  // Scan both, and prefer transcript_full.jsonl but accept transcript.jsonl.
  const brainDirs = [
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
  ];
  let best: { conversationId: string; transcriptPath: string; mtime: number } | null = null;
  for (const brainDir of brainDirs) {
    let cids: string[];
    try { cids = fs.readdirSync(brainDir); } catch { continue; }
    for (const cid of cids) {
      const logs = path.join(brainDir, cid, '.system_generated', 'logs');
      for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
        const tp = path.join(logs, name);
        let st: fs.Stats;
        try { st = fs.statSync(tp); } catch { continue; }
        if (!best || st.mtimeMs > best.mtime) best = { conversationId: cid, transcriptPath: tp, mtime: st.mtimeMs };
        break; // prefer _full; don't double-count the same conversation
      }
    }
  }
  return best ? { conversationId: best.conversationId, transcriptPath: best.transcriptPath } : null;
}

// agy tool-call args use PascalCase, varying by tool (run_command →
// CommandLine; file tools → TargetFile/FilePath/AbsolutePath/Path). Pull the
// file path (for FILE_RESTRICTION) and the command (for command policies).
export function agyToolPaths(toolCall: any): { filePath: string | null; command: string | null } {
  // agyArgs() strips agy's double-JSON-encoding. Reading toolCall.args raw
  // yields `"\"/abs/path\""`, whose leading quote defeats both path.isAbsolute
  // and the FILE_RESTRICTION glob (which anchors on `$`) — so every policy
  // silently allowed every real agy write.
  const args = agyArgs(toolCall);
  const fileKeys = ['TargetFile', 'FilePath', 'AbsolutePath', 'Path', 'file', 'path', 'file_path'];
  let filePath: string | null = null;
  for (const k of fileKeys) {
    if (typeof args[k] === 'string' && args[k]) { filePath = args[k]; break; }
  }
  const command = typeof args.CommandLine === 'string' ? args.CommandLine : null;
  return { filePath, command };
}

export function agyGlobToRegex(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`(^|/)${esc}$`);
}

// Decide allow/deny for an agy PreToolUse against cached rules. Budget lock
// blocks everything; FILE_RESTRICTION blocks edits to matching paths.
export function agyEvaluatePreTool(toolCall: any, cache: { enforcementRules?: any[]; budgetBlocked?: boolean; budgetMessage?: string } | null): { decision: 'allow' | 'deny'; reason?: string } {
  if (!cache) return { decision: 'allow' };
  if (cache.budgetBlocked) {
    return { decision: 'deny', reason: cache.budgetMessage || 'Origin: budget cap reached — session is locked.' };
  }
  const { filePath } = agyToolPaths(toolCall);
  if (filePath) {
    const base = filePath.split('/').pop() || filePath;
    for (const rule of cache.enforcementRules || []) {
      if (rule?.type !== 'FILE_RESTRICTION' || rule?.action !== 'block') continue;
      let cond: any = {};
      try { cond = JSON.parse(rule.condition || '{}'); } catch { /* ignore */ }
      const pattern = cond.path;
      if (typeof pattern !== 'string' || !pattern) continue;
      const re = agyGlobToRegex(pattern);
      if (re.test(filePath) || re.test(base)) {
        return { decision: 'deny', reason: `Origin policy "${rule.policyName || 'file restriction'}" blocks editing ${base} (${pattern}).` };
      }
    }
  }
  return { decision: 'allow' };
}

// agy fires no "turn complete" event, so trailing output generated AFTER the
// last tool call (a final answer, or a no-tool prompt) isn't synced until the
// next tool call or agy exit. A short-lived detached watcher closes that gap:
// after a tool call it polls the transcript until it goes quiet, then re-syncs.
// Poll cadence: fast while a turn is in flight, slow once idle (the process
// just sleeps + stats a file, so even an all-day session is negligible).
const AGY_WATCH_POLL_ACTIVE_MS = 1500;
const AGY_WATCH_POLL_IDLE_MS = 5000;
const AGY_WATCH_ACTIVE_WINDOW_MS = 60_000; // "active" = a transcript change within the last minute
const AGY_WATCH_STABLE_MS = 5000;          // file quiet this long → a turn settled
// The watcher lives until the turn closes: agy's Stop drops a `.done` sentinel,
// and the watcher drains whatever landed after Stop's own read before exiting
// (the next turn's PostToolUse spawns another). On older agy builds — which fire
// Stop only when the process exits — the same watcher covers the whole session,
// so trailing read-only prompts are caught no matter how long the user idles.
// The idle backstop only fires if agy died WITHOUT any Stop (crash / kill) —
// long enough that a normal think-pause never trips it. A hard cap bounds a
// truly stuck watcher.
const AGY_WATCH_IDLE_BACKSTOP_MS = 4 * 60 * 60 * 1000; // 4h with zero transcript activity → assume agy is gone
const AGY_WATCH_MAX_MS = 12 * 60 * 60 * 1000;          // 12h absolute ceiling
const AGY_WATCH_LOCK_FRESH_MS = 15_000; // a live watcher refreshes its lock every poll; older than this = dead → respawn

function agyWatchLockPath(cid: string): string {
  return path.join(os.homedir(), '.origin', 'agy-watch', `${cid}.lock`);
}
// Sentinel written by the Stop hook so the watcher knows the turn closed and can
// exit promptly instead of waiting out the idle backstop.
function agyWatchDonePath(cid: string): string {
  return path.join(os.homedir(), '.origin', 'agy-watch', `${cid}.done`);
}

function spawnAgyWatcher(cid: string, repoPath: string, transcriptPath: string): void {
  try {
    if (process.env.ORIGIN_AGY_IS_WATCHER) return;        // never recurse from the watcher's own re-sync
    if (!cid || !transcriptPath) return;
    const lock = agyWatchLockPath(cid);
    try {
      const st = fs.statSync(lock);
      // A live watcher refreshes its lock every poll; a fresh lock means one is
      // already covering this conversation. A stale lock (crashed watcher) is
      // ignored so a new one respawns promptly.
      if (Date.now() - st.mtimeMs < AGY_WATCH_LOCK_FRESH_MS) return;
    } catch { /* no lock → spawn */ }
    const bin = process.argv[1];
    if (!bin) return;
    const child = spawn(process.execPath, [bin, 'hooks', 'antigravity', '__watch'], {
      detached: true,
      stdio: 'ignore',
      // See the heartbeat spawn in session-state.ts — without this a detached
      // console app pops its own terminal window on Windows.
      windowsHide: true,
      env: {
        ...process.env,
        ORIGIN_AGY_IS_WATCHER: '1',
        ORIGIN_AGY_WATCH_CID: cid,
        ORIGIN_AGY_WATCH_REPO: repoPath,
        ORIGIN_AGY_WATCH_TRANSCRIPT: transcriptPath,
      },
    });
    child.unref();
    debugLog('post-tool-use', 'antigravity watcher spawned', { cid });
  } catch (err: any) {
    debugLog('post-tool-use', 'antigravity watcher spawn failed (non-fatal)', { message: err?.message });
  }
}

/**
 * The durable, session-independent half of Origin's preamble, for a rules file
 * written outside any session — agy's refresh below, and `origin enable`.
 *
 * Deliberately NOT the same text handleSessionStart writes. That message is
 * assembled from live session state (budget banners, the server's active-policy
 * list, the agent's own system prompt); none of it exists here, and inventing
 * placeholders for it would put stale claims in a checked-in file. What is left
 * is what a rules file is actually for: the tracking notice, the repo-context
 * section including the startup directive, and the authoring framework.
 *
 * `omitRepoContext` drops the volatile half for the agents that receive it over
 * the hook channel on every turn (see agentReadsContextFromHook) — the same
 * subtraction durableRulesFileMessage performs at session start, and for the
 * same reason: an always-loaded rules file that repeats what the hook just
 * delivered makes one digest arrive twice per turn, forever.
 */
export function buildDurableContextMessage(repoPath: string, omitRepoContext = false): string {
  const safeCtx = (fn: () => string | null): string | null => { try { return fn(); } catch { return null; } };
  let msg = 'Origin: Session tracking active — prompts, files, and tokens will be captured.';
  if (!isConnectedMode()) msg += ' (standalone mode)';
  const repoContext = omitRepoContext ? null : assembleRepoContext({
    brief: safeCtx(() => buildRepoBriefContext(repoPath)),
    attribution: safeCtx(() => buildAttributionContext(repoPath)),
    memory: safeCtx(() => buildMemoryBriefContext(repoPath)) || safeCtx(() => buildMemoryContext(repoPath)),
    memoryPointer: safeCtx(() => buildMemoryPointerContext(repoPath)),
    handoff: safeCtx(() => buildHandoffContext(repoPath)),
    startupCheck: safeCtx(() => buildStartupCheckContext(repoPath)),
  });
  if (repoContext) msg += '\n\n' + repoContext;
  msg += '\n\n' + buildOriginFrameworkGuidance();
  return msg;
}

function spawnAgyContextRefresh(repoPath: string): void {
  try {
    if (process.env.ORIGIN_AGY_IS_WATCHER) return;   // the watcher must not re-spawn chores
    if (!repoPath) return;
    const bin = process.argv[1];
    if (!bin) return;
    const child = spawn(process.execPath, [bin, 'hooks', 'antigravity', '__refresh-context'], {
      detached: true,
      stdio: 'ignore',
      // Same reason as the watcher spawn: without this a detached console app
      // pops its own terminal window on Windows.
      windowsHide: true,
      env: { ...process.env, ORIGIN_AGY_IS_WATCHER: '1', ORIGIN_AGY_REFRESH_REPO: repoPath },
    });
    child.unref();
    debugLog('pre-tool-use', 'antigravity context refresh spawned', { repoPath });
  } catch (err: any) {
    debugLog('pre-tool-use', 'antigravity context refresh spawn failed (non-fatal)', { message: err?.message });
  }
}

/**
 * Refresh entrypoint (`origin hooks antigravity __refresh-context`). Runs
 * detached, reads its target from env like the watcher does, and does the two
 * session-start chores agy never gets: pull the remote notes down (and fold any
 * left staged by a killed post-checkout), then rewrite the Origin block in the
 * repo's agent rules files from what those notes now say.
 */
async function runAgyContextRefresh(): Promise<void> {
  const repoPath = process.env.ORIGIN_AGY_REFRESH_REPO || '';
  if (!repoPath) return;
  try {
    syncNotesForSessionStart(repoPath);
  } catch {
    // Non-fatal — the refresh below still writes whatever notes are local.
  }
  try {
    const msg = buildDurableContextMessage(repoPath);
    // 'antigravity' targets AGENTS.md; writeAgentRulesFile's second pass also
    // refreshes any OTHER origin-managed file already in the repo, so an agy
    // session now keeps its siblings current too — the reciprocal of agy having
    // depended on their sessions for its own block.
    writeAgentRulesFile('antigravity', msg, repoPath);
    debugLog('__refresh-context', 'antigravity rules files refreshed', { repoPath, length: msg.length });
  } catch (err: any) {
    debugLog('__refresh-context', 'refresh failed (non-fatal)', { message: err?.message });
  }
}

// Watcher entrypoint (run as a detached `origin hooks antigravity __watch`).
// Polls the transcript so trailing prompts that fire no hook — including a
// read-only prompt sent after a long idle — are still synced. Exits once agy
// fires Stop (drops a `.done` sentinel), after one final drain, or after a long
// idle backstop / hard cap if agy died without ever firing one.
async function runAgyWatcher(): Promise<void> {
  const cid = process.env.ORIGIN_AGY_WATCH_CID || '';
  const repoPath = process.env.ORIGIN_AGY_WATCH_REPO || '';
  const transcriptPath = process.env.ORIGIN_AGY_WATCH_TRANSCRIPT || '';
  if (!cid || !transcriptPath) return;
  if (!isConnectedMode()) return;
  const lock = agyWatchLockPath(cid);
  const donePath = agyWatchDonePath(cid);
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    try { fs.rmSync(donePath, { force: true }); } catch { /* stale sentinel from a prior run */ }
    fs.writeFileSync(lock, String(process.pid));
  } catch { /* non-fatal */ }

  const started = Date.now();
  let lastMtime = -1;
  let lastChange = Date.now();
  let syncedMtime = -2;
  try { lastMtime = fs.statSync(transcriptPath).mtimeMs; } catch { /* file may not exist yet */ }

  try {
    while (Date.now() - started < AGY_WATCH_MAX_MS) {
      const idleNow = Date.now() - lastChange;
      const pollMs = idleNow < AGY_WATCH_ACTIVE_WINDOW_MS ? AGY_WATCH_POLL_ACTIVE_MS : AGY_WATCH_POLL_IDLE_MS;
      await new Promise((r) => setTimeout(r, pollMs));
      try { fs.utimesSync(lock, new Date(), new Date()); } catch { /* ignore — keeps the lock "live" for concurrent spawns */ }

      // A turn just closed (Stop hook). Stop captured the transcript as it stood
      // when the hook fired; anything agy wrote in the moments after — the tail
      // of a final answer — would otherwise wait for the next turn. Let the file
      // settle, flush it if it grew, then exit. The next turn's PostToolUse
      // spawns a fresh watcher.
      if (fs.existsSync(donePath)) {
        await new Promise((r) => setTimeout(r, AGY_WATCH_STABLE_MS));
        let post = -1;
        try { post = fs.statSync(transcriptPath).mtimeMs; } catch { /* transcript gone */ }
        if (post !== -1 && post !== syncedMtime) {
          try {
            await handleAntigravity('post-tool-use', { conversationId: cid, workspacePaths: [repoPath], transcriptPath });
            debugLog('__watch', 'antigravity post-stop trailing sync', { cid });
          } catch { /* non-fatal */ }
        }
        debugLog('__watch', 'antigravity watcher exiting — turn closed', { cid });
        break;
      }

      let m = -1;
      try { m = fs.statSync(transcriptPath).mtimeMs; } catch { /* transcript gone */ }

      if (m !== lastMtime) { lastMtime = m; lastChange = Date.now(); continue; } // still being written

      const idleFor = Date.now() - lastChange;
      if (idleFor >= AGY_WATCH_STABLE_MS && syncedMtime !== m) {
        // Settled on new content → re-sync the turn (post-tool-use keeps it RUNNING).
        try {
          await handleAntigravity('post-tool-use', { conversationId: cid, workspacePaths: [repoPath], transcriptPath });
          debugLog('__watch', 'antigravity trailing sync', { cid });
        } catch { /* non-fatal */ }
        syncedMtime = m;
      }
      // Backstop: no transcript activity for hours → agy likely died without a
      // clean Stop. Exit; the next tool call respawns a watcher if it's alive.
      if (idleFor >= AGY_WATCH_IDLE_BACKSTOP_MS) break;
    }
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(donePath, { force: true }); } catch { /* ignore */ }
  }
}

// Write a SessionState file for an agy conversation so the git-hook
// commit-attribution path treats Antigravity as a first-class session. The
// baseline shadow is stored as `sessionStartShadowSha` so staged-file matching
// can credit the session that actually produced the committed files. Always
// RUNNING — agy gives no exit event to end it on (its Stop is a turn boundary),
// so liveness is left to the state file's own mtime.
function registerAgySessionState(opts: {
  serverSessionId: string;
  conversationId: string;
  repoPath: string;
  // Working tree the turn ran in (the agy worktree, when there is one). The
  // git-hook attribution path matches a commit's cwd against `lastCwd`, so a
  // worktree commit only finds this session if lastCwd is the worktree.
  workRoot?: string;
  model: string;
  baselineSha?: string;
  transcriptPath: string;
  prompts: string[];
  filesChanged: string[];
}): void {
  try {
    const tag = `agy-${opts.conversationId.slice(0, 12)}`;
    const existing = loadSessionState(opts.repoPath, tag);
    const now = new Date().toISOString();
    // Accumulate the set of files this session has touched across syncs, so
    // staged-file matching credits this session for its own commit.
    const touched = new Set<string>(opts.filesChanged);
    for (const pm of (existing?.completedPromptMappings || [])) {
      for (const f of (pm?.filesChanged || [])) if (typeof f === 'string') touched.add(f);
    }
    const state = {
      ...(existing || {}),
      sessionId: opts.serverSessionId,
      agentSessionId: opts.conversationId,
      claudeSessionId: opts.conversationId,
      transcriptPath: opts.transcriptPath,
      model: opts.model,
      agentSlug: 'antigravity',
      repoPath: opts.repoPath,
      lastCwd: opts.workRoot || opts.repoPath,
      sessionTag: tag,
      startedAt: existing?.startedAt || now,
      headShaAtStart: existing?.headShaAtStart ?? null,
      sessionStartShadowSha: opts.baselineSha || existing?.sessionStartShadowSha || null,
      prompts: opts.prompts,
      completedPromptMappings: touched.size > 0 ? [{ promptIndex: 0, promptText: opts.prompts[0] || '', filesChanged: [...touched] }] : (existing?.completedPromptMappings || []),
      status: 'RUNNING',
    } as unknown as SessionState;
    saveSessionState(state, opts.repoPath, tag);
  } catch (err: any) {
    debugLog('antigravity', 'registerAgySessionState failed (non-fatal)', { message: err?.message });
  }
}

// Detect commits the agy session made since its baseline, so a committed turn
// shows as committed (with the SHA linked) instead of stuck on "uncommitted".
// The baseline shadow's PARENT is the session-start HEAD; a recorded-HEAD
// baseline (clean start) is itself the session-start HEAD.
export function agyDetectSessionCommit(
  repoPath: string,
  baselineSha?: string,
  // Epoch-ms of the session's first prompt. A commit made BEFORE the session
  // existed cannot be its work, whatever the revision walk says. Without this
  // guard a baseline pointing at an older branch tip made `baseline..HEAD`
  // enumerate the whole branch delta, and the newest of those commits — seven
  // weeks old, on another branch — was stamped onto a turn that had only asked
  // a clarifying question (session 5c281376). The root cause was a wrong
  // capture root, fixed separately; this is the backstop that keeps a bad range
  // from inventing authorship.
  notBeforeMs?: number,
): { commitSha?: string; treeClean: boolean } {
  if (!baselineSha || !/^[a-f0-9]{7,40}$/i.test(baselineSha)) return { treeClean: false };
  try {
    let startHead = baselineSha;
    try {
      // Ancestor of HEAD → a real commit (clean start); use as-is.
      execFileSync('git', ['merge-base', '--is-ancestor', baselineSha, 'HEAD'], { windowsHide: true, cwd: repoPath, timeout: 5_000 });
    } catch {
      // Not an ancestor → it's a shadow; the session-start HEAD is its parent.
      try {
        startHead = execFileSync('git', ['rev-parse', `${baselineSha}^`], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim();
      } catch { return { treeClean: false }; }
    }
    // %ct alongside the sha so the age guard needs no second git call.
    const log = execFileSync('git', ['log', '--format=%H %ct', `${startHead}..HEAD`], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim();
    let shas = log ? log.split('\n').filter(Boolean) : [];
    if (typeof notBeforeMs === 'number' && Number.isFinite(notBeforeMs)) {
      // Allow a minute of slack: the first prompt's transcript timestamp and
      // the committer clock are different clocks.
      const floor = notBeforeMs - 60_000;
      shas = shas.filter((line) => {
        const ct = Number(line.split(' ')[1]);
        return !Number.isFinite(ct) || ct * 1000 >= floor;
      });
    }
    shas = shas.map((line) => line.split(' ')[0]).filter(Boolean);
    if (!shas.length) return { treeClean: false };
    let treeClean = false;
    try {
      treeClean = execFileSync('git', ['diff', '--name-only', 'HEAD'], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim() === '';
    } catch { /* leave false */ }
    return { commitSha: shas[0], treeClean };
  } catch { return { treeClean: false }; }
}

/**
 * Recover the TRUE git root for an Antigravity session.
 *
 * agy's `workspacePaths[0]` is unreliable — it is frequently the workspace or
 * project NAME (e.g. "origin-demo-12"), not the folder the edits landed in
 * (e.g. /Users/.../origin-demo-1). Sent verbatim as repoPath, the server can't
 * match a registered repo → 403 → the session is kept local and invisible. So
 * we prefer the git root of the files the session ACTUALLY touched (absolute
 * paths from the transcript's tool_calls), and fall back to the workspace path /
 * cwd only when no such path exists. Every candidate is normalized to its git
 * toplevel (getGitRoot) so the server's path lookup matches a registered repo.
 */
export function deriveAgyRepoPath(filePaths: string[], workspacePath: string | undefined, cwd: string): string {
  return deriveAgyRoots(filePaths, workspacePath, cwd).repoPath;
}

/**
 * The same derivation, but keeping BOTH roots apart.
 *
 * Antigravity runs its agent turns inside its OWN linked git worktree —
 * ~/.gemini/antigravity/worktrees/<project>/<branch> — so the working tree the
 * edits land in is not the main checkout. `repoPath` collapses that to the
 * canonical repo (right for NAMING: repo identity, session/commit ingest,
 * memory). `workRoot` is the worktree itself, and is the only correct cwd for
 * git operations that CAPTURE the work: the baseline shadow, the working-tree
 * snapshot, the diff, commit detection, the branch label.
 *
 * Collapsing both to the canonical root is what emptied worktree turns: the
 * shadow baseline snapshotted the MAIN checkout's tree, `captureAgyDiff` then
 * snapshotted that same untouched tree, and the delta was empty — a turn that
 * created a file reported 0 files / +0 −0, under the main checkout's branch.
 * Mirrors the repoPath-vs-canonicalRepoPath split the Claude Code path uses.
 */
/**
 * The working git root for one path agy touched — which may be a FILE or a
 * DIRECTORY.
 *
 * This used to be `getWorkingGitRoot(path.dirname(p))` unconditionally. That is
 * right for a file and wrong for a directory: `list_dir` reports the directory
 * itself, so dirname() climbs one level ABOVE it. For an agy worktree at
 * ~/.gemini/antigravity/worktrees/<project>/<branch> that lands on
 * .../worktrees/<project>, which is not a git repo at all — so the one piece of
 * real evidence the transcript had was thrown away, and the caller fell through
 * to agy's workspacePaths[0] instead.
 *
 * Try the path itself when it is a directory, then dirname, then the path again
 * (paths from an older transcript may no longer exist, so a failed stat must not
 * be fatal).
 */
function workRootForPath(p: string): string | null {
  const candidates: string[] = [];
  try { if (fs.statSync(p).isDirectory()) candidates.push(p); } catch { /* may not exist any more */ }
  candidates.push(path.dirname(p), p);
  for (const c of candidates) {
    try { const r = getWorkingGitRoot(c); if (r) return r; } catch { /* try the next */ }
  }
  return null;
}

export function deriveAgyRoots(
  filePaths: string[],
  workspacePath: string | undefined,
  cwd: string,
): { repoPath: string; workRoot: string } {
  const roots = (workRoot: string): { repoPath: string; workRoot: string } => ({
    repoPath: getCanonicalRepoPath(workRoot),
    workRoot,
  });
  // 1. Most-touched working git root among the files agy actually edited/read.
  const counts = new Map<string, number>();
  for (const p of filePaths) {
    if (!path.isAbsolute(p)) continue;
    const root = workRootForPath(p);
    if (root) counts.set(root, (counts.get(root) || 0) + 1);
  }
  if (counts.size > 0) {
    let best = ''; let bestN = -1;
    for (const [root, n] of counts) if (n > bestN) { best = root; bestN = n; }
    if (best) return roots(best);
  }
  // 2. Workspace path — but ONLY if it resolves to a real git root. This is
  //    where a bare project name ("origin-demo-12") gets rejected instead of
  //    silently becoming the repo identity.
  if (workspacePath) {
    let wsRoot: string | null = null;
    try { wsRoot = getWorkingGitRoot(workspacePath); } catch { wsRoot = null; }
    if (wsRoot) return roots(wsRoot);
  }
  // 3. cwd's git root, then raw fallbacks (preserve prior behaviour for a
  //    genuinely non-git workspace rather than inventing a path).
  //
  //    agy runs a hook with cwd set to the DIRECTORY CONTAINING hooks.json, not
  //    the workspace. For a global install that is ~/.gemini/config — never a
  //    repo. So when the transcript has no absolute file path yet and agy sends
  //    `workspacePaths: []` (it does, on its first steps), the raw-cwd fallback
  //    used to hand back "~/.gemini/config" as the repo identity: the server
  //    rejected it as unregistered and the capture was queued offline against a
  //    path no repo will ever match. Refuse that candidate and report "unknown"
  //    instead — an honest blank the caller can skip on.
  let cwdRoot: string | null = null;
  try { cwdRoot = getWorkingGitRoot(cwd); } catch { cwdRoot = null; }
  const workFallback = cwdRoot || workspacePath || cwd;
  // Guard on the CANONICAL path, not the working one: an agy worktree legally
  // lives under ~/.gemini, and rejecting it here would refuse the very sessions
  // this split exists to capture. Only a candidate whose canonical repo is
  // still inside the agent's config tree is genuinely not a repo.
  const repoFallback = cwdRoot ? getCanonicalRepoPath(cwdRoot) : workFallback;
  if (isAgentConfigPath(repoFallback)) return { repoPath: '', workRoot: '' };
  return { repoPath: repoFallback, workRoot: workFallback };
}

// True for a path inside the agent's own config/state tree (~/.gemini/...).
// Such a path is agy's plumbing, never the user's repo.
function isAgentConfigPath(p: string): boolean {
  if (!p || !path.isAbsolute(p)) return false;
  // Compare RESOLVED paths. process.cwd() hands back a symlink-resolved path
  // while os.homedir() hands back $HOME verbatim, so on macOS (where /var and
  // /tmp are symlinks into /private) the same directory compares as two
  // different ones and the guard silently misses. realpath both sides; fall
  // back to the raw string when a path does not exist.
  const real = (q: string): string => { try { return fs.realpathSync(q); } catch { return q; } };
  const geminiRoot = real(path.join(os.homedir(), '.gemini'));
  const rel = path.relative(geminiRoot, real(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Exported for the offline-capture integration test: the ordering inside this
// function (local capture BEFORE the first network call) is the whole fix, and
// only driving the real handler can catch a regression that moves it back.
export async function handleAntigravity(event: string, input: Record<string, any>): Promise<void> {
  // PreToolUse: agy reads {decision} on stdout. Enforce file-restriction +
  // budget from the locally-cached rule set (no network on the hot path).
  if (event === 'pre-tool-use') {
    const cid = typeof input.conversationId === 'string' ? input.conversationId : '';
    let cache = cid ? readAgyRulesCache(cid) : null;
    // Establish a per-conversation diff baseline BEFORE the first tool mutates
    // the tree (pre-tool-use fires ahead of the tool). Snapshot the current
    // working tree as a shadow commit so later captures show ONLY what agy
    // changed — excluding pre-existing dirt (unrelated edits, stray untracked
    // files). A clean tree yields no shadow, so anchor on HEAD instead. Once
    // per conversation, guarded by baselineSha.
    if (cid && !cache?.baselineSha) {
      // Prefer the git root of the file THIS tool is about to touch over agy's
      // workspacePaths[0] (often a bare project name) so the baseline shadow
      // lands in the same repo the session gets attributed to.
      const wsPath = (Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string')
        ? input.workspacePaths[0] : undefined;
      const toolFile = agyToolPaths(input.toolCall).filePath;
      const { repoPath: rp, workRoot: rw } = deriveAgyRoots(toolFile ? [toolFile] : [], wsPath, process.cwd());
      // '' = no repo identity resolved (see deriveAgyRepoPath). Snapshotting the
      // agent's own config dir would pin the baseline to a non-repo, so skip and
      // let a later step, once a real file path appears, set it. Skip the
      // BASELINE only — never the function: agy blocks the tool call unless this
      // hook still writes a decision to stdout below.
      if (rp) {
        // Snapshot the WORKING tree (the worktree agy is about to edit), not
        // the canonical checkout — a baseline taken from the main checkout
        // makes every later diff empty.
        let base: string | null = null;
        try { base = createShadowCommit(rw, `agy-start-${cid.slice(0, 8)}`) || getHeadSha(rw); } catch { /* non-fatal */ }
        if (base) {
          cache = { ...(cache || {}), baselineSha: base, repoPath: rp, workRoot: rw };
          writeAgyRulesCache(cid, cache);
          debugLog('pre-tool-use', 'antigravity baseline set', { cid, base, repoPath: rp, workRoot: rw });
        }
      }
    }
    // agy's stand-in for SessionStart. It fires no such event (only PreToolUse,
    // PostToolUse and Stop exist), so every chore the other agents get at launch
    // — fetching remote notes, refreshing the AGENTS.md Origin block — has never
    // run for an agy session. AGENTS.md was only ever rewritten as a SIBLING of
    // some other agent's session-start in the same repo, which means a repo
    // driven only by agy carries whatever block was last committed to it, and a
    // fresh clone whose backgrounded post-checkout fetch was killed keeps its
    // notes stranded in the staging ref with nothing to ever fold them.
    //
    // Detached, not inline: agy blocks the tool call until this hook writes a
    // decision to stdout, and the notes sync alone budgets 6s of network. The
    // refresh lands after this tool call either way — AGENTS.md is read at
    // conversation start, so what it buys is a current block for the NEXT
    // conversation instead of a months-stale one. Once per conversation.
    const refreshRoot = cache?.repoPath;
    if (cid && refreshRoot && !cache?.contextRefreshedAt) {
      cache = { ...(cache || {}), contextRefreshedAt: new Date().toISOString() };
      writeAgyRulesCache(cid, cache);
      spawnAgyContextRefresh(refreshRoot);
    }
    const verdict = agyEvaluatePreTool(input.toolCall, cache);
    if (verdict.decision === 'deny') {
      debugLog('pre-tool-use', 'antigravity DENY', { reason: verdict.reason });
    }
    process.stdout.write(JSON.stringify(verdict) + '\n');
    return;
  }
  if (event !== 'post-tool-use' && event !== 'stop') return;

  let conversationId = typeof input.conversationId === 'string' ? input.conversationId : '';
  let transcriptPath = typeof input.transcriptPath === 'string' ? input.transcriptPath : '';
  // On Stop the payload can be thin (agy fires it on exit). Recover the active
  // conversation from disk so the final state — including a trailing prompt that
  // made no tool call — still gets captured.
  if ((!conversationId || !transcriptPath) && event === 'stop') {
    const found = discoverLatestAgyConversation();
    if (found) {
      conversationId = conversationId || found.conversationId;
      transcriptPath = transcriptPath || found.transcriptPath;
      debugLog('stop', 'antigravity: recovered conversation from disk', { conversationId });
    }
  }
  if (!conversationId || !transcriptPath) {
    debugLog(event, 'antigravity: missing conversationId/transcriptPath', {
      hasConversationId: !!conversationId, hasTranscriptPath: !!transcriptPath,
    });
    return;
  }
  const cachedForRepo = readAgyRulesCache(conversationId);
  if (!isConnectedMode()) return;
  const agentConfig = loadAgentConfig();
  if (!agentConfig?.machineId) return;

  let jsonl = '';
  try { jsonl = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return; }
  const parsed = parseAntigravityTranscript(jsonl);
  if (parsed.prompts.length === 0) return; // nothing capturable yet

  // Repo identity comes from the git root of the files agy ACTUALLY touched —
  // NOT agy's workspacePaths[0], which is often a bare project name that no
  // registered repo matches (→ 403 → session stuck local, the "origin-demo-12
  // vs origin-demo-1" bug). Fall back to the workspace path / cached root / cwd
  // only when the transcript carries no absolute file path.
  const wsPath0 = (Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string')
    ? input.workspacePaths[0] : undefined;
  // repoPath = canonical repo (identity: repo naming, session/commit ingest,
  // memory). workRoot = the working tree those edits actually landed in — for
  // agy that is routinely its own linked worktree under
  // ~/.gemini/antigravity/worktrees/. Every `git` below runs in workRoot.
  let { repoPath, workRoot } = deriveAgyRoots(
    parsed.filePaths,
    wsPath0 || cachedForRepo?.workRoot || cachedForRepo?.repoPath,
    typeof input.cwd === 'string' ? input.cwd : process.cwd(),
  );

  // PIN the capture root to wherever the BASELINE was taken.
  //
  // A diff is a baseline plus a tree, and they have to come from the same
  // checkout. agy's workspacePaths[0] does not: across fires of one
  // conversation it flips between the worktree and the main project directory.
  // When a fire resolved to the main checkout while the baseline had been taken
  // in the worktree, the turn diffed the worktree's HEAD against the MAIN
  // checkout's tree and reported the whole delta between two branches as the
  // turn's work — 9 files and a seven-week-old commit on a turn that only asked
  // a clarifying question (session 5c281376, prompt 0).
  //
  // The baseline is the fixed point: it already exists, everything else is
  // derived from it. So once one is recorded, its root wins.
  if (cachedForRepo?.baselineSha && cachedForRepo?.workRoot && !samePath(cachedForRepo.workRoot, workRoot)) {
    debugLog(event, 'antigravity workRoot re-pinned to the baseline root', {
      derived: workRoot, pinned: cachedForRepo.workRoot, wsPath0,
    });
    workRoot = cachedForRepo.workRoot;
    if (cachedForRepo.repoPath) repoPath = cachedForRepo.repoPath;
  }
  debugLog(event, 'antigravity repoPath resolved', { repoPath, workRoot, wsPath0, filesInTranscript: parsed.filePaths.length });
  if (!repoPath) {
    // Nothing but the agent's own config dir was on offer. Capturing against it
    // yields an unregisterable repo and an offline queue that never drains, so
    // wait for a step that names a real file instead.
    debugLog(event, 'antigravity capture skipped — no repo identity resolved', { conversationId });
    return;
  }

  const usage = estimateAntigravityUsage(parsed);
  const model = parsed.model || 'gemini-3-pro';
  // Branch comes from the WORKING tree: a worktree sits on its own branch, and
  // labelling the session with the main checkout's branch is both wrong and the
  // visible tell that capture ran in the wrong directory.
  const branch = getBranch(workRoot) || undefined;
  // Send the git remote too — repos imported from GitHub are registered by
  // REMOTE identity (path = "github.com/owner/repo"), not a filesystem path, so
  // a repoPath-only lookup 404s even though Codex/Claude (which send repoUrl)
  // match fine. Mirror their derivation so agy attributes to the same repo.
  let repoUrl: string | undefined;
  try {
    repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { windowsHide: true, cwd: workRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
  } catch { /* no remote — path-only, as before */ }
  // agy exposes no tokens → estimate cost from the estimated tokens × price so
  // the session shows a sensible (clearly-estimated) cost instead of $0.
  const costUsd = estimateCost(model, usage.inputTokens, usage.outputTokens);

  // ── LOCAL CAPTURE — runs BEFORE any network call ────────────────────────
  //
  // Everything from here to the end of the commit-detection block is pure git
  // plumbing and on-disk bookkeeping. It used to sit AFTER startSession, so a
  // single failed fetch skipped all of it and `return`ed. That lost the turn's
  // diff outright, and — because `lastSyncShadow` never advanced — silently
  // handed the whole outage's work to whichever later turn first reached the
  // server. Capture is local; only the SEND needs the network, so the send is
  // what degrades now (see the pending queue below).

  // Per-prompt diff baseline: prompt i's diff must be ITS OWN changes, not the
  // cumulative session diff — otherwise a read-only prompt (e.g. "what changes
  // did you make") inherits earlier prompts' files. promptBaselines[i] = the
  // tree at prompt i's START (the previous prompt's end snapshot,
  // `lastSyncShadow`); the first prompt anchors on the session baseline.
  const currentIdx = parsed.prompts.length - 1;
  // The watcher must NOT own the per-prompt baseline bookkeeping. It runs
  // concurrently with the real pre/post-tool-use hooks, and a shared
  // read-modify-write of the agy cache races them (lost update → a stale
  // baseline that makes a read-only prompt show the whole cumulative diff).
  // Real hooks fire one-at-a-time, so they alone mutate state; the watcher only
  // READS existing baselines and re-sends to the server.
  const isWatcherSync = !!process.env.ORIGIN_AGY_IS_WATCHER;
  const promptBaselines: Record<number, string> = { ...(cachedForRepo?.promptBaselines || {}) };
  let promptBaseline = promptBaselines[currentIdx];
  if (!promptBaseline) {
    promptBaseline = cachedForRepo?.lastSyncShadow || cachedForRepo?.baselineSha || '';
    if (promptBaseline && !isWatcherSync) promptBaselines[currentIdx] = promptBaseline;
  }

  // Capture ONLY this prompt's working-tree edits since its baseline. Excludes
  // pre-existing dirt AND earlier prompts' work. With NO baseline we capture
  // nothing (captureAgyDiff returns empty rather than dumping `git diff HEAD`).
  let filesChanged: string[] = [];
  let diff = '';
  let linesAdded = 0;
  let linesRemoved = 0;
  try {
    const cap = captureAgyDiff(workRoot, promptBaseline || null);
    filesChanged = cap.filesChanged;
    diff = cap.diff ? cap.diff.slice(0, MAX_PROMPT_DIFF_LEN) : '';
    linesAdded = cap.linesAdded;
    linesRemoved = cap.linesRemoved;
  } catch { /* non-fatal */ }

  // Guard against CONCURRENT-AGENT dirt: a file some OTHER agent created in the
  // shared working tree, swept into this turn by a stale watcher baseline. Scope
  // the capture to files THIS conversation actually edited (see the helper).
  {
    const scoped = scopeAgyDiffToSessionEdits(workRoot, filesChanged, diff, linesAdded, linesRemoved, parsed.filesEdited);
    if (scoped.dropped.length > 0) {
      filesChanged = scoped.filesChanged;
      diff = scoped.diff;
      linesAdded = scoped.linesAdded;
      linesRemoved = scoped.linesRemoved;
      debugLog(event, 'antigravity capture: dropped concurrent-agent dirt not edited by this session', { dropped: scoped.dropped, keptFiles: filesChanged.length });
    }
  }

  // A `git init` inside the work tree hides every file beneath it, and the
  // diff renders that as deleting all of them. Those files are still on disk;
  // nothing was deleted. See dropPhantomNestedRepoDeletions.
  {
    const turnStartMs = parsed.promptTimes[currentIdx];
    if (typeof turnStartMs === 'number') {
      const cleaned = dropPhantomNestedRepoDeletions(workRoot, filesChanged, diff, turnStartMs);
      if (cleaned.dropped.length > 0) {
        filesChanged = cleaned.filesChanged;
        diff = cleaned.diff;
        linesAdded = cleaned.linesAdded;
        linesRemoved = cleaned.linesRemoved;
        debugLog(event, 'antigravity capture: dropped phantom deletions from a nested repo created this turn', {
          dropped: cleaned.dropped, linesRemoved,
        });
      }
    }
  }

  // Roll the end-of-work snapshot forward so the NEXT prompt diffs against where
  // this one left off (clean tree → anchor on HEAD). Tag per prompt index so
  // each prompt's end-shadow keeps its own ref alive (a shared tag would move,
  // letting git GC prune a baseline an earlier prompt still points at).
  let lastSyncShadow = cachedForRepo?.lastSyncShadow;
  if (!isWatcherSync) {
    try { lastSyncShadow = createShadowCommit(workRoot, `agy-sync-${conversationId.slice(0, 8)}-${currentIdx}`) || getHeadSha(workRoot) || lastSyncShadow; } catch { /* keep previous */ }
  }

  // Track which prompts have uncommitted work. When a commit happens, every
  // such prompt's work was swept into it, so they all link to the commit.
  const firstPromptMs = parsed.promptTimes.find((t) => typeof t === 'number') ?? undefined;
  const { commitSha, treeClean } = agyDetectSessionCommit(workRoot, promptBaseline || undefined, firstPromptMs ?? undefined);
  const dirty = new Set<number>(cachedForRepo?.dirtyPromptIndices || []);
  if (filesChanged.length > 0) dirty.add(currentIdx);
  let committedIndices: number[] = [];
  if (commitSha) {
    committedIndices = [...new Set([...dirty, currentIdx])];
    dirty.clear();
  }

  // ── END LOCAL CAPTURE — the network starts here ─────────────────────────

  // Merge a patch over the cached entry so a partial write never drops a field
  // we didn't explicitly set (rules/budget survive an offline fire, baselines
  // survive a rules refresh).
  const persistAgyCache = (patch: Partial<AgyRulesCache>): void => {
    if (isWatcherSync) return;
    writeAgyRulesCache(conversationId, {
      ...(cachedForRepo || {}),
      repoPath,
      workRoot,
      transcriptPath,
      baselineSha: cachedForRepo?.baselineSha,
      promptBaselines,
      lastSyncShadow,
      dirtyPromptIndices: [...dirty],
      ...patch,
    });
  };

  // Persist the local bookkeeping BEFORE the network call. This is the half of
  // the fix that stops the MIS-attribution: with `lastSyncShadow` already on
  // disk, the next turn diffs from where this one ended even if everything
  // below fails, so it can no longer inherit this turn's work.
  persistAgyCache({});

  // Ensure/dedup the server session by conversationId.
  let sessionId: string | undefined;
  let startRes: any;
  try {
    startRes = await api.startSession({
      machineId: agentConfig.machineId,
      prompt: parsed.prompts[0],
      model,
      repoPath,
      repoUrl,
      agentSlug: 'antigravity',
      agentSessionId: conversationId,
      branch,
    } as any);
    sessionId = (startRes as any)?.sessionId;
  } catch (err: any) {
    debugLog(event, 'antigravity startSession failed (non-fatal)', { message: err?.message });
    sessionId = undefined;
  }

  // Register the session state NOW, not at the end of this handler.
  //
  // A git hook can only credit a commit to a session it can FIND, and the only
  // durable record is what registerAgySessionState writes (`.git` plus the
  // ~/.origin/sessions mirror). Writing it after the network payload means a
  // commit made in the NEXT turn — before that turn's Stop — has nothing to
  // attach to.
  //
  // Prod a5c2570c: the agent replaced the worktree's `.git` with a fresh repo,
  // destroying the state file. post-commit fired 7 seconds BEFORE the state was
  // re-created, logged "no active sessions, skipped API update", and the commit
  // was ingested as a brand-new repo row instead of onto the session.
  //
  // Idempotent — it merges over whatever exists — so registering early and
  // again at the end costs one extra write and makes the record exist for the
  // whole window a commit can land in.
  if (sessionId && !isWatcherSync) {
    try {
      registerAgySessionState({
        serverSessionId: sessionId,
        conversationId,
        repoPath,
        workRoot,
        model,
        transcriptPath,
        prompts: parsed.prompts,
        filesChanged,
      });
    } catch { /* non-fatal: the end-of-handler registration still runs */ }
  }

  if (!sessionId) {
    // Unreachable server (or no session id). Everything below needs one, so
    // queue what we just captured and let a later fire deliver it — this is the
    // half of the fix that stops the DATA LOSS. Without the queue an offline
    // turn's diff would be gone for good: the baseline has already rolled
    // forward, so no future capture can reproduce it.
    if (!isWatcherSync) {
      const ownMapping: Record<string, any> = {
        promptIndex: currentIdx,
        promptText: parsed.prompts[currentIdx],
        diff,
        uncommittedDiff: (commitSha && treeClean) ? '' : diff,
        filesChanged,
        linesAdded,
        linesRemoved,
        authoritative: true,
        ...(parsed.promptTimes[currentIdx] != null ? { createdAt: parsed.promptTimes[currentIdx] } : {}),
        ...(commitSha ? { commitSha } : {}),
      };
      const pending = mergePendingPromptChanges(cachedForRepo?.pendingPromptChanges, [ownMapping]);
      persistAgyCache({ pendingPromptChanges: pending });
      debugLog(event, 'antigravity capture queued offline', {
        promptIndex: currentIdx, queued: pending.length, files: filesChanged.length, linesAdded,
      });
    }
    return;
  }

  // Ingest the commit ROW ourselves. Normally the git post-commit hook calls
  // api.ingestCommits, but agy runs sandboxed and the model routinely commits
  // with hooks DISABLED (`git -c core.hooksPath=/dev/null commit`, to dodge the
  // sandbox's .git-write restrictions). Then the post-commit ingest never fires
  // and the commit is 404 server-side — the turn shows "uncommitted" forever
  // even though we linked its SHA. So ingest it here too. Idempotent (server
  // dedups by SHA); guarded by ingestedCommitSha so the many per-turn hook
  // fires don't re-send; fire-and-forget so a slow call never blocks capture.
  let ingestedCommitSha = cachedForRepo?.ingestedCommitSha;
  // Subjects of the session's commits, accumulated across fires — the heuristic
  // memory summary is built from these (see summarizeFromCommitSubjects).
  const commitSubjects: string[] = [...(cachedForRepo?.commitSubjects || [])];
  if (commitSha && !isWatcherSync && commitSha !== ingestedCommitSha && /^[a-fA-F0-9]{7,40}$/.test(commitSha)) {
    try {
      const cOpts = { encoding: 'utf-8' as const, cwd: workRoot, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
      const { diff: cDiff, filesChanged: cFiles } = extractCommitDiff(workRoot, commitSha);
      let cAdd = 0, cDel = 0;
      if (cDiff) for (const l of cDiff.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) cAdd++; else if (l.startsWith('-') && !l.startsWith('---')) cDel++; }
      const g = (fmt: string) => { try { return execFileSync('git', ['log', '-1', `--format=${fmt}`, commitSha], cOpts).trim(); } catch { return ''; } };
      const thisSubject = g('%s');
      if (thisSubject && !commitSubjects.includes(thisSubject)) commitSubjects.push(thisSubject);
      void api.ingestCommits({
        repoPath,
        repoUrl,
        commits: [{
          sha: commitSha,
          message: g('%s'),
          author: g('%an'),
          branch: branch || null,
          filesChanged: cFiles,
          additions: cAdd,
          deletions: cDel,
          committedAt: g('%cI') || undefined,
          diff: cDiff ? cDiff.slice(0, 500_000) : undefined,
        }],
      }).then((r: any) => debugLog(event, 'antigravity commit ingested', { commitSha: commitSha.slice(0, 8), ingested: r?.ingested }))
        .catch((e: any) => debugLog(event, 'antigravity commit ingest failed (non-fatal)', { message: e?.message }));
      ingestedCommitSha = commitSha;

      // memoryUpdate=commit/both: agy commits routinely bypass the git
      // post-commit hook (sandbox commits with hooks disabled), so
      // handlePostCommit — where the normal commit-time memory write lives —
      // never fires for them. Write memory HERE, attributed to the agy session
      // itself (correct agentSlug=antigravity + gemini model + the transcript's
      // real prompts), so this work is actually remembered instead of the write
      // being missed (or landing on whatever OTHER session the hook picked).
      // Upsert-by-sessionId collapses the per-turn fires to one latest entry.
      if (shouldWriteMemoryOnCommit(memoryUpdateTrigger())) {
        try {
          const agyState = loadSessionState(repoPath, `agy-${conversationId.slice(0, 12)}`);
          const agyStartedAt = agyState?.startedAt || new Date().toISOString();
          // Accumulate the files this SESSION touched, not just this one commit's.
          // Upsert-by-sessionId would otherwise leave memory showing only the
          // latest commit's file (a 3-file session collapsing to 1). Union this
          // commit (cFiles) + this fire's captured edits + every prior prompt's
          // files recorded on the agy session state.
          const accSet = new Set<string>(cFiles);
          for (const f of (filesChanged || [])) if (typeof f === 'string') accSet.add(f);
          for (const pm of (((agyState as any)?.completedPromptMappings) || [])) for (const f of ((pm?.filesChanged) || [])) if (typeof f === 'string') accSet.add(f);
          const accFiles = accSet.size > 0 ? Array.from(accSet) : cFiles;
          // Summary priority: LLM synthesis (if memorySummary='llm' + key) →
          // the session's COMMIT MESSAGES (deterministic, no key; "Add terminal
          // digital clock script; Add calculator script" beats a vague opening
          // prompt like "do whatever you want") → first prompt → commit subject.
          const commitSummary = summarizeFromCommitSubjects(commitSubjects);
          let agySummary: string | undefined = commitSummary || parsed.prompts[0] || g('%s') || undefined;
          const synth = await synthesizeSessionSummary({ prompts: parsed.prompts, filesChanged: accFiles, linesAdded: cAdd, linesRemoved: cDel, commitSubjects, diff: cDiff });
          if (synth?.summary) agySummary = synth.summary;
          const agyFileNotes = synth?.fileNotes && Object.keys(synth.fileNotes).length > 0 ? synth.fileNotes : undefined;
          // Decisions: explicit [Origin: Decision] markers (ground truth) + LLM-inferred.
          const agyDecisions: string[] = [];
          let agyMarkers: OriginMarkers | undefined;
          try {
            agyMarkers = parseMarkersFromTranscriptPath(transcriptPath);
            for (const d of agyMarkers?.decision || []) if (d && !agyDecisions.includes(d)) agyDecisions.push(d);
          } catch { /* best-effort */ }
          for (const d of (synth?.decisions || [])) if (d && !agyDecisions.includes(d)) agyDecisions.push(d);
          writeSessionMemory(repoPath, buildMemoryEntry(
            { sessionId, startedAt: agyStartedAt, prompts: parsed.prompts, branch: branch || null, agentSlug: 'antigravity' },
            {
              agentSlug: 'antigravity',
              model,
              branch: branch || null,
              filesChanged: accFiles,
              linesAdded: cAdd,
              linesRemoved: cDel,
              summary: agySummary,
              prompts: parsed.prompts,
              fileNotes: agyFileNotes,
              decisions: agyDecisions,
              markers: agyMarkers,
            },
          ));
          debugLog(event, 'antigravity session memory refreshed (memoryUpdate=commit)', { sessionId, commitSha: commitSha.slice(0, 8), files: accFiles.length, synth: !!synth });
          // Antigravity commits with hooks off and rarely reaches a clean
          // session end — refresh the continuation brief here, grounded in this
          // commit's diff, so its brief doesn't go stale.
          scheduleMemoryBriefRefresh(repoPath, isConnectedMode(), event, cDiff);

          // Immutable per-commit record for THIS commit (add-once by SHA), with
          // its own files + per-file notes (filtered to this commit).
          try {
            const commitNotes: Record<string, string> = {};
            for (const f of cFiles) if (agyFileNotes && agyFileNotes[f]) commitNotes[f] = agyFileNotes[f];
            writeCommitMemory(repoPath, {
              commitSha, sessionId, agentSlug: 'antigravity', message: g('%s') || '',
              filesChanged: cFiles, fileNotes: Object.keys(commitNotes).length > 0 ? commitNotes : undefined,
              decisions: agyDecisions.length > 0 ? agyDecisions.slice(0, 6) : undefined,
              linesAdded: cAdd, linesRemoved: cDel, branch: branch || null,
              committedAt: g('%cI') || new Date().toISOString(),
            });
          } catch { /* non-fatal */ }
        } catch (e: any) {
          debugLog(event, 'antigravity session memory refresh error (non-fatal)', { message: e?.message });
        }
      }
    } catch (e: any) {
      debugLog(event, 'antigravity commit ingest error', { message: e?.message });
    }
  }

  // Cache the server's rules + budget lock so PreToolUse can enforce locally,
  // plus the per-prompt baselines (preserve the session baselineSha set on the
  // first pre-tool-use). REAL hooks only — the watcher never writes the cache
  // (see isWatcherSync above), so it can't race/corrupt the baselines.
  // `pendingPromptChanges` is carried through explicitly: this write happens
  // BEFORE the send that flushes the queue, so omitting it here would erase
  // offline captures a moment before they were due to be delivered. It is
  // cleared only after the send lands (clearFlushedPending).
  if (!isWatcherSync) persistAgyCache({
    enforcementRules: Array.isArray(startRes?.enforcementRules) ? startRes.enforcementRules : [],
    budgetBlocked: !!startRes?.budget?.blocked,
    budgetMessage: startRes?.budget?.message,
    ingestedCommitSha,
    commitSubjects,
    pendingPromptChanges: cachedForRepo?.pendingPromptChanges || [],
  });

  // Register the agy session as a local SessionState (with the files it touched)
  // so git-hook commit attribution can SEE it and credit it for its own commit
  // — otherwise agy is invisible to prepare-commit-msg and its commits get
  // stamped with whatever other session is around (the "shown as Cursor" bug).
  // REAL hooks only — it read-modify-writes the state file, so the watcher must
  // not race it.
  //
  // Never ENDED here, on Stop or otherwise: agy fires Stop at every turn
  // boundary, so marking (and archiving) the state there retired a session that
  // was still working. The turn's own commit could then land with no candidate
  // left to own it. The state ages out on its own — isSessionAlive() reads it as
  // dead once the file goes stale, and expireStaleSessionsOnServer() closes it.
  if (!isWatcherSync) registerAgySessionState({
    serverSessionId: sessionId,
    conversationId,
    repoPath,
    workRoot,
    model,
    baselineSha: cachedForRepo?.baselineSha,
    transcriptPath,
    prompts: parsed.prompts,
    filesChanged,
  });

  // Attach this prompt's OWN diff to its turn (it's the current/last prompt) so
  // the per-turn view renders only what this prompt changed + AI Blame. Mark it
  // `authoritative` so the captured value REPLACES any prior diff for this
  // prompt wholesale — without it the server's "don't overwrite with empty"
  // rule keeps stale data forever (e.g. a read-only prompt that briefly
  // inherited the cumulative diff never clears to "no changes"). Earlier prompts
  // carry text only, so their already-stored (own) diffs are kept.
  // If the agent committed, link the commit to the turn (and every earlier
  // prompt whose uncommitted work it swept up) and — when nothing tracked is
  // left dirty — stop labeling the work "uncommitted", so the per-turn view
  // shows a "committed" badge. Read-only prompts (empty diff) never go dirty,
  // so they're never linked to the commit.
  const uncommittedDiff = (commitSha && treeClean) ? '' : diff;
  const committedSet = new Set(committedIndices);
  // Turns captured while the server was unreachable. We're reachable now, so
  // they ride along on this send and land on their OWN turn — without this the
  // flush never happens and an offline turn stays permanently blank.
  const pendingByIndex = new Map<number, Record<string, any>>();
  for (const pc of (cachedForRepo?.pendingPromptChanges || [])) {
    if (pc && typeof pc.promptIndex === 'number' && pc.promptIndex !== currentIdx) {
      pendingByIndex.set(pc.promptIndex, pc);
    }
  }
  if (pendingByIndex.size > 0) {
    debugLog(event, 'antigravity flushing offline captures', { indices: [...pendingByIndex.keys()] });
  }
  const promptChanges = parsed.prompts.map((p, i) => {
    // Real prompt time from the transcript. agy has no UserPromptSubmit hook, so
    // without this the server stamps the DB insert time (whenever the first Stop
    // fired) — wrong, and unstable across re-parses. parsed.prompts is sorted by
    // this time, so promptIndex `i` is a stable identity for the prompt.
    const ts = parsed.promptTimes[i];
    const createdAt = ts != null ? { createdAt: ts } : {};
    // What this turn wrote that is NOT in the repo — agy's own scratch dir, a
    // sibling checkout, /tmp. Without it a turn that wrote only outside the
    // repo is indistinguishable from a capture that broke: both render "0
    // files changed". Derived from the transcript, which is re-parsed in full
    // on every fire, so re-sending it is idempotent.
    // A NESTED REPO is inside workRoot, so outOfRepoWrites cannot see it —
    // and neither can git, which reports the directory and nothing under it.
    // Prod b6f3cc59 turn 3: the agent decided this worktree's git pointer was
    // broken (it was not — it resolves, and `git status` works), ran `git init`
    // inside `inventory/`, moved five files in and committed 228 lines there.
    // From the parent those five files simply VANISHED, so the turn rendered
    // "+0 -192" — a deletion, for work that was created. Same blind spot as
    // the 0-file case, wearing a worse mask.
    //
    // Only the turn that is CURRENTLY closing gets this: the window is its own
    // prompt time, and an earlier turn's nested repo is not its work.
    const nestedFiles = (i === currentIdx && typeof parsed.promptTimes[i] === 'number')
      ? nestedRepoFilesWritten(workRoot, parsed.promptTimes[i] as number)
      : [];
    const outsideFiles = [...new Set([
      ...outOfRepoWrites(workRoot, parsed.promptFilesEdited[i] || []),
      ...nestedFiles,
    ])];
    const outside = outsideFiles.length > 0 ? { outOfRepoFiles: outsideFiles } : {};
    if (nestedFiles.length > 0) {
      debugLog('stop', 'antigravity nested-repo writes reported as out-of-repo', {
        promptIndex: i, count: nestedFiles.length, sample: nestedFiles.slice(0, 3),
      });
    }
    if (i === currentIdx) {
      return { promptIndex: i, promptText: p, diff, uncommittedDiff, filesChanged, linesAdded, linesRemoved, authoritative: true, ...outside, ...createdAt, ...(commitSha ? { commitSha } : {}) };
    }
    const queued = pendingByIndex.get(i);
    if (queued) {
      // Replay the offline capture verbatim, re-stamping the text/time from the
      // current parse, and applying the commit backfill if this turn's work was
      // swept into a commit that landed later.
      return {
        ...queued,
        promptIndex: i,
        promptText: p,
        ...outside,
        ...createdAt,
        ...(commitSha && committedSet.has(i) ? { commitSha, uncommittedDiff: '' } : {}),
      };
    }
    if (commitSha && committedSet.has(i)) {
      // Backfill the commit link onto an earlier prompt whose work it included;
      // clear its uncommitted flag without touching its stored diff.
      return { promptIndex: i, promptText: p, commitSha, uncommittedDiff: '', ...outside, ...createdAt };
    }
    return { promptIndex: i, promptText: p, ...outside, ...createdAt };
  });

  // Synthesize the conversation transcript (turns of user/assistant messages)
  // so the session view renders the agent's actual output per turn — reasoning,
  // tool actions, and final answers — instead of "No response captured". agy
  // gives no real transcript file in our format, so we build one from the
  // parsed prompts + assembled responses, the same shape Gemini's stop hook
  // synthesizes. buildUnifiedTurns(transcript, promptChanges) on the web groups
  // these into per-turn cards.
  const turns: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < parsed.prompts.length; i++) {
    turns.push({ role: 'user', content: parsed.prompts[i] });
    const resp = parsed.responses[i];
    if (resp && resp.trim()) turns.push({ role: 'assistant', content: resp });
  }
  const transcript = turns.length > 0 ? JSON.stringify(turns) : undefined;

  const usagePayload = {
    tokensUsed: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    tokensEstimated: true,
    costUsd,
    // agy has no usage payload of its own, so these were never sent and the
    // session detail rendered "0 tools" for turns that plainly ran several.
    // The counts come from the transcript's tool_calls, normalized to the same
    // labels the UI colors chips by. Omit a zero so a thin/early parse can't
    // overwrite a real count with 0.
    ...(parsed.toolCalls > 0 ? { toolCalls: parsed.toolCalls } : {}),
    ...(parsed.toolBreakdown.length > 0 ? { toolBreakdown: parsed.toolBreakdown } : {}),
  };

  // Drop the offline queue only once the send that carried it LANDED. Re-reads
  // the cache rather than reusing `cachedForRepo`, which is stale by now — the
  // big write above has already run.
  const clearFlushedPending = (): void => {
    if (isWatcherSync || pendingByIndex.size === 0) return;
    try {
      const cur = readAgyRulesCache(conversationId);
      if (cur?.pendingPromptChanges?.length) {
        writeAgyRulesCache(conversationId, { ...cur, pendingPromptChanges: [] });
        debugLog(event, 'antigravity offline captures flushed', { count: pendingByIndex.size });
      }
    } catch { /* non-fatal — a retry just re-sends them, which is idempotent */ }
  };

  if (event === 'stop') {
    // agy's Stop is a TURN boundary, not a process exit.
    //
    // The original capture was built against agy builds that fired Stop only
    // when the CLI exited, so this branch called api.endSession() — which
    // COMPLETES the row. Current builds fire Stop at the end of EVERY turn
    // (proven from ~/.origin/hooks.log: one conversation logged four Stops,
    // 13:23/13:25/13:27/13:41, each followed by more Pre/PostToolUse from the
    // same still-running agy). So every turn ended the session, the next turn's
    // /session/start re-opened it via the COMPLETED-resume rung, and the row sat
    // on "Completed" the whole time the user was still working in it.
    //
    // There is no signal on the payload that separates a turn-end Stop from a
    // real exit, so treat Stop the way handleSessionEnd treats the other agents
    // with a per-turn "session end" (cursor / codex / claude-code / copilot):
    // send the full final-state payload as an UPDATE and leave the session
    // RUNNING. Ending it is then the server's job, on the same clock as every
    // other agent — IDLE at IDLE_THRESHOLD_MS (1h), COMPLETED by the
    // activity-idle sweep at IDLE_ACTIVITY_COMPLETE_MS (3h) — plus the local
    // expireStaleSessionsOnServer() path when a later commit finds the state
    // file stale.
    let sendOk = false;
    try {
      await api.updateSession(sessionId, {
        prompt: parsed.prompts.join('\n\n---\n\n'),
        promptChanges,
        transcript,
        model,
        branch,
        filesChanged,
        diff,
        ...usagePayload,
      } as any);
      sendOk = true;
      clearFlushedPending();
      debugLog('stop', 'antigravity turn finalized (session stays RUNNING)', { sessionId, prompts: parsed.prompts.length, model, costUsd, files: filesChanged?.length || 0, turns: turns.length });
    } catch (err: any) {
      debugLog('stop', 'antigravity stop updateSession failed (non-fatal)', { message: err?.message });
    }
    // The cache is NOT discarded here any more. It used to be, because Stop
    // meant the conversation was over — but a per-turn Stop is followed by more
    // turns, and the cache holds this conversation's diff baselines
    // (baselineSha / promptBaselines / lastSyncShadow). Deleting it mid-session
    // would make the next turn diff from nothing and re-report the whole
    // cumulative session as its own work. Old conversations are pruned by age
    // instead.
    if (!sendOk) {
      debugLog('stop', 'antigravity keeping cache — stop send failed, offline captures still queued', {
        queued: (readAgyRulesCache(conversationId)?.pendingPromptChanges || []).length,
      });
    }
    pruneAgyRulesCaches();
    // Tell the watcher a turn just closed. It drains any output written after
    // this hook's own transcript read, then exits; the next turn's PostToolUse
    // spawns a fresh one.
    try {
      const donePath = agyWatchDonePath(conversationId);
      fs.mkdirSync(path.dirname(donePath), { recursive: true });
      fs.writeFileSync(donePath, String(Date.now()));
    } catch { /* non-fatal */ }
  } else {
    try {
      await api.updateSession(sessionId, { promptChanges, transcript, model, filesChanged, diff, ...usagePayload });
      clearFlushedPending();
    } catch (err: any) {
      debugLog('post-tool-use', 'antigravity updateSession failed (non-fatal)', { message: err?.message });
    }
    // Catch trailing output that lands AFTER this tool call (a final answer, a
    // no-tool prompt) — agy emits no event for it, so watch the transcript and
    // re-sync once it settles. No-op when this IS the watcher's own re-sync.
    spawnAgyWatcher(conversationId, repoPath, transcriptPath);
  }
}

/**
 * Dual-hook collision guard: is THIS payload from a different agent than the
 * slug the hook was invoked with?
 *
 * Cursor fires Claude-Code-compatible hooks out of ~/.claude/settings.json IN
 * ADDITION to its own ~/.cursor/hooks.json, so one Cursor turn runs BOTH
 * `origin hooks cursor <event>` and `origin hooks claude-code <event>` with the
 * SAME stdin payload ~100ms apart (observed live: one session-start logged
 * agentSlug "cursor" and "claude-code" back-to-back on identical inputKeys).
 * That twin can never resolve the Cursor session state — `sessionMatchesAgent`
 * rejects it on the slug, and claude-code being in STABLE_SESSION_ID_AGENTS
 * forces an exact match on Cursor's PER-TURN-ROTATING session_id, which fails
 * ("no exact match for stable claudeSessionId — new session needed"). So the
 * tool-use events ABORT with "no session state" and Stop mints a WHOLE NEW
 * session tagged agentSlug "claude-code" while carrying a Cursor model
 * ("cursor-grok-4.6-high-fast"). Six of those accumulated in
 * ~/.origin/sessions on the reporting machine. They landed there with `local-`
 * ids only because that machine's session/start calls were falling back — on a
 * healthy connected machine the twin gets a REAL server session and reaches the
 * dashboard as a duplicate turn-for-turn Cursor chat mislabeled "Claude Code".
 *
 * `cursor_version` is the discriminator: Cursor stamps it on every hook payload
 * and Claude Code never sends it. Note this is the OPPOSITE move from the
 * Devin/Windsurf dual-hook fix (retagDevinFromProcess), which RE-TAGS the
 * claude-code fire as devin — correct there because Devin CLI has no separate
 * hook of its own to capture the run. Cursor does: `origin enable cursor` writes
 * ~/.cursor/hooks.json, and that fire already captures the turn correctly, so
 * the claude-code twin is pure duplicate and must be dropped. Re-tagging it
 * instead would risk double-capturing onto the REAL Cursor session (the existing
 * dual-hook dedup keys on prompt_id/turn_id, neither of which Cursor sends).
 *
 * Returns the real agent's slug when a foreign payload is detected, else null.
 */
export function detectForeignHookPayload(
  agentSlug: string | undefined,
  input: Record<string, any> | null | undefined,
): { foreignSlug: string; discriminator: string } | null {
  // Only the Claude-Code hook is hijacked this way (it's the config surface
  // other agents re-implement); never second-guess any other slug.
  if (agentSlug !== 'claude-code' && agentSlug !== 'claude') return null;
  if (!input || typeof input !== 'object') return null;
  if (typeof input.cursor_version === 'string' && input.cursor_version) {
    return { foreignSlug: 'cursor', discriminator: 'cursor_version' };
  }
  return null;
}

export async function hooksCommand(event: string, agentSlug?: string): Promise<void> {
  // FIX 1 — Codex capture hooks must ALWAYS exit 0.
  //
  // Codex reads our stdout for context injection but treats a non-zero exit as
  // a FAILED hook and surfaces a red "SessionStart hook (failed) / hook exited
  // with code 1" on the user's turn — even when the capture actually succeeded
  // and the session reached the dashboard. Capture is best-effort and must
  // never fail or decorate the user's turn with an error.
  //
  // Root cause of the stray non-zero: `program.parse()` (index.ts) runs command
  // actions WITHOUT awaiting them, so any promise rejection escaping this async
  // handler — a late throw after capture completed, a rejected fire-and-forget,
  // or a detached-spawn error — becomes an `unhandledRejection`, which Node
  // (>=15) turns into process exit code 1. Running the command manually with an
  // empty `{}` payload happens to take a code path that never throws, which is
  // why it exits 0 by hand but 1 under a real Codex payload.
  //
  // Neutralize this for CODEX ONLY. Other agents keep exact exit semantics —
  // notably the intentional `process.exit(2)` budget/session-limit blocks, which
  // are gated on BUDGET_BLOCKING_AGENTS (claude-code, gemini) and so never fire
  // for codex anyway. stdout (context injection) is untouched; only the exit
  // code is forced to 0.
  if (agentSlug === 'codex') {
    const forceZero = (why: string) => (err: any) => {
      try {
        debugLog(event, `codex hook: swallowed ${why} — forcing exit 0 (capture is best-effort)`, {
          message: err?.message || String(err),
          stack: err?.stack,
        });
      } catch { /* debug log must never itself break the hook */ }
      process.exitCode = 0;
    };
    // Guard against late/detached rejections that surface AFTER this handler
    // returns (index.ts never awaits us). Without these, Node exits 1.
    process.on('unhandledRejection', forceZero('unhandledRejection'));
    process.on('uncaughtException', forceZero('uncaughtException'));
    try {
      await runHookEvent(event, agentSlug);
    } catch (err: any) {
      forceZero('thrown error')(err);
    }
    process.exitCode = 0;
    return;
  }
  await runHookEvent(event, agentSlug);
}

async function runHookEvent(event: string, agentSlug?: string): Promise<void> {
  debugLog(event, '=== HOOK INVOKED ===', { pid: process.pid, argv: process.argv, cwd: process.cwd() });

  // Select the SQLite backend once (sqlite3 CLI on mac/linux, in-process
  // sql.js on native Windows) so the synchronous Cursor/Codex model readers
  // downstream have a backend ready. Cheap + idempotent; a failure just leaves
  // model detection degraded, exactly as on a Windows box without sqlite3.
  await ensureSqlite();

  // Opportunistic Devin Desktop sync. Desktop fires no hooks, so we piggyback
  // on any Origin hook to push its (metadata-only) sessions to the dashboard.
  // Internally throttled to once per 5 min and a no-op when Devin Desktop isn't
  // installed, so this adds latency to at most one hook every few minutes.
  try { await maybeSyncDevinDesktop(); } catch { /* best-effort */ }

  // Internal: the detached agy transcript watcher. Reads its target from env,
  // not stdin, so handle it before readStdin() (which would otherwise block).
  if (agentSlug === 'antigravity' && event === '__watch') {
    await runAgyWatcher();
    return;
  }
  // Internal: agy's detached session-start stand-in (notes sync + rules-file
  // refresh). Same reason as above — env-driven, so it must not fall through to
  // readStdin(), which would block forever on a detached process with no stdin.
  if (agentSlug === 'antigravity' && event === '__refresh-context') {
    await runAgyContextRefresh();
    return;
  }

  // Self-heal duplicate registrations. Each agent has its own dedupe strategy:
  //   claude-code  — layered .claude/settings.json across user / project /
  //                  worktree layers (Claude merges all of them)
  //   cursor       — flat .cursor/hooks.json at user vs project level
  //   windsurf     — flat .windsurf/hooks.json at user vs project level
  //   gemini/codex — their settings files don't layer the same way; the
  //                  installer already dedupes on write, so skip here.
  // All paths are cheap (2-3 stat calls + maybe one read) and only write
  // when a duplicate actually exists.
  if (agentSlug === 'claude-code') {
    try { dedupeOriginHookLayers(event); } catch (err: any) {
      debugLog(event, 'dedupe check failed (non-fatal)', { message: err?.message });
    }
  } else if (agentSlug === 'cursor') {
    try { dedupeAgentFlatHooks(event, '.cursor', 'cursor'); } catch (err: any) {
      debugLog(event, 'cursor dedupe check failed (non-fatal)', { message: err?.message });
    }
  }
  // devin — .devin/hooks.v1.json (Claude-Code shape, not the flat Cascade
  // format dedupeAgentFlatHooks expects); the installer dedupes on write, so
  // no self-heal branch here.

  const input = await readHookInput();

  // ── Dual-hook collision guard ───────────────────────────────────────────
  // Bail BEFORE any handler runs (and before the queue drains below touch the
  // network) when this claude-code invocation is really another agent's turn
  // arriving through ~/.claude/settings.json. The agent's own hook captures it.
  const foreign = detectForeignHookPayload(agentSlug, input);
  if (foreign) {
    debugLog(event, `ABORT: ${foreign.foreignSlug} payload on the ${agentSlug} hook (dual-hook collision)`, {
      discriminator: foreign.discriminator,
      sessionId: input.session_id,
      model: input.model,
      cwd: process.cwd(),
    });
    debugLog(event, '=== HOOK COMPLETE ===');
    return;
  }

  // The Copilot CLI delivers its hook payload in camelCase (sessionId,
  // transcriptPath, stopReason); the rest of this pipeline is Claude-Code-shaped
  // and reads snake_case. Normalize the fields we depend on so session identity
  // and transcript discovery work without special-casing every read site.
  // (prompt / cwd share the same name across both.)
  if (agentSlug === 'copilot') {
    if (input.session_id == null && input.sessionId != null) input.session_id = input.sessionId;
    if (input.transcript_path == null && input.transcriptPath != null) input.transcript_path = input.transcriptPath;
    if (input.stop_reason == null && input.stopReason != null) input.stop_reason = input.stopReason;
    // Copilot wraps the user's prompt in its own envelope blocks — a
    // <copilot_tauri_workspace>/<copilot_working_context>/<copilot_artifacts>/
    // <branch_rename_request> preamble on the FIRST prompt of a Desktop chat,
    // <system_notification> reminders ("call rename_session") on later ones.
    // Strip them all: what we store has to equal the transcript's clean text,
    // or reconcilePromptHistory() loses the overlap and starts concatenating
    // the whole history onto itself every turn. See stripCopilotEnvelopes().
    if (typeof input.prompt === 'string') {
      input.prompt = stripCopilotEnvelopes(input.prompt);
    }
    // Log the transcript shape (path + head) so we can wire Copilot response/tool
    // capture to its actual on-disk format (undocumented — needs a real sample).
    let transcriptInfo: Record<string, any> = { path: input.transcript_path || null };
    try {
      if (input.transcript_path && fs.existsSync(input.transcript_path)) {
        transcriptInfo = { path: input.transcript_path, exists: true, head: fs.readFileSync(input.transcript_path, 'utf-8').slice(0, 500) };
      } else {
        transcriptInfo.exists = false;
      }
    } catch (err: any) { transcriptInfo.err = err?.message; }
    debugLog(event, 'copilot payload', { keys: Object.keys(input), hasSession: !!input.session_id, hasPrompt: !!input.prompt, transcript: transcriptInfo });
  }

  // Antigravity (agy) has its own event set + payload shape — handle it on a
  // dedicated path instead of the SessionStart-based handlers below.
  if (agentSlug === 'antigravity') {
    await handleAntigravity(event, input);
    debugLog(event, '=== HOOK COMPLETE ===');
    return;
  }

  // Replay any capture uploads a previous hook failed to deliver (API down,
  // deploy window, offline). Fire-and-forget and only on the slow lifecycle
  // events — pre-tool-use/user-prompt-submit stay latency-clean.
  if (event === 'session-start' || event === 'stop' || event === 'session-end') {
    drainUpdateQueue((e, m, d) => debugLog(e, m, d)).catch(() => {});
  }

  // Devin writes its ATIF transcript only when a CONVERSATION ends, so a turn's
  // response / real tokens / tool count usually aren't readable at its own Stop.
  // Those turns queue themselves; drain here — by now the conversation that
  // produced them has ended and its transcript exists on disk. Deliberately NOT
  // gated on agentSlug: Devin fires the claude-code hooks, and a queue that is
  // empty (the common case, and every non-Devin user) costs one failed readdir.
  if (event === 'session-start' || event === 'stop' || event === 'session-end') {
    try {
      const res = await drainDevinBackfills(
        (id, data) => api.updateSession(id, data),
        { log: (m, d) => debugLog(event, m, d) },
      );
      if (res.patched > 0 || res.expired > 0) {
        debugLog(event, 'devin backfill drain', res);
      }
    } catch { /* never break the hook */ }
  }

  switch (event) {
    case 'session-start':
      await handleSessionStart(input, agentSlug);
      break;
    case 'user-prompt-submit':
      // Copilot ONLY: it blocks the user's prompt until this hook exits, and the
      // capture path below takes 6-14s — so run it detached and return instantly
      // (the child re-enters here with ORIGIN_HOOK_BG=1 and runs it inline). Any
      // spawn failure falls through to the normal synchronous path. Every other
      // agent is unaffected.
      if (agentSlug === 'copilot' && process.env.ORIGIN_HOOK_BG !== '1') {
        try {
          spawnBackgroundHook(agentSlug, event, input);
          debugLog(event, 'copilot: dispatched to background (non-blocking)');
          break;
        } catch (err: any) {
          debugLog(event, 'copilot background dispatch failed — running inline', { message: err?.message });
        }
      }
      await handleUserPromptSubmit(input, agentSlug);
      break;
    case 'stop':
      await handleStop(input, agentSlug);
      break;
    case 'session-end':
      await handleSessionEnd(input, agentSlug);
      break;
    case 'pre-tool-use':
      await handlePreToolUse(input, agentSlug);
      break;
    case 'post-tool-use':
      await handlePostToolUse(input, agentSlug);
      break;
    case 'after-file-edit':
      await handleAfterFileEdit(input, agentSlug);
      break;
    default:
      debugLog(event, 'unknown event');
      process.stderr.write(`[origin] unknown hook event: ${event}\n`);
  }

  debugLog(event, '=== HOOK COMPLETE ===');
}
