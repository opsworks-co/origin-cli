#!/usr/bin/env node
/**
 * Monotonic CLI version bump.
 *
 * Versions are `0.YYYYMMDD.HHMM`. The updater (src/version-check.ts → isNewer)
 * compares the three dot-separated parts NUMERICALLY, component by component.
 * So a clock-time bump can SORT BELOW an already-published version: if the last
 * release was `0.20260612.2356` (a hand-bumped counter value) and we bump at
 * 19:22 we'd produce `0.20260612.1922` — and 1922 < 2356, so the numeric check
 * decides it is NOT newer and users never receive the update.
 *
 * This happened repeatedly (#215, #225, #228 were all re-bumps to climb back
 * above the deployed version). Fix: never emit a version that isn't strictly
 * greater than the current one. Prefer the natural date/time value, but when it
 * wouldn't sort higher, fall back to incrementing the last component. The third
 * part is then just a monotonic counter (it may exceed 2359) — that's fine, the
 * comparison is pure numeric and nothing parses it back into a clock time.
 *
 * BOTH components come from UTC. They used to disagree: the date was read from
 * `toISOString()` (UTC) while the time came from `getHours()`/`getMinutes()`
 * (LOCAL). Anywhere west of UTC, every evening release then stamped TOMORROW's
 * date with TONIGHT's clock — a bump at 23:59 EDT on Aug 12 produced
 * `0.20260813.2359`, the highest counter that date can hold. Nothing breaks
 * immediately (the value is still strictly greater), but it burns the whole of
 * the next day: every release on Aug 13 sorts below it and falls back to
 * counter arithmetic. UTC for both keeps the stamp internally consistent and
 * makes the result identical whether a release is cut from CI or a laptop.
 */
const fs = require('fs');
const path = require('path');

const parts = (v) => String(v).split('.').map((n) => Number(n) || 0);

// Strict component-wise "a > b" — mirrors isNewer() in src/version-check.ts.
function isGreater(a, b) {
  for (let i = 0; i < 3; i++) {
    const va = a[i] || 0;
    const vb = b[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

/**
 * The next version after `currentVersion` at instant `now`. Pure — no clock, no
 * filesystem — so the boundary cases above are testable.
 */
function computeNextVersion(currentVersion, now) {
  const current = parts(currentVersion);

  const yyyymmdd = Number(now.toISOString().slice(0, 10).replace(/-/g, ''));
  const hhmm = Number(
    String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0'),
  );
  const candidate = [current[0] || 0, yyyymmdd, hhmm];

  // Use the natural date/time value when it already sorts above the current
  // version; otherwise keep the current major+date and just bump the counter so
  // the result is guaranteed strictly greater.
  const next = isGreater(candidate, current)
    ? candidate
    : [current[0] || 0, Math.max(current[1], yyyymmdd), current[2] + 1];

  const nextVersion = next.join('.');
  if (!isGreater(parts(nextVersion), current)) {
    // Defensive: should be impossible, but never emit a non-increasing version.
    throw new Error(`refusing non-increasing bump ${currentVersion} -> ${nextVersion}`);
  }
  return nextVersion;
}

module.exports = { computeNextVersion, isGreater, parts };

if (require.main === module) {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = require(pkgPath);
  let nextVersion;
  try {
    nextVersion = computeNextVersion(pkg.version, new Date());
  } catch (err) {
    console.error(`[version-bump] ${err.message}`);
    process.exit(1);
  }
  const before = pkg.version;
  pkg.version = nextVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[version-bump] ${before} -> ${nextVersion}`);
}
