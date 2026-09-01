// The repo-local hooks installed by `origin enable --local` must, like the
// global core.hooksPath hooks, redirect their backgrounded `origin` child to
// /dev/null (so a `git commit | tee` pipe doesn't stall until the network-bound
// capture finishes) AND carry a PATH shim (so a GUI git client that doesn't
// source the login profile can still resolve `origin` instead of silently
// no-opping and losing attribution).
//
// #703 fixed only the GLOBAL hooks; these local generators still emitted a bare,
// unredirected `origin hooks … &`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installRewriteHooks } from '../history-preservation.js';
import { installGitPostCommitHook } from '../commands/enable.js';

const SLEEP_SECS = 12; // fake capture "duration" — the leak signal, if it leaks
// Half the sleep, so a regression's signal is 2x the bar. Passing only needs
// spawn-time jitter between baseline and measurement to stay under 6s. The
// sleep is never waited out unless the hook is genuinely broken.
const MAX_LEAK_MS = (SLEEP_SECS * 1000) / 2;
const CONTROL_SECS = 3; // positive control — cheap enough to run every time

describe('repo-local hooks: redirect + PATH shim', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-localhook-'));
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Wait (bounded) for a backgrounded child's marker file to show up.
  async function markerAppears(marker: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  function hook(name: string): string {
    return fs.readFileSync(path.join(dir, '.git', 'hooks', name), 'utf-8');
  }

  it('post-commit redirects the backgrounded child', () => {
    installGitPostCommitHook(dir);
    const pc = hook('post-commit');
    expect(pc).toMatch(/git-post-commit >\/dev\/null 2>&1 &/);
  });

  it('post-rewrite + post-checkout redirect and carry a PATH shim', () => {
    installRewriteHooks(dir);
    const pr = hook('post-rewrite');
    const co = hook('post-checkout');
    expect(pr).toMatch(/git-post-rewrite "\$@" >\/dev\/null 2>&1 &/);
    expect(pr).toContain('export PATH=');
    expect(co).toMatch(/git-post-checkout "\$@" >\/dev\/null 2>&1 &/);
    expect(co).toContain('export PATH=');
  });

  // The quantity under test is the LEAK — how much of the fake capture's sleep
  // lands inside the pipeline — not the pipeline's absolute duration. An
  // absolute deadline here is a wall-clock budget on a shared runner: the
  // sibling global-hook test failed CI at 3304ms against a 2000ms bar while
  // the hook was perfectly fine, purely from sh/MSYS spawn overhead on a
  // loaded Windows machine. So time the identical pipeline against an INSTANT
  // capture too, and subtract it: spawn cost cancels and the check scales with
  // the runner. See post-commit-pipe-stall.test.ts for the same treatment.
  it('post-commit does not stall a pipe (behavioral)', async () => {
    installGitPostCommitHook(dir);
    const hookPath = path.join(dir, '.git', 'hooks', 'post-commit');
    const ran = path.join(dir, 'capture-ran');

    // Point the hook's capture command at a stub we control, keeping whatever
    // tail the generator emitted — that tail IS the redirect under test, so it
    // must survive the patch (and be absent when the fix regresses).
    //
    // This used to inject a fake `origin` onto PATH instead. That only worked
    // on POSIX: originCmd() emits an ABSOLUTE `node.exe <cli-entry>` command on
    // Windows, which never consults PATH, so the stub never ran and this test
    // passed on Windows no matter what the hook did — false green on the one
    // platform the job exists to cover.
    const setCaptureDuration = (sleepSecs: number) => {
      const bin = path.join(dir, 'fake-capture');
      const sleep = sleepSecs > 0 ? `sleep ${sleepSecs}\n` : '';
      fs.writeFileSync(bin, `#!/bin/sh\necho working\n: > "${ran}"\n${sleep}`);
      fs.chmodSync(bin, '755');
      const src = fs.readFileSync(hookPath, 'utf-8');
      fs.writeFileSync(hookPath, src.replace(/^.*hooks git-post-commit/m, `"${bin}"`));
      fs.chmodSync(hookPath, '755');
    };
    const timePipedHook = (): number => {
      const started = Date.now();
      spawnSync('sh', ['-c', `"${hookPath}" | cat`], {
        encoding: 'utf-8',
        timeout: (SLEEP_SECS + 8) * 1000,
      });
      return Date.now() - started;
    };

    // Two baseline samples, WORST taken: one unlucky spawn must not shrink the
    // baseline and manufacture a leak that isn't there.
    setCaptureDuration(0);
    const baseline = Math.max(timePipedHook(), timePipedHook());
    // The stub really is what the hook invokes — otherwise everything below
    // would be timing a hook that runs no capture at all. POLLED, not checked
    // outright: the capture is backgrounded, so its very first write races the
    // pipeline's exit — which is the whole property under test.
    expect(await markerAppears(ran)).toBe(true);

    setCaptureDuration(SLEEP_SECS);
    const leak = timePipedHook() - baseline;

    // With the redirect the pipe closes as soon as the hook script exits, so
    // the slow capture costs the pipeline nothing. Without it, `cat` blocks on
    // the inherited pipe fd for the full SLEEP_SECS.
    expect(leak).toBeLessThan(MAX_LEAK_MS);
  });

  // Guards the guard. If `sleep` were missing, or the fake `origin` never got
  // resolved off PATH at all, the test above would pass no matter what the
  // generated hook did. This proves a leak is observable here: same shape,
  // redirect deliberately omitted.
  it('an unredirected background child DOES hold the pipe open (control)', () => {
    const bin = path.join(dir, 'slow-capture');
    fs.writeFileSync(bin, `#!/bin/sh\necho working\nsleep ${CONTROL_SECS}\n`);
    fs.chmodSync(bin, '755');
    const leaky = path.join(dir, 'leaky-hook');
    fs.writeFileSync(leaky, `#!/bin/sh\n"${bin}" &\n`); // no >/dev/null — the bug
    fs.chmodSync(leaky, '755');
    const started = Date.now();
    spawnSync('sh', ['-c', `"${leaky}" | cat`], { encoding: 'utf-8', timeout: (CONTROL_SECS + 10) * 1000 });
    // No upper bound — a slow runner can only make this larger.
    expect(Date.now() - started).toBeGreaterThanOrEqual(CONTROL_SECS * 1000 * 0.8);
  });
});
