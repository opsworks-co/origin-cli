/**
 * `origin sessions sync` must replay a queued session under the CANONICAL
 * repo path, never the working root.
 *
 * A worktree session's state file records BOTH: `repoPath` is the worktree
 * (`<repo>/.claude/worktrees/<name>`) because that is where every git capture
 * has to run, and `canonicalRepoPath` is the main checkout because that is the
 * project's identity. The resync loop read only `repoPath`, so the server —
 * which names an auto-registered repo after the directory it is handed — minted
 * a junk row per worktree next to the real one ("diff-capture-issue-dc976e",
 * "agi-diff-capture-193272"), each with 0 commits and 0 sessions, grouped under
 * the right owner because `fullName` still derived from the remote. The
 * local→server migration path a few hundred lines away already collapsed to
 * canonical; this loop did not.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-wt-identity-${process.pid}` };
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

// `git remote get-url origin` — resolved per cwd so the test can assert WHICH
// checkout the remote was read from, and simulate a pruned worktree.
vi.mock('../utils/exec.js', async (orig) => ({
  ...((await orig()) as object),
  gitOrNull: vi.fn(),
}));

import { sessionsSyncCommand } from '../commands/sessions.js';
import { api } from '../api.js';
import { gitOrNull } from '../utils/exec.js';

const startSession = api.startSession as ReturnType<typeof vi.fn>;
const endSession = api.endSession as ReturnType<typeof vi.fn>;
const gitOrNullMock = gitOrNull as ReturnType<typeof vi.fn>;

const SESSIONS_DIR = path.join(TEST_HOME, '.origin', 'sessions');
const CANONICAL = '/repos/origin';
const WORKTREE = '/repos/origin/.claude/worktrees/diff-capture-issue-dc976e';
const REMOTE = 'https://github.com/opsworks-co/origin.git';

function writeQueued(file: string, state: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${file}.json`),
    JSON.stringify({
      sessionId: `local-${file}`,
      model: 'claude-opus-5',
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1000).toISOString(),
      prompts: [{ text: 'hello' }],
      agentSlug: 'claude-code',
      ...state,
    }),
    { mode: 0o600 },
  );
}

/** The remote resolves from any checkout of the repo — the normal case. */
function remoteEverywhere(): void {
  gitOrNullMock.mockImplementation(() => REMOTE);
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_HOME, '.origin'), { recursive: true, force: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  startSession.mockReset().mockResolvedValue({ sessionId: 'server-1' });
  endSession.mockReset().mockResolvedValue({});
  gitOrNullMock.mockReset();
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('sessions sync — repo identity', () => {
  it('replays a worktree session under the canonical repo, not the worktree', async () => {
    remoteEverywhere();
    writeQueued('wt', { repoPath: WORKTREE, canonicalRepoPath: CANONICAL });

    const result = await sessionsSyncCommand({ quiet: true });

    expect(result.synced).toBe(1);
    expect(startSession).toHaveBeenCalledTimes(1);
    const payload = startSession.mock.calls[0][0];
    // The whole bug: this used to be WORKTREE, so the server auto-registered a
    // second repo named "diff-capture-issue-dc976e".
    expect(payload.repoPath).toBe(CANONICAL);
    expect(payload.repoPath).not.toContain('.claude/worktrees');
    expect(payload.repoUrl).toBe(REMOTE);
  });

  it('reads the remote from the working root the session actually ran in', async () => {
    remoteEverywhere();
    writeQueued('wt', { repoPath: WORKTREE, canonicalRepoPath: CANONICAL });

    await sessionsSyncCommand({ quiet: true });

    expect(gitOrNullMock).toHaveBeenCalledWith(
      ['remote', 'get-url', 'origin'],
      { cwd: WORKTREE },
    );
  });

  it('falls back to the canonical checkout when the worktree has been pruned', async () => {
    // A pruned worktree is the common case by the time a queued session is
    // replayed — without the fallback the payload carries no repoUrl, and
    // repoUrl is what lets the server resolve to the registered row at all.
    gitOrNullMock.mockImplementation((_args: string[], opts: { cwd?: string }) =>
      opts?.cwd === CANONICAL ? REMOTE : null,
    );
    writeQueued('wt', { repoPath: WORKTREE, canonicalRepoPath: CANONICAL });

    await sessionsSyncCommand({ quiet: true });

    const payload = startSession.mock.calls[0][0];
    expect(payload.repoPath).toBe(CANONICAL);
    expect(payload.repoUrl).toBe(REMOTE);
  });

  it('leaves a plain (non-worktree) session on its own repoPath', async () => {
    // No canonicalRepoPath: sessions queued by older CLIs, and every session
    // that ran in the main checkout. These must not change behaviour.
    remoteEverywhere();
    writeQueued('plain', { repoPath: CANONICAL });

    await sessionsSyncCommand({ quiet: true });

    expect(startSession.mock.calls[0][0].repoPath).toBe(CANONICAL);
  });
});
