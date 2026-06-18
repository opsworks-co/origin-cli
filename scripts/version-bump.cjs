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
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = require(pkgPath);

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

const current = parts(pkg.version);

const d = new Date();
const yyyymmdd = Number(d.toISOString().slice(0, 10).replace(/-/g, ''));
const hhmm = Number(
  String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0'),
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
  // Defensive: should be impossible, but never write a non-increasing version.
  console.error(`[version-bump] refusing non-increasing bump ${pkg.version} -> ${nextVersion}`);
  process.exit(1);
}

pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`[version-bump] ${current.join('.')} -> ${nextVersion}`);
