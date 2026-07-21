// getGitRecap must count commits / AI-attributed commits / files-changed via
// the safe exec wrapper (array args, no shell). This exercises it against a
// real temp repo — proving the refactor off the old `2>/dev/null`/`$(…)` shell
// strings still works, and (on the windows-latest CI leg) that it works under
// native Windows where those shell constructs are invalid.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getGitRecap } from '../commands/recap.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('getGitRecap (safe exec, cross-platform)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-recap-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@origin.dev');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.hooksPath', path.join(dir, '.no-hooks'));
  });

  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  function commit(file: string, body: string, message: string): void {
    fs.writeFileSync(path.join(dir, file), body);
    git(dir, 'add', file);
    git(dir, 'commit', '-q', '-m', message);
  }

  it('counts commits, AI-attributed commits, and files changed in range', () => {
    // Two commits: one plain, one with a Co-Authored-By trailer (AI-attributed).
    commit('a.txt', 'one', 'plain change');
    commit('b.txt', 'two', 'ai change\n\nCo-Authored-By: Claude <noreply@anthropic.com>');

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24h ago
    const recap = getGitRecap(dir, since);

    expect(recap.commits).toBe(2);
    expect(recap.aiCommits).toBe(1);
    expect(recap.filesChanged).toBeGreaterThanOrEqual(1);
  });

  it('returns zeroes for a non-repo path without throwing', () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-norepo-')));
    try {
      const recap = getGitRecap(empty, new Date(Date.now() - 3600_000).toISOString());
      expect(recap).toEqual({ commits: 0, aiCommits: 0, filesChanged: 0 });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
