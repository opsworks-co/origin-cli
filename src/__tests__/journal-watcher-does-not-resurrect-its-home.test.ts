// A detached journal watcher must die with the home it was spawned for.
//
// The spawn is detached and the hook returns immediately, so there is a window
// between "watcher spawned" and "watcher runs". Anything tearing the home down
// inside that window used to LOSE the race: startWriteJournal opens with
// `mkdirSync(recursive)`, which silently rebuilt `<home>/.origin/journals` and
// began appending to a home nobody would read again.
//
// It did not then go away. A watcher refreshes its idle clock every time its
// journal grows, so one pointed at a repo somebody is actively editing never
// reaches the 30-minute idle window — it is immortal, holding a recursive
// watch over the whole tree. Measured on one developer machine before the fix:
// 87 leaked `origin-hook-home-*` trees, 79 still holding a live journal, 24
// live watcher processes, the oldest 57 minutes old.
//
// Both directions are covered here: the home already gone when the watcher
// starts, and the home removed under a watcher that is already up.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run the watcher exactly as the hook spawns it, and hand back the process. */
function spawnWatcher(home: string, repo: string) {
  const journals = path.join(home, '.origin', 'journals');
  return spawn(process.execPath, [BIN, 'hooks', 'journal-watch'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ORIGIN_JOURNAL_IS_WATCHER: '1',
      ORIGIN_JOURNAL_REPO: repo,
      ORIGIN_JOURNAL_PATH: path.join(journals, 'leak-test.jsonl'),
      ORIGIN_JOURNAL_LOCK: path.join(journals, 'leak-test.lock'),
    },
  });
}

/** Resolve when the process exits, or false if it is still up after `ms`. */
async function exitedWithin(child: ReturnType<typeof spawn>, ms: number): Promise<boolean> {
  let done = false;
  child.on('exit', () => { done = true; });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done) return true;
    await sleep(100);
  }
  return done;
}

function seed(): { home: string; repo: string } {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-leak-home-')));
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-leak-repo-')));
  fs.mkdirSync(path.join(home, '.origin', 'journals'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] });
  return { home, repo };
}

describe.skipIf(!haveDist)('a journal watcher dies with its home', () => {
  it('exits instead of recreating a home that was torn down before it started', async () => {
    const { home, repo } = seed();
    // The teardown wins the race: the home is gone before the watcher runs.
    fs.rmSync(home, { recursive: true, force: true });

    const child = spawnWatcher(home, repo);
    try {
      expect(await exitedWithin(child, 15_000), 'the watcher should have exited').toBe(true);
      // The real damage was not the process, it was the resurrection: a home
      // rebuilt after teardown is a tree nothing will ever clean up.
      expect(fs.existsSync(home), 'the watcher must not rebuild the deleted home').toBe(false);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it('exits when the home is removed under a watcher that is already running', async () => {
    const { home, repo } = seed();
    const child = spawnWatcher(home, repo);
    try {
      // Let it come up and take its lock, so this exercises the running path
      // rather than the startup guard.
      await sleep(3_000);
      expect(child.exitCode, 'watcher should still be up with its home present').toBeNull();

      fs.rmSync(home, { recursive: true, force: true });
      // The liveness tick is 15s, so allow two of them rather than assuming
      // one lands promptly on a loaded machine.
      expect(await exitedWithin(child, 45_000), 'the watcher should notice and exit').toBe(true);
      expect(fs.existsSync(home), 'and must not rebuild it on the way out').toBe(false);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 90_000);
});
