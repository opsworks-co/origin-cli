// A live pid is not our daemon. After a SIGKILL (a sleeping Mac, a killed
// terminal) the heartbeat's / watcher's pid file names a number the OS hands
// to the next process. The READ checks asked only `kill(pid, 0)`, so a
// stranger holding that number read as "our daemon is running" and no new
// daemon started until the stranger exited (Origin TODO 7e5c5571).
//
// Driven with real processes: a stranger, and processes whose command lines
// look like the daemons we start.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let home: string;
let prevHome: string | undefined;
let prevProfile: string | undefined;
const kids: ChildProcess[] = [];

// `node -e <idle> <extra args…>` — the extra args land on the command line,
// which is all the identity check reads.
function start(...args: string[]): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ...args], { stdio: 'ignore' });
  kids.push(child);
  return child.pid!;
}
function stamp(file: string, pid: number, ageMs: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(pid));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-recycled-pid-')));
  prevHome = process.env.HOME; prevProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
});
afterEach(() => { for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* gone */ } } });
afterAll(() => {
  process.env.HOME = prevHome; process.env.USERPROFILE = prevProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

const heartbeatPid = () => path.join(home, '.origin', 'heartbeats', `${SESSION}.pid`);
const STALE = 10 * 60_000;

describe('isHeartbeatAlive: alive AND ours', () => {
  it('a stranger holding a dead heartbeat\'s pid is not a live heartbeat', async () => {
    const { isHeartbeatAlive } = await import('../session-state.js');
    stamp(heartbeatPid(), start(), STALE);
    expect(isHeartbeatAlive(SESSION)).toBe(false);
  });

  it('our heartbeat, even with a stale stamp, is alive', async () => {
    const { isHeartbeatAlive } = await import('../session-state.js');
    stamp(heartbeatPid(), start('/x/dist/heartbeat.js', SESSION), STALE);
    expect(isHeartbeatAlive(SESSION)).toBe(true);
  });

  it('a heartbeat for ANOTHER session does not count', async () => {
    const { isHeartbeatAlive } = await import('../session-state.js');
    stamp(heartbeatPid(), start('/x/dist/heartbeat.js', 'ffffffff-0000-4000-8000-000000000000'), STALE);
    expect(isHeartbeatAlive(SESSION)).toBe(false);
  });

  it('a fresh stamp answers without reading the command line (the daemon re-stamps every tick)', async () => {
    const { isHeartbeatAlive } = await import('../session-state.js');
    stamp(heartbeatPid(), start(), 5_000);
    expect(isHeartbeatAlive(SESSION)).toBe(true);
  });

  it('a dead pid is not alive', async () => {
    const { isHeartbeatAlive } = await import('../session-state.js');
    const pid = start();
    kids[kids.length - 1].kill('SIGKILL');
    await new Promise((r) => kids[kids.length - 1].once('exit', r));
    stamp(heartbeatPid(), pid, 5_000);
    expect(isHeartbeatAlive(SESSION)).toBe(false);
  });
});

describe('anotherWatcherRunning: alive AND ours', () => {
  it('transcript-watch: a stranger is not a running watcher; our watcher is', async () => {
    const { anotherWatcherRunning } = await import('../transcript-watch.js');
    const file = path.join(home, 'tw.pid');
    stamp(file, start(), 0);
    expect(anotherWatcherRunning(file)).toBe(false);
    stamp(file, start('/x/dist/index.js', 'transcript-watch'), 0);
    expect(anotherWatcherRunning(file)).toBe(true);
  });

  it('codex-watch: a stranger is not a running watcher; our watcher is', async () => {
    const { anotherWatcherRunning } = await import('../codex-watch.js');
    const file = path.join(home, 'cw.pid');
    stamp(file, start(), 0);
    expect(anotherWatcherRunning(file)).toBe(false);
    stamp(file, start('/x/dist/index.js', 'codex-watch'), 0);
    expect(anotherWatcherRunning(file)).toBe(true);
  });
});
