// SessionEnd: the final capture pass and the hand-off to the heartbeat.
//
// Moved out of commands/hooks.ts mechanically: the text is unchanged, only its
// home is. Shared helpers still live in hooks.ts and are imported from there.
import { backfillAcceptanceForSession } from '../../acceptance.js';
import { claudeSessionName, claudeSessionTitles, cursorSessionName } from '../../agent-session-name.js';
import { getCodexPromptsTimeline } from '../../agents/codex.js';
import { discoverGeminiTranscriptPath } from '../../agents/gemini.js';
import { isSpecificModel } from '../../agents/registry.js';
import { api } from '../../api.js';
import { applyLedgerToMappings } from '../../capture-from-ledger.js';
import { stateLedgerIsContended } from '../../ledger-producer.js';
import { preferCommitPatchForCommittedTurns } from '../../commit-patch-for-committed-turn.js';
import { preferShadowRangeForTurns } from '../../prefer-shadow-range.js';
import { isConnectedMode, loadAgentConfig, loadConfig } from '../../config.js';
import { debugLog } from '../../debug-log.js';
import { queueDevinBackfill } from '../../devin-backfill.js';
import { discoverDevinCliSessionDataByPrompt, retagDevinFromProcess } from '../../devin-cli.js';
import { readDevinLiveSession } from '../../devin-sessions-db.js';
import { capDiff } from '../../diff-budget.js';
import { MAX_PROMPT_DIFF_LEN, captureGitState, gitIgnoredFiles, readFileAtRev } from '../../git-capture.js';
import { combineApplyableTurnDiff } from '../../applyable-turn-diff.js';
import { pushAcceptanceNotes, resolvePushRemote, writeGitNotes } from '../../git-notes.js';
import { publishMemoryNotes } from '../../memory-transport.js';
import type { PromptNoteEntry } from '../../git-notes.js';
import { extractTodosFromPrompts, handoffRepresentsWork, writeHandoff } from '../../handoff.js';
import { isRepoIgnored } from '../../ignore-repos.js';
import { pushSessionBranch, writeSessionFiles } from '../../local-entrypoint.js';
import type { PromptChange, PromptEntry, SessionWriteData } from '../../local-entrypoint.js';
import { enrichDecisionsForSession, isSubstantiveMemory, memoryBriefSignature, memoryUpdateTrigger, readAllSessionMemory, readMemoryBrief, shouldWriteMemoryOnSessionEnd, summarizeFromCommitSubjects, writeSessionMemory } from '../../memory.js';
import type { SessionMemoryEntry } from '../../memory.js';
import { parseMarkersFromTranscript, parseMarkersFromTranscriptPath } from '../../origin-markers.js';
import type { OriginMarkers } from '../../origin-markers.js';
import { toRepoRelativePath } from '../../paths.js';
import { anchorEditPositions, backfillWriteBaselines, buildCapturesFromLedger, capturePromptEdits, dropOutOfRepoEdits, mergeLedgerWithTranscript } from '../../prompt-capture/index.js';
import type { PromptCapture } from '../../prompt-capture/index.js';
import { editSourceForAgent } from '../../prompt-capture/types.js';
import { attachOrphanCommitFiles } from '../../prompt-completeness.js';
import { applyImageDescriptions } from '../../prompt-images.js';
import { redactSecrets } from '../../redaction.js';
import { adoptRegisteredReservation, clearSessionState, clipMappingsToPromptHistory, dropSessionMirror, getBranch, getGitCommonDir, getGitRoot, getHeadSha, getWorkingGitRoot, isPendingReservation, isProvisionalSessionId, reconcilePromptHistory, resolveSessionBranch, saveSessionState, stampCaptured, stopHeartbeat, turnBaseline } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import { memorySummaryMode, synthesizeSessionSummary } from '../../session-summary.js';
import { samePath, sessionWorkTree, shellWindowTarget } from '../../session-worktree.js';
import { addTodosFromSession, readMemoryTodos } from '../../todo.js';
import { recordPendingClosures } from '../../todo-sweep.js';
import { estimateCost, extractPromptFileMappings, formatTranscriptForDisplay, parseTranscript } from '../../transcript.js';
import type { ParsedTranscript, PromptFileMapping } from '../../transcript.js';
import { durableEndSession } from '../../update-queue.js';
import { querySqlite } from '../../utils/sqlite.js';
import { readJournalEntries } from '../../write-journal-watch.js';
import { handleStop } from '../hooks/stop.js';
import { condenseAndCleanupSession } from '../snapshot.js';
import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { localTurnForServerRow, rebaseToServerRows, turnIdForServerRow } from '../../turn-index.js';
import { applyAuthoredTotals, currentSessionWorkTree, inheritedBaselineForTurn, inheritedBeforeStatesForTurn, filterUncommittedDiff, findStateForHook, hookLookupSessionId, liveCaptureEnabled, normalizeWorkspaceRoot, recordShellWindowEdits, sessionAuthoredSnapshot, sessionScopedCommittedDiff, uncommittedExcludeUnion } from '../hooks.js';


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
export function resolveAgentSessionName(state: SessionState): string | null {
  switch (state.agentSlug) {
    case 'claude-code': {
      const name = claudeSessionName(state.transcriptPath);
      if (!name) {
        // A nameless Claude session is either untitled or a reader gap — the
        // Windows sessions that carried only `ai-title` records looked like
        // the former for two weeks. Say which sources were empty.
        const t = claudeSessionTitles(state.transcriptPath);
        debugLog('agent-session-name', 'claude-code: no name found', {
          transcriptPath: state.transcriptPath, transcriptRead: t.transcriptRead,
          hasCustomTitleRecord: t.hasCustomTitleRecord, sidecar: !!t.sidecarTitle, aiTitle: !!t.aiTitle,
        });
      }
      return name;
    }
    case 'cursor':
      return cursorSessionName(state.agentSessionId || '', querySqlite);
    default:
      return null;
  }
}

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
export function getWorkingTreeSha(repoPath: string): string | null {
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

export const durableEnd = (sessionId: string, data: any) =>
  durableEndSession(sessionId, data, (e, m, d) => debugLog(e, m, d));

export function buildPromptNoteEntries(
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
  const prompts = reconcilePromptHistory(state.prompts, parsed.prompts, {
    collapseTrailingRepeat: state.agentSlug === 'cursor',
  });
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
    // A ledger-owned turn is never rebuilt from its commit. `git show <sha>` is
    // the COMMIT's contents, which is not the same set as this turn's writes —
    // a `git commit -a` sweeps up whatever else was dirty, and a turn that
    // absorbed a merge takes the whole branch. The ledger recorded what this
    // turn actually wrote, so re-deriving from git here would replace an
    // observation with a guess, which is the one thing stage 2 forbids.
    const ledgerOwned = (m as { ledgerOwned?: boolean }).ledgerOwned === true
      || (m as { diffSource?: string }).diffSource === 'ledger';
    if (!ledgerOwned && (!diff.trim() || soleForCommit) && commitSha && /^[0-9a-f]{7,40}$/i.test(commitSha) && repoRoot) {
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
      ...(Array.isArray((m as { contentUnavailableFiles?: string[] }).contentUnavailableFiles)
        ? { contentUnavailableFiles: (m as { contentUnavailableFiles?: string[] }).contentUnavailableFiles }
        : {}),
      // Provenance travels WITH the content it describes, so the read path can
      // tell an observed diff from a reconstructed one.
      ...((m as { diffSource?: 'ledger' }).diffSource ? { diffSource: 'ledger' as const } : {}),
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
export function spawnMemoryBriefChild(
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
export function scheduleMemoryBriefRefresh(
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
export { localTurnForServerRow };

/**
 * `turnBaseline` for an index that arrived in SERVER space.
 *
 * A row we have no local shadow for falls back to the session's start-state,
 * which is exactly what turnBaseline already does for an unrecorded turn — so
 * a pre-adoption row degrades to "the session's start" instead of borrowing
 * some other turn's.
 */
export function turnBaselineForServerRow(state: SessionState, serverIndex: number): string | null {
  const local = localTurnForServerRow(serverIndex, state.promptIndexBase);
  // -1 matches no shadow, so turnBaseline takes its own fallback path.
  return turnBaseline(state, local ?? -1);
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
  // A session-start reservation is registered by session-start. Registering
  // it here as well is how one chat became two rows: the prompt hook adopted
  // the reservation while `session/start` was in flight, then "migrated" it.
  // The pre-mint re-check in user-prompt-submit already refused this; the
  // adoption path that found the reservation on its FIRST lookup did not go
  // through that re-check, and this was its next stop. Refuse at the source.
  // If session-start has landed its id since the caller read the row, take
  // that id instead — no call needed. Past the reservation's age bound the
  // start hook is presumed dead and every prompt is a retry point again.
  if (isProvisionalSessionId(state.sessionId) && !opts.remintGone && isPendingReservation(state)) {
    const adoption = adoptRegisteredReservation(state, saveCwd, state.sessionTag);
    if (adoption) {
      debugLog(scope, 'reservation was registered by session-start — adopting its id instead of minting', adoption);
      try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
      return true;
    }
    debugLog(scope, 'reservation still registering — leaving session/start to session-start', {
      local: state.sessionId, startedAt: state.startedAt,
    });
    return false;
  }
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
      const previousId = state.sessionId;
      state.sessionId = newId;
      try { saveSessionState(state, saveCwd, state.sessionTag); } catch { /* non-fatal */ }
      // The mirror under the old id is orphaned by the rename (see
      // dropSessionMirror); a gone server id that was re-minted leaves one too.
      if (previousId !== newId) dropSessionMirror(previousId);
      return true;
    }
  } catch (err: any) {
    debugLog(scope, 'local→server migration failed (non-fatal)', { message: err?.message });
  }
  return false;
}

export async function handleSessionEnd(input: Record<string, any>, agentSlug?: string): Promise<void> {
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
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug, input.conversation_id), agentSlug);
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

    const prompts = reconcilePromptHistory(state.prompts, parsed.prompts, {
    collapseTrailingRepeat: state.agentSlug === 'cursor',
  });
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
    // The committed side is the session's OWN commits, each by its authored
    // contribution — not `session-start..HEAD`, which holds every commit that
    // reached the branch meanwhile (another agent's, a merge's whole other
    // side). Same function post-commit and Stop use, so the number session
    // end stores is the number they stored. Sent as a snapshot so the server
    // REPLACES whatever a weaker producer appended, rather than merging onto
    // it. The uncommitted side stays what scopeSessionDiffToStart produced.
    let endIsAuthoredSnapshot = false;
    try {
      const authoredEnd = sessionAuthoredSnapshot(state.repoPath, state, { uncommittedDiff: gitCapture.uncommittedDiff || '' });
      if (authoredEnd.source !== 'none') {
        gitCapture.diff = authoredEnd.diff;
        gitCapture.linesAdded = authoredEnd.linesAdded;
        gitCapture.linesRemoved = authoredEnd.linesRemoved;
        gitCapture.commitShas = authoredEnd.commitShas;
        applyAuthoredTotals(state, authoredEnd);
        endIsAuthoredSnapshot = true;
        debugLog('session-end', 'session diff is the authored snapshot', {
          source: authoredEnd.source, commits: authoredEnd.commitShas.length,
          linesAdded: authoredEnd.linesAdded, linesRemoved: authoredEnd.linesRemoved,
        });
      }
    } catch (err: unknown) {
      debugLog('session-end', 'authored snapshot failed (non-fatal) — keeping the range capture', {
        message: err instanceof Error ? err.message : String(err),
      });
    }

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
          diff: combineApplyableTurnDiff({
            committedDiff: sessionCommitted,
            uncommittedDiff: filteredUncommitted,
            workingTreeDiff: lastPromptCapture.workingTreeDiff || '',
          }).slice(0, 200_000),
          uncommittedDiff: filteredUncommitted.slice(0, 200_000),
          commitSha: lastCommitSha,
          treeSha: lastTreeSha,
        };
        const existingIdx = state.completedPromptMappings.findIndex(m => m.promptIndex === lastPromptIdx);
        if (existingIdx >= 0) {
          state.completedPromptMappings[existingIdx] = stampCaptured(lastMapping);
        } else {
          state.completedPromptMappings.push(stampCaptured(lastMapping));
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

    // The ledger's answer, where it has one — the same wholesale precedence
    // Stop and the watcher apply. session-end is the ONLY producer that did
    // not: a conversation closed mid-turn (no Stop) had its last turn rebuilt
    // here from the git window alone, the reconstruction the ledger exists to
    // replace, and a turn Stop had already captured exactly could be re-sent
    // from the same reconstruction with a fresher stamp.
    try {
      const fromLedger = applyLedgerCaptures(state, promptMappings as any);
      if (fromLedger > 0) {
        debugLog('ledger', 'turns captured from the ledger at session end', { count: fromLedger, of: promptMappings.length });
      }
    } catch { /* the ledger never blocks the end of a session */ }

    // Mappings are server rows, `prompts` is this launch's local list.
    promptMappings = clipMappingsToPromptHistory(
      promptMappings, prompts,
      Math.max(parsed.promptIndexBase || 0, state.promptIndexBase || 0),
    );

    try {
      const fromShadows = preferShadowRangeForTurns(
        state, promptMappings as any, state.repoPath || '',
        { log: (event, data) => debugLog('session-end', event, data) },
      );
      if (fromShadows > 0) {
        debugLog('session-end', 'turns scoped to their shadow window', {
          count: fromShadows, of: promptMappings.length,
        });
      }
    } catch { /* never block the end of a session */ }

    // Same pass Stop runs. Agents that actually terminate here (Gemini, a
    // killed process) never get a later Stop to put the commit patch back;
    // without this, session-end re-sends baseline..HEAD with the newest stamp.
    try {
      const fromCommits = preferCommitPatchForCommittedTurns(
        state, promptMappings as any, state.repoPath || '',
        {
          inheritedBaseline: (shadowSha, localTurn) => inheritedBaselineForTurn(
            state.repoPath || '', state, shadowSha, localTurn,
          ),
          log: (event, data) => debugLog('session-end', event, data),
        },
      );
      if (fromCommits > 0) {
        debugLog('session-end', 'committed turns carrying their commit patch', {
          count: fromCommits, of: promptMappings.length,
        });
      }
    } catch { /* same as the ledger: never block the end of a session */ }

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
        // Attestation, sent again at end because this is where it is COMPLETE:
        // every commit the session made has landed by now, including ones made
        // after the last Stop. See the same field on the Stop payload.
        ...(Array.isArray(state.commitTurns) && state.commitTurns.length > 0
          ? { commitTurns: state.commitTurns.map((ct) => ({
              sha: ct.sha, turnId: ct.turnId, at: ct.at, via: ct.via,
            })) }
          : {}),
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
        gitCapture: gitCapture.diff ? { ...gitCapture, ...(endIsAuthoredSnapshot ? { snapshot: true } : {}) } : undefined,
        promptChanges: promptMappings.length > 0
          ? promptMappings.map(withDerivedLineCounts).map((pm, _i, all) => ({
              ...pm,
              promptText: (pm.promptText || '').slice(0, 1000),
              diff: capDiff(pm.diff, MAX_PROMPT_DIFF_LEN),
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
              // `pm.promptIndex` is a SERVER row; ids are numbered locally.
              ...(turnIdForServerRow(state, pm.promptIndex) && { turnId: turnIdForServerRow(state, pm.promptIndex) }),
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

    // Publish it NOW. writeGitNotes (above) already pushed the memory refs, but
    // it runs before this session's entry exists, so what it shipped was the
    // previous session's memory — this session's only left the machine on the
    // next push, and the dashboard only heard about it on the next BRANCH push
    // (hosts send no webhook for refs/notes/*). Same ordering fix the
    // acceptance notes needed; see publishMemoryNotes for the two halves.
    try {
      await publishMemoryNotes(state.repoPath, 'session-end');
    } catch (err: any) {
      debugLog('session-end', 'memory publish error (non-fatal)', { message: err?.message });
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

    // The other half: a session that DISCHARGED a prior leftover says so with
    // [Origin: Closes], and that claim is recorded against the TODO it names.
    //
    // Runs after the memory write above so the claim is matched against a note
    // that already contains this session's own leftovers — a session that
    // opened and closed the same loop should not leave it open.
    //
    // Recorded as PENDING. At session end the work is in a working tree or on a
    // branch; the promotion to closed happens once it is on the default branch
    // (todo-sweep.ts). Nothing disappears from `origin todo list` here.
    try {
      const closes = sessionMarkers?.closes || [];
      if (closes.length > 0) {
        const recorded = recordPendingClosures({
          repoPath: state.repoPath,
          sessionId: state.sessionId,
          markers: closes,
          openTodos: readMemoryTodos(state.repoPath).map((t) => ({ id: t.id, text: t.text })),
          shas: gitCapture.commitShas,
        });
        debugLog('session-end', 'todo closures claimed', { claimed: closes.length, recorded });
      }
    } catch {
      // Non-fatal — a claim that fails to record leaves the TODO open, which is
      // the safe direction.
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

// Build ONE session-memory entry from live session state. Shared by the
// session-end and per-commit writers (config.memoryUpdate) so both stay in
// sync; writeSessionMemory upserts by sessionId, so repeated writes collapse to
// a single, latest entry per session.
/**
 * Rewrite each prompt's `[image]` placeholders to carry the caption the server
 * generated for that image, for the copy that goes into git notes.
 *
 * The captions arrive keyed in NATIVE transcript index space (that is what the
 * image extractor counts in, and what the server stores rows under), while
 * `prompts` is LOCAL — it holds only the turns THIS launch saw. The two
 * coincide until a session is resumed or adopted, at which point using one for
 * the other hands a turn someone else's screenshot. Hence the conversion.
 */
export function describePromptImages(
  prompts: string[],
  state: { promptIndexBase?: number; promptImageDescriptions?: Record<string, string> },
): string[] {
  const descriptions = state.promptImageDescriptions;
  if (!descriptions || Object.keys(descriptions).length === 0) return prompts;

  // local prompt index → { imageIndex → caption }
  const byLocalPrompt = new Map<number, Record<number, string>>();
  for (const [key, description] of Object.entries(descriptions)) {
    const [rawPrompt, rawImage] = key.split(':');
    const nativeIndex = Number(rawPrompt);
    const imageIndex = Number(rawImage);
    if (!Number.isInteger(nativeIndex) || !Number.isInteger(imageIndex)) continue;
    const local = localTurnForServerRow(nativeIndex, state.promptIndexBase);
    // Null means the turn ran before this launch adopted the conversation —
    // we hold no prompt of our own for it, and guessing a slot would caption
    // a different turn's image.
    if (local === null || local < 0 || local >= prompts.length) continue;
    const forPrompt = byLocalPrompt.get(local) || {};
    forPrompt[imageIndex] = description;
    byLocalPrompt.set(local, forPrompt);
  }
  if (byLocalPrompt.size === 0) return prompts;

  return prompts.map((text, i) => {
    const forPrompt = byLocalPrompt.get(i);
    return forPrompt ? applyImageDescriptions(text, forPrompt) : text;
  });
}

export function buildMemoryEntry(
  state: { sessionId: string; startedAt: string; prompts?: string[]; branch?: string | null; agentSlug?: string; promptIndexBase?: number; promptImageDescriptions?: Record<string, string> },
  opts: { agentSlug?: string; model: string; branch: string | null; filesChanged: string[]; linesAdded: number; linesRemoved: number; summary?: string | null; prompts?: string[]; fileNotes?: Record<string, string>; decisions?: string[]; markers?: OriginMarkers },
): SessionMemoryEntry {
  // Captions in, before anything reads these. Everything below turns prompts
  // into the record a future agent gets — intent, summary, TODOs — and all of
  // it is text, so a turn that was a screenshot arrives as `[image]` and says
  // nothing. This is the one place the caption belongs: the notes, not the wire.
  const prompts = describePromptImages(opts.prompts || state.prompts || [], state);
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

// Union of files-read from the transcript parse and the hook-captured
// state.filesRead (pre-tool-use records Read-style tools live). Deduped,
// capped, undefined when empty so the API payload stays clean.
export function mergeFilesRead(fromTranscript: string[], fromState?: string[]): string[] | undefined {
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
export const CAPTURE_ID = `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

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
    // …or unless the saved mapping is the ledger's answer. The transcript is
    // a reconstruction of tool calls; the ledger observed the writes.
    if (prev && (prev as { diffSource?: string }).diffSource === 'ledger'
      && (m as { diffSource?: string }).diffSource !== 'ledger') continue;
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
export function turnIdFor(state: SessionState, promptIndex: number): string | undefined {
  const id = state.promptTurnIds?.[promptIndex];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The turn's out-of-repo files from BOTH sources: edits the capture already
 *  peeled off as outside the repo, and anything it wrote into a nested repo,
 *  which git hides from the parent entirely. */
export function outOfRepoFilesFor(
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
export function nestedRepoWritesForOpenTurn(state: SessionState): string[] {
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
        // toRepoRelativePath, not path.relative: the latter returns OS-native
        // separators, so on Windows this emitted `random_project\dice.py`
        // while every other capture path keys on forward slashes — the file
        // was captured and then matched nothing downstream. Caught only once
        // the doubled-drive-letter collection error stopped hiding this test.
        out.push(toRepoRelativePath(repoPath, full));
      }
    };
    walk(abs);
  }
  return out;
}

export function outOfRepoFilesFromEditsJson(raw: string | undefined | null): { outOfRepoFiles: string[] } | Record<string, never> {
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
export function applyLiveLedger(captures: PromptCapture[], state: SessionState, scope: string): PromptCapture[] {
  if (!liveCaptureEnabled() || !state.liveEdits || state.liveEdits.length === 0) return captures;
  // The ledger is numbered by this launch's local counter; the transcript
  // captures by the turn's native position. Lift the ledger onto server rows
  // BEFORE the merge, or a resumed conversation's first turn (local 0) is
  // welded onto the row of turn one (server 0) — the fallback index
  // mergeLedgerWithTranscript keeps for an edit the transcript never saw.
  const ledger = rebaseToServerRows(buildCapturesFromLedger(state.liveEdits), state.promptIndexBase);
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

/**
 * Hand each turn the ledger's answer, where the ledger has one.
 *
 * Thin wrapper over the shared `applyLedgerToMappings` — Stop, the heartbeat
 * and the transcript watcher all use it, so the precedence rule lives in one
 * place instead of three.
 */
export function applyLedgerCaptures(
  state: SessionState,
  promptMappings: Array<Record<string, unknown> & { promptIndex: number }>,
): number {
  const repoPath = currentSessionWorkTree(state) || state.repoPath;
  return applyLedgerToMappings({
    ...state,
    ledgerContended: stateLedgerIsContended(state, repoPath),
  } as any, promptMappings as any, {
    readEntries: readJournalEntries,
    readAtRev: repoPath ? (sha, file) => readFileAtRev(repoPath, sha, file) : undefined,
    ignoredFiles: repoPath ? (files) => gitIgnoredFiles(repoPath, files) : undefined,
    // A checkout, pull, rebase or merge inside the turn's window rewrote files
    // on disk; the watcher saw writes and cannot tell whose they were.
    inheritedBefore: repoPath
      ? (baselineSha, localTurn) => inheritedBeforeStatesForTurn(repoPath, state, baselineSha, localTurn)
      : undefined,
    log: (event, data) => debugLog('ledger', event, data),
  });
}

// Run the shell window over every worktree this turn revealed, in addition to
// the session's main tree. Each uses ITS OWN baseline — mixing a baseline from
// one tree with the files of another reports the whole branch delta.
export function recordDiscoveredWorkTreeEdits(state: SessionState, promptIndex: number): boolean {
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
