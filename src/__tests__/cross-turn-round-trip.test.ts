// Session df8cc9aa: turn 8 wrote a fix, turn 9 moved it off the tree to prove
// the test failed without it, turn 10 (a prompt that arrived mid-work) put it
// back and committed. Rows 9 and 10 each carried the whole change.
import { describe, it, expect } from 'vitest';
import { dropCrossTurnRoundTrips } from '../cross-turn-round-trip.js';

const sec = (f: string, add: number, del: number) =>
  `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1,${del} +1,${add} @@\n`
  + `${'-old\n'.repeat(del)}${'+new\n'.repeat(add)}`;

function row(promptIndex: number, sections: Array<[string, number, number]>) {
  return {
    promptIndex,
    filesChanged: sections.map(([f]) => f),
    diff: sections.map(([f, a, d]) => sec(f, a, d)).join(''),
    uncommittedDiff: '',
    linesAdded: sections.reduce((n, [, a]) => n + a, 0),
    linesRemoved: sections.reduce((n, [, , d]) => n + d, 0),
  } as any;
}

/**
 * Turns 0..n-1. `trees[k]` is the tree at turn k's start; `trees[n]` the end
 * of the last turn (the live tree when `liveEnd`). Each tree maps file → blob.
 */
function world(trees: Array<Record<string, string>>, opts: { liveEnd?: boolean } = {}) {
  const n = trees.length - 1;
  const sha = (k: number) => `tree${k}`;
  const state = {
    promptIndexBase: 0,
    prompts: Array.from({ length: n }, (_, k) => `prompt ${k}`),
    promptShadows: Array.from({ length: n }, (_, k) => ({ promptIndex: k, shadowSha: sha(k) })),
    turnEndShadows: Array.from({ length: opts.liveEnd ? n - 1 : n }, (_, k) => ({
      promptIndex: k, shadowSha: sha(k + 1), capturedAt: '2026-10-01T00:00:00Z',
    })),
  };
  const blobs = (s: string | null, files: string[]) => {
    const k = s === null ? n : Number(s.replace('tree', ''));
    return new Map(files.map((f) => [f, trees[k][f] ?? '']));
  };
  return { state, blobs };
}

describe('dropCrossTurnRoundTrips', () => {
  it('a change one turn took off and the next put back leaves both rows; the turn that wrote it keeps it', () => {
    // fix.ts: base → FIX (turn 0) → base (turn 1) → FIX (turn 2); turn 2 also bumps package.json.
    const { state, blobs } = world([
      { 'fix.ts': 'base', 'package.json': 'v1' },
      { 'fix.ts': 'FIX', 'package.json': 'v1' },
      { 'fix.ts': 'base', 'package.json': 'v1' },
      { 'fix.ts': 'FIX', 'package.json': 'v2' },
    ]);
    const rows = [
      row(0, [['fix.ts', 300, 7]]),
      row(1, [['fix.ts', 6, 300]]),
      row(2, [['fix.ts', 300, 6], ['package.json', 1, 1]]),
    ];
    expect(dropCrossTurnRoundTrips(state, rows, { blobs })).toBe(2);
    expect([rows[0].linesAdded, rows[0].linesRemoved, rows[0].filesChanged]).toEqual([300, 7, ['fix.ts']]);
    expect([rows[1].linesAdded, rows[1].linesRemoved, rows[1].filesChanged]).toEqual([0, 0, []]);
    expect(rows[1].chatOnly).toBe(true);
    expect([rows[2].linesAdded, rows[2].linesRemoved, rows[2].filesChanged]).toEqual([1, 1, ['package.json']]);
    expect(rows[2].diff).not.toContain('fix.ts');
    expect(rows[1].contentAuthoritative && rows[2].contentAuthoritative).toBe(true);
    expect(rows[2].inheritedFiles).toEqual(['fix.ts']);
  });

  it('a later Stop that rebuilds the restoring row drops the files again, though the moving row is already empty', () => {
    const { state, blobs } = world([
      { 'fix.ts': 'base', 'package.json': 'v1' },
      { 'fix.ts': 'FIX', 'package.json': 'v1' },
      { 'fix.ts': 'base', 'package.json': 'v1' },
      { 'fix.ts': 'FIX', 'package.json': 'v2' },
    ]);
    const emptied = { ...row(1, []), chatOnly: true, contentAuthoritative: true };
    const rows = [row(0, [['fix.ts', 300, 7]]), emptied, row(2, [['fix.ts', 300, 6], ['package.json', 1, 1]])];
    expect(dropCrossTurnRoundTrips(state, rows, { blobs })).toBe(1);
    expect(rows[2].filesChanged).toEqual(['package.json']);
    expect(rows[1].inheritedFiles).toBeUndefined();
  });

  it('a later turn reverting a turn\'s NEW work is left alone — that is discarded work, not a put-back', () => {
    const { state, blobs } = world([
      { 'fix.ts': 'base' },
      { 'fix.ts': 'FIX' },
      { 'fix.ts': 'base' },
    ]);
    const rows = [row(0, [['fix.ts', 300, 7]]), row(1, [['fix.ts', 7, 300]])];
    expect(dropCrossTurnRoundTrips(state, rows, { blobs })).toBe(0);
    expect(rows[0].linesAdded).toBe(300);
    expect(rows[1].linesRemoved).toBe(300);
  });

  it('a put-back that does not restore the exact bytes stays on both rows', () => {
    const { state, blobs } = world([
      { 'fix.ts': 'base' },
      { 'fix.ts': 'FIX' },
      { 'fix.ts': 'base' },
      { 'fix.ts': 'FIX+more' },
    ]);
    const rows = [row(0, [['fix.ts', 300, 7]]), row(1, [['fix.ts', 6, 300]]), row(2, [['fix.ts', 301, 6]])];
    expect(dropCrossTurnRoundTrips(state, rows, { blobs })).toBe(0);
  });

  it('a file something else changed between the two turns is not a round trip', () => {
    const { state, blobs } = world([
      { 'fix.ts': 'base' },
      { 'fix.ts': 'FIX' },
      { 'fix.ts': 'base' },
      { 'fix.ts': 'FIX' },
    ]);
    // Turn 2 starts on bytes turn 1 did not end on (a pull, another session).
    state.promptShadows[2].shadowSha = 'treeX';
    const fixed = (s: string | null, files: string[]) =>
      s === 'treeX' ? new Map(files.map((f) => [f, 'pulled'])) : blobs(s, files);
    const rows = [row(0, [['fix.ts', 300, 7]]), row(1, [['fix.ts', 6, 300]]), row(2, [['fix.ts', 300, 6]])];
    expect(dropCrossTurnRoundTrips(state, rows, { blobs: fixed })).toBe(0);
  });

  it('the turn this Stop closes is measured to the live tree', () => {
    const { state, blobs } = world([
      { 'fix.ts': 'base' },
      { 'fix.ts': 'FIX' },
      { 'fix.ts': 'base' },
      { 'fix.ts': 'FIX' },
    ], { liveEnd: true });
    const asked: Array<string | null> = [];
    const spy = (s: string | null, f: string[]) => { asked.push(s); return blobs(s, f); };
    const rows = [row(0, [['fix.ts', 300, 7]]), row(1, [['fix.ts', 6, 300]]), row(2, [['fix.ts', 300, 6]])];
    expect(dropCrossTurnRoundTrips(state, rows, { blobs: spy })).toBe(2);
    expect(asked).toContain(null);
  });

  it('putting back bytes no turn of the session wrote (pre-session dirt) is not a round trip', () => {
    // fix.ts was already DIRTY when turn 0 began; turn 0 cleans it, turn 1 restores it.
    const { state, blobs } = world([
      { 'fix.ts': 'DIRT' },
      { 'fix.ts': 'base' },
      { 'fix.ts': 'DIRT' },
    ]);
    const rows = [row(0, [['fix.ts', 1, 40]]), row(1, [['fix.ts', 40, 1]])];
    expect(dropCrossTurnRoundTrips(state, rows, { blobs })).toBe(0);
  });

  it('git that cannot answer drops nothing', () => {
    const { state } = world([{ a: '1' }, { a: '2' }, { a: '1' }, { a: '2' }]);
    const rows = [row(0, [['a', 1, 1]]), row(1, [['a', 1, 1]]), row(2, [['a', 1, 1]])];
    expect(dropCrossTurnRoundTrips(state, rows, { blobs: () => new Map() })).toBe(0);
    expect(rows.map((r) => r.linesAdded)).toEqual([1, 1, 1]);
  });
});
