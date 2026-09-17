/**
 * `inheritedWindowDeps.baselineCommit` resolved each shadow with its own
 * `git show -s`: a closed turn's window asked for the next shadow, then the
 * same sha again as `toShadow`, then `fromShadow`. They are now read in one
 * git process and remembered. This pins that a shadow resolves to its parent
 * and a plain commit to itself either way, abbreviated shas included, and that
 * an unreadable one still fails the way it did.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inheritedFilesForTurn, windowInheritsCommitsForTurn } from '../commands/hooks.js';

let repo: string;
const git = (a: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

function commit(file: string, message: string, env: Record<string, string> = {}): string {
  fs.writeFileSync(path.join(repo, file), `${file} ${Math.random()}\n`);
  git(['add', '.']);
  git(['commit', '-q', '-m', message], env);
  return git(['rev-parse', 'HEAD']);
}

const shadowOf = (parent: string, n: number): string =>
  git(['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', `origin shadow ${n}`]);

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-heads-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('inheritedWindowDeps shadow reads', () => {
  it('answers a closed turn the same for full and abbreviated shadows', () => {
    const base = commit('base.txt', 'base');
    const from = shadowOf(base, 0);
    commit('pulled.txt', 'squash (#12)', { GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub' });
    const end = commit('mine.txt', 'mine');
    const to = shadowOf(end, 1);
    const state: any = {
      sessionId: '9e9e9e9e-1111-2222',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      promptShadows: [{ promptIndex: 0, shadowSha: from }, { promptIndex: 1, shadowSha: to }],
    };
    expect(windowInheritsCommitsForTurn(repo, state, from, to, 0)).toBe(true);
    expect([...inheritedFilesForTurn(repo, state, from, to, 0)]).toEqual(['pulled.txt']);

    const short = { ...state, promptShadows: [{ promptIndex: 0, shadowSha: from.slice(0, 10) }, { promptIndex: 1, shadowSha: to.slice(0, 10) }] };
    expect(windowInheritsCommitsForTurn(repo, short, from.slice(0, 10), to.slice(0, 10), 0)).toBe(true);
    expect([...inheritedFilesForTurn(repo, short, from.slice(0, 10), to.slice(0, 10), 0)]).toEqual(['pulled.txt']);
  });

  it('a plain commit is its own baseline, and an unreadable shadow still reads as nothing', () => {
    const base = commit('base.txt', 'base');
    commit('pulled.txt', 'squash (#12)', { GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub' });
    const end = commit('mine.txt', 'mine');
    const state: any = { sessionId: 'x', startedAt: new Date(Date.now() - 3_600_000).toISOString(), promptShadows: [] };
    expect([...inheritedFilesForTurn(repo, state, base, end, 0)]).toEqual(['pulled.txt']);
    const missing = 'deadbeef'.repeat(5);
    expect(windowInheritsCommitsForTurn(repo, state, base, missing, 0)).toBe(false);
    expect([...inheritedFilesForTurn(repo, state, missing, end, 0)]).toEqual([]);
  });
});
