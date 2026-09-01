/**
 * A reservation is only worth writing if the prompt hook can actually find it.
 *
 * session-start publishes a provisional row before calling `session/start`;
 * user-prompt-submit's pre-mint re-check resolves it through `findStateForHook`
 * and adopts it instead of auto-creating. That is the whole mechanism, so it
 * gets a behavioural test rather than a source-text guard — the reservation
 * being written and the lookup finding it are separate facts.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-reservation-${process.pid}` };
});

vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

import { findStateForHook } from '../commands/hooks.js';
import { isPendingReservation } from '../session-state.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
let repo: string;

/** Exactly what handleSessionStart writes before its network call. */
function writeReservation(over: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(repo, '.git', 'origin-session-smtfv1cat.json'), JSON.stringify({
    sessionId: 'local-9adc70bd-a384-48ce-9517-e8734c9030f9',
    sessionTag: 'smtfv1cat',
    claudeSessionId: '',
    agentSessionId: 'ceb22e9b-2218-474c-be65-ecf73edda086',
    model: 'cursor-grok-4.6-high-fast',
    agentSlug: 'cursor',
    repoPath: repo,
    canonicalRepoPath: repo,
    lastCwd: repo,
    branch: 'feature/alien-style',
    startedAt: new Date().toISOString(),
    prompts: [],
    status: 'RUNNING',
    pendingRegistration: true,
    ...over,
  }));
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_HOME, '.origin'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_HOME, '.origin', 'sessions'), { recursive: true });
  repo = fs.mkdtempSync(path.join(TEST_HOME, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env: ENV });
  repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: repo, env: ENV, encoding: 'utf-8',
  }).trim();
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });
afterAll(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); });

describe('a session-start reservation is adoptable', () => {
  it('is found by the same lookup user-prompt-submit re-checks with', () => {
    // Without this the prompt hook mints a twin — the prod `baton` case.
    writeReservation();

    const found = findStateForHook(repo, undefined, 'cursor');

    expect(found).not.toBeNull();
    expect(found!.state.sessionId).toBe('local-9adc70bd-a384-48ce-9517-e8734c9030f9');
    expect(found!.saveCwd).toBe(repo);
  });

  it('is flagged pending, so an adopting hook does not register it too', () => {
    // Two concurrent registrations for one conversation is the other half of
    // the duplicate — session-start owns registration while its call is live.
    writeReservation();

    const found = findStateForHook(repo, undefined, 'cursor');

    expect(isPendingReservation(found!.state)).toBe(true);
  });

  it('stops being pending once session-start settles the id', () => {
    // handleSessionStart deletes the flag at its final save.
    writeReservation({ pendingRegistration: undefined, sessionId: 'server-1' });

    const found = findStateForHook(repo, undefined, 'cursor');

    expect(isPendingReservation(found!.state)).toBe(false);
  });

  it('is not handed to a different agent', () => {
    // A Cursor reservation must never absorb a Gemini turn running in the same
    // repo — the cross-agent mixing the agent filter exists to stop.
    writeReservation();

    expect(findStateForHook(repo, undefined, 'gemini')).toBeNull();
  });

  it('a stale pending reservation is registered by the next prompt', () => {
    // The start hook died mid-call. The flag must not suppress registration
    // for the rest of the conversation.
    writeReservation({ startedAt: new Date(Date.now() - 10 * 60_000).toISOString() });

    const found = findStateForHook(repo, undefined, 'cursor');

    expect(found).not.toBeNull();
    expect(isPendingReservation(found!.state)).toBe(false);
  });
});
