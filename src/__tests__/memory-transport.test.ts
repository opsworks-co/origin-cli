/**
 * Memory reaches the dashboard by two steps the CLI has to take itself: push
 * the notes ref, then tell the server it moved — no host sends a webhook for
 * refs/notes/*. These tests pin the contract of the module every memory writer
 * goes through (session end, brief refresh, pre-push, `origin sync`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { refreshRepoMemory, pushMemoryNotes, connected, memoryOn } = vi.hoisted(() => ({
  refreshRepoMemory: vi.fn(),
  pushMemoryNotes: vi.fn(),
  connected: { value: true },
  memoryOn: { value: true },
}));

vi.mock('../api.js', () => ({
  api: { refreshRepoMemory: (...a: any[]) => refreshRepoMemory(...a) },
}));
vi.mock('../config.js', () => ({
  isConnectedMode: () => connected.value,
}));
vi.mock('../git-notes.js', () => ({
  pushMemoryNotes: (...a: any[]) => pushMemoryNotes(...a),
  resolvePushRemote: () => 'origin',
  shouldPushMemory: () => memoryOn.value,
}));

import { publishMemoryNotes, notifyRepoMemoryChanged, remoteUrlFor, MEMORY_REFRESH_TIMEOUT_MS } from '../memory-transport.js';

let repo: string;

beforeEach(() => {
  refreshRepoMemory.mockReset();
  pushMemoryNotes.mockReset();
  pushMemoryNotes.mockReturnValue(true); // the push landed
  connected.value = true;
  memoryOn.value = true;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mem-transport-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
});

describe('publishMemoryNotes', () => {
  it('pushes the memory refs, then asks the server to re-read them with the remote URL', async () => {
    refreshRepoMemory.mockResolvedValue({ memory: { sessions: 3, commits: 9, brief: true } });

    expect(await publishMemoryNotes(repo, 'test')).toEqual({ pushed: true, memory: { sessions: 3, commits: 9, brief: true }, outcome: 'pushed' });

    expect(pushMemoryNotes).toHaveBeenCalledWith(repo, 'origin', expect.any(Object));
    expect(refreshRepoMemory).toHaveBeenCalledTimes(1);
    const [body, timeout] = refreshRepoMemory.mock.calls[0];
    expect(body).toEqual({ repoPath: repo, repoUrl: 'https://github.com/acme/widgets.git' });
    expect(timeout).toBe(MEMORY_REFRESH_TIMEOUT_MS);
    // Push strictly before notify — the server reads the host, so telling it
    // first would have it import the previous state.
    expect(pushMemoryNotes.mock.invocationCallOrder[0]).toBeLessThan(refreshRepoMemory.mock.invocationCallOrder[0]);
  });

  it('a push that did not land is not published: the server is not told, the write stays marked', async () => {
    pushMemoryNotes.mockImplementation((_r: string, _remote: string, report: any) => { report.localRefs = 1; report.error = 'remote: notes refs are not allowed here'; return false; });
    expect(await publishMemoryNotes(repo, 'test')).toEqual({ pushed: false, memory: null, outcome: 'failed', error: 'remote: notes refs are not allowed here' });
    expect(refreshRepoMemory).not.toHaveBeenCalled();
  });

  it('does nothing when memory push is turned off — nothing left the machine, so nothing to re-read', async () => {
    memoryOn.value = false;
    expect(await publishMemoryNotes(repo, 'test')).toEqual({ pushed: false, memory: null, outcome: 'opted-out' });
    expect(pushMemoryNotes).not.toHaveBeenCalled();
    expect(refreshRepoMemory).not.toHaveBeenCalled();
  });

  it('still counts as published in standalone mode, without calling the server', async () => {
    connected.value = false;
    expect(await publishMemoryNotes(repo, 'test')).toEqual({ pushed: true, memory: null, outcome: 'pushed' });
    expect(pushMemoryNotes).toHaveBeenCalledTimes(1);
    expect(refreshRepoMemory).not.toHaveBeenCalled();
  });

  it('swallows a failed push and does not notify about a state the host never got', async () => {
    pushMemoryNotes.mockImplementation(() => { throw new Error('remote rejected'); });
    expect(await publishMemoryNotes(repo, 'test')).toEqual({ pushed: false, memory: null, outcome: 'failed', error: 'remote rejected' });
    expect(refreshRepoMemory).not.toHaveBeenCalled();
  });

  it('a clone with no memory of its own is "nothing-local", still published, and still asks the server', async () => {
    pushMemoryNotes.mockImplementation((_r: string, _remote: string, report: any) => { report.localRefs = 0; return true; });
    refreshRepoMemory.mockResolvedValue({ memory: null });
    expect(await publishMemoryNotes(repo, 'test')).toEqual({ pushed: true, memory: null, outcome: 'nothing-local' });
    expect(refreshRepoMemory).toHaveBeenCalledTimes(1);
  });
});

describe('notifyRepoMemoryChanged', () => {
  it('returns what the server imported', async () => {
    refreshRepoMemory.mockResolvedValue({ memory: { sessions: 1, commits: 2, brief: false } });
    expect(await notifyRepoMemoryChanged(repo, 'test')).toEqual({ sessions: 1, commits: 2, brief: false });
  });

  it('never throws — an unreachable server is a null, not a failed hook', async () => {
    refreshRepoMemory.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await notifyRepoMemoryChanged(repo, 'test')).toBeNull();
  });

  it('honours a caller-supplied timeout budget', async () => {
    refreshRepoMemory.mockResolvedValue({ memory: null });
    await notifyRepoMemoryChanged(repo, 'test', { timeoutMs: 1234 });
    expect(refreshRepoMemory.mock.calls[0][1]).toBe(1234);
  });
});

describe('remoteUrlFor', () => {
  it('reads the remote URL, and is undefined for a remote that does not exist', () => {
    expect(remoteUrlFor(repo, 'origin')).toBe('https://github.com/acme/widgets.git');
    expect(remoteUrlFor(repo, 'upstream')).toBeUndefined();
  });
});
