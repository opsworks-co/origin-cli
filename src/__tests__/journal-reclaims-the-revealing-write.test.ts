// A turn nobody announced is discovered by the edit that reveals it — and by
// then that edit is in the log ahead of any mark the turn can get. By position
// it was the PREVIOUS turn's: Cursor session e2c3508a's unannounced turn 3
// wrote its files under turn 2's span, and turn 3 rendered chat-only above
// the commit it had just made. The discovering hook knows the file; the mark
// now names it, and the ledger moves exactly that record.
import { describe, it, expect } from 'vitest';
import { parseJournalEntries, serializeRecord, serializeTurnMark, turnFileChanges, writesForTurn } from '../write-journal.js';

const w = (file: string, hash: string, at: number) => serializeRecord({ file, at, hash, retained: true });

describe('TurnMark.reclaim', () => {
  const log = [
    serializeTurnMark({ at: 1000, turnId: 'A' }),
    w('app.py', 'h-app-1', 1100),
    w('notes.md', 'h-notes-1', 1200),        // the write that revealed turn B
    serializeTurnMark({ at: 1300, turnId: 'B', reclaim: ['notes.md'] }),
    w('notes.md', 'h-notes-2', 1400),
  ].join('');
  const entries = parseJournalEntries(log);

  it('round-trips the reclaim list', () => {
    const b = entries.find((e) => e.kind === 'turn' && e.turnId === 'B');
    expect(b && b.kind === 'turn' ? b.reclaim : null).toEqual(['notes.md']);
  });

  it('moves the revealing write out of the previous turn', () => {
    expect(writesForTurn(entries, 'A').map((r) => r.hash)).toEqual(['h-app-1']);
    expect(turnFileChanges(entries, 'A').map((c) => c.file)).toEqual(['app.py']);
  });

  it('and into the turn it revealed, with the before-state from ahead of it', () => {
    expect(writesForTurn(entries, 'B').map((r) => r.hash)).toEqual(['h-notes-1', 'h-notes-2']);
    const changes = turnFileChanges(entries, 'B');
    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe('notes.md');
    expect(changes[0].beforeHash).toBeNull();      // first sighting in the session
    expect(changes[0].afterHash).toBe('h-notes-2');
    expect(changes[0].writes).toBe(2);
  });

  it('reclaims only the LAST record of the file — an earlier edit by the previous turn stays there', () => {
    const entries2 = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      w('notes.md', 'h-old', 1050),
      w('app.py', 'h-app-1', 1100),
      w('notes.md', 'h-notes-1', 1200),
      serializeTurnMark({ at: 1300, turnId: 'B', reclaim: ['notes.md'] }),
    ].join(''));
    expect(turnFileChanges(entries2, 'A').map((c) => [c.file, c.afterHash])).toEqual([['notes.md', 'h-old'], ['app.py', 'h-app-1']]);
    const b = turnFileChanges(entries2, 'B');
    expect(b.map((c) => [c.file, c.beforeHash, c.afterHash])).toEqual([['notes.md', 'h-old', 'h-notes-1']]);
  });

  it('a write the backend reported twice is reclaimed as one write', () => {
    const dup = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      w('app.py', 'h-app-1', 1100),
      w('notes.md', 'h-notes-1', 1200),
      w('notes.md', 'h-notes-1', 1200),        // the same save, seen twice
      serializeTurnMark({ at: 1300, turnId: 'B', reclaim: ['notes.md'] }),
    ].join(''));
    expect(turnFileChanges(dup, 'A').map((c) => c.file)).toEqual(['app.py']);
    const b = turnFileChanges(dup, 'B');
    expect(b.map((c) => [c.file, c.beforeHash, c.afterHash, c.reclaimed])).toEqual([['notes.md', null, 'h-notes-1', true]]);
  });

  // Linux: the create fires before the bytes land, so one save is two records
  // — the empty file, then its content after the debounce. Jenkins run 5254.
  it('a save caught mid-write moves whole: its empty truncate goes with it', () => {
    const e = (file: string, hash: string, at: number, size: number) => serializeRecord({ file, at, hash, size, retained: true });
    const split = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      e('app.py', 'h-app-1', 1100, 40),
      e('notes.md', 'h-empty', 1200, 0),
      e('notes.md', 'h-notes-1', 1450, 14),
      serializeTurnMark({ at: 1600, turnId: 'B', reclaim: ['notes.md'] }),
    ].join(''));
    expect(turnFileChanges(split, 'A').map((c) => c.file)).toEqual(['app.py']);
    expect(turnFileChanges(split, 'B').map((c) => [c.file, c.beforeHash, c.afterHash])).toEqual([['notes.md', null, 'h-notes-1']]);
  });

  it('an empty file the previous turn left long before stays its own', () => {
    const e = (file: string, hash: string, at: number, size: number) => serializeRecord({ file, at, hash, size, retained: true });
    const apart = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      e('notes.md', 'h-empty', 1200, 0),
      e('notes.md', 'h-notes-1', 9000, 14),
      serializeTurnMark({ at: 9100, turnId: 'B', reclaim: ['notes.md'] }),
    ].join(''));
    expect(turnFileChanges(apart, 'A').map((c) => [c.file, c.afterHash])).toEqual([['notes.md', 'h-empty']]);
    expect(turnFileChanges(apart, 'B').map((c) => [c.beforeHash, c.afterHash])).toEqual([['h-empty', 'h-notes-1']]);
  });

  // Jenkins 11-06 (e52d3ac), cursor-binary turn 4: an EXISTING 60 KB file was
  // rewritten, the truncate was recorded empty, and the re-read that recorded
  // the bytes is a debounce timer — on a saturated box it fires seconds late.
  // The turn then read the empty record as its before-state: +1501 −0 for a
  // one-line edit. The kernel's mtimes for the two halves of one save are
  // milliseconds apart however late the watcher looks.
  it('a save whose re-read was observed seconds late still moves whole, by its mtimes', () => {
    const e = (file: string, hash: string, at: number, size: number, mtime: number) => serializeRecord({ file, at, hash, size, mtime, retained: true });
    const late = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      e('big.py', 'h-big-0', 1100, 60_000, 1099),
      e('big.py', 'h-empty', 5000, 0, 4998),
      e('big.py', 'h-big-1', 8200, 60_000, 5001),   // timer 3 s late
      serializeTurnMark({ at: 8300, turnId: 'B', reclaim: ['big.py'] }),
    ].join(''));
    expect(turnFileChanges(late, 'A').map((c) => [c.file, c.afterHash])).toEqual([['big.py', 'h-big-0']]);
    expect(turnFileChanges(late, 'B').map((c) => [c.beforeHash, c.afterHash])).toEqual([['h-big-0', 'h-big-1']]);
  });

  it('an empty file written seconds before stays the previous turn\'s, even when the two were observed close together', () => {
    const e = (file: string, hash: string, at: number, size: number, mtime: number) => serializeRecord({ file, at, hash, size, mtime, retained: true });
    const apart = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      e('notes.md', 'h-empty', 8800, 0, 1200),       // observed late; written at 1200
      e('notes.md', 'h-notes-1', 9000, 14, 8990),
      serializeTurnMark({ at: 9100, turnId: 'B', reclaim: ['notes.md'] }),
    ].join(''));
    expect(turnFileChanges(apart, 'A').map((c) => [c.file, c.afterHash])).toEqual([['notes.md', 'h-empty']]);
    expect(turnFileChanges(apart, 'B').map((c) => [c.beforeHash, c.afterHash])).toEqual([['h-empty', 'h-notes-1']]);
  });

  // local-ci 2026-11-11 (#3066), cursor-binary turn 4: the watcher read big.py
  // while one writeFileSync was still copying pages and recorded exactly 24,576
  // of its 58,906 bytes, then the whole file. The torn record stayed A's and
  // was B's before-state: +868 -1 for a one-line edit.
  it('a save the watcher read mid-write moves whole: its torn, shorter record goes with it', () => {
    const e = (file: string, hash: string, at: number, size: number, mtime: number) => serializeRecord({ file, at, hash, size, mtime, retained: true });
    const torn = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      e('big.py', 'h-big-0', 1100, 58_907, 1099),
      e('big.py', 'h-torn', 5000, 24_576, 4999),
      e('big.py', 'h-big-1', 5600, 58_906, 4999),
      serializeTurnMark({ at: 5700, turnId: 'B', reclaim: ['big.py'] }),
    ].join(''));
    expect(turnFileChanges(torn, 'A').map((c) => [c.file, c.afterHash])).toEqual([['big.py', 'h-big-0']]);
    expect(turnFileChanges(torn, 'B').map((c) => [c.beforeHash, c.afterHash])).toEqual([['h-big-0', 'h-big-1']]);
  });

  it('a truncate, a torn read and the bytes of one save all move together', () => {
    const e = (file: string, hash: string, at: number, size: number, mtime: number) => serializeRecord({ file, at, hash, size, mtime, retained: true });
    const three = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      e('big.py', 'h-big-0', 1100, 58_907, 1099),
      e('big.py', 'h-empty', 5000, 0, 4998),
      e('big.py', 'h-torn', 5001, 24_576, 4999),
      e('big.py', 'h-big-1', 7000, 58_906, 4999),
      serializeTurnMark({ at: 7100, turnId: 'B', reclaim: ['big.py'] }),
    ].join(''));
    expect(turnFileChanges(three, 'A').map((c) => [c.file, c.afterHash])).toEqual([['big.py', 'h-big-0']]);
    expect(turnFileChanges(three, 'B').map((c) => [c.beforeHash, c.afterHash])).toEqual([['h-big-0', 'h-big-1']]);
  });

  it('a shorter save the previous turn made seconds earlier stays its own', () => {
    const e = (file: string, hash: string, at: number, size: number, mtime: number) => serializeRecord({ file, at, hash, size, mtime, retained: true });
    const apart = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      e('notes.md', 'h-short', 1200, 10, 1200),
      e('notes.md', 'h-long', 9000, 40, 8990),
      serializeTurnMark({ at: 9100, turnId: 'B', reclaim: ['notes.md'] }),
    ].join(''));
    expect(turnFileChanges(apart, 'A').map((c) => [c.file, c.afterHash])).toEqual([['notes.md', 'h-short']]);
    expect(turnFileChanges(apart, 'B').map((c) => [c.beforeHash, c.afterHash])).toEqual([['h-short', 'h-long']]);
  });

  it('a mark without reclaim reads exactly as before', () => {
    const plain = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      w('x', 'h1', 1100),
      serializeTurnMark({ at: 1300, turnId: 'B' }),
      w('x', 'h2', 1400),
    ].join(''));
    expect(turnFileChanges(plain, 'A').map((c) => c.afterHash)).toEqual(['h1']);
    expect(turnFileChanges(plain, 'B').map((c) => [c.beforeHash, c.afterHash])).toEqual([['h1', 'h2']]);
  });
});

describe('captureTurnFromLedger on a reclaimed write', () => {
  it('reads the before-state from the PREVIOUS turn\'s baseline, not the one cut after the write', async () => {
    const { captureTurnFromLedger } = await import('../capture-from-ledger.js');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { putSnapshot } = await import('../write-journal-store.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-snap-'));
    const after = 'remember this\n';
    const hash = putSnapshot(dir, after).hash;
    const entries = parseJournalEntries([
      serializeTurnMark({ at: 1000, turnId: 'A' }),
      serializeRecord({ file: 'notes.md', at: 1200, hash, retained: true, mtime: 1200 }),
      serializeTurnMark({ at: 1300, turnId: 'B', reclaim: ['notes.md'] }),
    ].join(''));
    const reads: string[] = [];
    const cap = captureTurnFromLedger({
      entries, turnId: 'B', snapshotDir: dir,
      baselineSha: 'shadow-cut-after-the-write',
      priorBaselineSha: 'previous-turn-baseline',
      readAtRev: (sha, file) => { reads.push(`${sha}:${file}`); return sha === 'shadow-cut-after-the-write' ? after : null; },
    });
    expect(reads).toEqual(['previous-turn-baseline:notes.md']);
    expect(cap?.filesChanged).toEqual(['notes.md']);
    expect(cap?.netZero).toEqual([]);
    expect(cap?.linesAdded).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
