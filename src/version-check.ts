import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from './config.js';

const CACHE_PATH = path.join(os.homedir(), '.origin', 'last-update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 3000;
const DEFAULT_API_URL = 'https://getorigin.io';

interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
  downloadUrl?: string;
}

interface CacheEntry {
  latest: string;
  checkedAt: string;
}

/**
 * Check if a newer version of the Origin CLI is available on npm.
 * Returns null if the check fails (network error, timeout, etc.).
 *
 * Uses a 24h cache at ~/.origin/last-update-check.json to avoid
 * hitting the npm registry on every invocation.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  try {
    // Get current version from package.json
    const current = getCurrentVersion();
    if (!current) return null;

    // Check cache first
    const cached = readCache();
    if (cached) {
      return {
        current,
        latest: cached.latest,
        updateAvailable: isNewer(cached.latest, current),
      };
    }

    // Fetch from Origin API (the CLI is distributed as a tarball, not via npm)
    const config = loadConfig();
    const apiUrl = (config?.apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`${apiUrl}/api/v1/cli/version`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      clearTimeout(timeout);

      if (!res.ok) return null;

      const data = await res.json() as { version?: string; downloadUrl?: string };
      const latest = data.version;
      if (!latest) return null;

      // Write cache
      writeCache({ latest, checkedAt: new Date().toISOString() });

      return {
        current,
        latest,
        updateAvailable: isNewer(latest, current),
        downloadUrl: data.downloadUrl,
      };
    } catch {
      clearTimeout(timeout);
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Format a user-facing update banner message.
 */
export function formatUpdateBanner(result: UpdateCheckResult): string {
  if (!result.updateAvailable) return '';
  const url = result.downloadUrl || 'https://getorigin.io/cli/origin-cli-latest.tgz';
  return `\n  Update available: ${result.current} -> ${result.latest}\n  Run: npm install -g ${url}\n     or: origin upgrade\n`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getCurrentVersion(): string | null {
  try {
    // Try reading from package.json relative to this module
    const candidates = [
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, '..', '..', 'package.json'),
    ];
    for (const candidate of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (pkg.version) return pkg.version;
      } catch { /* try next */ }
    }
    return '0.1.0'; // fallback
  } catch {
    return null;
  }
}

function readCache(): CacheEntry | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);
    const age = Date.now() - new Date(entry.checkedAt).getTime();
    if (age < CACHE_TTL_MS) return entry;
    return null; // expired
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    const dir = path.dirname(CACHE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(entry, null, 2));
  } catch { /* best effort */ }
}

/**
 * Order two dotted version strings. Negative if `a` is older than `b`, 0 if
 * equal, positive if `a` is newer.
 *
 * Components are compared NUMERICALLY, never as strings: Origin's patch
 * component is a wall-clock `HHmm`, so `.524` vs `.2043` sorts backwards under
 * string comparison and every early-morning release would look like a
 * downgrade. Missing or unparseable components count as 0, which keeps the
 * `0.0.0` fallback (used when the version can't be read) sorting oldest.
 *
 * Exported because `origin upgrade` needs the same ordering — it used to test
 * only `current === latest` and would happily install an OLDER build over a
 * newer one, reporting it as an upgrade.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => String(v || '').split('.').map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

/**
 * Compare semver strings. Returns true if `a` is newer than `b`.
 */
export function isNewer(a: string, b: string): boolean {
  return compareVersions(a, b) > 0;
}
