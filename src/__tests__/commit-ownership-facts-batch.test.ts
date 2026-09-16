/**
 * `isOwnWork` is asked of every commit in a turn's window. A turn that merged a
 * busy main holds hundreds, and two `git show` per commit took ~4.6s for 300
 * inside hooks that run on a timeout. The window's facts are now read in one
 * `git log --no-walk --stdin`; this pins that the batch reads exactly what the
 * per-commit read does, so `commitBelongsToSession` answers the same either way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  commitBelongsToSession,
  readCommitOwnershipFacts,
  readCommitOwnershipFactsBatch,
} from '../commands/hooks.js';

let repo: string;
const git = (a: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

function commit(file: string, message: string, env: Record<string, string> = {}): string {
  fs.writeFileSync(path.join(repo, file), `${file} ${Math.random()}\n`);
  git(['add', '.']);
  git(['commit', '-q', '-m', message], env);
  return git(['rev-parse', 'HEAD']);
}

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-facts-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'Dev@Test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('readCommitOwnershipFactsBatch', () => {
  it('reads what the per-commit read does, for every commit in one call', () => {
    const plain = commit('a.txt', 'plain subject');
    const trailered = commit('b.txt', 'feat: x\n\nbody with\nlines\n\nOrigin-Session: 5151aaaa-bbb | Claude Code | 3 prompts');
    const pulled = commit('c.txt', 'squash (#12)', {
      GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub',
    });
    const batch = readCommitOwnershipFactsBatch(repo, [pulled, plain, trailered]);
    expect(batch.size).toBe(3);
    for (const sha of [plain, trailered, pulled]) {
      const single = readCommitOwnershipFacts(repo, sha)!;
      const batched = batch.get(sha)!;
      expect(batched.committerEmail).toBe(single.committerEmail);
      expect(batched.committedAtMs).toBe(single.committedAtMs);
      // `git show` terminates the body with a newline the record separator does not.
      expect(batched.body.trimEnd()).toBe(single.body.trimEnd());
    }
    expect(batch.get(pulled)!.committerEmail).toBe('noreply@github.com');
    expect(batch.get(trailered)!.body).toMatch(/^Origin-Session: 5151aaaa-bbb/m);
  });

  it('gives commitBelongsToSession the same answers as reading per commit', () => {
    const local = commit('a.txt', 'local, no trailer');
    const foreign = commit('b.txt', 'sibling\n\nOrigin-Session: 5151aaaa-bbb | Claude Code | 1 prompts');
    const ours = commit('c.txt', 'ours\n\nOrigin-Session: 9e9e9e9e-111 | Claude Code | 1 prompts');
    const pulled = commit('d.txt', 'pulled', { GIT_COMMITTER_EMAIL: 'noreply@github.com' });
    const state: any = { sessionId: '9e9e9e9e-1111-2222', startedAt: new Date(Date.now() - 3_600_000).toISOString() };
    const email = 'dev@test.dev';
    const batch = readCommitOwnershipFactsBatch(repo, [local, foreign, ours, pulled]);
    const answers = (facts?: (sha: string) => any) => [local, foreign, ours, pulled]
      .map((sha) => commitBelongsToSession(repo, sha, state, email, facts ? facts(sha) : undefined));
    expect(answers((sha) => batch.get(sha))).toEqual(answers());
    expect(answers()).toEqual([true, false, true, false]);
  });

  it('a sha git cannot name empties the batch, and a failed read stays generous', () => {
    const real = commit('a.txt', 'real');
    expect(readCommitOwnershipFactsBatch(repo, [real, 'deadbeef'.repeat(5)]).size).toBe(0);
    expect(readCommitOwnershipFacts(repo, 'deadbeef'.repeat(5))).toBeNull();
    expect(commitBelongsToSession(repo, real, { sessionId: 'x' } as any, 'dev@test.dev', null)).toBe(true);
  });
});
