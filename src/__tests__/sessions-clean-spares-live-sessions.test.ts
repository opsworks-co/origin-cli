/**
 * `origin sessions clean` must only end sessions that are actually stale.
 *
 * It used to end EVERY RUNNING session it could see: `api.getSessions({status:
 * 'RUNNING'})` straight into `endSessionById` for each row, then
 * `stopHeartbeat` + `clearSessionState` over every local state file. There was
 * no age comparison anywhere in the function, despite the command describing
 * itself as ending "stale" sessions.
 *
 * On this machine several agents run at once, so clearing one overnight-stuck
 * row also killed the heartbeat and the `.git/origin-session-<tag>.json` state
 * file of every session currently working — silently breaking capture for the
 * rest of those sessions.
 *
 * The shape asserted here: one fresh session and one long-stale session go in;
 * only the stale one is ended, and only its heartbeat is stopped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ── The two sessions under test ──────────────────────────────────────────────
const FRESH_ID = 'fresh000-1111-2222-3333-444444444444';
const STALE_ID = 'stale000-5555-6666-7777-888888888888';

const endSessionById = vi.fn(async () => ({}));
const getSessions = vi.fn(async () => ({
  sessions: [
    // Working right now — last activity 5 minutes ago.
    { id: FRESH_ID, model: 'claude-opus-5', lastActivityAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
    // Stuck since three weeks ago, exactly the row this command exists to clear.
    { id: STALE_ID, model: 'claude-opus-5', lastActivityAt: new Date(Date.now() - 21 * DAY).toISOString() },
  ],
}));

const stopHeartbeat = vi.fn();
const clearSessionState = vi.fn();

const freshState = {
  sessionId: FRESH_ID,
  sessionTag: 'fresh',
  model: 'claude-opus-5',
  repoPath: '/repo',
  status: 'RUNNING',
  startedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
};
const staleState = {
  sessionId: STALE_ID,
  sessionTag: 'stale',
  model: 'claude-opus-5',
  repoPath: '/repo',
  status: 'RUNNING',
  startedAt: new Date(Date.now() - 21 * DAY).toISOString(),
};

vi.mock('../session-state.js', () => ({
  // No git root: keeps the origin-sessions branch path out of this test so the
  // assertions below are unambiguously about the platform + local-state paths.
  getGitRoot: () => null,
  listActiveSessions: () => [],
  listAllActiveSessions: () => [freshState, staleState],
  clearSessionState,
  stopHeartbeat,
  isHeartbeatAlive: () => false,
  // NEITHER session has a heartbeat — the Windows case: GUI agents fire no hooks,
  // so capture runs through the transcript watcher and no heartbeat pid exists.
  // The fresh session must still be protected, by isSessionAlive's other signals.
  hasHealthyHeartbeat: () => false,
  isSessionAlive: (s: any) => s.sessionId === FRESH_ID,
  sessionLastSignMs: (s: any) =>
    s.sessionId === FRESH_ID ? Date.now() - 5 * 60 * 1000 : Date.now() - 21 * DAY,
}));

vi.mock('../api.js', () => ({ api: { getSessions, endSessionById } }));
vi.mock('../config.js', () => ({
  isConnectedMode: () => true,
  loadAgentConfig: () => ({}),
}));

const { sessionCleanCommand, planSessionClean, DEFAULT_CLEAN_AGE_MS } = await import('../commands/sessions.js');

beforeEach(() => {
  endSessionById.mockClear();
  stopHeartbeat.mockClear();
  clearSessionState.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('origin sessions clean — only the stale session is ended', () => {
  it('ends the stale session and leaves the fresh one alone', async () => {
    await sessionCleanCommand({ all: true });

    // Platform: exactly one row ended, and it is the stale one.
    expect(endSessionById).toHaveBeenCalledTimes(1);
    expect(endSessionById).toHaveBeenCalledWith(STALE_ID);
    expect(endSessionById).not.toHaveBeenCalledWith(FRESH_ID);

    // Local state: only the stale session's heartbeat is stopped and only its
    // state file is cleared. This is the half that broke live capture.
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(stopHeartbeat).toHaveBeenCalledWith(STALE_ID);
    expect(clearSessionState).toHaveBeenCalledTimes(1);
    expect(clearSessionState).toHaveBeenCalledWith('/repo', 'stale');
  });

  it('--dry-run ends nothing at all', async () => {
    await sessionCleanCommand({ all: true, dryRun: true });

    expect(endSessionById).not.toHaveBeenCalled();
    expect(stopHeartbeat).not.toHaveBeenCalled();
    expect(clearSessionState).not.toHaveBeenCalled();
  });

  it('--force still refuses to end a live session (which here has NO heartbeat)', async () => {
    await sessionCleanCommand({ all: true, force: true });

    // Age is bypassed, so the stale one goes — but the fresh one is protected
    // by isSessionAlive, which no flag overrides. Note it has NO heartbeat: a
    // guard written against hasHealthyHeartbeat alone passes every other test
    // in this file and fails this one, which is exactly how the real hole was
    // found (`--dry-run --force` on this machine offered to clear two working
    // sessions, because Windows agents have no heartbeat pid).
    expect(endSessionById).toHaveBeenCalledWith(STALE_ID);
    expect(endSessionById).not.toHaveBeenCalledWith(FRESH_ID);
    expect(stopHeartbeat).not.toHaveBeenCalledWith(FRESH_ID);
  });

  it('--older-than raises the bar past the stale session, sparing both', async () => {
    // The stale session is 21 days idle; demand 30.
    await sessionCleanCommand({ all: true, olderThan: String(30 * 24) });

    expect(endSessionById).not.toHaveBeenCalled();
    expect(stopHeartbeat).not.toHaveBeenCalled();
  });
});

describe('planSessionClean', () => {
  const now = Date.now();
  const candidate = (over: Partial<{ id: string; lastActivityMs: number | null; alive: boolean }>) => ({
    id: 'x',
    label: 'model',
    lastActivityMs: now - 20 * DAY,
    alive: false,
    ...over,
  });

  it('never ends a live session, even under --force', () => {
    const [d] = planSessionClean([candidate({ alive: true, lastActivityMs: now - 90 * DAY })], {
      force: true,
      now,
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/running/i);
  });

  it('ends a session idle past the threshold', () => {
    const [d] = planSessionClean([candidate({})], { now });
    expect(d.action).toBe('end');
  });

  it('keeps a session idle for less than the threshold', () => {
    const [d] = planSessionClean([candidate({ lastActivityMs: now - 30 * 60 * 1000 })], { now });
    expect(d.action).toBe('skip');
  });

  it('the default threshold is 12 hours: 11h stays, 13h goes', () => {
    expect(DEFAULT_CLEAN_AGE_MS).toBe(12 * HOUR);
    const [keep] = planSessionClean([candidate({ lastActivityMs: now - 11 * HOUR })], { now });
    const [end] = planSessionClean([candidate({ lastActivityMs: now - 13 * HOUR })], { now });
    expect(keep.action).toBe('skip');
    expect(end.action).toBe('end');
  });

  it('a session with no activity signal is kept unless --force', () => {
    const [keep] = planSessionClean([candidate({ lastActivityMs: null })], { now });
    expect(keep.action).toBe('skip');
    const [end] = planSessionClean([candidate({ lastActivityMs: null })], { force: true, now });
    expect(end.action).toBe('end');
  });
});
