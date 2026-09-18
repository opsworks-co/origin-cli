import { describe, expect, it } from 'vitest';
import { recoverJournalTurns } from '../recover-journal-turns.js';
import { turnWriteIndices, type JournalEntry } from '../write-journal.js';

const entries: JournalEntry[] = [
  { kind: 'turn', turnId: 'first', at: 10 },
  { kind: 'write', file: 'a', at: 20 },
  { kind: 'write', file: 'b', at: 30 },
  { kind: 'write', file: 'c', at: 40 },
];
const state = { promptTurnIds: ['first'], promptShadows: [
  { promptIndex: 0, promptStartedAt: 10 },
  { promptIndex: 1, promptStartedAt: 30 },
  { promptIndex: 2, promptStartedAt: 40 },
] };
const files = (result: ReturnType<typeof recoverJournalTurns>, local: number) =>
  turnWriteIndices(result.entries, result.turnIds[local]).map(i => (result.entries[i] as any).file);

describe('recoverJournalTurns', () => {
  it('partitions multiple missed submits, including writes exactly at the boundary', () => {
    const result = recoverJournalTurns(entries, state);
    expect([0, 1, 2].map(i => files(result, i))).toEqual([['a'], ['b'], ['c']]);
    expect(entries).toHaveLength(4);
    expect(state.promptTurnIds).toEqual(['first']);
    expect(result.entries.filter(e => e.kind !== 'turn' || e.turnId === 'first')).toEqual(entries);
  });

  it('keeps real late marks and their reclaim evidence', () => {
    const mark: JournalEntry = { kind: 'turn', at: 35, turnId: 'second', reclaim: ['b'] };
    const log = [...entries.slice(0, 3), mark, entries[3]];
    const result = recoverJournalTurns(log, { ...state, promptTurnIds: ['first', 'second'] });
    expect(result.entries.filter(e => e.kind === 'turn' && e.turnId === 'second')).toEqual([mark]);
    expect(files(result, 0)).toEqual(['a']);
    expect(files(result, 1)).toEqual(['b']);
  });

  it('keeps checkout fences inside recovered turns', () => {
    const log: JournalEntry[] = [...entries.slice(0, 3), { kind: 'fence', at: 35 }, entries[3]];
    const result = recoverJournalTurns(log, { ...state, promptShadows: state.promptShadows.slice(0, 2) });
    // The fence stays where it was, and no longer ends the turn around it:
    // `c` was written after the checkout, by the same turn.
    expect(files(result, 1)).toEqual(['b', 'c']);
    expect(result.entries).toContainEqual({ kind: 'fence', at: 35 });
  });

  it.each([undefined, 0, NaN, Infinity, -1])('declines absent or invalid start time %s', at => {
    expect(recoverJournalTurns(entries, { promptShadows: [{ promptIndex: 1, promptStartedAt: at }] }).entries).toBe(entries);
  });

  it('does not sort a journal whose clock went backwards', () => {
    const log = [entries[0], entries[2], entries[1]];
    expect(recoverJournalTurns(log, state).entries).toBe(log);
  });

  it('declines conflicting prompt times', () => {
    for (const at of [20, 30]) {
      expect(recoverJournalTurns(entries, { promptShadows: [
        { promptIndex: 1, promptStartedAt: 30 }, { promptIndex: 2, promptStartedAt: at },
      ] }).entries).toBe(entries);
    }
  });

  it('does not put a missing turn before an earlier real sibling mark', () => {
    const log: JournalEntry[] = [{ kind: 'turn', turnId: 'first', at: 35 }, entries[3]];
    const result = recoverJournalTurns(log, { ...state, promptShadows: state.promptShadows.slice(0, 2) });
    expect(result.entries).toBe(log);
  });
});
