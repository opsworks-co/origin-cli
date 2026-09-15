// Where the CLI suite's throwaway HOMEs live, shared by vitest.config.ts,
// isolate-home.ts (setupFile) and global-teardown.ts (globalSetup).
//
// Layout: <tmp>/origin-cli-test-runs/<runId>/<workerId>
//
// The run id is the part that matters. Vitest worker ids restart at 1 in every
// run and os.tmpdir() is per user, so a path keyed on the worker alone gave two
// suites running at once on one machine (two agent sessions in two worktrees)
// the SAME homes: they shared ~/.origin/config.json — the fake API URL each e2e
// test writes — plus journals, state mirrors and hooks.log, and one run's
// teardown deleted the tree under the other. The run id is minted once in the
// vitest main process (vitest.config.ts) and handed to every worker through
// config.env, so it is identical for every file every worker runs.
//
// The base dir is deliberately NOT the old `origin-cli-test-home`: a checkout
// still on the old code removes that whole directory on setup and teardown, and
// would delete a concurrent new-code run's homes with it.
//
// Keep this file dependency-free (os/path/fs/crypto only): isolate-home.ts
// imports it before any module that reads os.homedir() at load time.
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';

export const RUN_ID_ENV = 'ORIGIN_TEST_RUN_ID';

export function testRunsBase(tmpdir: string = os.tmpdir()): string {
  return path.join(tmpdir, 'origin-cli-test-runs');
}

// `<pid>-<random>`: the pid lets a later run tell a crashed run's residue from
// a live one; the random part keeps a recycled pid from reusing stale files.
const RUN_ID_RE = /^(\d+)-[0-9a-f]{8,}$/;

export function newRunId(pid: number = process.pid): string {
  return `${pid}-${randomBytes(6).toString('hex')}`;
}

/**
 * The run id for the vitest main process. Reuses an id already in the env only
 * when THIS process minted it (the config file can be evaluated more than once
 * in one process); an id inherited from a parent — a vitest run spawned from
 * inside a test — belongs to the parent's run and must not be shared.
 */
export function runIdForMainProcess(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): string {
  const existing = env[RUN_ID_ENV];
  const m = existing ? RUN_ID_RE.exec(existing) : null;
  if (existing && m && Number(m[1]) === pid) return existing;
  const id = newRunId(pid);
  env[RUN_ID_ENV] = id;
  return id;
}

export function runHomeRoot(runId: string, tmpdir?: string): string {
  return path.join(testRunsBase(tmpdir), runId);
}

export function workerHome(runId: string, worker: string, tmpdir?: string): string {
  return path.join(runHomeRoot(runId, tmpdir), worker);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, we just may not signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove run dirs left by crashed runs — those whose owning vitest process is
 * gone. Never touches a live run's dir, or anything whose name it doesn't
 * recognise.
 */
export function sweepDeadRuns(tmpdir?: string, isAlive: (pid: number) => boolean = pidAlive): string[] {
  const base = testRunsBase(tmpdir);
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    const m = RUN_ID_RE.exec(name);
    if (!m || isAlive(Number(m[1]))) continue;
    try {
      fs.rmSync(path.join(base, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* ignore */
    }
  }
  return removed;
}
