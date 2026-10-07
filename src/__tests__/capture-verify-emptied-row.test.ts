// An EMPTIED row: the row shows nothing while the turn's own hook-attested
// tool calls changed files that no row of the session carries.
//
// Session ed0e33c8 row 23 (2026-09-18) was re-captured as chat-only over a turn
// that had written two files. Only the header rule noticed, and #1719 holds
// that header back on a re-launched session — so the turn needs a rule of its
// own (TODO cb54d0ff). The turn's edit record is what tells an emptied row from
// a chat-only one.
import { describe, it, expect } from 'vitest';
import { verifySession, type VerifiableTurn } from '../capture-verify.js';

const patch = (file: string, line: string) => [
  `diff --git a/${file} b/${file}`,
  'index 1111111..2222222 100644',
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1,1 +1,2 @@',
  ' context',
  `+${line}`,
  '',
].join('\n');

const codes = (turns: VerifiableTurn[]) => verifySession(turns).map((v) => `${v.promptIndex}:${v.code}`);
const empty = (i: number, over: Partial<VerifiableTurn> = {}): VerifiableTurn => ({ promptIndex: i, filesChanged: [], diff: '', uncommittedDiff: '', ...over });

describe('emptied_row_with_own_writes', () => {
  it('an empty row whose turn wrote a file no row carries is a contradiction, naming the file', () => {
    const out = verifySession([empty(23, { ownWriteFiles: ['src/stop.ts', 'src/stop.test.ts'] })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: 'emptied_row_with_own_writes', severity: 'contradiction', promptIndex: 23 });
    expect(out[0].files).toEqual(['src/stop.ts', 'src/stop.test.ts']);
  });

  it('a chat-only turn — no own writes — is not asked', () => {
    expect(codes([empty(0), empty(1, { ownWriteFiles: [] }), empty(2, { ownWriteFiles: null })])).toEqual([]);
  });

  it('a file the turn put back before it ended explains the empty row', () => {
    // b300fdf0 turn 10: four edits, `git checkout --`, no commit — honestly empty.
    expect(codes([empty(9, { ownWriteFiles: ['src/agy.ts'], discardedFiles: ['src/agy.ts'] })])).toEqual([]);
    // …but only the files it names.
    expect(codes([empty(9, { ownWriteFiles: ['src/agy.ts', 'src/other.ts'], discardedFiles: ['src/agy.ts'] })]))
      .toEqual(['9:emptied_row_with_own_writes']);
  });

  it('a file some other row of the session carries is that row\'s to grade, not a loss', () => {
    // A mid-turn prompt or a re-Stop moves a turn's work onto its neighbour.
    const neighbour: VerifiableTurn = { promptIndex: 24, filesChanged: ['src/stop.ts'], diff: patch('src/stop.ts', 'moved') };
    expect(codes([empty(23, { ownWriteFiles: ['src/stop.ts'] }), neighbour])).toEqual([]);
    const declared: VerifiableTurn = { promptIndex: 24, filesChanged: ['src/stop.ts'], diff: '', contentUnavailableFiles: ['src/stop.ts'] };
    expect(codes([empty(23, { ownWriteFiles: ['src/stop.ts'] }), declared])).toEqual([]);
  });

  it('a row that shows anything at all is graded by the per-row rules instead', () => {
    // Its own write missing from a NON-empty row is the file-set rules' business.
    const partial: VerifiableTurn = { promptIndex: 3, filesChanged: ['src/a.ts'], diff: patch('src/a.ts', 'x'), ownWriteFiles: ['src/a.ts', 'src/b.ts'] };
    expect(codes([partial])).toEqual([]);
    const cut: VerifiableTurn = { promptIndex: 4, filesChanged: [], diff: '', contentUnavailableFiles: ['src/big.json'], ownWriteFiles: ['src/big.json'] };
    expect(codes([cut])).toEqual([]);
  });

  it('a file-set record is neither graded nor a place a file can be carried', () => {
    const accumulator: VerifiableTurn = { promptIndex: 99, filesChanged: ['src/stop.ts'], diff: '', fileSetOnly: true };
    expect(codes([empty(23, { ownWriteFiles: ['src/stop.ts'] }), accumulator])).toEqual(['23:emptied_row_with_own_writes']);
  });

  it('matches paths the way the other rules do', () => {
    const neighbour: VerifiableTurn = { promptIndex: 24, filesChanged: ['./src/stop.ts'], diff: patch('src/stop.ts', 'moved') };
    expect(codes([empty(23, { ownWriteFiles: ['src/stop.ts'] }), neighbour])).toEqual([]);
  });
});
