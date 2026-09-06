/**
 * Fails the build when source resolves a file URL with `.pathname`.
 *
 * `new URL(import.meta.url).pathname` returns `/D:/a/origin/…` on Windows — a
 * spurious leading slash before the drive letter — which then resolves to
 * `D:\D:\a\origin\…` and cannot be opened. `fileURLToPath` decodes a file URL
 * to a real OS path on every platform.
 *
 * This lesson was already learned and WRITTEN DOWN in product code:
 * commands/upgrade.ts carries a comment warning against exactly this, because
 * it once made every upgrade report "Current version: 0.0.0". The knowledge
 * never reached the tests, and five test files kept the broken form — four of
 * them failing at COLLECTION on native Windows, which kept that job red on
 * main for a dozen-plus commits and masked every regression it exists to catch.
 *
 * Knowing is not enough, which is why this is mechanical. Same shape as
 * path-comparison-guard.test.ts, and for the same reason: the next person to
 * write it will not have read upgrade.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROKEN = /new URL\(\s*import\.meta\.url\s*\)\.pathname/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      sourceFiles(p, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      // This file necessarily CONTAINS the broken pattern — as the thing it
      // searches for, and as the fixture proving the search works. Same
      // self-exclusion path-comparison-guard.test.ts makes for paths.ts.
      if (e.name === 'file-url-path-guard.test.ts') continue;
      out.push(p);
    }
  }
  return out;
}

describe('file URL path guard', () => {
  it('finds no `new URL(import.meta.url).pathname` anywhere in src', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      fs.readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        const code = line.trim();
        // Skip the prose that explains the rule (here, and in upgrade.ts).
        if (code.startsWith('*') || code.startsWith('//')) return;
        if (BROKEN.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${code}`);
      });
    }
    expect(
      offenders,
      'Use fileURLToPath(import.meta.url). `.pathname` yields "/C:/…" on Windows '
      + '(a leading slash before the drive letter), which resolves to "D:\\D:\\…" '
      + 'and cannot be opened. See commands/upgrade.ts.',
    ).toEqual([]);
  });

  it('actually fires — a guard that cannot fire is not a guard', () => {
    expect(BROKEN.test('const p = new URL(import.meta.url).pathname;')).toBe(true);
    expect(BROKEN.test('const p = fileURLToPath(import.meta.url);')).toBe(false);
  });
});
