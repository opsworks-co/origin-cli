/**
 * Memory notes that were written reach the remote.
 *
 * The note was written in many places but pushed in a few, and a failed push
 * was never retried: a clone of rhodecode-new.com sat three note commits ahead
 * of GitHub for days (2026-10-07 → 10-13), one of them a TODO closed by hand,
 * so the dashboard kept that issue open. Every write now leaves an
 * "unpublished" marker that only a push that landed clears, and starts a
 * publisher (here run in-process).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordManualTodos } from '../memory.js';
import {
  clearUnpublishedMemory, hasUnpublishedMemory, memoryAheadOfFetched, publishMemoryAction, takePublishLock, unpublishedMarkerPath,
} from '../memory-publish-queue.js';

let root: string, remote: string, repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
const remoteNote = () => { try { return git(remote, 'rev-parse', 'refs/notes/origin-memory'); } catch { return null; } };
const write = (text: string) => recordManualTodos(repo, [{ key: text.toLowerCase(), id: text.slice(0, 8), text, at: new Date().toISOString() } as any]);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mem-publish-')));
  remote = path.join(root, 'remote.git');
  repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, repo], { stdio: 'pipe' });
  for (const [k, v] of [['user.email', 't@e.st'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(repo, '.git', 'no-hooks')]]) git(repo, 'config', k, v);
  // Memory leaves the machine only with the prompt opt-in (OR-48).
  fs.writeFileSync(path.join(repo, '.origin.json'), JSON.stringify({ notesIncludePrompts: true }));
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\n.origin.json\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('memory notes reach the remote', () => {
  it('a write leaves the marker; the publisher pushes the note and clears it', async () => {
    write('the wording decision is still open');
    expect(hasUnpublishedMemory(repo)).toBe(true);
    expect(remoteNote()).toBeNull();
    await publishMemoryAction(repo, { debounceMs: 0 });
    expect(remoteNote()).toBe(git(repo, 'rev-parse', 'refs/notes/origin-memory'));
    expect(hasUnpublishedMemory(repo)).toBe(false);
  });

  it('a push that fails keeps the marker, and the next publish delivers', async () => {
    write('first');
    git(repo, 'remote', 'set-url', 'origin', path.join(root, 'nowhere.git'));
    await publishMemoryAction(repo, { debounceMs: 0 });
    expect(hasUnpublishedMemory(repo)).toBe(true);
    git(repo, 'remote', 'set-url', 'origin', remote);
    await publishMemoryAction(repo, { debounceMs: 0 });
    expect(hasUnpublishedMemory(repo)).toBe(false);
    expect(remoteNote()).toBe(git(repo, 'rev-parse', 'refs/notes/origin-memory'));
  });

  it('memory written during a push stays marked: it is not in what was pushed', () => {
    write('one');
    const pushStarted = Date.now() - 10_000;
    clearUnpublishedMemory(repo, pushStarted);
    expect(hasUnpublishedMemory(repo)).toBe(true);
    clearUnpublishedMemory(repo, Date.now() + 1000);
    expect(hasUnpublishedMemory(repo)).toBe(false);
  });

  it('a remote that moved is reconciled, not refused', async () => {
    write('mine');
    // Another machine published first.
    const other = path.join(root, 'other');
    execFileSync('git', ['clone', '-q', remote, other], { stdio: 'pipe' });
    for (const [k, v] of [['user.email', 'o@e.st'], ['user.name', 'O'], ['core.hooksPath', path.join(other, '.git', 'no-hooks')]]) git(other, 'config', k, v);
    fs.writeFileSync(path.join(other, '.origin.json'), JSON.stringify({ notesIncludePrompts: true }));
    recordManualTodos(other, [{ key: 'theirs', id: 'theirs00', text: 'theirs', at: new Date().toISOString() } as any]);
    git(other, 'push', '-q', 'origin', 'refs/notes/origin-memory');
    await publishMemoryAction(repo, { debounceMs: 0 });
    expect(hasUnpublishedMemory(repo)).toBe(false);
    const onRemote = git(remote, 'notes', '--ref=origin-memory', 'show', git(remote, 'rev-list', '--max-parents=0', 'main'));
    expect(onRemote).toContain('mine');
    expect(onRemote).toContain('theirs');
  });

  it('notes ahead of what was last fetched are found without a marker (written by an older CLI)', () => {
    write('old');
    fs.rmSync(unpublishedMarkerPath(repo)!);
    expect(memoryAheadOfFetched(repo)).toBe(false); // never fetched: nothing to compare
    git(repo, 'update-ref', 'refs/notes/origin-memory-remote', git(repo, 'rev-parse', 'refs/notes/origin-memory'));
    expect(memoryAheadOfFetched(repo)).toBe(false);
    write('newer');
    expect(memoryAheadOfFetched(repo)).toBe(true);
  });

  it('one publisher per repo at a time', () => {
    const release = takePublishLock(repo);
    expect(release).toBeTruthy();
    expect(takePublishLock(repo)).toBeNull();
    release!();
    const again = takePublishLock(repo);
    expect(again).toBeTruthy();
    again!();
  });
});
