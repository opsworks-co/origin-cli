// The global post-commit / post-rewrite hooks must NOT stall a piped git
// command such as `git commit | tee build.log`.
//
// The bug: the hook backgrounded `"$ORIGIN_BIN" hooks git-post-commit &`
// without redirecting stdout. A backgrounded child inherits the parent's
// stdout fd — which, under `git commit | tee`, is the WRITE end of the pipe
// feeding `tee`. `tee` (and anything downstream) only sees EOF once EVERY
// holder of that write end closes it, so it blocked until the (possibly slow,
// network-bound) origin capture finished. The fix redirects the child to
// /dev/null so it never holds the pipe open.
//
// This drives the REAL generated hook with a stubbed origin that sleeps, pipes
// the hook through `cat`, and asserts the pipeline does not absorb that sleep —
// i.e. the background child is detached from the pipe.
//
// TIMING: the quantity under test is the LEAK — how much of the fake capture's
// sleep lands inside the pipeline — not the pipeline's absolute duration. So
// every measurement is paired with a BASELINE run of the identical pipeline
// against an instant fake capture, and the baseline is subtracted. Process
// spawn cost (sh, MSYS's fork emulation, the hook's own `git rev-parse`)
// cancels out, and the check scales with the runner instead of assuming its
// speed. An absolute deadline cannot do that: on a loaded native-Windows
// runner, spawn overhead alone measured 3.3s — a working hook on a slow
// machine is then indistinguishable from a broken one on a fast machine.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeGlobalPostCommitHook, writeGlobalPostRewriteHook } from '../commands/enable.js';

const SLEEP_SECS = 12; // fake capture "duration" — the leak signal, if it leaks
// Half the sleep. A regression puts the WHOLE sleep in the pipeline, so the
// signal is 2x the threshold; passing needs only that spawn-time jitter between
// the baseline and the measurement stays under 6s, which no observed runner
// approaches. Wide on purpose — the sleep is only ever waited out when the
// hook is genuinely broken.
const MAX_LEAK_MS = (SLEEP_SECS * 1000) / 2;
// Positive control: short enough to wait for on every run, long enough to be
// unmistakable. Proves `sleep` exists and that an unredirected background
// child really does hold the pipe open on THIS machine.
const CONTROL_SECS = 3;

describe('global post-commit / post-rewrite hooks do not stall a pipe', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-pipestall-'));
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Point the hook's ORIGIN_BIN block at a fake origin we control.
  function patchOriginBin(hookPath: string, fakeBin: string) {
    const src = fs.readFileSync(hookPath, 'utf-8');
    const start = src.indexOf('ORIGIN_BIN=""');
    const end = src.indexOf('\nfi\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const patched =
      src.slice(0, start) + `ORIGIN_BIN="${fakeBin}"` + src.slice(end + '\nfi'.length);
    fs.writeFileSync(hookPath, patched);
    fs.chmodSync(hookPath, '755');
  }

  // A fake origin standing in for a slow, network-bound capture. It writes to
  // stdout so that WITHOUT the redirect it would keep the inherited pipe
  // write-end open for the full sleep. sleepSecs=0 gives the instant variant
  // used to time everything the pipeline costs APART from the capture.
  function writeFakeOrigin(into: string, sleepSecs: number): string {
    const bin = path.join(into, 'fake-origin');
    const sleep = sleepSecs > 0 ? `sleep ${sleepSecs}\n` : '';
    fs.writeFileSync(bin, `#!/bin/sh\necho "origin working..."\n${sleep}`);
    fs.chmodSync(bin, '755');
    return bin;
  }

  // Run `hook | cat` and return how long the pipeline took. `cat` reads until
  // the pipe hits EOF; if the backgrounded child still holds the write end,
  // this blocks for the fake capture's sleep.
  function timePipedHook(hookPath: string): number {
    const started = Date.now();
    spawnSync('sh', ['-c', `"${hookPath}" | cat`], {
      encoding: 'utf-8',
      timeout: (SLEEP_SECS + 8) * 1000,
    });
    return Date.now() - started;
  }

  // Generate the real hook into its own scratch dir, wired to a fake origin
  // that sleeps for `sleepSecs`, and time the piped run.
  function timeHookWithCapture(
    writeHook: (d: string) => void,
    hookName: string,
    label: string,
    sleepSecs: number,
  ): number {
    const d = path.join(dir, label);
    fs.mkdirSync(d, { recursive: true });
    writeHook(d);
    const hookPath = path.join(d, hookName);
    patchOriginBin(hookPath, writeFakeOrigin(d, sleepSecs));
    return timePipedHook(hookPath);
  }

  // How much of the slow capture's sleep leaked into the pipeline.
  function pipeLeakMs(writeHook: (d: string) => void, hookName: string): number {
    // Two baseline samples, WORST taken: one unlucky spawn must not shrink the
    // baseline and manufacture a leak that isn't there.
    const baseline = Math.max(
      timeHookWithCapture(writeHook, hookName, 'base-a', 0),
      timeHookWithCapture(writeHook, hookName, 'base-b', 0),
    );
    const slow = timeHookWithCapture(writeHook, hookName, 'slow', SLEEP_SECS);
    return slow - baseline;
  }

  it('post-commit: a slow background capture does not hold the pipe open', () => {
    // With the redirect the pipe closes as soon as the hook script exits, so the
    // slow capture costs the pipeline nothing. Without it, the leak is ~SLEEP_SECS.
    expect(pipeLeakMs(writeGlobalPostCommitHook, 'post-commit')).toBeLessThan(MAX_LEAK_MS);
  });

  it('post-rewrite: a slow background capture does not hold the pipe open', () => {
    expect(pipeLeakMs(writeGlobalPostRewriteHook, 'post-rewrite')).toBeLessThan(MAX_LEAK_MS);
  });

  // Guards the guard. If `sleep` were missing, or this platform's pipe
  // semantics did not actually propagate the write end to a background child,
  // the two tests above would pass no matter WHAT the hooks did. This proves a
  // leak is observable here: same shape, redirect deliberately omitted.
  it('an unredirected background child DOES hold the pipe open (control)', () => {
    const bin = writeFakeOrigin(dir, CONTROL_SECS);
    const leaky = path.join(dir, 'leaky-hook');
    fs.writeFileSync(leaky, `#!/bin/sh\n"${bin}" &\n`); // no >/dev/null — the bug
    fs.chmodSync(leaky, '755');
    const started = Date.now();
    spawnSync('sh', ['-c', `"${leaky}" | cat`], { encoding: 'utf-8', timeout: (CONTROL_SECS + 10) * 1000 });
    // No upper bound — a slow runner can only make this larger.
    expect(Date.now() - started).toBeGreaterThanOrEqual(CONTROL_SECS * 1000 * 0.8);
  });

  it('the generated hooks redirect the backgrounded child (guards the fix)', () => {
    writeGlobalPostCommitHook(dir);
    writeGlobalPostRewriteHook(dir);
    const pc = fs.readFileSync(path.join(dir, 'post-commit'), 'utf-8');
    const pr = fs.readFileSync(path.join(dir, 'post-rewrite'), 'utf-8');
    expect(pc).toMatch(/git-post-commit >\/dev\/null 2>&1 &/);
    expect(pr).toMatch(/git-post-rewrite "\$@" >\/dev\/null 2>&1 &/);
  });
});
