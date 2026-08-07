// Reap-decision regression for the heartbeat. The bug (user-reported: Codex
// Desktop on Windows): after a long idle the recorded parentPid was dead (the
// app came back under a new pid), so the heartbeat reaped a session the user
// was actively resuming — and the continuation auto-created a SPLIT duplicate
// session. Fix: fresh transcript/rollout activity vetoes the reap even when the
// recorded pid is dead.

import { describe, it, expect } from 'vitest';
import { parentLooksDead, heartbeatSuperseded, isServerTerminalDefinitive } from '../heartbeat-liveness.js';

// A healthy terminal agent: recorded pid alive.
const ALIVE = {
  recordedParentPid: 1234,
  recordedParentAlive: true,
  transcriptStale: false,
  stateFileStale: false,
  agentActivelyWriting: true,
};

describe('parentLooksDead', () => {
  it('keeps a session alive while the recorded parent process is running', () => {
    expect(parentLooksDead(ALIVE)).toBe(false);
  });

  it('THE FIX: dead recorded pid but agent still writing → NOT dead (no split)', () => {
    // Sleep/app-restart: the pid captured at session-start is gone, but the same
    // chat is being written to right now. Must not reap.
    expect(parentLooksDead({
      ...ALIVE,
      recordedParentAlive: false, // old pid dead
      agentActivelyWriting: true, // rollout freshly touched
    })).toBe(false);
  });

  it('reaps a dead recorded pid once the agent has gone quiet', () => {
    expect(parentLooksDead({
      ...ALIVE,
      recordedParentAlive: false,
      transcriptStale: true,
      agentActivelyWriting: false,
    })).toBe(true);
  });

  it('hookless IDE agent (pid≤0): stale transcript → dead, fresh → alive', () => {
    const base = {
      recordedParentPid: 0,
      recordedParentAlive: false,
      stateFileStale: true,
    };
    expect(parentLooksDead({ ...base, transcriptStale: true, agentActivelyWriting: false })).toBe(true);
    // Actively writing vetoes even the state-file/transcript staleness.
    expect(parentLooksDead({ ...base, transcriptStale: true, agentActivelyWriting: true })).toBe(false);
  });

  it('hookless IDE agent (pid≤0): state file fresh and no transcript signal → alive', () => {
    expect(parentLooksDead({
      recordedParentPid: 0,
      recordedParentAlive: false,
      transcriptStale: false,   // inconclusive (no path)
      stateFileStale: false,    // fresh
      agentActivelyWriting: false,
    })).toBe(false);
  });

  it('active-writing veto never overrides an ALREADY-alive parent (no-op)', () => {
    expect(parentLooksDead({ ...ALIVE, agentActivelyWriting: false })).toBe(false);
  });
});

// ── Orphaned-daemon regression ────────────────────────────────────────────────
// startHeartbeat() calls stopHeartbeat() before spawning, but two hooks firing
// concurrently race: both daemons spawn and the second overwrites the session's
// pid file with its own pid. The loser kept pinging forever, because the only
// ownership check was `fs.existsSync(pidFile)` — and the file DOES still exist,
// it just names the winner. Observed live on 2026-07-23: session 9e2ef3aa's pid
// file held 9218 while daemon 8107 was still running (and 13 daemons total were
// alive, several orphaned). Those orphans keep bumping session state, which
// holds sessions RUNNING forever — and a stale-but-"alive" session then wins
// commit attribution over the real one.
describe('heartbeatSuperseded', () => {
  it('keeps running while this daemon still owns the pid file', () => {
    expect(heartbeatSuperseded({ pidFileExists: true, pidFileOwner: 4242, myPid: 4242 })).toBe(false);
  });

  it('THE FIX: exits when a newer daemon took over the pid file', () => {
    // 8107 is still pinging, but 9218 owns the file now.
    expect(heartbeatSuperseded({ pidFileExists: true, pidFileOwner: 9218, myPid: 8107 })).toBe(true);
  });

  it('exits when the pid file is gone (session ended)', () => {
    expect(heartbeatSuperseded({ pidFileExists: false, pidFileOwner: null, myPid: 4242 })).toBe(true);
  });

  it('does NOT tear down on an unreadable or garbage pid file', () => {
    // Conservative: falsely killing the live daemon is worse than one extra tick.
    expect(heartbeatSuperseded({ pidFileExists: true, pidFileOwner: null, myPid: 4242 })).toBe(false);
    expect(heartbeatSuperseded({ pidFileExists: true, pidFileOwner: NaN, myPid: 4242 })).toBe(false);
    expect(heartbeatSuperseded({ pidFileExists: true, pidFileOwner: 0, myPid: 4242 })).toBe(false);
  });
});

describe('isServerTerminalDefinitive', () => {
  it('archived === true → stop immediately (the CLI/web drift fix)', () => {
    // A live IDE window keeps the parent alive, so the soft-terminal grace
    // would keep pinging forever; archived overrides that.
    expect(isServerTerminalDefinitive({ status: 'COMPLETED', archived: true })).toBe(true);
    expect(isServerTerminalDefinitive({ status: 'RUNNING', archived: true })).toBe(true);
    expect(isServerTerminalDefinitive({ archived: true })).toBe(true);
  });

  it('deleted / cross-org → NOT_FOUND is definitive', () => {
    expect(isServerTerminalDefinitive({ status: 'NOT_FOUND' })).toBe(true);
    expect(isServerTerminalDefinitive({ status: 'DELETED' })).toBe(true);
  });

  it('soft-terminal statuses are NOT definitive (keep the parent-alive grace)', () => {
    expect(isServerTerminalDefinitive({ status: 'COMPLETED', archived: false })).toBe(false);
    expect(isServerTerminalDefinitive({ status: 'ENDED' })).toBe(false);
    expect(isServerTerminalDefinitive({ status: 'ABANDONED' })).toBe(false);
    expect(isServerTerminalDefinitive({ status: 'IDLE' })).toBe(false);
    expect(isServerTerminalDefinitive({ status: 'RUNNING' })).toBe(false);
  });

  it('missing / empty response is not definitive (never tear down on a bad read)', () => {
    expect(isServerTerminalDefinitive(null)).toBe(false);
    expect(isServerTerminalDefinitive(undefined)).toBe(false);
    expect(isServerTerminalDefinitive({})).toBe(false);
  });
});
