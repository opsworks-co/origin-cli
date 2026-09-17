// Which working trees a session has WRITTEN in, and what it wrote there.
//
// `lastCwd` answers "where did this session's last hook fire". The bare git
// hooks (prepare-commit-msg, post-commit) used it to answer a different
// question — "did this session work in the tree being committed in" — and the
// two diverge the moment one session acts in several trees at once.
//
// Claude Code sub-agents with worktree isolation do exactly that: each runs in
// its own `.claude/worktrees/agent-*` checkout, and every tool hook it fires
// carries the PARENT's session_id, so all of them write the parent's single
// `lastCwd`. Session fd13f970 (2026-09-17) had three sub-agents flipping it
// several times a second. A commit in `agent-a47deb…` went unattributed because
// a sibling's post-tool-use moved lastCwd to `agent-abcef6…` 900ms before
// prepare-commit-msg read it; a commit in `agent-abcef6…` ten minutes later got
// the trailer because lastCwd happened to point there.
//
// PRESENCE IS NOT WORK. The first version of this recorded the tree of every
// tool call, so a Read or a Grep marked a tree forever — and a lone session
// with an open turn is allowed to own a commit, so a session that had merely
// LOOKED at a tree could be stamped onto a human's commit there. That is a
// false attribution, which is worse than the missing one this fixes. Only an
// OBSERVED WRITE records a tree, each entry carries the files written and the
// time, entries age out, and the git hooks require the commit to overlap those
// files before the entry counts for anything.
import * as fs from 'fs';
import * as path from 'path';
import { normalizePath } from './paths.js';

/** Enough for a parent plus a wide fan-out of sub-agents; stale entries go first. */
export const MAX_WRITE_TREES = 24;
/** Filenames kept per tree — the evidence a later commit is matched against. */
export const MAX_WRITE_TREE_FILES = 64;
/**
 * How long a write keeps a tree attributable. Matches the session-liveness
 * window used elsewhere: a session that wrote in a worktree three hours ago and
 * has not touched it since is no better a candidate than one that never did.
 */
export const WRITE_TREE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

export type WriteTree = { path: string; at: string; files?: string[] };
export type WriteTreeHolder = { writeTrees?: WriteTree[] | null };

const rootMemo = new Map<string, string | null>();

/** Case-folds where the filesystem does. Both sides must already be normalized. */
function sameNormalized(a: string, b: string): boolean {
  if (a === b) return true;
  if (process.platform === 'win32' || process.platform === 'darwin') return a.toLowerCase() === b.toLowerCase();
  return false;
}

/** A bare repo (HEAD + objects + refs, no work tree) has no working tree at all. */
function looksBare(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, 'HEAD'))) return false;
    return fs.existsSync(path.join(dir, 'objects')) && fs.existsSync(path.join(dir, 'refs'));
  } catch {
    return false;
  }
}

/**
 * The top of the working tree containing `dir`: the nearest ancestor holding a
 * `.git` entry — a directory in a main checkout, a FILE in a linked worktree.
 * Same answer as `git rev-parse --show-toplevel` for both, without a subprocess:
 * this runs on tool hooks.
 *
 * Nesting is why a plain containment test is not enough: every
 * `.claude/worktrees/*` checkout is textually inside the main checkout, and the
 * nearest `.git` is what tells them apart. A bare repo nested in a checkout
 * (`/code/mirror.git`) stops the walk instead of resolving to the checkout
 * around it — nothing inside it is part of that work tree.
 *
 * Returns the NORMALIZED root, so callers compare strings and never re-resolve.
 */
export function workTreeRootOf(dir: string | null | undefined): string | null {
  if (!dir) return null;
  const memo = rootMemo.get(dir);
  if (memo !== undefined) return memo;
  let found: string | null = null;
  try {
    let cur = normalizePath(dir);
    for (let hops = 0; hops < 128 && cur; hops++) {
      if (fs.existsSync(path.join(cur, '.git'))) { found = cur; break; }
      if (looksBare(cur)) break;
      const parent = path.dirname(cur);
      if (!parent || sameNormalized(parent, cur)) break;
      cur = parent;
    }
  } catch { found = null; }
  rootMemo.set(dir, found);
  return found;
}

function freshEntries(s: WriteTreeHolder, now: number): WriteTree[] {
  if (!Array.isArray(s.writeTrees)) return [];
  return s.writeTrees.filter((w) => {
    if (!w || typeof w.path !== 'string' || !w.path) return false;
    const at = Date.parse(w.at || '');
    return Number.isFinite(at) && now - at <= WRITE_TREE_MAX_AGE_MS;
  });
}

/**
 * Note that this session WROTE `files` in `hookCwd`'s working tree. Returns
 * true when the state changed (the caller saves). Never throws.
 *
 * `files` are the written paths as the observer saw them (absolute, or relative
 * to the tree); only their basenames are kept, which is the form every commit
 * comparison in post-commit.ts already uses.
 */
export function recordWriteTree(
  state: WriteTreeHolder,
  hookCwd: string | null | undefined,
  files: ReadonlyArray<string>,
  onEvict?: (evicted: WriteTree[]) => void,
): boolean {
  try {
    const tree = workTreeRootOf(hookCwd);
    if (!tree) return false;
    const names = files
      .filter((f): f is string => typeof f === 'string' && !!f)
      .map((f) => f.split(/[\\/]/).pop() || f);
    if (names.length === 0) return false;
    const nowIso = new Date().toISOString();
    const kept = Array.isArray(state.writeTrees) ? state.writeTrees.filter((w) => w && typeof w.path === 'string') : [];
    const at = kept.findIndex((w) => sameNormalized(w.path, tree));
    const previous = at >= 0 ? kept.splice(at, 1)[0] : undefined;
    const merged = [...new Set([...(previous?.files || []), ...names])].slice(-MAX_WRITE_TREE_FILES);
    kept.push({ path: tree, at: nowIso, files: merged });
    // Stale entries go before fresh ones — a sub-agent worktree is deleted the
    // moment its task ends, and its entry must not push out a live tree.
    const evicted: WriteTree[] = [];
    if (kept.length > MAX_WRITE_TREES) {
      const now = Date.now();
      const isStale = (w: WriteTree): boolean => {
        const t = Date.parse(w.at || '');
        return !Number.isFinite(t) || now - t > WRITE_TREE_MAX_AGE_MS;
      };
      const stale = kept.filter(isStale);
      const fresh = kept.filter((w) => !isStale(w));
      while (stale.length > 0 && stale.length + fresh.length > MAX_WRITE_TREES) evicted.push(stale.shift()!);
      const order = [...stale, ...fresh];
      while (order.length > MAX_WRITE_TREES) evicted.push(order.shift()!);
      kept.length = 0;
      kept.push(...order);
    }
    state.writeTrees = kept;
    if (evicted.length > 0 && onEvict) onEvict(evicted);
    return true;
  } catch {
    return false;
  }
}

/**
 * Did this session write in `hookTree` recently enough to count?
 *
 * `hookTree` is normalized ONCE here; stored paths are already normalized, so a
 * full list costs string compares and no filesystem access. That matters: the
 * steady state is a list of DELETED sub-agent worktrees, and resolving those
 * per entry on every candidate of every git hook was the whole cost of the
 * first version.
 */
export function sessionWroteInTree(
  s: WriteTreeHolder,
  hookTree: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!hookTree || !Array.isArray(s.writeTrees) || s.writeTrees.length === 0) return false;
  const want = normalizePath(hookTree);
  if (!want) return false;
  return freshEntries(s, now).some((w) => sameNormalized(w.path, want));
}

/** The files this session recorded writing in `hookTree` (basenames). */
export function filesWrittenInTree(
  s: WriteTreeHolder,
  hookTree: string | null | undefined,
  now: number = Date.now(),
): string[] {
  if (!hookTree || !Array.isArray(s.writeTrees)) return [];
  const want = normalizePath(hookTree);
  if (!want) return [];
  const hit = freshEntries(s, now).find((w) => sameNormalized(w.path, want));
  return hit?.files ? [...hit.files] : [];
}

/**
 * Does one of `commitFiles` match a file this session wrote in `hookTree`?
 *
 * This is the evidence a write-tree candidate stands on. Without it the entry
 * alone could make a session the lone candidate, and a lone candidate with an
 * open turn is allowed to own the commit — so "I once wrote something in this
 * worktree" would have been enough to take a stranger's commit.
 *
 * Basenames, like every other commit-file comparison in post-commit.ts:
 * ledgers hold a mix of absolute and repo-relative paths (#1085).
 */
export function commitOverlapsWritesInTree(
  s: WriteTreeHolder,
  hookTree: string | null | undefined,
  commitFiles: ReadonlyArray<string> | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!commitFiles || commitFiles.length === 0) return false;
  const wrote = new Set(filesWrittenInTree(s, hookTree, now));
  if (wrote.size === 0) return false;
  return commitFiles.some((f) => typeof f === 'string' && wrote.has(f.split(/[\\/]/).pop() || f));
}

/**
 * Keep write trees another hook process recorded since `state` was read.
 *
 * Parallel sub-agents fire hooks concurrently; each loads the state, records
 * its own tree and saves. Last-writer-wins would drop the others' trees — the
 * very race this list exists to take out of attribution. Entries merge per tree
 * (newest timestamp, union of files) and the NEWEST survive the cap, so a peer's
 * recent write is never dropped for one of our own stale ones. Does not save.
 * Returns how many entries were added or merged.
 */
export function keepWriteTreesSavedMeanwhile(
  state: WriteTreeHolder & { sessionId?: string },
  onDisk: (WriteTreeHolder & { sessionId?: string }) | null | undefined,
): number {
  if (!onDisk || !state?.sessionId || onDisk.sessionId !== state.sessionId) return 0;
  const theirs = Array.isArray(onDisk.writeTrees) ? onDisk.writeTrees.filter((w) => w && typeof w.path === 'string') : [];
  if (theirs.length === 0) return 0;
  const ours = Array.isArray(state.writeTrees) ? state.writeTrees.filter((w) => w && typeof w.path === 'string') : [];
  const merged: WriteTree[] = ours.map((w) => ({ ...w, files: w.files ? [...w.files] : undefined }));
  let changed = 0;
  for (const t of theirs) {
    const mine = merged.find((w) => sameNormalized(w.path, t.path));
    if (!mine) {
      merged.push({ ...t, files: t.files ? [...t.files] : undefined });
      changed++;
      continue;
    }
    const files = [...new Set([...(mine.files || []), ...(t.files || [])])].slice(-MAX_WRITE_TREE_FILES);
    const newer = (Date.parse(t.at || '') || 0) > (Date.parse(mine.at || '') || 0);
    if (newer || files.length !== (mine.files || []).length) changed++;
    mine.files = files;
    if (newer) mine.at = t.at;
  }
  if (changed === 0) return 0;
  merged.sort((a, b) => (Date.parse(a.at || '') || 0) - (Date.parse(b.at || '') || 0));
  state.writeTrees = merged.slice(-MAX_WRITE_TREES);
  return changed;
}
