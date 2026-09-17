/**
 * A commit rewrite is only what git proves: a `commit (amend)` reflog chain,
 * the same patch-id or tree, or a successor a rebase step produced.
 *
 * Session 874ff028 repeatedly committed "wip", then
 * `git reset --soft HEAD~1 && git reset`, and later made a DIFFERENT real commit
 * on the same parent. The rescue's same-parent rung paired each thrown-away
 * commit with the later one: `ownedSameTurn` answered true because post-commit
 * had recorded no turn for one side, and a shared subject ("wip") counted too.
 * It sent fake chains (650598eb → ca004579 → d518fbf4 → b316816f) as
 * rewrittenCommits, and the server repointed turn 5 onto b761a610, a commit
 * turn 8 made. Server PR #1681 trusts the CLI's pairs; the CLI must not invent
 * them.
 *
 * Driven against REAL git: reflogs, patch-ids and trees are what is tested.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testRescueCommitShas } from '../commands/hooks.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const head = () => git('rev-parse', 'HEAD');
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
const commit = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); return head(); };

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rewrite-proof-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n'); commit('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

const turn = (sha: string, turnId: string) => ({ sha, turnId, at: '2026-09-16T00:00:00Z', via: 'post-commit' });

describe('reset away, then a DIFFERENT commit on the same parent, is not a rewrite', () => {
  const resetAndRecommit = () => {
    const start = head();
    write('src.ts', 'export const v = 1;\n');
    const wip = commit('wip');
    git('reset', '-q', '--soft', 'HEAD~1');
    git('reset', '-q');
    write('src.ts', 'export const v = 2;\nexport const w = 3;\n');
    const real = commit('wip');
    return { start, wip, real };
  };

  it('when post-commit recorded no turn for the thrown-away commit', () => {
    const { start, wip, real } = resetAndRecommit();
    const state: any = {
      sessionCommitShas: [wip, real], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
      commitTurns: [turn(real, 't_8')],
    };
    const kept = __testRescueCommitShas(repo, state);
    expect(state.rewrittenCommits || [], 'a reset + new commit was declared a rewrite').toEqual([]);
    expect(kept).toEqual([wip, real]);
  });

  it('even when both commits were filed under the same turn', () => {
    const { start, wip, real } = resetAndRecommit();
    const state: any = {
      sessionCommitShas: [wip, real], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
      commitTurns: [turn(wip, 't_5'), turn(real, 't_5')],
    };
    expect(__testRescueCommitShas(repo, state)).toEqual([wip, real]);
    expect(state.rewrittenCommits || []).toEqual([]);
  });

  it('a commit `checkout -B` left behind is not a rewrite of the branch\'s new commit', () => {
    const start = head();
    git('checkout', '-q', '-b', 'fix/x');
    write('tmp.ts', 'export const tmp = 1;\n');
    const tmp = commit('tmp');
    git('checkout', '-q', 'main');
    write('main.txt', 'moved\n');
    const moved = commit('main moved');
    git('checkout', '-q', '-B', 'fix/x', moved);
    write('tmp.ts', 'export const real = 2;\n');
    const real = commit('fix: the real change');
    const state: any = {
      sessionCommitShas: [tmp, real], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
      commitTurns: [turn(tmp, 't_4'), turn(real, 't_6')],
    };
    __testRescueCommitShas(repo, state);
    expect(state.rewrittenCommits || []).toEqual([]);
    expect(state.sessionCommitShas).toContain(real);
  });
});

describe('git-proven rewrites still fold', () => {
  it('a real amend with a new subject and an extra file, no turn recorded', () => {
    const start = head();
    write('a.ts', 'export const a = 1;\n');
    const original = commit('feat: a');
    write('b.ts', 'export const b = 1;\n'); git('add', '-A');
    git('commit', '-q', '--amend', '-m', 'feat: a and b');
    const amended = head();
    const state: any = { sessionCommitShas: [original, amended], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    expect(__testRescueCommitShas(repo, state)).toEqual([amended]);
    expect(state.rewrittenCommits).toEqual([{ from: original, to: amended }]);
  });

  it('a rebase that re-bumped a version file (patch-id moved)', () => {
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'mine\n'); write('version.txt', 'v1\n');
    const original = commit('feat: my work');
    git('checkout', '-q', 'main');
    write('other.txt', 'theirs\n'); commit('someone else');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    write('version.txt', 'v2\n'); git('add', '-A'); git('commit', '-q', '--amend', '--no-edit');
    const rewritten = head();
    const state: any = { sessionCommitShas: [original, rewritten], repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([rewritten]);
    expect(state.rewrittenCommits).toEqual([{ from: original, to: rewritten }]);
  });

  it('a plain rebase onto a moved main (same patch)', () => {
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'mine\n');
    const original = commit('feat: my work');
    git('checkout', '-q', 'main');
    write('other.txt', 'theirs\n'); commit('someone else');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    const rewritten = head();
    const state: any = { sessionCommitShas: [original], repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([rewritten]);
  });
});

describe('sibling branches are not rewrites of each other', () => {
  it('keeps a commit still on another local branch', () => {
    const start = head();
    git('checkout', '-q', '-b', 'fix/one');
    write('one.ts', 'export const one = 1;\n');
    const one = commit('fix: one');
    git('checkout', '-q', '-b', 'fix/two', start);
    write('two.ts', 'export const two = 2;\n');
    const two = commit('fix: two');
    const state: any = {
      sessionCommitShas: [one, two], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
      commitTurns: [turn(one, 't_1')],
    };
    expect(__testRescueCommitShas(repo, state)).toEqual([one, two]);
    expect(state.rewrittenCommits || []).toEqual([]);
  });
});
