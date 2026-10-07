// Files a tree-moving git command put in place — git's, not the turn's.
//
// Origin TODO e87a35d5: a turn that ran `git pull` (or checkout, merge, …) was
// billed the files that came down. The write journal sees bytes land and
// cannot say who landed them, and six attempts to work that out AFTER the fact
// (from content, from clocks, from commit ranges at Stop) each dropped real
// work somewhere. This records it AT the command instead, from two facts the
// shell probe already brackets the command with:
//
//   1. touchedSince(before, after) — dirty files whose stamps changed.
//   2. the files that differ between HEAD before and HEAD after.
//
// (2) is the half the earlier design (5ef1cb12) missed: a file a pull brings
// down ends CLEAN, so a probe of dirty files never sees it — and that is the
// live repro (6b770703 turn 29). `git diff --name-only -z --no-renames A B` is
// tree-to-tree, so merges, renames, quoted paths and new directories all come
// out as plain paths — the cases that sank the content-inference attempt.
//
// The set is used to drop files from the JOURNAL channel only. A turn that
// edited f.py, committed and then pulled keeps f.py through its edit-hook
// evidence; that edit → commit → pull shape is what killed the ORIG_HEAD fence.
//
// Known limit: an agent write to a file the same command also moves is
// credited to git.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { stripHeredocBodies } from './shell-write-capture.js';

/**
 * Commands that move the working tree to another commit's content.
 *
 * `gh` too: `gh pr merge --delete-branch` checks out the default branch and
 * pulls it, `gh pr checkout` checks a PR out, `gh repo sync` fast-forwards —
 * all through git, none spelled `git`. Session 24e45142 turns 8 and 11 each
 * ran `gh pr merge --squash --delete-branch` and were billed what the pull
 * brought down (+266 and +482 lines of other work).
 */
const TREE_MOVING = /(^|[;&|(])\s*(?:git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(checkout|switch|pull|merge|rebase|reset|stash)\b|gh\s+(?:(?:-R|--repo)\s+\S+\s+)*(?:pr\s+(?:merge|checkout)|repo\s+sync)\b)/m;

export function commandMovesTree(command: string): boolean {
  return TREE_MOVING.test(stripHeredocBodies(String(command || '')));
}

/** Repo-relative files that differ between two commits, or [] when either is unknown. */
export function filesChangedBetween(tree: string, before?: string | null, after?: string | null): string[] {
  if (!tree || !before || !after || before === after) return [];
  try {
    const out = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', before, after], {
      cwd: tree, windowsHide: true, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/** Where a worktree's HEAD reflog ends right now — taken before a command runs. */
export type ReflogMark = { path: string; size: number };

/**
 * Mark the end of `tree`'s HEAD reflog. A linked worktree keeps its own HEAD
 * log in its gitdir (`git rev-parse --git-path` resolves it), so a sibling
 * worktree's moves never appear in it. Null when there is no log to mark.
 */
export function markReflog(tree: string): ReflogMark | null {
  if (!tree) return null;
  try {
    const rel = execFileSync('git', ['rev-parse', '--git-path', 'logs/HEAD'], {
      cwd: tree, windowsHide: true, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const p = path.resolve(tree, rel);
    return { path: p, size: fs.existsSync(p) ? fs.statSync(p).size : 0 };
  } catch {
    return null;
  }
}

/**
 * The HEADs a command moved `tree` through, oldest first: the reflog lines
 * appended since `mark`. By byte offset, not time — reflog stamps are whole
 * seconds, and a command that ends on the commit it started from (a PR merged
 * as the head it was on) cannot be told apart by sha either.
 */
export function headsSinceMark(mark?: ReflogMark | null): string[] {
  if (!mark) return [];
  try {
    const size = fs.statSync(mark.path).size;
    if (size <= mark.size) return []; // nothing appended — or the log was rewritten
    const fd = fs.openSync(mark.path, 'r');
    try {
      const buf = Buffer.alloc(size - mark.size);
      fs.readSync(fd, buf, 0, buf.length, mark.size);
      const heads: string[] = [];
      for (const line of buf.toString('utf-8').split('\n')) {
        const m = line.match(/^[0-9a-f]{40} ([0-9a-f]{40}) /);
        if (m) heads.push(m[1]);
      }
      return heads;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/**
 * Every file a tree-moving command rewrote, step by step: the union of what
 * differs between each consecutive HEAD it passed through, not just between
 * the first and the last.
 *
 * The two ends are not enough. `gh pr merge --delete-branch` from a PR branch
 * checked out a STALE local main (reverting files the branch already had),
 * then pulled them back: end to end those files are identical, so
 * before→after names none of them — yet the journal saw each rewritten twice
 * and billed the turn for the whole difference (24e45142 turn 11: +482 of two
 * other sessions' commits).
 */
export function filesMovedByCommand(tree: string, before?: string | null, after?: string | null, mark?: ReflogMark | null): string[] {
  const chain = [before, ...headsSinceMark(mark), after].filter((h): h is string => !!h);
  const steps = chain.filter((h, i) => i === 0 || h !== chain[i - 1]);
  const files = new Set<string>();
  for (let i = 1; i < steps.length; i++) {
    for (const f of filesChangedBetween(tree, steps[i - 1], steps[i])) files.add(f);
  }
  return [...files];
}

export type GitMovedState = {
  gitMovedFilesByTurn?: Array<{ promptIndex: number; tree: string; files: string[] }>;
};

const MAX_FILES_PER_TURN = 2000;
const MAX_TURNS_KEPT = 32;

const sameTree = (a: string, b: string) => path.resolve(a) === path.resolve(b);

/** Add `files` to what git moved in `tree` during LOCAL turn `promptIndex`. */
export function recordGitMovedFiles(state: GitMovedState, promptIndex: number, tree: string, files: Iterable<string>): void {
  const add = [...files].map((f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  if (!tree || add.length === 0 || !Number.isInteger(promptIndex) || promptIndex < 0) return;
  const all = state.gitMovedFilesByTurn || [];
  const prev = all.find((e) => e.promptIndex === promptIndex && sameTree(e.tree, tree));
  const rest = all.filter((e) => e !== prev);
  const merged = [...new Set([...(prev?.files || []), ...add])].slice(0, MAX_FILES_PER_TURN);
  state.gitMovedFilesByTurn = [...rest, { promptIndex, tree, files: merged }].slice(-MAX_TURNS_KEPT);
}

/** What git moved in `tree` during LOCAL turn `promptIndex`. */
export function gitMovedFilesForTurn(state: GitMovedState, promptIndex: number | null | undefined, tree: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (promptIndex == null || !tree) return out;
  for (const e of state.gitMovedFilesByTurn || []) {
    if (e.promptIndex === promptIndex && sameTree(e.tree, tree)) for (const f of e.files) out.add(f);
  }
  return out;
}
