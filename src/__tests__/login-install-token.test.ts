// `origin login --token <t>` — the one-line installer's login. The token is
// traded once at /api/cli-auth/install-token/exchange for an API key, and from
// there the login is exactly `origin login --key`: whoami check, config and
// profile saved. HOME is isolated per test run (setup/isolate-home.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalFetch = globalThis.fetch;

class Exit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}

type Call = { url: string; init?: RequestInit };
let calls: Call[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as never);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function runLogin(opts: Record<string, unknown>): Promise<number | undefined> {
  const { loginCommand } = await import('../commands/login.js');
  try {
    await loginCommand(opts as any);
  } catch (err) {
    if (err instanceof Exit) return err.code;
    throw err;
  }
  return undefined;
}

describe('origin login --token', () => {
  it('exchanges the token, then verifies and saves the key like --key does', async () => {
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/api/cli-auth/install-token/exchange')) {
        return json(200, { apiKey: 'org_sk_minted', orgId: 'org-1', orgName: 'Acme', apiUrl: 'http://x', keyType: 'team', accountType: 'org', profile: 'acme' });
      }
      if (String(url).endsWith('/api/mcp/whoami')) {
        return json(200, { orgId: 'org-1', orgName: 'Acme', keyType: 'team', accountType: 'org' });
      }
      return json(404, {});
    }) as any;

    const code = await runLogin({ token: 'oit_abc', url: 'http://localhost:4002/' });
    expect(code).toBe(0);

    expect(calls.map((c) => c.url).slice(0, 2)).toEqual([
      'http://localhost:4002/api/cli-auth/install-token/exchange',
      'http://localhost:4002/api/mcp/whoami',
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ token: 'oit_abc' });
    expect((calls[1].init?.headers as Record<string, string>)['X-API-Key']).toBe('org_sk_minted');

    const { loadConfig, listProfiles } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg?.apiKey).toBe('org_sk_minted');
    expect(cfg?.apiUrl).toBe('http://localhost:4002');
    expect(cfg?.orgId).toBe('org-1');
    // The profile the dashboard minted the token with (an invited member's
    // team) is used when --profile is not given.
    expect(listProfiles().find((p) => p.name === 'acme')?.apiKey).toBe('org_sk_minted');
  });

  it('exits 1 with the server message when the token is spent, and never calls whoami', async () => {
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      return json(410, { error: 'Install token is invalid, expired or already used.' });
    }) as any;

    const code = await runLogin({ token: 'oit_spent', url: 'http://localhost:4002' });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    const printed = (console.log as any).mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(printed).toContain('already used');
  });
});
