import { loadConfig, saveConfig, loadAgentConfig, saveAgentConfig, loadRepoConfig, isConnectedMode, ensureConfigDir } from '../config.js';
import { isRepoIgnored, matchIgnoredRepo } from '../ignore-repos.js';
import { decidePushBlock } from '../push-block.js';
import crypto from 'crypto';
import { detectTools } from '../tools-detector.js';
import { api, readAuthStatus } from '../api.js';
import { isSkippedScanPath, isNonSecretAssignmentValue } from '../secret-rules.js';
import { parseTranscript, estimateCost, formatTranscriptForDisplay, extractPromptFileMappings, setActivePricing, readCopilotModel, stripCopilotEnvelopes, scopeCapturedPath, buildDiffFromEdits } from '../transcript.js';
import { uploadPromptImages, applyImageDescriptions } from '../prompt-images.js';
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
import { capCommitMessage, captureGitState, captureAgyDiff, getDirtyFiles, createShadowCommit, commitDiffScopedToPrompt, filesChangedSinceShadow, readFileAtRev, gitIgnoredFiles, MAX_PROMPT_DIFF_LEN } from '../git-capture.js';
import { capDiff, fitDiffToBudget } from '../diff-budget.js';
import { finalHunksForCaptures } from '../final-state-blame.js';
import { parseAntigravityTranscript, estimateAntigravityUsage, agyArgs } from '../antigravity-transcript.js';
import { claudeSessionName, cursorSessionName } from '../agent-session-name.js';
import { outOfRepoWrites, samePath as samePathNormalized, isInsideRepo as isInsideRepoNormalized, toRepoRelativePath } from '../paths.js';
// Moved to ./hooks/git-hooks.ts — imported for the dispatcher, re-exported so
// every existing `from './commands/hooks.js'` import keeps resolving.
import { GENERIC_ASSIGNMENT_RULES, PRE_COMMIT_PATTERNS, buildOriginTrailers, handleGitPostCheckout, handleGitPostMerge, handlePreCommit, handlePrePush, handlePrepareCommitMsg, isNullRef, mapFindingSeverity, matchGlobPreCommit, parseStagedDiffLines, pickActiveSessionForCommit, policyAppliesToCommit, preCommitBudgetDecision, sessionTouchedFiles, stagedCommitFiles } from './hooks/git-hooks.js';
// Moved to ./hooks/post-commit.ts — imported for the dispatcher, re-exported so
// every existing `from './commands/hooks.js'` import keeps resolving.
import { RECENCY_TIEBREAK_MARGIN_MS, commitTurnContentUnit, countDiffSignLines, excludeSessionsFromOtherTrees, filesNamedInDiff, gitCommitDate, handlePostCommit, inFlightEditedFiles, listSessionsForGitHook, listSessionsForGitHookUnscoped, pathNamesSession, pickCommitUpdateTargets, pickIdleOwnerByFileEvidence, pickRecentDevinSessionForRepo, pickSessionByFileOverlap, pickSessionForCommit, pinCodexCommitToProducer, resolvePromptForCommit, safePgrep, sessionDurationMs, sessionToDateCommittedSnapshot, sessionTouchedAnyCommitFile, sessionTrees, uniquePgrepMatch, worksInAnotherTree } from './hooks/post-commit.js';
// Moved to ./hooks/after-file-edit.ts — imported for the dispatcher, re-exported so
// every existing `from './commands/hooks.js'` import keeps resolving.
import { EDIT_HOOK_TOOL, adoptUnannouncedPrompts, buildLiveEditPromptChanges, cursorTranscriptPrompts, handleAfterFileEdit, resolveAfterFileEditCwd } from './hooks/after-file-edit.js';
// Moved to ./hooks/tool-use.ts — imported for the dispatcher, re-exported so
// every existing `from './commands/hooks.js'` import keeps resolving.
import { LIVE_EDIT_MAX_ENTRIES, MAX_DISCOVERED_WORKTREES, PENDING_WRITE_MAX, SHELL_COMMAND_MAX, SHELL_PROBE_MAX_PENDING, attachReposForFiles, beginShellProbe, discoverWorkTreesFromCommand, endShellProbe, enforceFileRestrictions, extractFilePaths, handlePostToolUse, handlePreToolUse, matchGlob, noteShellWriteTurn, probeDepsFor, recordLiveEdits, toolCallFailed, treesToProbe } from './hooks/tool-use.js';
// Moved to ./hooks/session-start.ts — imported for the dispatcher, re-exported so
// every existing `from './commands/hooks.js'` import keeps resolving.
import { ADOPT_IDLESS_MAX_AGE_MS, ORIGIN_FRAMEWORK_MARKER, agentFileCarriesFramework, agentReadsContextFromHook, durableRulesFileMessage, emitVisiblePreamble, expireStaleSessionsOnServer, handleSessionStart, maybeSpawnHistorySync, maybeSpawnMemoryBriefBackfill, resolveCodexThreadId, resumeBaseFromTranscript, resumeSeedApplies, selectReusableSession } from './hooks/session-start.js';
// Moved to ./hooks/user-prompt-submit.ts — imported for the dispatcher, re-exported so
// every existing `from './commands/hooks.js'` import keeps resolving.
import { SESSION_START_RECENT_SHAS, budgetLockoutDecision, buildContextInjectionPayload, contextInjectionStampPath, conversationAnchorId, cursorSessionReusable, enforceBudgetLockout, enforceSessionDurationLimit, fullContextAlreadyInjected, handleUserPromptSubmit, noteCheckoutContention, recordFullContextInjection, recordWorkTreeBaseline, retroactiveTurnFiles, selectRecoverableArchiveSession, stateMatchesIncomingChat } from './hooks/user-prompt-submit.js';
// Moved to ./hooks/stop.ts — imported for the dispatcher, re-exported so
// every existing `from './commands/hooks.js'` import keeps resolving.
import { SHELL_PROBE_TOOL, WRITE_JOURNAL_TOOL, applyBudgetSignal, baselineShaForTree, buildSubagentSummary, dropForeignCommitsFromCapture, durableUpdate, excludeUntouchedSessionStartDirt, fileNamedInCommand, filesOwnedByTurn, getCursorConversationSummary, handleStop, isInsideRepo, isSessionGoneError, journalFilesForTurn, keepRicherTurnCapture, normalizeTurnFiles, ownedRangeCommitShas, recordJournalEdits, recordProbedShellEdits, resolveAutoAgentSessionId, rewrittenCommitsPayload, serverRowForLocalTurn, sessionFilesFromRangeCapture, shouldAutoSnapshot, warnIfSpawnerRenamed } from './hooks/stop.js';
// Moved to ./hooks/session-end.ts — imported for the dispatcher, re-exported so
// every existing `from './commands/hooks.js'` import keeps resolving.
import { CAPTURE_ID, applyLedgerCaptures, applyLiveLedger, buildMemoryEntry, buildPromptNoteEntries, buildSessionWriteData, captureStamp, describePromptImages, durableEnd, ensureServerSession, getWorkingTreeSha, handleSessionEnd, localTurnForServerRow, mergeFilesRead, mergePromptMappings, nestedRepoFilesWritten, nestedRepoWritesForOpenTurn, outOfRepoFilesFor, outOfRepoFilesFromEditsJson, promptMappingHasContent, recordDiscoveredWorkTreeEdits, repoRemoteUrl, resolveAgentSessionName, scheduleMemoryBriefRefresh, scopeSessionDiffToStart, sessionRepoRoots, spawnMemoryBriefChild, summarizePromptPayload, turnBaselineForServerRow, turnIdFor, withDerivedLineCounts } from './hooks/session-end.js';
export { CAPTURE_ID, applyLedgerCaptures, applyLiveLedger, buildMemoryEntry, buildPromptNoteEntries, buildSessionWriteData, captureStamp, describePromptImages, durableEnd, ensureServerSession, getWorkingTreeSha, handleSessionEnd, localTurnForServerRow, mergeFilesRead, mergePromptMappings, nestedRepoFilesWritten, nestedRepoWritesForOpenTurn, outOfRepoFilesFor, outOfRepoFilesFromEditsJson, promptMappingHasContent, recordDiscoveredWorkTreeEdits, repoRemoteUrl, resolveAgentSessionName, scheduleMemoryBriefRefresh, scopeSessionDiffToStart, sessionRepoRoots, spawnMemoryBriefChild, summarizePromptPayload, turnBaselineForServerRow, turnIdFor, withDerivedLineCounts };

export { SHELL_PROBE_TOOL, WRITE_JOURNAL_TOOL, applyBudgetSignal, baselineShaForTree, buildSubagentSummary, dropForeignCommitsFromCapture, durableUpdate, excludeUntouchedSessionStartDirt, fileNamedInCommand, filesOwnedByTurn, getCursorConversationSummary, handleStop, isInsideRepo, isSessionGoneError, journalFilesForTurn, keepRicherTurnCapture, normalizeTurnFiles, ownedRangeCommitShas, recordJournalEdits, recordProbedShellEdits, resolveAutoAgentSessionId, rewrittenCommitsPayload, serverRowForLocalTurn, sessionFilesFromRangeCapture, shouldAutoSnapshot, warnIfSpawnerRenamed };

export { SESSION_START_RECENT_SHAS, budgetLockoutDecision, buildContextInjectionPayload, contextInjectionStampPath, conversationAnchorId, cursorSessionReusable, enforceBudgetLockout, enforceSessionDurationLimit, fullContextAlreadyInjected, handleUserPromptSubmit, noteCheckoutContention, recordFullContextInjection, recordWorkTreeBaseline, retroactiveTurnFiles, selectRecoverableArchiveSession, stateMatchesIncomingChat };

export { ADOPT_IDLESS_MAX_AGE_MS, ORIGIN_FRAMEWORK_MARKER, agentFileCarriesFramework, agentReadsContextFromHook, durableRulesFileMessage, emitVisiblePreamble, expireStaleSessionsOnServer, handleSessionStart, maybeSpawnHistorySync, maybeSpawnMemoryBriefBackfill, resolveCodexThreadId, resumeBaseFromTranscript, resumeSeedApplies, selectReusableSession };

export { LIVE_EDIT_MAX_ENTRIES, MAX_DISCOVERED_WORKTREES, PENDING_WRITE_MAX, SHELL_COMMAND_MAX, SHELL_PROBE_MAX_PENDING, attachReposForFiles, beginShellProbe, discoverWorkTreesFromCommand, endShellProbe, enforceFileRestrictions, extractFilePaths, handlePostToolUse, handlePreToolUse, matchGlob, noteShellWriteTurn, probeDepsFor, recordLiveEdits, toolCallFailed, treesToProbe };

export { EDIT_HOOK_TOOL, adoptUnannouncedPrompts, buildLiveEditPromptChanges, cursorTranscriptPrompts, handleAfterFileEdit, resolveAfterFileEditCwd };

export { RECENCY_TIEBREAK_MARGIN_MS, commitTurnContentUnit, countDiffSignLines, excludeSessionsFromOtherTrees, filesNamedInDiff, gitCommitDate, handlePostCommit, inFlightEditedFiles, listSessionsForGitHook, listSessionsForGitHookUnscoped, pathNamesSession, pickCommitUpdateTargets, pickIdleOwnerByFileEvidence, pickRecentDevinSessionForRepo, pickSessionByFileOverlap, pickSessionForCommit, pinCodexCommitToProducer, resolvePromptForCommit, safePgrep, sessionDurationMs, sessionToDateCommittedSnapshot, sessionTouchedAnyCommitFile, sessionTrees, uniquePgrepMatch, worksInAnotherTree };
export type { FileEvidenceSession } from './hooks/post-commit.js';

export { GENERIC_ASSIGNMENT_RULES, PRE_COMMIT_PATTERNS, buildOriginTrailers, handleGitPostCheckout, handleGitPostMerge, handlePreCommit, handlePrePush, handlePrepareCommitMsg, isNullRef, mapFindingSeverity, matchGlobPreCommit, parseStagedDiffLines, pickActiveSessionForCommit, policyAppliesToCommit, preCommitBudgetDecision, sessionTouchedFiles, stagedCommitFiles };
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
import { writeSessionFiles, pushSessionBranch, reconcileSessionBranchWithRemote, type PromptEntry, type PromptChange, type SessionWriteData } from '../local-entrypoint.js';
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
  dropSessionMirror,
} from '../session-state.js';
import { sessionWorkTree, shellWindowTarget, samePath, candidateDirsFromCommand, worktreesAmongCandidates } from '../session-worktree.js';
import { probeTree, touchedSince, type TreeProbe } from '../shell-command-probe.js';
import { readJournal, compactJournal, startWriteJournal, markTurn, readJournalEntries, journalPathsForTag, JOURNAL_WATCH_LOCK_STALE_MS } from '../write-journal-watch.js';
import { applyLedgerToMappings } from '../capture-from-ledger.js';
import { isSubagentSpawnTool, detectRenamedSpawner, SUBAGENT_SPAWN_TOOLS } from '../subagent-tools.js';
import { detectContention, contentionAdvice } from '../checkout-contention.js';
import { filesWrittenDuring, turnIdsInJournal } from '../write-journal.js';
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
  // A correction is a LATER, narrower reading of a row already sent; stamped
  // now so the server ranks it above the row it corrects rather than treating
  // an unstamped payload as exempt from ordering.
  const captureStamp = newCaptureStamp('agyc');
  const out: AgyPromptCorrection[] = [];
  for (const pc of (promptChanges || [])) {
    const files = asArray(pc.filesChanged);
    if (files.length === 0) continue;
    const scoped = scopeAgyDiffToSessionEdits(repoPath, files, pc.diff || '', pc.linesAdded || 0, pc.linesRemoved || 0, filesEditedAbs);
    if (scoped.dropped.length === 0) continue;   // nothing foreign on this prompt
    out.push({
      ...captureStamp,
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
      ...captureStamp,
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
export const PENDING_WRITE_TTL_MS = 5 * 60 * 1000;

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
export function isRewriteOf(repoPath: string, orphan: string, candidate: string): boolean {
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

/** Same subject line on both commits — what an amend that only folded in a
 *  forgotten file or re-touched the body leaves intact. */
function sameSubject(repoPath: string, a: string, b: string): boolean {
  const sa = commitShape(repoPath, a);
  const sb = commitShape(repoPath, b);
  return !!sa && !!sb && sa.subject === sb.subject;
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
  // Every sha this session's own post-commit hook recorded, full-length and
  // lower-cased so a candidate from `git log` compares directly.
  const ownedShas = new Set<string>();
  for (const s of state.sessionCommitShas) {
    if (/^[a-fA-F0-9]{40}$/.test(s)) ownedShas.add(s.toLowerCase());
  }
  const turnOf = new Map<string, string>();
  for (const c of state.commitTurns || []) {
    if (!c || typeof c.sha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(c.sha)) continue;
    ownedShas.add(c.sha.toLowerCase());
    if (typeof c.turnId === 'string' && c.turnId) turnOf.set(c.sha.toLowerCase(), c.turnId);
  }
  // This session's own commit, filed under the SAME turn as the orphan when
  // the turn ledger knows both — an amend lands in the turn that made the
  // original. Two owned commits on one parent under DIFFERENT turns is a
  // reset-and-recommit across turns, which is not one commit rewritten; that
  // case is left to the subject and shape rules.
  const ownedSameTurn = (orphan: string, candidate: string): boolean => {
    const c = candidate.toLowerCase();
    if (!ownedShas.has(c)) return false;
    const to = turnOf.get(orphan.toLowerCase());
    const tc = turnOf.get(c);
    return to && tc ? to === tc : true;
  };
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
        if (parents[0] !== parent) continue;
        // `isRewriteOf` was written for a REBASE, where the copy keeps the
        // subject and the exact path set. An amend keeps neither: the point
        // of `git commit --amend` is usually to fold one more file or fix
        // the message. Prod vodka 5adc4b18 amended a 3-file commit into a
        // 4-file one — same parent, same subject, one extra path — and the
        // rescue found no rewrite, so the orphan stayed owned: the turn read
        // "2 commits total +996/-4" for +509/-3 of work and the session
        // header counted shelf.py twice.
        //
        // Same parent is the amend's signature; on top of it, EITHER of two
        // facts settles ownership without a shape match: this session
        // recorded the candidate itself (post-commit filed both under the
        // same turn — nobody else's commit gets into sessionCommitShas), or
        // the subject survived. Neither can reach a concurrent session's
        // commit: that one is not in our list, and the rescue's founding
        // rule — never add a sha we did not already own — still holds
        // because the candidate replaces an entry, it is never appended.
        if (isRewriteOf(repoPath, sha, candidate)
          || ownedSameTurn(sha, candidate)
          || sameSubject(repoPath, sha, candidate)) {
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
  // A SQUASH: `git reset --soft HEAD~N` and one new commit. No hook fires for
  // the reset, and neither rung above can see it — the new commit is not a
  // rewrite of ANY one orphan (its patch-id and file set are the union of
  // several). Prod vodka 944f7048: two commits, reset, one commit; the two
  // orphans stayed owned, the turn chip read "3 commits total +260/-72" for
  // +130/-36 of work and the header counted four commits for two.
  //
  // The shape is exact and cheap to test: a run of orphans chained by
  // parentage, and a reachable commit whose PARENT is the run's parent and
  // whose TREE is the run's last tree — the same end state, one commit.
  {
    const revParse = (spec: string): string => {
      try { return execFileSync('git', ['rev-parse', '--verify', '--quiet', spec], gitOpts).toString().trim(); } catch { return ''; }
    };
    // Every orphan, INCLUDING ones the amend rung already mapped: the head
    // of a reset-squashed run sits on the same parent as the squash and the
    // amend rung claims it first, and a chain walk that skipped it could no
    // longer reach the run's later members — they would stay owned.
    const orphans = state.sessionCommitShas.filter((sha) => {
      if (!/^[a-fA-F0-9]{7,40}$/.test(sha)) return false;
      try { execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], gitOpts); return false; } catch { return true; }
    });
    const orphanFull = new Map<string, string>();
    for (const o of orphans) { const full = revParse(`${o}^{commit}`); if (full) orphanFull.set(o, full); }
    const shortByFull = new Map<string, string>();
    for (const [o, full] of orphanFull) shortByFull.set(full, o);
    const parentOf = (full: string): string => revParse(`${full}^`);
    for (const o of orphans) {
      if (!orphanFull.has(o)) continue;
      // Only a run's HEAD starts a walk: an orphan whose parent is itself an
      // orphan is reached from that parent.
      const parentShort = shortByFull.get(parentOf(orphanFull.get(o)!));
      if (parentShort && orphanFull.has(parentShort)) continue;
      // Walk the run forward: o, then any orphan whose parent is the previous.
      const run: string[] = [o];
      let tip = orphanFull.get(o)!;
      for (let grew = true; grew;) {
        grew = false;
        for (const [full, short] of shortByFull) {
          if (run.includes(short)) continue;
          if (parentOf(full) === tip) { run.push(short); tip = full; grew = true; break; }
        }
      }
      // A single orphan the amend rung already placed is not a run to squash.
      if (run.length === 1 && replacements.has(o)) continue;
      const base = parentOf(orphanFull.get(o)!);
      const endTree = revParse(`${tip}^{tree}`);
      if (!base || !endTree) continue;
      const squash = reachablePool.find((candidate) =>
        !claimed.has(candidate) && !shortByFull.has(candidate)
        && parentOf(candidate) === base && revParse(`${candidate}^{tree}`) === endTree);
      if (!squash) continue;
      for (const member of run) replacements.set(member, squash);
      claimed.add(squash);
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
  // Remember the pairs, for the server. Dropping the orphan locally is only
  // half the job: the server merges sha lists by union and keeps the orphan's
  // Commit row on the session unless told which sha replaced it.
  const rewritten = Array.isArray(state.rewrittenCommits) ? [...state.rewrittenCommits] : [];
  const known = new Set(rewritten.map((r) => r.from));
  for (const [from, to] of replacements) {
    if (!known.has(from)) { rewritten.push({ from, to }); known.add(from); }
  }
  state.rewrittenCommits = rewritten;
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

/**
 * Which of these commits are MERGES, from one git process instead of one per
 * commit.
 *
 * Every caller below has to ask that question before it can render a commit,
 * because a merge takes the `mergeOwnDiff` path and everything else takes
 * `git show`. Asking it per commit — which is what `mergeOwnDiff` ->
 * `commitParents` does — is a `git rev-list` spawn per sha, and these walks run
 * over the session's WHOLE commit list on every post-commit, and paid again on
 * the next commit. Batching both halves takes that walk from 781ms to 442ms at
 * 30 commits on this repo, and from 1572ms to 955ms at 60.
 *
 * `--no-walk=unsorted` is what keeps the answer addressable: it emits one line
 * per named commit, in the order asked, and nothing else. The plain `--no-walk`
 * would re-sort by commit date, and a walk would print ancestors we never asked
 * about.
 *
 * `--ignore-missing` matters more than it looks. `sessionCommitShas` can hold a
 * sha a rebase rewrote away, and without it ONE such entry makes git exit
 * non-zero and the whole list goes unclassified. The map is therefore allowed
 * to be PARTIAL: a sha with no entry falls through to the per-commit path,
 * which is what it needs anyway — that path already answers '' for a commit
 * that no longer exists.
 */
function commitParentCounts(repoPath: string, shas: string[]): Map<string, number> | null {
  if (shas.length === 0) return new Map();
  let out: string;
  try {
    out = execFileSync(
      'git',
      ['rev-list', '--ignore-missing', '--no-walk=unsorted', '--parents', ...shas],
      { windowsHide: true, cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 },
    ).toString();
  } catch { return null; /* git unusable here; caller keeps the per-sha path */ }
  // "<full sha> <parent>…" per line. Callers hold ABBREVIATED shas, so pair by
  // prefix in both directions — the same match `sessionScopedCommittedDiff`
  // uses against rev-list output a few lines down.
  const rows: Array<{ full: string; parents: number }> = [];
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || !/^[a-fA-F0-9]{40}$/.test(parts[0])) continue;
    rows.push({ full: parts[0].toLowerCase(), parents: parts.length - 1 });
  }
  const counts = new Map<string, number>();
  for (const sha of shas) {
    const s = sha.toLowerCase();
    const row = rows.find((r) => r.full === s || r.full.startsWith(s));
    if (row) counts.set(sha, row.parents);
  }
  return counts;
}

/**
 * `git show` over many commits in one process — exactly what git does with
 * several revs, so the content is the per-commit outputs concatenated.
 *
 * It is not quite byte-identical to the loop it replaces, and the difference is
 * worth naming. That loop `.trim()`ed EACH commit's output before joining, so a
 * commit whose diff ended on a blank CONTEXT line (a bare " ") lost that line.
 * Batched, it survives. Over 30 commits of this repo's own history that is the
 * whole of the difference: 2 lines, both blank context, with the +/- counts and
 * all 160 `diff --git` sections identical and in the same order. Keeping them is
 * the more faithful rendering — a trimmed hunk is one context line short of
 * what git wrote — and nothing downstream counts or splits on them.
 *
 * Returns null if the batch fails, so the caller can retry the run one sha at a
 * time and still skip only the sha a rebase removed.
 */
function showCommitsBatched(repoPath: string, shas: string[], extraArgs: string[]): string | null {
  try {
    return execFileSync(
      'git',
      ['show', ...extraArgs, '--format=', '--no-color', ...shas],
      {
        windowsHide: true, cwd: repoPath, encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 64 * 1024 * 1024,
      },
    ).toString();
  } catch { return null; }
}

/** Every path the given commits touch, BOTH sides of a rename included.
 *  `--no-renames` is what makes a rename list as delete+add here; the caller's
 *  `git diff` then has both paths in its pathspec and re-detects the rename
 *  itself, instead of reporting the new path as a whole-file insertion.
 *  A merge contributes only the paths it resolved — `--name-only` on one lists
 *  nothing at all, which used to leave the pathspec silently short.
 *
 *  The result is a SET, so the non-merges are batched into one `git show`
 *  without any ordering concern. */
function ownedCommitPaths(repoPath: string, shas: string[]): string[] {
  const paths = new Set<string>();
  const valid = shas.filter((sha) => /^[a-fA-F0-9]{7,40}$/.test(sha));
  const counts = commitParentCounts(repoPath, valid);
  const plain: string[] = [];
  const addNames = (out: string) => {
    for (const line of out.split('\n')) {
      const p = line.trim();
      if (p) paths.add(p);
    }
  };
  const showOne = (sha: string) => {
    const out = showCommitsBatched(repoPath, [sha], ['--no-renames', '--name-only']);
    if (out) addNames(out);
    /* else: commit may have been removed by a rebase; skip */
  };
  for (const sha of valid) {
    // No classification (batch failed) means asking mergeOwnDiff itself, which
    // is the pre-batching behaviour for that sha and nothing more.
    const parents = counts?.get(sha);
    if (parents === undefined) {
      const merge = mergeOwnDiff(repoPath, sha);
      if (merge) { for (const p of merge.filesChanged) paths.add(p); continue; }
      showOne(sha);
      continue;
    }
    if (parents >= 2) {
      const merge = mergeOwnDiff(repoPath, sha);
      if (merge) for (const p of merge.filesChanged) paths.add(p);
      continue;
    }
    plain.push(sha);
  }
  if (plain.length > 0) {
    const out = showCommitsBatched(repoPath, plain, ['--no-renames', '--name-only']);
    // One sha a rebase removed fails the whole batch. Retry per sha so the
    // survivors still land — the old loop skipped only the missing one.
    if (out !== null) addNames(out);
    else for (const sha of plain) showOne(sha);
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
export function sessionScopedCommittedDiff(
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
  // ── Per-commit walk ───────────────────────────────────────────────────
  // Consecutive non-merges go to git in ONE `git show`; git concatenates them
  // itself, which is what the old per-sha loop was joining by hand (see
  // showCommitsBatched for the one blank-context-line difference). Runs —
  // rather than a partition — are what keep a merge in its place in the
  // sequence, which matters because every downstream consumer (the byte budget
  // above all) cuts this text in order.
  const valid = shas.filter((sha) => /^[a-fA-F0-9]{7,40}$/.test(sha));
  const counts = commitParentCounts(repoPath, valid);
  const parts: string[] = [];
  let run: string[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const batched = run.length > 1 ? showCommitsBatched(repoPath, run, []) : null;
    if (batched !== null) {
      const out = batched.trim();
      if (out) parts.push(out);
    } else {
      // A sha a rebase removed fails the whole batch; per-sha skips only it.
      for (const sha of run) {
        const out = commitOwnDiff(repoPath, sha);
        if (out) parts.push(out);
      }
    }
    run = [];
  };
  for (const sha of valid) {
    const parents = counts?.get(sha);
    if (parents === undefined || parents >= 2) {
      // Unclassified or a merge: both are exactly the old single-sha path.
      flushRun();
      const out = commitOwnDiff(repoPath, sha);
      if (out) parts.push(out);
      continue;
    }
    run.push(sha);
  }
  flushRun();
  const walked = parts.join('\n').trim();
  // The SESSION-level render (no turn baseline) still answers "what is in
  // these commits" per commit, and a `git add -A` commits whatever was already
  // lying in the tree before the session began. Drop the files the session
  // provably never changed: dirty at session start, and byte-identical at HEAD
  // to the session-start shadow. Per-turn callers pass `sinceSha` — a shadow
  // that already contains the dirt — and need nothing here.
  if (!sinceSha && walked) {
    const unchanged = preSessionDirtCommittedUnchanged(repoPath, state, filesNamedInDiff(walked));
    if (unchanged.size > 0) return dropDiffSectionsForFiles(walked, unchanged);
  }
  return walked;
}

/**
 * Files that were dirty (modified or untracked) when the session started and
 * that HEAD now holds byte-for-byte as the session-start shadow does.
 *
 * Such a file was swept into a commit — `git add -A`, "commit everything" —
 * without the session writing a line of it. Prod bc4a1438 (vodka): hello.py
 * had been untracked for weeks; the agent's commit picked it up and the
 * session header credited its ten lines as authored. The commit genuinely
 * contains the file; the SESSION did not write it.
 *
 * Compares blob ids, not content: one `ls-tree` per side over the candidate
 * paths, no file reads.
 */
export function preSessionDirtCommittedUnchanged(
  repoPath: string,
  state: { sessionStartShadowSha?: string | null; sessionStartDirtyFiles?: string[] },
  files: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  const shadow = state.sessionStartShadowSha;
  const dirty = new Set(state.sessionStartDirtyFiles || []);
  if (!shadow || !/^[a-fA-F0-9]{7,40}$/.test(shadow) || dirty.size === 0) return out;
  const candidates = [...new Set(files)].filter((f) => dirty.has(f));
  if (candidates.length === 0 || candidates.length > 500) return out;
  const blobs = (rev: string): Map<string, string> => {
    const m = new Map<string, string>();
    try {
      const text = execFileSync('git', ['ls-tree', '-r', '-z', rev, '--', ...candidates], {
        ...GIT_READ_OPTS, cwd: repoPath, maxBuffer: 16 * 1024 * 1024,
      }).toString();
      for (const entry of text.split('\0')) {
        const mm = entry.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/);
        if (mm) m.set(mm[2], mm[1]);
      }
    } catch { /* rev unreadable — treat as no match */ }
    return m;
  };
  const before = blobs(shadow);
  if (before.size === 0) return out;
  const now = blobs('HEAD');
  for (const f of candidates) {
    const a = before.get(f);
    if (a && a === now.get(f)) out.add(f);
  }
  return out;
}

/** Remove every `diff --git` section that describes one of `files`. */
export function dropDiffSectionsForFiles(diff: string, files: Set<string>): string {
  if (!diff || files.size === 0) return diff;
  const kept: string[] = [];
  for (const part of diff.split(/(?=^diff --git )/m)) {
    const m = part.match(/^diff --git a\/(.*?) b\//);
    if (m && m[1] && files.has(m[1])) continue;
    kept.push(part);
  }
  return kept.join('').trim();
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

export const GIT_READ_OPTS = {
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
export function trailerNamesAKnownSession(repoPath: string, commitBody: string, state: SessionState): boolean {
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

// ─── Session Write Helper ─────────────────────────────────────────────────

import type { ParsedTranscript, PromptFileMapping } from '../transcript.js';
// Moved to ./hooks/antigravity.ts — imported for the dispatcher, re-exported so
// every existing `from './commands/hooks.js'` import keeps resolving.
import { AGY_CACHE_MAX_AGE_MS, AGY_WATCH_LOCK_FRESH_MS, MAX_PENDING_PROMPT_CHANGES, agyDetectSessionCommit, agyEvaluatePreTool, agyGlobToRegex, agyOpenTurn, agyRulesCachePath, agySessionTag, agyToolPaths, discoverLatestAgyConversation, dropPhantomNestedRepoDeletions, handleAntigravity, mergePendingPromptChanges, pruneAgyRulesCaches, readAgyRulesCache, registerAgySessionState, spawnAgyContextRefresh, spawnAgyWatcher, writeAgyRulesCache } from './hooks/antigravity.js';
import { newCaptureStamp } from '../capture-stamp.js';
export { AGY_CACHE_MAX_AGE_MS, AGY_WATCH_LOCK_FRESH_MS, MAX_PENDING_PROMPT_CHANGES, agyDetectSessionCommit, agyEvaluatePreTool, agyGlobToRegex, agyOpenTurn, agyRulesCachePath, agySessionTag, agyToolPaths, discoverLatestAgyConversation, dropPhantomNestedRepoDeletions, handleAntigravity, mergePendingPromptChanges, pruneAgyRulesCaches, readAgyRulesCache, registerAgySessionState, spawnAgyContextRefresh, spawnAgyWatcher, writeAgyRulesCache };
export type { AgyRulesCache } from './hooks/antigravity.js';

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
/** Does the journal already carry a mark for this turn id? */
export function journalHasMark(journalPath: string, turnId: string | undefined): boolean {
  if (!turnId) return false;
  try {
    return turnIdsInJournal(readJournalEntries(journalPath)).includes(turnId);
  } catch {
    return false;
  }
}

/**
 * Open the NEXT turn in the write journal before a background prompt-submit
 * gets around to it.
 *
 * Copilot blocks the prompt on this hook, so the capture runs detached and
 * returns instantly — and the turn mark, written at the end of that capture,
 * landed 6-14s after the agent had already started writing. Everything in
 * that gap fell into the previous turn's span. This does the cheap half
 * inline: find the session, mint the id the background handler will find at
 * `prompts.length` and adopt, start the journal, mark. No network, no
 * transcript. Never throws — a miss here costs a boundary, not the prompt.
 */
export function preMarkTurnForBackgroundSubmit(agentSlug: string, input: Record<string, any>): boolean {
  try {
    const hookCwd = normalizeWorkspaceRoot(input.cwd) || process.cwd();
    const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
    if (!found?.state) return false;
    const state = found.state;
    const idx = state.prompts?.length || 0;
    if (!state.promptTurnIds) state.promptTurnIds = [];
    if (!state.promptTurnIds[idx]) {
      state.promptTurnIds[idx] = `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    }
    ensureWriteJournal(state, agentSlug);
    if (!state.writeJournalPath) return false;
    if (!journalHasMark(state.writeJournalPath, state.promptTurnIds[idx])) {
      markTurn(state.writeJournalPath, state.promptTurnIds[idx], Date.now());
    }
    saveSessionState(state, found.saveCwd, state.sessionTag);
    debugLog('user-prompt-submit', 'turn pre-marked ahead of the background capture', {
      promptIndex: idx, turnId: state.promptTurnIds[idx],
    });
    return true;
  } catch (err: unknown) {
    debugLog('user-prompt-submit', 'turn pre-mark failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

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
export function agentRulesTarget(
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
export function buildOriginFrameworkGuidance(): string {
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

// Anchor where the human-facing portion of the preamble begins. Everything
// before it (budget banner, agent system prompt) is either already surfaced
// on its own stderr line or is model-only config, not a user banner.
export const PREAMBLE_VISIBLE_ANCHOR = 'Origin: Session tracking active';

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
export const STABLE_SESSION_ID_AGENTS = ['claude-code', 'devin', 'copilot'];
export function hookLookupSessionId(sessionId: string | undefined, agentSlug?: string): string | undefined {
  return STABLE_SESSION_ID_AGENTS.includes(agentSlug || '') ? sessionId : undefined;
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
export function sameDir(a?: string | null, b?: string | null): boolean {
  return samePath(a, b);
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
export const LIVE_EDIT_CONTENT_MAX = 96 * 1024;      // hard cap on ledger entry count
// Total content-byte budget for the ledger. The state file is rewritten on
// every tool call AND re-read on every hook, so an unbounded ledger would
// drag the agent down. Past this, new edits fall back to the transcript
// capture (no data loss — the transcript still records them).
export const LIVE_EDIT_MAX_TOTAL_BYTES = 6 * 1024 * 1024;

export function liveCaptureEnabled(): boolean {
  return process.env.ORIGIN_LIVE_CAPTURE !== '0';
}

export function editContentBytes(e: { oldContent?: string; newContent?: string }): number {
  return (e.oldContent?.length || 0) + (e.newContent?.length || 0);
}

// Rough content-byte size of the existing ledger. Bounded by the entry cap,
// so this stays cheap (a few thousand string-length reads at worst).
export function liveLedgerBytes(state: SessionState): number {
  let n = 0;
  for (const entry of state.liveEdits || []) {
    for (const e of entry.edits) n += editContentBytes(e);
  }
  return n;
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
export function currentSessionWorkTree(state: SessionState): string {
  try {
    return sessionWorkTree(state.repoPath, state.lastCwd, {
      gitRoot: getWorkingGitRoot,
      gitCommonDir: getGitCommonDir,
    });
  } catch {
    return state.repoPath || '';
  }
}

// Agents that expose a per-tool or per-edit hook. They already produce
// evidence, so the journal is redundant cost for them; everything else has
// only the turn window and is exactly who the journal exists for.
/**
 * Escape hatch: `ORIGIN_WRITE_JOURNAL=0` turns the watcher off entirely.
 *
 * The journal costs one hash and one deduped write per observed file change,
 * debounced, with build output and `.git` excluded. That is small, but it is
 * not nothing on a very large repo, and a user who hits a pathological case
 * needs a way out that does not involve downgrading. Capture then falls back to
 * the pre-ledger behaviour, which is exactly what every session ran on before.
 */
function writeJournalDisabled(): boolean {
  const v = String(process.env.ORIGIN_WRITE_JOURNAL ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off';
}

/** How long a journal watcher stays alive with no session activity. */
const JOURNAL_WATCH_IDLE_MS = 30 * 60 * 1000;

/**
 * Make sure a write-journal watcher is running for this session.
 *
 * Runs for EVERY agent as of stage 2. It used to skip agents that emit
 * per-tool hooks (claude-code, cursor, gemini, antigravity) because the journal
 * existed only to give hookless agents something better than the turn window.
 * That reasoning does not survive the ledger: a tool hook says a file was
 * edited, the ledger says what its content BECAME, and only the second lets a
 * turn's diff be read instead of reconstructed. Agents with hooks have exactly
 * the same cumulative-diff and stale-baseline defects — stage 0 measured them
 * on claude-code and cursor sessions.
 *
 * Hooks are short-lived processes, so the watcher has to be detached and
 * outlive them — the same shape as the agy transcript watcher. A lock file
 * whose mtime the watcher refreshes keeps one per session; a lock older than
 * the refresh interval is treated as a dead watcher and replaced.
 *
 * Best-effort throughout: if the spawn fails, or the platform cannot watch
 * recursively, the session simply keeps the turn window it always had.
 */
export function ensureWriteJournal(state: SessionState, agentSlug: string | undefined): boolean {
  try {
    const repoPath = currentSessionWorkTree(state) || state.repoPath;
    if (!repoPath) return false;
    const tag = state.sessionTag || state.sessionId.slice(0, 12);
    const paths = ensureDetachedJournalWatcher(tag, repoPath);
    if (!paths) return false;
    const { journalPath, snapshotDir } = paths;

    let mutated = false;
    // samePath, not !==: this is built from os.homedir(), which can come back
    // in short form on one run and long form on another. Raw inequality would
    // rewrite the state file every hook for no reason.
    if (!samePath(state.writeJournalPath, journalPath)) {
      state.writeJournalPath = journalPath;
      mutated = true;
    }
    if (!samePath(state.writeSnapshotDir, snapshotDir)) {
      state.writeSnapshotDir = snapshotDir;
      mutated = true;
    }
    return mutated;
  } catch (err: unknown) {
    debugLog('journal', 'write-journal watcher spawn failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The detached watcher, keyed on a session TAG rather than a SessionState.
 *
 * Split out of ensureWriteJournal so a producer that keeps no SessionState —
 * the Antigravity handler, which has only its per-conversation cache — can
 * ask for the same watcher under the same tag derivation. Returns the journal
 * paths (whether a watcher was spawned or one was already live), or null when
 * journalling is off for this process.
 */
export function ensureDetachedJournalWatcher(
  tag: string,
  repoPath: string,
): { journalPath: string; snapshotDir: string } | null {
  try {
    if (!liveCaptureEnabled()) return null;
    if (writeJournalDisabled()) return null;
    if (!tag || !repoPath) return null;
    if (process.env.ORIGIN_JOURNAL_IS_WATCHER === '1') return null;

    const dir = path.join(os.homedir(), '.origin', 'journals');
    // Derived in ONE place so every reader resolves the same two paths.
    const { journalPath, snapshotDir, lockPath } = journalPathsForTag(tag);
    fs.mkdirSync(dir, { recursive: true });
    const paths = { journalPath, snapshotDir };

    // A fresh lock means a live watcher; anything older is a corpse.
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age <= JOURNAL_WATCH_LOCK_STALE_MS) return paths;
    } catch { /* no lock — spawn */ }

    // Same as every other detached spawn here: re-invoke this very script.
    const bin = process.argv[1];
    if (!bin) return paths;
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
        ORIGIN_JOURNAL_SNAPSHOTS: snapshotDir,
      },
    });
    child.unref();
    // Claim the lock NOW, on the child's behalf. The watcher refreshes it on
    // a 15s timer, and its FIRST write used to be the first tick — so every
    // hook that fired inside those 15 seconds (a tool call, an adopted turn,
    // a pre-mark) found no lock and spawned another watcher. Two watchers on
    // one journal append every write twice, and each one's compaction
    // rewrites the file under the other. Seen on the Cursor e2e: two spawns
    // two seconds apart.
    try { if (lockPath) fs.writeFileSync(lockPath, String(child.pid || 0)); } catch { /* the child will write it */ }
    debugLog('journal', 'write-journal watcher spawned', { repoPath, journalPath, pid: child.pid });
    return paths;
  } catch (err: unknown) {
    debugLog('journal', 'write-journal watcher spawn failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** A lock this old means the watcher that wrote it is gone. */

/**
 * The detached watcher itself. Refreshes its lock so a sibling hook can tell
 * it is alive, and exits once the session has been quiet long enough that
 * nothing will ask for its journal again.
 */
export async function runJournalWatcher(): Promise<void> {
  const repoPath = process.env.ORIGIN_JOURNAL_REPO || '';
  const journalPath = process.env.ORIGIN_JOURNAL_PATH || '';
  const lockPath = process.env.ORIGIN_JOURNAL_LOCK || '';
  const snapshotDir = process.env.ORIGIN_JOURNAL_SNAPSHOTS || '';
  if (!repoPath || !journalPath) return;

  const watcher = startWriteJournal(repoPath, journalPath, snapshotDir ? { snapshotDir } : {});
  if (!watcher) {
    // No recursive watch on this platform — say so once and leave, rather than
    // holding a process open that records nothing.
    debugLog('journal-watch', 'recursive watch unavailable, exiting', { repoPath });
    return;
  }

  let lastSize = -1;
  let idleSince = Date.now();
  // Own the lock from the first instant, not from the first tick.
  try { if (lockPath) fs.writeFileSync(lockPath, String(process.pid)); } catch { /* ignore */ }
  const timer = setInterval(() => {
    try { if (lockPath) fs.writeFileSync(lockPath, String(process.pid)); } catch { /* ignore */ }
    try {
      const size = fs.statSync(journalPath).size;
      if (size !== lastSize) { lastSize = size; idleSince = Date.now(); }
    } catch { /* ignore */ }
    if (Date.now() - idleSince > JOURNAL_WATCH_IDLE_MS) {
      clearInterval(timer);
      watcher.stop();
      try { compactJournal(journalPath, Date.now(), snapshotDir || undefined); } catch { /* ignore */ }
      try { if (lockPath) fs.unlinkSync(lockPath); } catch { /* ignore */ }
      process.exit(0);
    }
  }, 15_000);
  // Keep the interval from holding a finished process open indefinitely.
  timer.unref?.();
  await new Promise(() => { /* run until the idle check exits us */ });
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

export function recordShellWindowEdits(
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
export { isNonSecretAssignmentValue } from '../secret-rules.js';

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
const AGY_WATCH_MAX_MS = 12 * 60 * 60 * 1000; // a live watcher refreshes its lock every poll; older than this = dead → respawn

export function agyWatchLockPath(cid: string): string {
  return path.join(os.homedir(), '.origin', 'agy-watch', `${cid}.lock`);
}
// Sentinel written by the Stop hook so the watcher knows the turn closed and can
// exit promptly instead of waiting out the idle backstop.
export function agyWatchDonePath(cid: string): string {
  return path.join(os.homedir(), '.origin', 'agy-watch', `${cid}.done`);
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
          // The journal boundary cannot wait for the background process: that
          // one takes 6-14s to reach its mark, and Copilot starts writing the
          // moment this hook returns. A write landing before the mark belongs
          // to the PREVIOUS turn's span. Mint the id and mark it here — cheap,
          // no network — and the background handler adopts the id it finds.
          preMarkTurnForBackgroundSubmit(agentSlug, input);
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
