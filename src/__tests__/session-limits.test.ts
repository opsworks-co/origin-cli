/**
 * Tests for the SESSION_LIMITS policy evaluation (session-limits.ts).
 *
 * The policy exists to break the most expensive usage pattern we see:
 * sessions left open for many hours. Idle gaps kill the prompt cache (every
 * resume re-writes the whole context at 1.25× input price) and a context
 * that never resets drags its full history behind every turn. Admins
 * configure thresholds; the CLI heartbeat notifies/auto-ends and
 * user-prompt-submit blocks past the duration cap.
 *
 * These tests cover the pure logic shared by both enforcement points:
 * parseSessionLimits (rule extraction/merging) and evaluateSessionLimits
 * (threshold evaluation).
 */

import { describe, it, expect } from 'vitest';
import {
  parseSessionLimits,
  evaluateSessionLimits,
  buildDurationBlockMessage,
  DURATION_WARN_FRACTION,
} from '../session-limits.js';

const rule = (condition: object, action = 'block', type = 'SESSION_LIMITS') => ({
  type,
  condition: JSON.stringify(condition),
  action,
  severity: 'MEDIUM',
});

const MIN = 60_000;

describe('parseSessionLimits', () => {
  it('returns null when there are no rules at all', () => {
    expect(parseSessionLimits(undefined)).toBeNull();
    expect(parseSessionLimits(null)).toBeNull();
    expect(parseSessionLimits([])).toBeNull();
  });

  it('ignores rules of other policy types', () => {
    expect(parseSessionLimits([rule({ max_duration_minutes: 120 }, 'block', 'COST_LIMIT')])).toBeNull();
  });

  it('extracts all three thresholds from one rule', () => {
    const cfg = parseSessionLimits([
      rule({ idle_notify_minutes: 60, max_idle_minutes: 90, max_duration_minutes: 120 }),
    ]);
    expect(cfg).toEqual({
      idleNotifyMinutes: 60,
      maxIdleMinutes: 90,
      maxDurationMinutes: 120,
      enforce: true,
    });
  });

  it('treats non-block actions as notify-only (enforce: false)', () => {
    const cfg = parseSessionLimits([rule({ idle_notify_minutes: 60 }, 'warn')]);
    expect(cfg?.enforce).toBe(false);
  });

  it('merges multiple rules strictest-wins, block anywhere makes it enforcing', () => {
    const cfg = parseSessionLimits([
      rule({ max_duration_minutes: 240 }, 'warn'),
      rule({ max_duration_minutes: 120, idle_notify_minutes: 30 }, 'block'),
    ]);
    expect(cfg).toEqual({
      idleNotifyMinutes: 30,
      maxIdleMinutes: undefined,
      maxDurationMinutes: 120,
      enforce: true,
    });
  });

  it('skips malformed condition JSON and rules with no usable limit', () => {
    expect(parseSessionLimits([
      { type: 'SESSION_LIMITS', condition: 'not json{', action: 'block' },
      rule({ unrelated_key: 5 }),
    ])).toBeNull();
  });

  it('rejects non-positive and non-numeric threshold values', () => {
    expect(parseSessionLimits([rule({ max_duration_minutes: 0 })])).toBeNull();
    expect(parseSessionLimits([rule({ max_duration_minutes: -10 })])).toBeNull();
    expect(parseSessionLimits([rule({ max_duration_minutes: '120' })])).toBeNull();
  });
});

describe('evaluateSessionLimits', () => {
  const now = Date.UTC(2026, 5, 11, 12, 0, 0);
  const startedAt = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const activity = (minutesAgo: number) => now - minutesAgo * MIN;

  it('flags idle notification at the threshold and not before', () => {
    const cfg = { idleNotifyMinutes: 60, enforce: false };
    expect(evaluateSessionLimits(cfg, startedAt(120), activity(59), now).idleNotifyDue).toBe(false);
    expect(evaluateSessionLimits(cfg, startedAt(120), activity(60), now).idleNotifyDue).toBe(true);
  });

  it('only flags idle auto-end when the config is enforcing', () => {
    const idle = { startedAtIso: startedAt(300), last: activity(100) };
    expect(
      evaluateSessionLimits({ maxIdleMinutes: 90, enforce: false }, idle.startedAtIso, idle.last, now).idleEndDue,
    ).toBe(false);
    expect(
      evaluateSessionLimits({ maxIdleMinutes: 90, enforce: true }, idle.startedAtIso, idle.last, now).idleEndDue,
    ).toBe(true);
  });

  it('warns in the window before the duration cap and flips to exceeded at the cap', () => {
    const cfg = { maxDurationMinutes: 100, enforce: true };
    const warnStart = 100 * DURATION_WARN_FRACTION; // 85 minutes
    const fresh = evaluateSessionLimits(cfg, startedAt(50), activity(0), now);
    expect(fresh.durationWarnDue).toBe(false);
    expect(fresh.durationExceeded).toBe(false);

    const warming = evaluateSessionLimits(cfg, startedAt(warnStart), activity(0), now);
    expect(warming.durationWarnDue).toBe(true);
    expect(warming.durationExceeded).toBe(false);

    const capped = evaluateSessionLimits(cfg, startedAt(100), activity(0), now);
    expect(capped.durationWarnDue).toBe(false);
    expect(capped.durationExceeded).toBe(true);
  });

  it('a session with constant activity never trips idle limits, only duration', () => {
    const cfg = { idleNotifyMinutes: 60, maxIdleMinutes: 90, maxDurationMinutes: 120, enforce: true };
    const busy = evaluateSessionLimits(cfg, startedAt(180), activity(0.2), now);
    expect(busy.idleNotifyDue).toBe(false);
    expect(busy.idleEndDue).toBe(false);
    expect(busy.durationExceeded).toBe(true);
  });

  it('tolerates a missing startedAt and missing activity timestamp', () => {
    const cfg = { idleNotifyMinutes: 60, maxDurationMinutes: 120, enforce: true };
    const status = evaluateSessionLimits(cfg, undefined, 0, now);
    expect(status.ageMinutes).toBe(0);
    expect(status.idleMinutes).toBe(0);
    expect(status.durationExceeded).toBe(false);
    expect(status.idleNotifyDue).toBe(false);
  });
});

describe('buildDurationBlockMessage', () => {
  it('names both the limit and the session age, and tells the user what to do', () => {
    const msg = buildDurationBlockMessage(120, 145.4);
    expect(msg).toContain('120-minute session limit');
    expect(msg).toContain('145 minutes old');
    expect(msg).toContain('Start a NEW session');
  });
});
