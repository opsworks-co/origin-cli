/**
 * `origin sessions sync` uploads each queued local-* session in two phases:
 * session/start then session/end. If start succeeds but end fails, a naive
 * retry would call session/start AGAIN and create a second, orphaned server
 * row. The fix persists the real server id (state.syncedSessionId) the moment
 * start succeeds, so a retry resumes at session/end with the same id — exactly
 * one server session, no duplicate.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-sync-idem-${process.pid}` };
});

vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

vi.mock('../config.js', async (orig) => ({
  ...((await orig()) as object),
  isConnectedMode: () => true,
  loadAgentConfig: () => ({ machineId: 'm1', hostname: 'h1' }),
  loadConfig: () => ({ apiKey: 'current-key', orgId: 'org-current' }),
}));

vi.mock('../api.js', async (orig) => ({
  ...((await orig()) as object),
  api: {
    startSession: vi.fn(),
    endSession: vi.fn(),
  },
}));

import { sessionsSyncCommand } from '../commands/sessions.js';
import { api } from '../api.js';

const startSession = api.startSession as ReturnType<typeof vi.fn>;
const endSession = api.endSession as ReturnType<typeof vi.fn>;

const SESSIONS_DIR = path.join(TEST_HOME, '.origin', 'sessions');

// A queued local-* session with NO owner stamp — isForeignSession treats
// unstamped sessions as belonging to the current account, so sync picks it up.
function writeQueued(file: string): void {
  const state = {
    sessionId: `local-${file}`,
    model: 'claude-fable-5',
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1000).toISOString(),
    prompts: [{ text: 'hello' }],
    repoPath: TEST_HOME,
  };
  fs.writeFileSync(path.join(SESSIONS_DIR, `${file}.json`), JSON.stringify(state), { mode: 0o600 });
}

function readState(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${file}.json`), 'utf-8'));
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_HOME, '.origin'), { recursive: true, force: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  startSession.mockReset();
  endSession.mockReset();
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('sessionsSyncCommand idempotent start', () => {
  it('does not re-start when end failed on a prior run — exactly one server session', async () => {
    writeQueued('a');
    startSession.mockResolvedValue({ sessionId: 'real-a' });
    // end fails on the first run, succeeds on the retry.
    endSession.mockRejectedValueOnce(new Error('network blip')).mockResolvedValue({});

    // Run 1: start ok, end fails.
    const r1 = await sessionsSyncCommand({ quiet: true });
    expect(r1).toMatchObject({ synced: 0, failed: 1 });
    expect(startSession).toHaveBeenCalledTimes(1);
    // File kept, with the real server id persisted for the resume.
    expect(fs.existsSync(path.join(SESSIONS_DIR, 'a.json'))).toBe(true);
    expect(readState('a').syncedSessionId).toBe('real-a');

    // Run 2: resumes at end — start is NOT called again.
    const r2 = await sessionsSyncCommand({ quiet: true });
    expect(r2).toMatchObject({ synced: 1, failed: 0 });
    expect(startSession).toHaveBeenCalledTimes(1); // still 1 across both runs
    expect(endSession).toHaveBeenCalledTimes(2);
    // The end call resumed with the SAME server id (no duplicate).
    expect(endSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'real-a' }));
    // Uploaded → file removed.
    expect(fs.existsSync(path.join(SESSIONS_DIR, 'a.json'))).toBe(false);
  });

  it('persists the real id immediately so a crash before end still resumes', async () => {
    writeQueued('b');
    startSession.mockResolvedValue({ sessionId: 'real-b' });
    // Simulate a crash: end never even runs (throws synchronously is overkill —
    // just assert the id was persisted right after start, before end resolves).
    endSession.mockRejectedValue(new Error('still offline'));

    await sessionsSyncCommand({ quiet: true });

    // Even though end never succeeded, the real id is on disk for next time.
    expect(readState('b').syncedSessionId).toBe('real-b');
    expect(fs.existsSync(path.join(SESSIONS_DIR, 'b.json'))).toBe(true);
  });

  it('still creates exactly one session on the happy path', async () => {
    writeQueued('c');
    startSession.mockResolvedValue({ sessionId: 'real-c' });
    endSession.mockResolvedValue({});

    const r = await sessionsSyncCommand({ quiet: true });

    expect(r).toMatchObject({ synced: 1, failed: 0 });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(SESSIONS_DIR, 'c.json'))).toBe(false);
  });
});
