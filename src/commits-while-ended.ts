// Commits a session's sub-agents made while the session was ended by hand.
//
// A turn can end its own session (`origin sessions end`, which the release
// gate asks for) while background sub-agents it launched are still working in
// their own worktrees. prepare-commit-msg stamps those commits with the
// session's trailer (manuallyEndedSessionForTree), and post-commit, by design,
// records nothing on an ended session. When the same conversation prompts
// again the session resumes, but nothing went back for the commits made in
// between: the server links them by trailer with no turn, and the turn that
// wrote their files keeps an empty card.
//
// Session a325d2ee, 2026-10-15: turn 11 launched sub-agents, the session was
// ended at 20:19 for a release, and at 20:20 a sub-agent committed d669074f7
// and f269ac36d in `agent-a2c0…` — trailer "a325d2ee-1d1", post-commit "no
// active sessions, skipped API update". The conversation resumed at 20:21;
// turn 11 stayed empty and `verify-capture` flagged it
// (emptied_row_with_own_writes).
//
// On resume, each such commit is attested to the turn whose recorded edits in
// that tree wrote one of its files. Both conditions are required: the trailer
// alone would also match an amend or rebase replaying an old commit, and a
// file overlap alone is a guess. No match, no attestation.

import { execFileSync } from 'child_process';
import fs from 'fs';
import { samePath } from './paths.js';
import { commitTurnOf, type SessionState } from './session-state.js';

const MAX_COMMITS_PER_TREE = 50;

export type GitRunner = (cwd: string, args: string[]) => string | null;

const runGit: GitRunner = (cwd, args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

type Holder = Pick<SessionState, 'sessionId' | 'repoPath' | 'liveEdits' | 'writeTrees' | 'promptTurnIds' | 'commitTurns' | 'foldedCommitTurns' | 'preSquashCommitTurns'>;

/** The trees the session wrote in: its own checkout and every sub-agent worktree. */
function treesOf(state: Holder): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined) => {
    if (p && !out.some((t) => samePath(t, p))) out.push(p);
  };
  add(state.repoPath);
  for (const w of state.writeTrees || []) add(w?.path);
  for (const e of state.liveEdits || []) add(e?.tree);
  return out;
}

/** The latest turn whose recorded edits in `tree` wrote one of `files`. */
function turnThatWrote(state: Holder, tree: string, files: Set<string>): number | null {
  let best: number | null = null;
  for (const e of state.liveEdits || []) {
    if (!e || !Number.isInteger(e.promptIndex)) continue;
    const inTree = e.tree ? samePath(e.tree, tree) : samePath(state.repoPath, tree);
    if (!inTree) continue;
    if (!(e.edits || []).some((ed) => ed?.file && files.has(ed.file.replace(/\\/g, '/')))) continue;
    if (best === null || e.promptIndex > best) best = e.promptIndex;
  }
  return best;
}

/**
 * Attest the commits made since `endedAt` that carry this session's trailer.
 * Returns how many were attested. Mutates `state.commitTurns`; does not save.
 */
export function attestCommitsMadeWhileEnded(
  state: Holder,
  endedAt: string | undefined,
  git: GitRunner = runGit,
): number {
  const since = Date.parse(endedAt || '');
  if (!Number.isFinite(since) || !state.sessionId) return 0;
  const tag = state.sessionId.slice(0, 12);
  let attested = 0;
  for (const tree of treesOf(state)) {
    try { if (!fs.existsSync(tree)) continue; } catch { continue; }
    const log = git(tree, [
      'log', `--since=${new Date(since).toISOString()}`, `-n${MAX_COMMITS_PER_TREE}`,
      '--format=%H%x1f%cI%x1f%(trailers:key=Origin-Session,valueonly,separator=%x1d)%x1e', 'HEAD',
    ]);
    if (!log) continue;
    for (const rec of log.split('\x1e')) {
      const [sha, at, trailers] = rec.trim().split('\x1f');
      if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) continue;
      const committed = Date.parse(at || '');
      if (!Number.isFinite(committed) || committed < since) continue;
      // The FIRST trailer decides, as everywhere else that reads it.
      const owner = (trailers || '').split('\x1d')[0]?.trim() || '';
      if (!owner.startsWith(tag)) continue;
      if (commitTurnOf(state, sha)) continue;
      const names = git(tree, ['diff-tree', '--no-commit-id', '-r', '--name-only', '--root', sha]);
      if (!names) continue;
      const files = new Set(names.split('\n').map((f) => f.trim()).filter(Boolean));
      const turn = turnThatWrote(state, tree, files);
      const turnId = turn === null ? undefined : state.promptTurnIds?.[turn];
      if (!turnId) continue;
      (state.commitTurns ??= []).push({ sha, turnId, at: new Date(committed).toISOString(), via: 'trailer' });
      attested++;
    }
  }
  return attested;
}
