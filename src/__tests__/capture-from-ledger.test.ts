// Stage 2: the ledger as the source of a turn's capture.
//
// The property worth proving above all others: a capture built from the ledger
// CANNOT produce a stage 0 violation. `filesChanged` is read back off the
// emitted diff and the line counts are counted off that same text, so the three
// cannot disagree — four of stage 0's six violation classes become unreachable
// rather than fixed. Every test here ends by running `verifyTurn` over the
// result.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { serializeRecord, serializeTurnMark, parseJournalEntries } from '../write-journal.js';
import { putSnapshot } from '../write-journal-store.js';
import { captureTurnFromLedger, ledgerCaptureIsUsable, applyLedgerToMappings } from '../capture-from-ledger.js';
import { verifyTurn, parseUnifiedDiff } from '../capture-verify.js';

let tmp = '';
let store = '';
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-stage2-'));
  store = path.join(tmp, 'snap');
  fs.mkdirSync(store, { recursive: true });
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Put content in the store and hand back a write record line for it. */
const put = (content: string): string => putSnapshot(store, content).hash;
const w = (file: string, at: number, hash: string | null, gone = false): string =>
  serializeRecord({ file, at, ...(hash ? { hash, retained: true } : {}), ...(gone ? { gone: true } : {}) });
const t = (id: string, at: number): string => serializeTurnMark({ at, turnId: id });

const capture = (log: string, turnId: string, extra: Partial<Parameters<typeof captureTurnFromLedger>[0]> = {}) =>
  captureTurnFromLedger({ entries: parseJournalEntries(log), turnId, snapshotDir: store, ...extra });

/** Every capture this module produces must survive the stage 0 gate. */
const expectSelfConsistent = (cap: NonNullable<ReturnType<typeof capture>>) => {
  expect(verifyTurn({
    promptIndex: 0,
    filesChanged: cap.filesChanged,
    diff: cap.diff,
    linesAdded: cap.linesAdded,
    linesRemoved: cap.linesRemoved,
    contentUnavailableFiles: cap.contentUnavailable,
  })).toEqual([]);
};

describe('captureTurnFromLedger', () => {
  it('returns null for a turn the journal never marked, so the caller falls back', () => {
    // Critically NOT an empty capture: "no mark" is unknown, not "wrote nothing".
    expect(capture(t('T1', 1) + w('a.ts', 2, put('x\n')), 'NOPE')).toBeNull();
  });

  it('renders a turn that created a file', () => {
    const cap = capture(t('T1', 1) + w('a.ts', 2, put('one\n')), 'T1');
    expect(cap).not.toBeNull();
    expect(cap!.filesChanged).toEqual(['a.ts']);
    expect(cap!.linesAdded).toBe(1);
    expect(cap!.linesRemoved).toBe(0);
    expect(parseUnifiedDiff(cap!.diff).files[0]).toMatchObject({ isNew: true });
    expectSelfConsistent(cap!);
  });

  it('gives a later turn ONLY its own change', () => {
    const v1 = put('one\n');
    const v2 = put('one\ntwo\n');
    const log = t('T1', 1) + w('a.ts', 2, v1) + t('T2', 3) + w('a.ts', 4, v2);
    const cap = capture(log, 'T2')!;
    expect(cap.linesAdded).toBe(1);
    expect(cap.diff).toContain('+two');
    expect(cap.diff).not.toContain('+one');   // turn 1's work is CONTEXT, not credit
    expectSelfConsistent(cap);
  });

  it('makes the cumulative-diff defect unreachable across many turns', () => {
    // Stage 0's worked example, in miniature: with a stale baseline each turn
    // re-reported its predecessors. Here every turn reports exactly one line.
    let log = '';
    let content = '';
    for (let i = 1; i <= 5; i++) {
      content += `line ${i}\n`;
      log += t(`T${i}`, i * 10) + w('a.ts', i * 10 + 1, put(content));
    }
    const entries = parseJournalEntries(log);
    for (let i = 1; i <= 5; i++) {
      const cap = captureTurnFromLedger({ entries, turnId: `T${i}`, snapshotDir: store })!;
      expect(cap.linesAdded, `turn ${i}`).toBe(1);
      expect(cap.linesRemoved, `turn ${i}`).toBe(0);
      expectSelfConsistent(cap);
    }
  });

  it('renders a deletion', () => {
    const log = t('T1', 1) + w('a.ts', 2, put('bye\n')) + t('T2', 3) + w('a.ts', 4, null, true);
    const cap = capture(log, 'T2')!;
    expect(cap.filesChanged).toEqual(['a.ts']);
    expect(cap.linesRemoved).toBe(1);
    expect(cap.diff).toContain('+++ /dev/null');
    expectSelfConsistent(cap);
  });

  it('reports a net-zero turn as work with no change, not as a phantom edit', () => {
    const v1 = put('same\n');
    const v2 = put('changed\n');
    const log = t('T1', 1) + w('a.ts', 2, v1)
              + t('T2', 3) + w('a.ts', 4, v2) + w('a.ts', 5, v1);
    const cap = capture(log, 'T2')!;
    expect(cap.netZero).toEqual(['a.ts']);
    expect(cap.filesChanged).toEqual([]);   // nothing to show
    expect(cap.diff).toBe('');
    expect(ledgerCaptureIsUsable(cap)).toBe(true); // but the turn DID work
    expectSelfConsistent(cap);
  });

  it('resolves a first-seen file from the baseline, not from nothing', () => {
    const log = t('T1', 1) + w('a.ts', 2, put('old\nnew\n'));
    const cap = capture(log, 'T1', {
      baselineSha: 'abc123',
      readAtRev: (sha, file) => (sha === 'abc123' && file === 'a.ts' ? 'old\n' : null),
    })!;
    // Without the baseline this would read as a 2-line creation.
    expect(cap.linesAdded).toBe(1);
    expect(cap.diff).toContain('+new');
    expect(parseUnifiedDiff(cap.diff).files[0].isNew).toBe(false);
    expectSelfConsistent(cap);
  });

  it('treats a baseline miss as a creation, which is what it means', () => {
    const log = t('T1', 1) + w('brand-new.ts', 2, put('hello\n'));
    const cap = capture(log, 'T1', { baselineSha: 'abc123', readAtRev: () => null })!;
    expect(parseUnifiedDiff(cap.diff).files[0].isNew).toBe(true);
    expectSelfConsistent(cap);
  });

  it('reports an unretained file instead of dropping it or listing it bare', () => {
    // A hash the store never kept — binary, oversize, or a full store.
    const log = t('T1', 1) + w('big.bin', 2, 'f'.repeat(64));
    const cap = capture(log, 'T1')!;
    expect(cap.contentUnavailable).toEqual(['big.bin']);
    expect(cap.filesChanged).toEqual([]);  // never named without a diff section
    expect(cap.complete).toBe(false);
    expect(ledgerCaptureIsUsable(cap)).toBe(true);
    expectSelfConsistent(cap);  // and it still passes the gate
  });

  it('keeps the files it CAN resolve when another is unretained', () => {
    const log = t('T1', 1) + w('good.ts', 2, put('a\n')) + w('bad.bin', 3, 'f'.repeat(64));
    const cap = capture(log, 'T1')!;
    expect(cap.filesChanged).toEqual(['good.ts']);
    expect(cap.contentUnavailable).toEqual(['bad.bin']);
    expectSelfConsistent(cap);
  });

  it('never emits two sections for one file', () => {
    const log = t('T1', 1) + w('a.ts', 2, put('x\n')) + w('a.ts', 3, put('x\ny\n'));
    const cap = capture(log, 'T1')!;
    expect(parseUnifiedDiff(cap.diff).duplicateFiles).toEqual([]);
    expectSelfConsistent(cap);
  });

  it('counts lines off the diff it emitted, so they cannot disagree', () => {
    const log = t('T1', 1) + w('a.ts', 2, put('1\n2\n3\n'))
              + t('T2', 3) + w('a.ts', 4, put('1\nX\n3\nY\n'));
    const cap = capture(log, 'T2')!;
    const p = parseUnifiedDiff(cap.diff);
    const added = p.files.reduce((n, f) => n + f.added, 0);
    const removed = p.files.reduce((n, f) => n + f.removed, 0);
    expect(cap.linesAdded).toBe(added);
    expect(cap.linesRemoved).toBe(removed);
    expectSelfConsistent(cap);
  });
});

describe('ledgerCaptureIsUsable', () => {
  it('rejects null — an unmarked turn makes no claim', () => {
    expect(ledgerCaptureIsUsable(null)).toBe(false);
  });

  it('rejects an empty capture, because "nothing here" is not "nothing happened"', () => {
    // A watcher that never started looks exactly like a chat-only turn from
    // here. Claiming the turn on this evidence is how real work renders empty.
    const cap = capture(t('T1', 1), 'T1')!;
    expect(cap.filesChanged).toEqual([]);
    expect(ledgerCaptureIsUsable(cap)).toBe(false);
  });

  it('accepts a capture whose only finding is an unretained file', () => {
    const cap = capture(t('T1', 1) + w('b.bin', 2, 'f'.repeat(64)), 'T1')!;
    expect(ledgerCaptureIsUsable(cap)).toBe(true);
  });
});

// ─── the shared applier ─────────────────────────────────────────────────────
//
// Stop, the heartbeat and the transcript watcher all go through this. Each of
// them used to build its own per-turn capture independently, and every one of
// those is a chance to apply the ledger slightly differently — which is how
// this pipeline acquired fourteen producers to begin with.

describe('applyLedgerToMappings', () => {
  const journal = (log: string) => ({ readEntries: () => parseJournalEntries(log) });

  const ledgerState = (turnIds: string[]) => ({
    writeJournalPath: '/does/not/matter',
    writeSnapshotDir: store,
    promptTurnIds: turnIds,
  });

  it('replaces a mapping wholesale and marks its provenance', () => {
    const v1 = put('a\n');
    const v2 = put('a\nb\n');
    const log = t('T1', 1) + w('f.ts', 2, v1) + t('T2', 3) + w('f.ts', 4, v2);
    const pm: Record<string, unknown> = {
      promptIndex: 1,
      filesChanged: ['stale.ts'],
      diff: 'stale diff',
      uncommittedDiff: 'stale uncommitted',
      linesAdded: 999,
      linesRemoved: 999,
    };
    const n = applyLedgerToMappings(ledgerState(['T1', 'T2']), [pm as never], journal(log));
    expect(n).toBe(1);
    expect(pm.filesChanged).toEqual(['f.ts']);
    expect(pm.diff).toContain('+b');
    expect(pm.linesAdded).toBe(1);
    expect(pm.linesRemoved).toBe(0);
    expect(pm.diffSource).toBe('ledger');
    expect(pm.ledgerOwned).toBe(true);
  });

  it('clears uncommittedDiff to the EMPTY STRING, not undefined', () => {
    // `undefined` is dropped by JSON.stringify, so the field arrives ABSENT and
    // the server's "preserve existing on absent" rule keeps the stale value
    // forever. Only an explicit empty string clears it.
    const log = t('T1', 1) + w('f.ts', 2, put('x\n'));
    const pm: Record<string, unknown> = {
      promptIndex: 0, filesChanged: [], diff: '', uncommittedDiff: 'stale',
    };
    applyLedgerToMappings(ledgerState(['T1']), [pm as never], journal(log));
    expect(pm.uncommittedDiff).toBe('');
    expect(JSON.parse(JSON.stringify(pm))).toHaveProperty('uncommittedDiff', '');
  });

  it('leaves a mapping untouched when the journal never marked its turn', () => {
    const log = t('T1', 1) + w('f.ts', 2, put('x\n'));
    const pm: Record<string, unknown> = {
      promptIndex: 1, filesChanged: ['kept.ts'], diff: 'kept', uncommittedDiff: 'kept-unc',
    };
    // promptIndex 1 has no turn id in the journal.
    const n = applyLedgerToMappings(ledgerState(['T1', 'T_unmarked']), [pm as never], journal(log));
    expect(n).toBe(0);
    expect(pm).toMatchObject({ filesChanged: ['kept.ts'], diff: 'kept', uncommittedDiff: 'kept-unc' });
    expect(pm.diffSource).toBeUndefined();
  });

  it('does nothing without a journal path or snapshot dir', () => {
    const pm = { promptIndex: 0, diff: 'kept' } as never;
    expect(applyLedgerToMappings({ writeSnapshotDir: store }, [pm], journal(''))).toBe(0);
    expect(applyLedgerToMappings({ writeJournalPath: '/x' }, [pm], journal(''))).toBe(0);
  });

  it('never throws when reading the journal fails', () => {
    const pm: Record<string, unknown> = { promptIndex: 0, diff: 'kept' };
    const n = applyLedgerToMappings(
      ledgerState(['T1']),
      [pm as never],
      { readEntries: () => { throw new Error('unreadable'); } },
    );
    expect(n).toBe(0);
    expect(pm.diff).toBe('kept');
  });

  it('carries the line counts so they cannot disagree with the diff', () => {
    // The heartbeat and the watcher both set these from their own
    // reconstruction; leaving them is the mosaic stage 0 reports.
    const log = t('T1', 1) + w('f.ts', 2, put('1\n2\n3\n'));
    const pm: Record<string, unknown> = { promptIndex: 0, linesAdded: 42, linesRemoved: 7 };
    applyLedgerToMappings(ledgerState(['T1']), [pm as never], journal(log));
    expect(pm.linesAdded).toBe(3);
    expect(pm.linesRemoved).toBe(0);
  });
});

// ─── generated files ────────────────────────────────────────────────────────

describe('gitignored files are not the turn\'s work', () => {
  const journal = (log: string) => ({ readEntries: () => parseJournalEntries(log) });

  it('drops a file git ignores', () => {
    // Observed on session 1ea7a947: the ledger listed
    // `packages/cli/src/build-info.ts` — written by the build on its way past,
    // gitignored, so it can never appear in a commit. Left in, it inflates the
    // turn's file count and manufactures a turn-vs-commit gap with no cause.
    const log = t('T1', 1) + w('src/real.ts', 2, put('real\n')) + w('src/build-info.ts', 3, put('gen\n'));
    const cap = captureTurnFromLedger({
      entries: parseJournalEntries(log), turnId: 'T1', snapshotDir: store,
      ignoredFiles: (files) => new Set(files.filter((f) => f.endsWith('build-info.ts'))),
    })!;
    expect(cap.filesChanged).toEqual(['src/real.ts']);
    expect(cap.diff).not.toContain('build-info');
    expectSelfConsistent(cap);
  });

  it('keeps everything when the question cannot be answered', () => {
    // Dropping a file the agent really wrote is far worse than keeping a
    // generated one: the first is work that vanishes, the second is a line item
    // a reader can dismiss. So a throwing predicate keeps every write.
    const log = t('T1', 1) + w('src/a.ts', 2, put('a\n'));
    const cap = captureTurnFromLedger({
      entries: parseJournalEntries(log), turnId: 'T1', snapshotDir: store,
      ignoredFiles: () => { throw new Error('no repo'); },
    })!;
    expect(cap.filesChanged).toEqual(['src/a.ts']);
  });

  it('keeps everything when no predicate is supplied', () => {
    const log = t('T1', 1) + w('src/a.ts', 2, put('a\n'));
    const cap = captureTurnFromLedger({
      entries: parseJournalEntries(log), turnId: 'T1', snapshotDir: store,
    })!;
    expect(cap.filesChanged).toEqual(['src/a.ts']);
  });

  it('passes the predicate through the shared applier', () => {
    const log = t('T1', 1) + w('src/a.ts', 2, put('a\n')) + w('dist/out.js', 3, put('built\n'));
    const pm: Record<string, unknown> = { promptIndex: 0 };
    applyLedgerToMappings(
      { writeJournalPath: '/x', writeSnapshotDir: store, promptTurnIds: ['T1'] },
      [pm as never],
      { ...journal(log), ignoredFiles: (files) => new Set(files.filter((f) => f.startsWith('dist/'))) },
    );
    expect(pm.filesChanged).toEqual(['src/a.ts']);
  });
});
