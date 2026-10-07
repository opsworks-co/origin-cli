import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdRewrites, takeHeldRewritesFor } from '../held-rewrites.js';
import { recordGitRewrites } from '../commands/hooks/post-rewrite.js';
import { applyRewritePairsToState, saveSessionState, loadSessionState } from '../session-state.js';

/**
 * `git commit -m wip && git rebase origin/main`: the rebase's post-rewrite hook
 * runs while the commit's backgrounded post-commit is still starting, so no
 * session owns the old sha yet. Session c085f0af, 2026-09-26 04:45 UTC —
 * 2099d0d9 rebased to 47dbb095, pair dropped, the copy rendered "NOT LINKED
 * TO A TURN". The pair is held for the commit that is about to be recorded.
 */
describe('a rewrite pair git reports before the commit is recorded', () => {
  let repo = '';
  const TAG = 'held-tag';
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const commit = (msg: string) => {
    fs.writeFileSync(path.join(repo, 'f.txt'), `${msg}\n`);
    git('add', '-A'); git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  const heldDir = () => path.join(os.homedir(), '.origin', 'held-rewrites');

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-held-rewrites-')));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    commit('base');
  });
  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(heldDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('is held when no live session owns the old sha, and taken once by that sha', () => {
    const A = commit('wip');
    const B = commit('wip, replayed');
    expect(recordGitRewrites(repo, [{ oldSha: A, newSha: B }])).toEqual({ sessions: 0, pairs: 0 });
    // The full sha and git's abbreviation both find it; the take is consumed.
    expect(takeHeldRewritesFor(repo, A.slice(0, 8))).toEqual([{ from: A, to: B }]);
    expect(takeHeldRewritesFor(repo, A)).toEqual([]);
    expect(takeHeldRewritesFor(repo, B)).toEqual([]);
  });

  it('folds the session onto the copy once post-commit records the original', () => {
    const A = commit('wip');
    const B = commit('wip, replayed');
    recordGitRewrites(repo, [{ oldSha: A, newSha: B }]);
    // post-commit, arriving late: records A, then asks for what git said about it.
    const state = { sessionCommitShas: [A], rewrittenCommits: [], commitTurns: [{ sha: A, turnId: 't_1', at: 'now', via: 'post-commit' as const }] };
    expect(applyRewritePairsToState(state, takeHeldRewritesFor(repo, A))).toBe(true);
    expect(state.sessionCommitShas).toEqual([B]);
    expect(state.commitTurns[0].sha).toBe(B);
    expect(state.rewrittenCommits).toEqual([{ from: A, to: B }]);
  });

  it('is recorded on a session that already owns the old sha, and not held', () => {
    const A = commit('wip');
    const B = commit('wip, replayed');
    saveSessionState({
      sessionId: 'sess-held', sessionTag: TAG, claudeSessionId: 'conv-held', agentSlug: 'claude-code',
      status: 'RUNNING', startedAt: new Date(Date.now() - 60_000).toISOString(),
      repoPath: repo, lastCwd: repo, headShaAtStart: A, prompts: ['work'],
      sessionCommitShas: [A],
      commitTurns: [{ sha: A, turnId: 't_1', at: '2026-09-26T04:45:25.000Z', via: 'post-commit' }],
    } as any, repo, TAG);
    expect(recordGitRewrites(repo, [{ oldSha: A, newSha: B }])).toEqual({ sessions: 1, pairs: 1 });
    expect(loadSessionState(repo, TAG)!.sessionCommitShas).toEqual([B]);
    expect(takeHeldRewritesFor(repo, A)).toEqual([]);
  });

  it('a pair of one batch a session owns is recorded while the stranger\'s pair is held', () => {
    const A = commit('mine');
    const B = commit('mine, replayed');
    const X = commit('theirs');
    const Y = commit('theirs, replayed');
    saveSessionState({
      sessionId: 'sess-held-2', sessionTag: TAG, claudeSessionId: 'conv-held-2', agentSlug: 'claude-code',
      status: 'RUNNING', startedAt: new Date(Date.now() - 60_000).toISOString(),
      repoPath: repo, lastCwd: repo, headShaAtStart: A, prompts: ['work'],
      sessionCommitShas: [A], commitTurns: [],
    } as any, repo, TAG);
    expect(recordGitRewrites(repo, [{ oldSha: A, newSha: B }, { oldSha: X, newSha: Y }])).toEqual({ sessions: 1, pairs: 1 });
    expect(takeHeldRewritesFor(repo, A)).toEqual([]);
    expect(takeHeldRewritesFor(repo, X)).toEqual([{ from: X, to: Y }]);
  });

  it('git\'s latest word for a sha replaces an earlier held pair, and a day-old pair is gone', () => {
    const A = commit('wip');
    const B = commit('wip, replayed');
    const C = commit('wip, replayed again');
    expect(holdRewrites(repo, [{ from: A, to: B }])).toBe(1);
    expect(holdRewrites(repo, [{ from: A, to: C }])).toBe(1);
    expect(takeHeldRewritesFor(repo, A)).toEqual([{ from: A, to: C }]);
    holdRewrites(repo, [{ from: A, to: B }]);
    const file = path.join(heldDir(), fs.readdirSync(heldDir())[0]);
    const stale = JSON.parse(fs.readFileSync(file, 'utf-8')).map((p: any) => ({ ...p, at: new Date(Date.now() - 25 * 3_600_000).toISOString() }));
    fs.writeFileSync(file, JSON.stringify(stale));
    expect(takeHeldRewritesFor(repo, A)).toEqual([]);
  });

  it('a linked worktree and the main checkout share one hold', () => {
    const A = commit('wip');
    const B = commit('wip, replayed');
    const wt = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
    git('worktree', 'add', '-q', wt, '-b', 'side');
    try {
      holdRewrites(wt, [{ from: A, to: B }]);
      expect(takeHeldRewritesFor(repo, A)).toEqual([{ from: A, to: B }]);
    } finally {
      git('worktree', 'remove', '--force', wt);
    }
  });
});
