// The capture-e2e family runs on native Windows unless a file has earned a
// hold. Twice now a `skipIf(!haveDist || isWindows)` copied from the file
// next door spread to a quarter of the family with no Windows failure behind
// any of it (#1551 lifted the first round, see helpers/windows-e2e.ts for the
// second). A skip is invisible in a green run, so it is caught here instead.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { WINDOWS_HELD } from './helpers/windows-e2e.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(DIR).filter((f) => /^capture-e2e-.*\.test\.ts$/.test(f) && f !== path.basename(fileURLToPath(import.meta.url)));

/** Every skipIf/runIf condition in the file, and any bare `.skip(` gate. */
function gates(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:describe|it|test)\.(skipIf|runIf)\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
      i++;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

const WINDOWS = /isWindows|win32|posix|process\.platform/;

describe('capture-e2e Windows gate', () => {
  it('finds the family', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('no capture-e2e file skips Windows unless it is held with a Windows failure', () => {
    const skipping = files.filter((f) => gates(fs.readFileSync(path.join(DIR, f), 'utf-8')).some((g) => WINDOWS.test(g)));
    const unheld = skipping.filter((f) => !WINDOWS_HELD[f]);
    expect(unheld, 'skips Windows with no recorded Windows failure — run it, or add it to WINDOWS_HELD with the failing run').toEqual([]);
  });

  it('every hold names a file that still exists and still skips', () => {
    for (const f of Object.keys(WINDOWS_HELD)) {
      expect(files, `${f} is held but gone`).toContain(f);
      const g = gates(fs.readFileSync(path.join(DIR, f), 'utf-8'));
      expect(g.some((x) => WINDOWS.test(x)), `${f} is held but no longer skips Windows — drop the hold`).toBe(true);
    }
  });

  it('sees a Windows skip written in any of the shapes the family used', () => {
    const shapes = [
      "describe.skipIf(!haveDist || isWindows)('x', () => {})",
      "describe.skipIf(!haveDist || !posix)('x', () => {})",
      "it.skipIf(process.platform === 'win32')('x', () => {})",
      "describe.skipIf(!haveDist || (isWindows && process.env.P !== '1'))('x', () => {})",
    ];
    for (const s of shapes) expect(gates(s).some((g) => WINDOWS.test(g)), s).toBe(true);
    expect(gates("describe.skipIf(!haveDist)('x', () => {})").some((g) => WINDOWS.test(g))).toBe(false);
  });
});
