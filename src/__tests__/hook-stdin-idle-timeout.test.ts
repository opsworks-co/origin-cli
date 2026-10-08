// readStdin used to wait for 'end' with no timer at all: an agent that never
// closed its end of the hook's stdin pipe blocked the hook until the agent
// killed it. It now gives up after an IDLE timeout — reset on every chunk, so a
// large payload arriving slowly in pieces is never truncated.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import { readStdin } from '../commands/hooks.js';

describe('readStdin — idle timeout', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('resolves empty when the pipe stays open and silent', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    let settled = false;
    const p = readStdin(stream, 3000).then((v) => { settled = true; return v; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({});
  });

  it('resolves with the payload when data arrives but the pipe never closes', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const p = readStdin(stream, 3000);
    stream.write(JSON.stringify({ session_id: 'abc', cwd: '/repo' }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toEqual({ session_id: 'abc', cwd: '/repo' });
  });

  it('does not truncate a payload that arrives in slow chunks (timer is idle, not total)', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const payload = { transcript: 'x'.repeat(50_000), session_id: 'big' };
    const json = JSON.stringify(payload);
    const p = readStdin(stream, 3000);
    // Ten chunks, 2s apart: 18s total, far past a 3s total cap.
    const step = Math.ceil(json.length / 10);
    for (let i = 0; i < json.length; i += step) {
      stream.write(json.slice(i, i + step));
      await vi.advanceTimersByTimeAsync(2000);
    }
    stream.end();
    expect(await p).toEqual(payload);
  });

  it('resolves on end as before, without waiting for the timer', async () => {
    const stream = new PassThrough();
    const p = readStdin(stream, 60_000);
    stream.end('﻿{"session_id":"s1"}');
    expect(await p).toEqual({ session_id: 's1' });
  });

  it('resolves empty immediately for a TTY', async () => {
    const stream = Object.assign(new PassThrough(), { isTTY: true });
    expect(await readStdin(stream, 60_000)).toEqual({});
  });
});
