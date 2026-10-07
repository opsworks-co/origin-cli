import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * `scripts/ci-local.sh` holds this file (its pid inside) for the whole run.
 *
 * A bake-off arm is a headless agent that runs the repo's own test suite, and
 * on 2026-09-30 one started halfway through a local CI run: two tests that
 * take 0.6 s alone hit their 30 s timeout under the combined load, and the
 * release's CI read as failed. ci-local.sh checked for another vitest only at
 * its start, so it could not see an arm that came later. Arms now wait for
 * the lock before they start, and ci-local.sh waits for running arms before
 * it takes it.
 */
export function localCiLockPath(home = os.homedir()): string {
  return path.join(home, '.origin', 'locks', 'local-ci.pid');
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** The pid of a live local CI run holding the lock, or null. */
export function localCiHolder(home = os.homedir()): number | null {
  let pid: number;
  try { pid = Number(fs.readFileSync(localCiLockPath(home), 'utf-8').trim()); } catch { return null; }
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Block until no local CI run holds the lock. Arms start synchronously, so
 * this does too. A lock left by a dead process is ignored.
 */
export function waitForLocalCi(opts: { home?: string; pollMs?: number; log?: (msg: string) => void } = {}): void {
  const pollMs = opts.pollMs ?? 15_000;
  let told = false;
  for (;;) {
    const pid = localCiHolder(opts.home);
    if (pid === null) return;
    if (!told) {
      (opts.log ?? ((m: string) => console.log(m)))(`waiting for local CI (pid ${pid}) to finish before starting the next arm`);
      told = true;
    }
    sleepSync(pollMs);
  }
}
