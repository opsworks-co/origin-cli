// Per-line authorship reconstructed by replaying the turns' edits.
//
// The shadow-chain walk is the better source when it works, but it can only
// separate two turns if a git snapshot exists BETWEEN them — and the poll-based
// watcher doesn't guarantee one. On session 0079e36c (pipa) both shadows sat
// outside the pair, so the walk refused, correctly, and the file had no map at
// all. Replaying what the turns recorded gives the same answer from the other
// direction.
//
// It is only trustworthy because it is checked: the replayed file must come out
// byte-identical to the file on disk. Anything the records missed — a shell
// edit, a malformed payload — makes the reconstruction diverge, and then
// nothing is emitted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { replayLineMaps } from '../edit-replay-map.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
}
const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';

describe('replayLineMaps', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-replay-')));
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.co');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'initial');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('splits turns the git walk cannot (the pipa case: whole-file rewrite)', () => {
    // Turn 1 creates 4 rows; turn 2 rewrites the file with 9. Chained, turn 2's
    // record carries the 4 rows as its "before" — so only rows 5-9 are its own.
    fs.writeFileSync(path.join(dir, 'pipa'), rows(1, 9));
    const maps = replayLineMaps(dir, [
      { promptIndex: 0, edits: [{ file: 'pipa', op: 'write', oldContent: '', newContent: rows(1, 4) }] },
      { promptIndex: 1, edits: [{ file: 'pipa', op: 'write', oldContent: rows(1, 4), newContent: rows(1, 9) }] },
    ]);

    expect(maps).toHaveLength(1);
    expect(maps[0].total).toBe(9);
    expect(maps[0].runs.map((r) => [r.start, r.lines.length, r.promptIndex])).toEqual([
      [1, 4, 0],
      [5, 5, 1],
    ]);
  });

  it('keeps pre-session lines unowned, reading the base from git', () => {
    const f = path.join(dir, 'notes.txt');
    fs.writeFileSync(f, 'inherited 1\ninherited 2\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'pre-session');
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(f, 'inherited 1\ninherited 2\nmine\n');

    const maps = replayLineMaps(dir, [
      { promptIndex: 0, edits: [{ file: 'notes.txt', op: 'edit', oldContent: 'inherited 2\n', newContent: 'inherited 2\nmine\n' }] },
    ], base);

    expect(maps[0].runs.map((r) => [r.start, r.lines.length, r.promptIndex])).toEqual([
      [1, 2, null],
      [3, 1, 0],
    ]);
  });

  it('leaves untouched lines with their original author on a later edit', () => {
    const f = path.join(dir, 'notes.txt');
    fs.writeFileSync(f, 'a\nb\nINSERTED\nc\n');
    const maps = replayLineMaps(dir, [
      { promptIndex: 0, edits: [{ file: 'notes.txt', op: 'write', oldContent: '', newContent: 'a\nb\nc\n' }] },
      { promptIndex: 1, edits: [{ file: 'notes.txt', op: 'edit', oldContent: 'b\n', newContent: 'b\nINSERTED\n' }] },
    ]);
    expect(maps[0].runs.map((r) => [r.start, r.lines.length, r.promptIndex])).toEqual([
      [1, 2, 0],   // a, b — still turn 1's
      [3, 1, 1],   // INSERTED — turn 2's
      [4, 1, 0],   // c — still turn 1's
    ]);
  });

  it('emits nothing when the replay does not reproduce the file', () => {
    // The agent also edited through the shell, so the records alone can't
    // rebuild what is on disk. Better to say nothing than to place lines wrong.
    fs.writeFileSync(path.join(dir, 'pipa'), rows(1, 9) + 'written by a shell command\n');
    const maps = replayLineMaps(dir, [
      { promptIndex: 0, edits: [{ file: 'pipa', op: 'write', oldContent: '', newContent: rows(1, 9) }] },
    ]);
    expect(maps).toEqual([]);
  });

  it('emits nothing when a recorded "before" is not in the file', () => {
    fs.writeFileSync(path.join(dir, 'pipa'), rows(1, 4));
    const maps = replayLineMaps(dir, [
      { promptIndex: 0, edits: [{ file: 'pipa', op: 'write', oldContent: '', newContent: rows(1, 4) }] },
      { promptIndex: 1, edits: [{ file: 'pipa', op: 'edit', oldContent: 'not present\n', newContent: 'x\n' }] },
    ]);
    expect(maps).toEqual([]);
  });
});
