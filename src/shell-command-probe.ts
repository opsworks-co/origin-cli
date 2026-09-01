// Evidence that a SHELL command wrote a file, instead of an inference that it
// might have.
//
// The turn window (shell-write-capture.ts) answers "what changed in this tree
// between the start of the turn and now". Over a turn that runs for minutes in
// a checkout shared with other agents, that question has the wrong answer a
// lot: it collected a sibling session's WIP, files the user edited by hand, and
// work a concurrent agent committed. Every capture bug in this area is that
// window being wide.
//
// A command is a much smaller question. Fingerprint the dirty files just
// BEFORE a write-shaped command runs and again just after; what changed in
// between is what that command did. The exposure shrinks from the length of a
// turn to the length of one command, and — unlike the window — a file is
// claimed because it was seen changing, not because it happened to be dirty.
//
// Cost is deliberately low: `git status`-equivalent for names plus a stat per
// dirty file. No shadow commit, no content read, nothing O(repo).
//
// What it still cannot see: a command that rewrites a file to the same size
// within the same millisecond, and any write outside the trees being probed.
// Both are narrower than what the window gets wrong today.

export interface FileStamp {
  file: string;
  mtimeMs: number;
  size: number;
}

export interface TreeProbe {
  tree: string;
  stamps: FileStamp[];
  /** True when the probe gave up (too many dirty files) — callers must then
   *  fall back to the window rather than treat "nothing touched" as fact. */
  skipped?: boolean;
}

export interface ProbeDeps {
  /** Repo-relative paths of every dirty file in `tree` (tracked + untracked). */
  listDirty: (tree: string) => string[];
  /** mtime/size of one file, or null when it does not exist. */
  stat: (tree: string, file: string) => { mtimeMs: number; size: number } | null;
}

// A tree this dirty is a checkout mid-rebase or with a build output tree in
// it; stat-ing every entry around every command is not worth it, and the
// window remains as the fallback.
export const MAX_PROBED_FILES = 2000;

/** Fingerprint the dirty files of `tree`. */
export function probeTree(tree: string, deps: ProbeDeps, maxFiles = MAX_PROBED_FILES): TreeProbe {
  if (!tree) return { tree, stamps: [], skipped: true };
  let files: string[];
  try {
    files = deps.listDirty(tree) || [];
  } catch {
    return { tree, stamps: [], skipped: true };
  }
  if (files.length > maxFiles) return { tree, stamps: [], skipped: true };
  const stamps: FileStamp[] = [];
  for (const file of files) {
    if (!file) continue;
    let st: { mtimeMs: number; size: number } | null = null;
    try { st = deps.stat(tree, file); } catch { st = null; }
    if (!st) continue;
    stamps.push({ file, mtimeMs: st.mtimeMs, size: st.size });
  }
  return { tree, stamps };
}

/**
 * Files that changed between two probes of the same tree.
 *
 * Counted as touched:
 *   - newly dirty (including a tracked file the command deleted, which shows
 *     up as a dirty path)
 *   - already dirty and now a different mtime or size
 *
 * NOT counted: a file that STOPPED being dirty. `git commit` clears the dirty
 * flag for files an EARLIER command wrote, and crediting them to whichever
 * command happened to run the commit is precisely the kind of borrowed
 * attribution this module exists to remove.
 */
export function touchedSince(before: TreeProbe, after: TreeProbe): string[] {
  if (!before || !after) return [];
  if (before.skipped || after.skipped) return [];
  const prev = new Map<string, FileStamp>();
  for (const s of before.stamps) prev.set(s.file, s);
  const touched: string[] = [];
  for (const s of after.stamps) {
    const p = prev.get(s.file);
    if (!p) { touched.push(s.file); continue; }
    if (p.mtimeMs !== s.mtimeMs || p.size !== s.size) touched.push(s.file);
  }
  return touched;
}
