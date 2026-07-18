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

describe('repo-local hooks: redirect + PATH shim', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-localhook-'));
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

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

  it('post-commit does not stall a pipe (behavioral)', () => {
    installGitPostCommitHook(dir);
    const hookPath = path.join(dir, '.git', 'hooks', 'post-commit');
    // Swap the resolved `origin` command for a slow stub so we can measure the
    // pipe. The generated hook runs `PATH=<dir>:$PATH origin hooks …`; drop a
    // fake `origin` on that PATH that sleeps.
    const fakeBin = path.join(dir, 'fakebin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'origin'), '#!/bin/sh\necho working\nsleep 4\n');
    fs.chmodSync(path.join(fakeBin, 'origin'), '755');
    // Force our fake onto PATH ahead of everything for the hook run.
    const started = Date.now();
    spawnSync('sh', ['-c', `PATH="${fakeBin}:$PATH" "${hookPath}" | cat`], { encoding: 'utf-8', timeout: 9000 });
    // With the redirect the pipe closes as soon as the hook script exits (<2s);
    // without it, `cat` would block ~4s on the inherited pipe fd.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
