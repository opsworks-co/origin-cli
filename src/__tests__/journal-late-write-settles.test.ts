/**
 * A write observed after a turn mark but MADE before it belongs to the turn
 * before the mark. The trailing debounce re-read (and Linux's early inotify
 * event) can append a record a few hundred milliseconds after the write; a
 * mark in between put turn 1's last write into turn 2. Cursor e2e on Linux:
 * turn 2 listed app.py beside its own notes.md.
 */
import { describe, it, expect } from 'vitest';
import { parseJournalEntries, settleLateWrites, turnFileChanges, turnWriteIndices } from '../write-journal.js';

const mark = (t: number, id: string) => JSON.stringify({ k: 't', t, id });
const write = (f: string, t: number, h: string, m?: number) => JSON.stringify({ f, t, h, n: 10, r: 1, ...(m !== undefined ? { m } : {}) });

describe('settleLateWrites', () => {
  it('moves a late-observed write in front of the mark it precedes by mtime', () => {
    const entries = parseJournalEntries([
      mark(100, 'T1'),
      write('app.py', 110, 'partial', 105),
      mark(200, 'T2'),
      write('app.py', 260, 'full', 105), // the debounce re-read of the SAME write
      write('notes.md', 300, 'note', 299),
    ].join('\n'));
    expect(turnFileChanges(entries, 'T1').map((c) => [c.file, c.afterHash])).toEqual([['app.py', 'full']]);
    expect(turnFileChanges(entries, 'T2').map((c) => [c.file, c.afterHash])).toEqual([['notes.md', 'note']]);
  });

  it('leaves a write made after the mark where it is', () => {
    const entries = parseJournalEntries([
      mark(100, 'T1'), write('a', 110, 'h1', 105),
      mark(200, 'T2'), write('a', 260, 'h2', 250),
    ].join('\n'));
    expect(turnWriteIndices(entries, 'T2')).toHaveLength(1);
    expect(turnFileChanges(entries, 'T2')[0].afterHash).toBe('h2');
  });

  it('a record without an mtime has no opinion', () => {
    const entries = parseJournalEntries([
      mark(100, 'T1'), write('a', 110, 'h1'),
      mark(200, 'T2'), write('a', 260, 'h2'),
    ].join('\n'));
    expect(turnFileChanges(entries, 'T2')[0].afterHash).toBe('h2');
  });

  it('only a continuation of a file the previous turn wrote is late — a fresh file with a rounded mtime stays', () => {
    const entries = settleLateWrites(parseJournalEntries([
      mark(100, 'T1'), write('a', 110, 'first', 105),
      mark(200, 'T2'), write('b', 202, 'own', 198), write('a', 260, 'late', 150), write('c', 230, 'old-mtime', 120),
    ].join('\n')));
    // b: mtime 2ms before the mark, no earlier record — this turn's own write.
    // c: old mtime but never written before — a phantom for the ledger to judge.
    expect(entries.map((e) => (e.kind === 'turn' ? e.turnId : e.file))).toEqual(['T1', 'a', 'a', 'T2', 'b', 'c']);
  });

  it('an mtime a few milliseconds before the mark is the coarse kernel clock, not a late write', () => {
    // Linux stamps files from a 1-4 ms clock; the mark is Date.now(). The
    // same file, written in both turns, must stay with the turn that wrote it.
    const entries = settleLateWrites(parseJournalEntries([
      mark(100, 'T1'), write('a', 110, 'one', 105),
      mark(200, 'T2'), write('a', 203, 'two', 197),
    ].join('\n')));
    expect(entries.map((e) => (e.kind === 'turn' ? e.turnId : e.file))).toEqual(['T1', 'a', 'T2', 'a']);
  });

  it('a delete after the mark is never moved', () => {
    const entries = settleLateWrites(parseJournalEntries([
      mark(100, 'T1'), write('a', 110, 'h', 105),
      mark(200, 'T2'), JSON.stringify({ f: 'a', t: 210, g: 1, m: 50 }),
    ].join('\n')));
    expect(entries.map((e) => (e.kind === 'turn' ? e.turnId : e.file + (e.gone ? '!' : '')))).toEqual(['T1', 'a', 'T2', 'a!']);
  });
});
