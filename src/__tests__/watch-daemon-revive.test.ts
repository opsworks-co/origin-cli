// The watcher daemons used to die quietly and stay dead.
//
// Two holes, both hit in one evening: the 24h lifetime cap exited without
// spawning a successor, and `restartTranscriptWatchIfStale` — the only thing
// `origin upgrade` calls on the up-to-date path — refused to touch a watcher
// that wasn't running. So the daemon exited, nothing captured for hours, and
// upgrade reported everything healthy (observed: pid 9340, ESRCH).
//
// Reviving is now gated on HOW it went away: a pid file with no process behind
// it means it died, while no pid file at all is what a deliberate stop leaves.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const spawned: string[][] = [];
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      spawned.push([cmd, ...args]);
      return { unref: () => {} } as any;
    },
  };
});

describe('restartTranscriptWatchIfStale', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevFlag: string | undefined;

  beforeEach(() => {
    spawned.length = 0;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-daemon-')));
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    prevHome = process.env.HOME;
    prevFlag = process.env.ORIGIN_TRANSCRIPT_WATCH;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.ORIGIN_TRANSCRIPT_WATCH = '1'; // auto-start on, platform-independent
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevFlag === undefined) delete process.env.ORIGIN_TRANSCRIPT_WATCH; else process.env.ORIGIN_TRANSCRIPT_WATCH = prevFlag;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const pidFile = () => path.join(home, '.origin', 'transcript-watch.pid');

  it('revives a daemon that died leaving its pid file behind', async () => {
    const { restartTranscriptWatchIfStale } = await import('../transcript-watch.js');
    // A pid that cannot be alive — the shape of a crashed daemon.
    fs.writeFileSync(pidFile(), '999999');

    const res = restartTranscriptWatchIfStale('9.9.9');
    expect(res.restarted).toBe(true);
    expect(res.reason).toBe('revived-dead-watcher');
    expect(spawned.some((s) => s.includes('transcript-watch'))).toBe(true);
  });

  it('leaves a cleanly-stopped watcher alone (no pid file = deliberate)', async () => {
    const { restartTranscriptWatchIfStale } = await import('../transcript-watch.js');
    try { fs.unlinkSync(pidFile()); } catch { /* already absent */ }

    const res = restartTranscriptWatchIfStale('9.9.9');
    expect(res.restarted).toBe(false);
    expect(res.reason).toBe('not-running');
    expect(spawned).toEqual([]);
  });

  it('does nothing when auto-start is gated off, however it died', async () => {
    process.env.ORIGIN_TRANSCRIPT_WATCH = '0';
    const { restartTranscriptWatchIfStale } = await import('../transcript-watch.js');
    fs.writeFileSync(pidFile(), '999999');

    const res = restartTranscriptWatchIfStale('9.9.9');
    expect(res.restarted).toBe(false);
    expect(res.reason).toBe('gated-off');
    expect(spawned).toEqual([]);
  });
});
