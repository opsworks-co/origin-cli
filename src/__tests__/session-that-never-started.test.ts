/**
 * A session that never started does not stay Running.
 *
 * 2026-09-14: three Claude Code sessions sat on the Sessions page as Running
 * with no name, $0.00 and 0 tokens. Each fired SessionStart, then exited before
 * a prompt, so Claude Code never created its transcript. Their SessionEnd was
 * downgraded to a Stop, because the desktop app also fires SessionEnd on
 * reconnect. The heartbeat treated the missing transcript as inconclusive and
 * kept pinging for the 90-minute stale window, and since #1605 the server
 * keeps a pinging session.
 *
 * sessionNeverStarted recognises that shape and nothing else. A session with a
 * prompt, or with a transcript on disk, is something a resume can continue.
 */
import { describe, it, expect } from 'vitest';
import { NEVER_STARTED_GRACE_MS, parentLooksDead, sessionNeverStarted } from '../heartbeat-liveness.js';

const NOW = Date.parse('2026-09-14T02:40:00.000Z');
const GHOST = {
  promptCount: 0,
  transcriptPath: '/Users/x/.claude/projects/-repo/41aa01b9.jsonl',
  transcriptExists: false,
  startedAtMs: NOW - 20 * 60_000,
  nowMs: NOW,
  graceMs: NEVER_STARTED_GRACE_MS,
};

describe('sessionNeverStarted', () => {
  it('recognises the ghost: no prompt, transcript never created, past the grace window', () => {
    expect(sessionNeverStarted(GHOST)).toBe(true);
  });

  it('a session with a prompt started, even with no transcript on disk', () => {
    expect(sessionNeverStarted({ ...GHOST, promptCount: 1 })).toBe(false);
  });

  it('a transcript on disk means a resume can continue it', () => {
    expect(sessionNeverStarted({ ...GHOST, transcriptExists: true })).toBe(false);
  });

  it('no recorded transcript path proves nothing (Codex passes none)', () => {
    expect(sessionNeverStarted({ ...GHOST, transcriptPath: null })).toBe(false);
    expect(sessionNeverStarted({ ...GHOST, transcriptPath: '' })).toBe(false);
  });

  it('a just-opened session inside the grace window is left alone', () => {
    expect(sessionNeverStarted({ ...GHOST, startedAtMs: NOW - 60_000 })).toBe(false);
  });

  it('with a grace window, an unknown start time is inconclusive', () => {
    expect(sessionNeverStarted({ ...GHOST, startedAtMs: null })).toBe(false);
    expect(sessionNeverStarted({ ...GHOST, startedAtMs: Number.NaN })).toBe(false);
  });

  it('SessionEnd passes no grace window: the session has already exited', () => {
    expect(sessionNeverStarted({ ...GHOST, startedAtMs: null, graceMs: 0 })).toBe(true);
  });
});

describe('parentLooksDead with transcriptNeverCreated', () => {
  const HOOK_DRIVEN = {
    recordedParentPid: 0,
    recordedParentAlive: false,
    transcriptStale: false,
    stateFileStale: false,
    agentActivelyWriting: false,
  };

  it('reaps a never-started session that the stale checks could not see', () => {
    expect(parentLooksDead(HOOK_DRIVEN)).toBe(false);
    expect(parentLooksDead({ ...HOOK_DRIVEN, transcriptNeverCreated: true })).toBe(true);
  });

  it('a live recorded process still keeps it', () => {
    expect(parentLooksDead({
      ...HOOK_DRIVEN, recordedParentPid: 1234, recordedParentAlive: true, transcriptNeverCreated: true,
    })).toBe(false);
  });

  it('an open turn or active writing still vetoes the reap', () => {
    expect(parentLooksDead({ ...HOOK_DRIVEN, transcriptNeverCreated: true, turnInProgress: true })).toBe(false);
    expect(parentLooksDead({ ...HOOK_DRIVEN, transcriptNeverCreated: true, agentActivelyWriting: true })).toBe(false);
  });
});
