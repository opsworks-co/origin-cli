// A Start run's fix must leave the machine: Codex committed bd01843 for issue
// e31db5e2 in its worktree, nobody pushed it, and the issue waited "in
// progress" for a merge that could not happen (2026-10-13). After a clean run
// Origin pushes the branch and opens the pull request — never merges.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describePublish, githubRepoOf, publishIssueBranch, pullRequestBody, type Exec, type PublishInput } from '../issue-publish.js';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A clone of a bare "origin" whose default branch is main, on `branch` with `commits` new commits. */
function repo(branch: string, commits: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-publish-'));
  const bare = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '--bare', '-b', 'main', bare);
  git(dir, 'init', '-b', 'main', work);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'base');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-u', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  git(work, 'checkout', '-b', branch);
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(work, `f${i}.txt`), `${i}\n`);
    git(work, 'add', '.');
    git(work, 'commit', '-m', `fix part ${i} (e31db5e2)`);
  }
  return { bare, work };
}

/** Real git (isolated config); `gh` answered by `ghAnswer`, its calls recorded. */
function execWith(ghAnswer: (args: string[]) => { ok: boolean; stdout: string; stderr?: string }, remoteUrl?: string) {
  const ghCalls: string[][] = [];
  const exec: Exec = (cmd, args, cwd) => {
    if (cmd === 'gh') { ghCalls.push(args); const r = ghAnswer(args); return { ok: r.ok, stdout: r.stdout, stderr: r.stderr ?? '' }; }
    // The remote is a local bare repo; pretend its URL is GitHub's when asked.
    if (remoteUrl && args[0] === 'remote' && args[1] === 'get-url') return { ok: true, stdout: remoteUrl, stderr: '' };
    try { return { ok: true, stdout: git(cwd, ...args), stderr: '' }; } catch (e: any) { return { ok: false, stdout: '', stderr: String(e.stderr || e.message) }; }
  };
  return { exec, ghCalls };
}

const input = (cwd: string, extra: Partial<PublishInput> = {}): PublishInput => ({
  cwd, branch: 'issue/e31db5e2-slug', shortId: 'e31db5e2', title: 'Обрізані slug-и', agent: 'codex', ...extra,
});

describe('publishIssueBranch', () => {
  it('pushes the branch and opens a pull request titled after its one commit', () => {
    const r = repo('issue/e31db5e2-slug', 1);
    const { exec, ghCalls } = execWith((args) => args[1] === 'list'
      ? { ok: true, stdout: '' }
      : { ok: true, stdout: 'https://github.com/o/r/pull/12' }, 'https://github.com/o/r.git');
    const out = publishIssueBranch(input(r.work), exec);
    expect(out).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/12', created: true });
    expect(git(r.bare, 'rev-parse', 'refs/heads/issue/e31db5e2-slug')).toBe(git(r.work, 'rev-parse', 'HEAD'));
    const create = ghCalls.find((a) => a[1] === 'create')!;
    expect(create).toEqual(expect.arrayContaining(['--repo', 'o/r', '--base', 'main', '--head', 'issue/e31db5e2-slug', '--title', 'fix part 0 (e31db5e2)']));
    expect(ghCalls.some((a) => a.includes('merge'))).toBe(false);
  });

  it('reuses the pull request already open for the branch', () => {
    const r = repo('issue/e31db5e2-slug', 2);
    const { exec, ghCalls } = execWith(() => ({ ok: true, stdout: 'https://github.com/o/r/pull/9' }), 'git@github.com:o/r.git');
    expect(publishIssueBranch(input(r.work), exec)).toEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/9', created: false });
    expect(ghCalls.map((a) => a[1])).toEqual(['list']);
  });

  it('does nothing when the agent committed nothing', () => {
    const r = repo('issue/e31db5e2-slug', 0);
    const { exec, ghCalls } = execWith(() => ({ ok: true, stdout: '' }), 'https://github.com/o/r.git');
    const out = publishIssueBranch(input(r.work), exec);
    expect(out).toEqual({ kind: 'skipped', reason: 'no commits on issue/e31db5e2-slug beyond main' });
    expect(() => git(r.bare, 'rev-parse', '--verify', 'refs/heads/issue/e31db5e2-slug')).toThrow();
    expect(ghCalls).toEqual([]);
  });

  it('does nothing when the checkout left the issue branch', () => {
    const r = repo('issue/e31db5e2-slug', 1);
    git(r.work, 'checkout', 'main');
    const { exec } = execWith(() => ({ ok: true, stdout: '' }));
    expect(publishIssueBranch(input(r.work), exec)).toEqual({ kind: 'skipped', reason: 'the checkout is on main, not issue/e31db5e2-slug' });
  });

  it('a review fix only pushes: its pull request updates', () => {
    const r = repo('fix/review', 1);
    const { exec, ghCalls } = execWith(() => ({ ok: true, stdout: '' }), 'https://github.com/o/r.git');
    const out = publishIssueBranch(input(r.work, { branch: 'fix/review', pullRequest: 41 }), exec);
    expect(out).toEqual({ kind: 'pushed', note: 'pushed fix/review; pull request #41 updates' });
    expect(ghCalls).toEqual([]);
  });

  it('pushes but says so when the repo is not on GitHub, or gh is unusable', () => {
    const r = repo('issue/e31db5e2-slug', 1);
    expect(publishIssueBranch(input(r.work), execWith(() => ({ ok: true, stdout: '' })).exec).kind).toBe('pushed');
    const noGh = publishIssueBranch(input(r.work), execWith(() => ({ ok: false, stdout: '', stderr: 'gh: not found' }), 'https://github.com/o/r').exec);
    expect(noGh).toEqual({ kind: 'pushed', note: 'pushed issue/e31db5e2-slug; gh is missing or not signed in, so open its pull request by hand' });
  });
});

describe('helpers', () => {
  it('githubRepoOf reads https and ssh remotes, and nothing else', () => {
    expect(githubRepoOf('https://github.com/dolobanko/upplabs.com.git')).toBe('dolobanko/upplabs.com');
    expect(githubRepoOf('git@github.com:o/r.git')).toBe('o/r');
    expect(githubRepoOf('https://gitlab.com/o/r.git')).toBeNull();
  });

  it('the body closes a GitHub issue and lists the commits', () => {
    const body = pullRequestBody({ cwd: '', branch: 'b', shortId: '42', title: 'T', agent: 'claude', hostIssue: { provider: 'github', number: 42 } }, ['x (abc1234)']);
    expect(body.startsWith('Fixes #42\n')).toBe(true);
    expect(body).toContain('- x (abc1234)');
  });

  it('describePublish is one line for the log and the Start dialog', () => {
    expect(describePublish({ kind: 'pr', url: 'https://github.com/o/r/pull/1', created: true })).toBe('Opened pull request https://github.com/o/r/pull/1');
    expect(describePublish({ kind: 'skipped', reason: 'no origin' })).toBe('Did not push: no origin');
  });
});
