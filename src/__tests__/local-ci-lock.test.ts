// A bake-off arm must not start while scripts/ci-local.sh holds its lock: one
// that did on 2026-09-30 timed two of that run's tests out.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { localCiLockPath, localCiHolder, waitForLocalCi } from '../local-ci-lock.js';

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-ci-lock-'));
  fs.mkdirSync(path.dirname(localCiLockPath(home)), { recursive: true });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('the local CI lock', () => {
  it('is free with no lock file, and with a lock left by a dead process', () => {
    expect(localCiHolder(home)).toBeNull();
    fs.writeFileSync(localCiLockPath(home), '999999999\n');
    expect(localCiHolder(home)).toBeNull();
    const began = Date.now();
    waitForLocalCi({ home, pollMs: 50, log: () => {} });
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  it('holds an arm back until the CI run holding it exits', () => {
    // Stands in for ci-local.sh: alive for ~1.5 s, its pid in the lock. NOT
    // this process's child, as the real one is not: a child that exits stays
    // a zombie (still "alive" to kill -0) until this blocked thread reaps it.
    const pid = Number(execFileSync('sh', ['-c', 'sleep 1.5 >/dev/null 2>&1 & echo $!'], { encoding: 'utf-8' }).trim());
    fs.writeFileSync(localCiLockPath(home), `${pid}\n`);
    expect(localCiHolder(home)).toBe(pid);

    const said: string[] = [];
    const began = Date.now();
    waitForLocalCi({ home, pollMs: 100, log: (m) => said.push(m) });
    const waited = Date.now() - began;

    expect(waited).toBeGreaterThan(1_000);
    expect(said).toEqual([`waiting for local CI (pid ${pid}) to finish before starting the next arm`]);
  });
});
