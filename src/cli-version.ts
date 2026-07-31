import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve this CLI's own version once. In both dev (tsx from src/) and the
// bundled build (dist/), package.json sits one directory up from this module —
// the same path index.ts reads for `origin --version`. Cached; never throws.
let cached: string | null = null;

export function cliVersion(): string {
  if (cached !== null) return cached;
  let v = '0.0.0';
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string') v = pkg.version;
  } catch {
    /* fall back to 0.0.0 */
  }
  cached = v;
  return v;
}
