import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { serializeRecord, serializeTurnMark, parseJournalEntries } from '../write-journal.js';
import { putSnapshot } from '../write-journal-store.js';
import { InheritedTooLarge, inheritedBeforeStates, type InheritedWindowDeps } from '../inherited-window-baseline.js';
import { applyLedgerToMappings } from '../capture-from-ledger.js';

// Session efd40ad9: a Codex turn merged main into its branch, 363 files. The
// before-states were cut at the first 300 by name, so the last 63 (packages/cli,
// pnpm-lock.yaml) were measured from the turn's own start and billed to it.
const BASE = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const files = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(4, '0')}.ts`);

function deps(changed: string[], batched: boolean): InheritedWindowDeps {
  return {
    listWindow: () => [MAIN],
    isOwnWork: () => false,
    changedFiles: () => changed,
    readAtRev: (_sha, file) => `main ${file}\n`,
    isAncestor: () => false,
    baselineCommit: () => BASE,
    changedFilesBetween: () => changed,
    ...(batched && { primeReadAtRev: () => {} }),
    fileBudget: 300,
  };
}

describe('before-states for a turn that merged in many files', () => {
  it('reads every file the merge brought in when reads are batched', () => {
    const out = inheritedBeforeStates(BASE, deps(files(363), true));
    expect(out.size).toBe(363);
    expect(out.get('f0362.ts')).toBe('main f0362.ts\n');
  });

  it('gives up rather than answer for only some of them', () => {
    expect(() => inheritedBeforeStates(BASE, deps(files(363), false))).toThrow(InheritedTooLarge);
    const walk = { ...deps(files(363), false), changedFilesBetween: undefined };
    expect(() => inheritedBeforeStates(BASE, walk)).toThrow(InheritedTooLarge);
  });

  let store = '';
  beforeAll(() => { store = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-large-merge-')); });
  afterAll(() => { fs.rmSync(store, { recursive: true, force: true }); });

  const run = (inheritedBefore: () => Map<string, string | null>) => {
    const log = serializeTurnMark({ at: 1, turnId: 'T1' })
      + serializeRecord({ file: 'f0362.ts', at: 2, hash: putSnapshot(store, 'main f0362.ts\n').hash, retained: true });
    const pm: Record<string, unknown> = { promptIndex: 0, filesChanged: ['pnpm-lock.yaml'], diff: 'kept' };
    const seen: Array<{ reason?: string }> = [];
    const replaced = applyLedgerToMappings(
      { writeJournalPath: '/does/not/matter', writeSnapshotDir: store, promptTurnIds: ['T1'], prePromptSha: BASE },
      [pm as never],
      {
        readEntries: () => parseJournalEntries(log),
        readAtRev: () => null,
        inheritedBefore,
        observe: (_i: number, o: unknown) => seen.push(o as { reason?: string }),
      },
    );
    return { replaced, pm, seen };
  };

  it('without the guard, the merged-in file reads as the turn\'s own creation', () => {
    const { replaced, pm } = run(() => new Map());
    expect(replaced).toBe(1);
    expect(pm.filesChanged).toEqual(['f0362.ts']);
  });

  it('the ledger declines the turn instead of billing it the unread files', () => {
    const { replaced, pm, seen } = run(() => { throw new InheritedTooLarge(6000); });
    expect(replaced).toBe(0);
    expect(pm.filesChanged).toEqual(['pnpm-lock.yaml']);
    expect(pm.diff).toBe('kept');
    expect(seen.map((o) => o.reason)).toContain('the turn inherited more files than can be read');
  });
});
