// `origin review runner`: which checkouts it watches, which one a claimed run
// goes to, and one --once cycle against a fake server and a fake review.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkoutsToWatch, depsForRunnerMode, pickCheckout, remoteRepoNames, repoNamesOf, pollForReviewRun, reviewRunnerCommand, reviewRunnerCycle,
  MAX_CONSECUTIVE_POLL_FAILURES, MAX_PARALLEL, RUNNER_HEARTBEAT_MS, parallelWorkers, runnerMode, slotsFromHello, type ClaimedReviewRun, type ReviewRunnerDeps, type RunnerHello, type WatchedCheckout,
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
let hosted: string;  // origin/team-5ba5e2/test33, an Origin-hosted RhodeCode repo (three-part path)

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-review-runner-'));
  app = repoWithRemote(path.join(tmp, 'app'), 'https://github.com/acme/app.git');
  lib = repoWithRemote(path.join(tmp, 'lib'), 'git@github.com:acme/lib.git');
  bare = repoWithRemote(path.join(tmp, 'noremote'), null);
  appWorktree = path.join(tmp, 'app-worktrees', 'feat');
  g(app, 'worktree', 'add', '-q', '-b', 'feat', appWorktree);
  hosted = repoWithRemote(path.join(tmp, 'hosted'), 'https://code.rhodecode.com/origin/team-5ba5e2/test33');
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

describe('a repo whose path has more than two parts', () => {
  it('goes by its whole path first, then its last two parts; a two-part path only by itself', () => {
    expect(remoteRepoNames('https://code.rhodecode.com/origin/team-5ba5e2/test33')).toEqual(['origin/team-5ba5e2/test33', 'team-5ba5e2/test33']);
    expect(remoteRepoNames('https://gitlab.com/group/sub/repo.git/')).toEqual(['group/sub/repo', 'sub/repo']);
    expect(remoteRepoNames('git@gitlab.com:group/sub/repo.git')).toEqual(['group/sub/repo', 'sub/repo']);
    expect(remoteRepoNames('ssh://git@gitlab.example.com:2222/group/sub/repo.git')).toEqual(['group/sub/repo', 'sub/repo']);
    expect(remoteRepoNames('https://github.com/acme/app.git')).toEqual(['acme/app']);
    expect(remoteRepoNames('git@github.com:acme/lib.git')).toEqual(['acme/lib']);
    expect(remoteRepoNames('')).toEqual([]);
  });

  it('is watched under its whole path, and a claim names it both ways', () => {
    const got = checkoutsToWatch([hosted, lib], tmp, () => []);
    expect(got.map((c) => c.fullName)).toEqual(['origin/team-5ba5e2/test33', 'acme/lib']);
    expect(repoNamesOf(got)).toEqual(['origin/team-5ba5e2/test33', 'team-5ba5e2/test33', 'acme/lib']);
    expect(pickCheckout('ORIGIN/team-5ba5e2/test33', got)?.path).toBe(real(hosted));
  });

  it('a local check the server hands out under the whole path runs in that checkout', async () => {
    const check = { id: 'chk-h', name: 'origin/local-ci', repoFullName: 'origin/team-5ba5e2/test33', prNumber: 4 } as any;
    const claimLocal = vi.fn<NonNullable<ReviewRunnerDeps['claimLocal']>>().mockResolvedValueOnce({ check }).mockResolvedValue({ check: null });
    const runLocal = vi.fn<NonNullable<ReviewRunnerDeps['runLocal']>>(async () => ({}) as any);
    const { deps } = fakeDeps({ cwd: tmp, discover: () => [hosted], claimLocal, runLocal });
    await reviewRunnerCommand({ once: true }, deps);
    expect(claimLocal.mock.calls[0]![0].repos).toEqual(['origin/team-5ba5e2/test33', 'team-5ba5e2/test33']);
    expect(runLocal).toHaveBeenCalledTimes(1);
    expect(real(runLocal.mock.calls[0]![1])).toBe(real(hosted));
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

describe('the process instance', () => {
  it('claims with this process\'s instance and heartbeats it while a run runs, then stops', async () => {
    vi.useFakeTimers();
    try {
      const run: ClaimedReviewRun = { id: 'run-3', prNumber: 9, repoFullName: 'acme/app', reviewerName: 'R' };
      const claim = vi.fn<ReviewRunnerDeps['claim']>().mockResolvedValue({ run });
      const heartbeat = vi.fn(async () => ({}));
      let finish!: () => void;
      const { deps } = fakeDeps({
        instance: 'proc-1', claim, heartbeat,
        runReview: (runId) => new Promise((resolve) => {
          finish = () => resolve({ runId, ok: true, branch: null, worktree: null, headSha: null, error: null, result: null });
        }),
      });
      const cycle = reviewRunnerCycle(checkoutsToWatch(undefined, app, () => []), deps);
      await vi.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledWith({ machineId: 'box', instance: 'proc-1', repos: ['acme/app'] });
      await vi.advanceTimersByTimeAsync(RUNNER_HEARTBEAT_MS * 2 + 1);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(heartbeat).toHaveBeenCalledWith({ machineId: 'box', instance: 'proc-1' });
      finish();
      expect(await cycle).toBe('ran');
      await vi.advanceTimersByTimeAsync(RUNNER_HEARTBEAT_MS * 3);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

describe('origin review runner — orchestrator issues', () => {
  const orun = { id: 'orun-1', repoFullName: 'acme/lib', shortId: 'ori-7', agent: 'codex' };

  it('launches a claimed orchestrator issue in the matching checkout before any review, and reports it', async () => {
    const launched: Array<{ shortId: string; cwd: string }> = [];
    const reports: Array<{ id: string; ok: boolean; output: string }> = [];
    const claim = vi.fn<ReviewRunnerDeps['claim']>().mockResolvedValue({ run: null });
    const { deps, lines } = fakeDeps({
      claim,
      claimOrchestrator: async () => ({ run: orun }),
      launchOrchestrator: async (r, cwd) => { launched.push({ shortId: r.shortId, cwd }); return { ok: true, output: '✓ codex is working on ori-7' }; },
      reportOrchestrator: async (id, data) => { reports.push({ id, ...data }); },
    });
    const res = await reviewRunnerCycle([{ path: app, fullName: 'acme/app' }, { path: lib, fullName: 'acme/lib' }], deps);
    expect(res).toBe('ran');
    expect(launched).toHaveLength(1);
    expect(real(launched[0].cwd)).toBe(real(lib));
    expect(reports).toEqual([{ id: 'orun-1', ok: true, output: '✓ codex is working on ori-7' }]);
    expect(claim).not.toHaveBeenCalled(); // reviews wait for the next cycle
    expect(lines.join('\n')).toMatch(/✓ codex started on ori-7/);
  });

  it('reports a failure when there is no checkout of the repo, and a throwing launch as a failure', async () => {
    const reports: Array<{ ok: boolean; output: string }> = [];
    const report = async (_id: string, data: { ok: boolean; output: string }) => { reports.push(data); };
    const none = fakeDeps({ claimOrchestrator: async () => ({ run: { ...orun, repoFullName: 'acme/elsewhere' } }), launchOrchestrator: async () => ({ ok: true, output: '' }), reportOrchestrator: report });
    await reviewRunnerCycle([{ path: lib, fullName: 'acme/lib' }], none.deps);
    const boom = fakeDeps({ claimOrchestrator: async () => ({ run: orun }), launchOrchestrator: async () => { throw new Error('spawn failed'); }, reportOrchestrator: report });
    await reviewRunnerCycle([{ path: lib, fullName: 'acme/lib' }], boom.deps);
    expect(reports).toEqual([
      { ok: false, output: 'no checkout of acme/elsewhere on box' },
      { ok: false, output: 'spawn failed' },
    ]);
  });

  it('a failing orchestrator claim (an older server) never stops the reviews', async () => {
    const run: ClaimedReviewRun = { id: 'run-9', prNumber: 9, repoFullName: 'acme/lib', reviewerName: 'Security' };
    const { deps, ranIn } = fakeDeps({
      claim: async () => ({ run }),
      claimOrchestrator: async () => { throw new Error('404'); },
      launchOrchestrator: async () => ({ ok: true, output: '' }),
      reportOrchestrator: async () => {},
    });
    await reviewRunnerCycle([{ path: lib, fullName: 'acme/lib' }], deps);
    expect(ranIn.map((r) => r.runId)).toEqual(['run-9']);
  });
});

describe('--parallel', () => {
  it('reads a worker count, 1 for anything that is not a positive number, capped at MAX_PARALLEL', () => {
    expect(parallelWorkers(undefined)).toBe(1);
    expect(parallelWorkers('0')).toBe(1);
    expect(parallelWorkers('abc')).toBe(1);
    expect(parallelWorkers('3')).toBe(3);
    expect(parallelWorkers('2.7')).toBe(2);
    expect(parallelWorkers('99')).toBe(MAX_PARALLEL);
  });

  it('drives several runs at once, each worker claiming under its own instance; only worker 0 takes orchestrator issues and local checks', async () => {
    const run = (n: number): ClaimedReviewRun => ({ id: `run-${n}`, prNumber: n, repoFullName: 'acme/app', reviewerName: 'R' });
    const queue = [run(1), run(2), run(3)];
    const claimedBy: Array<string | undefined> = [];
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    let nextWorker = 0;
    const claimLocal = vi.fn(async () => ({ check: null }));
    const claimOrchestrator = vi.fn(async () => ({ run: null }));
    const { deps, exits, ranIn } = fakeDeps({
      instance: 'w0',
      claim: async (d) => {
        const r = queue.shift() ?? null;
        if (r) claimedBy.push(d.instance);
        return { run: r };
      },
      runReview: (runId, cwd) => new Promise((resolve) => {
        ranIn.push({ runId, cwd });
        running++; peak = Math.max(peak, running);
        gates.push(() => { running--; resolve({ runId, ok: true, branch: null, worktree: null, headSha: null, error: null, result: null }); });
      }),
      claimLocal, runLocal: vi.fn(),
      claimOrchestrator, launchOrchestrator: vi.fn(), reportOrchestrator: vi.fn(),
      worker: () => {
        const id = `w${++nextWorker}`;
        return { instance: id, runReview: deps.runReview };
      },
      // Idle: version bump stops every worker.
      sleep: async () => { gates.length === 0 && queue.length === 0 && (version = '2'); },
      version: () => version,
    });
    let version = '1';
    const done = reviewRunnerCommand({ parallel: '3' }, deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(peak).toBe(3);
    expect(new Set(claimedBy)).toEqual(new Set(['w0', 'w1', 'w2']));
    gates.splice(0).forEach((g) => g());
    await done;
    expect(ranIn.map((r) => r.runId).sort()).toEqual(['run-1', 'run-2', 'run-3']);
    expect(claimLocal.mock.calls.length).toBeGreaterThan(0);
    // Worker 0 alone polls local checks and orchestrator issues.
    expect(claimLocal.mock.calls.length).toBe(claimOrchestrator.mock.calls.length);
    expect(exits).toEqual([0]);
  });
});

describe('Settings → Runners', () => {
  it('reads the slots the dashboard answers, keeping the fallback when it says nothing usable', () => {
    expect(slotsFromHello({ slots: 3 }, 1)).toBe(3);
    expect(slotsFromHello({ slots: 0 }, 2)).toBe(0);
    expect(slotsFromHello({ slots: 99 }, 1)).toBe(MAX_PARALLEL);
    expect(slotsFromHello({ slots: -1 }, 2)).toBe(2);
    expect(slotsFromHello(null, 2)).toBe(2);
    expect(runnerMode({})).toBe('all');
    expect(runnerMode({ localCi: false })).toBe('no_local_ci');
    expect(runnerMode({ localCiOnly: true })).toBe('local_ci_only');
  });

  it('says hello with what it is, and a paused runner takes nothing, even with --once', async () => {
    const claim = vi.fn(async () => ({ run: null }));
    const claimLocal = vi.fn(async () => ({ check: null }));
    const hello = vi.fn(async () => ({ slots: 0, scope: 'mine' }));
    const { deps, lines } = fakeDeps({ claim, claimLocal, runLocal: vi.fn(), hello });
    await reviewRunnerCommand({ once: true, parallel: '2', localCi: false }, deps);
    expect(hello).toHaveBeenCalledWith({ machineId: 'box', version: '1', parallel: 2, mode: 'no_local_ci', repos: ['acme/app', 'acme/lib'] });
    expect(claim).not.toHaveBeenCalled();
    expect(claimLocal).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('Paused in Settings → Runners');
  });

  it('says hello with --scope when given, and drops a scope that is not mine or workspace', async () => {
    const hello = vi.fn(async (_data: RunnerHello) => ({ slots: 0 }));
    const { deps } = fakeDeps({ claim: vi.fn(async () => ({ run: null })), hello });
    await reviewRunnerCommand({ once: true, scope: 'workspace' }, deps);
    expect(hello).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'workspace' }));
    await reviewRunnerCommand({ once: true, scope: 'everyone' }, deps);
    expect(hello.mock.calls[1][0]).not.toHaveProperty('scope');
  });

  it('runs as many at once as the dashboard allows, whatever --parallel said', async () => {
    const run = (n: number): ClaimedReviewRun => ({ id: `run-${n}`, prNumber: n, repoFullName: 'acme/app', reviewerName: 'R' });
    const queue = [run(1), run(2), run(3), run(4)];
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    let nextWorker = 0;
    let version = '1';
    const runReview = (runId: string, cwd: string) => new Promise<any>((resolve) => {
      running++; peak = Math.max(peak, running);
      gates.push(() => { running--; resolve({ runId, ok: true, branch: null, worktree: null, headSha: null, error: null, result: null }); });
      void cwd;
    });
    const made: string[] = [];
    const { deps } = fakeDeps({
      instance: 'w0',
      claim: async () => ({ run: queue.shift() ?? null }),
      runReview,
      hello: async () => ({ slots: 3 }),
      worker: () => { const id = `w${++nextWorker}`; made.push(id); return { instance: id, runReview }; },
      sleep: async () => { await new Promise((r) => setTimeout(r, 1)); if (gates.length === 0 && queue.length === 0) version = '2'; },
      version: () => version,
    });
    const done = reviewRunnerCommand({ parallel: '1' }, deps);
    await new Promise((r) => setTimeout(r, 30));
    expect(peak).toBe(3);
    // Only the loops the slots allow ever get a worker.
    expect(made).toEqual(['w1', 'w2']);
    gates.splice(0).forEach((g) => g());
    await new Promise((r) => setTimeout(r, 30));
    gates.splice(0).forEach((g) => g());
    await done;
    expect(queue).toEqual([]);
  });

  it('an older server without hello: --parallel stays in force', async () => {
    const claim = vi.fn().mockResolvedValueOnce({ run: { id: 'run-1', prNumber: 7, repoFullName: 'acme/lib', reviewerName: 'S' } }).mockResolvedValue({ run: null });
    const { deps, ranIn } = fakeDeps({ claim, hello: async () => { throw new Error('404'); } });
    await reviewRunnerCommand({ once: true }, deps);
    expect(ranIn).toHaveLength(1);
  });
});

describe('--no-local-ci / --local-ci-only', () => {
  const check = { id: 'chk-1', name: 'origin/local-ci', repoFullName: 'acme/lib', prNumber: 9 } as any;
  const run: ClaimedReviewRun = { id: 'run-9', prNumber: 9, repoFullName: 'acme/lib', reviewerName: 'Security' };

  function split() {
    const claimLocal = vi.fn<NonNullable<ReviewRunnerDeps['claimLocal']>>(async () => ({ check }));
    const runLocal = vi.fn<NonNullable<ReviewRunnerDeps['runLocal']>>(async () => ({}) as any);
    const claim = vi.fn<ReviewRunnerDeps['claim']>(async () => ({ run }));
    const claimOrchestrator = vi.fn<NonNullable<ReviewRunnerDeps['claimOrchestrator']>>(async () => ({ run: null }));
    return { claimLocal, runLocal, claim, claimOrchestrator };
  }

  it('by default a queued local check is taken before a reviewer run', async () => {
    const f = split();
    const { deps, ranIn } = fakeDeps({ ...f, launchOrchestrator: vi.fn(), reportOrchestrator: vi.fn() });
    await reviewRunnerCommand({ once: true }, deps);
    expect(f.runLocal).toHaveBeenCalledTimes(1);
    expect(ranIn).toEqual([]);
  });

  it('--no-local-ci never asks for a local check and runs the reviewer', async () => {
    const f = split();
    const { deps, ranIn, lines } = fakeDeps(f);
    await reviewRunnerCommand({ once: true, localCi: false }, deps);
    expect(f.claimLocal).not.toHaveBeenCalled();
    expect(f.runLocal).not.toHaveBeenCalled();
    expect(ranIn.map((r) => r.runId)).toEqual(['run-9']);
    expect(lines.join('\n')).toMatch(/no local checks/);
  });

  it('--local-ci-only runs the local check and never claims a reviewer run or orchestrator issue', async () => {
    const f = split();
    f.claimLocal.mockResolvedValueOnce({ check }).mockResolvedValue({ check: null });
    const launchOrchestrator = vi.fn();
    const first = fakeDeps({ ...f, launchOrchestrator, reportOrchestrator: vi.fn() });
    await reviewRunnerCommand({ once: true, localCiOnly: true }, first.deps);
    expect(f.runLocal).toHaveBeenCalledTimes(1);
    // Queue empty of checks: the reviewer run stays on the server for another runner.
    const second = fakeDeps({ ...f, launchOrchestrator, reportOrchestrator: vi.fn() });
    await reviewRunnerCommand({ once: true, localCiOnly: true }, second.deps);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.claimOrchestrator).not.toHaveBeenCalled();
    expect(second.ranIn).toEqual([]);
    expect(second.lines.join('\n')).toMatch(/Nothing queued/);
  });

  it('both flags at once is refused', async () => {
    const { deps, exits, lines } = fakeDeps();
    await reviewRunnerCommand({ once: true, localCi: false, localCiOnly: true }, deps);
    expect(exits).toEqual([2]);
    expect(lines.join('\n')).toMatch(/cannot be used together/);
    expect('error' in depsForRunnerMode({ localCi: false, localCiOnly: true }, deps)).toBe(true);
  });

  it('--local-ci-only drops the extra --parallel workers', () => {
    const { deps } = fakeDeps({ worker: () => ({ instance: 'w', runReview: vi.fn() }) as any });
    const mode = depsForRunnerMode({ localCiOnly: true }, deps);
    expect('deps' in mode && mode.deps.worker).toBeUndefined();
  });
});
