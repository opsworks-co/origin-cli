/**
 * Org policies for the commit hooks, cached on disk.
 *
 * pre-commit / commit-msg enforce the org's policies locally, and used to ask
 * the server for them on EVERY `git commit` with the default 8s fetch timeout.
 * On a slow (CPU-starved) server that put up to 8s inside every commit, for a
 * list that changes a few times a month.
 *
 * Now: a cached list younger than POLICY_CACHE_TTL_MS is served without a
 * network call. An older one is refreshed with a short timeout, and if the
 * refresh fails or times out the last-known list is used — a slow server
 * degrades to "the policies from a few minutes ago", never to "no policies".
 * With no cache at all the behaviour is unchanged: the default timeout, and
 * the error propagates (the caller skips policy checks, as before).
 *
 * Keyed by API URL + a hash of the API key, because the server scopes the list
 * to the key's org: switching profile or server must not serve another org's
 * policies. The key itself never lands on disk.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { request } from './api.js';
import { loadConfig, writeSecret } from './config.js';
import { debugLog } from './debug-log.js';

export const POLICY_CACHE_TTL_MS = 5 * 60_000;
export const POLICY_REFRESH_TIMEOUT_MS = 2_000;

interface CachedPolicies { fetchedAt: number; policies: unknown[] }

export function policyCachePath(): string {
  return path.join(os.homedir(), '.origin', 'policy-cache.json');
}

function cacheKey(): string | null {
  const config = loadConfig();
  if (!config?.apiUrl || !config.apiKey) return null;
  return crypto.createHash('sha256').update(`${config.apiUrl}\0${config.apiKey}`).digest('hex').slice(0, 32);
}

function readCache(): Record<string, CachedPolicies> {
  try {
    const c = JSON.parse(fs.readFileSync(policyCachePath(), 'utf-8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

function readEntry(key: string): CachedPolicies | null {
  const v = readCache()[key];
  return v && typeof v.fetchedAt === 'number' && Array.isArray(v.policies) ? v : null;
}

function writeEntry(key: string, entry: CachedPolicies): void {
  // One entry per profile/server; the file is tiny, so keep only this one
  // rather than accumulating keys from old profiles.
  try {
    const file = policyCachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeSecret(file, JSON.stringify({ [key]: entry }));
  } catch { /* a cache that can't be written only costs a refetch */ }
}

export async function getPoliciesCached(now: number = Date.now()): Promise<unknown[]> {
  const key = cacheKey();
  const cached = key ? readEntry(key) : null;
  if (cached && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < POLICY_CACHE_TTL_MS) {
    return cached.policies;
  }
  try {
    const policies = await request('/api/mcp/policies', {}, cached ? POLICY_REFRESH_TIMEOUT_MS : undefined);
    if (key && Array.isArray(policies)) writeEntry(key, { fetchedAt: now, policies });
    return policies as unknown[];
  } catch (err: any) {
    if (!cached) throw err;
    debugLog('policy-cache', 'refresh failed — using last-known policies', {
      message: err?.message,
      ageMs: now - cached.fetchedAt,
    });
    return cached.policies;
  }
}
