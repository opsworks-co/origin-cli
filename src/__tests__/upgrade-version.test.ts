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
