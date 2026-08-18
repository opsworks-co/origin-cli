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

const require = createRequire(import.meta.url);
const { computeNextVersion, isGreater, parts } = require('../../scripts/version-bump.cjs');

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
