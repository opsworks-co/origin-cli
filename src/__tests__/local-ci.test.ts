// Local CI on the runner (commands/local-ci.ts): one claimed check run at the
// PR's head in a throwaway worktree — against real git repos (a "remote" and a
// checkout that fetches the PR branch from it) and a real shell — and the
// runner trying local checks before reviewer runs.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  localCheckEnv, localCheckWorktreePath, runLocalCheck, runShellCommand, TailBuffer,
  type ClaimedLocalCheck, type LocalCheckDeps, type LocalCheckReport,
} from '../commands/local-ci.js';
import { reviewRunnerCycle, type ReviewRunnerDeps, type WatchedCheckout } from '../commands/review-runner.js';

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

let tmp: string;
let upstream: string; // stands in for the host: has the PR branch
let checkout: string; // this machine's clone, which has never seen the branch
let headSha: string;
const node = JSON.stringify(process.execPath);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-local-ci-'));
  upstream = path.join(tmp, 'upstream');
  fs.mkdirSync(upstream);
  g(upstream, 'init', '-q', '-b', 'main');
  g(upstream, 'config', 'user.email', 't@t');
  g(upstream, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(upstream, 'a.txt'), 'one\n');
  g(upstream, 'add', '.');
  g(upstream, 'commit', '-q', '-m', 'init');
  checkout = path.join(tmp, 'app');
  g(tmp, 'clone', '-q', upstream, checkout);
  // The PR's branch exists only upstream until the check fetches it.
  g(upstream, 'checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(upstream, 'marker.txt'), 'from the PR\n');
  g(upstream, 'add', '.');
  g(upstream, 'commit', '-q', '-m', 'pr work');
  headSha = g(upstream, 'rev-parse', 'HEAD');
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

const check = (over: Partial<ClaimedLocalCheck> = {}): ClaimedLocalCheck => ({
  id: 'chk00001-aaaa', repoFullName: 'acme/app', prNumber: 7, headBranch: 'feat', headSha, command: 'true', timeoutSec: 60, name: 'local: true', ...over,
});

function deps(over: Partial<LocalCheckDeps> = {}) {
  const reports: Array<{ id: string; data: LocalCheckReport }> = [];
  const lines: string[] = [];
  const d: LocalCheckDeps = {
    log: (l) => lines.push(l),
    report: async (id, data) => { reports.push({ id, data }); },
    run: runShellCommand,
    env: localCheckEnv(process.env),
    ...over,
  };
  return { d, reports, lines };
}

describe('runLocalCheck', () => {
  it("fetches the PR's branch, runs the command at its head, reports the exit code and output, and removes the worktree", async () => {
    const { d, reports } = deps();
    const cmd = `${node} -e "const fs=require('fs');process.stdout.write(fs.readFileSync('marker.txt','utf8'));process.exit(3)"`;
    const r = await runLocalCheck(check({ command: cmd }), checkout, d);
    expect(r).toMatchObject({ exitCode: 3, timedOut: false });
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe('chk00001-aaaa');
    expect(reports[0].data.logTail).toContain('from the PR');
    expect(fs.existsSync(localCheckWorktreePath(checkout, 7, 'chk00001-aaaa'))).toBe(false);
    expect(g(checkout, 'worktree', 'list')).not.toContain('local-ci-7');
  });

  it('a passing command reports exit 0', async () => {
    const { d, reports } = deps();
    await runLocalCheck(check({ command: `${node} -e "process.exit(0)"` }), checkout, d);
    expect(reports[0].data).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('a command that outlives its timeout is killed and reported as timed out', async () => {
    const { d, reports } = deps();
    await runLocalCheck(check({ command: `${node} -e "setTimeout(()=>{}, 60000)"`, timeoutSec: 1 }), checkout, d);
    expect(reports[0].data).toMatchObject({ timedOut: true, exitCode: null });
  }, 20_000);

  it("gets a small environment, not the runner's own (no secrets), with CI=true", async () => {
    const env = localCheckEnv({ PATH: '/bin', HOME: '/h', AWS_SECRET_ACCESS_KEY: 'x', ORIGIN_API_KEY: 'y' });
    expect(env).toEqual({ CI: 'true', ORIGIN_LOCAL_CI: '1', PATH: '/bin', HOME: '/h' });
  });

  it("a head the clone can't get is reported as could-not-run, with no worktree made", async () => {
    const { d, reports } = deps();
    const r = await runLocalCheck(check({ headSha: 'f'.repeat(40) }), checkout, d);
    expect(r.error).toMatch(/not in this clone/);
    expect(reports[0].data.error).toMatch(/not in this clone/);
    const gone = await runLocalCheck(check({ headBranch: 'no-such-branch' }), checkout, d);
    expect(gone.error).toMatch(/could not fetch no-such-branch/);
  });

  it('a report that fails is logged, not thrown', async () => {
    const { d, lines } = deps({ report: async () => { throw new Error('ECONNRESET'); } });
    await expect(runLocalCheck(check(), checkout, d)).resolves.toMatchObject({ exitCode: 0 });
    expect(lines.join('\n')).toMatch(/could not report chk00001: ECONNRESET/);
  });
});

describe('TailBuffer', () => {
  it('keeps only the last N characters', () => {
    const t = new TailBuffer(5);
    t.push('abc'); t.push('defg'); t.push('h');
    expect(t.text()).toBe('defgh');
  });
});

describe('the runner cycle', () => {
  const watched: WatchedCheckout[] = [{ path: '/x/app', fullName: 'acme/app' }];
  const base = (over: Partial<ReviewRunnerDeps>): ReviewRunnerDeps => ({
    cwd: '/x', machineId: 'box', log: () => {},
    claim: vi.fn(async () => ({ run: null })),
    runReview: vi.fn(async () => ({ ok: true } as never)),
    discover: () => [], sleep: async () => {}, version: () => '1', exit: () => {},
    ...over,
  });

  it('runs a claimed local check before asking for a reviewer run', async () => {
    const runLocal = vi.fn(async () => ({ exitCode: 0 }));
    const d = base({ claimLocal: async () => ({ check: check() }), runLocal });
    expect(await reviewRunnerCycle(watched, d)).toBe('ran');
    expect(runLocal).toHaveBeenCalledWith(expect.objectContaining({ id: 'chk00001-aaaa' }), '/x/app');
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('no local check, or a server without local CI: the reviewer queue is polled as before', async () => {
    const none = base({ claimLocal: async () => ({ check: null }), runLocal: vi.fn() });
    expect(await reviewRunnerCycle(watched, none)).toBe('idle');
    expect(none.claim).toHaveBeenCalledTimes(1);
    const old = base({ claimLocal: async () => { throw new Error('404 Not Found'); }, runLocal: vi.fn() });
    expect(await reviewRunnerCycle(watched, old)).toBe('idle');
    expect(old.claim).toHaveBeenCalledTimes(1);
  });
});
