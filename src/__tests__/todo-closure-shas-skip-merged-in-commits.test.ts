/**
 * A `[Origin: Closes]` claim names the session's OWN commits, not every commit
 * in session-start..HEAD.
 *
 * TODO 25d67628 (2026-10-30): its run committed the work (PR #2810, still
 * open), then ran `git merge origin/main`. Stop handed the claim the whole
 * range — its commit, a merge of #2803's branch and #2814's commit — and the
 * sweep confirms a claim as soon as ANY of its shas is on the default branch.
 * Those two were, so Issues closed the TODO as done by #2803.
 *
 * Real git on purpose: the defect is what `start..HEAD` yields after a merge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { captureGitState } from '../git-capture.js';
import { closingCommitShas } from '../commands/hooks/stop.js';

const LOCAL = 't@origin.dev';
const OURS = '784f8f47-80a2-4e2c-8194-970f36ada25f';
const OTHER = '2f434ef4-0ab5-4ae8-8279-338229e78409';
const HOUR = 3600_000;
const NOW = Date.now();
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('closingCommitShas', () => {
  let repo: string;
  let n = 0;
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

  function commit(subject: string, opts: { trailer?: string; committer?: string; when: string }): string {
    fs.writeFileSync(path.join(repo, `f${++n}.txt`), `${subject}\n`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', opts.trailer ? `${subject}\n\nOrigin-Session: ${opts.trailer}` : subject], {
      GIT_COMMITTER_EMAIL: opts.committer || LOCAL, GIT_COMMITTER_NAME: opts.committer ? 'GitHub' : 'T',
      GIT_COMMITTER_DATE: opts.when, GIT_AUTHOR_DATE: opts.when,
    });
    return git(['rev-parse', 'HEAD']);
  }

  let start: string;
  let own: string;
  let foreign: string;
  let merge: string;

  beforeEach(() => {
    n = 0;
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-closure-shas-')));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', LOCAL]);
    git(['config', 'user.name', 'T']);
    git(['config', 'commit.gpgsign', 'false']);
    start = commit('seed', { when: at(3 * HOUR) });
    git(['checkout', '-q', '-b', 'issue/25d67628-split']);
    own = commit('feat: split the cost tab (25d67628)', { trailer: OURS, when: at(HOUR) });
    // Another PR lands on main meanwhile (a GitHub squash, its own session's trailer)…
    git(['checkout', '-q', 'main']);
    foreign = commit('feat(dashboard): count people (#2814)', { trailer: OTHER, committer: 'noreply@github.com', when: at(HOUR / 2) });
    // …and the session merges main into its branch before claiming the TODO.
    git(['checkout', '-q', 'issue/25d67628-split']);
    git(['merge', '-q', '--no-edit', 'main'], { GIT_COMMITTER_DATE: at(HOUR / 4), GIT_AUTHOR_DATE: at(HOUR / 4) });
    merge = git(['rev-parse', 'HEAD']);
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  const state = (sessionCommitShas: string[]): any => ({
    sessionId: OURS, repoPath: repo, headShaAtStart: start, startedAt: at(2 * HOUR), sessionCommitShas,
  });

  it('the range takes in what the merge brought; the claim does not', () => {
    // What the claim used to get.
    expect(captureGitState(repo, start).commitShas).toContain(foreign);
    expect(closingCommitShas(repo, state([own, merge]))).toEqual([own, merge]);
  });

  it('with no post-commit record, the owned range still leaves the merged-in commit out', () => {
    const shas = closingCommitShas(repo, state([]));
    expect(shas).toContain(own);
    expect(shas).not.toContain(foreign);
  });

  it('no repo, no shas', () => {
    expect(closingCommitShas(null, state([]))).toEqual([]);
  });
});
