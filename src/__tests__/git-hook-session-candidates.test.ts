// listSessionsForGitHook must not delete a live session just because it never
// recorded a `lastCwd`.
//
// Real failure (repo `popok`, 2026-07-23): a Codex session's heartbeat daemon
// never exited, so its state stayed `status: RUNNING` and `isSessionAlive` kept
// returning true for hours. Hours later a Cursor session committed
// `eight_rows.txt`. Cursor writes no `lastCwd`; the stale Codex state had one
// pointing at the same repo. The old narrowing returned ONLY the lastCwd
// matches, so the live Cursor session was dropped and
// pickActiveSessionForCommit saw a single candidate — returning it before the
// staged-file-overlap check (the strongest signal, and the one that would have
// picked Cursor, which alone touched eight_rows.txt) ever ran. The commit was
// trailered `Origin-Session: 88c6190f | Codex`, so the Cursor session owned no
// commit: every turn rendered "uncommitted" and the session diff read +0/-0.
//
// Both candidates must survive so the overlap check can decide on evidence.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSessionsForGitHook } from '../commands/hooks.js';

let repo: string;

const writeState = (tag: string, state: Record<string, unknown>) => {
  fs.writeFileSync(
    path.join(repo, '.git', `origin-session-${tag}.json`),
    JSON.stringify(state),
    { mode: 0o600 },
  );
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hook-cand-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('listSessionsForGitHook — candidate narrowing', () => {
  it('keeps a live session that records no lastCwd alongside a lastCwd match', () => {
    // Stale-but-still-"alive" Codex session that DOES carry a lastCwd.
    writeState('stalecodex', {
      sessionId: 'stale-codex-0001',
      sessionTag: 'stalecodex',
      agentSlug: 'codex',
      repoPath: repo,
      lastCwd: repo,
      status: 'RUNNING',
      startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      completedPromptMappings: [{ filesChanged: ['ten_rows.txt'] }],
    });
    // Live Cursor session — Cursor never writes lastCwd.
    writeState('livecursor', {
      sessionId: 'live-cursor-0002',
      sessionTag: 'livecursor',
      agentSlug: 'cursor',
      repoPath: repo,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      completedPromptMappings: [{ filesChanged: ['eight_rows.txt'] }],
    });

    const ids = listSessionsForGitHook(repo).map((s) => s.sessionId);

    // The regression: the live Cursor session used to be filtered out here,
    // handing the commit to the stale Codex session by default.
    expect(ids).toContain('live-cursor-0002');
    expect(ids).toContain('stale-codex-0001');
  });

  it('still drops a session demonstrably working in another directory', () => {
    writeState('elsewhere', {
      sessionId: 'elsewhere-0003',
      sessionTag: 'elsewhere',
      agentSlug: 'codex',
      repoPath: repo,
      lastCwd: path.join(os.tmpdir(), 'some-other-repo'),
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    writeState('here', {
      sessionId: 'here-0004',
      sessionTag: 'here',
      agentSlug: 'codex',
      repoPath: repo,
      lastCwd: repo,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    const ids = listSessionsForGitHook(repo).map((s) => s.sessionId);
    expect(ids).toContain('here-0004');
    expect(ids).not.toContain('elsewhere-0003');
  });
});
