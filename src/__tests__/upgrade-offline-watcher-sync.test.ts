// Restarting the capture daemons must not depend on the network.
//
// `origin upgrade` checks the server for the latest version, and on failure
// printed "Could not check for updates" and returned — before reaching
// syncWatchersToInstalledCode(), which merely compares each running daemon's
// build to the installed one and respawns it. That is a purely local operation.
//
// Observed on a working machine: two consecutive upgrade runs failed with
// "(fetch error: fetch failed)" and left both watchers capturing on a stale
// build, with no supported way to cycle them — the restart helpers had to be
// called by hand. On a genuinely offline machine the daemons could never be
// cycled at all, which is precisely where stale capture code hurts most.
//
// --check stays read-only: it reports, it does not restart anything.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const restartCodexWatchIfStale = vi.fn(() => ({ restarted: true, reason: 'older-build' }));
const restartTranscriptWatchIfStale = vi.fn(() => ({ restarted: true, reason: 'older-build' }));

vi.mock('../codex-watch.js', () => ({ restartCodexWatchIfStale }));
vi.mock('../transcript-watch.js', () => ({ restartTranscriptWatchIfStale }));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  restartCodexWatchIfStale.mockClear();
  restartTranscriptWatchIfStale.mockClear();
  // The outage: every version lookup fails, exactly as it did live.
  globalThis.fetch = vi.fn(() => Promise.reject(new Error('fetch failed'))) as unknown as typeof fetch;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('origin upgrade with no network', () => {
  it('still cycles both watchers when the version check fails', async () => {
    const { upgradeCommand } = await import('../commands/upgrade.js');
    await upgradeCommand({});

    expect(restartCodexWatchIfStale).toHaveBeenCalledTimes(1);
    expect(restartTranscriptWatchIfStale).toHaveBeenCalledTimes(1);
  });

  it('leaves the daemons alone under --check', async () => {
    // --check is a question, not an action. It must not respawn anything.
    const { upgradeCommand } = await import('../commands/upgrade.js');
    await upgradeCommand({ check: true });

    expect(restartCodexWatchIfStale).not.toHaveBeenCalled();
    expect(restartTranscriptWatchIfStale).not.toHaveBeenCalled();
  });

  it('does not throw when the watcher modules themselves fail to load', async () => {
    // Daemon cycling is best-effort: a broken watcher import must not take the
    // upgrade command down with it.
    restartTranscriptWatchIfStale.mockImplementationOnce(() => { throw new Error('boom'); });
    const { upgradeCommand } = await import('../commands/upgrade.js');

    await expect(upgradeCommand({})).resolves.not.toThrow();
  });
});
