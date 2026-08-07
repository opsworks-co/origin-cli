// `shouldRestartForUpgrade` is the shared self-restart-on-upgrade decision used
// by BOTH the bake-off runner (restarts via launchd/systemd KeepAlive) and the
// per-session heartbeat (re-spawns its own replacement). It must fire ONLY on a
// strictly-newer on-disk version so a daemon can never restart-loop.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { shouldRestartForUpgrade, getCurrentVersion } from '../version-check.js';

describe('getCurrentVersion (ESM __dirname regression)', () => {
  // The CLI is ESM ("type":"module"), where __dirname is undefined. The old
  // implementation used __dirname, so in every built (dist) runtime this threw
  // and returned null — silently disabling the update check and BOTH self-
  // restart daemons (shouldRestartForUpgrade(null, …) is always false). Must
  // return the REAL package.json version, never null or the 0.1.0 fallback.
  it('returns the real package.json version, not null/fallback', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf-8'));
    const v = getCurrentVersion();
    expect(v).toBe(pkg.version);
    expect(v).not.toBeNull();
    expect(v).not.toBe('0.1.0');
  });
});

describe('shouldRestartForUpgrade (shared runner + heartbeat)', () => {
  it('restarts when the on-disk binary is strictly newer than startup', () => {
    expect(shouldRestartForUpgrade('0.20260805.2152', '0.20260805.2153')).toBe(true);
    // numeric compare, not string: .930 is NEWER than .245 despite sorting lower
    expect(shouldRestartForUpgrade('0.20260805.245', '0.20260805.930')).toBe(true);
  });

  it('does NOT restart on equal versions (just respawned → no loop)', () => {
    expect(shouldRestartForUpgrade('0.20260805.2152', '0.20260805.2152')).toBe(false);
  });

  it('does NOT restart when the on-disk version is older (never downgrade-loop)', () => {
    expect(shouldRestartForUpgrade('0.20260805.2153', '0.20260805.2152')).toBe(false);
  });

  it('does NOT restart when either version is unreadable', () => {
    expect(shouldRestartForUpgrade(null, '0.20260805.2153')).toBe(false);
    expect(shouldRestartForUpgrade('0.20260805.2152', null)).toBe(false);
    expect(shouldRestartForUpgrade(null, null)).toBe(false);
  });
});
