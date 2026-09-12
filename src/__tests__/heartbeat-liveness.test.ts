// Reap-decision regression for the heartbeat. The bug (user-reported: Codex
// Desktop on Windows): after a long idle the recorded parentPid was dead (the
// app came back under a new pid), so the heartbeat reaped a session the user
// was actively resuming — and the continuation auto-created a SPLIT duplicate
// session. Fix: fresh transcript/rollout activity vetoes the reap even when the
// recorded pid is dead.

import { describe, it, expect } from 'vitest';
import { parentLooksDead, heartbeatSuperseded, isServerTerminalDefinitive, turnInProgress, OPEN_TURN_MAX_MS } from '../heartbeat-liveness.js';

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

  // Prod c1e361a4 (Cursor, 2026-09-08): the prompt landed 23:14:55, the agent
  // read and thought until 23:44, Stop came 23:45:30 — and the heartbeat ended
  // the session 23:36:37. Cursor writes its transcript when a generation ends,
  // so for the whole turn every disk signal read "idle": no pid, transcript
  // untouched past the 20-minute hookless-IDE window, state file only ever
  // bumped by Origin itself. The 23:44 edits found no session; the next prompt
  // minted a twin.
  it('THE FIX: an OPEN turn vetoes the hookless-IDE transcript reap', () => {
    expect(parentLooksDead({
      recordedParentPid: 0,
      recordedParentAlive: false,
      transcriptStale: true,
      stateFileStale: true,
      agentActivelyWriting: false,
      turnInProgress: true,
    })).toBe(false);
  });

  it('with no open turn the same signals still reap (the zombie case stays fixed)', () => {
    expect(parentLooksDead({
      recordedParentPid: 0,
      recordedParentAlive: false,
      transcriptStale: true,
      stateFileStale: true,
      agentActivelyWriting: false,
      turnInProgress: false,
    })).toBe(true);
  });

  it('an open turn also outranks a dead recorded pid', () => {
    expect(parentLooksDead({
      ...ALIVE,
      recordedParentAlive: false,
      agentActivelyWriting: false,
      transcriptStale: true,
      turnInProgress: true,
    })).toBe(false);
  });
});

describe('turnInProgress (hook-written stamps only)', () => {
  const NOW = 1_800_000_000_000;

  it('open: a prompt was submitted and no Stop has closed it', () => {
    expect(turnInProgress({ currentTurnStartedAt: NOW - 30 * 60_000 }, NOW)).toBe(true);
    expect(turnInProgress({ currentTurnStartedAt: NOW - 30 * 60_000, lastTurnClosedAt: NOW - 60 * 60_000 }, NOW)).toBe(true);
  });

  it('closed: the Stop after the prompt ends the turn', () => {
    expect(turnInProgress({ currentTurnStartedAt: NOW - 30 * 60_000, lastTurnClosedAt: NOW - 10 * 60_000 }, NOW)).toBe(false);
    // Same instant counts as closed — Stop stamps after the prompt did.
    expect(turnInProgress({ currentTurnStartedAt: NOW, lastTurnClosedAt: NOW }, NOW)).toBe(false);
  });

  it('a turn that never got its Stop stops counting past the cap', () => {
    // API error / interrupt / app quit mid-generation: nothing closes the
    // turn, so the veto must lapse or a dead Cursor would never be reaped.
    expect(turnInProgress({ currentTurnStartedAt: NOW - OPEN_TURN_MAX_MS - 1 }, NOW)).toBe(false);
    expect(turnInProgress({ currentTurnStartedAt: NOW - OPEN_TURN_MAX_MS }, NOW)).toBe(true);
  });

  it('no stamps, garbage stamps, or a stamp from the future → not open', () => {
    expect(turnInProgress(null, NOW)).toBe(false);
    expect(turnInProgress({}, NOW)).toBe(false);
    expect(turnInProgress({ currentTurnStartedAt: NaN }, NOW)).toBe(false);
    expect(turnInProgress({ currentTurnStartedAt: 0 }, NOW)).toBe(false);
    expect(turnInProgress({ currentTurnStartedAt: NOW + 60_000 }, NOW)).toBe(false);
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

// ── stateFileTakenOver ──────────────────────────────────────────────────────
// The daemon is spawned on a session id and a state-file path; the file is
// keyed by conversation TAG. A second registration on the same tag changes the
// file's sessionId under the daemon, which then feeds the other session's
// turns to a row nobody owns (prod 2026-09-09: 5431ff0f's daemon pushed
// e24477e2's turn 1 under 5431ff0f — both rows live, same diff on each).
import { stateFileTakenOver } from '../heartbeat-liveness.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

describe('stateFileTakenOver', () => {
  it('a different REGISTERED id in the file means the row moved', () => {
    expect(stateFileTakenOver({ ownSessionId: '5431ff0f', fileSessionId: 'e24477e2' })).toBe(true);
  });

  it('our own id is not a takeover', () => {
    expect(stateFileTakenOver({ ownSessionId: '5431ff0f', fileSessionId: '5431ff0f' })).toBe(false);
  });

  it('a provisional id in the file is a stale reservation write, not a takeover', () => {
    // A hook holding the reservation can briefly write `local-…` back; between
    // placeholders the incumbent wins, and the registered id returns on the
    // next save.
    expect(stateFileTakenOver({ ownSessionId: '5431ff0f', fileSessionId: 'local-82aaa929' })).toBe(false);
    expect(stateFileTakenOver({ ownSessionId: 'local-a', fileSessionId: 'local-b' })).toBe(false);
  });

  it('a standalone daemon on a placeholder exits once the row is registered', () => {
    expect(stateFileTakenOver({ ownSessionId: 'local-a', fileSessionId: 'srv-1' })).toBe(true);
  });

  it('an unreadable file is not a takeover (never tear down on a bad read)', () => {
    expect(stateFileTakenOver({ ownSessionId: '5431ff0f', fileSessionId: undefined })).toBe(false);
    expect(stateFileTakenOver({ ownSessionId: '5431ff0f', fileSessionId: null })).toBe(false);
    expect(stateFileTakenOver({ ownSessionId: '5431ff0f', fileSessionId: '' })).toBe(false);
  });

  it('is wired into the daemon before any push of the file\'s contents', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'heartbeat.ts'), 'utf-8');
    const check = src.indexOf('stateFileTakenOver({ ownSessionId: sessionId');
    const stamp = src.indexOf('// Liveness stamp: bump the pid file');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(stamp);
    // And it ends OUR row without reading the file's contents into the payload.
    const orphan = src.indexOf('async function endOrphanedSession');
    expect(orphan).toBeGreaterThan(-1);
    const next = src.indexOf('async function endSession', orphan);
    expect(src.slice(orphan, next)).not.toContain('stateData');
  });
});
