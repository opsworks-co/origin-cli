/**
 * The same patch proves two commits are copies of one piece of work; it does
 * not say which one replaced the other. The rescue reads the direction from
 * "HEAD cannot reach it", and that answer depends on the tree it runs from.
 *
 * Session df8cc9aa turn 26 (2026-10-02): the session committed 5ab32f7b in its
 * worktree and the PR was squash-merged as 8497e852. A rescue run from a tree on
 * main recorded 5ab32f7b -> 8497e852; the next, run from the worktree still on
 * 5ab32f7b, recorded 8497e852 -> 5ab32f7b. Both pairs went to the server, which
 * retired each commit in favour of the other, and the turn showed no commit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testRescueCommitShas } from '../commands/hooks.js';

let tmp = '';
let repo = '';
let wt = '';
const git = (cwd: string, args: string[], date?: string) =>
  execFileSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    env: date ? { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : process.env,
  }).toString().trim();
const write = (tree: string, f: string, c: string) => fs.writeFileSync(path.join(tree, f), c);

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rescue-backwards-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  write(repo, 'base.txt', 'base\n'); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'base'], '2026-10-02T16:00:00Z');
  wt = path.join(tmp, 'wt');
  git(repo, ['worktree', 'add', '-q', '-b', 'fix/deploy-waits', wt]);
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** One commit in the worktree; main moves on and squash-merges it two minutes later. */
function squashMergedOnMain() {
  const start = git(repo, ['rev-parse', 'HEAD']);
  write(wt, 'deploy.sh', 'wait for backup\n'); git(wt, ['add', '-A']);
  git(wt, ['commit', '-qm', 'fix(deploy): wait for a running backup'], '2026-10-02T17:02:47Z');
  const own = git(wt, ['rev-parse', 'HEAD']);
  write(repo, 'other.ts', 'main moved on\n'); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'main moved on'], '2026-10-02T17:03:30Z');
  git(repo, ['merge', '-q', '--squash', 'fix/deploy-waits']);
  git(repo, ['commit', '-qm', 'fix(deploy): wait for a running backup (#2069)'], '2026-10-02T17:04:52Z');
  const squash = git(repo, ['rev-parse', 'HEAD']);
  const state: any = {
    sessionCommitShas: [own], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
    discoveredWorkTrees: [{ path: wt, sha: start, promptIndex: 1 }],
    commitTurns: [{ sha: own, turnId: 't_26', at: '2026-10-02T17:04:21Z', via: 'post-commit' }],
  };
  return { own, squash, state };
}

describe('the rescue keeps one direction for a commit and its forge squash', () => {
  it('a rescue from the worktree still on the original does not record the squash as rewritten into it', () => {
    const { own, squash, state } = squashMergedOnMain();
    // The tree on main: the original is gone from HEAD, the squash carries its patch.
    __testRescueCommitShas(repo, state);
    expect(state.rewrittenCommits).toEqual([{ from: own, to: squash }]);
    expect(state.sessionCommitShas).toEqual([squash]);
    // The worktree still stands on the original, so from there the SQUASH looks orphaned.
    __testRescueCommitShas(wt, state);
    expect(state.rewrittenCommits, 'both directions recorded: the server retires both commits').toEqual([{ from: own, to: squash }]);
    expect(state.commitTurns.map((c: any) => [c.sha, c.turnId])).toEqual([[squash, 't_26']]);
  });

  it('a rescue that runs from the worktree FIRST does not record the squash as the old side', () => {
    const { own, squash, state } = squashMergedOnMain();
    // The squash was recorded too (a post-commit or capture walk on main).
    state.sessionCommitShas = [own, squash];
    __testRescueCommitShas(wt, state);
    expect(state.rewrittenCommits || [], 'the squash was made after the original — it cannot be what was rewritten').toEqual([]);
    __testRescueCommitShas(repo, state);
    expect(state.rewrittenCommits).toEqual([{ from: own, to: squash }]);
    expect(state.sessionCommitShas).toEqual([squash]);
  });
});
