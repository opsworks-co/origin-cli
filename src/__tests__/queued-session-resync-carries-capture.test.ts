/**
 * `origin sessions sync` must ship the CAPTURE, not just start/end.
 *
 * The resync loop replayed a queued session as `session/start` followed by
 * `session/end` and nothing else — no files, no line counts, no tokens, no
 * per-turn rows. It then `fs.unlinkSync`'d the state file on success. So a
 * fully captured session was replayed as a bare row, the empty-session sweep
 * deleted that row, and the only local copy was already gone.
 *
 * Observed on a Cursor session on `baton` (2026-08-30 13:43 UTC): prod was
 * unreachable at session/start, the session stayed `local-9adc70bd…` holding
 * 11 files / +247 −2, `origin sessions sync` printed
 *
 *   ✓  cursor · smtfv1cat
 *
 * and afterwards `origin sessions --global` still showed nothing newer than
 * an 18h-old row for that repo, while both `~/.origin/sessions/local-*.json`
 * mirrors had been deleted. A green tick that loses the data is worse than
 * the failure it was reporting on.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-resync-capture-${process.pid}` };
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
  api: { startSession: vi.fn(), endSession: vi.fn() },
}));

vi.mock('../update-queue.js', async (orig) => ({
  ...((await orig()) as object),
  durableUpdateSession: vi.fn(),
}));

vi.mock('../utils/exec.js', async (orig) => ({
  ...((await orig()) as object),
  gitOrNull: vi.fn(() => 'https://github.com/dolobanko/baton.git'),
}));

import { sessionsSyncCommand } from '../commands/sessions.js';
import { api } from '../api.js';
import { durableUpdateSession } from '../update-queue.js';

const startSession = api.startSession as ReturnType<typeof vi.fn>;
const endSession = api.endSession as ReturnType<typeof vi.fn>;
const durableUpdate = durableUpdateSession as ReturnType<typeof vi.fn>;

const SESSIONS_DIR = path.join(TEST_HOME, '.origin', 'sessions');
const REPO = '/Users/artemdolobanko/Documents/baton';

/** The shape the hooks actually persist for the session that was lost. */
function writeQueued(file: string, state: Record<string, unknown> = {}): string {
  const p = path.join(SESSIONS_DIR, `${file}.json`);
  fs.writeFileSync(p, JSON.stringify({
    sessionId: `local-${file}`,
    sessionTag: 'smtfv1cat',
    model: 'cursor-grok-4.6-high-fast',
    agentSlug: 'cursor',
    branch: 'feature/alien-style',
    repoPath: REPO,
    canonicalRepoPath: REPO,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1000).toISOString(),
    prompts: [{ text: 'generate some code ieen here' }],
    filesChanged: ['src/index.js', 'src/parseArgs.test.js', 'README.md'],
    linesAdded: 247,
    linesRemoved: 2,
    tokensUsed: 483,
    costUsd: 0.0061,
    completedPromptMappings: [
      { promptIndex: 0, promptText: 'generate some code ieen here', filesChanged: ['src/index.js'] },
    ],
    ...state,
  }), { mode: 0o600 });
  return p;
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_HOME, '.origin'), { recursive: true, force: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  startSession.mockReset().mockResolvedValue({ sessionId: 'server-1' });
  endSession.mockReset().mockResolvedValue({});
  durableUpdate.mockReset().mockResolvedValue({});
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('sessions sync — the capture travels with the replay', () => {
  it('sends the files, line counts and per-turn rows the state file holds', async () => {
    writeQueued('9adc70bd');

    const result = await sessionsSyncCommand({ quiet: true });

    expect(result.synced).toBe(1);
    expect(durableUpdate).toHaveBeenCalledTimes(1);
    const [id, payload] = durableUpdate.mock.calls[0];
    // The real id from session/start, never the local- one.
    expect(id).toBe('server-1');
    expect(payload.filesChanged).toEqual([
      'src/index.js', 'src/parseArgs.test.js', 'README.md',
    ]);
    expect(payload.linesAdded).toBe(247);
    expect(payload.linesRemoved).toBe(2);
    expect(payload.tokensUsed).toBe(483);
    expect(payload.costUsd).toBeCloseTo(0.0061);
    // Without promptChanges the session renders as a row with no turns — the
    // exact shape the empty sweep removes.
    expect(payload.promptChanges).toHaveLength(1);
    expect(payload.promptChanges[0].promptIndex).toBe(0);
  });

  it('updates BEFORE ending, so the row is never briefly empty', async () => {
    const order: string[] = [];
    durableUpdate.mockImplementation(async () => { order.push('update'); return {}; });
    endSession.mockImplementation(async () => { order.push('end'); return {}; });
    writeQueued('9adc70bd');

    await sessionsSyncCommand({ quiet: true });

    expect(order).toEqual(['update', 'end']);
  });

  it('keeps the local file when the capture upload hard-fails', async () => {
    // A non-retriable error throws out of durableUpdateSession. Unlinking here
    // is what turned a failed sync into permanent data loss.
    const file = writeQueued('9adc70bd');
    durableUpdate.mockRejectedValue(new Error('boom'));

    const result = await sessionsSyncCommand({ quiet: true });

    expect(result.synced).toBe(0);
    expect(result.failed).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('still removes the file when the payload was queued rather than sent', async () => {
    // durableUpdateSession returns null after persisting to ~/.origin/queue.
    // The capture is out of this file at that point, so keeping it would
    // double-upload on the next run.
    const file = writeQueued('9adc70bd');
    durableUpdate.mockResolvedValue(null);

    const result = await sessionsSyncCommand({ quiet: true });

    expect(result.synced).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('derives session files from the per-turn rows when the rollup is missing', async () => {
    // The recovered baton session's shape exactly: Stop never wrote a
    // session-level filesChanged, so without the union the row reads "0 files"
    // while its one turn lists eleven.
    writeQueued('9adc70bd', {
      filesChanged: undefined,
      completedPromptMappings: [
        { promptIndex: 0, filesChanged: ['src/greek.js', 'src/index.js'] },
        { promptIndex: 1, filesChanged: ['src/index.js', 'README.md'] },
      ],
    });

    await sessionsSyncCommand({ quiet: true });

    expect(durableUpdate.mock.calls[0][1].filesChanged)
      .toEqual(['src/greek.js', 'src/index.js', 'README.md']);
  });

  it('derives session line counts from the turns when the rollup is missing', async () => {
    // Recovered session 02bfcbf3 landed with a header of "+0 −0" over a turn
    // card reading "+247 −2" — the surfaces-disagree shape that reads as a
    // capture failure even though the capture was intact.
    writeQueued('9adc70bd', {
      linesAdded: 0,
      linesRemoved: 0,
      completedPromptMappings: [
        { promptIndex: 0, linesAdded: 247, linesRemoved: 2, filesChanged: ['src/index.js'] },
        { promptIndex: 1, linesAdded: 4, linesRemoved: 1, filesChanged: ['README.md'] },
      ],
    });

    await sessionsSyncCommand({ quiet: true });

    const payload = durableUpdate.mock.calls[0][1];
    expect(payload.linesAdded).toBe(251);
    expect(payload.linesRemoved).toBe(3);
  });

  it('prefers the session rollup over the per-turn sum when it exists', async () => {
    // Summing turns double-counts churn. Whenever Stop wrote a real
    // session-level number it is the better one and must win.
    writeQueued('9adc70bd', {
      linesAdded: 100,
      linesRemoved: 5,
      completedPromptMappings: [
        { promptIndex: 0, linesAdded: 60, linesRemoved: 3, filesChanged: ['a.js'] },
        { promptIndex: 1, linesAdded: 60, linesRemoved: 3, filesChanged: ['a.js'] },
      ],
    });

    await sessionsSyncCommand({ quiet: true });

    const payload = durableUpdate.mock.calls[0][1];
    expect(payload.linesAdded).toBe(100);
    expect(payload.linesRemoved).toBe(5);
  });

  it('skips the update for a session that captured nothing', async () => {
    // A genuinely chat-only session has no capture to ship; sending an
    // all-undefined patch would be a pointless round trip.
    writeQueued('empty', {
      filesChanged: [], linesAdded: 0, linesRemoved: 0,
      tokensUsed: 0, costUsd: 0, completedPromptMappings: [],
    });

    const result = await sessionsSyncCommand({ quiet: true });

    expect(result.synced).toBe(1);
    expect(durableUpdate).not.toHaveBeenCalled();
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});
