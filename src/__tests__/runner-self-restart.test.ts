// The bake-off runner is a long-running daemon. `origin upgrade` (npm install -g)
// replaces the package files in place, but the running process keeps executing
// the OLD code and re-stamps its stale version every heartbeat — the "your CLI is
// out of date" bake-off banner even after the user upgraded (hit twice on prod).
// shouldRestartForUpgrade decides when to exit so KeepAlive respawns onto the new
// binary. It must fire ONLY on a strictly-newer on-disk version — never loop.
import { describe, it, expect } from 'vitest';
import { shouldRestartForUpgrade } from '../commands/benchmark-runner.js';

describe('shouldRestartForUpgrade', () => {
  it('restarts when the on-disk binary is strictly newer than startup', () => {
    expect(shouldRestartForUpgrade('0.20260729.245', '0.20260805.2011')).toBe(true);
    expect(shouldRestartForUpgrade('0.20260804.2040', '0.20260804.2042')).toBe(true);
  });

  it('does NOT restart when versions are equal (no upgrade / just respawned — no loop)', () => {
    expect(shouldRestartForUpgrade('0.20260805.2011', '0.20260805.2011')).toBe(false);
  });

  it('does NOT restart when the on-disk version is older (never downgrade-loop)', () => {
    expect(shouldRestartForUpgrade('0.20260805.2011', '0.20260804.2042')).toBe(false);
  });

  it('does NOT restart when either version is unreadable', () => {
    expect(shouldRestartForUpgrade(null, '0.20260805.2011')).toBe(false);
    expect(shouldRestartForUpgrade('0.20260805.2011', null)).toBe(false);
    expect(shouldRestartForUpgrade(null, null)).toBe(false);
  });
});
