/**
 * Line counts come from numstat, so the diff-text cap cannot shrink them.
 *
 * Commit 7f310b6b (683KB of patch) was recorded as +1561/-892 for git's
 * +1959/-1249, and its session header as +1612/-927 over a 146-file range:
 * both counted `+`/`-` lines of a diff that had been cut at MAX_DIFF_SIZE.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { captureGitState, commitDiffScopedToPrompt, commitLineCounts, createShadowCommit, numstatTotals } from '../git-capture.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

// 30k lines × ~25 bytes ≈ 750KB: past the 500KB text cap on its own.
const BIG = Array.from({ length: 30_000 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-numstat-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('README.md', '# r\n');
  git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

describe('commitLineCounts', () => {
  it('reports git\'s totals for a commit whose patch exceeds the text cap', () => {
    write('big.ts', BIG); write('small.ts', 'x\n');
    git('add', '-A'); git('commit', '-qm', 'big');
    expect(commitLineCounts(repo, git('rev-parse', 'HEAD'))).toEqual({ added: 30_001, removed: 0 });
  });

  it('skips the files the diff layer strips (a lockfile), like the text count did', () => {
    write('package-lock.json', Array.from({ length: 500 }, (_, i) => `"dep${i}": "1.0.0",`).join('\n') + '\n');
    write('app.ts', 'a\nb\n');
    git('add', '-A'); git('commit', '-qm', 'lock');
    expect(commitLineCounts(repo, git('rev-parse', 'HEAD'))).toEqual({ added: 2, removed: 0 });
  });

  it('counts a merge by its resolution, not zero and not the absorbed branch', () => {
    const base = git('rev-parse', 'HEAD');
    // THEIR branch: a whole PR's worth of work, plus the file we will conflict on.
    git('checkout', '-q', '-b', 'theirs');
    write('their-feature.ts', Array.from({ length: 40 }, (_, i) => `export const THEIRS_${i} = ${i};`).join('\n') + '\n');
    write('version.txt', 'v2-theirs\n');
    git('add', '-A'); git('commit', '-qm', 'their PR');
    // OUR branch: one line of our own and the other side of the conflict.
    git('checkout', '-q', base); git('checkout', '-q', '-b', 'ours');
    write('our-feature.ts', 'export const OURS = 1;\n');
    write('version.txt', 'v2-ours\n');
    git('add', '-A'); git('commit', '-qm', 'our work');
    // Merge theirs into ours and resolve the conflict with a line neither side had.
    try { git('merge', '--no-edit', 'theirs'); } catch { /* conflict expected */ }
    write('version.txt', 'v3-resolved\n');
    git('add', '-A'); git('-c', 'core.editor=true', 'commit', '-qm', 'merge theirs');
    const merge = git('rev-parse', 'HEAD');
    expect(git('rev-list', '--parents', '-n', '1', merge).split(' ')).toHaveLength(3);

    // Bare diff-tree prints NOTHING for a merge; that used to read as +0/-0.
    // The first-parent view would be their 40-line feature. The resolution is
    // the one line of version.txt that is in neither parent.
    expect(commitLineCounts(repo, merge)).toEqual({ added: 1, removed: 1 });
  });

  it('returns null, not zero, when git cannot answer', () => {
    expect(commitLineCounts(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull();
    expect(numstatTotals(['diff', '--numstat', 'nope..nope'], { cwd: repo, timeoutMs: 5_000, maxBuffer: 1024 * 1024 })).toBeNull();
  });
});

describe('captureGitState line totals', () => {
  it('counts the whole committed range even when the diff text was truncated', () => {
    const before = git('rev-parse', 'HEAD');
    write('big.ts', BIG);
    git('add', '-A'); git('commit', '-qm', 'big');
    const cap = captureGitState(repo, before);
    expect(cap.diffTruncated).toBe(true);
    expect([cap.linesAdded, cap.linesRemoved]).toEqual([30_000, 0]);
  });

  it('counts uncommitted and untracked work the same way', () => {
    const before = git('rev-parse', 'HEAD');
    write('README.md', '# r\nmore\n');
    write('new.ts', 'n1\nn2\nn3\n');
    const cap = captureGitState(repo, before);
    expect([cap.linesAdded, cap.linesRemoved]).toEqual([4, 0]);
  });
});

describe('commitDiffScopedToPrompt', () => {
  it('names every file and counts every line when the text has to be cut', () => {
    const before = git('rev-parse', 'HEAD');
    // Three ~200KB files: each fits the 500KB cap alone, together they do not.
    const MID = Array.from({ length: 8_000 }, (_, i) => `export const w${i} = ${i};`).join('\n') + '\n';
    write('one.ts', MID); write('two.ts', MID); write('three.ts', MID);
    git('add', '-A'); git('commit', '-qm', 'three big files');
    const sha = git('rev-parse', 'HEAD');
    const scoped = commitDiffScopedToPrompt(repo, before, sha, ['one.ts', 'two.ts', 'three.ts'])!;
    expect(scoped.diffTruncated).toBe(true);
    expect(scoped.files.sort()).toEqual(['one.ts', 'three.ts', 'two.ts']);
    expect([scoped.linesAdded, scoped.linesRemoved]).toEqual([24_000, 0]);
    // What text survives is whole sections that still parse — two of the three.
    expect(scoped.diff.startsWith('diff --git ')).toBe(true);
    expect(scoped.diff.length).toBeLessThanOrEqual(500_000);
    expect((scoped.diff.match(/^diff --git /gm) || []).length).toBe(2);
  });

  it('keeps full-file context when the patch is small', () => {
    const before = git('rev-parse', 'HEAD');
    write('README.md', '# r\nmore\n');
    git('add', '-A'); git('commit', '-qm', 'small');
    const scoped = commitDiffScopedToPrompt(repo, before, git('rev-parse', 'HEAD'), ['README.md'])!;
    expect(scoped.diffTruncated).toBe(false);
    expect(scoped.files).toEqual(['README.md']);
    expect([scoped.linesAdded, scoped.linesRemoved]).toEqual([1, 0]);
    expect(scoped.diff).toContain('@@ -1 +1,2 @@');
  });
});

describe('a committed turn whose patch text had to be cut', () => {
  it('names the cut files as content-unavailable so the row stays whole', () => {
    const baseline = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
    const MID = Array.from({ length: 8_000 }, (_, i) => `export const w${i} = ${i};`).join('\n') + '\n';
    write('one.ts', MID); write('two.ts', MID); write('three.ts', MID);
    git('add', '-A'); git('commit', '-qm', 'three big files');
    const sha = git('rev-parse', 'HEAD');
    const state = { promptTurnIds: ['t_0'], commitTurns: [{ sha, turnId: 't_0' }], promptShadows: [{ promptIndex: 0, shadowSha: baseline }] };
    const mapping: { promptIndex: number; filesChanged: string[]; diff: string; linesAdded: number; linesRemoved: number; contentUnavailableFiles?: string[] } = {
      promptIndex: 0, filesChanged: ['one.ts'], diff: 'diff --git a/one.ts b/one.ts\n+x\n', linesAdded: 1, linesRemoved: 0,
      contentUnavailableFiles: ['stale-from-the-journal.ts'],
    };
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect([...mapping.filesChanged].sort()).toEqual(['one.ts', 'three.ts', 'two.ts']);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([24_000, 0]);
    // Two sections fit; the third file is named, not lost — and the stale
    // journal entry is gone.
    expect(mapping.contentUnavailableFiles).toHaveLength(1);
    expect(mapping.filesChanged).toContain(mapping.contentUnavailableFiles![0]);
    expect(mapping.diff).not.toContain(`diff --git a/${mapping.contentUnavailableFiles![0]}`);
  });
});
