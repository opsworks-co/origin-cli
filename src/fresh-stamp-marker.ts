/**
 * "prepare-commit-msg just wrote this trailer on a fresh commit", written down
 * for post-commit when the reflog cannot say so.
 *
 * post-commit keeps the session a commit's trailer names when that session is
 * homed in another linked worktree of the same repository
 * (keepSessionTheTrailerNames, #2392, the 6f67706e / df8cc9aa case) — but only
 * when the HEAD reflog entry that created the commit is a plain `commit:`.
 * Anything else (an amend, a merge, a rebase pick, a cherry-pick) carries a
 * trailer prepare-commit-msg did not freshly write, and keeping its session
 * would hand a neighbour's commit to whoever the old trailer names (9d583342).
 *
 * Reading the reflog is a `git` subprocess with a 5 s timeout, and on a starved
 * host it fails. Then post-commit could not tell a fresh commit from an amend,
 * dropped the session, and 6f67706e's bug came back: no session link, no note.
 *
 * prepare-commit-msg knows the answer in the foreground: git hands it the
 * message `source`, and it is the one that wrote the trailer. So when it stamps
 * session X on a FRESH commit (source empty, `message` or `template`, no replay
 * in progress) it leaves `<git-dir>/origin-stamps/<X's 12-char token>`. For
 * every other commit it removes the marker for the trailer token the message
 * already carries, so a stale one can never vouch for an amend or a merge.
 *
 * Guards against a stale marker:
 *  - it lives in the PER-WORKTREE git dir, where only this tree's commits see it;
 *  - post-commit consumes it for every commit whose trailer names the token,
 *    whatever it decides, and only honours one written in the last 10 minutes;
 *  - markers older than a day are pruned, and the directory is removed once
 *    empty again;
 *  - it is only a fallback: when the reflog IS readable, it decides alone.
 *
 * The git dir is found from the `.git` entry on disk, not with `git rev-parse`:
 * the point is to answer when git subprocesses are what is failing.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const MARKER_DIR = 'origin-stamps';
/** A marker older than this no longer vouches: post-commit runs within seconds of its commit. */
export const FRESH_STAMP_MAX_AGE_MS = 10 * 60 * 1000;
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** git sources for a commit whose message is new: `-m`/`-F` (message), a template, or none. */
export function isFreshCommitSource(source: string | undefined | null): boolean {
  return !source || source === 'message' || source === 'template';
}

/** The token of the LAST `Origin-Session:` trailer in a message — the one prepare-commit-msg appends. */
export function lastTrailerToken(message: string | null | undefined): string | null {
  if (!message) return null;
  const all = [...message.matchAll(/^Origin-Session:\s*([^\s|]+)/gmi)];
  const token = all.length ? all[all.length - 1][1].trim().toLowerCase() : '';
  return TOKEN.test(token) ? token : null;
}

/**
 * The git dir of the worktree containing `cwd`, from the `.git` entry on disk
 * (a directory, or a `gitdir:` file in a linked worktree). Falls back to
 * `git rev-parse --git-dir` only when there is no such entry.
 */
export function gitDirOnDisk(cwd: string): string | null {
  try {
    let dir = path.resolve(cwd);
    for (;;) {
      const dotGit = path.join(dir, '.git');
      let st: fs.Stats | null = null;
      try { st = fs.statSync(dotGit); } catch { st = null; }
      if (st?.isDirectory()) return dotGit;
      if (st?.isFile()) {
        const m = fs.readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+?)\s*$/m);
        return m ? path.resolve(dir, m[1]) : null;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { /* fall through */ }
  try {
    const out = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true,
    }).trim();
    return out ? (path.isAbsolute(out) ? out : path.resolve(cwd, out)) : null;
  } catch {
    return null;
  }
}

/**
 * prepare-commit-msg, after it ran: record that `stampedToken` was freshly
 * written on this commit, or — for an amend/merge/squash, a replay, or a commit
 * it did not stamp — clear the marker for the trailer `message` carries.
 * `stampedToken` is null whenever the hook did not stamp a fresh commit.
 * Never throws.
 */
export function noteTrailerStamp(
  hookCwd: string,
  source: string | undefined | null,
  stampedToken: string | null,
  message: string | null,
): void {
  try {
    const gitDir = gitDirOnDisk(hookCwd);
    if (!gitDir) return;
    const dir = path.join(gitDir, MARKER_DIR);
    const token = stampedToken ? stampedToken.slice(0, 12).toLowerCase() : null;
    if (token && TOKEN.test(token) && isFreshCommitSource(source)) {
      const body = JSON.stringify({ at: new Date().toISOString() });
      for (let attempt = 0; ; attempt++) {
        fs.mkdirSync(dir, { recursive: true });
        try {
          fs.writeFileSync(path.join(dir, token), body);
          break;
        } catch (err: any) {
          // Another hook removed the directory as it emptied: make it again.
          if (err?.code !== 'ENOENT' || attempt >= 2) throw err;
        }
      }
      prune(dir);
      return;
    }
    if (!fs.existsSync(dir)) return;
    const carried = lastTrailerToken(message);
    if (carried) {
      try { fs.unlinkSync(path.join(dir, carried.slice(0, 12))); } catch { /* none */ }
    }
    prune(dir);
    removeIfEmpty(dir);
  } catch { /* best effort */ }
}

/**
 * post-commit: take (consume) the fresh-stamp marker for the token `message`'s
 * last trailer names. True only when one existed and was written in the last
 * FRESH_STAMP_MAX_AGE_MS. Call it for every commit with a trailer, whatever
 * else decides, so a marker can never vouch twice. Never throws.
 */
export function takeFreshStamp(hookCwd: string, message: string | null | undefined): boolean {
  try {
    const token = lastTrailerToken(message);
    if (!token) return false;
    const gitDir = gitDirOnDisk(hookCwd);
    if (!gitDir) return false;
    const dir = path.join(gitDir, MARKER_DIR);
    if (!fs.existsSync(dir)) return false;
    const file = path.join(dir, token.slice(0, 12));
    let marker: { at?: unknown } | null = null;
    try { marker = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { marker = null; }
    if (marker) {
      try { fs.unlinkSync(file); } catch { /* another hook took it */ }
    }
    prune(dir);
    removeIfEmpty(dir);
    const at = typeof marker?.at === 'string' ? Date.parse(marker.at) : NaN;
    const age = Date.now() - at;
    return Number.isFinite(age) && age >= -60_000 && age <= FRESH_STAMP_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** Remove the marker directory if — and only if — it is empty. Never a marker. */
function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch { /* ENOTEMPTY/EEXIST: another commit's marker is in it; ENOENT: already gone */ }
}

function prune(dir: string): void {
  try {
    const cutoff = Date.now() - PRUNE_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* gone */ }
    }
  } catch { /* best-effort */ }
}
