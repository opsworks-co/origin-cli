// Regression: an OLD id-less session became a "magnet" — once one existed,
// every later Codex/Cursor conversation in the repo folded onto it (b7a2e816:
// a 22h Windows session swallowing a fresh Mac conversation and inflating its
// diff). selectReusableSession prefers an exact thread-id match and refuses to
// adopt a stale id-less session when a concrete incoming id is known.

import { describe, it, expect } from 'vitest';
import { selectReusableSession, ADOPT_IDLESS_MAX_AGE_MS } from '../commands/hooks.js';

const NOW = 1_700_000_000_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type S = { sessionId: string; agentSessionId?: string | null; startedAt?: string };

describe('selectReusableSession', () => {
  it('does NOT adopt a stale id-less session when the incoming id is known (the magnet)', () => {
    const magnet: S = { sessionId: 'b7a2e816', agentSessionId: '', startedAt: iso(22 * 60 * 60 * 1000) };
    const picked = selectReusableSession([magnet], 'codex', 'thread-mac-new', NOW);
    expect(picked).toBeNull(); // → caller starts a fresh session (rotation)
  });

  it('prefers an exact thread-id match over an earlier id-less row', () => {
    const magnet: S = { sessionId: 'old', agentSessionId: '', startedAt: iso(22 * 60 * 60 * 1000) };
    const mine: S = { sessionId: 'mine', agentSessionId: 'thread-abc', startedAt: iso(60_000) };
    const picked = selectReusableSession([magnet, mine], 'codex', 'thread-abc', NOW);
    expect(picked?.sessionId).toBe('mine');
  });

  it('STILL adopts a RECENT id-less session (same conversation, id not resolved yet)', () => {
    const fresh: S = { sessionId: 'fresh', agentSessionId: '', startedAt: iso(30_000) };
    const picked = selectReusableSession([fresh], 'codex', 'thread-mac-new', NOW);
    expect(picked?.sessionId).toBe('fresh');
  });

  it('adopts an id-less session when the incoming id is ALSO unknown (rapid session-start fires)', () => {
    const old: S = { sessionId: 'old', agentSessionId: '', startedAt: iso(22 * 60 * 60 * 1000) };
    // No incoming id at all → fall back to plain adoption to avoid twins.
    const picked = selectReusableSession([old], 'codex', '', NOW);
    expect(picked?.sessionId).toBe('old');
  });

  it('never reuses a session whose known id DIFFERS from the incoming id', () => {
    const other: S = { sessionId: 'other', agentSessionId: 'thread-other', startedAt: iso(60_000) };
    expect(selectReusableSession([other], 'codex', 'thread-mine', NOW)).toBeNull();
  });

  it('honours the recency boundary exactly', () => {
    const justInside: S = { sessionId: 'in', agentSessionId: '', startedAt: iso(ADOPT_IDLESS_MAX_AGE_MS - 1_000) };
    const justOutside: S = { sessionId: 'out', agentSessionId: '', startedAt: iso(ADOPT_IDLESS_MAX_AGE_MS + 1_000) };
    expect(selectReusableSession([justInside], 'codex', 'tid', NOW)?.sessionId).toBe('in');
    expect(selectReusableSession([justOutside], 'codex', 'tid', NOW)).toBeNull();
  });
});
