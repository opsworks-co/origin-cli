import fs from 'fs';
import path from 'path';
import { runDetailed } from './utils/exec.js';

const LIST_TIMEOUT_MS = 30_000;
const LIST_MAX_BUFFER = 16 * 1024 * 1024;
const CLONE_TIMEOUT_MS = 5 * 60_000;

/**
 * Give a new linked worktree its own copy of the canonical checkout's
 * dependency directories (`node_modules` at any depth), so an agent there can
 * build without installing first.
 *
 * Only `node_modules` is carried over: other ignored files (.env, *.pem, local
 * tokens) never reach a worktree, which matters for bake-off arms running
 * third-party agents. Each directory is a copy-on-write clone (APFS clonefile,
 * Linux reflink), never a symlink, so an install or edit in one worktree can't
 * reach the canonical checkout or a sibling. Where the filesystem can't clone,
 * the directory is skipped with a warning rather than fully copied. Existing
 * destinations (including dangling links) always win.
 *
 * Symlinks inside are cloned as links. Relative ones (pnpm's) resolve inside
 * the worktree; an absolute one (`npm link`, a hand-made link) still points
 * where it did, so writes through it reach that place.
 *
 * `onClone` is called with each directory before its clone starts, which can
 * take several seconds, so a caller can say what the pause is.
 */
export function hydrateWorktreeIgnoredFiles(canonical: string, worktree: string, onClone?: (relative: string) => void): string[] {
  const listed = runDetailed('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
    cwd: canonical, timeoutMs: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER,
  });
  if (listed.timedOut) return ['could not list ignored files: git ls-files timed out'];
  if (listed.status !== 0) return [`could not list ignored files: ${listed.stderr.trim() || `exit ${listed.status}`}`];

  const candidates = listed.stdout.split('\0')
    .filter((raw) => raw.endsWith('/'))
    .map((raw) => raw.slice(0, -1))
    .filter((relative) => relative.split('/').pop() === 'node_modules')
    // Existing destinations win, and git refuses to check a path behind one.
    .filter((relative) => !pathEntryExists(path.join(worktree, relative)));
  if (!candidates.length) return [];

  // Ask the worktree's branch, not canonical's: a path its .gitignore doesn't
  // ignore (or that it tracks) must not be shadowed by canonical's copy.
  const checked = runDetailed('git', ['check-ignore', '-z', '--stdin'], {
    cwd: worktree, timeoutMs: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER,
    input: candidates.map((relative) => `${relative}/\0`).join(''),
  });
  // Exit 1 = nothing ignored; anything else is a failure.
  if (checked.status !== 0 && checked.status !== 1) return [`could not check ignored files: ${checked.stderr.trim() || `exit ${checked.status}`}`];
  const ignoredHere = new Set(checked.stdout.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, '')));

  const warnings: string[] = [];
  for (const relative of candidates) {
    if (!ignoredHere.has(relative)) continue;
    const source = path.join(canonical, relative);
    const target = path.join(worktree, relative);
    onClone?.(relative);
    const failure = cloneDirectory(source, target);
    if (failure) warnings.push(`${relative}: not cloned (${failure}) — run your package install in the worktree`);
  }
  return warnings;
}

// lstat, not existsSync: a dangling symlink is still an entry we must not touch.
function pathEntryExists(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

// Copy-on-write clone or nothing. A full copy of node_modules can be
// gigabytes, so `--reflink=auto` is not used. macOS `cp -c` silently falls back
// to a full copy, so cloning is first checked to be possible: same APFS volume
// on macOS, a force-cloned probe file on Linux.
function cloneDirectory(source: string, target: string): string | null {
  let args: string[];
  if (process.platform === 'darwin') args = ['-c', '-a', source, target];
  else if (process.platform === 'linux') args = ['-a', '--reflink=always', source, target];
  else return 'copy-on-write cloning is not supported on this platform';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err: any) {
    return err?.message || String(err);
  }
  const cannotClone = process.platform === 'darwin'
    ? apfsCloneBlocker(source, path.dirname(target))
    : probeClone(source, path.dirname(target));
  if (cannotClone) return `filesystem can't copy-on-write: ${cannotClone}`;
  const r = runDetailed('cp', args, { timeoutMs: CLONE_TIMEOUT_MS });
  if (r.status === 0 && !r.timedOut) return null;
  fs.rmSync(target, { recursive: true, force: true });
  if (r.timedOut) return 'clone timed out';
  return `filesystem can't copy-on-write: ${r.stderr.trim().split('\n')[0] || `exit ${r.status}`}`;
}

// APFS's statfs f_type on macOS (HFS+ is 0x11). clonefile(2) needs both ends
// on the same APFS volume.
const APFS_FS_TYPE = 0x1a;

function apfsCloneBlocker(source: string, destDir: string): string | null {
  try {
    if (fs.statSync(source).dev !== fs.statSync(destDir).dev) return 'different volume';
    if (fs.statfsSync(destDir).type !== APFS_FS_TYPE) return 'not APFS';
    return null;
  } catch (err: any) {
    return err?.code || err?.message || String(err);
  }
}

// Linux only: Node's FICLONE_FORCE is the FICLONE ioctl there (it's ENOSYS on
// macOS). Force-clone one regular file from `source` into `destDir` and remove
// it. Returns null when cloning works (or the tree has no file to clone), else
// the reason.
function probeClone(source: string, destDir: string): string | null {
  const file = findRegularFile(source);
  if (file === undefined) return 'no file found to test cloning with';
  if (!file) return null;
  const probe = path.join(destDir, `.origin-clone-probe-${process.pid}`);
  try {
    fs.copyFileSync(file, probe, fs.constants.COPYFILE_FICLONE_FORCE);
    return null;
  } catch (err: any) {
    return err?.code || err?.message || String(err);
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

// Breadth-first: node_modules has a regular file within a level or two. The
// bound is on directories read, not entries, so a top level of thousands of
// package dirs (npm's hoisted layout) is still searched for its files first.
// null = the whole tree has no regular file; undefined = gave up looking.
export function findRegularFile(dir: string, maxDirs = 200): string | null | undefined {
  const queue = [dir];
  let read = 0;
  while (queue.length) {
    if (read++ >= maxDirs) return undefined;
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    const file = entries.find((entry) => entry.isFile());
    if (file) return path.join(current, file.name);
    for (const entry of entries) if (entry.isDirectory()) queue.push(path.join(current, entry.name));
  }
  return null;
}
