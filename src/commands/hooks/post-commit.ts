// The git post-commit hook: attribute a commit to the session and turn that made it.
//
// Moved out of commands/hooks.ts mechanically: the text is unchanged, only its
// home is. Shared helpers still live in hooks.ts and are imported from there.
import { findCodexRolloutPath, getCodexPromptsTimeline } from '../../agents/codex.js';
import type { PromptTimelineEntry } from '../../agents/codex.js';
import { getGeminiPromptsTimeline } from '../../agents/gemini.js';
import { attributionPgrepChecks, isCodexLikeModel, sessionMatchesAgent, standalonePgrepChecks } from '../../agents/registry.js';
import { api } from '../../api.js';
import { maybeAutoSyncBenchmark } from '../../benchmark-auto-sync.js';
import { backfillCodexPromptMappings } from '../../codex-prompt-mapping.js';
import { isConnectedMode, loadConfig } from '../../config.js';
import { debugLog } from '../../debug-log.js';
import { readDevinDesktopSessions, selectDevinSessionForRepo } from '../../devin-desktop.js';
import type { DevinDesktopSession } from '../../devin-desktop.js';
import { capDiff, fitDiffToBudget } from '../../diff-budget.js';
import { MAX_PROMPT_DIFF_LEN, capCommitMessage, captureGitState, commitDiffScopedToPrompt, commitLineCounts } from '../../git-capture.js';
import { writeGitNotes } from '../../git-notes.js';
import { BACKFILL_TIMEOUT_MS, COMMIT_INGEST_TIMEOUT_MS, RECENT_SHAS_LIMIT, acquireBackfillLock, backfillUnknownCommits, commitAuthoredDelta, extractCommitDiff, listRecentShas, releaseBackfillLock, shouldAdvertiseHistory, writeSyncMarker } from '../../history-backfill.js';
import { pushSessionBranch, writeSessionFiles } from '../../local-entrypoint.js';
import { memoryUpdateTrigger, shouldWriteMemoryOnCommit, summarizeFromCommitSubjects, writeCommitMemory, writeSessionMemory } from '../../memory.js';
import { parseMarkersFromTranscriptPath } from '../../origin-markers.js';
import type { OriginMarkers } from '../../origin-markers.js';
import { currentTurnIndex, getBranch, getGitRoot, getHeadSha, getWorkingGitRoot, isSessionAlive, listActiveSessions, listMirroredSessionsForTree, markSessionEnded, saveSessionState, stampCaptured } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import { estimateCost, extractPromptFileMappings, livePrompts, parseTranscript } from '../../transcript.js';
import type { ParsedTranscript } from '../../transcript.js';
import { drainUpdateQueue, durableUpdateSession, enqueueFailedUpdate, isRetriableApiError, persistUpdateBeforeWork } from '../../update-queue.js';
import { isProcessRunning, uniqueMatchingId } from '../../utils/process-detect.js';
import { ensureSqlite } from '../../utils/sqlite.js';
import { condenseSnapshot, listSnapshots } from '../snapshot.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { serverRowForLocalTurn, turnIdForServerRow } from '../../turn-index.js';
import { applyLedgerCaptures, buildMemoryEntry, buildPromptNoteEntries, buildSessionWriteData, captureStamp, commitTrailerBelongsToSession, durableUpdate, isInsideRepo, ownedRangeCommitShas, rewrittenCommitsPayload, sameDir, scheduleMemoryBriefRefresh, sessionRepoRoots, sessionScopedCommittedDiff, summarizePromptPayload, trailerNamesAKnownSession, turnIdFor, withDerivedLineCounts } from '../hooks.js';


/**
 * Detect whether a process matching a registry pgrep pattern is running,
 * filtering out our own process tree to avoid false positives when the
 * pattern appears in our own argv. Cross-platform (pgrep on Unix, Win32_Process
 * command-line scan on Windows) — see utils/process-detect.ts.
 *
 * Accepts either a bare pattern or a legacy `pgrep -f "…"` command string
 * (what the registry stores), so existing call sites pass their `.cmd` verbatim.
 */
export function safePgrep(pgrepCmd: string): boolean {
  return isProcessRunning(pgrepCmd);
}

/**
 * The ONE agent whose process pattern matches, or null when zero or several do.
 * Abstaining on ambiguity is deliberate — see uniqueMatchingId.
 */
export function uniquePgrepMatch(
  checks: Array<{ cmd: string; id: string }>,
  logScope: string,
): string | null {
  const { id, matched } = uniqueMatchingId(checks, safePgrep);
  if (!id && matched.length > 1) {
    debugLog(logScope, 'multiple agent processes running — not guessing', { matched });
  }
  return id;
}

/** Added (`+`) or removed (`-`) lines in a unified diff, file headers excluded. */
export function countDiffSignLines(diff: string, sign: '+' | '-'): number {
  let n = 0;
  for (const line of diff.split('\n')) {
    if (line[0] === sign && line.slice(0, 3) !== sign + sign + sign) n++;
  }
  return n;
}

/**
 * The session-to-date COMMITTED diff for the post-commit snapshot.
 *
 * post-commit sends this with `snapshot: true`, which makes the server REPLACE
 * the stored sessionDiff — so whatever this measures becomes the session
 * header. It used to be `captureGitState(headShaAtStart).committedDiff`, i.e.
 * the raw `session-start..HEAD` range, and that range is not the session's
 * work:
 *
 *  - a MERGE brings the whole absorbed branch into it. Prod f7881a6e is the
 *    case on record: the per-turn row was fixed to credit only what the merge
 *    RESOLVED, but the session header kept counting everything it absorbed —
 *    including a file the session never opened.
 *  - in a shared checkout it also holds whatever a CONCURRENT agent committed
 *    while this session was running, which is the whole reason
 *    `sessionScopedCommittedDiff` exists.
 *
 * handleStop already answers this correctly, from the same two primitives:
 * commits this session OWNS, each rendered by `commitOwnDiff` so a merge
 * contributes only its resolution. post-commit was the last caller still on
 * the raw range — and the one that matters most, because a commit-and-go agent
 * never reaches Stop, so for those sessions the inflated header was permanent
 * rather than merely shown until session end.
 *
 * Cumulative rather than net, for the same reason Stop is: a session that
 * commits A then reverts it in B reports +1/-1, not 0/0. That is the existing
 * churn-not-net accounting, and matching Stop is the point — the two used
 * different algorithms, so the header visibly jumped when Stop landed.
 *
 * Falls back to the caller's raw range when the owned walk yields nothing.
 * Codex bypasses .git/hooks/post-commit on some installs, so
 * `sessionCommitShas` can be empty for a session that really did commit, and
 * an empty snapshot would BLANK the session diff rather than merely inflate
 * it — strictly worse than the bug being fixed.
 */
export function sessionToDateCommittedSnapshot(
  repoPath: string,
  state: SessionState,
  fallback: { diff: string; linesAdded: number; linesRemoved: number },
): { diff: string; linesAdded: number; linesRemoved: number; scoped: boolean } {
  const snap = sessionAuthoredSnapshot(repoPath, state);
  if (snap.source === 'none') return { ...fallback, scoped: false };
  return { diff: snap.diff, linesAdded: snap.linesAdded, linesRemoved: snap.linesRemoved, scoped: true };
}

// ─── The one answer to "what did this session author" ─────────────────────
//
// Session 51995e1c (2026-09-08) put the same question to six producers and
// got three answers. The turn row asked a merge commit what it RESOLVED (2
// files, +3/-3); the session accumulator added what the merge ABSORBED (13
// files, +326/-71); the read side then recovered those 13 files back into a
// header that post-commit had just stored correctly. Every one of those paths
// had its own arithmetic, and each was fixed on its own — #1385 the turn,
// #1409 the header, #1473 checkouts — while the next path kept the old answer.
//
// So: two functions, and everything that describes a session's authorship
// derives from them.
//
//   commitAuthoredDelta   — what ONE commit contributed. A merge contributes
//                           its resolution; a plain commit contributes its
//                           patch. Never the first-parent view of a merge,
//                           which is the whole other branch.
//   sessionAuthoredSnapshot — what the SESSION has authored so far: its own
//                           commits, each rendered by commitAuthoredDelta and
//                           stripped of pre-session dirt, plus whatever
//                           uncommitted work the caller hands in. Counts are
//                           taken from the resulting text, never summed from
//                           parts, so a file touched twice counts once.
//
// The Commit ROW ingest, the session accumulator, the memory entry, the turn
// row, Stop's and session-end's session-level snapshots, and the transcript
// watcher's, all call these. `origin verify-capture` checks the header they
// produce against the turn rows, so a seventh producer with its own
// arithmetic fails locally before it ships.

// commitAuthoredDelta / renderAuthoredCommits live in history-backfill.ts
// (beside mergeOwnDiff, with no hook-side imports) and are re-exported here so
// every hooks consumer reaches them from one place.
export { commitAuthoredDelta, renderAuthoredCommits, type CommitAuthoredDelta } from '../../history-backfill.js';

export interface SessionAuthoredSnapshot {
  /** Committed + uncommitted, one text; the counts below are taken from it. */
  diff: string;
  committedDiff: string;
  uncommittedDiff: string;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  /** The commits the committed side was rendered from. */
  commitShas: string[];
  /**
   * `owned`   — rendered from the session's recorded commits.
   * `trailer` — no commit was recorded (a hook was missed) but the range
   *             since session start holds commits whose trailer names this
   *             session; those were rendered instead.
   * `none`    — nothing committed; only the uncommitted side, if any.
   */
  source: 'owned' | 'trailer' | 'none';
}

/**
 * Everything the session has authored so far, from its own commits and the
 * uncommitted work the caller passes in. The uncommitted side is the caller's
 * because each caller already filters it differently (a turn's baseline, the
 * session-start shadow, the dirt lists); what is shared is the committed side
 * and the rule that the totals come from the one combined text.
 */
export function sessionAuthoredSnapshot(
  repoPath: string,
  state: SessionState,
  opts: { uncommittedDiff?: string | null } = {},
): SessionAuthoredSnapshot {
  let committed = '';
  let source: SessionAuthoredSnapshot['source'] = 'none';
  let commitShas: string[] = [];
  try {
    committed = sessionScopedCommittedDiff(repoPath, state);
  } catch { /* range unreadable — fall through to the trailer walk */ }
  if (committed) {
    source = 'owned';
    commitShas = (state.sessionCommitShas || []).filter((s) => /^[a-fA-F0-9]{7,40}$/.test(s));
  } else {
    // Codex bypasses .git/hooks/post-commit on some installs, so the recorded
    // list can be empty for a session that really did commit. The commits in
    // range whose trailer names this session are still ours — render those,
    // each by its OWN contribution, never `git show` on a merge.
    let trailerOwned: string[] = [];
    try { trailerOwned = ownedRangeCommitShas(repoPath, state); } catch { trailerOwned = []; }
    const parts: string[] = [];
    for (const sha of trailerOwned) {
      try {
        const own = commitAuthoredDelta(repoPath, sha);
        if (own.diff) parts.push(own.diff);
      } catch { /* a sha a rebase removed */ }
    }
    if (parts.length > 0) {
      committed = parts.join('\n').trim();
      source = 'trailer';
      commitShas = trailerOwned;
    }
  }
  const uncommitted = (opts.uncommittedDiff || '').trim();
  const diff = (committed + (uncommitted ? '\n' + uncommitted : '')).trim();
  return {
    diff,
    committedDiff: committed,
    uncommittedDiff: uncommitted,
    filesChanged: filesNamedInDiff(diff),
    linesAdded: countDiffSignLines(diff, '+'),
    linesRemoved: countDiffSignLines(diff, '-'),
    commitShas,
    source,
  };
}

/**
 * Write a snapshot's totals onto the session state — the header numbers the
 * CLI keeps and sends. SET, never accumulated: the snapshot is already the
 * whole answer, and adding to it is how a merge's absorbed branch got in.
 */
export function applyAuthoredTotals(
  state: SessionState,
  snap: Pick<SessionAuthoredSnapshot, 'filesChanged' | 'linesAdded' | 'linesRemoved' | 'commitShas' | 'source'>,
): void {
  const s = state as SessionState & { filesChanged?: string[]; linesAdded?: number; linesRemoved?: number; commitCount?: number; authoredSource?: string };
  s.filesChanged = [...snap.filesChanged];
  s.linesAdded = snap.linesAdded;
  s.linesRemoved = snap.linesRemoved;
  s.commitCount = snap.commitShas.length;
  s.authoredSource = snap.source;
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
/**
 * The files a diff actually describes, in the order it names them.
 *
 * The point of reading the list off the diff rather than being handed one is
 * that the two can then never disagree: a row that says four files over three
 * `diff --git` blocks is unexplainable to anyone reading it later, and it is
 * what session 798de196 turn 2 stored. See the post-commit `pFiles` comment.
 *
 * De-duplicated, because a diff assembled from more than one capture can name
 * the same path twice.
 */
export function filesNamedInDiff(diff: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of (diff || '').matchAll(/^diff --git a\/(.*?) b\//gm)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/**
 * The post-commit payload's CONTENT UNIT — files, diff and line counts, decided
 * together so they can never describe three different things.
 *
 * `scoped` is the commit rendered from THIS turn's baseline shadow rather than
 * from the commit's parent, which is what answers "what did this turn write"
 * instead of "what is in this commit" (#1332). It is null when the commit
 * cannot be scoped — a merge, or no usable baseline — and then the commit's own
 * view is all there is.
 *
 * `filesChanged` used to ignore all of that. The lines followed `scoped` and
 * the file list was `turnFiles`, the whole commit's paths. Session 798de196
 * turn 2 ran `git add`, `git commit`, `git push`, `gh pr create` and authored
 * nothing; both halves are in one pair of hooks.log lines a millisecond apart:
 *
 *   01:41:35.694  scoped commit to prompt baseline
 *                 {promptIndex:1, commitLines:"+328/-11", promptLines:"+0/-0"}
 *   01:41:35.695  sending incremental update
 *                 {payload:[{i:1, f:4, a:0, r:0, d:0, c:"30e527c5"}]}
 *
 * The scoping was RIGHT — `+0/-0` is the truth for that turn, because the
 * baseline shadow already held turn 1's uncommitted work. It then shipped the
 * commit's four files beside that zero.
 *
 * A file list alone was enough to corrupt the row because of how the server
 * merges (mcp.ts, "CONTENT UNIT"): a non-empty `filesChanged` lands on its own,
 * while an empty `diff` and zero counts are skipped in favour of whatever the
 * row already holds. The four files grafted onto a diff and a +326/-1 from a
 * different capture — the stored row claims four files over three `diff --git`
 * blocks, and its `linesRemoved` of 1 recounts to 9 against its own diff.
 *
 * Reading the list off the diff being sent closes it at the source: an empty
 * scoped diff yields `[]`, the server skips the field, and the turn is left as
 * the chat-only turn it was.
 *
 * NOT a truncation concern: when the scoped diff is capped, the counts are
 * taken from the same capped text, so the three stay consistent with each other
 * — which is the property that matters here. A list that describes more than
 * the diff does is the failure being fixed.
 */
export function commitTurnContentUnit(
  scoped: { diff: string; linesAdded: number; linesRemoved: number } | null | undefined,
  turnFiles: string[],
  turnDiff: string,
): { filesChanged: string[]; diff: string; linesAdded: number; linesRemoved: number } {
  if (scoped) {
    return {
      filesChanged: filesNamedInDiff(scoped.diff),
      diff: scoped.diff,
      linesAdded: scoped.linesAdded,
      linesRemoved: scoped.linesRemoved,
    };
  }
  return {
    filesChanged: turnFiles,
    diff: turnDiff,
    linesAdded: countDiffSignLines(turnDiff, '+'),
    linesRemoved: countDiffSignLines(turnDiff, '-'),
  };
}

/**
 * Every working tree a session is in. One entry for the normal case; a
 * multi-repo session lists each checkout it spans. Used to answer "is this
 * session working in the tree this git hook fired in", which `lastCwd` cannot
 * answer — that records a subdirectory as often as a root.
 */
export function sessionTrees(s: { repoPath?: string | null; repoPaths?: string[] | null }): string[] {
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
export function worksInAnotherTree(
  s: { repoPath?: string | null; repoPaths?: string[] | null },
  hookTree: string,
): boolean {
  const trees = sessionTrees(s);
  if (trees.length === 0) return false;
  return !trees.some((t) => sameDir(t, hookTree));
}

export function pathNamesSession(
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

export function listSessionsForGitHookUnscoped(
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
  // A commit belongs to the tree it was made in. Applied to the whole live pool
  // BEFORE the narrowing below, because the narrowing can collapse to a single
  // candidate on its own and every caller then trusts that one absolutely —
  // which is how a sibling worktree's session ended up owning this one's commit
  // with `ofActive: 1` in the log. See excludeSessionsFromOtherTrees.
  sessions = excludeSessionsFromOtherTrees(sessions, hookCwd);
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
      // An exact lastCwd match used to be returned ALONE, and both commit
      // hooks trust a lone candidate absolutely. But lastCwd is only where a
      // session's last lifecycle hook fired: a session that ran `cd
      // packages/cli` for its tests is at a subdirectory of this same tree,
      // and it is the one mid-commit. Session e1095412 (2026-09-08) lost both
      // of its commits this way to session 29b32c38 — the earlier chat in the
      // same worktree, still open and idle, parked at the root — with
      // `narrowed by lastCwd, matched: [29b32c38]` and `ofActive: 1` in the
      // log. Its open turn had every staged file in its ledger; the picker
      // never saw it.
      //
      // Keep every live session working in THIS tree. The exact match stays
      // first and is the tie-break both pickers fall back to when the file
      // evidence does not separate the candidates (`pickSessionForCommit`
      // reason 'cwd', `breakTie` in git-hooks.ts), so a lone root-cwd session
      // beside idle siblings still wins — it just no longer beats a sibling
      // whose open turn staged the commit.
      const sameTree = sessions.filter((s) =>
        !exact.includes(s)
        && !!s.lastCwd
        && sessionTrees(s).some((t) => sameDir(t, hookTree))
        && isInsideRepo(hookTree, s.lastCwd));
      debugLog('git-hook-sessions', 'narrowed by lastCwd', {
        hookCwd,
        matched: exact.map(s => s.sessionId.slice(0, 12)),
        keptSameTree: sameTree.map(s => s.sessionId.slice(0, 12)),
        keptUnknownCwd: unknownCwd.map(s => s.sessionId.slice(0, 12)),
      });
      return [...exact, ...sameTree, ...unknownCwd];
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

/**
 * A commit belongs to the working tree it was made in. Nothing else.
 *
 * The narrowing above states this in its own comments — "sessions in a
 * different tree stay dropped" — but only ever enforces it on the `inHookTree`
 * rung. Every other exit (a lone candidate, the mirror recovery, the
 * `return sessions` passthrough) hands back whatever it found, and BOTH commit
 * hooks then trust a single candidate absolutely: `pickActiveSessionForCommit`
 * returns early on `length === 1` before it scores anything, and post-commit
 * takes `activeSessions[0]`.
 *
 * Session bd3c110a, this machine, 14:25:43 — six live Claude worktrees:
 *
 *   [prepare-commit-msg] trailers written  {"sessionId":"bd3c110a-286", …}
 *   [post-commit] disambiguated by Origin-Session trailer  {"ofActive":1}
 *   [post-commit] recorded commit on session  {"commitSha":"6d9fdd4c", …}
 *   [post-commit] branch changed
 *       {"from":"claude/prompt-2-to-3-migration-6388f5",
 *          "to":"claude/image-capture-modes"}
 *
 * `6d9fdd4c` was committed in the `screenshots-prompts-strategy-da0c24`
 * worktree by session d731ff09. bd3c110a lives in `adoring-cerf-65e553` and
 * never touched it. prepare-commit-msg stamped bd3c110a's id into the sibling's
 * commit message, and from there it was not a guess any more: the trailer is
 * the strongest signal post-commit has, so it took the commit with full
 * confidence, restamped the session's branch, and pushed the commit's 15 files
 * / +454/-22 onto turn 2 of a session that wrote two files. The session page
 * read "17 files · +728/-43 · 3 commits · 2 branches".
 *
 * The rule below is not a tie-breaker or another rung — it is a precondition,
 * so it runs on the whole live pool BEFORE the narrowing, which can collapse to
 * one candidate by itself. It only decides at all when some candidate actually
 * claims this tree; an unclaimed worktree is left exactly as it was. The
 * carve-outs are required, for the same reason the `inHookTree` rung needs
 * both halves:
 *
 *   • a session with NO recorded tree is unknown, not elsewhere — kept, exactly
 *     as `unknownCwd` keeps it today;
 *   • a session whose recorded tree is elsewhere but whose lastCwd is INSIDE
 *     this tree has moved here (an agent that `cd`-ed into a worktree by hand —
 *     see session-worktree.ts) and is kept, or its own commits would go
 *     unattributed;
 *   • a session the hook's own path NAMES is kept whatever its recorded tree
 *     says. A session registers its state before the harness creates its
 *     worktree, so `repoPath` is legitimately the main checkout while the
 *     commit happens in `…/worktrees/<its own id>`. The path naming the session
 *     outranks a recorded tree that predates it — this is the existing
 *     `owning` rung, and dropping it here would re-open the "commit credited to
 *     nobody" case it was written for.
 *
 * What is dropped is only the provable case: a session whose tree is known, is
 * not this one, which was last seen outside this one, and which this path does
 * not name.
 */
export function excludeSessionsFromOtherTrees(
  sessions: SessionState[],
  hookCwd: string,
): SessionState[] {
  if (sessions.length === 0) return sessions;
  // getWorkingGitRoot, NOT getGitRoot: the latter collapses a linked worktree
  // to the MAIN repo, which makes every worktree session "elsewhere" and drops
  // the whole list — including the one that owns the commit. The narrowing
  // below uses the working root for exactly this reason.
  const hookTree = getWorkingGitRoot(hookCwd) || hookCwd;
  // Only decide when the tree HAS an owner among the candidates. An unclaimed
  // worktree is the mid-session EnterWorktree case — the session registered
  // under the main checkout before the worktree existed, the worktree fallback
  // reached out to find it, and its recorded tree being "elsewhere" is exactly
  // what that fallback expects. Dropping it there credits the commit to nobody,
  // which is the failure worktree-capture.test.ts pins.
  if (!sessions.some((s) => !worksInAnotherTree(s, hookTree))) return sessions;
  const kept = sessions.filter((s) =>
    !worksInAnotherTree(s, hookTree)
    || (!!s.lastCwd && isInsideRepo(hookTree, s.lastCwd))
    || pathNamesSession(s, hookCwd));
  if (kept.length !== sessions.length) {
    debugLog('git-hook-sessions', 'dropped sessions working in another tree', {
      hookCwd,
      hookTree,
      dropped: sessions
        .filter((s) => !kept.includes(s))
        .map((s) => `${s.sessionId.slice(0, 12)}@${s.repoPath || '?'}`),
      kept: kept.map((s) => s.sessionId.slice(0, 12)),
    });
  }
  return kept;
}

export function listSessionsForGitHook(
  hookCwd: string,
  opts?: { commitFiles?: string[] },
): SessionState[] {
  return listSessionsForGitHookUnscoped(hookCwd, opts);
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
export function resolvePromptForCommit(
  state: SessionState | null,
  repoPath: string,
  commitTimestampMs: number,
): { promptIndex: number; promptText: string; total: number } {
  // `livePrompts` prefers the transcript when it is further along than
  // state.prompts — a submit hook killed at its timeout leaves the list short
  // by the very turn that is committing, which filed three of this session's
  // own commits one turn early. Longer only; see livePrompts.
  const fromState = livePrompts(state || {});
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

// ─── Git Hook: Post-Commit ────────────────────────────────────────────────

/** A session's file evidence, whether or not its turn has finished. */
export type FileEvidenceSession = {
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
export function inFlightEditedFiles(session: FileEvidenceSession): string[] {
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
 * Did the prompt that is running — submitted, not yet closed by Stop — record
 * a committed file through its own captures? Read from the edit hook's mapping
 * for that index and the live ledger, never inferred from time.
 */
export function runningTurnTouchedCommit(
  state: { completedPromptMappings?: Array<{ promptIndex: number; filesChanged?: string[] }>; liveEdits?: Array<{ promptIndex: number; edits?: Array<{ file: string }> }> },
  running: number,
  commitFiles: string[],
): boolean {
  if (!commitFiles || commitFiles.length === 0) return false;
  const baseOf = (f: string): string => f.split('/').pop() || f;
  const wanted = new Set(commitFiles.map(baseOf));
  for (const m of state.completedPromptMappings || []) {
    if (m.promptIndex !== running) continue;
    for (const f of m.filesChanged || []) if (wanted.has(baseOf(f))) return true;
  }
  for (const b of state.liveEdits || []) {
    if (b.promptIndex !== running) continue;
    for (const e of b.edits || []) if (e?.file && wanted.has(baseOf(e.file))) return true;
  }
  return false;
}

/**
 * May the ONLY live session be credited with this commit?
 *
 * Both commit hooks used to trust a lone candidate absolutely: one session in
 * the repo meant the commit was its. Session b3b45536 (lumen-interiors,
 * 2026-09-09): one prompt, "check what's in here", a read-only turn already
 * closed with an empty file list — and a README commit made in the main
 * checkout by someone else landed on it. prepare-commit-msg wrote its
 * trailer, post-commit recorded the sha, the header read +41/-8 on README.md
 * while its one turn carried +0/-0, and `origin verify-capture` flagged both.
 *
 * Evidence, in the order the multi-candidate picker already uses: a turn is
 * OPEN (the agent is mid-turn; the commit is part of its work), or the open
 * turn's ledger holds a committed file, or a recorded turn touched one. A
 * session with no recorded turns at all (a hookless agent's first turn, or
 * nothing captured yet) is left as before — there is nothing to contradict it
 * with. An empty file list likewise: without files there is no evidence to
 * weigh, and refusing on none would strip every merge and empty commit.
 */
export function loneSessionMayOwnCommit<T extends FileEvidenceSession & { prompts?: string[] }>(
  session: T,
  commitFiles: string[],
): { ok: boolean; why: string } {
  if (!commitFiles || commitFiles.length === 0) return { ok: true, why: 'no files to weigh' };
  const open = session.activeTurn;
  if (open && Number.isInteger(open.index)) return { ok: true, why: 'turn open' };
  const baseOf = (f: string): string => f.split('/').pop() || f;
  const wanted = new Set(commitFiles.map(baseOf));
  if (inFlightEditedFiles(session).some((f) => wanted.has(baseOf(f)))) return { ok: true, why: 'in-flight edit' };
  const mappings = session.completedPromptMappings || [];
  if (mappings.length === 0) return { ok: true, why: 'no recorded turns to contradict' };
  if (sessionTouchedAnyCommitFile(session, commitFiles)) return { ok: true, why: 'a recorded turn touched a committed file' };
  return { ok: false, why: 'no open turn and no recorded turn touched any committed file' };
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
export const RECENCY_TIEBREAK_MARGIN_MS = 120_000;

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
    /**
     * Where git ran the hook — the working-tree root. A session whose lastCwd
     * is exactly this is the tie-break AFTER the file evidence, never before
     * it: it is where a session's last hook fired, not who made the commit.
     */
    hookCwd?: string | null;
  } = {},
): { session: T | null; reason: 'trailer' | 'only' | 'process' | 'branch' | 'file-overlap' | 'cwd' | 'recency' | 'ambiguous' | 'none' } {
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

  // Where git ran the hook. A session whose lastCwd is exactly the tree root
  // is the tie-break only once the file evidence above has had its say —
  // lastCwd is where a session's last hook fired, not who made the commit
  // (e1095412: the committing session sat in packages/cli).
  if (candidates.length > 1 && opts.hookCwd) {
    const atCwd = candidates.filter((s) => sameDir((s as { lastCwd?: string }).lastCwd, opts.hookCwd as string));
    if (atCwd.length === 1) return { session: atCwd[0], reason: 'cwd' };
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
export async function pinCodexCommitToProducer(state: SessionState, hookCwd: string): Promise<void> {
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
      if (i >= 0) state.completedPromptMappings[i] = stampCaptured(bf);
      else state.completedPromptMappings.push(stampCaptured(bf));
    }
    state.completedPromptMappings.sort((a, b) => a.promptIndex - b.promptIndex);
    try { if (state.sessionTag) saveSessionState(state, repoPath, state.sessionTag); } catch { /* non-fatal */ }
    // PATCH the corrected per-prompt commitSha/diff. editsJson is omitted — the
    // server preserves any existing value (mcp.ts only overwrites when sent).
    await durableUpdate(state.sessionId, {
      promptChanges: state.completedPromptMappings.map(withDerivedLineCounts).map((pm) => ({
        ...pm,
        promptText: (pm.promptText || '').slice(0, 1000),
        diff: capDiff(pm.diff, MAX_PROMPT_DIFF_LEN),
        // `completedPromptMappings` is numbered by SERVER row; ids are local.
        ...(turnIdForServerRow(state, pm.promptIndex) && { turnId: turnIdForServerRow(state, pm.promptIndex) }),
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
export function pickRecentDevinSessionForRepo(repoPath: string, nowMs: number): DevinDesktopSession | null {
  try {
    return selectDevinSessionForRepo(readDevinDesktopSessions(), repoPath, nowMs);
  } catch {
    return null;
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
export function gitCommitDate(repoPath: string, commitSha: string): string | null {
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
  const firstParent = extractCommitDiff(hookCwd, commitSha);
  // From here on `diff` / `filesChanged` are what this commit AUTHORED — for a
  // merge, its resolution. The first-parent view of a merge is the whole other
  // branch, and every consumer below (the Commit row, the session totals, the
  // memory entry, the turn) describes this session's work, not what landed on
  // the branch. See commitAuthoredDelta.
  const authored = commitAuthoredDelta(hookCwd, commitSha, firstParent);
  const { diff, filesChanged } = authored;
  if (!diff && !authored.isMerge) {
    debugLog('post-commit', 'WARN: empty per-commit diff after all three strategies', { commitSha });
  }
  if (authored.isMerge) {
    debugLog('post-commit', 'merge commit — crediting the session with its resolution only', {
      commitSha: commitSha.slice(0, 8),
      absorbedFiles: authored.absorbed?.files ?? 0,
      absorbedLines: `+${authored.absorbed?.linesAdded ?? 0}/-${authored.absorbed?.linesRemoved ?? 0}`,
      resolvedFiles: filesChanged.length,
    });
  }

  // Count lines
  // git's own totals. `diff` is capped at MAX_DIFF_SIZE, so counting its
  // sign lines under-reports a large commit: 7f310b6b (683KB) was sent as
  // +1561/-892 for git's +1959/-1249, and the session page compared that
  // against a turn counted another way. Fall back to the text only when
  // numstat itself fails.
  //
  // A MERGE is the exception. `git diff-tree --numstat` prints nothing for
  // it (no single parent), so commitLineCounts returns {0,0} — a real-looking
  // zero that would throw away the resolution commitAuthoredDelta just
  // computed. And the first-parent numstat, if we asked for it, is the
  // absorbed branch: session 51995e1c stored +1218/−178 against a true
  // +891/−106 because that number was added into the session total. The
  // authored counts ARE the merge's contribution.
  let linesAdded = 0, linesRemoved = 0;
  if (authored.isMerge) {
    linesAdded = authored.linesAdded;
    linesRemoved = authored.linesRemoved;
  } else {
    const counted = commitLineCounts(hookCwd, commitSha);
    if (counted) {
      linesAdded = counted.added;
      linesRemoved = counted.removed;
    } else if (diff) {
      linesAdded = authored.linesAdded;
      linesRemoved = authored.linesRemoved;
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
        //
        // For a MERGE this is the resolution, and the row says what the
        // merge brought in from the other branch. The Commit row is read by
        // the session composers as this session's authored content (the
        // header recovery, the git-fallback body), so a first-parent patch
        // here is how another PR's files reached a session's header.
        diff: diff ? diff.slice(0, 500_000) : undefined,
        ...(authored.isMerge ? { isMerge: true, absorbed: authored.absorbed } : {}),
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
  let activeSessions = listSessionsForGitHook(hookCwd, { commitFiles: filesChanged });
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
    const only = activeSessions[0];
    const verdict = loneSessionMayOwnCommit(only, filesChanged);
    if (verdict.ok) {
      state = only;
    } else {
      // One live session is not evidence that the commit is its (b3b45536).
      // Treat the repo as having no session for this commit: the row still
      // ingests, nothing is stamped on a turn that did not make it.
      debugLog('post-commit', 'SKIP: the only live session shows no evidence for this commit', {
        sessionId: only.sessionId, commitSha: commitSha.slice(0, 8), files: filesChanged.length, why: verdict.why,
      });
      activeSessions = [];
    }
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
      hookCwd,
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
      // A commit made while a prompt is RUNNING but before any tool capture
      // opened its turn attested nothing. Cursor session c1e361a4: prompt 10
      // saved 00:31:32, after-file-edit mapped its edits by prompt index
      // without opening the turn, the commit landed 00:37:59 with "(no
      // active turn)", and the header then carried the commit's files that
      // no turn claimed. The running turn is the one after the last closed
      // one — the same rule every tool capture opens by.
      //
      // This does not invent a turn (see the caveat above): it opens one only
      // when a prompt is running AND that prompt's own captures — the edit
      // hook's mapping for its index, or its live ledger — already hold a
      // committed file. That is the same observation the tool captures make;
      // post-commit merely arrives before the next one would have.
      if (!state.activeTurn && Array.isArray(state.prompts) && state.prompts.length > 0) {
        const lastClosed = Number.isInteger(state.lastClosedTurnIndex as number) ? (state.lastClosedTurnIndex as number) : -1;
        const running = state.prompts.length - 1;
        if (running > lastClosed && runningTurnTouchedCommit(state, running, filesChanged)) {
          const opened = currentTurnIndex(state);
          debugLog('post-commit', 'opened the running turn to attest the commit', {
            promptIndex: opened, lastClosed, commitSha: commitSha.slice(0, 8),
          });
        }
      }
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

  // The owner's whole-session snapshot, computed once here and reused by the
  // session-level diff below. It is the header: what the dashboard shows above
  // the turns, what the memory entry records, what verify-capture checks the
  // turns against.
  let ownerAuthored: SessionAuthoredSnapshot | null = null;
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
    // The session's header totals — for the session that MADE the commit.
    //
    // SET from the authored snapshot, not accumulated. The accumulator added
    // each commit's first-parent delta, so a `git merge origin/main` added the
    // whole other branch to a session that resolved two version lines
    // (51995e1c: +1218 stored against +895 authored). The snapshot renders the
    // session's own commits through commitAuthoredDelta and counts the one
    // resulting text, so it cannot drift from the turn rows built the same
    // way. The per-commit add remains only as the fallback for a session whose
    // owned walk yields nothing (a hook was missed), and it adds what the
    // commit AUTHORED.
    if (filesChanged.length > 0 && counterSessionIds.has(s.sessionId)) {
      let snap: SessionAuthoredSnapshot | null = null;
      try { snap = sessionAuthoredSnapshot(hookCwd, s); } catch { snap = null; }
      if (snap && snap.source !== 'none') {
        applyAuthoredTotals(s, snap);
        if (state && s.sessionId === state.sessionId) ownerAuthored = snap;
      } else {
        const existing = new Set((s as any).filesChanged || []);
        for (const f of filesChanged) existing.add(f);
        (s as any).filesChanged = Array.from(existing);
        (s as any).linesAdded = ((s as any).linesAdded || 0) + linesAdded;
        (s as any).linesRemoved = ((s as any).linesRemoved || 0) + linesRemoved;
        (s as any).commitCount = ((s as any).commitCount || 0) + 1;
      }
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
    // The session PATCH builds the Commit row from this object. Ingest also
    // sends the patch, but that call can stall and the durable retry is a
    // later hop — if this payload is thin (filesChanged only), the row
    // renders as a bare "N files" line with no +/- and no hunks
    // (session 49b1c722). The per-commit patch is THIS commit's authored
    // `diff`, already in hand — send it FIRST, before the session-to-date
    // snapshot. That snapshot is the expensive half (1.6s–7.2s of
    // captureGitState) and is what killed post-commit before the PATCH on
    // session e24477e2: local commitTurns via post-commit, dashboard pill
    // "5 files" with no hunks. Drop an oversize patch rather than slice
    // it: a truncated unified diff mis-parses in blame.
    const commitPatch = diff && diff.length <= 500_000 ? diff : undefined;
    const commitDetail = {
      sha: commitSha,
      message: commitMessage,
      author: commitAuthor,
      filesChanged,
      linesAdded,
      linesRemoved,
      ...(commitPatch && { patch: commitPatch }),
    };
    // A COMMIT CARRIER, not a session capture: no `diff`, no line totals.
    // headBefore is the session baseline, and the server REPLACES the stored
    // session-to-date diff on a same-baseline capture — so a `diff` here
    // (this one commit's) would shrink the session header to one commit until
    // the snapshot below lands, and the snapshot is the half that gets killed.
    // A capture with no `diff` field leaves SessionDiff alone (mcp.ts); the
    // Commit row is built from commitDetails, which carry this commit's own
    // patch and numstat.
    const gitCapture: {
      headBefore: string; headAfter: string; commitShas: string[];
      commitDetails: Array<{
        sha: string; message: string; author: string; filesChanged: string[];
        linesAdded?: number; linesRemoved?: number; patch?: string;
      }>;
      diff?: string; diffTruncated?: boolean; linesAdded?: number; linesRemoved?: number;
      snapshot?: boolean;
      rewrittenCommits?: Array<{ from: string; to: string }>;
    } = {
      ...(state ? rewrittenCommitsPayload(state) : {}),
      headBefore: (state?.headShaAtStart) || commitSha,
      headAfter: commitSha,
      commitShas: [commitSha],
      commitDetails: [commitDetail],
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
    //
    // `diff` / `filesChanged` are already the authored view (commitAuthoredDelta,
    // above); `mergeOwn` only tells the prompt-baseline re-diff below to stand
    // down for a merge, since re-diffing from the baseline tree would put the
    // absorbed branch straight back in.
    const mergeOwn = authored.isMerge ? { diff: authored.diff, filesChanged: authored.filesChanged } : null;
    const turnFiles = filesChanged;
    const turnDiff = diff;

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
        const unit = commitTurnContentUnit(scoped, turnFiles, turnDiff);
        const pDiff = unit.diff;
        const budgetedCommitDiff = fitDiffToBudget(pDiff, MAX_PROMPT_DIFF_LEN);
        // `latestPromptIdx` is LOCAL — it indexes `s.prompts`, the shadows and
        // the turn ids. The row it is sent to is the SERVER one. This producer
        // sent the local number: on prod 8a626742, resumed with base 21, the
        // commit's diff went out under index 0 and was refused (row 0 held
        // turn one), so the commit was never stamped on its own turn.
        const latestPromptRow = serverRowForLocalTurn(latestPromptIdx, s.promptIndexBase);
        const perPromptUpdate = {
          promptIndex: latestPromptRow,
          // Key the row on IDENTITY, like every other sender does. This one
          // was the last positional-only producer, and it is the one that
          // writes the commit-linked row — so a prompt list that renumbered
          // between two PATCHes landed a commit's diff on a neighbour's turn
          // with nothing to correct it.
          ...(turnIdFor(s, latestPromptIdx) && { turnId: turnIdFor(s, latestPromptIdx) }),
          ...captureStamp(),
          promptText: latestPromptText.slice(0, 1000),
          // Files, diff and line counts all come from commitTurnContentUnit, so
          // they cannot describe three different things.
          filesChanged: unit.filesChanged,
          // Capped at FILE boundaries. The slice this replaces cut mid-hunk,
          // which stores a corrupt diff rather than a shorter one. Anything
          // dropped is named below so the row does not claim a file its own
          // diff no longer contains.
          diff: budgetedCommitDiff.diff,
          ...(budgetedCommitDiff.omittedFiles.length > 0
            ? { contentUnavailableFiles: budgetedCommitDiff.omittedFiles }
            : {}),
          linesAdded: unit.linesAdded,
          linesRemoved: unit.linesRemoved,
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
            attributedPromptRow: latestPromptRow,
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
          // Write-ahead copy: the fetch below can outlive this process (git
          // returns to the user and Cursor moves on). Superseded by the send.
          const prePersisted = persistUpdateBeforeWork(s.sessionId, {
            filesChanged: turnFiles.length > 0 ? turnFiles : undefined,
            branch: currentBranch || undefined,
            gitCapture,
            promptChanges: latestPromptText ? [perPromptUpdate] : undefined,
          }, (e, m, d) => debugLog(e, m, d));
          await durableUpdateSession(s.sessionId, {
            // `turnFiles`, not the commit's raw list. This one is the SESSION's
            // file list, and the session's list is a union that only ever
            // grows — so a merge putting every file the absorbed branch
            // touched into it is not something a later capture can take back.
            // The COMMIT row keeps the full list: it travels separately, in
            // `gitCapture.commitDetails[].filesChanged`, which is what the
            // server reads to build it. Identical to the old value for every
            // non-merge commit.
            filesChanged: turnFiles.length > 0 ? turnFiles : undefined,
            branch: currentBranch || undefined,
            gitCapture,
            promptChanges: latestPromptText ? [perPromptUpdate] : undefined,
          }, (e, m, d) => debugLog(e, m, d), { supersedes: prePersisted });
          debugLog('post-commit', 'API update complete', { sessionId: s.sessionId });
        } catch (err: any) {
          // Retriable failures no longer reach here — durableUpdateSession
          // queues those and returns null. This is now only permanent (4xx)
          // failures, which replaying could never fix.
          debugLog('post-commit', 'API update error (non-fatal)', { sessionId: s.sessionId, message: err.message });
        }
      }
    }

    // Session-to-date snapshot AFTER the Commit row is on the wire. This is
    // the expensive half: captureGitState of the whole session range at
    // `--unified=2000`, 1.6s–7.2s and growing. It used to run first, so a
    // killed hook left the pill files-only. Same commitDetail so
    // gitCapture.diff (the header) cannot leak onto commitDetails[].patch.
    if (connected && state?.headShaAtStart && state.headShaAtStart !== commitSha && updateTargets.length > 0) {
      try {
        // hookCwd, not repoPath: the session-to-date diff must read the
        // committing working tree's HEAD (worktree-safe, see execOpts above).
        //
        // The owned walk runs FIRST and the raw capture is computed only when
        // it comes back empty, because the raw capture is the expensive half:
        // `captureGitState` re-reads metadata for EVERY commit in the session
        // range — five git spawns each — and then renders the range at
        // `--unified=2000`, up to three times as the byte ladder steps down.
        // Measured on this repo: 1.6s over a 10-commit range, 4.0s over 30,
        // 7.2s over 60 — paid on every `git commit`, growing for the length of
        // the session, and in the common case thrown away unlooked-at because
        // the owned walk answered. post-commit runs before git returns, so it
        // is latency a person sits through.
        //
        // `--name-only` reproduces the old `if (snap.committedDiff)` gate for
        // a few ms: an empty committed range still sends nothing, so a session
        // whose commits are all somebody else's does not get a snapshot.
        let rangeHasContent = false;
        try {
          rangeHasContent = !!execFileSync(
            'git', ['diff', '--name-only', state.headShaAtStart, commitSha],
            { ...execOpts, timeout: 10000 },
          ).trim();
        } catch { rangeHasContent = true; /* unreadable range — let the old path decide */ }
        if (rangeHasContent) {
          let owned: { diff: string; linesAdded: number; linesRemoved: number; scoped: boolean } | null =
            ownerAuthored && ownerAuthored.source !== 'none'
              ? { diff: ownerAuthored.diff, linesAdded: ownerAuthored.linesAdded, linesRemoved: ownerAuthored.linesRemoved, scoped: true }
              : null;
          if (!owned) owned = sessionToDateCommittedSnapshot(hookCwd, state, { diff: '', linesAdded: 0, linesRemoved: 0 });
          if (!owned.scoped) {
            const snap = captureGitState(hookCwd, state.headShaAtStart, { fullContext: true });
            owned = {
              diff: snap.committedDiff,
              linesAdded: snap.linesAdded || linesAdded,
              linesRemoved: snap.linesRemoved || linesRemoved,
              scoped: false,
            };
          }
          if (owned.scoped) {
            debugLog('post-commit', 'session-to-date diff scoped to owned commits', {
              owned: `+${owned.linesAdded}/-${owned.linesRemoved}`,
              ownedCommits: (state.sessionCommitShas || []).length,
              rawCaptureSkipped: true,
            });
          }
          const sessionToDateDiff = owned.diff;
          if (sessionToDateDiff) {
            const snapshotCapture = {
              ...gitCapture,
              diff: sessionToDateDiff.length > 500_000 ? sessionToDateDiff.slice(0, 500_000) : sessionToDateDiff,
              diffTruncated: sessionToDateDiff.length > 500_000,
              linesAdded: owned.linesAdded,
              linesRemoved: owned.linesRemoved,
              snapshot: true as const,
            };
            for (const s of updateTargets) {
              try {
                debugLog('post-commit', 'sending session-to-date snapshot', { sessionId: s.sessionId });
                await durableUpdateSession(s.sessionId, { gitCapture: snapshotCapture }, (e, m, d) => debugLog(e, m, d));
              } catch (err: any) {
                debugLog('post-commit', 'session-to-date snapshot error (non-fatal)', {
                  sessionId: s.sessionId, message: err?.message,
                });
              }
            }
          }
        }
      } catch (err: any) {
        debugLog('post-commit', 'fullContext snapshot failed (non-fatal)', { message: err?.message });
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
    // The ledger's answer, where it has one — the same precedence Stop applies.
    // This path re-derived every turn from the transcript alone, so the git
    // notes and the origin-sessions branch carried the reconstruction for
    // turns the server had already been told were observed.
    applyLedgerCaptures(state, promptMappings as any);
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
