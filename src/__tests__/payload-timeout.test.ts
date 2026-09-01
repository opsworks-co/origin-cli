// `updateSession` carries a session's ENTIRE state — every prompt diff, all
// editsJson, commit attribution, the transcript — and it grows all session
// long. On the 8s default sized for an agent hook's ~10s budget, it eventually
// cannot finish, and because the watcher rebuilds the same payload every poll
// it then fails at exactly 8s FOREVER. The server's copy freezes at that
// moment while local capture keeps working perfectly, so nothing looks broken
// until someone compares the two.
//
// Observed on session 1271f66c: four consecutive `AbortError`, each exactly
// 8.0s after its payload was built (23:01:39→47, 23:06:10→18, 23:31:22→30,
// 23:33:07→15), while the watcher log showed the turn captured correctly with
// its 7 files and its commit. 35 minutes stale on the dashboard, nothing wrong
// with the capture at all.

import { describe, it, expect } from 'vitest';
import {
  timeoutForPayload,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_PAYLOAD_TIMEOUT_MS,
  PAYLOAD_TIMEOUT_BYTES_PER_SEC,
} from '../fetch-timeout';

describe('timeoutForPayload', () => {
  it('leaves a small body on the hook-sized default', () => {
    // A branch update or a status flip must keep failing FAST: hooks are killed
    // at ~10s, and a kill skips the durable-retry enqueue entirely.
    expect(timeoutForPayload(0)).toBe(DEFAULT_FETCH_TIMEOUT_MS);
    expect(timeoutForPayload(200)).toBeLessThanOrEqual(DEFAULT_FETCH_TIMEOUT_MS + 20);
  });

  it('gives the payload that actually stalled enough room to land', () => {
    // ~494 KB is the size of a real queued capture from this machine. Under the
    // old fixed 8s it aborted every time.
    const t = timeoutForPayload(494_000);
    expect(t).toBeGreaterThan(DEFAULT_FETCH_TIMEOUT_MS);
    expect(t).toBeGreaterThanOrEqual(25_000);
    expect(t).toBeLessThanOrEqual(MAX_PAYLOAD_TIMEOUT_MS);
  });

  it('scales monotonically with size', () => {
    const sizes = [10_000, 100_000, 250_000, 500_000];
    const times = sizes.map(timeoutForPayload);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });

  it('caps, so a runaway payload cannot hang the poll indefinitely', () => {
    expect(timeoutForPayload(50_000_000)).toBe(MAX_PAYLOAD_TIMEOUT_MS);
    expect(MAX_PAYLOAD_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('never returns less than the default, whatever it is handed', () => {
    // A negative or NaN length must not produce a timeout SHORTER than the
    // baseline — that would turn a measurement bug into a capture outage.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(timeoutForPayload(bad as number)).toBeGreaterThanOrEqual(DEFAULT_FETCH_TIMEOUT_MS);
    }
  });

  it('uses an allowance that covers server processing, not just transfer', () => {
    // The constant is deliberately far below real bandwidth: the API has to
    // parse and persist the whole session, which dominates for a big payload.
    expect(PAYLOAD_TIMEOUT_BYTES_PER_SEC).toBeLessThanOrEqual(100_000);
  });
});
