/**
 * Regression tests for commit↔session linking when multiple Claude Code
 * sessions run in parallel git worktrees of the same repo.
 *
 * Symptom (from ~/.origin/hooks.log): prepare-commit-msg fired inside a
 * linked worktree while 4 sessions were active. The committing session's
 * state file lived under the MAIN repo's .git (the session started there
 * before the harness created the worktree), so the worktree's own git dir
 * held 0 candidates and the repo level held 4 ambiguous ones — the hook
 * skipped writing Origin trailers and the commit reached GitHub unlinked.
 *
 * Fix under test:
 *   • listSessionsForGitHook falls back from the worktree's git dir to the
 *     main repo's session files, then narrows candidates by each session's
 *     last-seen lifecycle-hook cwd (state.lastCwd).
 *   • handlePrepareCommitMsg therefore writes the trailer of exactly the
 *     session working in the committing worktree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handlePrepareCommitMsg, listSessionsForGitHook } from '../commands/hooks.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function createTempGitRepo(): string {
  // realpathSync: os.tmpdir() is a symlink on macOS (/var → /private/var);
  // resolve it up front so paths written into state files compare cleanly.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wt-hook-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@origin.dev');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Neutralize globally-installed git hooks (core.hooksPath → Origin's real
  // hooks on dev machines) so fixture commits don't fire them.
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

function addWorktree(mainRepo: string, name: string): string {
  const wtPath = path.join(path.dirname(mainRepo), `${path.basename(mainRepo)}-${name}`);
  git(mainRepo, 'worktree', 'add', '-q', wtPath, '-b', `wt-${name}`);
  return fs.realpathSync(wtPath);
}

// Session state files live in the MAIN repo's .git — exactly where a session
// that started in the main repo (before the harness created its worktree)
// registers itself.
function writeActiveSession(mainRepo: string, opts: {
  sessionId: string;
  model: string;
  lastCwd?: string;
  promptCount?: number;
}): void {
  const tag = opts.sessionId.slice(0, 12);
  const state = {
    sessionId: opts.sessionId,
    claudeSessionId: opts.sessionId,
    transcriptPath: '',
    model: opts.model,
    startedAt: new Date().toISOString(),
    prompts: Array.from({ length: opts.promptCount ?? 1 }, (_, i) => `prompt ${i}`),
    repoPath: mainRepo,
    lastCwd: opts.lastCwd,
    headShaAtStart: null,
    headShaAtLastStop: null,
    prePromptSha: null,
    branch: null,
    sessionTag: tag,
  };
  fs.writeFileSync(
    path.join(mainRepo, '.git', `origin-session-${tag}.json`),
    JSON.stringify(state),
    { mode: 0o600 },
  );
}

function writeMsgFile(repoOrWorktree: string, message: string): string {
  const msgPath = path.join(repoOrWorktree, 'COMMIT_EDITMSG');
  fs.writeFileSync(msgPath, message);
  return msgPath;
}

describe('multi-session worktree commit linking', () => {
  let mainRepo: string;
  let worktree: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    mainRepo = createTempGitRepo();
    worktree = addWorktree(mainRepo, 'a');
  });

  afterEach(() => {
    process.chdir(origCwd);
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(mainRepo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  describe('listSessionsForGitHook', () => {
    it('falls back to repo-level sessions when the hook cwd is a linked worktree', () => {
      writeActiveSession(mainRepo, { sessionId: 'solo-session-0001', model: 'claude-sonnet-4' });

      const found = listSessionsForGitHook(worktree);

      expect(found.map((s) => s.sessionId)).toEqual(['solo-session-0001']);
    });

    it('narrows multiple repo-level sessions to the one whose lastCwd is the worktree', () => {
      writeActiveSession(mainRepo, { sessionId: 'main-session-0001', model: 'claude-sonnet-4', lastCwd: mainRepo });
      writeActiveSession(mainRepo, { sessionId: 'wt-session-000001', model: 'claude-opus-4-8', lastCwd: worktree });

      const found = listSessionsForGitHook(worktree);

      expect(found.map((s) => s.sessionId)).toEqual(['wt-session-000001']);
    });

    it('excludes sessions known to work elsewhere when the hook runs in the main repo', () => {
      writeActiveSession(mainRepo, { sessionId: 'main-session-0001', model: 'claude-sonnet-4', lastCwd: mainRepo });
      writeActiveSession(mainRepo, { sessionId: 'wt-session-000001', model: 'claude-opus-4-8', lastCwd: worktree });

      const found = listSessionsForGitHook(mainRepo);

      expect(found.map((s) => s.sessionId)).toEqual(['main-session-0001']);
    });

    it('returns no candidates when every session is working in a different directory', () => {
      const otherWorktree = addWorktree(mainRepo, 'b');
      try {
        writeActiveSession(mainRepo, { sessionId: 'main-session-0001', model: 'mystery-model-a', lastCwd: mainRepo });
        writeActiveSession(mainRepo, { sessionId: 'wtb-session-00001', model: 'mystery-model-b', lastCwd: otherWorktree });

        expect(listSessionsForGitHook(worktree)).toEqual([]);
      } finally {
        try { fs.rmSync(otherWorktree, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });
  });

  describe('handlePrepareCommitMsg in a worktree', () => {
    it('writes the trailer of the session working in this worktree, not its siblings', async () => {
      // The reported scenario: several sessions registered at repo level,
      // only one of them (per lastCwd) actually committing in this worktree.
      writeActiveSession(mainRepo, { sessionId: 'aaaa11112222dead', model: 'claude-sonnet-4', lastCwd: mainRepo, promptCount: 5 });
      writeActiveSession(mainRepo, { sessionId: 'bbbb33334444beef', model: 'claude-opus-4-8', lastCwd: worktree, promptCount: 2 });
      process.chdir(worktree);
      const msgFile = writeMsgFile(worktree, 'feat: change made in worktree\n');

      await handlePrepareCommitMsg(msgFile, 'message');

      const out = fs.readFileSync(msgFile, 'utf-8');
      expect(out).toContain('Origin-Session: bbbb33334444 | Claude Code | 2 prompts');
      expect(out).not.toContain('aaaa11112222');
    });

    it('still skips (no trailer) when no session can be tied to the worktree', async () => {
      // Models deliberately match no agent slug so the hook's pgrep
      // disambiguation can't accidentally resolve the tie on dev machines.
      writeActiveSession(mainRepo, { sessionId: 'aaaa11112222dead', model: 'mystery-model-a', lastCwd: mainRepo });
      writeActiveSession(mainRepo, { sessionId: 'bbbb33334444beef', model: 'mystery-model-b', lastCwd: mainRepo });
      process.chdir(worktree);
      const original = 'feat: ambiguous commit\n';
      const msgFile = writeMsgFile(worktree, original);

      await handlePrepareCommitMsg(msgFile, 'message');

      expect(fs.readFileSync(msgFile, 'utf-8')).toBe(original);
    });

    it('links a main-repo commit to the main-repo session while siblings work in worktrees', async () => {
      writeActiveSession(mainRepo, { sessionId: 'aaaa11112222dead', model: 'claude-sonnet-4', lastCwd: mainRepo, promptCount: 1 });
      writeActiveSession(mainRepo, { sessionId: 'bbbb33334444beef', model: 'claude-opus-4-8', lastCwd: worktree, promptCount: 1 });
      process.chdir(mainRepo);
      const msgFile = writeMsgFile(mainRepo, 'feat: change made in main repo\n');

      await handlePrepareCommitMsg(msgFile, 'message');

      const out = fs.readFileSync(msgFile, 'utf-8');
      expect(out).toContain('Origin-Session: aaaa11112222');
      expect(out).not.toContain('bbbb33334444');
    });
  });
});
