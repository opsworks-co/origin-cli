// Windows reads command lines from a Win32_Process snapshot cached for 2 s. A
// process started after it is missing from it — and "missing" read as "could
// not tell", which isOwnDaemonAlive answers with "ours": a stranger at a dead
// daemon's pid kept a new heartbeat or watcher from starting (Windows CI,
// recycled-pid-is-not-our-daemon.test.ts). A live pid the cache lacks re-takes it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const snapshots: Array<Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string }>> = [];
let calls = 0;
vi.mock('../utils/exec.js', () => ({
  runDetailed: () => {
    const rows = snapshots[Math.min(calls, snapshots.length - 1)];
    calls++;
    return { status: 0, stdout: JSON.stringify(rows), stderr: '' };
  },
}));

const { processInfo, __resetProcessSnapshot } = await import('../utils/process-detect.js');
const { __resetPlatformCache } = await import('../utils/platform.js');

const realPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  __resetPlatformCache();
  __resetProcessSnapshot();
  snapshots.length = 0;
  calls = 0;
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  __resetPlatformCache();
  __resetProcessSnapshot();
});

describe('processInfo on Windows, from a cached snapshot', () => {
  it('a live pid started after the snapshot re-takes it', () => {
    snapshots.push([{ ProcessId: 4, ParentProcessId: 0, CommandLine: 'System' }]);
    snapshots.push([{ ProcessId: process.pid, ParentProcessId: 4, CommandLine: 'node stranger.js' }]);
    expect(processInfo(4)).toEqual({ ppid: 0, command: 'System' });
    expect(processInfo(process.pid)).toEqual({ ppid: 4, command: 'node stranger.js' });
    expect(calls).toBe(2);
  });

  it('a dead pid does not, and a fresh snapshot is not taken twice', () => {
    snapshots.push([{ ProcessId: 4, ParentProcessId: 0, CommandLine: 'System' }]);
    expect(processInfo(process.pid)).toBeNull(); // fresh snapshot: no second query
    expect(processInfo(2_000_000_000)).toBeNull(); // cached, but nothing lives there
    expect(calls).toBe(1);
  });
});
