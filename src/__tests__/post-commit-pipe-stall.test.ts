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
// the hook through `cat`, and asserts `cat` returns well before the sleep — i.e.
// the background child is detached from the pipe.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeGlobalPostCommitHook, writeGlobalPostRewriteHook } from '../commands/enable.js';

const SLEEP_SECS = 4; // fake capture "duration" — must exceed the assert threshold
const MAX_MS = 2000; // the piped command must return far sooner than SLEEP_SECS

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

  // A fake origin that takes SLEEP_SECS to finish, standing in for a slow,
  // network-bound capture. It writes to stdout so that WITHOUT the redirect it
  // would keep the inherited pipe write-end open for the full sleep.
  function writeSlowFakeOrigin(): string {
    const bin = path.join(dir, 'fake-origin');
    fs.writeFileSync(bin, `#!/bin/sh\necho "origin working..."\nsleep ${SLEEP_SECS}\n`);
    fs.chmodSync(bin, '755');
    return bin;
  }

  // Run `hook | cat` and return how long the pipeline took. `cat` reads until
  // the pipe hits EOF; if the backgrounded child still holds the write end,
  // this blocks for SLEEP_SECS.
  function timePipedHook(hookPath: string): number {
    const started = Date.now();
    spawnSync('sh', ['-c', `"${hookPath}" | cat`], { encoding: 'utf-8', timeout: (SLEEP_SECS + 5) * 1000 });
    return Date.now() - started;
  }

  it('post-commit: a slow background capture does not hold the pipe open', () => {
    writeGlobalPostCommitHook(dir);
    const hookPath = path.join(dir, 'post-commit');
    patchOriginBin(hookPath, writeSlowFakeOrigin());
    // With the redirect the pipe closes as soon as the hook script exits.
    // Without it, this would be ~SLEEP_SECS.
    expect(timePipedHook(hookPath)).toBeLessThan(MAX_MS);
  });

  it('post-rewrite: a slow background capture does not hold the pipe open', () => {
    writeGlobalPostRewriteHook(dir);
    const hookPath = path.join(dir, 'post-rewrite');
    patchOriginBin(hookPath, writeSlowFakeOrigin());
    expect(timePipedHook(hookPath)).toBeLessThan(MAX_MS);
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
