import { describe, it, expect, vi, afterEach } from 'vitest';
import zlib from 'zlib';
import { fetchWithTimeout, GZIP_BODY_MIN_BYTES } from '../fetch-timeout.js';

describe('fetchWithTimeout', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it('aborts a hung request after the timeout (turns a hang into a fast reject)', async () => {
    // A server that never responds but honours the AbortSignal — the case that
    // otherwise hangs a hook past the agent's 10s budget.
    global.fetch = vi.fn((_url: any, opts: any) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e: any = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    })) as any;
    await expect(fetchWithTimeout('http://x', {}, 30)).rejects.toThrow(/abort/i);
  });

  it('returns the response on success', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200 } as any)) as any;
    const res = await fetchWithTimeout('http://x', {}, 1000);
    expect(res.status).toBe(200);
  });

  it('passes a caller-supplied signal through unchanged (no second controller)', async () => {
    let seenSignal: unknown = 'unset';
    global.fetch = vi.fn(async (_url: any, opts: any) => { seenSignal = opts.signal; return { ok: true } as any; }) as any;
    const ctrl = new AbortController();
    await fetchWithTimeout('http://x', { signal: ctrl.signal }, 10);
    expect(seenSignal).toBe(ctrl.signal);
  });

  it('gzips a large body and says so, so a session PATCH fits inside the hook budget', async () => {
    let seen: any;
    global.fetch = vi.fn(async (_url: any, opts: any) => { seen = opts; return { ok: true } as any; }) as any;
    const json = JSON.stringify({ promptChanges: [{ diff: '+line\n'.repeat(GZIP_BODY_MIN_BYTES) }] });
    await fetchWithTimeout('http://x', { method: 'PATCH', body: json, headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' } }, 1000);
    const headers = new Headers(seen.headers);
    expect(headers.get('content-encoding')).toBe('gzip');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-api-key')).toBe('k');
    expect(seen.body.length).toBeLessThan(json.length / 4);
    expect(zlib.gunzipSync(seen.body).toString('utf8')).toBe(json);
  });

  it('leaves a small body plain', async () => {
    let seen: any;
    global.fetch = vi.fn(async (_url: any, opts: any) => { seen = opts; return { ok: true } as any; }) as any;
    const headers = { 'Content-Type': 'application/json' };
    await fetchWithTimeout('http://x', { method: 'POST', body: '{"a":1}', headers }, 1000);
    expect(seen.body).toBe('{"a":1}');
    expect(seen.headers).toBe(headers);
  });
});
