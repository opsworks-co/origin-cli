/**
 * A turn that only COMMITTED must not be billed the commit's file list.
 *
 * Session 798de196 turn 2 ran `git add`, `git commit`, `git push`, `gh pr
 * create`. It authored nothing. It stored 4 files and +326/-1.
 *
 * Both halves of the defect are in one pair of hooks.log lines a millisecond
 * apart:
 *
 *   01:41:35.694  scoped commit to prompt baseline
 *                 {promptIndex:1, commitLines:"+328/-11", promptLines:"+0/-0"}
 *   01:41:35.695  sending incremental update
 *                 {payload:[{i:1, f:4, a:0, r:0, d:0, c:"30e527c5"}]}
 *
 * The scoping was RIGHT. `+0/-0` is the truth for that turn — the shadow
 * baseline already contained turn 1's uncommitted work, so the commit added
 * nothing on top of it. The payload then shipped the commit's four files beside
 * that zero.
 *
 * Why a file list alone was enough to corrupt the row: the server's per-prompt
 * merge (mcp.ts, "CONTENT UNIT") lands a non-empty `filesChanged` on its own,
 * while an empty `diff` and zero line counts are skipped in favour of whatever
 * the row already holds. So the four files grafted onto a diff and a +326/-1
 * produced by a different capture — the stored row claims four files over three
 * `diff --git` blocks, and `linesRemoved` is 1 where its own diff recounts to 9.
 *
 * #1332 fixed this class for the LINE COUNTS (diff from the turn's shadow
 * rather than `git show`, which renders against the parent) and for the
 * transcript watcher's file list. The post-commit producer kept seeding
 * `filesChanged` from the commit. This is that producer.
 *
 * Driven against REAL git. The thing under test is whether a shadow baseline
 * taken mid-turn actually subtracts an earlier turn's uncommitted work from a
 * commit — that is a property of git's tree comparison, and a stubbed git would
 * only test the stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { filesNamedInDiff, commitTurnContentUnit } from '../commands/hooks.js';
import { createShadowCommit, commitDiffScopedToPrompt } from '../git-capture.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-commit-turn-files-'));
  git('init', '-q', '-b', 'main');
  // A fixture identity — a global gitconfig must not decide whether this passes.
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('README.md', 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/**
 * The 798de196 shape: turn 1 authors and leaves everything uncommitted, turn 2
 * starts (shadow taken here), turn 2 commits and writes nothing of its own.
 */
function turn1AuthorsTurn2Commits() {
  write('src/memory.ts', ['a', 'b', 'c', 'd'].join('\n') + '\n');
  write('src/__tests__/memory.test.ts', ['t1', 't2', 't3'].join('\n') + '\n');
  write('package.json', '{"version":"0.1.1"}\n');
  // Turn 2 begins: the baseline shadow captures the tree as turn 2 found it,
  // turn 1's uncommitted work included.
  const shadowSha = createShadowCommit(repo, 'turn2')!;
  git('add', '-A'); git('commit', '-qm', 'fix: turn 1 work, committed by turn 2');
  return { shadowSha, commitSha: git('rev-parse', 'HEAD') };
}

const commitFiles = () =>
  git('show', '--no-renames', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();

describe('a turn that only committed', () => {
  it('is scoped to +0/-0 — the baseline already held the work', () => {
    const { shadowSha, commitSha } = turn1AuthorsTurn2Commits();
    const scoped = commitDiffScopedToPrompt(repo, shadowSha, commitSha, commitFiles());
    expect(scoped).not.toBeNull();
    expect([scoped!.linesAdded, scoped!.linesRemoved]).toEqual([0, 0]);
  });

  it('the commit really does carry the files — so the list has to be refused, not absent', () => {
    // Guards the test itself: if the commit were empty the assertion below
    // would pass for the wrong reason.
    const { commitSha } = turn1AuthorsTurn2Commits();
    expect(commitFiles()).toEqual(['package.json', 'src/__tests__/memory.test.ts', 'src/memory.ts']);
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('sends NO files — the PAYLOAD the hook builds, not just its ingredients', () => {
    // THE REGRESSION TEST. The old code was `filesChanged: turnFiles`, which
    // shipped all three of these next to a:0/r:0/d:0 — so this assertion is the
    // one that fails on the pre-fix source. An empty list is what lets the
    // server skip the field and leave the chat-only turn alone.
    const { shadowSha, commitSha } = turn1AuthorsTurn2Commits();
    const files = commitFiles();
    const scoped = commitDiffScopedToPrompt(repo, shadowSha, commitSha, files);

    const unit = commitTurnContentUnit(scoped, files, 'IGNORED — the commit-vs-parent diff');
    expect(unit.filesChanged).toEqual([]);
    expect(unit.diff).toBe('');
    expect([unit.linesAdded, unit.linesRemoved]).toEqual([0, 0]);
  });
});

describe('a turn that authored some of what it committed', () => {
  it('is billed its own files only, never the whole commit', () => {
    // Turn 1 leaves two files dirty; turn 2 adds a third and commits all three.
    write('src/memory.ts', 'a\nb\n');
    write('src/__tests__/memory.test.ts', 't1\n');
    const shadowSha = createShadowCommit(repo, 'turn2')!;
    write('src/late.ts', 'late1\nlate2\n');
    git('add', '-A'); git('commit', '-qm', 'fix: two turns of work');
    const commitSha = git('rev-parse', 'HEAD');

    const scoped = commitDiffScopedToPrompt(repo, shadowSha, commitSha, commitFiles());
    expect(filesNamedInDiff(scoped!.diff)).toEqual(['src/late.ts']);
    expect(scoped!.linesAdded).toBe(2);
    // The commit itself carries all three — the whole point is that the turn
    // does not inherit that list.
    expect(commitFiles()).toHaveLength(3);
  });

  it('keeps the files and the line counts describing the SAME diff', () => {
    write('a.txt', 'one\n');
    const shadowSha = createShadowCommit(repo, 'turn2')!;
    write('b.txt', 'two\nthree\n');
    git('add', '-A'); git('commit', '-qm', 'both');
    const scoped = commitDiffScopedToPrompt(repo, shadowSha, git('rev-parse', 'HEAD'), commitFiles())!;
    const files = filesNamedInDiff(scoped.diff);
    // The invariant the row violated: 4 files over 3 diff blocks. Whatever the
    // list says, the diff must name exactly those paths.
    expect(files).toEqual(['b.txt']);
    expect(scoped.diff.match(/^diff --git /gm)!).toHaveLength(files.length);
  });
});

describe('commitTurnContentUnit', () => {
  it('falls back to the commit’s own view when the commit cannot be scoped', () => {
    // A merge, or no usable baseline. `scoped` is null and the commit's view is
    // all there is — the pre-#1332 behaviour, deliberately preserved.
    const turnDiff = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n+extra';
    const unit = commitTurnContentUnit(null, ['x.ts', 'y.ts'], turnDiff);
    expect(unit.filesChanged).toEqual(['x.ts', 'y.ts']);
    expect(unit.diff).toBe(turnDiff);
    expect([unit.linesAdded, unit.linesRemoved]).toEqual([2, 1]);
  });

  it('never lets the file list outrun the diff it ships', () => {
    // The stored-row shape being prevented: 4 files over 3 diff blocks.
    const scoped = {
      diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n+one',
      linesAdded: 1, linesRemoved: 0,
    };
    const unit = commitTurnContentUnit(scoped, ['a.ts', 'b.ts', 'c.ts', 'd.ts'], 'unused');
    expect(unit.filesChanged).toEqual(['a.ts']);
    expect(unit.diff.match(/^diff --git /gm)!).toHaveLength(unit.filesChanged.length);
  });

  it('keeps the counts the scoping produced, not a recount of the commit', () => {
    const scoped = { diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n+one', linesAdded: 1, linesRemoved: 0 };
    const unit = commitTurnContentUnit(scoped, ['a.ts'], 'diff --git a/z.ts b/z.ts\n+1\n+2\n+3');
    expect([unit.linesAdded, unit.linesRemoved]).toEqual([1, 0]);
  });
});

describe('filesNamedInDiff', () => {
  it('names every file a diff describes, in order', () => {
    const diff = [
      'diff --git a/packages/cli/package.json b/packages/cli/package.json',
      '@@ -1 +1 @@', '-old', '+new',
      'diff --git a/src/memory.ts b/src/memory.ts',
      '@@ -1 +1 @@', '+x',
    ].join('\n');
    expect(filesNamedInDiff(diff)).toEqual(['packages/cli/package.json', 'src/memory.ts']);
  });

  it('is empty for an empty diff — the case that makes the server skip the field', () => {
    expect(filesNamedInDiff('')).toEqual([]);
    expect(filesNamedInDiff(null)).toEqual([]);
    expect(filesNamedInDiff(undefined)).toEqual([]);
  });

  it('de-duplicates a path a spliced diff names twice', () => {
    const diff = [
      'diff --git a/src/memory.ts b/src/memory.ts', '@@ -1 +1 @@', '+x',
      'diff --git a/src/memory.ts b/src/memory.ts', '@@ -9 +9 @@', '+y',
    ].join('\n');
    expect(filesNamedInDiff(diff)).toEqual(['src/memory.ts']);
  });

  it('handles paths with spaces', () => {
    const diff = 'diff --git a/docs/my notes.md b/docs/my notes.md\n@@ -1 +1 @@\n+x';
    expect(filesNamedInDiff(diff)).toEqual(['docs/my notes.md']);
  });
});
