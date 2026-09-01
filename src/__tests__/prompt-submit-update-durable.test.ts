/**
 * The turn's capture was dropped whenever the API was slow.
 *
 * user-prompt-submit sends the turn's prompt text, transcript and per-prompt
 * diffs, then returns without awaiting — deliberately, because Codex kills that
 * hook after 10s. The send ran on the shared 8s timeout and aborted whenever the
 * API was busy or restarting, which during a burst of deploys is constant:
 *
 *   [user-prompt-submit] background updateSession failed (non-fatal)
 *                        {"message":"This operation was aborted"}
 *
 * 72 of those in one machine's hook log, each one a turn's capture thrown away.
 *
 * The old comment argued nothing was lost because "the heartbeat daemon
 * re-sends the same payload on its own tick". That holds only while a heartbeat
 * is running — not for a session's final turn, and not when the daemon is gone.
 *
 * durableUpdate persists a retriable failure to ~/.origin/queue and a later
 * hook replays it, draining that session's backlog in order first. The queue,
 * its drain and this wrapper were all built and tested for exactly this, and
 * simply never wired to this call site.
 *
 * A source guard: driving the hook for real needs git, fs, env and api stood up,
 * and what matters here is which function the call site names.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks.ts'),
  'utf-8',
);

/** The payload block that carries a turn's capture, wherever it is sent from. */
const captureSends = src.match(/\w+\(state\.sessionId, \{\s*\n\s*prompt: joinedPrompt/g) || [];

describe('user-prompt-submit session update', () => {
  it('sends the turn capture through the durable wrapper', () => {
    expect(captureSends.length).toBeGreaterThan(0);
    for (const call of captureSends) {
      expect(call).toContain('durableUpdate');
      expect(call).not.toContain('api.updateSession');
    }
  });

  it('keeps the durable wrapper bound to the queue', () => {
    // durableUpdate is what enqueues on a retriable failure; if it stopped
    // delegating, the call site above would be durable in name only.
    expect(src).toMatch(/const durableUpdate = [^;]*durableUpdateSession\(/s);
  });

  it('still drains the queue, or nothing ever replays', () => {
    expect(src).toContain('drainUpdateQueue(');
  });
});
