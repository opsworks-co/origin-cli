/**
 * A turn that writes a file and puts it back before it ends has DISCARDED
 * that work — a different thing from work still dirty in the tree, and the
 * page must be able to say which.
 *
 * Session b300fdf0 turn 10 (2026-09-26): four Edit calls on
 * antigravity-transcript.ts, then `git checkout --` on it after finding the
 * same fix merged as #1907. The ledger resolved the file to netZero and the
 * row went out with no files; the page kept an earlier capture's +46/-6 and
 * read "uncommitted", which the user took to mean the work was still
 * somewhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { discardedWorkForTurn } from '../discarded-work.js';
import { serializeRecord, serializeTurnMark, parseJournalEntries } from '../write-journal.js';
import { putSnapshot } from '../write-journal-store.js';
import { applyLedgerToMappings } from '../capture-from-ledger.js';

describe('discardedWorkForTurn', () => {
  const none = () => new Set<string>();

  it('a file the turn wrote and the tree no longer holds is discarded', () => {
    expect(discardedWorkForTurn(['a.ts'], new Set(['a.ts']), none)).toEqual(['a.ts']);
  });

  it('a netZero file the turn never authored is a checkout round-trip, not discarded work', () => {
    // 22 of the 23 files a `git checkout -B sync-main origin/main` rewrote in
    // b300fdf0 turn 10 came back within the second.
    expect(discardedWorkForTurn(['theirs.ts', 'a.ts'], new Set(['a.ts']), none)).toEqual(['a.ts']);
    expect(discardedWorkForTurn(['theirs.ts'], new Set(['a.ts']), none)).toEqual([]);
  });

  it('a file a commit of the turn holds is committed, not discarded', () => {
    // Commit on a branch, switch back to main: the tree is at its baseline
    // and the work is in git.
    expect(discardedWorkForTurn(['a.ts'], new Set(['a.ts']), () => new Set(['a.ts']))).toEqual([]);
  });

  it('nothing put back is a measured "none", not unknown', () => {
    expect(discardedWorkForTurn([], new Set(['a.ts']), none)).toEqual([]);
    expect(discardedWorkForTurn([], undefined, none)).toEqual([]);
  });

  it('is unknown without authoring evidence, or when a commit could not be read', () => {
    expect(discardedWorkForTurn(['a.ts'], undefined, none)).toBeNull();
    expect(discardedWorkForTurn(['a.ts'], new Set(['a.ts']), () => null)).toBeNull();
  });

  it('reads the commits only when a candidate exists', () => {
    let read = 0;
    discardedWorkForTurn(['theirs.ts'], new Set(['a.ts']), () => { read++; return new Set(); });
    expect(read).toBe(0);
  });
});

describe('applyLedgerToMappings — the verdict rides the mapping', () => {
  let tmp = '';
  let store = '';
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-discarded-'));
    store = path.join(tmp, 'snap');
    fs.mkdirSync(store, { recursive: true });
  });
  afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  const put = (content: string): string => putSnapshot(store, content).hash;
  const w = (file: string, at: number, hash: string): string => serializeRecord({ file, at, hash, retained: true });
  const t = (id: string, at: number): string => serializeTurnMark({ at, turnId: id });
  const state = (turnIds: string[]) => ({ writeJournalPath: '/does/not/matter', writeSnapshotDir: store, promptTurnIds: turnIds });

  /** Turn 1 wrote a.ts (v0 → v1) and the tree then held v0 again; b.ts kept its edit. */
  const log = () => {
    const v0 = put('base\n');
    const v1 = put('base\nedited\n');
    const b1 = put('b\n');
    return t('T0', 1) + w('a.ts', 2, v0) + t('T1', 3) + w('a.ts', 4, v1) + w('b.ts', 5, b1) + w('a.ts', 6, v0);
  };

  it('names the file the turn wrote and put back, beside a row that no longer lists it', () => {
    const pm: Record<string, unknown> = { promptIndex: 1, filesChanged: ['a.ts', 'b.ts'], diff: 'stale' };
    const n = applyLedgerToMappings(state(['T0', 'T1']), [pm as never], {
      readEntries: () => parseJournalEntries(log()),
      authoredFiles: () => new Set(['a.ts', 'b.ts']),
      committedFiles: () => new Set(),
    });
    expect(n).toBe(1);
    expect(pm.filesChanged).toEqual(['b.ts']);
    expect(pm.discardedFiles).toEqual(['a.ts']);
  });

  it('sends a measured [] when nothing was put back, so a stale list on the server clears', () => {
    const pm: Record<string, unknown> = { promptIndex: 1, filesChanged: [], diff: '', discardedFiles: ['a.ts'] };
    const v0 = put('base\n');
    const v1 = put('base\nedited\n');
    const kept = t('T0', 1) + w('a.ts', 2, v0) + t('T1', 3) + w('a.ts', 4, v1);
    applyLedgerToMappings(state(['T0', 'T1']), [pm as never], {
      readEntries: () => parseJournalEntries(kept),
      authoredFiles: () => new Set(['a.ts']),
    });
    expect(pm.filesChanged).toEqual(['a.ts']);
    expect(pm.discardedFiles).toEqual([]);
  });

  it('a producer without authoring evidence leaves the field exactly as it stands', () => {
    // The heartbeat re-sends Stop's row; it must neither invent nor clear.
    const pm: Record<string, unknown> = { promptIndex: 1, filesChanged: [], diff: '', discardedFiles: ['a.ts'] };
    applyLedgerToMappings(state(['T0', 'T1']), [pm as never], { readEntries: () => parseJournalEntries(log()) });
    expect(pm.discardedFiles).toEqual(['a.ts']);
    const fresh: Record<string, unknown> = { promptIndex: 1, filesChanged: [], diff: '' };
    applyLedgerToMappings(state(['T0', 'T1']), [fresh as never], { readEntries: () => parseJournalEntries(log()) });
    expect('discardedFiles' in fresh).toBe(false);
  });

  it('a file a stash made in the turn holds at the turn\'s bytes is not discarded', () => {
    let asked: { since: number; written: Map<string, Set<string>> } | null = null;
    const pm: Record<string, unknown> = { promptIndex: 1, filesChanged: [], diff: '' };
    applyLedgerToMappings(state(['T0', 'T1']), [pm as never], {
      readEntries: () => parseJournalEntries(log()),
      authoredFiles: () => new Set(['a.ts', 'b.ts']),
      committedFiles: () => new Set(),
      stashedFiles: (since, written) => {
        asked = { since, written: new Map([...written].map(([f, h]) => [f, new Set(h)])) };
        return new Set(['a.ts']);
      },
    });
    expect(pm.discardedFiles).toEqual([]);
    // Asked from the turn's own mark, with the hashes the TURN wrote a.ts at.
    expect(asked!.since).toBe(3);
    expect([...asked!.written.keys()]).toEqual(['a.ts']);
    expect(asked!.written.get('a.ts')!.size).toBe(2);
  });

  it('a stash that holds other files leaves the put-back file discarded; an unanswerable stash leaves the field alone', () => {
    const pm: Record<string, unknown> = { promptIndex: 1, filesChanged: [], diff: '' };
    applyLedgerToMappings(state(['T0', 'T1']), [pm as never], {
      readEntries: () => parseJournalEntries(log()),
      authoredFiles: () => new Set(['a.ts']),
      stashedFiles: () => new Set(),
    });
    expect(pm.discardedFiles).toEqual(['a.ts']);
    const unknown: Record<string, unknown> = { promptIndex: 1, filesChanged: [], diff: '', discardedFiles: ['earlier.ts'] };
    applyLedgerToMappings(state(['T0', 'T1']), [unknown as never], {
      readEntries: () => parseJournalEntries(log()),
      authoredFiles: () => new Set(['a.ts']),
      stashedFiles: () => null,
    });
    expect(unknown.discardedFiles).toEqual(['earlier.ts']);
  });

  it('a file in a commit of the turn is not discarded', () => {
    const pm: Record<string, unknown> = { promptIndex: 1, filesChanged: [], diff: '' };
    applyLedgerToMappings(state(['T0', 'T1']), [pm as never], {
      readEntries: () => parseJournalEntries(log()),
      authoredFiles: () => new Set(['a.ts', 'b.ts']),
      committedFiles: () => new Set(['a.ts']),
    });
    expect(pm.discardedFiles).toEqual([]);
  });
});
