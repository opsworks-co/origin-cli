/**
 * A branch switch does not move Origin's attribution note onto the commit it
 * lands on.
 *
 * post-checkout used to copy `refs/notes/origin` from the previous HEAD to the
 * new one whenever the stash list was non-empty, on the theory that a stash
 * pop had moved HEAD. A stash pop never moves HEAD — post-checkout only sees a
 * changed HEAD on a real checkout — and the stash stack is shared by every
 * worktree of the repo, so on a working machine it is never empty. Every
 * `git checkout` therefore stamped the session that had been on the old branch
 * as the author of whatever commit the new branch pointed at, and pre-push
 * published the note.
 *
 * Session 6c21a6d8 (2026-09-16): checking out Codex's PR branch wrote this
 * Claude session's note onto Codex's commit 9f8e2bbf, which then appeared on
 * the session's page as a commit it made. 30 such copies in two days of
 * hooks.log. Driven against real git.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let repo: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe', env }).trim();
const noteOn = (sha: string): string | null => {
  try { return git('notes', '--ref=origin', 'show', sha); } catch { return null; }
};

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-attribution-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@test.dev');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('a checkout with stash entries present', () => {
  it('leaves the new HEAD without the old HEAD\'s attribution note', async () => {
    // Another agent's branch, with a commit this session never touched.
    git('checkout', '-q', '-b', 'codex/track-created-worktrees');
    fs.writeFileSync(path.join(repo, 'codex.ts'), 'export const codex = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'fix(capture): track worktrees created mid-session');
    const foreign = git('rev-parse', 'HEAD');

    // This session's commit, carrying its note, on its own branch.
    git('checkout', '-q', '-b', 'review/1663', 'main');
    fs.writeFileSync(path.join(repo, 'ours.ts'), 'export const ours = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'perf(capture): ours');
    const ours = git('rev-parse', 'HEAD');
    git('notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"6c21a6d8-ba93"}}', ours);

    // A stash entry — any worktree's — is all the old rule needed.
    fs.writeFileSync(path.join(repo, 'ours.ts'), 'export const ours = 2;\n');
    git('stash', 'push', '-q', '-m', 'someone else\'s wip');
    expect(git('stash', 'list')).not.toBe('');

    git('checkout', '-q', 'codex/track-created-worktrees');

    vi.doMock('../session-state.js', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('../session-state.js')),
      getGitRoot: () => repo,
    }));
    const { handleGitPostCheckout } = await import('../commands/hooks.js');
    await handleGitPostCheckout(ours, foreign, '1');

    expect(noteOn(foreign), 'the foreign commit must not be attributed to this session').toBeNull();
    expect(noteOn(ours)).toContain('6c21a6d8');
  });
});
