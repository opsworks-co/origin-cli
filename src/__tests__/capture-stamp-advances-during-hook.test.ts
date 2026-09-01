// `capturedAt` must describe when the content was captured, not when the hook
// process booted.
//
// It was a module-load constant, on the assumption that a hook is short-lived
// enough for start time and send time to be one instant. The Stop hook is not:
// it parses the transcript, captures git state, normalizes turn windows and
// builds shadow commits before it sends. In prod session aea8c4d1 that gap was
// 19:29:58.8 -> 19:30:03.7, about five seconds.
//
// The heartbeat re-sends the CURRENT turn every 30s with a FRESH stamp
// (newCaptureStamp('hb')), so a tick inside that window carried a newer
// capturedAt than the Stop already in flight. The server's staleness rule then
// dropped the Stop's complete capture — 11 files, a 67 KB diff — while
// editsJson and turnId, which are not staleness-gated, landed anyway. Those
// rows ended up with mid-turn line counts underneath a Stop-only editsJson.
//
// capture-stamp.ts already documents this trap for long-lived producers; it
// applies equally to any hook that does work before sending.

import { describe, it, expect } from 'vitest';
import { captureStamp } from '../commands/hooks.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('captureStamp', () => {
  it('advances across the work a hook does before it sends', async () => {
    const atProcessStart = captureStamp();
    await sleep(25);
    const atSend = captureStamp();

    // The whole bug: these used to be equal, so a producer that stamped
    // honestly during the gap always looked fresher.
    expect(atSend.capturedAt).toBeGreaterThan(atProcessStart.capturedAt);
  });

  it('keeps ONE capture id per process — identity is still process-scoped', async () => {
    const a = captureStamp();
    await sleep(5);
    const b = captureStamp();
    expect(b.captureId).toBe(a.captureId);
    expect(a.captureId).toMatch(/^c_[0-9a-f]{16}$/);
  });

  it('beats a stamp minted before the hook started working', async () => {
    // A heartbeat tick that fired while the Stop was still capturing.
    const heartbeatTick = Date.now();
    await sleep(25);
    // The Stop sends after its work — it must not look older than that tick.
    expect(captureStamp().capturedAt).toBeGreaterThan(heartbeatTick);
  });
});
