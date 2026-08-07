// Per-turn attribution in FINAL-file coordinates, exercised against a real git
// repo with real shadow commits.
//
// The case that motivated it: a turn deletes lines other turns wrote. Every
// captured per-turn diff is anchored to the file as it looked at the time, so
// once a deletion shifts the file those windows describe positions that no
// longer exist — and merging them would render deleted text as live code.
// Walking each turn's lines forward through the remaining states says where
// they actually ended up, or that they are gone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeFinalHunks, renderFinalHunks, mapLineForward, parseUnifiedZero, finalHunksForCaptures, computeFileLineMaps } from '../final-state-blame.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
}
const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';

describe('computeFinalHunks', () => {
  let dir: string;
  // Snapshot the working tree the way the watcher's createShadowCommit does:
  // a commit-ish sha we can diff against later.
  const shadow = (tag: string) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', tag, '--allow-empty');
    return git(dir, 'rev-parse', 'HEAD').trim();
  };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-fsb-')));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.co');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'initial');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('numbers each turn against the file as it is now (pure appends)', () => {
    const f = path.join(dir, 'shisha');
    const s0 = shadow('before-p0');
    fs.writeFileSync(f, rows(1, 12));                     // turn 0
    const s1 = shadow('before-p1');
    fs.writeFileSync(f, rows(1, 17));                     // turn 1
    const s2 = shadow('before-p2');
    fs.writeFileSync(f, rows(1, 24));                     // turn 2
    const s3 = shadow('before-p3');
    fs.writeFileSync(f, rows(1, 34));                     // turn 3, left uncommitted

    const map = computeFinalHunks(dir, [
      { promptIndex: 0, baselineSha: s0 },
      { promptIndex: 1, baselineSha: s1 },
      { promptIndex: 2, baselineSha: s2 },
      { promptIndex: 3, baselineSha: s3 },
    ], ['shisha']);

    const spanOf = (i: number) => (map.get(i) || []).flatMap((h) => h.lines.map((_, k) => h.start + k));
    expect(spanOf(0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(spanOf(1)).toEqual([13, 14, 15, 16, 17]);
    expect(spanOf(2)).toEqual([18, 19, 20, 21, 22, 23, 24]);
    expect(spanOf(3)).toEqual([25, 26, 27, 28, 29, 30, 31, 32, 33, 34]);
  });

  it('drops lines a later turn deleted, and renumbers the survivors', () => {
    const f = path.join(dir, 'notes.txt');
    const s0 = shadow('before-p0');
    fs.writeFileSync(f, 'A\nB\nC\nD\nE\nF\nG\nH\n');       // turn 0 creates A-H
    const s1 = shadow('before-p1');
    fs.writeFileSync(f, 'A\nB\nE\nF\n');                   // turn 1 deletes C, D, G, H
    const s2 = shadow('before-p2');
    fs.writeFileSync(f, 'A\nB\nE\nF\nX\nY\n');             // turn 2 appends X, Y

    const map = computeFinalHunks(dir, [
      { promptIndex: 0, baselineSha: s0 },
      { promptIndex: 1, baselineSha: s1 },
      { promptIndex: 2, baselineSha: s2 },
    ], ['notes.txt']);

    // Turn 0 wrote A-H; only A, B, E, F survive — at lines 1,2,3,4 now, NOT at
    // the 1..8 its own captured diff still claims.
    const t0 = (map.get(0) || []).flatMap((h) => h.lines.map((c, k) => [h.start + k, c]));
    expect(t0).toEqual([[1, 'A'], [2, 'B'], [3, 'E'], [4, 'F']]);
    // C, D, G, H are gone — they must not appear anywhere.
    expect(JSON.stringify([...map.values()])).not.toContain('"C"');
    expect(JSON.stringify([...map.values()])).not.toContain('"H"');
    // Turn 1 only deleted, so it authored nothing that survives.
    expect(map.get(1)).toBeUndefined();
    expect((map.get(2) || []).flatMap((h) => h.lines)).toEqual(['X', 'Y']);
  });

  it('handles an insert ABOVE an earlier turn (the shift the server cannot see)', () => {
    const f = path.join(dir, 'notes.txt');
    const s0 = shadow('before-p0');
    fs.writeFileSync(f, 'one\ntwo\n');                     // turn 0
    const s1 = shadow('before-p1');
    fs.writeFileSync(f, 'header\nheader2\none\ntwo\n');    // turn 1 inserts at the top

    const map = computeFinalHunks(dir, [
      { promptIndex: 0, baselineSha: s0 },
      { promptIndex: 1, baselineSha: s1 },
    ], ['notes.txt']);

    // Turn 0's lines moved from 1-2 to 3-4.
    expect((map.get(0) || []).map((h) => [h.start, h.lines])).toEqual([[3, ['one', 'two']]]);
    expect((map.get(1) || []).map((h) => [h.start, h.lines])).toEqual([[1, ['header', 'header2']]]);
  });

  it('picks the right shadow alignment when snapshots land AFTER each turn', () => {
    // The poll-based watcher snapshots when it NOTICES a prompt, which for a
    // fast turn is after that turn already wrote. Read as pre-turn baselines,
    // every turn gets credited with the next turn's lines. The content
    // signatures below are what rules that reading out.
    const f = path.join(dir, 'shisha');
    const start = shadow('session-start');
    fs.writeFileSync(f, rows(1, 12));
    const afterP0 = shadow('noticed-p0');
    fs.writeFileSync(f, rows(1, 17));
    const afterP1 = shadow('noticed-p1');
    fs.writeFileSync(f, rows(1, 24));
    const afterP2 = shadow('noticed-p2');
    fs.writeFileSync(f, rows(1, 34));

    const expected = new Map([
      [0, new Set(rows(1, 12).trimEnd().split('\n'))],
      [1, new Set(rows(13, 17).trimEnd().split('\n'))],
      [2, new Set(rows(18, 24).trimEnd().split('\n'))],
      [3, new Set(rows(25, 34).trimEnd().split('\n'))],
    ]);
    const map = computeFinalHunks(dir, [
      { promptIndex: 0, baselineSha: afterP0 },
      { promptIndex: 1, baselineSha: afterP1 },
      { promptIndex: 2, baselineSha: afterP2 },
      { promptIndex: 3, baselineSha: afterP2 },
    ], ['shisha'], { sessionStartSha: start, expected });

    const spanOf = (i: number) => (map.get(i) || []).flatMap((h) => h.lines.map((_, k) => h.start + k));
    expect(spanOf(0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(spanOf(1)).toEqual([13, 14, 15, 16, 17]);
    expect(spanOf(2)).toEqual([18, 19, 20, 21, 22, 23, 24]);
    expect(spanOf(3)).toEqual([25, 26, 27, 28, 29, 30, 31, 32, 33, 34]);
  });

  it('emits nothing when no alignment matches what the prompts recorded', () => {
    const f = path.join(dir, 'shisha');
    const s0 = shadow('before-p0');
    fs.writeFileSync(f, rows(1, 5));
    const s1 = shadow('before-p1');
    fs.writeFileSync(f, rows(1, 9));

    // Signatures that match neither turn's real work — a chain we cannot trust.
    const expected = new Map([
      [0, new Set(['something else entirely'])],
      [1, new Set(['and this too'])],
    ]);
    const map = computeFinalHunks(dir, [
      { promptIndex: 0, baselineSha: s0 },
      { promptIndex: 1, baselineSha: s1 },
    ], ['shisha'], { expected });
    expect(map.size).toBe(0);
  });

  it('returns nothing when the file was deleted outright', () => {
    const f = path.join(dir, 'gone.txt');
    const s0 = shadow('before-p0');
    fs.writeFileSync(f, 'a\nb\n');
    const s1 = shadow('before-p1');
    fs.rmSync(f);

    const map = computeFinalHunks(dir, [
      { promptIndex: 0, baselineSha: s0 },
      { promptIndex: 1, baselineSha: s1 },
    ], ['gone.txt']);
    expect(map.size).toBe(0);
  });

  it('renders hunks the server can parse as a normal per-prompt diff', () => {
    const diff = renderFinalHunks([
      { file: 'shisha', start: 13, lines: ['Row 13', 'Row 14'] },
      { file: 'shisha', start: 20, lines: ['Row 20'] },
    ]);
    expect(diff.split('\n')).toEqual([
      'diff --git a/shisha b/shisha',
      '--- a/shisha',
      '+++ b/shisha',
      '@@ -13,0 +13,2 @@',
      '+Row 13',
      '+Row 14',
      '@@ -20,0 +20,1 @@',
      '+Row 20',
    ]);
  });
});

describe('finalHunksForCaptures (the entry point both capture paths share)', () => {
  let dir: string;
  const shadow = (tag: string) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', tag, '--allow-empty');
    return git(dir, 'rev-parse', 'HEAD').trim();
  };
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-fsb-cap-')));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.co');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'initial');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('derives the file list and content signatures from editsJson alone', () => {
    const f = path.join(dir, 'notes.txt');
    const s0 = shadow('before-p0');
    fs.writeFileSync(f, 'alpha\nbeta\n');
    const s1 = shadow('before-p1');
    fs.writeFileSync(f, 'alpha\nbeta\ngamma\n');

    // Exactly the payload shape both paths store as editsJson.
    const editsJsonByIndex = new Map([
      [0, JSON.stringify({ edits: [{ file: 'notes.txt', op: 'write', oldContent: '', newContent: 'alpha\nbeta\n' }], commits: [] })],
      [1, JSON.stringify({ edits: [{ file: 'notes.txt', op: 'edit', oldContent: 'beta\n', newContent: 'beta\ngamma\n' }], commits: [] })],
    ]);

    const map = finalHunksForCaptures(dir, [
      { promptIndex: 0, baselineSha: s0 },
      { promptIndex: 1, baselineSha: s1 },
    ], editsJsonByIndex);

    expect((map.get(0) || []).map((h) => [h.start, h.lines])).toEqual([[1, ['alpha', 'beta']]]);
    expect((map.get(1) || []).map((h) => [h.start, h.lines])).toEqual([[3, ['gamma']]]);
  });

  it('returns nothing when the payloads name no files', () => {
    const s0 = shadow('before-p0');
    const empty = new Map([[0, JSON.stringify({ edits: [], commits: [] })]]);
    expect(finalHunksForCaptures(dir, [{ promptIndex: 0, baselineSha: s0 }], empty).size).toBe(0);
  });
});

describe('line walk primitives', () => {
  it('maps a line past an earlier insertion and drops a replaced one', () => {
    const hunks = parseUnifiedZero(
      ['@@ -0,0 +1,2 @@', '+header', '+header2', '@@ -5,2 +7,0 @@'].join('\n'),
    );
    expect(mapLineForward(1, hunks)).toBe(3);  // shifted by the 2-line insert
    expect(mapLineForward(5, hunks)).toBeNull(); // inside the removed range
    expect(mapLineForward(6, hunks)).toBeNull();
    expect(mapLineForward(7, hunks)).toBe(7);  // +2 insert, -2 removal cancel out
  });
});

describe('computeFileLineMaps (the artifact the server renders)', () => {
  let dir: string;
  const shadow = (tag: string) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', tag, '--allow-empty');
    return git(dir, 'rev-parse', 'HEAD').trim();
  };
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-lmap-')));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.co');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'initial');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const capture = (i: number, oldC: string, newC: string) =>
    JSON.stringify({ edits: [{ file: 'notes.txt', op: i === 0 ? 'write' : 'edit', oldContent: oldC, newContent: newC }], commits: [] });

  it('covers EVERY line, marking inherited ones null instead of dropping them', () => {
    const f = path.join(dir, 'notes.txt');
    // Pre-existing content the session did not write.
    fs.writeFileSync(f, 'old A\nold B\n');
    const s0 = shadow('session-start');
    fs.writeFileSync(f, 'old A\nold B\nmine 1\nmine 2\n');
    const s1 = shadow('after-p0');
    fs.writeFileSync(f, 'old A\nold B\nmine 1\nmine 2\nmine 3\n');

    const maps = computeFileLineMaps(dir, [
      { promptIndex: 0, baselineSha: s0 },
      { promptIndex: 1, baselineSha: s1 },
    ], new Map([
      [0, capture(0, '', 'mine 1\nmine 2\n')],
      [1, capture(1, 'mine 2\n', 'mine 2\nmine 3\n')],
    ]));

    expect(maps).toHaveLength(1);
    const m = maps[0];
    expect(m.file).toBe('notes.txt');
    expect(m.total).toBe(5);
    // Every line present, in order, no holes.
    const flat = m.runs.flatMap((r) => r.lines.map((c, i) => [r.start + i, r.promptIndex, c]));
    expect(flat.map((x) => x[0])).toEqual([1, 2, 3, 4, 5]);
    // Pre-existing lines are owned by nobody — but still THERE.
    expect(flat[0]).toEqual([1, null, 'old A']);
    expect(flat[1]).toEqual([2, null, 'old B']);
    expect(flat[2][1]).toBe(0);
    expect(flat[4]).toEqual([5, 1, 'mine 3']);
  });

  it('emits nothing when the chain cannot be verified', () => {
    const f = path.join(dir, 'notes.txt');
    const s0 = shadow('p0');
    fs.writeFileSync(f, 'a\nb\n');
    const maps = computeFileLineMaps(dir, [{ promptIndex: 0, baselineSha: s0 }], new Map([
      [0, capture(0, '', 'something the file never contained\n')],
    ]));
    expect(maps).toEqual([]);
  });
});
