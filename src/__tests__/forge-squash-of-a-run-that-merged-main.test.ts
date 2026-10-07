/**
 * A forge's squash of a branch that merged main in is a rewrite of that branch.
 *
 * Session d027b430, PR #1929 (2026-09-27): turn 7 committed 133fa563, turn 8
 * merged main into the PR branch (0bee0765) and bumped the version (fe322fac),
 * and GitHub squash-merged it as 291c3fdd5 on the main the merge had absorbed.
 * The rescue's squash rule wants the squash's PARENT to be the run's base and
 * its TREE the run's tip tree; a forge squash has neither once the branch took
 * main in. No orphan was replaced, the session never held 291c3fdd5, and
 * `origin why` on the lines that landed said "committed without an active
 * Origin session".
 *
 * Driven against real git, like rebase-duplicate-commits.
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
const commit = (f: string, c: string, msg: string) => { write(f, c); git('add', '-A'); git('commit', '-qm', msg); return head(); };

let start = '';
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-forge-squash-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  start = commit('base.txt', 'base\n', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

/** The PR branch: a commit, main merged in, a bump. Returns the three shas. */
function prThatMergedMain(): string[] {
  git('checkout', '-q', '-b', 'pr');
  const work = commit('flag.ts', 'export const flag = 1;\n', 'fix: the chatOnly mark dies with the fill');
  git('checkout', '-q', 'main');
  commit('other.ts', 'export const other = 1;\n', 'fix: someone else lands first');
  git('checkout', '-q', 'pr');
  git('merge', '-q', '--no-edit', 'main');
  const merge = head();
  const bump = commit('version.txt', '0.20260927.1402\n', 'chore: version bump');
  return [work, merge, bump];
}

/** What GitHub's "Squash and merge" leaves: one commit on main, the branch gone. */
function forgeSquash(): string {
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'pr');
  git('commit', '-qm', 'fix: the chatOnly mark dies with the fill (#1929)');
  const squash = head();
  git('branch', '-q', '-D', 'pr');
  return squash;
}

describe('a forge squash of a run that merged main in', () => {
  it('replaces every commit of the run with the squash', () => {
    const run = prThatMergedMain();
    const squash = forgeSquash();
    const state: any = { sessionId: 's-forge', sessionCommitShas: [...run], headShaAtStart: start, repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([squash]);
  });

  it('still finds it when main moved again before the squash', () => {
    const run = prThatMergedMain();
    git('checkout', '-q', 'main');
    commit('late.ts', 'export const late = 1;\n', 'fix: lands between the merge and the squash');
    const squash = forgeSquash();
    const state: any = { sessionId: 's-forge-moved', sessionCommitShas: [...run], headShaAtStart: start, repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([squash]);
  });

  it('takes no commit whose patch is not the run\'s', () => {
    const run = prThatMergedMain();
    git('checkout', '-q', 'main');
    git('branch', '-q', '-D', 'pr');
    // Something else lands on main; the PR was closed, not merged.
    commit('flag.ts', 'export const flag = 2;\n', 'fix: a different flag');
    const state: any = { sessionId: 's-forge-none', sessionCommitShas: [...run], headShaAtStart: start, repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual(run);
  });
});
