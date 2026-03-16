import fs from 'fs';
import path from 'path';
import os from 'os';

const CACHE_PATH = path.join(os.homedir(), '.origin', 'last-update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 3000;
const VERSION_URL = 'https://origin-platform.fly.dev/cli/version.json';

interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

interface CacheEntry {
  latest: string;
  checkedAt: string;
}

/**
 * Check if a newer version of the Origin CLI is available.
 * Returns null if the check fails (network error, timeout, etc.).
 *
 * Uses a 24h cache at ~/.origin/last-update-check.json to avoid
 * hitting the server on every invocation.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  try {
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

    // Fetch from Origin server
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(VERSION_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      clearTimeout(timeout);

      if (!res.ok) return null;

      const data = await res.json() as { version?: string };
      const latest = data.version;
      if (!latest) return null;

      writeCache({ latest, checkedAt: new Date().toISOString() });

      return {
        current,
        latest,
        updateAvailable: isNewer(latest, current),
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
  return `\n  Update available: ${result.current} → ${result.latest}\n  Run: origin upgrade\n`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getCurrentVersion(): string | null {
  try {
    const candidates = [
      path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'),
      path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json'),
    ];
    for (const candidate of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (pkg.version) return pkg.version;
      } catch { /* try next */ }
    }
    return '0.1.0';
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
    return null;
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
 * Compare semver strings. Returns true if `a` is newer than `b`.
 */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}
