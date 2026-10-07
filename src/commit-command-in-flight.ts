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

/** git's commit timestamp has whole-second resolution; allow for it on both ends. */
export const COMMIT_TIME_SLACK_MS = 2_000;

export interface CommitCommandInFlight {
  /** ISO time the pre-tool-use hook saw the command. */
  at: string;
  /** The tool call that is running it; post-tool-use clears only its own. */
  toolCallId?: string;
  /** Where the agent's shell was when it ran — the hook payload's cwd. */
  cwd?: string;
  /** The turn it ran in. A claim does not outlive its turn. */
  turn?: number;
  /**
   * When the call returned (post-tool-use / PostToolUseFailure). The claim is
   * ENDED, not deleted: git starts Origin's post-commit in the background, so
   * post-commit can read the state after the call has returned. It asks
   * whether the claim was live when the commit was MADE; prepare-commit-msg,
   * which runs while the call is still going, treats an ended claim as over.
   */
  endedAt?: string;
}

interface ClaimingSession {
  commitCommandInFlight?: CommitCommandInFlight | null;
  lastClosedTurnIndex?: number;
}

// `git commit` and `git revert`: the two that reach the picker. The hook
// returns before it for a merge (`source=merge`) and for a rebase, cherry-pick
// or am in progress (commit-replay.ts), and a fast-forward pull fires no hook —
// claiming for those would hold a claim up for minutes and decide nothing.
// `git merge --continue` is the exception: it IS a commit, and post-commit —
// which does see merge commits — reads the claim when no trailer names anyone.
//
// Read as shell words, not by pattern. A regex could not see `/usr/bin/git`,
// `git.exe`, a quoted option value (`git -c "user.name=A B" commit`), a
// command wrapped in `bash -lc "…"`, or an alias (`git ci`); each of those fell
// through to the file rules, the very ones this exists to overrule.

/** Looks up `alias.<name>` for the repo the command runs in; null when unset. */
export type GitAliasResolver = (name: string) => string | null;

// Global options that take their value as the NEXT word (`-c k=v`, `-C dir`).
// The `--opt=value` spelling is one word and needs no entry here.
const GIT_OPTS_WITH_VALUE = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--list-cmds',
]);

// Words that run the command after them. `timeout` takes a duration first.
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'nice', 'sudo', 'timeout', 'caffeinate']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

// git refuses an alias that shadows a builtin, so these are never looked up —
// and the lookup is a process spawn this hook should not pay per `git status`.
const GIT_BUILTINS = new Set([
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-ignore', 'checkout',
  'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-tree', 'config', 'count-objects', 'describe', 'diff',
  'diff-files', 'diff-index', 'diff-tree', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object',
  'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'merge-file', 'merge-tree', 'mv',
  'name-rev', 'notes', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace',
  'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout',
  'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit',
  'version', 'whatchanged', 'worktree', 'write-tree',
]);

const SEP = '\u0000';

/**
 * Split a command line into words, with SEP between simple commands. Quotes
 * group and are removed; a separator inside quotes is text. Deliberately
 * small: no expansion, and a heredoc body is read as more commands — harmless,
 * it is text nobody runs as git.
 */
function shellWords(command: string): string[] {
  const out: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const end = () => { if (inWord) out.push(word); word = ''; inWord = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // In double quotes a backslash escapes only these; before anything else
      // it is literal (`"C:\Program Files\Git\cmd\git.exe"`).
      if (ch === '\\' && quote === '"' && '"\\$`'.includes(command[i + 1] ?? '')) { word += command[++i]; continue; }
      word += ch; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
    if (ch === '\\' && i + 1 < command.length) {
      const next = command[++i];
      if (next !== '\n') { word += next; inWord = true; }
      continue;
    }
    if (/\s/.test(ch)) {
      end();
      if (ch === '\n') out.push(SEP);
      continue;
    }
    if (';&|()`{}'.includes(ch) || (ch === '$' && command[i + 1] === '(')) {
      end(); out.push(SEP);
      if (ch === '$') i++;
      continue;
    }
    word += ch; inWord = true;
  }
  end();
  return out;
}

/** `/usr/bin/git`, `C:\Program Files\Git\cmd\git.exe`, `git` → `git`. */
function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() || '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

function gitArgsMakeCommit(args: string[], resolveAlias: GitAliasResolver | undefined, depth: number): boolean {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    i += GIT_OPTS_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  const verb = args[i];
  if (!verb) return false;
  if (verb === 'commit' || verb === 'revert') return true;
  if (verb === 'merge') return args.slice(i + 1).includes('--continue');
  if (!resolveAlias || GIT_BUILTINS.has(verb) || !/^[\w.-]+$/.test(verb) || depth >= 3) return false;
  let alias: string | null = null;
  try { alias = resolveAlias(verb); } catch { alias = null; }
  if (!alias || !alias.trim()) return false;
  const rest = args.slice(i + 1).join(' ');
  // `!…` is a shell alias: its text is a command line of its own.
  if (alias.trim().startsWith('!')) return makesCommit(alias.trim().slice(1), resolveAlias, depth + 1);
  return makesCommit(`git ${alias} ${rest}`, resolveAlias, depth + 1);
}

function makesCommit(command: string, resolveAlias: GitAliasResolver | undefined, depth: number): boolean {
  const words = shellWords(command);
  let cmd: string[] = [];
  const check = (): boolean => {
    let i = 0;
    for (;;) {
      while (i < cmd.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd[i])) i++; // FOO=1 git …
      const prog = cmd[i] === undefined ? '' : programName(cmd[i]);
      if (!WRAPPERS.has(prog)) break;
      i++;
      // A wrapper's own options (`env -i`, `nice -n 5`, `timeout 60`).
      while (i < cmd.length && (cmd[i].startsWith('-') || /^\d+[smhd]?$/.test(cmd[i]))) i++;
    }
    if (i >= cmd.length) return false;
    const prog = programName(cmd[i]);
    if (prog === 'git') return gitArgsMakeCommit(cmd.slice(i + 1), resolveAlias, depth);
    // `bash -lc "git commit …"` — the script is the word after the -c flag.
    if (SHELLS.has(prog) && depth < 3) {
      for (let j = i + 1; j < cmd.length; j++) {
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(cmd[j])) return !!cmd[j + 1] && makesCommit(cmd[j + 1], resolveAlias, depth + 1);
        if (!cmd[j].startsWith('-')) break;
      }
    }
    return false;
  };
  for (const w of words) {
    if (w === SEP) { if (check()) return true; cmd = []; continue; }
    cmd.push(w);
  }
  return check();
}

/**
 * Does this shell command make a commit the hooks will attribute? Nothing is
 * run, except `resolveAlias` for a git verb that is not a builtin.
 */
export function commandMakesCommit(command: string, resolveAlias?: GitAliasResolver): boolean {
  if (!command || typeof command !== 'string') return false;
  return makesCommit(command, resolveAlias, 0);
}

/** `alias.<name>` as the repo at `cwd` sees it, or null. For commandMakesCommit. */
export function gitAliasResolver(cwd: string): GitAliasResolver {
  return (name: string) => {
    try {
      const v = execFileSync('git', ['config', '--get', `alias.${name}`], {
        windowsHide: true, encoding: 'utf-8', cwd, timeout: 2_000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return v || null;
    } catch {
      return null; // exit 1 = unset
    }
  };
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
  commitAt?: number,
): boolean {
  const claim = session?.commitCommandInFlight;
  if (!claim || typeof claim.at !== 'string') return false;
  const at = Date.parse(claim.at);
  if (!Number.isFinite(at) || now - at > COMMIT_COMMAND_TTL_MS || at - now > 60_000) return false;
  // With the commit's own time (post-commit), the claim must have been live
  // THEN: made before it, and not ended before it. Without it (prepare-commit-msg,
  // mid-command), an ended claim is simply over.
  const endedAt = typeof claim.endedAt === 'string' ? Date.parse(claim.endedAt) : NaN;
  if (Number.isFinite(commitAt)) {
    if ((commitAt as number) < at - COMMIT_TIME_SLACK_MS) return false;
    if (Number.isFinite(endedAt) && (commitAt as number) > endedAt + COMMIT_TIME_SLACK_MS) return false;
  } else if (Number.isFinite(endedAt)) {
    return false;
  }
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
  commitAt?: number,
): { session: T | null; why: string } {
  const claimants = sessions.filter((s) => sessionIsRunningCommitHere(s, hookCwd, workTreeOf, now, commitAt));
  if (claimants.length === 0) return { session: null, why: 'no session announced a commit here' };
  if (claimants.length > 1) return { session: null, why: 'several sessions announced a commit here' };
  const claimant = claimants[0];
  const holdsStaged = (s: T): boolean => inFlightFilesOf(s).some((f) => staged.has(f));
  if (!holdsStaged(claimant) && sessions.some((s) => s !== claimant && holdsStaged(s))) {
    return { session: null, why: "another session's open turn holds a staged file and the claimant's does not" };
  }
  return { session: claimant, why: 'commit command in flight' };
}
