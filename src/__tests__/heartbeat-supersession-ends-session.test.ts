// A second startHeartbeat for a session that already has a LIVE daemon used to
// SIGTERM the first one — and the dying daemon ended the session on its way out,
// which made the server hard-delete a row that had not yet recorded any work.
//
// Real failure (prod copilot session `b567ee4f`, 2026-08-25):
//
//   13:27:35.707  POST /session/start          → b567ee4f created
//   13:27:35.823  session-start  startHeartbeat(b567ee4f)   → daemon A
//   13:27:36.343  user-prompt-submit startHeartbeat(b567ee4f) → SIGTERM daemon A
//   13:27:36.4xx  daemon A's signalExit → POST /session/end
//                 tokens 0, cost 0, toolCalls 0, promptChange.count 0
//                 → mcp.ts empty-session cleanup HARD-DELETES the row
//   13:27:36.397  the first prompt is saved LOCALLY — 50ms too late to save it
//   13:27:36.466  PATCH → 404 "Session not found"
//   13:27:43.812  handleStop re-mints the session as 8b25cb05
//
// Copilot makes this routine rather than rare: it fires `userPromptSubmitted`
// BEFORE `sessionStart`, so both handleSessionStart and user-prompt-submit's
// auto-create run for a chat's first prompt and both call startHeartbeat.
//
// Two independent guards, either of which breaks the chain:
//   1. startHeartbeat is a no-op when a live daemon already owns the session.
//   2. signalExit does not end a session when the pid file says we were
//      superseded — stopHeartbeat unlinks it right after the kill.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { heartbeatSuperseded } from '../heartbeat-liveness.js';

let home: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
const spawned: ChildProcess[] = [];

const pidFileFor = (sessionId: string) =>
  path.join(home, '.origin', 'heartbeats', `${sessionId}.pid`);

/** A stand-in for a live heartbeat daemon: a real process that outlives us. */
const spawnLiveDaemon = (sessionId: string): number => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  spawned.push(child);
  const pidFile = pidFileFor(sessionId);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(child.pid));
  return child.pid as number;
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

beforeEach(() => {
  // realpathSync.native so the fixture home is spelled the way the OS spells it
  // — on Windows os.tmpdir() hands back the 8.3 SHORT form (C:\Users\RUNNER~1\…)
  // and os.homedir() would answer with the long one.
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hb-')));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  // os.homedir() — which is what session-state resolves the heartbeat pid dir
  // through — reads $HOME on POSIX but %USERPROFILE% on Windows. Setting only
  // HOME left the pid file written under the fixture home while
  // isHeartbeatAlive looked in the real one, so the live daemon this test
  // exists to protect was invisible and the test failed on Windows alone.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  spawned.length = 0;
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('startHeartbeat — one daemon per session', () => {
  it('leaves a live daemon for the same session alone', async () => {
    // Imported here so it picks up the patched HOME.
    const { startHeartbeat, isHeartbeatAlive } = await import('../session-state.js');
    const sessionId = 'b567ee4f-08e1-49a4-a999-29740cda1537';
    const daemonA = spawnLiveDaemon(sessionId);
    expect(isHeartbeatAlive(sessionId)).toBe(true);

    // The second hook's startHeartbeat — this is the call that used to SIGTERM
    // daemon A, whose signal handler then ended (and so deleted) the session.
    startHeartbeat(sessionId, 'https://example.invalid', 'k', undefined, 'copilot');

    expect(alive(daemonA)).toBe(true);
    expect(fs.readFileSync(pidFileFor(sessionId), 'utf-8').trim()).toBe(String(daemonA));
  });

  it('still replaces a daemon that is dead', async () => {
    const { isHeartbeatAlive } = await import('../session-state.js');
    const sessionId = 'dead-daemon-0001';
    const pidFile = pidFileFor(sessionId);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    // A pid that cannot be running: recorded, then reaped.
    const child = spawn(process.execPath, ['-e', '']);
    const deadPid = child.pid as number;
    await new Promise((r) => child.on('exit', r));
    fs.writeFileSync(pidFile, String(deadPid));

    // The "restarted (was dead)" path must still see this as replaceable.
    expect(isHeartbeatAlive(sessionId)).toBe(false);
  });
});

describe('signalExit — a supersession SIGTERM must not end the session', () => {
  // stopHeartbeat kills, then unlinks the pid file. So by the time the dying
  // daemon runs its handler, the file is GONE — that is the supersession tell,
  // and it is the same predicate ping() already uses to bail out.
  it('reads a missing pid file as superseded', () => {
    expect(heartbeatSuperseded({ pidFileExists: false, pidFileOwner: null, myPid: 4242 }))
      .toBe(true);
  });

  it('reads a pid file naming another process as superseded', () => {
    expect(heartbeatSuperseded({ pidFileExists: true, pidFileOwner: 999, myPid: 4242 }))
      .toBe(true);
  });

  it('reads a pid file that still names us as a genuine teardown', () => {
    // Logout / reboot / `origin session end` — here the daemon SHOULD end it.
    expect(heartbeatSuperseded({ pidFileExists: true, pidFileOwner: 4242, myPid: 4242 }))
      .toBe(false);
  });
});
