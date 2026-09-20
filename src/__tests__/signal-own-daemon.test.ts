// A pid file outlives a daemon that was SIGKILLed, and the OS hands the number
// to whatever starts next. Every "kill the pid in the file" site used to signal
// that stranger. See utils/signal-own-daemon.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isCliDaemon, isHeartbeatFor, signalOwnDaemon, type SignalDeps } from '../utils/signal-own-daemon.js';
import { stopHeartbeat } from '../session-state.js';
import { isWindows } from './helpers/windows-e2e.js';

function deps(command: string | null, alive = true): SignalDeps & { sent: Array<[number, unknown]> } {
  const sent: Array<[number, unknown]> = [];
  return {
    sent,
    processInfo: () => (command === null ? null : { ppid: 1, command }),
    kill: (pid, signal) => {
      if (signal === 0) { if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return; }
      sent.push([pid, signal]);
    },
  };
}

describe('signalOwnDaemon', () => {
  const HB = '/usr/local/bin/node /opt/origin/dist/heartbeat.js sess-1234 https://api  /home/u/.origin/heartbeats/sess-1234.pid 77 /repo/.git/origin-session-x.json';

  it('signals the heartbeat it started', () => {
    const d = deps(HB);
    expect(signalOwnDaemon(4242, 'heartbeat', isHeartbeatFor('sess-1234'), 'SIGTERM', d)).toBe('signalled');
    expect(d.sent).toEqual([[4242, 'SIGTERM']]);
  });

  it('leaves a stranger holding the recycled pid alone', () => {
    for (const stranger of [
      '/usr/local/bin/node /repo/node_modules/vitest/dist/workers/forks.js',
      'git -c diff.ignoreSubmodules=none diff HEAD',
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      // Another session's heartbeat is not this session's either.
      HB.replace(/sess-1234/g, 'sess-9999'),
    ]) {
      const d = deps(stranger);
      expect(signalOwnDaemon(4242, 'heartbeat', isHeartbeatFor('sess-1234'), 'SIGTERM', d), stranger).toBe('not-ours');
      expect(d.sent).toEqual([]);
    }
  });

  it('does not signal a live process whose command it could not read', () => {
    const d = deps(null, true);
    expect(signalOwnDaemon(4242, 'heartbeat', isHeartbeatFor('sess-1234'), 'SIGTERM', d)).toBe('unknown');
    expect(d.sent).toEqual([]);
  });

  it('reports a pid nothing holds as gone, and never signals itself', () => {
    expect(signalOwnDaemon(4242, 'heartbeat', isHeartbeatFor('sess-1234'), 'SIGTERM', deps(null, false))).toBe('gone');
    const self = deps(HB);
    expect(signalOwnDaemon(process.pid, 'heartbeat', isHeartbeatFor('sess-1234'), 'SIGTERM', self)).toBe('gone');
    expect(self.sent).toEqual([]);
    expect(signalOwnDaemon(0, 'heartbeat', () => true, 'SIGTERM', deps(HB))).toBe('gone');
  });

  // The usual stale pid file names a dead process. Reading a command line is
  // a `ps` spawn (on Windows a whole process snapshot, about a second) inside
  // a hook; asking whether the pid is alive is free (review of #1735).
  it('does not read the command line of a pid nothing holds', () => {
    let reads = 0;
    const d = deps(HB, false);
    const counted: SignalDeps = { ...d, processInfo: (pid) => { reads += 1; return d.processInfo(pid); } };
    expect(signalOwnDaemon(4242, 'heartbeat', isHeartbeatFor('sess-1234'), 'SIGTERM', counted)).toBe('gone');
    expect(reads).toBe(0);
    expect(d.sent).toEqual([]);
  });

  it('knows a CLI daemon by its subcommand, not by a path that merely contains the word', () => {
    expect(isCliDaemon('transcript-watch')('/usr/bin/node /opt/origin/dist/index.js transcript-watch')).toBe(true);
    expect(isCliDaemon('codex-watch')('"C:\\node.exe" "C:\\origin\\dist\\index.js" "codex-watch"')).toBe(true);
    expect(isCliDaemon('transcript-watch')('/usr/bin/node /opt/origin/dist/index.js codex-watch')).toBe(false);
    expect(isCliDaemon('transcript-watch')('vim /src/transcript-watch.ts')).toBe(false);
  });
});

// The real thing, with real processes: ps has to read a real command line.
describe.skipIf(isWindows)('stopHeartbeat with a stale pid file', () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pidFileFor = (sessionId: string) => {
    const dir = path.join(os.homedir(), '.origin', 'heartbeats');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${sessionId}.pid`);
  };
  const started = (c: ChildProcess) => new Promise<void>((resolve) => c.stdout!.once('data', () => resolve()));
  const exited = (c: ChildProcess) => new Promise<void>((resolve) => c.once('exit', () => resolve()));

  it('does not kill the stranger that now holds the pid, and still clears the file', async () => {
    const stranger = spawn(process.execPath, ['-e', 'console.log("up"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(stranger);
    await started(stranger);
    const pidFile = pidFileFor('stale-sess-0001');
    fs.writeFileSync(pidFile, String(stranger.pid));

    stopHeartbeat('stale-sess-0001');

    await new Promise((r) => setTimeout(r, 300));
    expect(alive(stranger.pid!)).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('still stops the real heartbeat', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hb-'));
    dirs.push(dir);
    const script = path.join(dir, 'heartbeat.js');
    fs.writeFileSync(script, 'console.log("up"); setInterval(() => {}, 1000);\n');
    const hb = spawn(process.execPath, [script, 'live-sess-0002', 'http://127.0.0.1:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(hb);
    await started(hb);
    const pidFile = pidFileFor('live-sess-0002');
    fs.writeFileSync(pidFile, String(hb.pid));

    const gone = exited(hb);
    stopHeartbeat('live-sess-0002');
    await gone;

    expect(alive(hb.pid!)).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
