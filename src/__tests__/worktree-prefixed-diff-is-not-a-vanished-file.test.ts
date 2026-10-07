/**
 * A worktree session's own file is not "a file nobody wrote" because a
 * producer spelled its diff header from the main checkout.
 *
 * Session 90eca883 turn 16 (2026-09-23) wrote git-moved-files.ts and its test
 * with the Write tool, in the linked worktree .claude/worktrees/xenodochial-…,
 * and committed them. Its row reached the server as those two files, +0/-0, no
 * diff — a files_without_content contradiction. The file list had been
 * collapsed by normalizeTurnFiles; the diff sections still read
 * `.claude/worktrees/xenodochial-…/packages/cli/…`, so dropVanishedWatchedAdds
 * looked that path up in the worktree, on disk, in HEAD and in the session's
 * commits, found it nowhere, and — the Write edits naming the unprefixed path —
 * dropped both sections as written by no tool. It did so at every Stop, from
 * the turn's first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeTurnDiff } from '../commands/hooks/stop.js';
import { dropVanishedWatchedAdds } from '../vanished-watched-files.js';

let main: string;
let wt: string;
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

const PREFIX = '.claude/worktrees/feature-x/';
const addSection = (file: string, lines: string[]) =>
  `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;

beforeEach(() => {
  main = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wt-prefix-')));
  git(main, ['init', '-q', '-b', 'main']);
  git(main, ['config', 'user.email', 'me@example.com']);
  git(main, ['config', 'user.name', 'Me']);
  git(main, ['config', 'commit.gpgsign', 'false']);
  git(main, ['config', 'core.hooksPath', path.join(main, '.git', 'no-hooks')]);
  fs.writeFileSync(path.join(main, 'base.ts'), 'base\n');
  git(main, ['add', '-A']); git(main, ['commit', '-qm', 'base']);
  wt = path.join(main, '.claude', 'worktrees', 'feature-x');
  git(main, ['worktree', 'add', '-q', '-b', 'feature-x', wt]);
});
afterEach(() => { try { fs.rmSync(main, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('normalizeTurnDiff', () => {
  it('strips our worktree prefix from the headers only', () => {
    // A line of the file that spells the very header text the rewrite looks for.
    const out = normalizeTurnDiff(addSection(`${PREFIX}src/a.ts`, ['x', `git diff a/${PREFIX}src/a.ts b/${PREFIX}src/a.ts`]), { workTree: wt });
    expect(out).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(out).toContain('+++ b/src/a.ts');
    // Content that happens to mention the prefix is not rewritten.
    expect(out).toContain(`+git diff a/${PREFIX}src/a.ts b/${PREFIX}src/a.ts`);
  });

  it('drops the prefixed twin of a section already present, and another worktree\'s section', () => {
    const diff = addSection('src/a.ts', ['one']) + addSection(`${PREFIX}src/a.ts`, ['one'])
      + addSection('.claude/worktrees/someone-else/src/b.ts', ['theirs']) + addSection('src/c.ts', ['c']);
    const out = normalizeTurnDiff(diff, { workTree: wt });
    expect(out.match(/^diff --git /gm)).toHaveLength(2);
    expect(out).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(out).toContain('diff --git a/src/c.ts b/src/c.ts');
    expect(out).not.toContain('someone-else');
  });

  it('leaves a diff with no worktree path byte for byte', () => {
    const diff = addSection('src/a.ts', ['one']);
    expect(normalizeTurnDiff(diff, { workTree: wt })).toBe(diff);
  });
});

describe('a Write-tool file in a linked worktree, diff spelled from the main checkout', () => {
  it('keeps its diff through the vanished-file pass', () => {
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'moved.ts'), 'export const x = 1;\n');
    git(wt, ['add', '-A']); git(wt, ['commit', '-qm', 'turn 16']);
    const sha = git(wt, ['rev-parse', 'HEAD']);
    const row: any = {
      promptIndex: 16,
      filesChanged: ['src/moved.ts'],
      diff: addSection(`${PREFIX}src/moved.ts`, ['export const x = 1;']),
      linesAdded: 1, linesRemoved: 0,
    };
    const edits = new Map([[16, JSON.stringify({ edits: [{ file: 'src/moved.ts', op: 'write', evidence: 'tool_call' }] })]]);

    row.diff = normalizeTurnDiff(row.diff, { workTree: wt });
    const dropped = dropVanishedWatchedAdds(wt, [row], { editsByIndex: edits, commitShas: [sha] });

    expect(dropped.size).toBe(0);
    expect(row.diff).toContain('+export const x = 1;');
    expect([row.linesAdded, row.linesRemoved]).toEqual([1, 0]);
  });

  it('reproduces the loss without the normalization', () => {
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'src', 'moved.ts'), 'export const x = 1;\n');
    git(wt, ['add', '-A']); git(wt, ['commit', '-qm', 'turn 16']);
    const sha = git(wt, ['rev-parse', 'HEAD']);
    const row: any = {
      promptIndex: 16, filesChanged: ['src/moved.ts'],
      diff: addSection(`${PREFIX}src/moved.ts`, ['export const x = 1;']), linesAdded: 1, linesRemoved: 0,
    };
    const edits = new Map([[16, JSON.stringify({ edits: [{ file: 'src/moved.ts', op: 'write', evidence: 'tool_call' }] })]]);
    dropVanishedWatchedAdds(wt, [row], { editsByIndex: edits, commitShas: [sha] });
    // The 90eca883 row: the file named, its diff gone.
    expect(row.diff).toBe('');
    expect(row.filesChanged).toEqual(['src/moved.ts']);
  });
});

// Session 9da1000f turn 16: the same change made in two sibling trees kept
// OUTSIDE `.claude/worktrees/` (scratch clones) arrived as two sections with
// the same plain repo path, and the row counted it twice (+184/-12 against
// its commits' +171/-9).
describe('normalizeTurnDiff: one section per file, whatever the path', () => {
  const sec = (f: string, idx: string, add: string) =>
    `diff --git a/${f} b/${f}\nindex ${idx}..1111111 100644\n--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,2 @@\n line\n+${add}\n`;
  const count = (d: string, f: string) => (d.match(new RegExp(`^diff --git a/${f.replace(/[.]/g, '\\.')} `, 'gm')) || []).length;

  it('drops a second plain-path section for a file already in the diff (first wins)', () => {
    const diff = sec('pkg/stop.ts', 'aaaaaaa', 'from tree one') + sec('pkg/other.ts', 'bbbbbbb', 'x') + sec('pkg/stop.ts', 'ccccccc', 'from tree two');
    const out = normalizeTurnDiff(diff, { workTree: '/repo' });
    expect(count(out, 'pkg/stop.ts')).toBe(1);
    expect(out).toContain('+from tree one');
    expect(out).not.toContain('+from tree two');
    expect(count(out, 'pkg/other.ts')).toBe(1);
  });

  // Session df8cc9aa turn 34: a commit patch joined from two branches that
  // both bumped the version. Each section is a different commit's change and
  // the row's counts sum them, so dropping one leaves the counts above the text.
  it('keeps every plain-path section of a commit patch made of several commits', () => {
    const diff = sec('package.json', 'aaaaaaa', 'branch one') + sec('a.ts', 'bbbbbbb', 'x') + sec('package.json', 'ccccccc', 'branch two');
    expect(normalizeTurnDiff(diff, { workTree: '/repo', commitPieces: true })).toBe(diff);
  });

  it('still drops another worktree\'s section from a commit patch made of several commits', () => {
    const wt = '/repo/.claude/worktrees/ours';
    const diff = sec('package.json', 'aaaaaaa', 'one') + sec('.claude/worktrees/theirs/package.json', 'ccccccc', 'theirs');
    const out = normalizeTurnDiff(diff, { workTree: wt, commitPieces: true });
    expect(count(out, 'package.json')).toBe(1);
    expect(out).not.toContain('+theirs');
  });

  it('leaves a diff with one section per file byte-for-byte as it was', () => {
    const diff = sec('a.ts', 'aaaaaaa', 'x') + sec('b.ts', 'bbbbbbb', 'y');
    expect(normalizeTurnDiff(diff, { workTree: '/repo' })).toBe(diff);
    expect(normalizeTurnDiff('', { workTree: '/repo' })).toBe('');
  });
});
