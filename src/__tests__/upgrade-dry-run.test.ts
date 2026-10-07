// `origin upgrade --dry-run` and `--rollback` must not touch the install.
//
// Both flags were declared in index.ts but upgradeCommand never read them, so
// each fell through to a full upgrade. Observed 2026-09-18 22:31Z: a --dry-run
// replaced the global 0.20260918.1744 with .2155 ("changed 99 packages").
//
// Read-only means: no curl, no `npm install -g`, no watcher restart, no hook
// config rewrite. The only command a dry run may run is `npm root -g`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execSync = vi.fn((cmd: string) => (cmd === 'npm root -g' ? '/usr/lib/node_modules\n' : ''));
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), execSync }));

const restartCodexWatchIfStale = vi.fn(() => ({ restarted: false }));
const restartTranscriptWatchIfStale = vi.fn(() => ({ restarted: false }));
vi.mock('../codex-watch.js', () => ({ restartCodexWatchIfStale }));
vi.mock('../transcript-watch.js', () => ({ restartTranscriptWatchIfStale }));
const hookConfigBases = vi.fn(() => []);
vi.mock('../hook-config-health.js', () => ({ hookConfigBases, checkHookConfigs: vi.fn(() => []), repairHookConfig: vi.fn(), isRepairable: vi.fn() }));

const originalFetch = globalThis.fetch;
let logs: string[] = [];

function serverAdvertises(version: string) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
    version, url: 'https://getorigin.io/cli/origin-cli-latest.tgz', sha256: 'abc123',
  }), { status: 200 })) as unknown as typeof fetch;
}

beforeEach(() => {
  execSync.mockClear();
  restartCodexWatchIfStale.mockClear();
  restartTranscriptWatchIfStale.mockClear();
  hookConfigBases.mockClear();
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  process.exitCode = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const installCalls = () => execSync.mock.calls.map((c) => String(c[0])).filter((c) => c !== 'npm root -g');

describe('origin upgrade --dry-run', () => {
  it('reports what it WOULD install and installs nothing when an update exists', async () => {
    serverAdvertises('9999.1.1');
    const { upgradeCommand } = await import('../commands/upgrade.js');
    await upgradeCommand({ dryRun: true });

    expect(installCalls(), 'a dry run downloaded or installed').toEqual([]);
    const out = logs.join('\n');
    expect(out).toMatch(/Dry run/);
    expect(out).toMatch(/9999\.1\.1/);
    expect(out).toMatch(/origin-cli-latest\.tgz/);
    expect(out).toMatch(/abc123/);
    expect(out).toMatch(/\/usr\/lib\/node_modules/);
  });

  it('does not restart watchers or rewrite hooks when already up to date', async () => {
    const { upgradeCommand, getCurrentVersion } = await import('../commands/upgrade.js');
    serverAdvertises(getCurrentVersion());
    await upgradeCommand({ dryRun: true });

    expect(installCalls()).toEqual([]);
    expect(restartCodexWatchIfStale).not.toHaveBeenCalled();
    expect(restartTranscriptWatchIfStale).not.toHaveBeenCalled();
    expect(hookConfigBases).not.toHaveBeenCalled();
  });

  it('with --force on a downgrade, still only reports', async () => {
    serverAdvertises('0.0.1');
    const { upgradeCommand } = await import('../commands/upgrade.js');
    await upgradeCommand({ dryRun: true, force: true });

    expect(installCalls()).toEqual([]);
    expect(logs.join('\n')).toMatch(/Dry run — would downgrade/);
  });
});

describe('origin upgrade --rollback', () => {
  it('refuses without fetching or installing anything, and exits non-zero', async () => {
    serverAdvertises('9999.1.1');
    const { upgradeCommand } = await import('../commands/upgrade.js');
    await upgradeCommand({ rollback: true });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).toMatch(/not available/);
  });
});
