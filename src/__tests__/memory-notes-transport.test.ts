/**
 * Integration test for memory-note transport against real git repos.
 *
 * The bug: refs/notes/origin-memory had NO push path and NO fetch refspec
 * anywhere in the CLI. Every notes push targeted refs/notes/origin only
 * (git-notes.ts session-end push, the pre-push hook, scrub-notes), and
 * NOTES_FETCH_REFSPEC staged only refs/notes/origin. So memory never left the
 * machine that wrote it — a teammate's clone, or the same developer's second
 * machine, started with an empty payload — even though DOCS.md promised
 * "memory ... travels with the repo when pushed".
 *
 * These tests drive two clones through a real bare remote, which is the only
 * way to catch the interesting failure: the payload is ONE note on ONE object
 * (the root commit), so both clones collide there and a naive `git notes
 * merge -s ours` would silently drop the other clone's sessions entirely.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { forgetCommitMemory } from '../memory.js';
import {
  syncNotesFromRemote,
  pushMemoryNotes,
  foldStagedNotes,
  MEMORY_NOTES_FETCH_REFSPECS,
  NOTES_FETCH_REFSPEC,
  ORIGIN_NOTES_GLOB_REFSPEC,
} from '../git-notes.js';

let tmpRoot: string;
let upstream: string;
let alice: string;
let bob: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

// Neutralize the developer's globally-installed Origin hooks so they don't
// annotate these fixture commits mid-test.
function muteHooks(dir: string) {
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
}

/** Write a memory payload onto the repo's ROOT commit, the way memory.ts does. */
function writeMemory(repo: string, sessions: any[], commits: any[] = []) {
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
  const payload = JSON.stringify({ version: 2, sessions, commits }, null, 2);
  git(repo, 'notes', '--ref=origin-memory', 'add', '-f', '-m', payload, root);
}

function readMemory(repo: string): { sessions: any[]; commits: any[] } {
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
  return JSON.parse(git(repo, 'notes', '--ref=origin-memory', 'show', root));
}

const session = (id: string, endedAt = '2026-08-01T01:00:00.000Z', extra: any = {}) => ({
  sessionId: id,
  agentSlug: 'claude-code',
  model: 'claude',
  startedAt: '2026-08-01T00:00:00.000Z',
  endedAt,
  branch: 'main',
  summary: `work ${id}`,
  filesChanged: [`${id}.py`],
  promptCount: 1,
  linesAdded: 10,
  linesRemoved: 0,
  openTodos: [],
  ...extra,
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-memory-transport-'));
  upstream = path.join(tmpRoot, 'upstream.git');
  alice = path.join(tmpRoot, 'alice');
  bob = path.join(tmpRoot, 'bob');

  execFileSync('git', ['init', '--bare', upstream], { stdio: 'pipe' });
  execFileSync('git', ['clone', upstream, alice], { stdio: 'pipe' });
  muteHooks(alice);
  git(alice, 'config', 'user.email', 'alice@test.dev');
  git(alice, 'config', 'user.name', 'Alice');
  fs.writeFileSync(path.join(alice, 'file.txt'), 'hello\n');
  git(alice, 'add', '.');
  git(alice, 'commit', '-m', 'initial');
  git(alice, 'push', 'origin', 'HEAD:main');

  execFileSync('git', ['clone', upstream, bob], { stdio: 'pipe' });
  muteHooks(bob);
  git(bob, 'config', 'user.email', 'bob@test.dev');
  git(bob, 'config', 'user.name', 'Bob');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('memory notes transport', () => {
  it('memory reaches a teammate: push on one clone, sync on the other', () => {
    writeMemory(alice, [session('a1', '2026-08-01T01:00:00.000Z', {
      fileNotes: { 'countdown.py': 'New interactive CLI countdown timer' },
      decisions: ['used curses over ANSI — handles terminal resize'],
    })]);
    pushMemoryNotes(alice, 'origin');

    // Bob has nothing yet — `git clone` never fetches refs/notes/*.
    expect(() => readMemory(bob)).toThrow();

    expect(syncNotesFromRemote(bob)).toBe(true);
    const got = readMemory(bob);
    expect(got.sessions.map((s) => s.sessionId)).toEqual(['a1']);
    // The high-signal fields survive the round trip, not just the ids.
    expect(got.sessions[0].fileNotes['countdown.py']).toBe('New interactive CLI countdown timer');
    expect(got.sessions[0].decisions).toEqual(['used curses over ANSI — handles terminal resize']);
  });

  it('a RETRACTION reaches the teammate, and the record it retracts does not come back', () => {
    // The fold used to read the remote's tombstones and then write only
    // sessions+commits. `writeMemoryPayload` preserves what it is not given, so
    // the merged tombstones were replaced by the local ones (none) — the commit
    // record vanished on this clone with nothing recorded to keep it away, and
    // the next sync from any clone that still had it put it straight back. That
    // is the 74d04c6 loop the tombstones were introduced to break, surviving in
    // the one path that carries them between machines.
    const commit = {
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sessionId: 'a1', agentSlug: 'antigravity', message: 'wrong agent',
      filesChanged: ['x.py'], linesAdded: 1, linesRemoved: 0,
      branch: 'main', committedAt: '2026-08-01T00:30:00.000Z',
    };
    writeMemory(alice, [session('a1')], [commit]);
    pushMemoryNotes(alice, 'origin');
    expect(syncNotesFromRemote(bob)).toBe(true);
    expect(readMemory(bob).commits.map((c) => c.commitSha)).toEqual([commit.commitSha]);

    expect(forgetCommitMemory(alice, commit.commitSha, 'filed under antigravity; Cursor made it')).toBe(true);
    pushMemoryNotes(alice, 'origin');
    syncNotesFromRemote(bob);

    const got = readMemory(bob) as any;
    expect(got.commits).toEqual([]);
    // The retraction has to be PRESENT here, not merely effective: an absence
    // merges as nothing, and the next fold would restore the record.
    expect((got.tombstones || []).map((t: any) => t.commitSha)).toEqual([commit.commitSha]);
    expect(got.tombstones[0].reason).toContain('Cursor made it');
  });

  it('the ref actually lands on the remote', () => {
    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');
    const remoteRefs = git(alice, 'ls-remote', 'origin', 'refs/notes/*');
    expect(remoteRefs).toContain('refs/notes/origin-memory');
  });

  it('concurrent machines keep BOTH sets of sessions (the -s ours trap)', () => {
    // Alice publishes first.
    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');

    // Bob, having synced, records his own session and pushes. His push is a
    // non-fast-forward on the shared root-commit note; the retry path must
    // fold Alice's payload into his rather than replacing it.
    syncNotesFromRemote(bob);
    const bobMem = readMemory(bob);
    writeMemory(bob, [...bobMem.sessions, session('b1', '2026-08-02T01:00:00.000Z')], bobMem.commits);
    pushMemoryNotes(bob, 'origin');

    // Alice pulls back down and must now see both.
    syncNotesFromRemote(alice);
    expect(readMemory(alice).sessions.map((s) => s.sessionId).sort()).toEqual(['a1', 'b1']);
  });

  it('a genuinely divergent push still preserves the other side', () => {
    // Both write WITHOUT syncing first — the real two-laptop case. Bob's push
    // is rejected, and the retry has to union rather than clobber.
    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');
    writeMemory(bob, [session('b1', '2026-08-03T01:00:00.000Z')]);
    pushMemoryNotes(bob, 'origin');

    syncNotesFromRemote(alice);
    expect(readMemory(alice).sessions.map((s) => s.sessionId).sort()).toEqual(['a1', 'b1']);
  });

  it('installs the glob refspec even when the remote has NO notes — and git fetch still works', () => {
    // The invariant this protects: a configured refspec naming a ref the remote
    // doesn't have makes ordinary `git fetch` fail outright ("couldn't find
    // remote ref ..."). Explicit refspecs therefore could not be installed
    // up-front. The glob has no such failure mode, so it goes in unconditionally
    // — including here, where the remote has neither attribution nor memory.
    syncNotesFromRemote(bob);
    const cfg = (() => { try { return git(bob, 'config', '--get-all', 'remote.origin.fetch'); } catch { return ''; } })();
    expect(cfg).toContain(ORIGIN_NOTES_GLOB_REFSPEC);
    // The explicit refspecs remain the thing we must NOT install blind.
    for (const spec of MEMORY_NOTES_FETCH_REFSPECS) expect(cfg).not.toContain(spec);
    expect(cfg).not.toContain(NOTES_FETCH_REFSPEC);
    expect(() => git(bob, 'fetch', '-q', 'origin')).not.toThrow();
  });

  it('a refspec installed BEFORE the remote had memory still carries it later', () => {
    // The chicken-and-egg this release fixes. Bob syncs while the remote is
    // empty (so the old code installed nothing and could only ever install a
    // refspec once one was no longer needed). Alice then pushes memory, and
    // Bob's ORDINARY pull has to carry it with no Origin command in between.
    syncNotesFromRemote(bob);

    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');

    git(bob, 'fetch', '-q', 'origin'); // a plain pull — nothing Origin-aware
    // Fetched into staging; foldStagedNotes is what post-merge runs.
    expect(foldStagedNotes(bob)).toBe(true);
    expect(readMemory(bob).sessions.map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('folds memory the remote gained, and git fetch still works', () => {
    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');
    syncNotesFromRemote(bob);

    const cfg = git(bob, 'config', '--get-all', 'remote.origin.fetch');
    expect(cfg).toContain(ORIGIN_NOTES_GLOB_REFSPEC);
    expect(() => git(bob, 'fetch', '-q', 'origin')).not.toThrow();
    expect(readMemory(bob).sessions.map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('does not push memory when the privacy opt-out is set', () => {
    fs.writeFileSync(path.join(alice, '.origin.json'), JSON.stringify({ notesIncludePrompts: false }));
    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');
    expect(git(alice, 'ls-remote', 'origin', 'refs/notes/*')).not.toContain('origin-memory');
  });

  it('syncs memory even when the remote has no attribution notes at all', () => {
    // Each refspec is fetched independently — a remote missing
    // refs/notes/origin makes git fail that one fetch, and it must not take
    // the memory fetch down with it.
    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');
    expect(git(alice, 'ls-remote', 'origin', 'refs/notes/*')).not.toContain('refs/notes/origin\t');

    expect(syncNotesFromRemote(bob)).toBe(true);
    expect(readMemory(bob).sessions.map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('is a quiet no-op when there is no memory to push', () => {
    expect(() => pushMemoryNotes(alice, 'origin')).not.toThrow();
    expect(git(alice, 'ls-remote', 'origin', 'refs/notes/*')).not.toContain('origin-memory');
  });
});
