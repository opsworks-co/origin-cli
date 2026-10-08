// `origin upgrade` must never put the server-supplied tarball URL into a shell.
//
// The URL was only prefix-checked (`startsWith('https://getorigin.io/')`) and
// then run as `curl "${url}" ...` through execSync, so a server answering
// `https://getorigin.io/$(cmd)` ran `cmd` on the user's machine BEFORE the
// SHA-256 check could reject the download.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execSync = vi.fn((cmd: string) => (cmd === 'npm root -g' ? '/usr/lib/node_modules\n' : ''));
const execFileSync = vi.fn((_file: string, _args?: readonly string[]) => { throw new Error('download failed (test)'); });
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), execSync, execFileSync }));

const originalFetch = globalThis.fetch;
const HOSTILE = 'https://getorigin.io/$(touch /tmp/origin-pwned)';

beforeEach(() => {
  execSync.mockClear();
  execFileSync.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('trustedDownloadUrl', () => {
  it('accepts the getorigin.io https tarball URL', async () => {
    const { trustedDownloadUrl } = await import('../commands/upgrade.js');
    expect(trustedDownloadUrl('https://getorigin.io/cli/origin-cli-latest.tgz')).toBe('https://getorigin.io/cli/origin-cli-latest.tgz');
  });

  it.each([
    ['http, not https', 'http://getorigin.io/cli/x.tgz'],
    ['another host', 'https://evil.example/cli/x.tgz'],
    ['a look-alike host', 'https://getorigin.io.evil.example/x.tgz'],
    ['credentials before the host', 'https://getorigin.io@evil.example/x.tgz'],
    ['a non-default port', 'https://getorigin.io:8443/x.tgz'],
    ['not a URL', 'getorigin.io/x.tgz'],
    ['not a string', 42],
  ])('rejects %s', async (_label, raw) => {
    const { trustedDownloadUrl } = await import('../commands/upgrade.js');
    expect(trustedDownloadUrl(raw)).toBeNull();
  });
});

describe('origin upgrade download', () => {
  it('passes a hostile server URL to curl as one argv entry, never through a shell', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      version: '9999.1.1', url: HOSTILE, sha256: 'abc123',
    }), { status: 200 })) as unknown as typeof fetch;

    const { upgradeCommand } = await import('../commands/upgrade.js');
    await upgradeCommand({});

    const shellCalls = execSync.mock.calls.map((c) => String(c[0]));
    expect(shellCalls.filter((c) => c.includes('getorigin.io') || c.includes('curl'))).toEqual([]);

    const curl = execFileSync.mock.calls.find((c) => c[0] === 'curl');
    expect(curl, 'curl was not run via execFileSync').toBeDefined();
    const args = curl![1] as string[];
    expect(args.some((a) => a.startsWith('https://getorigin.io/$(touch'))).toBe(true);
  });
});
