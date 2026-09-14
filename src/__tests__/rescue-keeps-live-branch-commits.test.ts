/**
 * The amend/rebase rescue must not fold one live branch's commit into another's.
 *
 * `rescueAmendedCommitShas` treats a recorded commit HEAD cannot reach as a
 * possible amend, and its first rung maps it onto a commit sitting on the SAME
 * PARENT that the session also owns for the same turn. That is exactly what an
 * amend leaves behind — and exactly what two sibling branches cut from the same
 * base commit look like too.
 *
 * Session 049d69db (2026-09-14) branched four PRs off one main commit in a
 * single turn. The rescue recorded 40416b28 → 05a909f5 → 3f52e3e4 → 5e275a6a as
 * "rewrites", the session's commit list collapsed to the last one, and the
 * turn's card read +9/-1 beside four commits totalling +866/-179.
 *
 * Driven against REAL git: branch reachability is the thing under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testRescueCommitShas } from '../commands/hooks.js';
import { recordTranscriptCommitProofs } from '../commands/hooks/stop.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rescue-live-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

describe('sibling branches cut from one base in the same turn', () => {
  it('keeps the commit on the branch HEAD is not on', () => {
    const start = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'fix/one');
    write('one.ts', 'export const one = 1;\n'); git('add', '-A'); git('commit', '-qm', 'fix: one');
    const one = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'fix/two', start);
    write('two.ts', 'export const two = 2;\n'); git('add', '-A'); git('commit', '-qm', 'fix: two');
    const two = git('rev-parse', 'HEAD');

    const state: any = {
      sessionCommitShas: [one, two], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
      commitTurns: [
        { sha: one, turnId: 't_same', at: '2026-09-14T00:00:00Z', via: 'post-commit' },
        { sha: two, turnId: 't_same', at: '2026-09-14T00:01:00Z', via: 'post-commit' },
      ],
    };
    expect(__testRescueCommitShas(repo, state), 'fix/one was folded into fix/two as if it were an amend').toEqual([one, two]);
    expect(state.rewrittenCommits || []).toEqual([]);
  });

  it('still folds a real amend (the original is on no branch any more)', () => {
    const start = git('rev-parse', 'HEAD');
    write('a.ts', 'export const a = 1;\n'); git('add', '-A'); git('commit', '-qm', 'feat: a');
    const original = git('rev-parse', 'HEAD');
    write('b.ts', 'export const b = 1;\n'); git('add', '-A'); git('commit', '-q', '--amend', '-m', 'feat: a and b');
    const amended = git('rev-parse', 'HEAD');

    const state: any = {
      sessionCommitShas: [original, amended], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
      commitTurns: [
        { sha: original, turnId: 't_same', at: '2026-09-14T00:00:00Z', via: 'post-commit' },
        { sha: amended, turnId: 't_same', at: '2026-09-14T00:01:00Z', via: 'post-commit' },
      ],
    };
    expect(__testRescueCommitShas(repo, state)).toEqual([amended]);
  });
});

// Session 936ac5d1 (2026-09-14): `gh pr merge --squash --delete-branch` removed
// the PR's local branch and left its commit on no branch. Its sibling from the
// same turn sat on the same parent, and the rescue recorded the PR as amended
// into it: 48cad5c0 -> 8c608841.
describe('a sibling that was merged and had its branch deleted', () => {
  const siblings = () => {
    const start = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'fix/one');
    write('one.ts', 'export const one = 1;\n'); git('add', '-A'); git('commit', '-qm', 'fix: one');
    const one = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'fix/two', start);
    write('two.ts', 'export const two = 2;\n'); git('add', '-A'); git('commit', '-qm', 'test: two');
    const two = git('rev-parse', 'HEAD');
    const state: any = {
      sessionCommitShas: [one, two], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
      commitTurns: [
        { sha: one, turnId: 't_same', at: '2026-09-14T00:00:00Z', via: 'post-commit' },
        { sha: two, turnId: 't_same', at: '2026-09-14T00:01:00Z', via: 'post-commit' },
      ],
    };
    return { start, one, two, state };
  };

  it('keeps it when it was squash-merged upstream and the remote branch is gone', () => {
    const { start, one, two, state } = siblings();
    git('checkout', '-q', '--detach', start);
    git('merge', '-q', '--squash', 'fix/one');
    git('commit', '-qm', 'fix: one (#1)');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('checkout', '-q', 'fix/two');
    git('branch', '-q', '-D', 'fix/one');

    expect(__testRescueCommitShas(repo, state), 'the merged PR was folded into its sibling as if amended').toEqual([one, two]);
    expect(state.rewrittenCommits || []).toEqual([]);
  });

  it('keeps it while a remote-tracking branch still holds it', () => {
    const { one, two, state } = siblings();
    git('update-ref', 'refs/remotes/origin/fix/one', one);
    git('checkout', '-q', 'fix/two');
    git('branch', '-q', '-D', 'fix/one');

    expect(__testRescueCommitShas(repo, state)).toEqual([one, two]);
  });

  it('still folds a real amend when the remotes hold unrelated history', () => {
    const start = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', start);
    write('a.ts', 'export const a = 1;\n'); git('add', '-A'); git('commit', '-qm', 'feat: a');
    const original = git('rev-parse', 'HEAD');
    write('b.ts', 'export const b = 1;\n'); git('add', '-A'); git('commit', '-q', '--amend', '-m', 'feat: a and b');
    const amended = git('rev-parse', 'HEAD');
    const state: any = {
      sessionCommitShas: [original, amended], repoPath: repo, sessionTag: 'test', headShaAtStart: start,
      commitTurns: [
        { sha: original, turnId: 't_same', at: '2026-09-14T00:00:00Z', via: 'post-commit' },
        { sha: amended, turnId: 't_same', at: '2026-09-14T00:01:00Z', via: 'post-commit' },
      ],
    };
    expect(__testRescueCommitShas(repo, state)).toEqual([amended]);
  });
});

describe('a transcript proof for a commit that was amended away', () => {
  it('is not re-filed on the turn beside its amendment', () => {
    const original = 'e79941c238139381e9cd337fbe1fd924e9ebd991';
    const amended = 'e6ccbb7fa5e1d4e660db4204251a8107ecc35874';
    const unrelated = 'ae323f3107ce58ef421b9cd5b1591e6070fd9ffa';
    const state: any = {
      promptTurnIds: ['t_zero'],
      commitTurns: [{ sha: amended, turnId: 't_zero', at: '2026-09-14T02:48:23Z', via: 'post-commit' }],
      rewrittenCommits: [{ from: original, to: amended }],
    };
    recordTranscriptCommitProofs(state, [
      { promptIndex: 0, sha: original },
      { promptIndex: 0, sha: unrelated },
    ]);
    const shas = state.commitTurns.map((c: any) => c.sha);
    expect(shas, 'the amended-away original came back via the transcript').not.toContain(original);
    expect(shas).toEqual([amended, unrelated]);
  });
});
