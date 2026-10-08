// Commit-hook policy cache (policy-cache.ts): a fresh cache skips the network,
// a stale one refreshes with a short timeout and falls back to the last-known
// list, and no cache keeps the old behaviour (default timeout, error thrown).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const request = vi.fn();
let config: { apiUrl: string; apiKey: string } | null = { apiUrl: 'https://origin.test', apiKey: 'key-a' };
vi.mock('../api.js', () => ({ request: (...args: unknown[]) => request(...args) }));
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), loadConfig: () => config }));

const { getPoliciesCached, policyCachePath, POLICY_CACHE_TTL_MS, POLICY_REFRESH_TIMEOUT_MS } = await import('../policy-cache.js');

const P1 = [{ id: 'p1', name: 'No env', type: 'FILE_RESTRICTION', rules: [] }];
const P2 = [{ id: 'p2', name: 'Msg', type: 'COMMIT_MESSAGE', rules: [] }];
const T0 = 1_800_000_000_000;

beforeEach(() => {
  request.mockReset();
  config = { apiUrl: 'https://origin.test', apiKey: 'key-a' };
  try { fs.rmSync(policyCachePath()); } catch { /* none */ }
});

describe('getPoliciesCached', () => {
  it('no cache: fetches with the default timeout and caches the result', async () => {
    request.mockResolvedValueOnce(P1);
    expect(await getPoliciesCached(T0)).toEqual(P1);
    expect(request).toHaveBeenCalledWith('/api/mcp/policies', {}, undefined);
    expect(fs.readFileSync(policyCachePath(), 'utf-8')).not.toContain('key-a');
  });

  it('no cache + unreachable server: the error propagates (caller skips checks, as before)', async () => {
    request.mockRejectedValueOnce(new Error('This operation was aborted'));
    await expect(getPoliciesCached(T0)).rejects.toThrow('aborted');
  });

  it('fresh cache: served with no network call', async () => {
    request.mockResolvedValueOnce(P1);
    await getPoliciesCached(T0);
    request.mockClear();
    expect(await getPoliciesCached(T0 + POLICY_CACHE_TTL_MS - 1)).toEqual(P1);
    expect(request).not.toHaveBeenCalled();
  });

  it('stale cache: refreshes with the short timeout and stores the new list', async () => {
    request.mockResolvedValueOnce(P1);
    await getPoliciesCached(T0);
    request.mockResolvedValueOnce(P2);
    expect(await getPoliciesCached(T0 + POLICY_CACHE_TTL_MS)).toEqual(P2);
    expect(request).toHaveBeenLastCalledWith('/api/mcp/policies', {}, POLICY_REFRESH_TIMEOUT_MS);
    request.mockClear();
    expect(await getPoliciesCached(T0 + POLICY_CACHE_TTL_MS + 1)).toEqual(P2);
    expect(request).not.toHaveBeenCalled();
  });

  it('stale cache + failed refresh: falls back to the last-known policies, never to none', async () => {
    request.mockResolvedValueOnce(P1);
    await getPoliciesCached(T0);
    request.mockRejectedValueOnce(new Error('This operation was aborted'));
    expect(await getPoliciesCached(T0 + 60 * 60_000)).toEqual(P1);
  });

  it('a different API key (another org/profile) does not reuse the cache', async () => {
    request.mockResolvedValueOnce(P1);
    await getPoliciesCached(T0);
    config = { apiUrl: 'https://origin.test', apiKey: 'key-b' };
    request.mockResolvedValueOnce(P2);
    expect(await getPoliciesCached(T0 + 1)).toEqual(P2);
    expect(request).toHaveBeenLastCalledWith('/api/mcp/policies', {}, undefined);
  });
});
