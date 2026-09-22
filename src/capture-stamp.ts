/**
 * Provenance every promptChanges payload carries: WHICH capture produced it,
 * and WHEN that capture ran.
 *
 * The server uses the pair to order two writes to the same row (#1276): a
 * payload older than the content already stored cannot replace it. The rule
 * engages only when BOTH sides carry a timestamp, which makes an unstamped
 * producer not "unversioned" but EXEMPT — it silently outranks every producer
 * that plays by the rules.
 *
 * That is how prod session fdf299d3 got rows whose commitSha came from one
 * capture and whose files and line counts came from another: hooks.ts stamped,
 * and the transcript watcher — which re-sends every prompt in the session
 * every 8 seconds — did not. Its recomputation of turn N landed on whatever
 * row held index N, overwriting fresher hook-written content. Turn 15 ended up
 * holding turn 20's three files and its +377/-0.
 *
 * One helper so the next producer has nothing to decide. `capture-stamp-guard`
 * fails the build if a sender skips it.
 */
import crypto from 'crypto';

export interface CaptureStamp {
  captureId: string;
  capturedAt: number;
}

function mint(prefix: string): CaptureStamp {
  return {
    captureId: `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    capturedAt: Date.now(),
  };
}

/**
 * A fresh stamp for ONE send, from a long-lived process.
 *
 * Watchers and the heartbeat run for hours and capture continuously, so a
 * process-scoped constant would label hundreds of distinct captures
 * identically and freeze `capturedAt` at start-up — making every later pass
 * look older than content it had itself just written, and (once ordering is
 * enforced) unable to correct its own mistakes.
 *
 * `prefix` is for reading logs, not for logic: `w` watcher, `cw` codex watcher,
 * `hb` heartbeat, `rc` recapture.
 */
export function newCaptureStamp(prefix = 'c'): CaptureStamp {
  return mint(prefix);
}

/**
 * Stamp a mapping that is being REPLAYED from disk.
 *
 * Persisted mappings carry an ISO-string `capturedAt` — that is the form the
 * release gate grades — while the server's ordering contract is epoch
 * milliseconds and reads the field with `Number()`. A string therefore lands
 * as NaN, is nulled, and the whole payload becomes EXEMPT from the staleness
 * check: it outranks every producer that stamps properly. That is the
 * fdf299d3 shape described above, reached from a different direction.
 *
 * So: keep the time the content was really captured, and fall back to the
 * replay's own stamp only for a legacy row with nothing readable. The stamp
 * spreads AFTER the mapping so a stale field on disk cannot overwrite it.
 */
export function stampReplayedMapping<T extends Record<string, any>>(
  mapping: T,
  stamp: CaptureStamp,
): T & CaptureStamp {
  const savedAt = typeof mapping.capturedAt === 'number'
    ? mapping.capturedAt
    : (typeof mapping.capturedAt === 'string' ? Date.parse(mapping.capturedAt) : NaN);
  return {
    ...mapping,
    ...stamp,
    capturedAt: Number.isFinite(savedAt) && savedAt > 0 ? Math.floor(savedAt) : stamp.capturedAt,
  };
}
