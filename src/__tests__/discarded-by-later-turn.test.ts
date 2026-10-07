/**
 * An earlier turn's uncommitted work that a LATER turn threw away reads
 * "discarded", not "uncommitted".
 *
 * Session 7ba816a4 (2026-10-01): every turn edited Landing.tsx, none
 * committed until the end; turn 3 and turn 7 each ran
 * `git checkout HEAD -- Landing.tsx`. Turns 1–6 read "uncommitted" while none
 * of their lines existed in the tree, a commit or a stash.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  distinctiveAddedLines, heldRevsFromGit, laterDiscardVerdict, markWorkDiscardedByLaterTurns, startBasesFromGit,
  type LaterDiscardDeps, type LaterDiscardRow,
} from '../discarded-by-later-turn.js';

const base = 'export function a() {\n  return 1;\n}\n';
const turnA = base + 'export const heroLine = "Make AI-generated code maintainable";\nexport const subLine = "Session history and blame";\n';

describe('distinctiveAddedLines', () => {
  it('keeps the lines the turn added and drops punctuation-only lines', () => {
    const lines = distinctiveAddedLines(base, base + '}\n</div>\nconst featureFlag = true;\n');
    expect([...lines]).toEqual(['const featureFlag = true;']);
  });

  it('a line already in the start file is not the turn\'s own', () => {
    expect(distinctiveAddedLines(base, base + 'export function a() {\n').size).toBe(0);
  });

  it('whitespace does not make a line new', () => {
    expect(distinctiveAddedLines('const featureFlag = true;\n', '    const   featureFlag = true;\n').size).toBe(0);
  });
});

describe('laterDiscardVerdict', () => {
  it('none of the turn\'s lines in the tree or anywhere held → gone', () => {
    expect(laterDiscardVerdict({ before: base, after: turnA, now: base + 'const other = 2;\n', held: [] })).toBe('gone');
  });

  it('the file dirty again with OTHER work is still gone (content, not dirtiness)', () => {
    const now = base + 'export const newSection = "something else entirely";\n';
    expect(laterDiscardVerdict({ before: base, after: turnA, now, held: [] })).toBe('gone');
  });

  it('a later turn that refined the work (one line kept) → survives', () => {
    const now = base + 'export const heroLine = "Make AI-generated code maintainable";\nexport const subLine = "rewritten";\n';
    expect(laterDiscardVerdict({ before: base, after: turnA, now, held: [] })).toBe('survives');
  });

  it('a commit made since holds the lines → survives', () => {
    expect(laterDiscardVerdict({ before: base, after: turnA, now: base, held: [turnA] })).toBe('survives');
  });

  it('lines a turn PUT BACK from the commit are no evidence (7ba816a4 row 2)', () => {
    // The start was dirty with an earlier launch's rewrite; the turn restored
    // the committed original and added one line of its own.
    const committed = base + 'export const original = "the committed hero";\n';
    const dirtyStart = 'export const rewrite = "an earlier turn\'s rewrite";\n';
    const after = committed + 'export const ownSection = "added by this turn";\n';
    // Later: checked out to the commit again.
    expect(laterDiscardVerdict({ before: dirtyStart, after, now: committed, held: [] })).toBe('survives');
    expect(laterDiscardVerdict({ before: dirtyStart, base: committed, after, now: committed, held: [] })).toBe('gone');
  });

  it('unknown when the file is gone from the tree (a move reads like a delete)', () => {
    expect(laterDiscardVerdict({ before: base, after: turnA, now: null, held: [] })).toBe('unknown');
  });

  it('unknown when the end state cannot be read', () => {
    expect(laterDiscardVerdict({ before: base, after: null, now: base, held: [] })).toBe('unknown');
  });

  // Session df8cc9aa turn 9 took a fix back out of five files (−306) to run a
  // control, and turn 10 put every line back and committed it.
  it('a removal a later turn put back → gone', () => {
    expect(laterDiscardVerdict({ before: turnA, after: base, now: turnA, held: [turnA] })).toBe('gone');
  });

  it('a removal still in the tree → survives', () => {
    expect(laterDiscardVerdict({ before: turnA, after: base, now: base, held: [] })).toBe('survives');
  });

  it('a removal a commit made since holds → survives, even once the lines are back', () => {
    expect(laterDiscardVerdict({ before: turnA, after: base, now: turnA, held: [base] })).toBe('survives');
  });

  it('a deleted file a later turn restored → gone, but only when git confirms the delete', () => {
    expect(laterDiscardVerdict({ before: turnA, after: null, deletedAtEnd: true, now: turnA, held: [] })).toBe('gone');
    expect(laterDiscardVerdict({ before: turnA, after: null, now: turnA, held: [] })).toBe('unknown');
  });

  it('a turn that added lines and removed others: gone only when both are undone', () => {
    const edited = base.replace('return 1;', 'return compute();') + 'export const flagEnabled = true;\n';
    const before = base.replace('return 1;', 'return previousValue();');
    expect(laterDiscardVerdict({ before, after: edited, now: before, held: [] })).toBe('gone');
    expect(laterDiscardVerdict({ before, after: edited, now: edited, held: [] })).toBe('survives');
  });
});

describe('markWorkDiscardedByLaterTurns', () => {
  const F = 'src/Landing.tsx';
  const revs: Record<string, Record<string, string>> = {
    s0: { [F]: base }, e0: { [F]: turnA },
    s1: { [F]: turnA }, e1: { [F]: base + 'export const section = "new section from turn one";\n' },
    // The commit both start shadows stood on (startBases below).
    c0: { [F]: base },
  };
  const deps = (over: Partial<LaterDiscardDeps> = {}): LaterDiscardDeps => ({
    localTurn: (row) => row,
    window: (local) => (local <= 1 ? { start: `s${local}`, end: `e${local}` } : null),
    turnCommitted: () => false,
    readAtRev: (rev, file) => revs[rev]?.[file] ?? null,
    readNow: () => base + 'export const paragraph = "the one that was committed";\n',
    heldRevs: () => [],
    // Shadows stand on a commit, as every real Stop passes: turn 1's start
    // carried turn 0's uncommitted lines, which it then rewrote.
    startBases: (starts) => new Map(starts.map((st) => [st, 'c0'])),
    ...over,
  });
  const rows = (): LaterDiscardRow[] => [
    { promptIndex: 0, filesChanged: [F], discardedFiles: [] },
    { promptIndex: 1, filesChanged: [F], discardedFiles: [] },
    { promptIndex: 2, filesChanged: [F], discardedFiles: [] },
  ];

  it('marks every earlier turn whose lines are gone, and leaves the closing turn alone', () => {
    const r = rows();
    expect(markWorkDiscardedByLaterTurns(r, 2, deps())).toBe(2);
    expect(r.map((x) => x.discardedFiles)).toEqual([[F], [F], []]);
  });

  it('touches only discardedFiles — never files, diff or counts', () => {
    const r: LaterDiscardRow[] = [{ promptIndex: 0, filesChanged: [F], discardedFiles: [], diff: 'D', linesAdded: 2 } as any];
    markWorkDiscardedByLaterTurns(r, 1, deps());
    expect(r[0]).toEqual({ promptIndex: 0, filesChanged: [F], discardedFiles: [F], diff: 'D', linesAdded: 2 });
  });

  it('adds to the turn\'s own verdict rather than replacing it', () => {
    const r: LaterDiscardRow[] = [{ promptIndex: 0, filesChanged: [F, 'b.ts'], discardedFiles: ['b.ts'] }];
    markWorkDiscardedByLaterTurns(r, 1, deps());
    expect(r[0].discardedFiles).toEqual(['b.ts', F]);
  });

  it('a committed turn is never considered — stamped sha, commit patch, or attestation', () => {
    const r: LaterDiscardRow[] = [
      { promptIndex: 0, filesChanged: [F], commitSha: 'abc1234' },
      { promptIndex: 1, filesChanged: [F] },
    ];
    expect(markWorkDiscardedByLaterTurns(r, 2, deps({ turnCommitted: (l) => l === 1 }))).toBe(0);
    expect(r[0].discardedFiles).toBeUndefined();
    expect(r[1].discardedFiles).toBeUndefined();
  });

  it('a turn whose lines a commit since holds stays uncommitted', () => {
    const r = rows();
    revs.c1 = { [F]: turnA };
    markWorkDiscardedByLaterTurns(r, 2, deps({ heldRevs: () => ['c1'] }));
    expect(r[0].discardedFiles).toEqual([]);
  });

  it('decides nothing when the held versions are unknown', () => {
    const r = rows();
    expect(markWorkDiscardedByLaterTurns(r, 2, deps({ heldRevs: () => null }))).toBe(0);
    expect(markWorkDiscardedByLaterTurns(r, 2, deps({ heldRevs: () => { throw new Error('git'); } }))).toBe(0);
  });

  it('decides nothing for a turn without both shadows, or a row from before this launch', () => {
    const r = rows();
    expect(markWorkDiscardedByLaterTurns(r, 2, deps({ window: () => null }))).toBe(0);
    expect(markWorkDiscardedByLaterTurns(r, 2, deps({ localTurn: () => null }))).toBe(0);
  });
});

describe('heldRevsFromGit', () => {
  let repo = '';
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'later-discard-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
  });
  afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it('lists commits since the start that touch the files, and stashes made since', () => {
    const start = git('rev-parse', 'HEAD');
    expect(heldRevsFromGit(repo, start, ['a.txt'])).toEqual([]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    git('commit', '-q', '-am', 'two');
    const c = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'other\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'unrelated');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
    git('stash', '-q');
    const s = git('rev-parse', 'refs/stash');
    expect(heldRevsFromGit(repo, start, ['a.txt'])).toEqual([c, s]);
  });

  it('startBasesFromGit: a shadow maps to the commit it stood on, a real commit to itself', () => {
    const head = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const shadow = execFileSync('git', ['commit-tree', tree, '-p', head, '-m', 'origin shadow tag 2026-10-01'], { cwd: repo, encoding: 'utf-8' }).trim();
    const bases = startBasesFromGit(repo, [shadow, head]);
    expect(bases.get(shadow)).toBe(head);
    expect(bases.get(head)).toBe(head);
  });

  it('null when git cannot answer', () => {
    expect(heldRevsFromGit(path.join(repo, 'nope'), 'abcdef1', ['a.txt'])).toBeNull();
    expect(heldRevsFromGit(repo, 'not-a-sha', ['a.txt'])).toBeNull();
  });
});
