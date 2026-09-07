// Stop: close the turn and capture it — files, diff, counts, commits.
//
// Moved out of commands/hooks.ts mechanically: the text is unchanged, only its
// home is. Shared helpers still live in hooks.ts and are imported from there.
import { discoverCodexSessionData, findCodexRolloutPath, getCodexPromptsTimeline } from '../../agents/codex.js';
import { discoverCursorTranscript, findCursorTranscriptJsonl, getCursorModelFromDb } from '../../agents/cursor.js';
import { discoverGeminiTranscriptPath } from '../../agents/gemini.js';
import { isSpecificModel, sessionMatchesAgent } from '../../agents/registry.js';
import { api } from '../../api.js';
import { preferCommitPatchForCommittedTurns } from '../../commit-patch-for-committed-turn.js';
import { backfillCodexPromptMappings } from '../../codex-prompt-mapping.js';
import { isConnectedMode, loadAgentConfig, loadConfig } from '../../config.js';
import { debugLog } from '../../debug-log.js';
import { queueDevinBackfill } from '../../devin-backfill.js';
import { discoverDevinCliSessionDataByPrompt, retagDevinFromProcess } from '../../devin-cli.js';
import { readDevinLiveSession } from '../../devin-sessions-db.js';
import { capDiff } from '../../diff-budget.js';
import { finalHunksForCaptures } from '../../final-state-blame.js';
import { MAX_PROMPT_DIFF_LEN, captureGitState, createShadowCommit, getDirtyFiles, gitIgnoredFiles, readFileAtRev } from '../../git-capture.js';
import { writeGitNotes } from '../../git-notes.js';
import { extractTodosFromPrompts, handoffRepresentsWork, writeHandoff } from '../../handoff.js';
import { isOriginAutoManagedPath, shouldIgnoreFile } from '../../ignore-patterns.js';
import { writeSessionFiles } from '../../local-entrypoint.js';
import { parseMarkersFromTranscript } from '../../origin-markers.js';
import { anchorEditPositions, backfillWriteBaselines, capturePromptEdits } from '../../prompt-capture/index.js';
import type { PromptEdit } from '../../prompt-capture/index.js';
import { editSourceForAgent } from '../../prompt-capture/types.js';
import { uploadPromptImages } from '../../prompt-images.js';
import { redactSecrets } from '../../redaction.js';
import { closeTurn, discoverGitRoot, getBranch, getCanonicalRepoPath, getGitRoot, getHeadSha, getWorkingGitRoot, homePromptIndexByText, reconcilePromptHistory, saveSessionState } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import type { ParsedTranscript } from '../../transcript.js';
import { samePath, shellWindowTarget } from '../../session-worktree.js';
import { SUBAGENT_SPAWN_TOOLS, detectRenamedSpawner } from '../../subagent-tools.js';
import { countDiffLines } from '../../transcript-adapters.js';
import { estimateCost, extractPromptFileMappings, formatTranscriptForDisplay, parseTranscript, scopeCapturedPath } from '../../transcript.js';
import { durableUpdateSession } from '../../update-queue.js';
import { querySqlite } from '../../utils/sqlite.js';
import { readJournal } from '../../write-journal-watch.js';
import { filesWrittenDuring } from '../../write-journal.js';
import { createSnapshot } from '../snapshot.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GIT_READ_OPTS, LIVE_EDIT_CONTENT_MAX, LIVE_EDIT_MAX_TOTAL_BYTES, STABLE_SESSION_ID_AGENTS, applyLedgerCaptures, applyLiveLedger, buildPromptNoteEntries, buildSessionWriteData, captureStamp, commitBelongsToSession, currentSessionWorkTree, editContentBytes, ensureServerSession, filterUncommittedDiff, findStateForHook, getWorkingTreeSha, hookLookupSessionId, isRewriteOf, liveLedgerBytes, localCommitterEmail, mergeFilesRead, mergePromptMappings, nestedRepoWritesForOpenTurn, normalizeWorkspaceRoot, outOfRepoFilesFor, preSessionDirtCommittedUnchanged, recordDiscoveredWorkTreeEdits, recordShellWindowEdits, repoRemoteUrl, resolveAgentSessionName, sessionRepoRoots, sessionScopedCommittedDiff, summarizePromptPayload, turnBaselineForServerRow, turnIdFor, uncommittedExcludeUnion, windowIsRebaseOfEarlierTurns, withDerivedLineCounts } from '../hooks.js';


// ─── Debug Logger ─────────────────────────────────────────────────────────

// (debug logger moved to ../debug-log.ts — imported above)
// Durable upload wrappers (update-queue.ts) bound to this file's debugLog.
// On a retriable API failure the payload is persisted to ~/.origin/queue/
// and replayed by a later hook — capture data is never silently lost.
export const durableUpdate = (sessionId: string, data: any) =>
  durableUpdateSession(sessionId, data, (e, m, d) => debugLog(e, m, d));

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
/**
 * Warn when the sub-agent SPAWNER appears to have been renamed.
 *
 * The fix above matches both `task` and `agent`, but the next rename cannot be
 * predicted and no test can be written against a name that does not exist yet.
 * What CAN be detected is the contradiction: a session that read, stopped or
 * listed sub-agents while recording none being spawned is describing something
 * impossible.
 *
 * That is exactly the state this build shipped in — 114 sessions with 66
 * `TaskOutput` calls and zero spawns — and nothing anywhere said so. Logged
 * rather than thrown: a capture warning must never break the agent, and the
 * session's other data is still good.
 */
export function warnIfSpawnerRenamed(state: SessionState): void {
  try {
    const names = (state.subagents || [])
      .map((r) => (r as { toolName?: string }).toolName || '')
      .filter(Boolean);
    if (names.length === 0) return;
    const verdict = detectRenamedSpawner(names, (state.subagentSpawns || []).length);
    if (!verdict.broken) return;
    debugLog('subagent', 'SPAWNER TOOL MAY HAVE BEEN RENAMED — no spawns recorded', {
      sessionId: state.sessionId,
      companionsSeen: verdict.companionsSeen,
      // The new spawner is almost certainly one of these.
      unrecognisedTools: verdict.candidates.slice(0, 12),
      known: [...SUBAGENT_SPAWN_TOOLS],
      fix: 'add the new name to SUBAGENT_SPAWN_TOOLS in subagent-tools.ts',
    });
  } catch { /* a diagnostic must never break a capture */ }
}

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

/** The (orphan → rewrite) pairs to send with a gitCapture, or nothing. */
export function rewrittenCommitsPayload(state: SessionState): { rewrittenCommits?: Array<{ from: string; to: string }> } {
  const r = state.rewrittenCommits;
  return Array.isArray(r) && r.length > 0 ? { rewrittenCommits: r } : {};
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
export function ownedRangeCommitShas(repoPath: string, state: SessionState): string[] {
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
export function getCursorConversationSummary(conversationId: string): { title: string; tldr: string; overview: string; summaryBullets: string } | null {
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
  // SUFFIX match, deliberately — prior captures can hold a bare name where
  // this one holds a repo-relative path. Not paths.ts's samePath, and no longer
  // wearing its name.
  const sameFileBySuffix = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  const isExcluded = (f: string) => excludeFiles.some((x) => sameFileBySuffix(x, f));
  const priorByIdx = new Map(previous.map((pm) => [pm.promptIndex, pm]));
  // Files this pass attributes to some LATER turn — the signal that a prior
  // capture ran past a turn boundary nobody announced.
  const claimedLater = (file: string, index: number) => current.some(
    (other) => other.promptIndex > index
      && (other.filesChanged || []).some((f) => sameFileBySuffix(f, file)),
  );
  return current.map((pm) => {
    const prior = priorByIdx.get(pm.promptIndex);
    if (!prior) return pm;
    // An observed answer is not one opinion among reconstructions. When the
    // earlier capture of this turn came from the ledger and this pass did not
    // (the journal has since compacted, or the watcher is gone), the earlier
    // answer stands WHOLE — files, diff and provenance — rather than being
    // voted against a fresh guess by string length.
    if ((prior as { diffSource?: string }).diffSource === 'ledger'
      && (pm as { diffSource?: string }).diffSource !== 'ledger') {
      return { ...pm, ...prior, promptIndex: pm.promptIndex } as T;
    }
    const curFiles = Array.isArray(pm.filesChanged) ? pm.filesChanged : [];
    const claimedFiles = Array.isArray(prior.filesChanged) ? prior.filesChanged : [];
    const kept = claimedFiles.filter((f) => !isExcluded(f));
    const priorFiles = kept.filter(
      (f) => curFiles.some((c) => sameFileBySuffix(c, f)) || !claimedLater(f, pm.promptIndex),
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

/** Persist the budget signal carried on a session PATCH response. */
export function applyBudgetSignal(state: SessionState, apiResponse: unknown, saveCwd: string): void {
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

export function isSessionGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /(^|\b)Session not found\b/i.test(msg);
}
















// ─── The phases of a Stop, in the order handleStop runs them ─────────────────
// Each was a block of handleStop's body; the text is unchanged, the inputs and
// outputs are now explicit. Kept in call order so a guard that reads this file
// as text ("the ledger is applied before the state round-trip") still reads
// the runtime order.

function enrichCursorTranscript({ agentSlug, parsed, input, state, displayTranscript }: { agentSlug: string | undefined; parsed: ParsedTranscript; input: Record<string, any>; state: SessionState; displayTranscript: ReturnType<typeof formatTranscriptForDisplay> }): { displayTranscript: ReturnType<typeof formatTranscriptForDisplay> } {
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
  return { displayTranscript };
}
function backfillCodexRollout({ codexData, parsed, state, displayTranscript }: { codexData: ReturnType<typeof discoverCodexSessionData> | null; parsed: ParsedTranscript; state: SessionState; displayTranscript: ReturnType<typeof formatTranscriptForDisplay> }): { displayTranscript: ReturnType<typeof formatTranscriptForDisplay> } {
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
  return { displayTranscript };
}
function enrichDevinTurn({ agentSlug, state, input, parsed, displayTranscript }: { agentSlug: string | undefined; state: SessionState; input: Record<string, any>; parsed: ParsedTranscript; displayTranscript: ReturnType<typeof formatTranscriptForDisplay> }): { devinPromptTimes: (string | undefined)[] | undefined; displayTranscript: ReturnType<typeof formatTranscriptForDisplay> } {
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
  return { devinPromptTimes, displayTranscript };
}
function synthesizeDisplayTranscript({ displayTranscript, state }: { displayTranscript: ReturnType<typeof formatTranscriptForDisplay>; state: SessionState }): { displayTranscript: ReturnType<typeof formatTranscriptForDisplay> } {
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
  return { displayTranscript };
}
function resolveModelFromCursorDb({ model, agentSlug, input }: { model: string; agentSlug: string | undefined; input: Record<string, any> }): { model: string } {
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
  return { model };
}
function captureMultiRepoFiles({ state, filesChanged }: { state: SessionState; filesChanged: string[] }): { filesChanged: string[] } {
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
  return { filesChanged };
}
function buildTurnMappings({ state, parsed, prompts, promptMappings, gitCapture, turnExcludeFiles, filesChanged, foreignCommitFiles }: { state: SessionState; parsed: ParsedTranscript; prompts: string[]; promptMappings: ReturnType<typeof extractPromptFileMappings>; gitCapture: ReturnType<typeof captureGitState>; turnExcludeFiles: string[]; filesChanged: string[]; foreignCommitFiles: string[] }): { promptMappings: ReturnType<typeof extractPromptFileMappings> } {
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
  return { promptMappings };
}
function sessionFilesAcrossRepos({ state, sessionFilesChanged, promptBaseline, parsed }: { state: SessionState; sessionFilesChanged: string[]; promptBaseline: string | null | undefined; parsed: ParsedTranscript }): { sessionFilesChanged: string[] } {
  // default: per-prompt files
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
      // Pre-session dirt a commit swept up unchanged is not the session's
      // file either — same rule the session-level diff applies.
      const sweptUnchanged = preSessionDirtCommittedUnchanged(state.repoPath, state, sessionFilesSet);
      for (const f of sweptUnchanged) sessionFilesSet.delete(f);
      if (sessionFilesSet.size > 0) {
        sessionFilesChanged = Array.from(sessionFilesSet);
        debugLog('stop', 'session-level filesChanged from headShaAtStart', {
          count: sessionFilesChanged.length, foreignDropped: sessionForeignFiles.size,
          preSessionDirtDropped: sweptUnchanged.size,
        });
      }
    } catch (err: any) {
      debugLog('stop', 'session-level capture failed, using per-prompt files', { message: err.message });
    }
  }
  return { sessionFilesChanged };
}
async function sendStopCapture({ connected, state, hookCwd, agentSlug, prompts, model, parsed, costUsd, promptMappings, filesChanged, turnExcludeFiles, promptBaseline, found, input, codexData, gitCapture, promptEditsByIndex, joinedPrompt, displayTranscript, sessionFilesChanged, tokensEstimated, durationMs, devinPromptTimes }: { connected: boolean; state: SessionState; hookCwd: string; agentSlug: string | undefined; prompts: string[]; model: string; parsed: ParsedTranscript; costUsd: number; promptMappings: ReturnType<typeof extractPromptFileMappings>; filesChanged: string[]; turnExcludeFiles: string[]; promptBaseline: string | null | undefined; found: ReturnType<typeof findStateForHook>; input: Record<string, any>; codexData: ReturnType<typeof discoverCodexSessionData> | null; gitCapture: ReturnType<typeof captureGitState>; promptEditsByIndex: Map<number, string> | null; joinedPrompt: string; displayTranscript: ReturnType<typeof formatTranscriptForDisplay>; sessionFilesChanged: string[]; tokensEstimated: boolean; durationMs: number; devinPromptTimes: (string | undefined)[] | undefined }): Promise<{ promptEditsByIndex: Map<number, string> | null; model: string }> {
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
            ...rewrittenCommitsPayload(state),
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

    // Hand each turn the ledger's answer where the ledger has one.
    //
    // MUST run before `stopUpdatePayload` is built. It used to run ~300 lines
    // further down, after the payload had already been constructed AND SENT,
    // so the server received the legacy reconstruction every time and only
    // the local state file ever saw the ledger's answer — i.e. the whole of
    // stage 2 was inert on the path that actually fires. Caught by checking a
    // real session's stored row against what the ledger produces for the same
    // turn: 5 files vs 4, and `diffSource` null on every row.
    //
    // Runs AFTER the legacy chain rather than instead of it, so a turn the
    // journal never marked keeps exactly today's behaviour.
    const fromLedger = applyLedgerCaptures(state, promptMappings as any);
    if (fromLedger > 0) {
      debugLog('ledger', 'turns captured from the ledger this stop', {
        count: fromLedger, of: promptMappings.length,
      });
    }
    // A turn whose work is entirely in its commits sends the commit's patch —
    // the diff the badge, the commit detail and blame already read — rather
    // than the ledger's own rendering of the same change. Post-commit sent
    // exactly this; Stop's newer stamp used to overwrite it with a diff that
    // could differ from the badge by a couple of alignment lines.
    const fromCommits = preferCommitPatchForCommittedTurns(
      state, promptMappings as any, state.repoPath || hookCwd,
      {
        log: (event, data) => debugLog('stop', event, data),
        // Only the turn this Stop closes, and any turn that committed since
        // the previous Stop — every other row is a re-send of a settled turn.
        currentPromptIndex: promptMappings.length > 0
          ? Math.max(...promptMappings.map((pm) => pm.promptIndex))
          : undefined,
        since: state.lastStopAt || null,
      },
    );
    if (fromCommits > 0) {
      debugLog('stop', 'committed turns carrying their commit patch', {
        count: fromCommits, of: promptMappings.length,
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
      subagents: (warnIfSpawnerRenamed(state), buildSubagentSummary(state, parsed)),
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
      // ATTESTATION: which turn each commit landed under, observed rather
      // than inferred. post-commit reads `activeTurn` at the moment the
      // commit is created; the transcript path pairs a sha the agent printed
      // to the turn whose region it appeared in.
      //
      // The server has never had this. It re-derives commit ownership from
      // nine time windows and ten prompt-text checks and ranks that guess
      // ABOVE the capture's own claim — reasonably, because until now the
      // "claim" was itself derived (git HEAD stamped onto whichever turn the
      // poll thought was active), which is exactly the field that goes stale.
      // An observation is a different kind of thing, and `via` grades it so
      // the server can tell the two apart.
      ...(Array.isArray(state.commitTurns) && state.commitTurns.length > 0
        ? { commitTurns: state.commitTurns.map((ct) => ({
            sha: ct.sha, turnId: ct.turnId, at: ct.at, via: ct.via,
          })) }
        : {}),
      promptChanges: promptMappings.length > 0
        ? promptMappings.map(withDerivedLineCounts).map((pm, _i, all) => ({
            ...pm,
            // Internal marker — `diffSource` is what travels.
            ledgerOwned: undefined,
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
      const imgResult = await uploadPromptImages({
        sessionId: state.sessionId,
        transcriptPath: state.transcriptPath,
        upload: (id, payload) => api.uploadAttachment(id, payload),
        alreadyUploaded: state.uploadedImages || [],
        debug: (event, data) => debugLog('stop', event, data),
      });
      // Captions are kept for the session memory written at session end —
      // that record is text-only, so a screenshot reaches it as words or not
      // at all. Merged, not replaced: each Stop only handles the images it
      // hasn't dealt with before.
      if (imgResult.uploaded.length > 0) {
        state.uploadedImages = [...(state.uploadedImages || []), ...imgResult.uploaded];
        state.promptImageDescriptions = {
          ...(state.promptImageDescriptions || {}),
          ...imgResult.descriptions,
        };
        saveSessionState(state);
        debugLog('stop', 'images recorded', {
          uploaded: imgResult.uploaded.length,
          described: Object.keys(imgResult.descriptions).length,
        });
      }
    } catch (imgErr: any) {
      debugLog('stop', 'image upload failed (non-fatal)', { message: imgErr?.message });
    }
  }
  return { promptEditsByIndex, model };
}
function writeCommitNotes({ gitCapture, state, model, agentSlug, prompts, promptEditsByIndex, parsed, costUsd, durationMs, config }: { gitCapture: ReturnType<typeof captureGitState>; state: SessionState; model: string; agentSlug: string | undefined; prompts: string[]; promptEditsByIndex: Map<number, string> | null; parsed: ParsedTranscript; costUsd: number; durationMs: number; config: ReturnType<typeof loadConfig> }): void {
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
}
function advanceTurnBaselines({ state, gitCapture }: { state: SessionState; gitCapture: ReturnType<typeof captureGitState> }): void {
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
}
function persistCompletedMappings({ promptMappings, state }: { promptMappings: ReturnType<typeof extractPromptFileMappings>; state: SessionState }): void {
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
      ...((pm as { contentUnavailableFiles?: string[] }).contentUnavailableFiles?.length
        ? { contentUnavailableFiles: (pm as { contentUnavailableFiles?: string[] }).contentUnavailableFiles }
        : {}),
      // Provenance must survive the round-trip. This pick is explicit, so a
      // field not listed here is silently dropped — and the heartbeat re-sends
      // from this state, so losing it lets the server's editsJson synthesis
      // win back a row the ledger had already answered for.
      ...((pm as { diffSource?: 'ledger' }).diffSource
        ? { diffSource: (pm as { diffSource?: 'ledger' }).diffSource }
        : {}),
      // The "never rebuild this from a commit" guard travels with the
      // provenance. Picking `diffSource` alone kept the label and lost the
      // guard, so the next Stop's `previousMappings` and every heartbeat
      // re-send were free to replace an observed diff with `git show`.
      ...((pm as { ledgerOwned?: boolean }).ledgerOwned ? { ledgerOwned: true } : {}),
      diff: pm.diff,
      uncommittedDiff: pm.uncommittedDiff,
    }));
  }
}
function autoSnapshotTurn({ prompts, promptMappings, state, model, parsed, costUsd, gitCapture }: { prompts: string[]; promptMappings: ReturnType<typeof extractPromptFileMappings>; state: SessionState; model: string; parsed: ParsedTranscript; costUsd: number; gitCapture: ReturnType<typeof captureGitState> }): void {
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
}
function publishSessionFiles({ config, state, parsed, promptMappings, gitCapture, promptEditsByIndex }: { config: ReturnType<typeof loadConfig>; state: SessionState; parsed: ParsedTranscript; promptMappings: ReturnType<typeof extractPromptFileMappings>; gitCapture: ReturnType<typeof captureGitState>; promptEditsByIndex: Map<number, string> | null }): void {
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
}
function refreshHandoff({ prompts, state, agentSlug, model, found, parsed, filesChanged, gitCapture }: { prompts: string[]; state: SessionState; agentSlug: string | undefined; model: string; found: ReturnType<typeof findStateForHook>; parsed: ParsedTranscript; filesChanged: string[]; gitCapture: ReturnType<typeof captureGitState> }): void {
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
}

export async function handleStop(input: Record<string, any>, agentSlug?: string): Promise<void> {
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
    // Phase: enrichCursorTranscript.
    displayTranscript = (enrichCursorTranscript({ agentSlug, parsed, input, state, displayTranscript })).displayTranscript;

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
    // Phase: backfillCodexRollout.
    displayTranscript = (backfillCodexRollout({ codexData, parsed, state, displayTranscript })).displayTranscript;

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
    // Phase: enrichDevinTurn.
    const __enrichDevinTurn = enrichDevinTurn({ agentSlug, state, input, parsed, displayTranscript });
    displayTranscript = __enrichDevinTurn.displayTranscript;
    const { devinPromptTimes } = __enrichDevinTurn;
    // Phase: synthesizeDisplayTranscript.
    displayTranscript = (synthesizeDisplayTranscript({ displayTranscript, state })).displayTranscript;

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
    // Phase: resolveModelFromCursorDb.
    model = (resolveModelFromCursorDb({ model, agentSlug, input })).model;
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
    // Phase: captureMultiRepoFiles.
    filesChanged = (captureMultiRepoFiles({ state, filesChanged })).filesChanged;
    // Phase: buildTurnMappings.
    promptMappings = (buildTurnMappings({ state, parsed, prompts, promptMappings, gitCapture, turnExcludeFiles, filesChanged, foreignCommitFiles })).promptMappings;

    // Compute session-level filesChanged from headShaAtStart (accumulated across all prompts)
    // This is separate from per-prompt filesChanged which uses promptBaseline
    let sessionFilesChanged = filesChanged;
    // Phase: sessionFilesAcrossRepos.
    sessionFilesChanged = (sessionFilesAcrossRepos({ state, sessionFilesChanged, promptBaseline, parsed })).sessionFilesChanged;

    // Hoisted out of `if (connected)` so writeSessionFiles below (which
    // runs in both connected + disconnected modes) can pass editsJson
    // through to changes.json. Populated inside the connected block;
    // stays null when offline or when capture fails.
    let promptEditsByIndex: Map<number, string> | null = null;
    // Phase: sendStopCapture.
    ({ promptEditsByIndex, model } = await sendStopCapture({ connected, state, hookCwd, agentSlug, prompts, model, parsed, costUsd, promptMappings, filesChanged, turnExcludeFiles, promptBaseline, found, input, codexData, gitCapture, promptEditsByIndex, joinedPrompt, displayTranscript, sessionFilesChanged, tokensEstimated, durationMs, devinPromptTimes }));
    // Phase: writeCommitNotes.
    writeCommitNotes({ gitCapture, state, model, agentSlug, prompts, promptEditsByIndex, parsed, costUsd, durationMs, config });
    // Phase: advanceTurnBaselines.
    advanceTurnBaselines({ state, gitCapture });
    // The running turn is finished. Closing it here — rather than letting the
    // next capture infer "current" from the list tail — is what lets a prompt
    // queued mid-turn wait its turn instead of stealing this one's remaining
    // edits. The next capture binds lastClosedTurnIndex + 1, so two prompts
    // queued back to back are still captured in order.
    //
    // The turn that finished is the one this Stop captured, whether or not a
    // tool hook ever OPENED it. A chat-only turn runs no tool, so nothing
    // calls currentTurnIndex() and `activeTurn` stays null; closing
    // `activeTurn?.index` then closes nothing, the "next in sequence" pointer
    // stays one turn behind, and every later tool call — the shell probes,
    // the commit attestation — files under the turn BEFORE the one running.
    // Prod bc4a1438 (vodka): turn 2 was a question, turn 3 wrote four files
    // and committed; the probe and the commit trailer both said turn 2, and
    // the state ended the four-turn session at lastClosedTurnIndex 1.
    closeTurn(state, state.activeTurn?.index ?? Math.max(state.prompts.length - 1, 0));
    // Phase: persistCompletedMappings.
    persistCompletedMappings({ promptMappings, state });
    // Phase: autoSnapshotTurn.
    autoSnapshotTurn({ prompts, promptMappings, state, model, parsed, costUsd, gitCapture });

    // Re-save state with RUNNING status FIRST so it survives any errors below
    state.status = 'RUNNING';
    saveSessionState(state, found!.saveCwd, state.sessionTag);
    // Phase: publishSessionFiles.
    publishSessionFiles({ config, state, parsed, promptMappings, gitCapture, promptEditsByIndex });
    // Phase: refreshHandoff.
    refreshHandoff({ prompts, state, agentSlug, model, found, parsed, filesChanged, gitCapture });
  } catch (err: any) {
    debugLog('stop', 'ERROR', { message: err.message, stack: err.stack });
    process.stderr.write(`[origin] stop error: ${err.message}\n`);
  }
}
// `isInsideRepo` used to be re-implemented here — same "resolve the nearest
// existing ancestor, then path.relative" idea as paths.ts, written a second
// time. Two implementations that decide whose file a write is will drift;
// paths.ts is the one, re-exported here so every existing import
// (`from './commands/hooks.js'`) keeps resolving.
import { isInsideRepo } from '../../paths.js';
export { isInsideRepo };


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
export function baselineShaForTree(state: SessionState, tree: string, promptIndex: number): string | null {
  for (const w of state.discoveredWorkTrees || []) {
    if (w.promptIndex === promptIndex && samePath(w.path, tree)) return w.sha;
  }
  const wt = state.prePromptWorkTree;
  if (wt && wt.promptIndex === promptIndex && samePath(wt.path, tree)) return wt.sha;
  if (samePath(tree, state.repoPath)) return state.prePromptSha || null;
  return null;
}

export function recordProbedShellEdits(
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
export function journalFilesForTurn(state: SessionState, endedAt?: number): string[] {
  try {
    const jp = state.writeJournalPath;
    const startedAt = state.currentTurnStartedAt;
    if (!jp || !startedAt) return [];
    const records = readJournal(jp);
    if (records.length === 0) return [];
    const files = filesWrittenDuring(records, { startedAt, endedAt })
      .filter((f) => !isOriginAutoManagedPath(f) && !shouldIgnoreFile(f));
    // The REPO's ignore rules too, not only the built-in patterns. The
    // journal sees every byte the agent's run lands on disk — Python's
    // `__pycache__/x.cpython-314.pyc.4392877312` atomic-write temp files
    // included — and the built-in list cannot know a repo's own rules. The
    // ledger capture already drops gitignored files from the TURN row; this
    // evidence fed the session-level file list unfiltered, so a session
    // whose one turn wrote four files read "9 files" in the header (prod
    // ccffdc75, vodka).
    const ignored = gitIgnoredFiles(currentSessionWorkTree(state), files);
    return ignored.size > 0 ? files.filter((f) => !ignored.has(f)) : files;
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
export function recordJournalEdits(state: SessionState, promptIndex: number, endedAt?: number): boolean {
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

// Ledger entries produced by the per-command probe (evidence), kept distinct
// from the turn window's inferred entries so each can be replaced on its own.
export const SHELL_PROBE_TOOL = '__shell_probe__';

// Ledger slot for write-journal evidence, separate so it never replaces what
// the more precise tool-hook paths recorded for the same turn.
export const WRITE_JOURNAL_TOOL = 'origin:write-journal';
