// Stop the long-lived children a built-binary hook leaves behind, then remove
// the test's temp tree.
//
// A hook spawns its daemons detached and returns: the heartbeat (lives for
// hours) and the write-journal watcher (30 idle minutes, with a recursive
// watch on the repo). Neither is given a cwd, so both inherit the hook's —
// the test repo. On POSIX that is harmless. On Windows a process whose cwd is
// inside a directory, or an open watch handle on it, makes `rmdir` fail with
// EBUSY, so `fs.rmSync(repo)` in afterEach failed the test after every
// assertion had passed.
//
// The short-lived children (drain-queue, publish-memory, git-history-sync) exit
// on their own; `removeTestTree` gives them a few seconds through rmSync's
// retry, which is what that option exists for.
import fs from 'fs';
import os from 'os';
import path from 'path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Pids recorded under `<home>/.origin`: heartbeats/*.pid and journals/*.lock. */
function daemonPids(home: string): number[] {
  const pids: number[] = [];
  for (const [sub, ext] of [['heartbeats', '.pid'], ['journals', '.lock']] as const) {
    const dir = path.join(home, '.origin', sub);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(ext)); } catch { continue; }
    for (const n of names) {
      try {
        const pid = Number(fs.readFileSync(path.join(dir, n), 'utf-8').trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.push(pid);
      } catch { /* removed meanwhile */ }
    }
  }
  return [...new Set(pids)];
}

/**
 * SIGTERM every heartbeat and journal watcher recorded under `home`, and wait
 * until they have exited (Windows releases the cwd and watch handles only
 * then).
 */
export async function stopBackgroundDaemons(home: string = os.homedir(), timeoutMs = 10_000): Promise<void> {
  const pids = daemonPids(home);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + timeoutMs;
  while (pids.some(alive) && Date.now() < deadline) await sleep(100);
}

/** fs.rmSync that rides out a child still releasing the tree (EBUSY/EPERM on Windows). */
export function removeTestTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
