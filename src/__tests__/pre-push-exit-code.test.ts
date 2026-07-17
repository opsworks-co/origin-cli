// The global pre-push hook must propagate Origin's exit code.
//
// The bug: the generated hook ran `"$ORIGIN_BIN" hooks git-pre-push` and then
// fell through to the local-hook chain, so the SCRIPT's exit status was the
// trailing `if` — which returns 0 when no local hook exists. `git-pre-push`
// exits 1 to abort a blocked push, but the hook exited 0, so git pushed anyway.
// On the default (global) install there is no local pre-push to rescue it, so
// the "Block pushes from disabled agents" feature was entirely inert.
//
// This drives the REAL generated hook with a stubbed origin binary and asserts
// the hook's exit code, because the bug lives in the shell, not in TS.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeGlobalPrePushHook } from '../commands/enable.js';

describe('global pre-push hook exit-code propagation', () => {
  let dir: string;
  let hookPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-prepush-'));
    writeGlobalPrePushHook(dir);
    hookPath = path.join(dir, 'pre-push');
    // Swap the binary-resolution block for a stub we control, so the hook
    // invokes our fake `origin` instead of resolving the real one.
    const src = fs.readFileSync(hookPath, 'utf-8');
    const start = src.indexOf('ORIGIN_BIN=""');
    const end = src.indexOf('\nfi\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const patched =
      src.slice(0, start) +
      `ORIGIN_BIN="${path.join(dir, 'fake-origin')}"` +
      src.slice(end + '\nfi'.length);
    fs.writeFileSync(hookPath, patched);
    fs.chmodSync(hookPath, '755');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function setFakeOrigin(exitCode: number) {
    fs.writeFileSync(
      path.join(dir, 'fake-origin'),
      `#!/bin/sh\necho "  origin pre-push (exit ${exitCode})" >&2\nexit ${exitCode}\n`,
    );
    fs.chmodSync(path.join(dir, 'fake-origin'), '755');
  }

  function runHook(): number {
    // No local .git/hooks/pre-push exists here — the default-install case.
    const r = spawnSync('sh', [hookPath], { encoding: 'utf-8' });
    return r.status ?? -1;
  }

  it('a BLOCKED push (origin exits 1) makes the hook exit non-zero', () => {
    setFakeOrigin(1);
    // THE regression: this used to be 0, so git pushed anyway.
    expect(runHook()).toBe(1);
  });

  it('an ALLOWED push (origin exits 0) lets the hook exit 0', () => {
    setFakeOrigin(0);
    expect(runHook()).toBe(0);
  });

  it('a hard failure (origin exits 2) is propagated, not swallowed', () => {
    setFakeOrigin(2);
    expect(runHook()).toBe(2);
  });
});
