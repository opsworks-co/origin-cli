// Regression: `origin upgrade` reported "Current version: 0.0.0" on native
// Windows because getCurrentVersion() resolved the package.json path from
// `new URL(import.meta.url).pathname`, which prepends a spurious slash before
// the drive letter (/C:/…) that readFileSync can't open. This test runs on the
// windows-latest CI leg too, where it would have failed against the old code.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCurrentVersion } from '../commands/upgrade.js';
import { compareVersions, isNewer } from '../version-check.js';

describe('upgrade getCurrentVersion', () => {
  it('reads the real package version, not the 0.0.0 fallback', () => {
    // The package.json this test resolves against (src/__tests__ → ../../).
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const expected = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;

    const got = getCurrentVersion();
    expect(got).not.toBe('0.0.0');
    expect(got).toBe(expected);
  });
});

// `origin upgrade` used to test only `current === latest`. Anything "different"
// was treated as newer, so a CLI ahead of the server got silently DOWNGRADED
// and the output still read "Upgrading: 2043 -> 2042". Two ordinary ways to be
// ahead: a locally-built install, and the several-minute window after a release
// tag is pushed but before its deploy regenerates /cli/version.json.
describe('compareVersions — ordering, not equality', () => {
  it('orders the real release stream', () => {
    expect(compareVersions('0.20260804.2042', '0.20260804.2043')).toBeLessThan(0);
    expect(compareVersions('0.20260804.2043', '0.20260804.2042')).toBeGreaterThan(0);
    expect(compareVersions('0.20260804.2043', '0.20260804.2043')).toBe(0);
  });

  it('compares the patch component NUMERICALLY, not as a string', () => {
    // The exact trap: Origin's patch is a wall-clock HHmm, so an early-morning
    // release ("524") sorts AFTER a late one ("2043") under string compare.
    expect('2043' < '524').toBe(true);                                  // string order is wrong
    expect(compareVersions('0.20260804.524', '0.20260804.2043')).toBeLessThan(0);
    expect(compareVersions('0.20260804.2043', '0.20260804.524')).toBeGreaterThan(0);
  });

  it('orders across the date component', () => {
    expect(compareVersions('0.20260804.2359', '0.20260805.0001')).toBeLessThan(0);
    expect(compareVersions('0.20260805.0001', '0.20260804.2359')).toBeGreaterThan(0);
  });

  it('sorts the 0.0.0 read-failure fallback oldest, so it always upgrades', () => {
    expect(compareVersions('0.0.0', '0.20260804.2043')).toBeLessThan(0);
  });

  it('treats missing and unparseable components as zero rather than NaN', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(0); // tolerated, never NaN
    expect(compareVersions('', '0.0.0')).toBe(0);
    expect(Number.isNaN(compareVersions('x.y.z', '1.0.0'))).toBe(false);
    expect(compareVersions('x.y.z', '1.0.0')).toBeLessThan(0);
  });

  it('is antisymmetric across the whole release history', () => {
    const releases = [
      '0.20260624.2348', '0.20260804.524', '0.20260804.1909', '0.20260804.2013',
      '0.20260804.2039', '0.20260804.2040', '0.20260804.2042', '0.20260804.2043',
    ];
    for (let i = 0; i < releases.length; i++) {
      for (let j = 0; j < releases.length; j++) {
        const c = compareVersions(releases[i], releases[j]);
        if (i < j) expect(c).toBeLessThan(0);
        else if (i > j) expect(c).toBeGreaterThan(0);
        else expect(c).toBe(0);
      }
    }
  });
});

describe('isNewer stays consistent with compareVersions', () => {
  it('agrees on every ordering', () => {
    expect(isNewer('0.20260804.2043', '0.20260804.2042')).toBe(true);
    expect(isNewer('0.20260804.2042', '0.20260804.2043')).toBe(false);
    expect(isNewer('0.20260804.2043', '0.20260804.2043')).toBe(false);
    // The banner must not fire for an early-morning build that IS older.
    expect(isNewer('0.20260804.524', '0.20260804.2043')).toBe(false);
  });
});
