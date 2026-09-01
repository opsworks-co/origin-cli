/**
 * `scripts/version-bump.cjs` — the only thing standing between a release and a
 * version number users can never install.
 *
 * The updater compares `0.YYYYMMDD.HHMM` NUMERICALLY, component by component,
 * so a version that doesn't sort strictly above the deployed one is invisible:
 * `origin upgrade` reports "already up to date" forever. #215/#225/#228 were
 * all re-bumps to climb back over a published version.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const { computeNextVersion, isGreater, parts, syncLockVersion } = require('../../scripts/version-bump.cjs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const gt = (a: string, b: string) => isGreater(parts(a), parts(b));

describe('computeNextVersion — date and time must share one basis', () => {
  it('takes BOTH date and time from UTC', () => {
    // 23:59 EDT on Aug 12 is 03:59 UTC on Aug 13. Reading the date from UTC
    // and the clock from LOCAL produced 0.20260813.2359 — tomorrow's date
    // stamped with tonight's time, and the highest counter that date can hold.
    const at = new Date('2026-08-13T03:59:00Z');
    expect(computeNextVersion('0.20260812.1057', at)).toBe('0.20260813.359');
  });

  it('does not burn the following day (the 2359 regression)', () => {
    // With the old mixed-basis bump, every release the next day sorted BELOW
    // and fell back to counter arithmetic. Pin that the natural value for a
    // morning release is a small counter, leaving the day's range usable.
    const morning = computeNextVersion('0.20260813.359', new Date('2026-08-13T09:15:00Z'));
    expect(morning).toBe('0.20260813.915');
    expect(gt(morning, '0.20260813.359')).toBe(true);
  });

  it('uses the natural value when it already sorts higher', () => {
    expect(computeNextVersion('0.20260812.1057', new Date('2026-08-12T17:40:00Z')))
      .toBe('0.20260812.1740');
  });
});

describe('computeNextVersion — monotonicity', () => {
  it('falls back to a counter when the clock would sort BELOW', () => {
    // Same day, but the current version holds a hand-rolled high counter.
    expect(computeNextVersion('0.20260812.2356', new Date('2026-08-12T19:22:00Z')))
      .toBe('0.20260812.2357');
  });

  it('lets the counter exceed 2359 rather than emitting a stale version', () => {
    // The third part is a sort key, not a clock — nothing parses it back.
    expect(computeNextVersion('0.20260813.2359', new Date('2026-08-13T10:00:00Z')))
      .toBe('0.20260813.2360');
  });

  it('never emits a version that is not strictly greater', () => {
    const cases: Array<[string, string]> = [
      ['0.20260812.1057', '2026-08-13T03:59:00Z'],
      ['0.20260812.2356', '2026-08-12T19:22:00Z'],
      ['0.20260813.2359', '2026-08-13T10:00:00Z'],
      ['0.20260813.2359', '2026-08-14T00:00:00Z'],
      ['0.20260812.0000', '2026-08-12T00:00:00Z'],
    ];
    for (const [current, iso] of cases) {
      const next = computeNextVersion(current, new Date(iso));
      expect(gt(next, current), `${current} @ ${iso} -> ${next}`).toBe(true);
    }
  });

  it('carries the date forward even when falling back to the counter', () => {
    // A stale high counter must not pin the version to an old date.
    const next = computeNextVersion('0.20260812.9999', new Date('2026-08-13T10:00:00Z'));
    expect(parts(next)[1]).toBe(20260813);
    expect(gt(next, '0.20260812.9999')).toBe(true);
  });

  it('advances cleanly across a day boundary', () => {
    expect(computeNextVersion('0.20260813.2360', new Date('2026-08-14T08:30:00Z')))
      .toBe('0.20260814.830');
  });
});

// The bump used to write package.json only, so every release left the lockfile
// on the previous version — the exact drift version-collision-guard.test.ts
// keeps catching. npm records the package's own version in TWO places.
describe('syncLockVersion — the lockfile moves with the manifest', () => {
  it('updates both places npm records the version', () => {
    const lock = {
      name: '@origin/cli',
      version: '0.20260825.2247',
      lockfileVersion: 3,
      packages: { '': { name: '@origin/cli', version: '0.20260825.2247' } },
    };
    syncLockVersion(lock, '0.20260826.0');
    expect(lock.version).toBe('0.20260826.0');
    expect(lock.packages[''].version).toBe('0.20260826.0');
  });

  it('leaves dependency pins alone', () => {
    const lock = {
      version: '1.0.0',
      packages: {
        '': { version: '1.0.0' },
        'node_modules/chalk': { version: '1.0.0' },
      },
    };
    syncLockVersion(lock, '2.0.0');
    expect(lock.packages['node_modules/chalk'].version).toBe('1.0.0');
  });

  it('tolerates a lockfile with no packages map rather than throwing', () => {
    const lock: any = { version: '1.0.0' };
    expect(() => syncLockVersion(lock, '2.0.0')).not.toThrow();
    expect(lock.version).toBe('2.0.0');
  });
});

// End-to-end: run the real script against a scratch copy and assert the two
// files agree afterwards — the property version-collision-guard asserts.
describe('version-bump.cjs writes both files', () => {
  it('leaves package.json and package-lock.json on the same version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-bump-'));
    const scripts = path.join(dir, 'scripts');
    fs.mkdirSync(scripts);
    fs.copyFileSync(
      path.join(__dirname, '../../scripts/version-bump.cjs'),
      path.join(scripts, 'version-bump.cjs'),
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@origin/cli', version: '0.20260101.1' }, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify(
        {
          name: '@origin/cli',
          version: '0.20260101.1',
          lockfileVersion: 3,
          packages: { '': { name: '@origin/cli', version: '0.20260101.1' } },
        },
        null,
        2,
      ) + '\n',
    );

    execFileSync(process.execPath, [path.join(scripts, 'version-bump.cjs')], { cwd: dir });

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    expect(pkg.version).not.toBe('0.20260101.1');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
