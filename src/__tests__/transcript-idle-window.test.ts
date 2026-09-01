/**
 * The transcript-idle window decides when the heartbeat calls an agent gone.
 *
 * At a flat 20 minutes it was ending live conversations. Claude Code has no
 * watchable pid — `LONG_RUNNING_AGENTS` is `['devin']` alone, so everything
 * else lands in the stale-file-only bucket with `parentPid = 0` — and
 * parentLooksDead reaps on `!processConfirmedAlive && transcriptStale` by
 * itself. Prod 0a8e2164 went quiet 16:35 → 18:48 while the user was away, was
 * reaped, and (before #1089) had its state deleted with the prompt history in
 * it.
 *
 * A hookless IDE agent genuinely has nothing else to go on: no pid, and a state
 * file kept warm by something other than its lifecycle. It keeps the short
 * window, which is what catches its zombie heartbeat.
 *
 * Everything else bumps the state file through saveSessionState on every
 * lifecycle hook and signals a real close via SessionEnd, so the transcript is
 * a backstop — 90 minutes, matching STALE_THRESHOLD_MS, which the state-file
 * signal already applies to the same pid-less agents.
 */
import { describe, it, expect } from 'vitest';
import { transcriptIdleWindowMs, parentLooksDead } from '../heartbeat-liveness.js';

const MIN = 60 * 1000;

describe('transcriptIdleWindowMs', () => {
  it('keeps the short window for hookless IDE agents', () => {
    expect(transcriptIdleWindowMs('cursor')).toBe(20 * MIN);
    expect(transcriptIdleWindowMs('antigravity')).toBe(20 * MIN);
  });

  it('gives hook-driven agents the backstop window', () => {
    for (const slug of ['claude-code', 'codex', 'gemini', 'copilot', 'devin']) {
      expect(transcriptIdleWindowMs(slug), slug).toBe(90 * MIN);
    }
  });

  it('treats an unknown agent as hook-driven', () => {
    // Reaping a live session corrupts the record; a zombie lingering an extra
    // hour costs a stale row the server's no-ping sweep clears anyway.
    expect(transcriptIdleWindowMs('')).toBe(90 * MIN);
    expect(transcriptIdleWindowMs('some-future-agent')).toBe(90 * MIN);
  });

  it('matches the state-file staleness window it sits beside', () => {
    // Both signals apply to the same pid-less agents in parentLooksDead. When
    // they disagreed the shorter one silently won.
    expect(transcriptIdleWindowMs('claude-code')).toBe(90 * MIN);
  });
});

describe('parentLooksDead — a pid-less agent idling between prompts', () => {
  // The exact shape of a Claude Code session waiting on its user.
  const idleClaude = (minutes: number) => ({
    recordedParentPid: 0,
    recordedParentAlive: false,
    transcriptStale: minutes > transcriptIdleWindowMs('claude-code') / MIN,
    stateFileStale: minutes > 90,
    agentActivelyWriting: minutes <= transcriptIdleWindowMs('claude-code') / MIN,
  });

  it('survives the gap that used to kill it', () => {
    // 25 minutes: past the old 20-minute window, nowhere near the new one.
    expect(parentLooksDead(idleClaude(25))).toBe(false);
    // The two-hour-thirteen gap from prod, under the OLD window, did reap.
    const underOldWindow = { ...idleClaude(133), transcriptStale: true, agentActivelyWriting: false };
    expect(parentLooksDead(underOldWindow)).toBe(true);
  });

  it('still reaps once everything has gone quiet past the backstop', () => {
    expect(parentLooksDead(idleClaude(120))).toBe(true);
  });

  it('never reaps while the agent is demonstrably writing', () => {
    expect(parentLooksDead({
      recordedParentPid: 0,
      recordedParentAlive: false,
      transcriptStale: true,
      stateFileStale: true,
      agentActivelyWriting: true,
    })).toBe(false);
  });

  it('leaves the hookless-IDE zombie caught as before', () => {
    // Cursor after its window closed: no pid, transcript cold past 20 minutes.
    expect(parentLooksDead({
      recordedParentPid: 0,
      recordedParentAlive: false,
      transcriptStale: true,
      stateFileStale: false,
      agentActivelyWriting: false,
    })).toBe(true);
  });
});
