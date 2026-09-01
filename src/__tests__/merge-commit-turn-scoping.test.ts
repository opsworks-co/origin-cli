// A turn that runs `git merge` was credited with the branch it absorbed, and
// its own row stored nothing.
//
// Prod f7881a6e turn 3 ("merge the PR and deploy it") merged origin/main:
//
//   [post-commit] sending incremental update
//     {filesChanged:0, attributedPromptIdx:2, payload:[{i:2, f:0, a:84, r:20, …}]}
//   stored row: idx 2 | +0 -0 | diffLen 0
//
// Zero files with +84/-20, and those 84 lines were another PR's
// `final-state-blame.ts` and `transcript-watch.ts` — files that session never
// opened. Two independent git facts about merges caused it:
//
//   `git diff-tree --name-only <merge>`  → prints NOTHING (no single parent)
//   `git diff <merge>~1..<merge>`        → the ENTIRE absorbed branch
//   `git show <merge> --format=`         → a `--cc` combined diff, whose `@@@`
//                                          headers and `++` prefixes no parser
//                                          in this codebase reads
//
// A merge's own work is its conflict resolution: what is in it and in NEITHER
// parent. That is the intersection of the two parent diffs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mergeOwnDiff, mergeAbsorbedFiles, extractCommitDiff, commitParents } from '../history-backfill.js';

let repo: string;
const git = (...a: string[]) =>
  execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();

let mergeSha = '';
let cleanMergeSha = '';
let plainSha = '';

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-merge-'));
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'T');

  fs.writeFileSync(path.join(repo, 'version.txt'), 'v1\n');
  fs.writeFileSync(path.join(repo, 'untouched.ts'), 'export const x = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  // THEIR branch: a whole PR's worth of work this session never wrote.
  git('checkout', '-q', '-b', 'theirs');
  fs.writeFileSync(path.join(repo, 'their-feature.ts'),
    Array.from({ length: 40 }, (_, i) => `export const THEIRS_${i} = ${i};`).join('\n') + '\n');
  fs.writeFileSync(path.join(repo, 'version.txt'), 'v2-theirs\n');
  git('add', '-A'); git('commit', '-q', '-m', 'their PR');

  // OUR branch: our own work, and the same file they touched (a conflict).
  git('checkout', '-q', base);
  git('checkout', '-q', '-b', 'ours');
  fs.writeFileSync(path.join(repo, 'our-feature.ts'), 'export const OURS = 1;\n');
  fs.writeFileSync(path.join(repo, 'version.txt'), 'v2-ours\n');
  git('add', '-A'); git('commit', '-q', '-m', 'our work');
  plainSha = git('rev-parse', 'HEAD');

  // The merging turn: resolve the conflict, commit the merge.
  try { git('merge', 'theirs'); } catch { /* conflict expected */ }
  fs.writeFileSync(path.join(repo, 'version.txt'), 'v3-resolved\n');
  git('add', '-A');
  git('commit', '-q', '--no-edit');
  mergeSha = git('rev-parse', 'HEAD');

  // A second, CLEAN merge — nothing to resolve, so the turn authored nothing.
  git('checkout', '-q', '-b', 'sidecar', mergeSha);
  fs.writeFileSync(path.join(repo, 'sidecar.ts'), 'export const SIDE = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'sidecar work');
  git('checkout', '-q', 'ours');
  git('merge', '-q', '--no-ff', '--no-edit', 'sidecar');
  cleanMergeSha = git('rev-parse', 'HEAD');
});
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('a merging turn is credited with its resolution, not the branch', () => {
  it('recognises the merge', () => {
    expect(commitParents(repo, mergeSha)).toHaveLength(2);
  });

  it('reproduces the two git facts the old code trusted', () => {
    // No files…
    const names = execFileSync('git',
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', mergeSha],
      { cwd: repo, encoding: 'utf-8' }).trim();
    expect(names).toBe('');
    // …and a first-parent diff carrying the whole absorbed branch.
    const firstParent = execFileSync('git', ['diff', `${mergeSha}~1..${mergeSha}`],
      { cwd: repo, encoding: 'utf-8' });
    expect(firstParent).toContain('THEIRS_0');
  });

  it('credits only the resolved files, and never the absorbed branch', () => {
    const own = mergeOwnDiff(repo, mergeSha)!;
    expect(own.filesChanged).toEqual(['version.txt']);
    expect(own.diff).toContain('v3-resolved');
    expect(own.diff).not.toContain('THEIRS_0');
    expect(own.diff).not.toContain('OURS');
  });

  it('emits a diff the downstream parsers can actually read', () => {
    const own = mergeOwnDiff(repo, mergeSha)!;
    // `git show` on a merge emits `diff --cc` / `@@@`, which every parser here
    // silently skips — that is how the row stored +0/-0.
    expect(own.diff).toMatch(/^diff --git /m);
    expect(own.diff).not.toContain('@@@');
    const added = own.diff.split('\n').filter((l) => l[0] === '+' && !l.startsWith('+++'));
    expect(added.length).toBeGreaterThan(0);
  });

  it('gives a clean merge nothing, rather than falling back to the branch', () => {
    const own = mergeOwnDiff(repo, cleanMergeSha)!;
    expect(own.filesChanged).toEqual([]);
    expect(own.diff).toBe('');
  });

  it('leaves a non-merge commit alone', () => {
    expect(commitParents(repo, plainSha)).toHaveLength(1);
    expect(mergeOwnDiff(repo, plainSha)).toBeNull();
  });

  it('extractCommitDiff no longer reports a merge as touching zero files', () => {
    // The Commit ROW wants the first-parent view — what the merge landed on
    // this branch. What it must never be again is empty.
    const { filesChanged } = extractCommitDiff(repo, mergeSha);
    expect(filesChanged.length).toBeGreaterThan(0);
    expect(filesChanged).toContain('their-feature.ts');
  });
});

// The SESSION HEADER, which is synthesized from every turn's editsJson —
// a different surface from the per-turn commit diff, and wrong for a different
// reason: `git merge` rewrites every file it absorbs, so the shell-write
// window sees the other branch's work as writes this turn made.
//
// Prod f7881a6e read +1607/-119 while its own three commits hold +1074/-69.
// The +533/-50 difference was eight files three merges brought in.
describe('a merge’s absorbed files are not the merging turn’s writes', () => {
  it('names what the merge brought in, and never what it resolved', () => {
    const absorbed = mergeAbsorbedFiles(repo, mergeSha);
    expect(absorbed).toContain('their-feature.ts');
    expect(absorbed).not.toContain('version.txt'); // the resolution IS ours
  });

  it('is empty for a commit that is not a merge', () => {
    expect(mergeAbsorbedFiles(repo, plainSha)).toEqual([]);
  });

  it('covers every file the working tree gained from the other side', () => {
    // The exclusion has to be complete: one file left behind is one file of
    // someone else's code in this session's header.
    const absorbed = new Set(mergeAbsorbedFiles(repo, mergeSha));
    const gained = execFileSync('git', ['diff', '--name-only', `${mergeSha}~1`, mergeSha],
      { cwd: repo, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    const own = new Set(mergeOwnDiff(repo, mergeSha)!.filesChanged);
    for (const f of gained) {
      if (!own.has(f)) expect(absorbed.has(f)).toBe(true);
    }
  });
});
