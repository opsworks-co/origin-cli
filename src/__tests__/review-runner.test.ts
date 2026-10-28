// `origin review runner`: which checkouts it watches, which one a claimed run
// goes to, and one --once cycle against a fake server and a fake review.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkoutsToWatch, pickCheckout, pollForReviewRun, reviewRunnerCommand, reviewRunnerCycle,
  MAX_CONSECUTIVE_POLL_FAILURES, type ClaimedReviewRun, type ReviewRunnerDeps, type WatchedCheckout,
} from '../commands/review-runner.js';

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** A git checkout with an `origin` remote naming `owner/name` (no network needed). */
function repoWithRemote(dir: string, remote: string | null): string {
  fs.mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'init');
  if (remote) g(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

let tmp: string;
let app: string;     // acme/app, https remote
let lib: string;     // acme/lib, ssh remote
let bare: string;    // no remote
let appWorktree: string; // a linked worktree of app

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-review-runner-'));
  app = repoWithRemote(path.join(tmp, 'app'), 'https://github.com/acme/app.git');
  lib = repoWithRemote(path.join(tmp, 'lib'), 'git@github.com:acme/lib.git');
  bare = repoWithRemote(path.join(tmp, 'noremote'), null);
  appWorktree = path.join(tmp, 'app-worktrees', 'feat');
  g(app, 'worktree', 'add', '-q', '-b', 'feat', appWorktree);
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

const real = (p: string) => fs.realpathSync(p);

describe('checkoutsToWatch', () => {
  it('maps each checkout to its owner/name, skipping one without a remote, deduplicating a linked worktree against its main checkout', () => {
    const got = checkoutsToWatch(undefined, appWorktree, () => [lib, bare, app, lib]);
    expect(got.map((c) => [real(c.path), c.fullName])).toEqual([[real(app), 'acme/app'], [real(lib), 'acme/lib']]);
  });

  it('--repo wins over discovery, and a path that is not a git checkout is ignored', () => {
    const discover = vi.fn(() => [app]);
    const got = checkoutsToWatch([lib, path.join(tmp, 'nowhere')], tmp, discover);
    expect(got.map((c) => c.fullName)).toEqual(['acme/lib']);
    expect(discover).not.toHaveBeenCalled();
  });

  it('a cwd outside any repo watches only what discovery finds', () => {
    expect(checkoutsToWatch(undefined, tmp, () => [app]).map((c) => c.fullName)).toEqual(['acme/app']);
    expect(checkoutsToWatch(undefined, tmp, () => [])).toEqual([]);
  });
});

describe('pickCheckout', () => {
  const list: WatchedCheckout[] = [{ path: '/a', fullName: 'Acme/App' }, { path: '/l', fullName: 'acme/lib' }];
  it('matches the full name case-insensitively, null when none', () => {
    expect(pickCheckout('acme/app', list)?.path).toBe('/a');
    expect(pickCheckout('ACME/LIB', list)?.path).toBe('/l');
    expect(pickCheckout('acme/other', list)).toBeNull();
  });
});

describe('pollForReviewRun', () => {
  const run: ClaimedReviewRun = { id: 'run-1', prNumber: 7, repoFullName: 'acme/app', reviewerName: 'Security' };
  it('classifies a claim, an empty queue, one blip (retried) and two failures', async () => {
    expect(await pollForReviewRun(async () => ({ run }))).toEqual({ status: 'claimed', run });
    expect((await pollForReviewRun(async () => ({ run: null }))).status).toBe('idle');
    const blip = vi.fn().mockRejectedValueOnce(new Error('aborted')).mockResolvedValueOnce({ run: null });
    expect((await pollForReviewRun(blip)).status).toBe('idle');
    expect(blip).toHaveBeenCalledTimes(2);
    const dead = await pollForReviewRun(vi.fn().mockRejectedValue(new Error('This operation was aborted')));
    expect(dead.status).toBe('poll-failed');
    if (dead.status === 'poll-failed') expect(dead.error).toMatch(/aborted/);
  });
});

function fakeDeps(over: Partial<ReviewRunnerDeps> = {}) {
  const lines: string[] = [];
  const ranIn: Array<{ runId: string; cwd: string }> = [];
  const exits: number[] = [];
  const deps: ReviewRunnerDeps = {
    cwd: app,
    machineId: 'box',
    log: (l) => lines.push(l),
    claim: async () => ({ run: null }),
    runReview: async (runId, cwd) => {
      ranIn.push({ runId, cwd });
      return { runId, ok: true, branch: 'review/7/run-1', worktree: null, headSha: 'abc', error: null, result: { verdict: 'approve', summary: 's', findings: [] } };
    },
    discover: () => [lib],
    sleep: async () => {},
    version: () => '1',
    exit: (code) => { exits.push(code); },
    ...over,
  };
  return { deps, lines, ranIn, exits };
}

describe('origin review runner --once', () => {
  it('names the repos it watches, claims with all of them, and runs the claimed run in the matching checkout', async () => {
    const run: ClaimedReviewRun = { id: 'run-1', prNumber: 7, repoFullName: 'ACME/lib', reviewerName: 'Security' };
    const claim = vi.fn<ReviewRunnerDeps['claim']>().mockResolvedValueOnce({ run }).mockResolvedValue({ run: null });
    const { deps, lines, ranIn, exits } = fakeDeps({ claim });
    await reviewRunnerCommand({ once: true }, deps);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith({ machineId: 'box', repos: ['acme/app', 'acme/lib'] });
    expect(ranIn).toHaveLength(1);
    expect(ranIn[0].runId).toBe('run-1');
    expect(real(ranIn[0].cwd)).toBe(real(lib));
    expect(lines.join('\n')).toMatch(/acme\/app/);
    expect(lines.join('\n')).toMatch(/▶ Security on ACME\/lib#7/);
    expect(lines.join('\n')).toMatch(/✓ Security on #7: approve — 0 finding/);
    expect(exits).toEqual([]);
  });

  it('with nothing queued says so; a failed poll exits 1 for cron', async () => {
    const idle = fakeDeps();
    await reviewRunnerCommand({ once: true }, idle.deps);
    expect(idle.ranIn).toEqual([]);
    expect(idle.lines.join('\n')).toMatch(/Nothing queued/);
    expect(idle.exits).toEqual([]);

    const down = fakeDeps({ claim: async () => { throw new Error('ECONNREFUSED'); } });
    await reviewRunnerCommand({ once: true }, down.deps);
    expect(down.exits).toEqual([1]);
  });

  it('refuses to start with no checkout to watch', async () => {
    const { deps, exits, lines } = fakeDeps({ cwd: tmp, discover: () => [] });
    await reviewRunnerCommand({ once: true }, deps);
    expect(exits).toEqual([2]);
    expect(lines.join('\n')).toMatch(/No checkout to watch/);
  });

  it('a run that throws is logged as failed and the cycle still counts as ran', async () => {
    const run: ClaimedReviewRun = { id: 'run-2', prNumber: 8, repoFullName: 'acme/app', reviewerName: 'Tests' };
    const { deps, lines } = fakeDeps({ claim: async () => ({ run }), runReview: async () => { throw new Error('boom'); } });
    const checkouts = checkoutsToWatch(undefined, app, () => []);
    expect(await reviewRunnerCycle(checkouts, deps)).toBe('ran');
    expect(lines.join('\n')).toMatch(/✗ run-2: boom/);
  });
});

describe('the polling loop', () => {
  it('drains a backlog without sleeping, sleeps when idle, and restarts onto a newer binary', async () => {
    const run = (n: number): ClaimedReviewRun => ({ id: `run-${n}`, prNumber: n, repoFullName: 'acme/app', reviewerName: 'R' });
    const claim = vi.fn<ReviewRunnerDeps['claim']>()
      .mockResolvedValueOnce({ run: run(1) })
      .mockResolvedValueOnce({ run: run(2) })
      .mockResolvedValue({ run: null });
    const sleeps: number[] = [];
    let polls = 0;
    // Two runs, one idle poll (sleeps), then the on-disk version is newer.
    const versions = ['1', '1', '1', '1', '2'];
    const { deps, ranIn, exits } = fakeDeps({
      claim: (d) => { polls++; return claim(d); },
      sleep: async (ms) => { sleeps.push(ms); },
      version: () => versions[Math.min(polls, versions.length - 1)],
      exit: (code) => { exits.push(code); throw new Error(`exit ${code}`); },
    });
    await expect(reviewRunnerCommand({ interval: '7' }, deps)).rejects.toThrow('exit 0');
    expect(ranIn.map((r) => r.runId)).toEqual(['run-1', 'run-2']);
    expect(sleeps).toEqual([7000]);
    expect(exits).toEqual([0]);
  });

  it('exits 1 after MAX_CONSECUTIVE_POLL_FAILURES failed polls in a row', async () => {
    let n = 0;
    const { deps, exits } = fakeDeps({
      claim: async () => { n++; throw new Error('down'); },
      exit: (code) => { exits.push(code); throw new Error(`exit ${code}`); },
    });
    await expect(reviewRunnerCommand({}, deps)).rejects.toThrow('exit 1');
    // Each poll retries once, so twice the attempts.
    expect(n).toBe(MAX_CONSECUTIVE_POLL_FAILURES * 2);
    expect(exits).toEqual([1]);
  });
});
