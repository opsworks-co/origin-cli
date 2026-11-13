// Commits this session made whose post-commit never ran.
//
// The session header falls back to the commits in range whose trailer names
// the session (sessionAuthoredSnapshot's `trailer` source) when post-commit
// recorded none. The turn rows had no such fallback: a turn is given its
// commit patch only through `commitTurns`, which only post-commit and the
// transcript proof fill. So the header credited the commit and no turn did,
// and the release gate read `header_exceeds_turns`.
//
// Session 8cf9e6b1, 2026-11-02: it started mid-merge, fixed the conflicts in
// three files with shell commands, and ran `git commit -q`. prepare-commit-msg
// stamped the trailer (`8cf9e6b1-45b | Claude Code | 1 prompt | turn 1`), then
// Entire's chained post-commit hung and the agent killed it, so Origin's
// post-commit never started. `-q` printed no `[branch sha]` for the transcript
// proof to find. The header showed the merge's resolution, +10/-15 over three
// files; the turn showed +0/-0.
//
// The trailer's `turn N` is the committing turn's SERVER row + 1, written by
// prepare-commit-msg while the commit was being made — the same observation
// post-commit would have recorded. A commit is attested here only when its
// FIRST trailer names this session and carries that turn number, the turn has
// an id in this launch, and nothing has attested or rewritten it already. The
// candidates come from ownedRangeCommitShas, which already limits them to
// session-start..HEAD and to commits made after the session started.

import { execFileSync } from 'child_process';
import { commitTurnOf, type SessionState } from './session-state.js';
import { turnIdForServerRow } from './turn-index.js';

export type GitRunner = (cwd: string, args: string[]) => string | null;

const runGit: GitRunner = (cwd, args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

const FULL_SHA = /^[0-9a-f]{40}$/i;

type Holder = Pick<SessionState, 'sessionId' | 'repoPath' | 'promptTurnIds' | 'promptIndexBase' | 'sessionCommitShas' | 'commitTurns' | 'foldedCommitTurns' | 'preSquashCommitTurns' | 'rewrittenCommits'>;

/** The SERVER row a trailer value names, or null. `… | turn 3 | …` → 2. */
export function trailerTurnRow(value: string): number | null {
  const m = value.match(/\|\s*turn\s+(\d+)\s*(?:\||$)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n - 1 : null;
}

/**
 * Attest each of `candidates` whose trailer names this session and its
 * committing turn. Adds to `sessionCommitShas` and `commitTurns`; does not
 * save. Returns the shas attested.
 */
export function attestHookMissedTrailerCommits(
  state: Holder,
  candidates: string[],
  git: GitRunner = runGit,
): string[] {
  const tag = (state.sessionId || '').slice(0, 12).toLowerCase();
  const shas = candidates.filter((s) => FULL_SHA.test(s));
  if (!tag || !state.repoPath || shas.length === 0) return [];
  const rewritten = (state.rewrittenCommits || []).map((r) => (r?.from || '').toLowerCase());
  const fresh = shas.filter((s) => !commitTurnOf(state, s) && !rewritten.some((f) => f && s.toLowerCase().startsWith(f)));
  if (fresh.length === 0) return [];
  const log = git(state.repoPath, [
    'log', '--no-walk=unsorted',
    '--format=%H%x1f%cI%x1f%(trailers:key=Origin-Session,valueonly,separator=%x1d)%x1e',
    ...fresh,
  ]);
  if (!log) return [];
  const out: string[] = [];
  for (const rec of log.split('\x1e')) {
    const [sha, at, trailers] = rec.trim().split('\x1f');
    if (!sha || !FULL_SHA.test(sha)) continue;
    // The FIRST trailer decides, as everywhere else that reads it.
    const owner = (trailers || '').split('\x1d')[0]?.trim() || '';
    if (!owner.toLowerCase().startsWith(tag)) continue;
    const row = trailerTurnRow(owner);
    if (row === null) continue;
    const turnId = turnIdForServerRow(state, row);
    if (!turnId) continue;
    const committed = Date.parse(at || '');
    (state.commitTurns ??= []).push({
      sha, turnId, at: new Date(Number.isFinite(committed) ? committed : Date.now()).toISOString(), via: 'trailer',
    });
    state.sessionCommitShas ??= [];
    if (!state.sessionCommitShas.some((s) => s.toLowerCase() === sha.toLowerCase())) state.sessionCommitShas.push(sha);
    out.push(sha);
  }
  return out;
}
