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
