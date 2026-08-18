/**
 * Two halves of the same live failure, seen on a fresh clone 2026-08-14: an
 * agent opened a just-cloned repo and reported it had "no access to memory from
 * previous agent sessions" — while refs/notes/origin-remote-memory sat in that
 * repo's .git carrying the entire history.
 *
 *  1. TRANSPORT — the notes had been FETCHED (post-checkout ran) but never
 *     FOLDED onto the live ref. syncNotesForSessionStart delegated to the
 *     throttle, which returns early on a fresh stamp WITHOUT folding, so the
 *     repair could not happen until the backoff window elapsed. post-checkout
 *     stamps before it fetches and does its work backgrounded, so "staged but
 *     not folded, stamp already fresh" is the normal fresh-clone race, not a
 *     corner case.
 *
 *  2. DISCOVERABILITY — even with memory folded and injected, the injected
 *     block is a capped digest and never says where the full store lives. An
 *     agent asked "is there any memory?" checks git log and the rules files,
 *     finds nothing, and answers no.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  syncNotesForSessionStart,
  pushMemoryNotes,
  hasUnfoldedStagedNotes,
  ORIGIN_NOTES_GLOB_REFSPEC,
} from '../git-notes.js';
import { buildMemoryPointerContext, buildMemoryContext } from '../memory.js';
import { assembleRepoContext } from '../context-injection.js';

let tmpRoot: string;
let upstream: string;
let alice: string;
let bob: string;
let home: string;
let realHome: string | undefined;
let realUserProfile: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

function muteHooks(dir: string) {
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
}

function writeMemory(repo: string, sessions: any[], commits: any[] = []) {
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
  const payload = JSON.stringify({ version: 2, sessions, commits }, null, 2);
  git(repo, 'notes', '--ref=origin-memory', 'add', '-f', '-m', payload, root);
}

function refExists(repo: string, ref: string): boolean {
  try {
    git(repo, 'rev-parse', '--verify', '--quiet', ref);
    return true;
  } catch {
    return false;
  }
}

/** The stamp syncNotesFromRemoteThrottled consults, in the isolated HOME. */
function stampPath(repoPath: string): string {
  const key = crypto.createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.origin', 'notes-sync', `${key}.stamp`);
}

const session = (id: string, extra: any = {}) => ({
  sessionId: id,
  agentSlug: 'cursor',
  model: 'cursor-grok-4.5-high-fast',
  startedAt: '2026-08-14T13:53:29.682Z',
  endedAt: '2026-08-14T13:55:14.246Z',
  branch: 'main',
  summary: `work ${id}`,
  filesChanged: [`${id}.sh`],
  promptCount: 4,
  linesAdded: 351,
  linesRemoved: 16,
  openTodos: [],
  ...extra,
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-memory-pointer-'));
  home = path.join(tmpRoot, 'home');
  fs.mkdirSync(home, { recursive: true });
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

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
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('session start folds staged notes even when the fetch is throttled', () => {
  /** Reproduce post-checkout having fetched but not folded, stamp already written. */
  function stageWithoutFolding() {
    git(bob, 'fetch', '--no-tags', 'origin', ORIGIN_NOTES_GLOB_REFSPEC);
    const stamp = stampPath(bob);
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, new Date().toISOString());
  }

  it('recovers memory that a previous sync fetched but never folded', () => {
    writeMemory(alice, [session('a1', { decisions: ['used curses over ANSI'] })]);
    pushMemoryNotes(alice, 'origin');

    stageWithoutFolding();

    // The exact broken state from the live report: staging populated, live ref
    // absent — so every reader (buildMemoryContext included) sees nothing.
    expect(refExists(bob, 'refs/notes/origin-remote-memory')).toBe(true);
    expect(refExists(bob, 'refs/notes/origin-memory')).toBe(false);
    expect(buildMemoryContext(bob)).toBeNull();

    // Throttled, so NO fetch runs — the return value says so — but the local
    // fold still happens and the memory becomes readable on this very launch.
    expect(syncNotesForSessionStart(bob)).toBe(false);

    expect(refExists(bob, 'refs/notes/origin-memory')).toBe(true);
    const ctx = buildMemoryContext(bob);
    expect(ctx).toContain('work a1');
    expect(ctx).toContain('used curses over ANSI');
  });

  it('is a no-op when there is nothing staged (no spurious ref creation)', () => {
    const stamp = stampPath(bob);
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, new Date().toISOString());

    expect(syncNotesForSessionStart(bob)).toBe(false);
    expect(refExists(bob, 'refs/notes/origin-memory')).toBe(false);
    expect(buildMemoryContext(bob)).toBeNull();
  });

  // The fold costs 117-259ms (it merges whole payloads before it can find out
  // there was nothing to do), so the guard below is what keeps it off the hot
  // path. If it ever returns true in the steady state, every agent launch on
  // every machine pays that — silently.
  describe('the guard that keeps the fold off the hot path', () => {
    it('is false on a repo with no notes at all', () => {
      expect(hasUnfoldedStagedNotes(bob)).toBe(false);
    });

    it('is true exactly when a staging ref has no live counterpart', () => {
      writeMemory(alice, [session('a1')]);
      pushMemoryNotes(alice, 'origin');
      stageWithoutFolding();
      expect(hasUnfoldedStagedNotes(bob)).toBe(true);
    });

    it('goes false again once the fold has run — the steady state stays cheap', () => {
      writeMemory(alice, [session('a1')]);
      pushMemoryNotes(alice, 'origin');
      stageWithoutFolding();

      syncNotesForSessionStart(bob);
      expect(refExists(bob, 'refs/notes/origin-memory')).toBe(true);

      // Second launch: nothing stuck, so no fold is attempted.
      expect(hasUnfoldedStagedNotes(bob)).toBe(false);
    });

    it('ignores a staging ref whose live counterpart already exists', () => {
      writeMemory(alice, [session('a1')]);
      pushMemoryNotes(alice, 'origin');
      stageWithoutFolding();
      // Bob writes his own memory, so the live ref exists and the pair is merely
      // divergent — not stuck. post-merge and the throttled sync own that case.
      writeMemory(bob, [session('b1')]);
      expect(hasUnfoldedStagedNotes(bob)).toBe(false);
    });
  });
});

describe('memory pointer', () => {
  it('names the ref and every way to read the full store', () => {
    writeMemory(alice, [session('a1')]);

    const pointer = buildMemoryPointerContext(alice)!;
    expect(pointer).not.toBeNull();
    // The three routes, cheapest-to-reach first. The raw git command matters
    // most: it is the only one that works with no MCP server and no CLI.
    expect(pointer).toContain('get_repo_memory');
    expect(pointer).toContain('origin context memory');
    expect(pointer).toContain('git notes --ref=origin-memory show');
    // It must be explicit that the injected block is only a digest, otherwise
    // the agent has no reason to go looking for more.
    expect(pointer).toContain('digest');
  });

  it('stays silent when the repo has no memory — never send an agent chasing an empty ref', () => {
    expect(buildMemoryPointerContext(bob)).toBeNull();
  });

  it('is dropped by the assembler when no memory block rendered', () => {
    const assembled = assembleRepoContext({
      brief: 'What this repo is.',
      memory: null,
      memoryPointer: 'read the full memory with …',
    });
    expect(assembled).toBe('What this repo is.');
  });

  it('follows the memory block when one did render', () => {
    const assembled = assembleRepoContext({
      memory: 'Prior work in this repo — 1 session:',
      memoryPointer: 'Repo memory (1 session, 0 commit records) is stored in …',
      handoff: 'In flight: nothing.',
    })!;
    expect(assembled.indexOf('Prior work')).toBeLessThan(assembled.indexOf('Repo memory (1 session'));
    expect(assembled.indexOf('Repo memory (1 session')).toBeLessThan(assembled.indexOf('In flight'));
  });
});
