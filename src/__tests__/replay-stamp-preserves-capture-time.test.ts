/**
 * A replayed mapping keeps the time it was CAPTURED, and always carries a
 * stamp the server can read.
 *
 * Persisted mappings store `capturedAt` as an ISO string — the form the
 * release gate grades. The server's ordering contract is epoch milliseconds
 * and it reads the field with `Number()`, so a string becomes NaN, is nulled,
 * and the payload turns EXEMPT from the staleness check: it then outranks
 * every producer that stamps properly. Both replay paths (`session-end` and
 * `sessions sync`) go through one helper so neither can drift.
 */
import { describe, it, expect } from 'vitest';
import { newCaptureStamp, stampReplayedMapping } from '../capture-stamp.js';

const stamp = { captureId: 'sy_deadbeefdeadbeef', capturedAt: 1_790_000_000_000 };

describe('stampReplayedMapping', () => {
  it('converts a persisted ISO capturedAt to epoch ms', () => {
    const iso = '2026-09-21T18:42:11.123Z';
    const out = stampReplayedMapping({ promptIndex: 3, capturedAt: iso }, stamp);
    expect(out.capturedAt).toBe(Date.parse(iso));
    expect(typeof out.capturedAt).toBe('number');
    expect(out.captureId).toBe(stamp.captureId);
  });

  it('keeps a numeric capturedAt exactly', () => {
    const out = stampReplayedMapping({ promptIndex: 0, capturedAt: 1_789_999_999_999 }, stamp);
    expect(out.capturedAt).toBe(1_789_999_999_999);
  });

  it('falls back to the replay stamp when nothing readable is stored', () => {
    // The branch that decides whether a legacy row is exempt or merely late.
    for (const bad of [undefined, null, '', 'not-a-date', 0, -5, NaN, {}]) {
      const out = stampReplayedMapping({ promptIndex: 1, capturedAt: bad as any }, stamp);
      expect(out.capturedAt, `capturedAt=${String(bad)}`).toBe(stamp.capturedAt);
      expect(Number.isFinite(out.capturedAt)).toBe(true);
    }
  });

  it('the stamp wins over a stale one already on the mapping', () => {
    const out = stampReplayedMapping({ promptIndex: 2, captureId: 'old_1', capturedAt: '2026-01-01T00:00:00.000Z' }, stamp);
    expect(out.captureId).toBe(stamp.captureId);
    expect(out.capturedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('leaves the rest of the mapping untouched', () => {
    const out = stampReplayedMapping({ promptIndex: 7, turnId: 't_7', filesChanged: ['a.ts'], diff: '@@' }, stamp);
    expect(out.promptIndex).toBe(7);
    expect(out.turnId).toBe('t_7');
    expect(out.filesChanged).toEqual(['a.ts']);
    expect(out.diff).toBe('@@');
  });

  it('every stamp the server reads is a finite positive number', () => {
    const s = newCaptureStamp('sy');
    expect(s.captureId.startsWith('sy_')).toBe(true);
    expect(Number.isFinite(s.capturedAt) && s.capturedAt > 0).toBe(true);
  });
});
