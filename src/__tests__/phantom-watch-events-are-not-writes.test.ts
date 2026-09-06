/**
 * A watcher event is not proof that a file was written.
 *
 * `fs.watch(recursive)` on Windows fires for files whose bytes never changed.
 * Session bd3c110a turn 2, from that session's own journal:
 *
 *   14:24:41  .claude/launch.json
 *   14:24:41  dev.sh
 *   14:24:41  docker-start.sh
 *   14:24:41  fly.dev.toml
 *   14:24:41  fly.toml
 *   14:24:41  pnpm-workspace.yaml
 *   14:24:41  stop.sh
 *
 * Seven files in one second. Their mtimes on disk were 2026-08-05 and
 * 2026-07-25 — nothing had written them. Each was the turn's first sighting, so
 * `beforeHash` was null; with no baseline to consult, `before` stayed null and
 * renderFileDiff emitted the whole file as an add. The turn ran `git commit`,
 * `gh pr create` and a version bump — it edited one file — and was recorded as
 * 11 files, +684/-0. Zero deletions is the signature.
 *
 * The file's own mtime is the discriminator, and it needs no baseline.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { serializeRecord, serializeTurnMark, parseJournalEntries } from '../write-journal.js';
import { putSnapshot } from '../write-journal-store.js';
import { captureTurnFromLedger } from '../capture-from-ledger.js';
import { verifyTurn } from '../capture-verify.js';

let tmp = '';
let store = '';
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-phantom-'));
  store = path.join(tmp, 'snap');
  fs.mkdirSync(store, { recursive: true });
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const put = (content: string): string => putSnapshot(store, content).hash;
const t = (id: string, at: number): string => serializeTurnMark({ at, turnId: id });
const w = (file: string, at: number, hash: string, mtime?: number): string =>
  serializeRecord({ file, at, hash, retained: true, ...(mtime !== undefined ? { mtime } : {}) });

const capture = (log: string, turnId: string) =>
  captureTurnFromLedger({ entries: parseJournalEntries(log), turnId, snapshotDir: store });

const TURN_AT = 1_788_360_244_000; // 14:24:04, the turn's mark
const LAST_MONTH = 1_785_931_718_000; // the mtime fly.toml actually carried

describe('a watch event with an old mtime is not this turn s write', () => {
  it('drops the phantom and bills nothing for it', () => {
    const log =
      t('T2', TURN_AT)
      + w('fly.toml', TURN_AT + 37_000, put('a\nb\nc\n'), LAST_MONTH)
      + w('dev.sh', TURN_AT + 37_000, put('x\ny\n'), LAST_MONTH);
    const cap = capture(log, 'T2')!;
    expect(cap).not.toBeNull();
    expect(cap.filesChanged).toEqual([]);
    expect(cap.linesAdded).toBe(0);
    expect(cap.linesRemoved).toBe(0);
    // Not "unavailable" either — there is nothing to report, the file did not
    // change. Saying it did in a quieter voice is the same wrong row.
    expect(cap.contentUnavailable).toEqual([]);
  });

  it('keeps a real write in the same turn as the phantoms', () => {
    const log =
      t('T2', TURN_AT)
      + w('fly.toml', TURN_AT + 37_000, put('a\nb\nc\n'), LAST_MONTH)
      + w('packages/cli/package.json', TURN_AT + 73_000, put('{\n"v":2\n}\n'), TURN_AT + 73_000);
    const cap = capture(log, 'T2')!;
    expect(cap.filesChanged).toEqual(['packages/cli/package.json']);
    expect(cap.linesAdded).toBeGreaterThan(0);
    expect(verifyTurn({
      promptIndex: 0,
      filesChanged: cap.filesChanged,
      diff: cap.diff,
      linesAdded: cap.linesAdded,
      linesRemoved: cap.linesRemoved,
      contentUnavailableFiles: cap.contentUnavailable,
    })).toEqual([]);
  });

  it('keeps a write whose mtime lands inside the turn', () => {
    const log = t('T1', TURN_AT) + w('a.ts', TURN_AT + 5_000, put('one\n'), TURN_AT + 5_000);
    expect(capture(log, 'T1')!.filesChanged).toEqual(['a.ts']);
  });

  it('keeps a write whose mtime exactly equals the mark', () => {
    // The turn's own first write can land in the same millisecond as its mark.
    const log = t('T1', TURN_AT) + w('a.ts', TURN_AT, put('one\n'), TURN_AT);
    expect(capture(log, 'T1')!.filesChanged).toEqual(['a.ts']);
  });

  it('keeps a write whose mtime rounds BACKWARDS past the mark', () => {
    // The two timestamps come from different clocks: markTurn reads Date.now(),
    // an inode's mtime is stamped by the kernel's coarse realtime clock. On
    // Linux that rounds back a few ms, so a file written 1ms after the mark can
    // report an mtime before it. CI found this — new-agent-day-one.test.ts fails
    // on the Linux runner and passes on Windows.
    const log = t('T1', TURN_AT) + w('a.ts', TURN_AT + 2, put('one\n'), TURN_AT - 8);
    expect(capture(log, 'T1')!.filesChanged).toEqual(['a.ts']);
  });

  it('still drops a phantom just outside the slack', () => {
    const log = t('T1', TURN_AT) + w('fly.toml', TURN_AT + 1_000, put('a\nb\n'), TURN_AT - 61_000);
    expect(capture(log, 'T1')!.filesChanged).toEqual([]);
  });

  it('keeps a record with NO mtime — silence is not evidence', () => {
    // Every journal written before the field existed. These must behave exactly
    // as they did, or the fix would erase history it cannot judge.
    const log = t('T1', TURN_AT) + w('a.ts', TURN_AT + 5_000, put('one\n'));
    expect(capture(log, 'T1')!.filesChanged).toEqual(['a.ts']);
  });

  it('keeps a DELETE with an old mtime — the stat is of a file that is gone', () => {
    const log =
      t('T1', TURN_AT)
      + serializeRecord({ file: 'a.ts', at: TURN_AT + 1_000, hash: put('one\n'), retained: true, mtime: TURN_AT + 1_000 })
      + t('T2', TURN_AT + 10_000)
      + serializeRecord({ file: 'a.ts', at: TURN_AT + 11_000, gone: true, mtime: LAST_MONTH });
    const cap = capture(log, 'T2')!;
    expect(cap.filesChanged).toEqual(['a.ts']);
  });
});
