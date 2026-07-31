import { describe, it, expect, vi } from 'vitest';
import { pollForBakeOff, MAX_CONSECUTIVE_POLL_FAILURES } from '../commands/benchmark-runner.js';

const bake = { id: 'b1', shortId: 'b1', prompt: 'p', title: null, arms: [] };

describe('pollForBakeOff — poll classification + transient-blip retry', () => {
  it('classifies a claimed bake-off', async () => {
    const res = await pollForBakeOff(async () => ({ bakeOff: bake }));
    expect(res).toEqual({ status: 'claimed', bakeOff: bake });
  });

  it('classifies an empty queue as idle', async () => {
    const res = await pollForBakeOff(async () => ({ bakeOff: null }));
    expect(res.status).toBe('idle');
  });

  it('retries once, so a single transient failure still succeeds', async () => {
    const claim = vi.fn()
      .mockRejectedValueOnce(new Error('This operation was aborted'))
      .mockResolvedValueOnce({ bakeOff: null });
    const res = await pollForBakeOff(claim);
    expect(res.status).toBe('idle');
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('reports poll-failed when both attempts throw', async () => {
    const claim = vi.fn().mockRejectedValue(new Error('This operation was aborted'));
    const res = await pollForBakeOff(claim);
    expect(res.status).toBe('poll-failed');
    if (res.status === 'poll-failed') expect(res.error).toMatch(/aborted/i);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('exposes a sane self-heal threshold', () => {
    // The loop exits after this many consecutive poll failures so the service
    // manager respawns a fresh process (clears a wedged connection pool).
    expect(MAX_CONSECUTIVE_POLL_FAILURES).toBeGreaterThanOrEqual(3);
  });
});
