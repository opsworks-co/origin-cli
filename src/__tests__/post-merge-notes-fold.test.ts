/**
 * post-merge: an ordinary `git pull` must leave Origin's metadata USABLE.
 *
 * Two halves have to line up for that, and before this release neither did on
 * its own:
 *
 *   Transport — `git clone`/`git pull` never carry refs/notes/*. The glob
 *   fetchspec (ORIGIN_NOTES_GLOB_REFSPEC) fixes that, and unlike the explicit
 *   refspecs it can be installed before the remote has any notes at all.
 *
 *   Fold — a fetched note lands in the STAGING namespace, where nothing reads
 *   it. `origin blame`, `origin context memory` and the SessionStart context
 *   block all read the live refs, so a pull that fetched a teammate's memory
 *   still showed the agent stale context until the next SessionStart sync (6h
 *   throttle) or a manual `origin link`. foldStagedNotes is what the post-merge
 *   hook runs to close that gap.
 *
 * These tests drive real git pulls against a real bare remote and call the fold
 * directly — the only untested layer is the ~20-line shell wrapper that shells
 * out to `origin hooks git-post-merge`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  syncNotesFromRemote,
  pushMemoryNotes,
  foldStagedNotes,
  ORIGIN_NOTES_GLOB_REFSPEC,
  STAGED_NOTES,
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

function writeMemory(repo: string, sessions: any[]) {
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
  git(repo, 'notes', '--ref=origin-memory', 'add', '-f', '-m',
    JSON.stringify({ version: 2, sessions, commits: [] }, null, 2), root);
}

function readMemory(repo: string): { sessions: any[] } {
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
  return JSON.parse(git(repo, 'notes', '--ref=origin-memory', 'show', root));
}

const session = (id: string) => ({
  sessionId: id,
  agentSlug: 'claude-code',
  model: 'claude',
  startedAt: '2026-08-01T00:00:00.000Z',
  endedAt: '2026-08-01T01:00:00.000Z',
  branch: 'main',
  summary: `work ${id}`,
  filesChanged: [`${id}.py`],
  promptCount: 1,
  linesAdded: 10,
  linesRemoved: 0,
  openTodos: [],
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-post-merge-'));
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

describe('post-merge fold', () => {
  it('a plain `git pull` + fold delivers a teammate\'s memory', () => {
    // Bob has been touched by Origin once (any command that syncs), which is
    // all it takes to install the glob refspec.
    syncNotesFromRemote(bob);
    expect(git(bob, 'config', '--get-all', 'remote.origin.fetch'))
      .toContain(ORIGIN_NOTES_GLOB_REFSPEC);

    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');

    // A completely ordinary pull — no Origin command in the loop.
    git(bob, 'pull', '-q');
    // Transport worked: it's staged.
    expect(git(bob, 'rev-parse', '--verify', STAGED_NOTES.memory.staging)).toBeTruthy();
    // But not yet readable — this is precisely the gap post-merge closes.
    expect(() => readMemory(bob)).toThrow();

    expect(foldStagedNotes(bob)).toBe(true);
    expect(readMemory(bob).sessions.map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('folds attribution notes on the same pull', () => {
    syncNotesFromRemote(bob);

    const head = git(alice, 'rev-parse', 'HEAD');
    git(alice, 'notes', '--ref=origin', 'add', '-f', '-m',
      '{"origin":{"version":1,"sessionId":"s1","model":"claude-fable-5"}}', head);
    git(alice, 'push', 'origin', '+refs/notes/origin:refs/notes/origin');

    git(bob, 'pull', '-q');
    expect(foldStagedNotes(bob)).toBe(true);
    expect(git(bob, 'notes', '--ref=origin', 'show', head)).toContain('claude-fable-5');
  });

  it('keeps Bob authoritative for commits he annotated himself', () => {
    syncNotesFromRemote(bob);
    const head = git(bob, 'rev-parse', 'HEAD');
    git(bob, 'notes', '--ref=origin', 'add', '-f', '-m',
      '{"origin":{"version":1,"sessionId":"bob-local","model":"local"}}', head);

    // Alice annotates the SAME commit and pushes.
    git(alice, 'notes', '--ref=origin', 'add', '-f', '-m',
      '{"origin":{"version":1,"sessionId":"alice","model":"remote"}}', head);
    git(alice, 'push', 'origin', '+refs/notes/origin:refs/notes/origin');

    git(bob, 'pull', '-q');
    foldStagedNotes(bob);
    // `-s ours`: the local machine wins for commits it annotated itself.
    expect(git(bob, 'notes', '--ref=origin', 'show', head)).toContain('bob-local');
  });

  it('is a no-op when the pull brought nothing new', () => {
    syncNotesFromRemote(bob);
    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');
    git(bob, 'pull', '-q');
    expect(foldStagedNotes(bob)).toBe(true);
    // Second fold with no intervening fetch must not churn the ref.
    expect(foldStagedNotes(bob)).toBe(false);
  });

  it('falls back to the legacy staging ref a previous release wrote', () => {
    // A repo synced by an older CLI has memory staged under the old name and
    // no glob refspec. The fold must still find it, or upgrading the CLI would
    // strand whatever that release had already fetched.
    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');
    git(bob, 'fetch', '-q', 'origin',
      `+refs/notes/origin-memory:${STAGED_NOTES.memory.legacy}`);

    expect(foldStagedNotes(bob)).toBe(true);
    expect(readMemory(bob).sessions.map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('a pull that NAMES a refspec bypasses the glob — the fold must report nothing', () => {
    // `git pull origin main` makes git use THAT refspec instead of the
    // configured fetchspecs, so the glob never runs and nothing is staged.
    // Agents write this form constantly, which is why handleGitPostMerge falls
    // back to the throttled network sync whenever the fold comes up empty.
    syncNotesFromRemote(bob);
    writeMemory(alice, [session('a1')]);
    pushMemoryNotes(alice, 'origin');

    git(bob, 'pull', '-q', 'origin', 'main');
    expect(() => git(bob, 'rev-parse', '--verify', STAGED_NOTES.memory.staging)).toThrow();
    expect(foldStagedNotes(bob)).toBe(false);

    // …and the fallback recovers it.
    expect(syncNotesFromRemote(bob)).toBe(true);
    expect(readMemory(bob).sessions.map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('the glob never breaks a plain fetch against a notes-free remote', () => {
    // The reason the glob can be installed unconditionally at all. An explicit
    // refspec here would make every subsequent `git fetch` exit 128.
    syncNotesFromRemote(bob);
    expect(git(bob, 'config', '--get-all', 'remote.origin.fetch'))
      .toContain(ORIGIN_NOTES_GLOB_REFSPEC);
    expect(() => git(bob, 'fetch', '-q', 'origin')).not.toThrow();
    expect(() => git(bob, 'pull', '-q')).not.toThrow();
    expect(foldStagedNotes(bob)).toBe(false); // nothing upstream to fold
  });
});
