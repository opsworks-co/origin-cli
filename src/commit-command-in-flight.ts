// Which session is running `git commit` right now.
//
// prepare-commit-msg has to name the committing session from the outside: git
// runs the hook, not the agent. With several live sessions in one checkout it
// weighed FILES — an open turn whose ledger holds a staged file, then whose
// recorded turns overlap the staged list. Both read what a session wrote, and
// neither can see a write the ledger has not recorded yet: a shell command
// that edits a file and commits it in the same call (`python3 - <<EOF … EOF;
// git add …; git commit`) reaches the hook before its own post-tool-use has
// run. Session 6b770703, 2026-09-20: two staged files, none in its ledger yet,
// and the overlap rule then found ONE — in the completed turns of ff9131bd, the
// previous conversation in the same worktree, idle since the day before. Its
// trailer went on the commit and post-commit followed the trailer.
//
// The pre-tool-use hook sees the command before it runs. A shell call that is
// about to make a commit is recorded here, on the session's own state, and the
// commit hook asks for it before it weighs any file.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/** A claim older than this is a tool call that crashed or was blocked, not a commit in progress. */
export const COMMIT_COMMAND_TTL_MS = 10 * 60_000;

export interface CommitCommandInFlight {
  /** ISO time the pre-tool-use hook saw the command. */
  at: string;
  /** The tool call that is running it; post-tool-use clears only its own. */
  toolCallId?: string;
  /** Where the agent's shell was when it ran — the hook payload's cwd. */
  cwd?: string;
  /** The turn it ran in. A claim does not outlive its turn. */
  turn?: number;
}

interface ClaimingSession {
  commitCommandInFlight?: CommitCommandInFlight | null;
  lastClosedTurnIndex?: number;
}

// `git commit` and `git revert`: the two that reach the picker. The hook
// returns before it for a merge (`source=merge`) and for a rebase, cherry-pick
// or am in progress (commit-replay.ts), and a fast-forward pull fires no hook —
// claiming for those would hold a claim up for minutes and decide nothing.
// Global options may sit between `git` and the verb (`git -c user.name=x
// commit`, `git -C dir commit`); a verb after a command separator belongs to
// another command.
const COMMIT_VERB = /(?:^|[\s;&|(`])git(?:\s+(?:-[A-Za-z]\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*\s+(commit|revert)(?=$|[\s;&|)`])/;

/** Does this shell command make a commit the hooks will attribute? Text only; nothing is run. */
export function commandMakesCommit(command: string): boolean {
  if (!command || typeof command !== 'string') return false;
  return COMMIT_VERB.test(command);
}

function realDir(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function sameDir(a: string, b: string): boolean {
  const ra = realDir(a); const rb = realDir(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * The top of the working tree `dir` is in — asked of git with the hook's own
 * GIT_* variables taken out. For a commit in a LINKED worktree git runs the
 * hook with GIT_DIR set and no GIT_WORK_TREE, and under that
 * `rev-parse --show-toplevel` answers the directory it was asked from,
 * whatever it is: a shell parked in `packages/cli` came back as its own tree
 * and never matched the hook's (git 2.50.1).
 */
export function workTreeTop(dir: string): string | null {
  try {
    const env = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[k];
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      windowsHide: true, encoding: 'utf-8', cwd: dir, env, timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return top || null;
  } catch {
    return null;
  }
}

/**
 * Is `session` running a commit-making command in the working tree git is
 * committing in (`hookCwd`: git runs commit hooks at the top of it)?
 *
 * The claim has to be of a turn Stop has not closed. post-tool-use clears it,
 * but not every call reports back (a failed or interrupted one may not), and
 * a turn that has ended is not committing anything. Read off the closed-turn
 * marker rather than `activeTurn`: a turn whose only tool call is the commit
 * was never opened by a tool hook, and is committing all the same.
 *
 * The shell's cwd has to be in THAT tree — its top, not merely a path under
 * it: a linked worktree lives under the main checkout's directory, and a
 * commit running there is no evidence for one in the main checkout. A command
 * that commits somewhere else (`git -C ../other commit`, `cd ../other && git
 * commit`) says so in its text, which this does not read; such a claim can
 * only mislead if a second commit lands in this tree in the same seconds.
 */
export function sessionIsRunningCommitHere(
  session: ClaimingSession,
  hookCwd: string,
  workTreeOf: (dir: string) => string | null = workTreeTop,
  now: number = Date.now(),
): boolean {
  const claim = session?.commitCommandInFlight;
  if (!claim || typeof claim.at !== 'string') return false;
  const at = Date.parse(claim.at);
  if (!Number.isFinite(at) || now - at > COMMIT_COMMAND_TTL_MS || at - now > 60_000) return false;
  const closed = Number.isInteger(session.lastClosedTurnIndex) ? session.lastClosedTurnIndex as number : -1;
  if (!Number.isInteger(claim.turn) || (claim.turn as number) <= closed) return false;
  if (!claim.cwd || !hookCwd) return false;
  let claimTree: string | null = null;
  let hookTree: string | null = null;
  try { claimTree = workTreeOf(claim.cwd); hookTree = workTreeOf(hookCwd) || hookCwd; } catch { return false; }
  return !!claimTree && !!hookTree && sameDir(claimTree, hookTree);
}

/**
 * The one session that is running this commit, or null when the claims do not
 * settle it and the file rules must.
 *
 * Exactly one claimant — several prove nothing. And a claimant with no staged
 * file in its open turn's ledger gives way when ANOTHER session's open turn
 * has one: a claim can be stale inside its own turn (a call that never
 * reported back), and then the committer may be an agent whose shell this
 * does not see, or a person. That session's ledger is the better evidence,
 * and the in-flight rule after this one reads it. In the case this exists for
 * the other session had no turn open at all.
 */
export function sessionRunningTheCommit<T extends ClaimingSession>(
  sessions: T[],
  hookCwd: string,
  staged: Set<string>,
  inFlightFilesOf: (s: T) => string[],
  workTreeOf: (dir: string) => string | null = workTreeTop,
  now: number = Date.now(),
): { session: T | null; why: string } {
  const claimants = sessions.filter((s) => sessionIsRunningCommitHere(s, hookCwd, workTreeOf, now));
  if (claimants.length === 0) return { session: null, why: 'no session announced a commit here' };
  if (claimants.length > 1) return { session: null, why: 'several sessions announced a commit here' };
  const claimant = claimants[0];
  const holdsStaged = (s: T): boolean => inFlightFilesOf(s).some((f) => staged.has(f));
  if (!holdsStaged(claimant) && sessions.some((s) => s !== claimant && holdsStaged(s))) {
    return { session: null, why: "another session's open turn holds a staged file and the claimant's does not" };
  }
  return { session: claimant, why: 'commit command in flight' };
}
