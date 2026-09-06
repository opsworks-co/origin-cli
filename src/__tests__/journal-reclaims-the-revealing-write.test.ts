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
