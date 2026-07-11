import { loadConfig, saveConfig, loadAgentConfig, saveAgentConfig, loadRepoConfig, isConnectedMode, ensureConfigDir } from '../config.js';
import { decidePushBlock } from '../push-block.js';
import crypto from 'crypto';
import { detectTools } from '../tools-detector.js';
import { api, readAuthStatus } from '../api.js';
import { parseTranscript, estimateCost, formatTranscriptForDisplay, extractPromptFileMappings, extractPromptImages, setActivePricing } from '../transcript.js';
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
  type SessionState,
  type ToolCallRecord,
} from '../session-state.js';
import { captureGitState, captureAgyDiff, getDirtyFiles, createShadowCommit, MAX_PROMPT_DIFF_LEN } from '../git-capture.js';
import { parseAntigravityTranscript, estimateAntigravityUsage } from '../antigravity-transcript.js';
import { backfillCodexPromptMappings } from '../codex-prompt-mapping.js';
import { buildCodexThreadByCwdQuery } from '../codex-thread-query.js';
import { durableUpdateSession, durableEndSession, drainUpdateQueue } from '../update-queue.js';
import { debugLog } from '../debug-log.js';
import {
  listRecentShas,
  backfillUnknownCommits,
  shouldAdvertiseHistory,
  writeSyncMarker,
  acquireBackfillLock,
  releaseBackfillLock,
  extractCommitDiff,
  syncRepoHistory,
  shouldSyncStandalone,
  hasFreshFailedAttempt,
  RECENT_SHAS_LIMIT,
  BACKFILL_TIMEOUT_MS,
} from '../history-backfill.js';
import {
  discoverCodexSessionData, findCodexRolloutPath, readCodexRolloutFile,
  getCodexPromptsTimeline, parseCodexRollout, isCodexInternalSubroutine,
  isKnownCodexInternalPrompt,
  type PromptTimelineEntry, type CodexSessionData,
} from '../agents/codex.js';
import { readGeminiModel, discoverGeminiTranscriptPath, getGeminiPromptsTimeline } from '../agents/gemini.js';
import { getCursorModelFromDb, findCursorTranscriptJsonl, discoverCursorTranscript, type CursorTranscriptData } from '../agents/cursor.js';
// Re-exported: tests and external callers import these from hooks historically.
export { parseCodexRollout, isCodexInternalSubroutine } from '../agents/codex.js';
import {
  isSpecificModel, sessionMatchesAgent, isCodexLikeModel,
  attributionPgrepChecks, standalonePgrepChecks, resolveAgentDisplayName,
} from '../agents/registry.js';
import { attachOrphanCommitFiles } from '../prompt-completeness.js';
import { writeSessionFiles, pushSessionBranch, type PromptEntry, type PromptChange, type SessionWriteData } from '../local-entrypoint.js';
import { writeGitNotes, shouldIncludePromptText, syncNotesFromRemoteThrottled, type PromptNoteEntry } from '../git-notes.js';
import { parseMarkersFromTranscript, parseMarkersFromTranscriptPath } from '../origin-markers.js';
import { redactSecrets } from '../redaction.js';
import { buildAttributionContext, buildFileAttributionContext } from '../attribution.js';
import { writeHandoff, buildHandoffContext, extractTodosFromPrompts } from '../handoff.js';
import { writeSessionMemory, buildMemoryContext, readRecentMemory } from '../memory.js';
import { backfillAcceptanceForSession } from '../acceptance.js';
import { addTodosFromSession } from '../todo.js';
import {
  capturePromptEdits,
  extractEditsFromToolCall,
  anchorEditPositions,
  buildCapturesFromLedger,
  mergeLedgerWithTranscript,
} from '../prompt-capture/index.js';
import type { PromptCapture } from '../prompt-capture/index.js';
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
      cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (stashSha && HEX.test(stashSha)) {
      const treeSha = execFileSync('git', ['rev-parse', `${stashSha}^{tree}`], {
        cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (HEX.test(treeSha)) return treeSha;
    }
  } catch { /* fall through to HEAD's tree */ }
  try {
    const headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
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
 * Run a pgrep command safely, filtering out the current process (and its children)
 * to avoid false-positive matches when the pattern appears in our own argv.
 * Returns true if at least one *other* process matched.
 */
function safePgrep(pgrepCmd: string): boolean {
  const myPid = process.pid;
  const myPpid = process.ppid;
  // Parse command string into args for execFileSync (e.g. 'pgrep -f "pattern"')
  const parts = pgrepCmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const cmd = parts[0] || 'pgrep';
  const args = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));
  // Run pgrep, capture PIDs, filter out our own process tree
  const raw = execFileSync(cmd, args, { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }).trim();
  if (!raw) return false;
  const pids = raw.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p));
  const filtered = pids.filter(p => p !== myPid && p !== myPpid);
  return filtered.length > 0;
}

// ─── Diff Filtering ─────────────────────────────────────────────────────
// Filter a unified diff to exclude files that were already dirty before the prompt.

function filterUncommittedDiff(diffText: string, prePromptDirtyFiles: string[]): string {
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

function uncommittedExcludeUnion(state: SessionState): string[] {
  const set = new Set<string>();
  for (const f of state.prePromptDirtyFiles || []) set.add(f);
  for (const f of state.sessionStartDirtyFiles || []) set.add(f);
  // (c) Other-session-touched files. Iterate the active session registry on
  // this repo, gather their filesChanged / commit-derived filename lists,
  // and add any file we ourselves haven't touched. "Touched by us" is
  // defined as appearing in one of OUR completedPromptMappings.
  try {
    const repoPath = state.repoPath;
    if (repoPath) {
      const others = listActiveSessions(repoPath).filter((s) => s.sessionId !== state.sessionId);
      if (others.length > 0) {
        const ours = new Set<string>();
        for (const m of state.completedPromptMappings || []) {
          for (const f of m.filesChanged || []) ours.add(f);
        }
        for (const other of others) {
          for (const m of other.completedPromptMappings || []) {
            for (const f of m.filesChanged || []) {
              if (!ours.has(f)) set.add(f);
            }
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
function rescueAmendedCommitShas(repoPath: string, state: SessionState): void {
  if (!state.sessionCommitShas || state.sessionCommitShas.length === 0) return;
  const gitOpts = {
    cwd: repoPath,
    encoding: 'utf-8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  };
  const replacements = new Map<string, string>();
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
        if (parents[0] === parent) {
          replacements.set(sha, candidate);
          break;
        }
      }
    } catch { /* parent unreachable — orphan irrecoverable */ }
  }
  if (replacements.size === 0) return;
  state.sessionCommitShas = state.sessionCommitShas.map((s) => replacements.get(s) ?? s);
  try {
    saveSessionState(state, state.repoPath || '', state.sessionTag);
  } catch { /* best-effort persistence */ }
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
function sessionScopedCommittedDiff(
  repoPath: string,
  state: SessionState,
): string {
  rescueAmendedCommitShas(repoPath, state);
  const shas = state.sessionCommitShas || [];
  if (shas.length === 0) return '';
  const parts: string[] = [];
  for (const sha of shas) {
    if (!/^[a-fA-F0-9]{7,40}$/.test(sha)) continue;
    try {
      const out = execFileSync(
        'git',
        ['show', sha, '--format=', '--no-color'],
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
      ).toString().trim();
      if (out) parts.push(out);
    } catch { /* commit may have been removed by a rebase; skip */ }
  }
  return parts.join('\n').trim();
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
    const result = execFileSync('sqlite3', ['-separator', '|||', dbPath, `SELECT title, tldr, overview, summaryBullets FROM conversation_summaries WHERE conversationId='${escapedId}' LIMIT 1`], { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 2000 }).trim();
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

  const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;
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
  const promptsPerCommit = new Map<string, number>();
  for (const mm of promptMappings) {
    const sha = mm.commitSha ?? gitCapture.headAfter ?? null;
    if (sha) promptsPerCommit.set(sha, (promptsPerCommit.get(sha) ?? 0) + 1);
  }

  // Build PromptChange[] from mappings with snapshot metadata. Pulls the
  // per-prompt commit/tree/uncommitted refs straight off the mapping when
  // the stop hook attached them (typical for Claude/Cursor/Gemini); falls
  // back to gitCapture.headAfter for legacy synth paths. editsJson comes
  // from the parallel `promptEditsByIndex` map populated by
  // capturePromptEdits — same shape that ships to the API.
  const changes: PromptChange[] = promptMappings.map(m => {
    const commitSha = m.commitSha ?? gitCapture.headAfter ?? null;
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
          { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
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
            { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
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
    costUsd: estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens),
    tokensUsed: parsed.tokensUsed,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheCreationTokens: parsed.cacheCreationTokens,
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

// ─── Stdin Reader ──────────────────────────────────────────────────────────

async function readStdin(): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
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

/**
 * Write Origin policies to agent-specific rules/instructions files.
 * Cursor: ~/.cursor/rules/origin.md
 * Codex: AGENTS.md in project root (Codex reads this natively)
 * Claude Code: uses systemMessage from stdout (no file needed)
 */
function writeAgentRulesFile(agentSlug: string, systemMsg: string, repoPath: string): void {
  if (!systemMsg || !agentSlug) return;

  let target: string | undefined;
  let useMarker = false;
  if (agentSlug === 'claude-code') {
    // Claude Code reads .claude/settings.local.json instructions, but the most
    // reliable way to inject rules is via the project-level CLAUDE.md file.
    // Use a marker to manage our section without clobbering user content.
    target = path.join(repoPath, 'CLAUDE.md');
    useMarker = true;
  } else if (agentSlug === 'cursor') {
    target = path.join(os.homedir(), '.cursor', 'rules', 'origin.md');
  } else if (agentSlug === 'codex' || agentSlug === 'antigravity') {
    // Codex and Antigravity both read AGENTS.md from the project root.
    target = path.join(repoPath, 'AGENTS.md');
    useMarker = true;
  } else if (agentSlug === 'windsurf') {
    target = path.join(repoPath, '.windsurfrules');
    useMarker = true;
  } else if (agentSlug === 'gemini') {
    target = path.join(repoPath, 'GEMINI.md');
    useMarker = true;
  }

  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (useMarker) {
      // Wrap with markers so we only replace our section, preserving user content
      const marker = '<!-- origin-managed -->';
      const content = `${marker}\n${systemMsg}\n${marker}`;
      const existingContent = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
      const markerRegex = new RegExp(`${marker}[\\s\\S]*?${marker}`, 'g');
      if (existingContent.includes(marker)) {
        fs.writeFileSync(target, existingContent.replace(markerRegex, content));
      } else if (existingContent.trim()) {
        fs.writeFileSync(target, existingContent + '\n\n' + content);
      } else {
        fs.writeFileSync(target, content);
      }
    } else {
      fs.writeFileSync(target, systemMsg);
    }
    debugLog('session-start', 'agent rules file written', { agent: agentSlug, path: target });
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
function buildOriginFrameworkGuidance(): string {
  return [
    'Origin authoring framework — emit these markers inline in your responses when there is real signal worth surfacing to the human reviewer. Don\'t force one per turn.',
    '',
    '  [Origin: Intent] <one sentence on WHY you\'re making this change>',
    '  [Origin: Decision] <choice you made> — <why>',
    '  [Origin: Open] <something you didn\'t finish, or aren\'t sure about>',
    '  [Origin: Verify] <something a human reviewer should check>',
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
const STABLE_SESSION_ID_AGENTS = ['claude-code', 'windsurf'];
export function hookLookupSessionId(sessionId: string | undefined, agentSlug?: string): string | undefined {
  return STABLE_SESSION_ID_AGENTS.includes(agentSlug || '') ? sessionId : undefined;
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
    if (stateFiles.length === 0) return null;
    const out = execFileSync('sqlite3', [
      stateFiles[0].path,
      buildCodexThreadByCwdQuery('id', repoPath),
    ], {
      encoding: 'utf-8' as const, timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Compare two directory paths for identity, tolerating symlinks (macOS
 * /var → /private/var) and trailing-slash/relative differences. Used to
 * match a session's lastCwd against a git hook's cwd.
 */
function sameDir(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const norm = (p: string): string => {
    let r = p;
    try { r = fs.realpathSync(p); } catch { /* deleted dir — compare as-is */ }
    return path.resolve(r);
  };
  return norm(a) === norm(b);
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
export function listSessionsForGitHook(hookCwd: string): SessionState[] {
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
  // Drop zombie sessions — ones whose agent process died without a clean end
  // (no fresh git-state write, no live heartbeat, stale state file). Without
  // this a never-ended Cursor/Codex session lingers "RUNNING" forever and gets
  // its name stamped onto commits made by a different, live agent. Auto-close
  // each zombie locally (mark ENDED on disk) so it stops lingering, rather than
  // re-detecting it on every hook.
  if (sessions.length > 0) {
    const live: SessionState[] = [];
    const closed: string[] = [];
    for (const s of sessions) {
      if (isSessionAlive(s)) { live.push(s); continue; }
      try { if (markSessionEnded(s)) closed.push(s.sessionId.slice(0, 12)); } catch { /* best effort */ }
    }
    if (closed.length) {
      debugLog('git-hook-sessions', 'auto-closed stale sessions', { closed, kept: live.map((s) => s.sessionId.slice(0, 12)) });
    }
    sessions = live;
  }
  if (sessions.length > 1) {
    const exact = sessions.filter(s => sameDir(s.lastCwd, hookCwd));
    if (exact.length > 0) {
      debugLog('git-hook-sessions', 'narrowed by lastCwd', {
        hookCwd, matched: exact.map(s => s.sessionId.slice(0, 12)),
      });
      return exact;
    }
    // No exact match — drop sessions demonstrably working elsewhere; keep
    // only those whose cwd is unknown (state files predating lastCwd).
    return sessions.filter(s => !s.lastCwd);
  }
  return sessions;
}

function findStateForHook(hookCwd: string, claudeSessionId?: string, agentSlug?: string): { state: SessionState; saveCwd: string } | null {
  const repoPath = discoverGitRoot(hookCwd) || hookCwd;

  // Debug: log what listActiveSessions finds
  const debugSessions1 = listActiveSessions(hookCwd);
  const debugSessions2 = hookCwd !== repoPath ? listActiveSessions(repoPath) : [];
  debugLog('findStateForHook', 'scanning', {
    hookCwd, repoPath,
    sessionsInHookCwd: debugSessions1.length,
    sessionsInRepoPath: debugSessions2.length,
    tags: [...debugSessions1, ...debugSessions2].map(s => s.sessionTag),
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
    const found = findSessionByClaudeId(claudeSessionId, hookCwd)
      || (repoPath !== hookCwd ? findSessionByClaudeId(claudeSessionId, repoPath) : null);
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

  // 2. Fall back to active sessions for this repo
  let sessions = listActiveSessions(hookCwd);
  if (sessions.length === 0 && repoPath !== hookCwd) {
    sessions = listActiveSessions(repoPath);
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

  // Fetch latest model pricing from API (non-blocking, falls back to defaults)
  if (connected) {
    try {
      const { pricing } = await api.getPricing();
      if (pricing && typeof pricing === 'object') {
        setActivePricing(pricing as Record<string, { input: number; output: number }>);
        debugLog('session-start', 'pricing fetched from API', { models: Object.keys(pricing).length });
      }
    } catch (err: any) {
      debugLog('session-start', 'pricing fetch failed, using defaults', { error: err.message });
    }
  }

  // Skip background agents (Cursor fires session-start for background indexing agents)
  if (input.is_background_agent === true || input.is_background_agent === 'true') {
    debugLog('session-start', 'SKIP: background agent', { is_background_agent: input.is_background_agent });
    return;
  }

  // Use cwd from hook input (Claude Code passes this), or workspace_roots (Cursor),
  // or fall back to process.cwd()
  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd — ALWAYS prefer workspace_roots
  // because Cursor runs hooks from ~/.cursor/ (not the project dir) and process.cwd()
  // may point to a completely different repo.
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
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
  const finalAgentSlug = slugOverride || baseSlug;
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
  const agentsWithStableSessionId = ['claude-code', 'windsurf', 'antigravity'];
  const hasStableSessionId = agentsWithStableSessionId.includes(agentSlug || '');
  // Cursor prefers `conversation_id` — stable per-chat and matches the
  // `agent-transcripts/<id>/` directory name. Cursor's `session_id`
  // rotates per turn, so picking it as the anchor would force a "new
  // chat" lock on every prompt. Other agents fall through to whichever
  // id stdin provides first.
  const stdinSessionId = agentSlug === 'cursor'
    ? ((typeof input.conversation_id === 'string' && input.conversation_id) ||
       (typeof input.session_id === 'string' && input.session_id) ||
       '')
    : ((typeof input.session_id === 'string' && input.session_id) ||
       (typeof input.conversation_id === 'string' && input.conversation_id) ||
       '');
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
  const sessionTag = claudeSessionId
    ? claudeSessionId.slice(0, 12)
    : `s${Date.now().toString(36)}`;
  debugLog('session-start', 'session tag', { sessionTag, claudeSessionId });

  // ── Deduplicate: skip if we already have an active session for this Claude session ──
  if (claudeSessionId) {
    const existing = findSessionByClaudeId(claudeSessionId, repoPath);
    if (existing && existing.sessionId) {
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
    const cursorChatMatches = (s: { agentSessionId?: string | null }): boolean =>
      cursorSessionReusable(agentSlug, agentSessionId, s.agentSessionId);
    if (agentsWithSessionReuse.includes(agentSlug || '')) {
      existing = listActiveSessions(repoPath).find(
        s => sessionMatchesAgent(s, finalAgentSlug || agentSlug || '') && cursorChatMatches(s),
      ) || null;
      // Also check global archive — the .git/ file might have been cleaned up
      if (!existing) {
        try {
          const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
          const entries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
          const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
          for (const entry of entries) {
            try {
              const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
              if (!s?.sessionId || !s?.startedAt) continue;
              if (Date.now() - new Date(s.startedAt).getTime() > MAX_AGE_MS) continue;
              if (s.status === 'ENDED' && s.endedAt) continue;
              if (s.repoPath === repoPath && sessionMatchesAgent(s, finalAgentSlug || agentSlug || '') && cursorChatMatches(s)) {
                existing = s;
                break;
              }
            } catch { /* skip corrupt file */ }
          }
        } catch { /* no archive dir */ }
      }
    }
    if (existing) {
      debugLog('session-start', 'reusing existing session for per-prompt agent', {
        sessionId: existing.sessionId,
        tag: existing.sessionTag,
        agent: finalAgentSlug,
        promptCount: existing.prompts.length,
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
      const prevPromptIdx = existing.prompts.length - 1;
      const prevAlreadyCaptured = !!(existing.completedPromptMappings || []).find(
        (m: any) => m.promptIndex === prevPromptIdx && (m.diff || m.uncommittedDiff),
      );
      if (existing.prePromptSha && currentHead && existing.prompts.length > 0 && !prevAlreadyCaptured) {
        try {
          const prevCapture = captureGitState(repoPath, existing.prePromptSha, { fullContext: true });
          const prevFilesSet = new Set<string>();
          for (const c of prevCapture.commitDetails) {
            for (const f of c.filesChanged) prevFilesSet.add(f);
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
              mappingCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            } catch { /* ignore */ }
            mappingTreeSha = getWorkingTreeSha(repoPath);
            // Scope committed side to commits this session authored (see
            // sessionScopedCommittedDiff). Same isolation rule as the
            // user-prompt-submit path.
            const reuseSessionCommitted = sessionScopedCommittedDiff(repoPath, existing);
            const reuseDiff = (reuseSessionCommitted +
              (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
            const mapping = {
              promptIndex: prevPromptIdx,
              promptText: (existing.prompts[prevPromptIdx] || '').slice(0, 1000),
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
        syncNotesFromRemoteThrottled(repoPath);
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
  }
  if (!model || model === 'unknown' || model === 'default') {
    const AGENT_DEFAULT_MODELS: Record<string, string> = {
      'gemini': 'gemini',
      'claude-code': 'claude',
      'cursor': 'cursor',
      'windsurf': 'windsurf',
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
    repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }).trim();
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

  try {
    let sessionId: string;
    // Set when the server refused session/start with a 429 (hard budget
    // cap). The local fallback session is created anyway but flagged
    // budgetBlocked so every enforcement layer sees the lockout.
    let budgetRefusedReason: string | undefined;
    // Scoped SOFT-cap breach — warn-only (amber banner, no lockout).
    let budgetWarnReason: string | undefined;
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
        if (apiErr?.code === 'AGENT_DISABLED') {
          const agentName = apiErr?.body?.agent?.name || finalAgentSlug || 'this agent';
          debugLog('session-start', 'agent disabled, keeping session local', { agentName });
          process.stderr.write(`[origin] ${agentName} is disabled in your org — session kept local. An admin has been notified to enable it.\n`);
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
        sessionId = `local-${crypto.randomUUID()}`;
      }
    } else {
      // ── Standalone mode: generate local session ID ──
      sessionId = `local-${crypto.randomUUID()}`;
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
    saveSessionState(state, saveCwd, sessionTag);
    debugLog('session-start', 'state saved', { sessionId, sessionTag });

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
      syncNotesFromRemoteThrottled(repoPath);
    } catch {
      // Non-fatal — attribution below still renders whatever notes are local.
    }

    // Inject AI attribution context so the agent knows what other agents have done
    try {
      const attributionCtx = buildAttributionContext(repoPath);
      if (attributionCtx) {
        systemMsg += '\n\n' + attributionCtx;
        debugLog('session-start', 'attribution context injected', { length: attributionCtx.length });
      }
    } catch {
      // Non-fatal — skip attribution context if it fails
    }

    // Inject cross-agent handoff context (from previous session, possibly different agent)
    try {
      const handoffCtx = buildHandoffContext(repoPath);
      if (handoffCtx) {
        systemMsg += '\n\n' + handoffCtx;
        debugLog('session-start', 'handoff context injected', { length: handoffCtx.length });
      }
    } catch {
      // Non-fatal
    }

    // Inject session memory (last 3 session summaries for this repo)
    try {
      const memoryCtx = buildMemoryContext(repoPath);
      if (memoryCtx) {
        systemMsg += '\n\n' + memoryCtx;
        debugLog('session-start', 'memory context injected', { length: memoryCtx.length });
      }
    } catch {
      // Non-fatal
    }

    // Inject the Origin authoring framework — short prompt telling the
    // agent to emit structured `[Origin: …]` markers as it works so the
    // post-PR reviewer can scan intent / decisions / open questions /
    // verification steps without round-tripping through synthesis. Path
    // A of "GitHub for agents" (server-side synthesis is the Path B
    // fallback on existing PR detail; agent-emitted text takes
    // precedence when present). Goes LAST so it's the most recent
    // thing the agent reads — models tend to weight tail context more.
    systemMsg += '\n\n' + buildOriginFrameworkGuidance();
    debugLog('session-start', 'framework guidance injected');

    // Deliver the context through each agent's correct channel (see
    // buildContextInjectionPayload). Codex gets null here — it reads from
    // AGENTS.md — but we still surface the budget banner in its warning
    // area: "your cap is breached" belongs on the initial screen.
    const payload = buildContextInjectionPayload(agentSlug, 'SessionStart', systemMsg);
    if (payload) {
      process.stdout.write(payload);
    } else if (agentSlug === 'codex' && budgetRefusedReason) {
      process.stdout.write(buildBudgetBanner(budgetRefusedReason) + '\n');
    } else if (agentSlug === 'codex' && budgetWarnReason) {
      process.stdout.write(buildBudgetWarningBanner(budgetWarnReason) + '\n');
    }
    // Make the preamble VISIBLE for the agents that don't render stdout as a
    // banner (everyone but Gemini) — see emitVisiblePreamble.
    emitVisiblePreamble(agentSlug, systemMsg);
    debugLog('session-start', 'system prompt injected', { agent: agentSlug, length: systemMsg.length, budgetBanner: !!budgetRefusedReason, budgetWarnBanner: !!budgetWarnReason });

    // Write rules files so agents natively see Origin policies
    if (systemMsg) {
      try {
        writeAgentRulesFile(finalAgentSlug || '', systemMsg, repoPath);
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
export async function ensureServerSession(
  state: SessionState,
  saveCwd: string,
  agentSlug: string | undefined,
  scope: string,
): Promise<boolean> {
  if (!isConnectedMode()) return false;
  if (!state.sessionId || !state.sessionId.startsWith('local-')) return false;
  try {
    const agentConfig = loadAgentConfig();
    if (!agentConfig?.machineId) return false;
    debugLog(scope, 'migrating local session to server', { local: state.sessionId });
    const startRes = await api.startSession({
      machineId: agentConfig.machineId,
      prompt: (state.prompts && state.prompts[0]) || '',
      model: isSpecificModel(state.model) ? state.model : 'claude',
      repoPath: state.canonicalRepoPath || state.repoPath || saveCwd,
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

  let hookCwd = input.cwd || process.cwd();
  // Cursor sends workspace_roots instead of cwd
  if (input.workspace_roots && Array.isArray(input.workspace_roots) && input.workspace_roots.length > 0) {
    const wsRoot = input.workspace_roots[0];
    debugLog('user-prompt-submit', 'workspace_roots check', { wsRoot, isString: typeof wsRoot === 'string', gitRoot: typeof wsRoot === 'string' ? getGitRoot(wsRoot) : null });
    if (typeof wsRoot === 'string' && getGitRoot(wsRoot)) {
      hookCwd = wsRoot;
    }
  }
  debugLog('user-prompt-submit', 'cwd resolved', { hookCwd });

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
  const found = findStateForHook(hookCwd, lookupSessionId, agentSlug);
  let state = found?.state || null;

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
        let bestCandidate: SessionState | null = null;
        let bestAge = Infinity;
        for (const entry of archiveEntries) {
          try {
            const s = JSON.parse(fs.readFileSync(path.join(archiveDir, entry), 'utf-8'));
            if (!s?.sessionId || !s?.startedAt) continue;
            const age = Date.now() - new Date(s.startedAt).getTime();
            if (age > MAX_RECOVERY_AGE_MS) continue;
            if (s.status === 'ENDED' && s.endedAt) continue;
            if (s.repoPath !== recoveryRepoPath && s.repoPath !== recoveryCanonical) continue;
            if (agentSlug && !sessionMatchesAgent(s, agentSlug)) continue;
            if (age < bestAge) {
              bestCandidate = s;
              bestAge = age;
            }
          } catch { /* skip */ }
        }
        if (bestCandidate) {
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
    if (repoPath) {
      try {
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
        const finalAgentSlug = slugOverride || baseSlug;
        const branch = getBranch(hookCwd);
        let model = input.model || (agentSlug === 'gemini' ? 'gemini' : agentSlug === 'codex' ? 'codex' : 'claude');
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
        const autoTag = (input.session_id || '').slice(0, 12) || `s${Date.now().toString(36)}`;

        // Get git remote URL for better repo matching on the server
        let repoUrl = '';
        try {
          repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }).trim();
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
            const autoAgentSessionId = stableAgents.includes(agentSlug || '')
              ? (input.session_id || undefined)
              : undefined;
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
        if (autoSessionStartDirty.length > 0) {
          try {
            const startShadowTag = autoTag || sessionId.slice(0, 12);
            const startShadow = createShadowCommit(hookCwd, `start-${startShadowTag}`);
            if (startShadow) {
              autoPrePromptSha = startShadow;
              autoPrePromptDirtyFiles = [];
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
        state = {
          sessionId,
          claudeSessionId: input.session_id || '',
          transcriptPath: input.transcript_path || '',
          model,
          startedAt: new Date().toISOString(),
          prompts: [],
          repoPath,
          canonicalRepoPath: canonicalRepoPath || undefined,
          headShaAtStart: getHeadSha(hookCwd),
          headShaAtLastStop: null,
          prePromptSha: autoPrePromptSha,
          prePromptDirtyFiles: autoPrePromptDirtyFiles,
          sessionStartDirtyFiles: autoSessionStartDirty,
          branch,
          sessionTag: autoTag,
          agentSlug: finalAgentSlug || agentSlug,
          agentSystemPrompt,
          activePolicies,
          enforcementRules,
        };
        saveSessionState(state, repoPath, autoTag);

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
    // ── Per-prompt diff: capture previous prompt's changes before recording new prompt ──
    const repoPath = state.repoPath || hookCwd;
    const currentHead = getHeadSha(repoPath);
    if (state.prePromptSha && currentHead && state.prompts.length > 0) {
      try {
        const prevPromptIdx = state.prompts.length - 1; // index of the prompt that just finished
        // Prefer the per-prompt shadow recorded by the heartbeat daemon at
        // the moment this prompt was detected in the rollout. That shadow
        // represents the working tree state at the START of this prompt
        // (= end of the previous prompt's work). Using it as the baseline
        // for `captureGitState` produces a per-prompt diff that contains
        // ONLY this prompt's work, even when no prompt-submit hook fired
        // (Codex auto-trust gating, Gemini IDE plug-in, etc.).
        const promptShadow = (state.promptShadows || []).find(
          (s) => s.promptIndex === prevPromptIdx,
        );
        const captureBaseline = promptShadow?.shadowSha || state.prePromptSha;
        // fullContext: per-prompt pc.diff feeds the blame route's
        // fallback path when sessionDiff doesn't cover the file (typical
        // for uncommitted work). Full-file context lets the replay
        // anchor every editsJson edit at an exact position instead of
        // falling through to content-keyed guessing.
        const prevGitCapture = captureGitState(repoPath, captureBaseline, { fullContext: true });
        // Extract filesChanged from commit details + diff headers
        const prevFilesSet = new Set<string>();
        for (const c of prevGitCapture.commitDetails) {
          for (const f of c.filesChanged) prevFilesSet.add(f);
        }
        if (prevGitCapture.diff) {
          for (const m of prevGitCapture.diff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
            if (m[1]) prevFilesSet.add(m[1]);
          }
        }
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
            prevCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath || hookCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          } catch { /* ignore */ }
          prevTreeSha = getWorkingTreeSha(state.repoPath || hookCwd);
          // Scope `committedDiff` to commits THIS session authored. Walking
          // the session's own commit list keeps concurrent agents isolated:
          // a heartbeat in this session no longer picks up a foreign agent's
          // commits even when HEAD has moved past ours.
          const sessionCommitted = sessionScopedCommittedDiff(repoPath, state);
          const diffText = (sessionCommitted +
            (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
          const prevMapping = {
            promptIndex: prevPromptIdx,
            promptText: (state.prompts[prevPromptIdx] || '').slice(0, 1000),
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
    {
      const repo = state.repoPath || hookCwd;
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
            parsed = parseTranscript(state.transcriptPath, { since: state.startedAt });
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
                  toolCalls: 0,
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
              parsed = parseTranscript(state.transcriptPath, { since: state.startedAt });
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
          ? estimateCost(model, hbInputTokens, hbOutputTokens, parsed?.cacheReadTokens || 0, parsed?.cacheCreationTokens || 0)
          : 0;

        // Redact secrets from prompts
        const shouldRedact = config.secretRedaction !== false;
        const redactedPrompts = shouldRedact
          ? state.prompts.map(p => redactSecrets(p).redacted)
          : state.prompts;
        const joinedPrompt = redactedPrompts.join('\n\n---\n\n');

        // Fire-and-forget — Codex's user-prompt-submit hook has a 10s budget,
        // and awaiting this network call here was making the hook time out
        // (the heartbeat daemon already re-sends the same payload on its
        // own tick, so the data isn't lost — just delayed by up to 30s).
        // Shadow commit + state-file write already happened earlier in this
        // hook, so the per-prompt baseline is captured before we return.
        api.updateSession(state.sessionId, {
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
                  aiPercentage: 100,
                  checkpointType: 'auto',
                };
              })
            : undefined,
        }).catch((err: any) => {
          debugLog('user-prompt-submit', 'background updateSession failed (non-fatal)', { message: err?.message });
        });
        debugLog('user-prompt-submit', 'heartbeat dispatched (fire-and-forget)', { sessionId: state.sessionId, promptCount: state.prompts.length, costUsd, promptChanges: state.completedPromptMappings?.length || 0 });

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

    // Inject repo-level attribution context
    const repoPath = state.repoPath || hookCwd;
    try {
      const attributionCtx = buildAttributionContext(repoPath);
      if (attributionCtx) {
        systemMsg += '\n\n' + attributionCtx;
      }
    } catch {}

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
    const wsRoot = input.workspace_roots[0];
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
          const wsRoot = input.workspace_roots[0];
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
            agentSlug: 'cursor',
            branch: branch || undefined,
            agentSessionId: input.session_id,
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
    const parsed = parseTranscript(state.transcriptPath, { since: state.startedAt });

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

    // Estimate tokens from prompt text when no real token data exists (Codex, agents without transcripts)
    if (parsed.tokensUsed === 0 && state.prompts.length > 0) {
      const totalPromptChars = state.prompts.reduce((sum, p) => sum + p.length, 0);
      // ~4 chars per token for English, assume 3:1 output:input ratio for coding tasks
      const estimatedInputTokens = Math.round(totalPromptChars / 4);
      const estimatedOutputTokens = estimatedInputTokens * 3;
      parsed.inputTokens = estimatedInputTokens;
      parsed.outputTokens = estimatedOutputTokens;
      parsed.tokensUsed = estimatedInputTokens + estimatedOutputTokens;
      debugLog('stop', 'estimated tokens from prompt text', { totalPromptChars, estimatedInputTokens, estimatedOutputTokens });
    }

    // Use prompts from transcript if we captured them, else from state
    const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;

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
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens);

    // Extract prompt → file change mappings
    let promptMappings = extractPromptFileMappings(state.transcriptPath);
    debugLog('stop', 'prompt mappings', { count: promptMappings.length });

    // Fall back to git-captured files if transcript parsing didn't find any
    // Use per-prompt baseline: prePromptSha (set at prompt start) > headShaAtLastStop > headShaAtStart
    const promptBaseline = state.prePromptSha || state.headShaAtLastStop || state.headShaAtStart;
    // fullContext: per-prompt diff feeds AI Blame's replay. Full-file
    // context lets every editsJson edit anchor at an exact position.
    const gitCapture = captureGitState(state.repoPath, promptBaseline, { fullContext: true });
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
      const currentPromptIdx = prompts.length - 1;
      const currentPromptText = prompts[currentPromptIdx] || '';

      if (promptMappings.length === 0 && prompts.length > 0) {
        // No transcript-based mappings — synthesize from git for current prompt.
        // Filter uncommitted diff against the prompt-baseline + session-start
        // pre-existing dirt union.
        const filteredUncommitted = filterUncommittedDiff(
          gitCapture.uncommittedDiff || '', uncommittedExcludeUnion(state),
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
        const noUncommittedChanges =
          !filteredUncommitted &&
          !((gitCapture.workingTreeDiff || '').length > 0);
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
          // shadow's content.
          const useWorkingTreeDiff = gitCapture.baselineIsShadow && gitCapture.workingTreeDiff;
          if (useWorkingTreeDiff) {
            // Pull file list out of the working-tree diff (which is what
            // we'll actually store) so filesChanged matches the diff.
            for (const m of gitCapture.workingTreeDiff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          const allFiles = new Set([...filesChanged, ...uncommittedFiles]);
          const synthDiff = useWorkingTreeDiff
            ? gitCapture.workingTreeDiff
            : (((gitCapture.committedDiff || '') + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim());
          // Capture commit/tree SHAs so the commit-detail page can link
          // this prompt to the commit it produced.
          let synthCommitSha: string | null = null;
          let synthTreeSha: string | null = null;
          try {
            synthCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
        // Transcript gave us mappings for current prompt — merge with saved previous ones.
        // Deduplicate by promptIndex (current prompt's data wins over saved).
        const currentIndices = new Set(promptMappings.map(pm => pm.promptIndex));
        const kept = previousMappings.filter(pm => !currentIndices.has(pm.promptIndex));
        promptMappings = [...kept, ...promptMappings];
      }

      // Safety net: ensure the CURRENT prompt has a mapping even if transcript
      // parsing missed it. Without this, the latest prompt shows empty on the
      // platform until the NEXT prompt fires (when user-prompt-submit captures it).
      if (prompts.length > 0 && !promptMappings.some(pm => pm.promptIndex === currentPromptIdx)) {
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
        const noUncommittedChanges = !((gitCapture.uncommittedDiff || '').length > 0)
          && !((gitCapture.workingTreeDiff || '').length > 0);
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
          const filteredUncommitted = filterUncommittedDiff(
            gitCapture.uncommittedDiff || '', uncommittedExcludeUnion(state),
          );
          const uncommittedFiles: string[] = [];
          if (filteredUncommitted) {
            for (const m of filteredUncommitted.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          // Shadow baseline → prefer workingTreeDiff (see note in synthesis branch above).
          const useWorkingTreeDiff = gitCapture.baselineIsShadow && gitCapture.workingTreeDiff;
          if (useWorkingTreeDiff) {
            for (const m of gitCapture.workingTreeDiff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
              if (m[1]) uncommittedFiles.push(m[1]);
            }
          }
          const allFiles = new Set([...filesChanged, ...uncommittedFiles]);
          const safetyDiff = useWorkingTreeDiff
            ? gitCapture.workingTreeDiff
            : (((gitCapture.committedDiff || '') + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim());
          // Capture commitSha + treeSha so the dashboard can link this prompt
          // to its commit on the commit-detail page. Without these the
          // "Prompts in this commit" panel says "No linked prompts" even
          // when the per-prompt mapping was captured correctly.
          //
          // Stamp the commit sha ONLY when this turn's capture actually saw
          // a new commit land since its baseline (committedDiff non-empty).
          // Unconditionally stamping current HEAD spread a later commit's
          // sha onto turns that never committed (the cumulative-stamp class
          // — prod petrushka 2a3a52aa), and the server's fill-only guard
          // can't help when the row is still null. The boundary race (the
          // commit's true turn not yet detected by the poll) is resolved
          // server-side by the attribution sweep (#582).
          let synthCommitSha: string | null = null;
          let synthTreeSha: string | null = null;
          try {
            const sawNewCommit = !!(gitCapture.committedDiff && gitCapture.committedDiff.trim());
            if (sawNewCommit) {
              synthCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
        const sessionFilesSet = new Set<string>();
        for (const c of sessionCapture.commitDetails) {
          for (const f of c.filesChanged) sessionFilesSet.add(f);
        }
        if (sessionCapture.diff) {
          for (const m of sessionCapture.diff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
            if (m[1]) sessionFilesSet.add(m[1]);
          }
        }
        if (sessionFilesSet.size > 0) {
          sessionFilesChanged = Array.from(sessionFilesSet);
          debugLog('stop', 'session-level filesChanged from headShaAtStart', { count: sessionFilesChanged.length });
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
        model,
        tokensUsed: parsed.tokensUsed,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cacheReadTokens: parsed.cacheReadTokens,
        cacheCreationTokens: parsed.cacheCreationTokens,
        costUsd,
        promptMappings: promptMappings.length,
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
              uncommittedExcludeUnion(state),
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
            // Codex bypasses .git/hooks/post-commit on some installs, so
            // sessionCommitShas can be empty even when the session produced
            // real commits — sessionScopedCommittedDiff then returns "" and
            // fullDiff collapses to just the uncommitted slice, dropping every
            // committed prompt from sessionDiff (and the AI Blame view). Fall
            // back to snap.committedDiff (= git diff session-start..HEAD)
            // when the session-scoped walk produces nothing.
            let sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state);
            if (!sessionCommitted && snap.committedDiff) {
              sessionCommitted = snap.committedDiff;
            }
            const fullDiff = (sessionCommitted +
              (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
            sessionGitCapture = {
              headBefore: state.headShaAtStart,
              headAfter: snap.headAfter || state.headShaAtStart,
              commitShas: (snap.commitDetails || []).map(c => c.sha),
              diff: fullDiff.slice(0, 500_000),
              linesAdded: snap.linesAdded || 0,
              linesRemoved: snap.linesRemoved || 0,
              commitDetails: snap.commitDetails || [],
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
        const captureAgent =
          slug === 'codex' ? 'codex' :
          slug === 'cursor' ? 'cursor' :
          slug === 'gemini' ? 'gemini' :
          'claude';
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
        const transcriptCaptures = capturePromptEdits({
          agent: captureAgent,
          repoPath: state.repoPath,
          transcriptPath: capTranscript,
          codexPrompts: codexPromptsForCapture,
          sessionCommitShas: state.sessionCommitShas || [],
          headShaAtStart: state.headShaAtStart || undefined,
          headShaAtEnd: gitCapture.headAfter || undefined,
        });
        const captures = applyLiveLedger(transcriptCaptures, state, 'stop');
        if (captures.length > 0) {
          promptEditsByIndex = new Map();
          for (const cap of captures) {
            // Anchor any edit the live ledger didn't already position
            // (transcript-only agents like Gemini) against the final
            // on-disk file. Already-anchored live edits are skipped.
            if (state.repoPath) anchorEditPositions(cap.edits, state.repoPath);
            promptEditsByIndex.set(cap.promptIndex, JSON.stringify(cap));
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

      const updateRes = await durableUpdate(state.sessionId, {
        prompt: joinedPrompt || undefined,
        transcript: displayTranscript || undefined,
        // Only send a specific model (mirrors session-end). When the parse
        // found nothing (resumed session, empty transcript), state.model is
        // the bare brand "claude" — sending it would overwrite a real
        // identifier (e.g. "claude-fable-5") stored by an earlier update.
        model: isSpecificModel(model) ? model : undefined,
        filesChanged: sessionFilesChanged.length > 0 ? sessionFilesChanged : undefined,
        tokensUsed: parsed.tokensUsed > 0 ? parsed.tokensUsed : undefined,
        inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
        outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
        cacheReadTokens: parsed.cacheReadTokens > 0 ? parsed.cacheReadTokens : undefined,
        cacheCreationTokens: parsed.cacheCreationTokens > 0 ? parsed.cacheCreationTokens : undefined,
        toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
        // Structured per-tool breakdown + files-read so the server stores
        // them directly instead of re-parsing the display transcript (which
        // is prompt-only for synthesized/aggregated sessions → "0 / None").
        toolBreakdown: parsed.toolBreakdown.length > 0 ? parsed.toolBreakdown : undefined,
        filesRead: mergeFilesRead(parsed.filesRead, state.filesRead),
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        gitCapture: sessionGitCapture,
        promptChanges: promptMappings.length > 0
          ? promptMappings.map(pm => ({
              ...pm,
              promptText: (pm.promptText || '').slice(0, 1000),
              diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
              editsJson: promptEditsByIndex?.get(pm.promptIndex) || undefined,
            }))
          : undefined,
      });
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
        const execOptsNotes = { cwd: state.repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
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
    // Save accumulated prompt mappings so next stop can include previous prompts' data
    if (promptMappings.length > 0) {
      state.completedPromptMappings = promptMappings.map(pm => ({
        promptIndex: pm.promptIndex,
        promptText: pm.promptText,
        filesChanged: pm.filesChanged,
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
    try {
      const cpId = createSnapshot(state.repoPath, {
        sessionTag: state.sessionTag,
        prompt: prompts.length > 0 ? prompts[prompts.length - 1] : undefined,
        model: model || state.model,
        tokensUsed: parsed.tokensUsed || 0,
        costUsd: costUsd || 0,
        promptIndex: prompts.length,
        type: 'auto',
        linesAdded: gitCapture.linesAdded || 0,
        linesRemoved: gitCapture.linesRemoved || 0,
        transcriptPath: state.transcriptPath,
      });
      if (cpId) {
        debugLog('stop', 'auto-snapshot created', {
          snapshotId: cpId,
          promptIndex: prompts.length,
          lines: (gitCapture.linesAdded || 0) + (gitCapture.linesRemoved || 0),
        });
      } else {
        debugLog('stop', 'auto-snapshot skipped by createSnapshot dedup (clean tree or unchanged from last)', {
          promptIndex: prompts.length,
        });
      }
    } catch (cpErr: any) {
      debugLog('stop', 'auto-snapshot failed (non-fatal)', { message: cpErr.message });
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
      writeSessionFiles(state.repoPath, writeData);
      pushSessionBranch(state.repoPath);
      debugLog('stop', 'session files written + pushed', { prompts: writeData.prompts.length, costUsd: writeData.costUsd });
    } catch (gitErr: any) {
      debugLog('stop', 'session files write/push failed (non-fatal)', { message: gitErr.message });
    }

    // Update handoff context after each prompt stop (always fresh for next agent)
    try {
      const todos = extractTodosFromPrompts(prompts);
      writeHandoff(state.repoPath, {
        version: 1,
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
      });
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
  const agentsWithFakeSessionEnd = ['cursor', 'codex', 'claude-code'];
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
    const wsRoot = input.workspace_roots[0];
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
    const parsed = parseTranscript(state.transcriptPath, { since: state.startedAt });

    // Format transcript for dashboard display (converts JSONL → [{role, content}] JSON)
    let displayTranscript = formatTranscriptForDisplay(state.transcriptPath, { verbose: !!state.verboseCapture });
    debugLog('session-end', 'formatted transcript', { displayLength: displayTranscript.length });

    const prompts = parsed.prompts.length > 0 ? parsed.prompts : state.prompts;

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
    const costUsd = estimateCost(model, parsed.inputTokens, parsed.outputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens);

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
    let promptMappings = extractPromptFileMappings(state.transcriptPath);

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
      const lastPromptIdx = prompts.length - 1;
      const lastPromptCapture = captureGitState(state.repoPath, state.prePromptSha, { fullContext: true });
      const lastFilesSet = new Set<string>();
      for (const c of lastPromptCapture.commitDetails) {
        for (const f of c.filesChanged) lastFilesSet.add(f);
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
        // Scope committed side to commits this session authored (see
        // sessionScopedCommittedDiff).
        const sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state);
        // Capture commit/tree SHAs so the commit-detail page can link the
        // last prompt to the commit it produced.
        let lastCommitSha: string | null = null;
        let lastTreeSha: string | null = null;
        try {
          lastCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch { /* ignore */ }
        lastTreeSha = getWorkingTreeSha(state.repoPath);
        const lastMapping = {
          promptIndex: lastPromptIdx,
          promptText: (prompts[lastPromptIdx] || '').slice(0, 1000),
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
        const transcriptIndices = new Set(promptMappings.map(pm => pm.promptIndex));
        const kept = savedMappings.filter(pm => !transcriptIndices.has(pm.promptIndex));
        promptMappings = [...kept, ...promptMappings];
      } else if (promptMappings.length === 0 && savedMappings.length > 0) {
        promptMappings = savedMappings;
      }
      debugLog('session-end', 'prompt mappings merged', {
        transcriptCount: extractPromptFileMappings(state.transcriptPath).length,
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
      });

      // ─── New per-prompt PromptCapture pipeline ────────────────────────
      // Gemini (and any other agent that hits handleSessionEnd directly)
      // runs the agent-specific extractor here so each PromptChange row
      // carries editsJson — the server-side blame computes the displayed
      // diff and attribution from this directly.
      // `promptEditsByIndex` is declared at function scope above so the
      // writeSessionFiles call below `if (connected)` can also pick it up.
      try {
        const slug = (agentSlug || state.agentSlug || '').toLowerCase();
        const captureAgent =
          slug === 'codex' ? 'codex' :
          slug === 'cursor' ? 'cursor' :
          slug === 'gemini' ? 'gemini' :
          'claude';
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
        const transcriptCaptures = capturePromptEdits({
          agent: captureAgent,
          repoPath: state.repoPath,
          transcriptPath: state.transcriptPath,
          codexPrompts: codexPromptsForCapture,
          sessionCommitShas: state.sessionCommitShas || [],
          headShaAtStart: state.headShaAtStart || undefined,
          headShaAtEnd: gitCapture.headAfter || undefined,
        });
        const captures = applyLiveLedger(transcriptCaptures, state, 'session-end');
        if (captures.length > 0) {
          promptEditsByIndex = new Map();
          for (const cap of captures) {
            // Anchor transcript-only edits (e.g. Gemini) against the
            // final on-disk file; live edits are already positioned.
            if (state.repoPath) anchorEditPositions(cap.edits, state.repoPath);
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
        inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
        outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
        cacheReadTokens: parsed.cacheReadTokens > 0 ? parsed.cacheReadTokens : undefined,
        cacheCreationTokens: parsed.cacheCreationTokens > 0 ? parsed.cacheCreationTokens : undefined,
        toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
        // See the stop handler — structured tool/files data so the PR-detail
        // "behind the work" view doesn't depend on transcript-text markers.
        toolBreakdown: parsed.toolBreakdown.length > 0 ? parsed.toolBreakdown : undefined,
        filesRead: mergeFilesRead(parsed.filesRead, state.filesRead),
        durationMs: durationMs > 0 ? durationMs : undefined,
        costUsd: costUsd > 0 ? costUsd : undefined,
        gitCapture: gitCapture.diff ? gitCapture : undefined,
        promptChanges: promptMappings.length > 0
          ? promptMappings.map(pm => ({
              ...pm,
              promptText: (pm.promptText || '').slice(0, 1000),
              diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
              editsJson: promptEditsByIndex?.get(pm.promptIndex) || undefined,
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
    pushSessionBranch(state.repoPath);
    debugLog('session-end', 'session files written + pushed');

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
        }
      } catch (err: any) {
        debugLog('session-end', 'acceptance backfill error (non-fatal)', { message: err.message });
      }
    }

    // Write cross-agent handoff context for next session
    try {
      const todos = extractTodosFromPrompts(prompts);
      writeHandoff(state.repoPath, {
        version: 1,
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model,
        endedAt: new Date().toISOString(),
        branch: getBranch(hookCwd) || state.branch,
        prompts: prompts.map(p => p.slice(0, 500)),
        summary: parsed.summary || null,
        filesChanged,
        linesAdded: gitCapture.linesAdded,
        linesRemoved: gitCapture.linesRemoved,
        lastPrompt: (prompts[prompts.length - 1] || '').slice(0, 2000),
        lastResponse: null, // Could extract from transcript later
        openTodos: todos,
      });
      debugLog('session-end', 'handoff written', { filesCount: filesChanged.length, todosCount: todos.length });
    } catch (err: any) {
      debugLog('session-end', 'handoff write error (non-fatal)', { message: err.message });
    }

    // Write session memory entry for repo history
    try {
      const todos = extractTodosFromPrompts(prompts);
      writeSessionMemory(state.repoPath, {
        sessionId: state.sessionId,
        agentSlug: agentSlug || 'unknown',
        model,
        startedAt: state.startedAt,
        endedAt: new Date().toISOString(),
        branch: getBranch(hookCwd) || state.branch,
        summary: parsed.summary || prompts[0]?.slice(0, 200) || 'No summary',
        filesChanged,
        promptCount: prompts.length,
        linesAdded: gitCapture.linesAdded,
        linesRemoved: gitCapture.linesRemoved,
        openTodos: todos,
      });
      debugLog('session-end', 'session memory written');
    } catch (err: any) {
      debugLog('session-end', 'session memory error (non-fatal)', { message: err.message });
    }

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

/**
 * Pick, among several concurrently-active sessions the post-commit hook
 * couldn't tell apart by agent process, the one whose recorded edits best
 * overlap the committed files. Recency-weighted: the latest prompt's files
 * count ×3, the last three ×2, older ×1 — so the session that JUST edited
 * what landed in the commit wins, even if an older session touched the same
 * files earlier. Returns null when no session's edits overlap (caller then
 * declines to guess). Matches on basename so repo-relative vs absolute paths
 * in the two sources still line up.
 */
export function pickSessionByFileOverlap<
  T extends { completedPromptMappings?: Array<{ filesChanged?: string[] }> },
>(candidates: T[], commitFiles: string[]): T | null {
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
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore > 0 ? best : null;
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
      promptChanges: state.completedPromptMappings.map((pm) => ({
        ...pm,
        promptText: (pm.promptText || '').slice(0, 1000),
        diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
      })),
    });
    debugLog('post-commit', 'codex producer-pin PATCH sent', {
      sessionId: state.sessionId, mappings: state.completedPromptMappings.length,
    });
  } catch (err: any) {
    debugLog('post-commit', 'codex producer-pin failed (non-fatal)', { message: err?.message });
  }
}

export async function handlePostCommit(): Promise<void> {
  debugLog('post-commit', '=== GIT HOOK INVOKED ===', { pid: process.pid, cwd: process.cwd() });
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
  const execOpts = { encoding: 'utf-8' as const, cwd: hookCwd, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  let commitSha: string, commitMessage: string, commitAuthor: string;
  try {
    commitSha = execFileSync('git', ['rev-parse', 'HEAD'], execOpts).trim();
    commitMessage = execFileSync('git', ['log', '-1', '--format=%s'], execOpts).trim();
    commitAuthor = execFileSync('git', ['log', '-1', '--format=%an'], execOpts).trim();
  } catch (err: any) {
    debugLog('post-commit', 'ERROR: cannot read commit', { message: err.message });
    return;
  }

  debugLog('post-commit', 'commit info', { commitSha, commitMessage, commitAuthor });

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
      api.ingestCommits({
        repoPath,
        repoUrl,
        recentShas: recentShas.length > 0 ? recentShas : undefined,
        commits: [{
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
        }],
      })
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
        .catch((err: any) => debugLog('post-commit', 'shadow ingest failed (non-fatal)', { message: err?.message }));
    } catch (err: any) {
      debugLog('post-commit', 'shadow ingest setup failed', { message: err?.message });
    }
  }

  // Get ALL active sessions for this repo (concurrent session support).
  // Worktree-aware: falls back to the main repo's state files when the hook
  // runs inside a linked worktree, then narrows by last-seen lifecycle cwd
  // so a sibling session in another worktree isn't credited with this commit.
  const activeSessions = listSessionsForGitHook(hookCwd);
  activeSessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  // Pick the correct session — use process detection to disambiguate when multiple are active
  let state: SessionState | null = null;
  if (activeSessions.length === 1) {
    state = activeSessions[0];
  } else if (activeSessions.length > 1) {
    // Detect which agent made this commit via process detection
    let detectedSlug: string | null = null;
    const agentChecks = attributionPgrepChecks();
    for (const check of agentChecks) {
      try {
        if (safePgrep(check.cmd)) {
          detectedSlug = check.slug;
          break;
        }
      } catch { /* no match */ }
    }

    // Narrow to the agent that made this commit. When process detection
    // matches exactly one session, that's our answer. When it matches
    // several (e.g. two concurrent Gemini sessions in the same repo) — or
    // doesn't fire at all — fall through to the file-overlap tiebreak below
    // rather than blindly taking the first.
    let candidates = activeSessions;
    if (detectedSlug) {
      const matched = activeSessions.filter(s => sessionMatchesAgent(s, detectedSlug!));
      if (matched.length > 0) candidates = matched;
    }
    if (candidates.length === 1) {
      state = candidates[0];
      debugLog('post-commit', 'matched single candidate session', { detectedSlug, sessionId: state.sessionId, model: state.model });
    } else if (candidates.length > 1 && filesChanged.length > 0) {
      // Multiple same-agent sessions are active and process detection can't
      // tell them apart. Attribute the commit to the session whose RECENT
      // edits overlap the committed files — the committing session is the
      // one that just edited what landed in the commit. Without this we'd
      // take an arbitrary (newest-started) session and credit the commit to
      // the wrong agent, surfacing as a false "uncommitted" badge on the
      // session that actually did the work (user-reported: a Gemini commit
      // attributed to a sibling Gemini session running in the same repo).
      const best = pickSessionByFileOverlap(candidates, filesChanged);
      if (best) {
        state = best;
        debugLog('post-commit', 'disambiguated by file overlap', { sessionId: best.sessionId, model: best.model });
      }
    }

    // If neither process detection nor file overlap narrowed it down, don't guess.
    if (!state) {
      debugLog('post-commit', 'multiple sessions active, could not disambiguate', {
        totalSessions: activeSessions.length,
        sessionModels: activeSessions.map(s => ({ id: s.sessionId, model: s.model })),
      });
    }
  }

  // If no active session AND no sessions were found at all, detect AI agent process.
  // Only do this when there are truly zero sessions — if sessions exist but couldn't
  // be disambiguated, we already warned above and shouldn't guess via pgrep.
  if (!state && activeSessions.length === 0) {
    let detectedModel: string | null = null;
    try {
      // Use pgrep for targeted process detection — look for CLI binaries only,
      // not desktop apps (Cursor/VS Code have many helper processes that would match)
      const checks = standalonePgrepChecks();
      for (const check of checks) {
        try {
          if (safePgrep(check.cmd)) {
            detectedModel = check.model;
            break;
          }
        } catch { /* pgrep exits 1 if no match */ }
      }
    } catch { /* ignore */ }

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
  if (state && state.sessionTag) {
    if (!state.sessionCommitShas) state.sessionCommitShas = [];
    if (!state.sessionCommitShas.includes(commitSha)) {
      state.sessionCommitShas.push(commitSha);
      try {
        saveSessionState(state, state.repoPath || hookCwd, state.sessionTag);
      } catch { /* non-fatal */ }
      debugLog('post-commit', 'recorded commit on session', {
        sessionId: state.sessionId, commitSha: commitSha.slice(0, 8),
        totalForSession: state.sessionCommitShas.length,
      });
    }
  }

  // Update branch + accumulate filesChanged on all active sessions
  for (const s of activeSessions) {
    let changed = false;
    if (currentBranch && currentBranch !== s.branch) {
      debugLog('post-commit', 'branch changed', { from: s.branch, to: currentBranch, sessionId: s.sessionId });
      s.branch = currentBranch;
      changed = true;
    }
    // Accumulate files changed in session state so standalone sessions show file counts
    if (filesChanged.length > 0) {
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
        { cmd: 'pgrep -f "windsurf"', model: 'windsurf' },
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
      tokensUsed: 0,
      costUsd: 0,
      durationMs: 0,
      linesAdded,
      linesRemoved,
      originUrl: state ? `${apiUrl}/sessions/${state.sessionId}` : '',
      snapshot: true,
      snapshotAt: new Date().toISOString(),
      filesChanged,
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

    if (connected) {
      for (const s of activeSessions) {
        // Pick the prompt this commit belongs to. Claude path uses
        // s.prompts (populated on user-prompt-submit). Codex/Gemini have
        // no submit hook — resolvePromptForCommit walks their transcript
        // and picks the latest prompt timestamped at-or-before this
        // commit. Fixes "all commits attributed to prompt #1" for
        // Codex sessions with multiple prompts.
        const resolved = resolvePromptForCommit(s, repoPath, commitTimestampMs);
        const latestPromptIdx = resolved.promptIndex;
        const latestPromptText = resolved.promptText;
        const perPromptUpdate = {
          promptIndex: latestPromptIdx,
          promptText: latestPromptText.slice(0, 1000),
          filesChanged,
          diff: diff.length > MAX_PROMPT_DIFF_LEN ? diff.slice(0, MAX_PROMPT_DIFF_LEN) : diff,
          linesAdded,
          linesRemoved,
          commitSha,
        };
        try {
          debugLog('post-commit', 'sending incremental update', {
            sessionId: s.sessionId,
            filesChanged: filesChanged.length,
            attributedPromptIdx: latestPromptIdx,
            commitSha,
          });
          await api.updateSession(s.sessionId, {
            filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
            branch: currentBranch || undefined,
            gitCapture,
            promptChanges: latestPromptText ? [perPromptUpdate] : undefined,
          });
          debugLog('post-commit', 'API update complete', { sessionId: s.sessionId });
        } catch (err: any) {
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
  if (state && !state.sessionId.startsWith('detected-')) {
    const durationMs = Date.now() - new Date(state.startedAt).getTime();

    // Parse transcript for full metrics (or use empty defaults for agents without transcripts)
    const parsed = state.transcriptPath
      ? parseTranscript(state.transcriptPath, { since: state.startedAt })
      : { prompts: [], filesChanged: [], tokensUsed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: 0, toolBreakdown: [], filesRead: [], summary: '', model: '', transcript: '' };
    const promptMappings = state.transcriptPath
      ? extractPromptFileMappings(state.transcriptPath)
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
    pushSessionBranch(repoPath);
    debugLog('post-commit', 'session files written + pushed', {
      prompts: writeData.prompts.length,
      costUsd: writeData.costUsd,
      files: writeData.filesChanged.length,
    });
  }

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

async function handlePreToolUse(input: Record<string, any>, agentSlug?: string): Promise<void> {
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

  // Extract file paths once — used for both lazy repo attach and policy enforcement.
  const toolInput = input.tool_input || {};
  const filePaths = extractFilePaths(input.tool_name || '', toolInput);
  if (filePaths.length > 0) {
    debugLog('pre-tool-use', 'extracted paths', { filePaths, toolName: input.tool_name });
  }

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
function recordLiveEdits(state: SessionState, input: Record<string, any>, repoPath: string): boolean {
  if (!liveCaptureEnabled()) return false;
  try {
    const toolName = String(input.tool_name || '');
    if (!toolName) return false;
    // Claude Code PostToolUse → tool_input; other agents vary, so fall back.
    const toolInput =
      (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input
        : (input.toolInput && typeof input.toolInput === 'object') ? input.toolInput
          : (input.tool_response && typeof input.tool_response === 'object' && input.tool_response.input) ? input.tool_response.input
            : {};
    const promptIndex = (state.prompts?.length || 0) - 1;
    if (promptIndex < 0) return false;
    const agentLabel = state.agentSlug === 'cursor' ? 'cursor' : 'claude';
    // warnUnknown=false: this fires for EVERY tool (Read/Grep/Bash…) in a
    // fresh per-call process, so the unknown-tool note would spam stderr.
    const extracted = extractEditsFromToolCall(toolName, toolInput, repoPath, agentLabel, false);
    if (extracted.length === 0) return false;
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
  return merged;
}

async function handlePostToolUse(input: Record<string, any>, agentSlug?: string): Promise<void> {
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
  if (recordLiveEdits(state, input, state.repoPath || saveCwd)) {
    saveSessionState(state, saveCwd, state.sessionTag);
  }
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

  const hookCwd = input.cwd || process.cwd();
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  if (!found) {
    debugLog('after-file-edit', 'ABORT: no session state');
    return;
  }
  const { state, saveCwd } = found;
  if (!state.repoPath || !state.prePromptSha) {
    debugLog('after-file-edit', 'ABORT: missing repoPath or prePromptSha');
    return;
  }
  const promptIdx = (state.prompts?.length || 0) - 1;
  if (promptIdx < 0) {
    debugLog('after-file-edit', 'ABORT: no current prompt');
    return;
  }

  try {
    // Re-capture working tree against the per-prompt shadow so the current
    // prompt's mapping reflects whatever Cursor just wrote to disk.
    const promptShadow = (state.promptShadows || []).find((s) => s.promptIndex === promptIdx);
    const captureBaseline = promptShadow?.shadowSha || state.prePromptSha;
    const capture = captureGitState(state.repoPath, captureBaseline, { fullContext: true });

    const filteredUncommitted = filterUncommittedDiff(
      capture.uncommittedDiff || '', uncommittedExcludeUnion(state),
    );
    const sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state);
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
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
        const dl = fullDiff.split('\n');
        await api.updateSession(state.sessionId, {
          promptChanges: state.completedPromptMappings.map((pm) => ({
            ...pm,
            promptText: (pm.promptText || '').slice(0, 1000),
            diff: (pm.diff || '').slice(0, MAX_PROMPT_DIFF_LEN),
            uncommittedDiff: (pm.uncommittedDiff || '').slice(0, MAX_PROMPT_DIFF_LEN),
            linesAdded: dl.filter((l: string) => l.startsWith('+') && !l.startsWith('+++')).length,
            linesRemoved: dl.filter((l: string) => l.startsWith('-') && !l.startsWith('---')).length,
            aiPercentage: 100,
            checkpointType: 'auto',
          })),
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

    // Skip minified/bundled build artifacts — they trigger false positives on
    // vendor library internals, example code in docs, and React/chart internals.
    const SCAN_SKIP_PATHS = [
      '/dist/', '/build/', '/public/', '/web-dist/',
      '.min.js', '.min.css', '.bundle.js', '.chunk.js',
      'node_modules/', 'vendor/', '.tgz',
    ];

    for (const entry of addedLines) {
      // Skip build artifacts and vendor bundles
      if (SCAN_SKIP_PATHS.some(p => entry.file.includes(p))) continue;
      const trimmed = entry.content.trim();
      if (trimmed.length < 5) continue;
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) continue;

      for (const pattern of PRE_COMMIT_PATTERNS) {
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(entry.content);
        if (match) {
          const matchedValue = match[1] || match[0];
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
): string[] {
  const shortId = sessionId.slice(0, 12);
  const agentName = resolveAgentDisplayName(model, agentSlug);
  const parts = [shortId, agentName];
  if (promptCount > 0) parts.push(promptCount === 1 ? '1 prompt' : `${promptCount} prompts`);
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
    return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repoPath, encoding: 'utf-8', timeout: 5_000 })
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
      const out = execFileSync('git', ['diff', '--name-only', base], { cwd: repoPath, encoding: 'utf-8', timeout: 5_000 });
      for (const f of out.trim().split('\n').filter(Boolean)) files.add(f);
    } catch { /* baseline unreachable */ }
  }
  return files;
}

export function pickActiveSessionForCommit(hookCwd: string): SessionState | null {
  // Worktree-aware lookup: falls back to the main repo's sessions when the
  // hook runs inside a linked worktree (whose own git dir holds no state
  // files), then narrows multiple candidates by last-seen lifecycle cwd.
  const activeSessions = listSessionsForGitHook(hookCwd);
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
    const staged = new Set(stagedCommitFiles(hookCwd));
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
  // Per-prompt diff baselines: promptBaselines[i] is a shadow of the tree as it
  // was at the START of prompt i, so prompt i's diff = its OWN changes (not the
  // cumulative session diff). `lastSyncShadow` is the rolling end-of-work
  // snapshot used as the next prompt's baseline.
  promptBaselines?: Record<number, string>;
  lastSyncShadow?: string;
  // Prompt indices that made uncommitted changes. When a later prompt commits
  // everything at once, the commit swept up ALL of their work, so they all get
  // linked to that commit (the "prompts in this commit" set).
  dirtyPromptIndices?: number[];
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

// agy's Stop event fires only on exit and may carry a minimal payload (no
// conversationId / transcriptPath). To still finalize the session — and capture
// any trailing prompt that triggered no tool call (so PostToolUse never fired) —
// recover the most-recently-active conversation from the on-disk brain dir.
function discoverLatestAgyConversation(): { conversationId: string; transcriptPath: string } | null {
  try {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
    let best: { conversationId: string; transcriptPath: string; mtime: number } | null = null;
    for (const cid of fs.readdirSync(brainDir)) {
      const tp = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript_full.jsonl');
      let st: fs.Stats;
      try { st = fs.statSync(tp); } catch { continue; }
      if (!best || st.mtimeMs > best.mtime) best = { conversationId: cid, transcriptPath: tp, mtime: st.mtimeMs };
    }
    return best ? { conversationId: best.conversationId, transcriptPath: best.transcriptPath } : null;
  } catch { return null; }
}

// agy tool-call args use PascalCase, varying by tool (run_command →
// CommandLine; file tools → TargetFile/FilePath/AbsolutePath/Path). Pull the
// file path (for FILE_RESTRICTION) and the command (for command policies).
export function agyToolPaths(toolCall: any): { filePath: string | null; command: string | null } {
  const args = toolCall?.args || {};
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
// The watcher lives for the WHOLE session: it exits when agy fires Stop (which
// drops a `.done` sentinel) so trailing read-only prompts are caught no matter
// how long the user idles. The idle backstop only fires if agy died WITHOUT a
// clean Stop (crash / kill) — long enough that a normal think-pause never trips
// it. A hard cap bounds a truly stuck watcher.
const AGY_WATCH_IDLE_BACKSTOP_MS = 4 * 60 * 60 * 1000; // 4h with zero transcript activity → assume agy is gone
const AGY_WATCH_MAX_MS = 12 * 60 * 60 * 1000;          // 12h absolute ceiling
const AGY_WATCH_LOCK_FRESH_MS = 15_000; // a live watcher refreshes its lock every poll; older than this = dead → respawn

function agyWatchLockPath(cid: string): string {
  return path.join(os.homedir(), '.origin', 'agy-watch', `${cid}.lock`);
}
// Sentinel written by the Stop hook so the watcher knows the agy session ended
// and can exit promptly instead of waiting out the idle backstop.
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

// Watcher entrypoint (run as a detached `origin hooks antigravity __watch`).
// Lives for the WHOLE agy session, polling the transcript so trailing prompts
// that fire no hook — including a read-only prompt sent after a long idle — are
// still synced. Exits when agy fires Stop (drops a `.done` sentinel), or after a
// long idle backstop / hard cap if agy died without a clean Stop.
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

      // agy exited (Stop hook) — Stop already did the final full capture, so
      // just exit (a post-tool-use sync here could re-open the ENDED session).
      if (fs.existsSync(donePath)) {
        debugLog('__watch', 'antigravity watcher exiting — session ended', { cid });
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

// Write (or end) a SessionState file for an agy conversation so the git-hook
// commit-attribution path treats Antigravity as a first-class session. The
// baseline shadow is stored as `sessionStartShadowSha` so staged-file matching
// can credit the session that actually produced the committed files.
function registerAgySessionState(opts: {
  serverSessionId: string;
  conversationId: string;
  repoPath: string;
  model: string;
  baselineSha?: string;
  transcriptPath: string;
  prompts: string[];
  filesChanged: string[];
  ended: boolean;
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
      lastCwd: opts.repoPath,
      sessionTag: tag,
      startedAt: existing?.startedAt || now,
      headShaAtStart: existing?.headShaAtStart ?? null,
      sessionStartShadowSha: opts.baselineSha || existing?.sessionStartShadowSha || null,
      prompts: opts.prompts,
      completedPromptMappings: touched.size > 0 ? [{ promptIndex: 0, promptText: opts.prompts[0] || '', filesChanged: [...touched] }] : (existing?.completedPromptMappings || []),
      status: opts.ended ? 'ENDED' : 'RUNNING',
      ...(opts.ended ? { endedAt: now } : {}),
    } as unknown as SessionState;
    saveSessionState(state, opts.repoPath, tag);
    // On Stop, archive it so it immediately drops out of the candidate pool.
    if (opts.ended) clearSessionState(opts.repoPath, tag);
  } catch (err: any) {
    debugLog('antigravity', 'registerAgySessionState failed (non-fatal)', { message: err?.message });
  }
}

// Detect commits the agy session made since its baseline, so a committed turn
// shows as committed (with the SHA linked) instead of stuck on "uncommitted".
// The baseline shadow's PARENT is the session-start HEAD; a recorded-HEAD
// baseline (clean start) is itself the session-start HEAD.
export function agyDetectSessionCommit(repoPath: string, baselineSha?: string): { commitSha?: string; treeClean: boolean } {
  if (!baselineSha || !/^[a-f0-9]{7,40}$/i.test(baselineSha)) return { treeClean: false };
  try {
    let startHead = baselineSha;
    try {
      // Ancestor of HEAD → a real commit (clean start); use as-is.
      execFileSync('git', ['merge-base', '--is-ancestor', baselineSha, 'HEAD'], { cwd: repoPath, timeout: 5_000 });
    } catch {
      // Not an ancestor → it's a shadow; the session-start HEAD is its parent.
      try {
        startHead = execFileSync('git', ['rev-parse', `${baselineSha}^`], { cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim();
      } catch { return { treeClean: false }; }
    }
    const log = execFileSync('git', ['log', '--format=%H', `${startHead}..HEAD`], { cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim();
    const shas = log ? log.split('\n').filter(Boolean) : [];
    if (!shas.length) return { treeClean: false };
    let treeClean = false;
    try {
      treeClean = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim() === '';
    } catch { /* leave false */ }
    return { commitSha: shas[0], treeClean };
  } catch { return { treeClean: false }; }
}

async function handleAntigravity(event: string, input: Record<string, any>): Promise<void> {
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
      const rp = (Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string')
        ? input.workspacePaths[0] : process.cwd();
      let base: string | null = null;
      try { base = createShadowCommit(rp, `agy-start-${cid.slice(0, 8)}`) || getHeadSha(rp); } catch { /* non-fatal */ }
      if (base) {
        cache = { ...(cache || {}), baselineSha: base, repoPath: rp };
        writeAgyRulesCache(cid, cache);
        debugLog('pre-tool-use', 'antigravity baseline set', { cid, base });
      }
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
  const repoPath = (Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string')
    ? input.workspacePaths[0]
    : (cachedForRepo?.repoPath || (typeof input.cwd === 'string' ? input.cwd : process.cwd()));
  if (!isConnectedMode()) return;
  const agentConfig = loadAgentConfig();
  if (!agentConfig?.machineId) return;

  let jsonl = '';
  try { jsonl = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return; }
  const parsed = parseAntigravityTranscript(jsonl);
  if (parsed.prompts.length === 0) return; // nothing capturable yet
  const usage = estimateAntigravityUsage(parsed);
  const model = parsed.model || 'gemini-3-pro';
  const branch = getBranch(repoPath) || undefined;
  // agy exposes no tokens → estimate cost from the estimated tokens × price so
  // the session shows a sensible (clearly-estimated) cost instead of $0.
  const costUsd = estimateCost(model, usage.inputTokens, usage.outputTokens);

  // Ensure/dedup the server session by conversationId.
  let sessionId: string | undefined;
  let startRes: any;
  try {
    startRes = await api.startSession({
      machineId: agentConfig.machineId,
      prompt: parsed.prompts[0],
      model,
      repoPath,
      agentSlug: 'antigravity',
      agentSessionId: conversationId,
      branch,
    } as any);
    sessionId = (startRes as any)?.sessionId;
  } catch (err: any) {
    debugLog(event, 'antigravity startSession failed (non-fatal)', { message: err?.message });
    return;
  }
  if (!sessionId) return;

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
    const cap = captureAgyDiff(repoPath, promptBaseline || null);
    filesChanged = cap.filesChanged;
    diff = cap.diff ? cap.diff.slice(0, MAX_PROMPT_DIFF_LEN) : '';
    linesAdded = cap.linesAdded;
    linesRemoved = cap.linesRemoved;
  } catch { /* non-fatal */ }

  // Roll the end-of-work snapshot forward so the NEXT prompt diffs against where
  // this one left off (clean tree → anchor on HEAD). Tag per prompt index so
  // each prompt's end-shadow keeps its own ref alive (a shared tag would move,
  // letting git GC prune a baseline an earlier prompt still points at).
  let lastSyncShadow = cachedForRepo?.lastSyncShadow;
  if (!isWatcherSync) {
    try { lastSyncShadow = createShadowCommit(repoPath, `agy-sync-${conversationId.slice(0, 8)}-${currentIdx}`) || getHeadSha(repoPath) || lastSyncShadow; } catch { /* keep previous */ }
  }

  // Track which prompts have uncommitted work. When a commit happens, every
  // such prompt's work was swept into it, so they all link to the commit.
  const { commitSha, treeClean } = agyDetectSessionCommit(repoPath, promptBaseline || undefined);
  const dirty = new Set<number>(cachedForRepo?.dirtyPromptIndices || []);
  if (filesChanged.length > 0) dirty.add(currentIdx);
  let committedIndices: number[] = [];
  if (commitSha) {
    committedIndices = [...new Set([...dirty, currentIdx])];
    dirty.clear();
  }

  // Cache the server's rules + budget lock so PreToolUse can enforce locally,
  // plus the per-prompt baselines (preserve the session baselineSha set on the
  // first pre-tool-use). REAL hooks only — the watcher never writes the cache
  // (see isWatcherSync above), so it can't race/corrupt the baselines.
  if (!isWatcherSync) writeAgyRulesCache(conversationId, {
    enforcementRules: Array.isArray(startRes?.enforcementRules) ? startRes.enforcementRules : [],
    budgetBlocked: !!startRes?.budget?.blocked,
    budgetMessage: startRes?.budget?.message,
    repoPath,
    transcriptPath,
    baselineSha: cachedForRepo?.baselineSha,
    promptBaselines,
    lastSyncShadow,
    dirtyPromptIndices: [...dirty],
  });

  // Register the agy session as a local SessionState (with the files it touched)
  // so git-hook commit attribution can SEE it and credit it for its own commit
  // — otherwise agy is invisible to prepare-commit-msg and its commits get
  // stamped with whatever other session is around (the "shown as Cursor" bug).
  // Marked ENDED on Stop so it stops being an attribution candidate. REAL hooks
  // only — it read-modify-writes the state file, so the watcher must not race it.
  if (!isWatcherSync) registerAgySessionState({
    serverSessionId: sessionId,
    conversationId,
    repoPath,
    model,
    baselineSha: cachedForRepo?.baselineSha,
    transcriptPath,
    prompts: parsed.prompts,
    filesChanged,
    ended: event === 'stop',
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
  const promptChanges = parsed.prompts.map((p, i) => {
    // Real prompt time from the transcript. agy has no UserPromptSubmit hook, so
    // without this the server stamps the DB insert time (whenever the first Stop
    // fired) — wrong, and unstable across re-parses. parsed.prompts is sorted by
    // this time, so promptIndex `i` is a stable identity for the prompt.
    const ts = parsed.promptTimes[i];
    const createdAt = ts != null ? { createdAt: ts } : {};
    if (i === currentIdx) {
      return { promptIndex: i, promptText: p, diff, uncommittedDiff, filesChanged, linesAdded, linesRemoved, authoritative: true, ...createdAt, ...(commitSha ? { commitSha } : {}) };
    }
    if (commitSha && committedSet.has(i)) {
      // Backfill the commit link onto an earlier prompt whose work it included;
      // clear its uncommitted flag without touching its stored diff.
      return { promptIndex: i, promptText: p, commitSha, uncommittedDiff: '', ...createdAt };
    }
    return { promptIndex: i, promptText: p, ...createdAt };
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
  };

  if (event === 'stop') {
    try {
      await api.endSession({
        sessionId,
        prompt: parsed.prompts.join('\n\n---\n\n'),
        promptChanges,
        transcript,
        model,
        branch,
        filesChanged,
        diff,
        ...usagePayload,
      } as any);
      debugLog('stop', 'antigravity session finalized', { sessionId, prompts: parsed.prompts.length, model, costUsd, files: filesChanged?.length || 0, turns: turns.length });
    } catch (err: any) {
      debugLog('stop', 'antigravity endSession failed (non-fatal)', { message: err?.message });
    }
    try { fs.rmSync(agyRulesCachePath(conversationId), { force: true }); } catch { /* ignore */ }
    // Signal the long-lived watcher that the session ended so it exits promptly
    // instead of polling out its idle backstop.
    try {
      const donePath = agyWatchDonePath(conversationId);
      fs.mkdirSync(path.dirname(donePath), { recursive: true });
      fs.writeFileSync(donePath, String(Date.now()));
    } catch { /* non-fatal */ }
  } else {
    try {
      await api.updateSession(sessionId, { promptChanges, transcript, model, filesChanged, diff, ...usagePayload });
    } catch (err: any) {
      debugLog('post-tool-use', 'antigravity updateSession failed (non-fatal)', { message: err?.message });
    }
    // Catch trailing output that lands AFTER this tool call (a final answer, a
    // no-tool prompt) — agy emits no event for it, so watch the transcript and
    // re-sync once it settles. No-op when this IS the watcher's own re-sync.
    spawnAgyWatcher(conversationId, repoPath, transcriptPath);
  }
}

export async function hooksCommand(event: string, agentSlug?: string): Promise<void> {
  debugLog(event, '=== HOOK INVOKED ===', { pid: process.pid, argv: process.argv, cwd: process.cwd() });

  // Internal: the detached agy transcript watcher. Reads its target from env,
  // not stdin, so handle it before readStdin() (which would otherwise block).
  if (agentSlug === 'antigravity' && event === '__watch') {
    await runAgyWatcher();
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
  } else if (agentSlug === 'windsurf') {
    try { dedupeAgentFlatHooks(event, '.windsurf', 'windsurf'); } catch (err: any) {
      debugLog(event, 'windsurf dedupe check failed (non-fatal)', { message: err?.message });
    }
  }

  const input = await readStdin();

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

  switch (event) {
    case 'session-start':
      await handleSessionStart(input, agentSlug);
      break;
    case 'user-prompt-submit':
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
