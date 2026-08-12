/**
 * Integration test for syncNotesFromRemote against real git repos: a
 * fresh clone has no refs/notes/* (git clone doesn't fetch them), so a
 * teammate cloning an Origin-tracked repo saw no attribution until they
 * manually fetched. The sync must (1) bring the notes down immediately,
 * (2) install a persistent fetch refspec so plain `git fetch` keeps them
 * current, and (3) never clobber local notes the clone wrote itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { syncNotesFromRemote, syncNotesFromRemoteThrottled, syncNotesForSessionStart, NOTES_SYNC_BACKOFF_MS, SESSION_START_SYNC_TIMEOUT_MS, ORIGIN_NOTES_GLOB_REFSPEC } from '../git-notes.js';

let tmpRoot: string;
let upstream: string;
let author: string;
let clone: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

// Neutralize globally-installed git hooks (core.hooksPath → Origin's real
// hooks) for every git invocation in this suite — same pattern as
// worktree-session-linking. Without this, the user's own post-commit hook
// annotates our test commits before the test does.
function muteHooks(dir: string) {
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-notes-sync-'));
  upstream = path.join(tmpRoot, 'upstream.git');
  author = path.join(tmpRoot, 'author');
  clone = path.join(tmpRoot, 'clone');

  execFileSync('git', ['init', '--bare', upstream], { stdio: 'pipe' });
  execFileSync('git', ['clone', upstream, author], { stdio: 'pipe' });
  muteHooks(author);
  git(author, 'config', 'user.email', 'a@test.dev');
  git(author, 'config', 'user.name', 'Author');
  fs.writeFileSync(path.join(author, 'file.txt'), 'hello\n');
  git(author, 'add', '.');
  git(author, 'commit', '-m', 'initial');
  git(author, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"version":1,"sessionId":"s1","model":"claude-fable-5"}}', 'HEAD');
  git(author, 'push', 'origin', 'HEAD:main', 'refs/notes/origin:refs/notes/origin');

  execFileSync('git', ['clone', upstream, clone], { stdio: 'pipe' });
  muteHooks(clone);
  git(clone, 'config', 'user.email', 'b@test.dev');
  git(clone, 'config', 'user.name', 'Cloner');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('syncNotesFromRemote', () => {
  it('a fresh clone has no notes until synced; sync brings them down', () => {
    expect(() => git(clone, 'notes', '--ref=origin', 'show', 'HEAD')).toThrow();
    expect(syncNotesFromRemote(clone)).toBe(true);
    const note = git(clone, 'notes', '--ref=origin', 'show', 'HEAD');
    expect(note).toContain('claude-fable-5');
  });

  it('installs the fetch refspec so plain git fetch keeps notes current', () => {
    syncNotesFromRemote(clone);
    const refspecs = git(clone, 'config', '--get-all', 'remote.origin.fetch');
    expect(refspecs).toContain(ORIGIN_NOTES_GLOB_REFSPEC);

    // Author annotates a new commit; the clone's ORDINARY fetch now
    // carries it — no Origin command involved.
    fs.writeFileSync(path.join(author, 'file2.txt'), 'more\n');
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'second');
    git(author, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"version":1,"sessionId":"s2","model":"gpt-5.5"}}', 'HEAD');
    git(author, 'push', 'origin', 'HEAD:main', '+refs/notes/origin:refs/notes/origin');

    git(clone, 'fetch', 'origin');
    expect(git(clone, 'rev-parse', '--verify', 'refs/notes/origin-remote')).toBeTruthy();
    // Folding into local notes happens on the next sync (e.g. next
    // `origin blame` run).
    syncNotesFromRemote(clone);
    const sha2 = git(clone, 'rev-parse', 'origin/main');
    expect(git(clone, 'notes', '--ref=origin', 'show', sha2)).toContain('gpt-5.5');
  });

  it('keeps local notes authoritative for commits the clone annotated itself', () => {
    syncNotesFromRemote(clone);
    const head = git(clone, 'rev-parse', 'HEAD');
    git(clone, 'notes', '--ref=origin', 'add', '-f', '-m', '{"origin":{"version":1,"sessionId":"local","model":"local-model"}}', head);
    expect(syncNotesFromRemote(clone)).toBe(false);
    expect(git(clone, 'notes', '--ref=origin', 'show', head)).toContain('local-model');
  });

  it('is a quiet no-op when the upstream has no notes', () => {
    const bare2 = path.join(tmpRoot, 'empty.git');
    const clone2 = path.join(tmpRoot, 'clone2');
    execFileSync('git', ['init', '--bare', bare2], { stdio: 'pipe' });
    execFileSync('git', ['clone', bare2, clone2], { stdio: 'pipe' });
    muteHooks(clone2);
    expect(syncNotesFromRemote(clone2)).toBe(false);
  });

  it('is a quiet no-op without any remote', () => {
    const lonely = path.join(tmpRoot, 'lonely');
    execFileSync('git', ['init', lonely], { stdio: 'pipe' });
    muteHooks(lonely);
    expect(syncNotesFromRemote(lonely)).toBe(false);
  });
});

// The SessionStart wrapper: syncs once per repo per backoff window so the
// hot path isn't a `git fetch` on every agent launch. HOME is redirected
// into the temp dir so the per-repo stamp never touches the real ~/.origin.
describe('syncNotesFromRemoteThrottled', () => {
  const realHome = process.env.HOME;
  beforeEach(() => { process.env.HOME = tmpRoot; });
  afterEach(() => { process.env.HOME = realHome; });

  it('fetches on the first call, then throttles within the window', () => {
    // Fresh clone: no local notes yet.
    expect(() => git(clone, 'notes', '--ref=origin', 'show', 'HEAD')).toThrow();

    // First call runs the sync and brings the upstream note down.
    expect(syncNotesFromRemoteThrottled(clone)).toBe(true);
    expect(git(clone, 'notes', '--ref=origin', 'show', 'HEAD')).toContain('claude-fable-5');

    // A stamp was written under the redirected HOME.
    const stampDir = path.join(tmpRoot, '.origin', 'notes-sync');
    expect(fs.readdirSync(stampDir).length).toBeGreaterThan(0);

    // Second call within the backoff window is a no-op (throttled).
    expect(syncNotesFromRemoteThrottled(clone)).toBe(false);
  });

  it('re-syncs once the window has elapsed', () => {
    // The window is what makes "fresh at session start" mean anything. At the
    // old 6h an agent launched 5h59m later started on stale memory with no way
    // to know; the guarantee is only as good as this backoff.
    expect(syncNotesFromRemoteThrottled(clone)).toBe(true);
    expect(syncNotesFromRemoteThrottled(clone)).toBe(false);

    // Age the stamp past the window.
    const stampDir = path.join(tmpRoot, '.origin', 'notes-sync');
    const stamp = path.join(stampDir, fs.readdirSync(stampDir)[0]);
    const past = Date.now() - (NOTES_SYNC_BACKOFF_MS + 60_000);
    fs.utimesSync(stamp, new Date(past), new Date(past));

    expect(syncNotesFromRemoteThrottled(clone)).toBe(true);
  });

  it('still throttles just INSIDE the window', () => {
    expect(syncNotesFromRemoteThrottled(clone)).toBe(true);
    const stampDir = path.join(tmpRoot, '.origin', 'notes-sync');
    const stamp = path.join(stampDir, fs.readdirSync(stampDir)[0]);
    const justInside = Date.now() - (NOTES_SYNC_BACKOFF_MS - 60_000);
    fs.utimesSync(stamp, new Date(justInside), new Date(justInside));

    expect(syncNotesFromRemoteThrottled(clone)).toBe(false);
  });

  it('a fleet launching at once produces ONE fetch, not N', () => {
    // The stamp is written BEFORE the fetch precisely so this holds — it is
    // what makes the shorter window safe.
    const results = Array.from({ length: 16 }, () => syncNotesFromRemoteThrottled(clone));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('syncNotesForSessionStart shares the throttle but caps network time', () => {
    // Session start runs this SYNCHRONOUSLY in front of a user waiting for
    // their agent, so its ceiling has to be tighter than the 15s default.
    expect(SESSION_START_SYNC_TIMEOUT_MS).toBeLessThan(15_000);
    expect(syncNotesForSessionStart(clone)).toBe(true);
    expect(syncNotesForSessionStart(clone)).toBe(false); // same stamp, same window
  });
});
