/**
 * `findStateForHook` must consult the durable mirror when `.git` holds nothing.
 *
 * `listActiveSessions` returns EARLY from its git-dir branch, so a session whose
 * state has not (yet) reached `.git/origin-session-<tag>.json` is invisible to
 * every hook that captures work — after-file-edit, pre/post-tool-use, stop.
 *
 * Prod, Cursor on `baton`, 2026-08-30: the API was timing out, session/start
 * took 8s to fail, and the state file's BIRTHTIME was 13:45:55 — two minutes
 * after the session began. Throughout those two minutes:
 *
 *   13:43:54  scanning {"sessionsInHookCwd":0,"sessionsInRepoPath":0,"tags":[]}
 *   13:43:54  [after-file-edit] ABORT: no session state
 *   …          src/index.js, src/parseArgs.test.js, src/index.test.js, README.md
 *   13:45:30  [stop] no state found
 *
 * The whole turn was dropped. `~/.origin/sessions/local-9adc70bd.json` held the
 * session the entire time — the git-hook lookup already falls back to it
 * (#1346), this path did not. That is the same "fixed one path, bug is on
 * another" shape, so it gets a behavioural test rather than a wiring guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-mirror-hook-${process.pid}` };
});

vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

import { findStateForHook } from '../commands/hooks.js';

const SESSIONS_DIR = path.join(TEST_HOME, '.origin', 'sessions');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

let repo: string;

/** A session in the mirror only — exactly what the hooks had to work with. */
function writeMirror(id: string, state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify({
    sessionId: id,
    sessionTag: 'smtfv1cat',
    agentSlug: 'cursor',
    model: 'cursor-grok-4.6-high-fast',
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    ...state,
  }), { mode: 0o600 });
}

/** A session written the normal way, into the repo's own `.git`. */
function writeGitState(tag: string, state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify({
    sessionTag: tag,
    agentSlug: 'cursor',
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    repoPath: repo,
    ...state,
  }));
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_HOME, '.origin'), { recursive: true, force: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  repo = fs.mkdtempSync(path.join(TEST_HOME, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env: ENV });
  // macOS: /var → /private/var. discoverGitRoot returns the resolved path, and
  // listMirroredSessionsForTree compares with samePath, so the state must claim
  // the same tree git will report.
  repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: repo, env: ENV, encoding: 'utf-8',
  }).trim();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('findStateForHook — durable mirror fallback', () => {
  it('recovers the session from the mirror when .git holds no state', () => {
    // The baton case: mirror written, `.git` not yet.
    writeMirror('local-9adc70bd', { repoPath: repo });

    const found = findStateForHook(repo, undefined, 'cursor');

    expect(found).not.toBeNull();
    expect(found!.state.sessionId).toBe('local-9adc70bd');
  });

  it('still returns null when the mirror has nothing for this tree', () => {
    // No session anywhere — the hook must go on to auto-create, not attach to
    // whatever else is running on the machine.
    writeMirror('local-elsewhere', { repoPath: '/some/other/repo' });

    expect(findStateForHook(repo, undefined, 'cursor')).toBeNull();
  });

  it('prefers the in-repo state over the mirror when both exist', () => {
    // The mirror is a LAST resort. `.git` is the live record; a stale mirror
    // entry must never displace it.
    writeGitState('smtfv1cat', { sessionId: 'in-git' });
    writeMirror('local-mirror', { repoPath: repo });

    const found = findStateForHook(repo, undefined, 'cursor');

    expect(found!.state.sessionId).toBe('in-git');
  });

  it('does not hand a cursor hook an antigravity session from the mirror', () => {
    // The agent filter has to survive the new path — attaching a Cursor turn to
    // a live Gemini session is the bug the filter exists for.
    writeMirror('local-agy', { repoPath: repo, agentSlug: 'antigravity', model: 'gemini-3.1-pro' });

    expect(findStateForHook(repo, undefined, 'cursor')).toBeNull();
  });

  it('ignores an ended session in the mirror', () => {
    writeMirror('local-done', {
      repoPath: repo, status: 'ENDED', endedAt: new Date().toISOString(),
    });

    expect(findStateForHook(repo, undefined, 'cursor')).toBeNull();
  });

  it('matches on lastCwd, so a session that moved is still found', () => {
    writeMirror('local-bycwd', { repoPath: '/stale/path', lastCwd: repo });

    const found = findStateForHook(repo, undefined, 'cursor');

    expect(found!.state.sessionId).toBe('local-bycwd');
  });

  it('still reads the mirror when .git already has someone else\'s session', () => {
    // Session c1e361a4: this Cursor worktree chat lived in ~/.origin/sessions.
    // The common git dir already held other origin-session files, so the
    // "both scans empty" gate never opened the mirror. after-file-edit
    // scanned the foreign tags, missed this conversation id, and the turns
    // stored no diffs.
    writeGitState('foreign-chat', {
      sessionId: 'other-session',
      agentSlug: 'claude-code',
      model: 'claude-opus-5',
    });
    const conv = '7b2b1608-065e-43c6-982a-a5841d39fead';
    writeMirror('c1e361a4-68d', {
      repoPath: repo,
      agentSessionId: conv,
      sessionId: 'c1e361a4-68d9-4b71-af22-a0d4d7732215',
    });

    const found = findStateForHook(repo, conv, 'cursor');
    expect(found).not.toBeNull();
    expect(found!.state.sessionId).toBe('c1e361a4-68d9-4b71-af22-a0d4d7732215');
  });
});
