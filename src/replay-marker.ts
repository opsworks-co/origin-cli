/**
 * "This commit is a replay", written down while git still says so.
 *
 * post-commit decides a commit is a rebase pick, a cherry-pick or a `git am`
 * patch from the HEAD reflog entry that created it (commit-replay.ts). That
 * read is a `git` subprocess with a timeout, and on a starved host it fails.
 * Then the replay markers in the git dir (`rebase-merge/`, `rebase-apply/`,
 * `CHERRY_PICK_HEAD`) are the fallback — but the installed post-commit hook
 * runs Origin in the BACKGROUND, and by the time it looks the replay may have
 * finished and taken its markers with it. Neither source answers, the verdict
 * is `unknown`, and the replayed commit is credited to the running turn.
 *
 * prepare-commit-msg runs in the FOREGROUND, while the markers exist, for every
 * commit a replay writes. So it records the fact here, keyed by the commit the
 * new commit will sit on — its parent, HEAD at that moment — and post-commit
 * takes it for the commit it was given. The key keeps the picks of one rebase
 * apart even when their backgrounded post-commits run late: each pick has a
 * different parent. The same shape as cherry-pick-source.ts.
 *
 * Guards against a stale marker:
 *  - every commit prepared on the same parent that is NOT a replay clears it;
 *  - post-commit consumes it whatever it decides, and markers older than a
 *    day are pruned;
 *  - it is only a fallback: post-commit asks the reflog first, which also
 *    tells an authored commit made while a rebase is stopped at `edit` from
 *    the picks around it.
 *
 * The directory is removed once it is empty again, so an ordinary commit keeps
 * its fast path (no directory → no extra git call).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { replayInProgressInGitDir, type ReplayKind } from './commit-replay.js';

const READ = { encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true };
const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const KINDS: readonly ReplayKind[] = ['rebase', 'cherry-pick', 'am'];
const MARKER_DIR = 'origin-replays';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { ...READ, cwd }).trim();
  } catch {
    return null;
  }
}

function gitDirOf(cwd: string): string | null {
  const gitDir = gitOut(cwd, ['rev-parse', '--git-dir']);
  if (!gitDir) return null;
  return path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir);
}

function fullCommit(cwd: string, rev: string): string | null {
  const out = (gitOut(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) || '').toLowerCase();
  return FULL_SHA.test(out) ? out : null;
}

/**
 * prepare-commit-msg: record that the commit about to be made on HEAD is a
 * replay, or clear a stale record when it is not. Never throws; returns the
 * kind it recorded, for the log.
 */
export function rememberReplayInProgress(hookCwd: string): ReplayKind | null {
  try {
    const gitDir = gitDirOf(hookCwd);
    if (!gitDir) return null;
    const dir = path.join(gitDir, MARKER_DIR);
    const kind = replayInProgressInGitDir(gitDir);
    // The common case — an ordinary commit and no marker anywhere — costs no more git calls.
    if (!kind && !fs.existsSync(dir)) return null;
    const head = fullCommit(hookCwd, 'HEAD');
    if (!head) return null;
    const file = path.join(dir, head);
    if (!kind) {
      try { fs.unlinkSync(file); } catch { /* none */ }
      prune(dir);
      removeIfEmpty(dir);
      return null;
    }
    const body = JSON.stringify({ kind, at: new Date().toISOString() });
    for (let attempt = 0; ; attempt++) {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(file, body);
        break;
      } catch (err: any) {
        // Another hook removed the directory as it emptied: make it again.
        if (err?.code !== 'ENOENT' || attempt >= 2) throw err;
      }
    }
    prune(dir);
    return kind;
  } catch {
    return null;
  }
}

/**
 * post-commit: the replay kind prepare-commit-msg recorded for `commitSha`'s
 * parent, consumed. Null when nothing was recorded. Call it for every commit,
 * whatever else decides the verdict, so a marker never outlives its commit.
 */
export function takeReplayMarker(hookCwd: string, commitSha: string): ReplayKind | null {
  try {
    const commit = (commitSha || '').toLowerCase();
    if (!FULL_SHA.test(commit)) return null;
    const gitDir = gitDirOf(hookCwd);
    if (!gitDir) return null;
    const dir = path.join(gitDir, MARKER_DIR);
    if (!fs.existsSync(dir)) return null;
    const parent = fullCommit(hookCwd, `${commit}^1`);
    if (!parent) return null;
    const file = path.join(dir, parent);
    let marker: { kind?: unknown };
    try {
      marker = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
    try { fs.unlinkSync(file); } catch { /* another hook took it */ }
    prune(dir);
    removeIfEmpty(dir);
    return KINDS.includes(marker.kind as ReplayKind) ? marker.kind as ReplayKind : null;
  } catch {
    return null;
  }
}

/** Remove the marker directory if — and only if — it is empty. Never a marker. */
function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch { /* ENOTEMPTY/EEXIST: a replay's marker is in it; ENOENT: already gone */ }
}

function prune(dir: string): void {
  try {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* gone */ }
    }
  } catch { /* best-effort */ }
}
