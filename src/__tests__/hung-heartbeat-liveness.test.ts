// isSessionAlive must not treat a HUNG heartbeat as alive. A heartbeat whose
// ping loop wedged (unresolved await, stuck fs/network) stays alive as a PROCESS
// but stops pinging and stops writing state — the server ends the session via
// its no-ping sweep, yet `origin status` kept showing it "active" because the
// liveness check trusted the bare live PID (observed live: a bake-off session
// pinned active 16h after the server marked it COMPLETED). The heartbeat now
// re-touches its pid file every tick, so a live PID only counts when its pid
// file is also fresh. HOME is isolated per-worker (setup/isolate-home.ts), so
// ~/.origin here is a throwaway dir.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isSessionAlive, type SessionState } from '../session-state.js';

const STALE_MS = 3 * 60 * 60 * 1000; // mirrors SESSION_STALE_MS

function writePidFile(sessionId: string, pid: number, ageMs: number): void {
  const dir = path.join(os.homedir(), '.origin', 'heartbeats');
  fs.mkdirSync(dir, { recursive: true });
  const pf = path.join(dir, `${sessionId}.pid`);
  fs.writeFileSync(pf, String(pid));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(pf, t, t);
}

// A state with no repoPath/sessionTag and no __statePath, so ONLY the pid-file
// liveness check (#2) decides — isolating exactly what we're testing.
const bare = (sessionId: string): SessionState => ({ sessionId } as unknown as SessionState);

describe('isSessionAlive — hung-heartbeat detection', () => {
  it('live PID + FRESH pid file → alive (healthy daemon)', () => {
    writePidFile('hb-alive-fresh', process.pid, 2_000); // our own pid, touched 2s ago
    expect(isSessionAlive(bare('hb-alive-fresh'))).toBe(true);
  });

  it('THE FIX: live PID + STALE pid file (hung daemon) → NOT alive', () => {
    writePidFile('hb-hung', process.pid, STALE_MS + 60_000); // alive pid, but 3h+ since last tick
    expect(isSessionAlive(bare('hb-hung'))).toBe(false);
  });

  it('dead PID + fresh pid file → not alive', () => {
    writePidFile('hb-deadpid', 1_073_741_824, 2_000); // implausible pid → ESRCH
    expect(isSessionAlive(bare('hb-deadpid'))).toBe(false);
  });

  it('no pid file at all → not alive', () => {
    expect(isSessionAlive(bare('hb-nofile'))).toBe(false);
  });
});
