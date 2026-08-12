/**
 * refs/notes/origin-acceptance round trip.
 *
 * Acceptance ("how much of the previous agent's output did the human keep")
 * was local-only: every notes push targeted refs/notes/origin, and memory got
 * its own transport, so this ref had none. The glob fetchspec and
 * foldStagedNotes brought down the fetch half; without a push the fetch half
 * was inert, because no remote ever had the ref.
 *
 * Per-commit data, so this rides the ATTRIBUTION shape — `notes merge -s ours`
 * against a staging ref — not memory's payload-level union.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  pushAcceptanceNotes,
  resolvePushRemote,
  syncNotesFromRemote,
  foldStagedNotes,
} from '../git-notes.js';

let tmpRoot: string;
let upstream: string;
let alice: string;
let bob: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

function muteHooks(dir: string) {
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
}

const acceptance = (sessionId: string, rate: number) => JSON.stringify({
  version: 1,
  sessionId,
  computedAt: '2026-08-01T02:00:00.000Z',
  addedLines: 100,
  survivingLines: Math.round(rate * 100),
  acceptanceRate: rate,
}, null, 2);

function writeAcceptance(repo: string, sha: string, sessionId: string, rate: number) {
  git(repo, 'notes', '--ref=origin-acceptance', 'add', '-f', '-m', acceptance(sessionId, rate), sha);
}

function readAcceptance(repo: string, sha: string): any {
  return JSON.parse(git(repo, 'notes', '--ref=origin-acceptance', 'show', sha));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-acceptance-transport-'));
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

describe('acceptance notes transport', () => {
  it('reaches a teammate: push on one clone, pull + fold on the other', () => {
    const head = git(alice, 'rev-parse', 'HEAD');
    writeAcceptance(alice, head, 's1', 0.8);
    pushAcceptanceNotes(alice, 'origin');

    // On the remote at all — the thing that was missing entirely.
    expect(git(alice, 'ls-remote', 'origin', 'refs/notes/*')).toContain('origin-acceptance');

    syncNotesFromRemote(bob);
    expect(readAcceptance(bob, head).acceptanceRate).toBe(0.8);
    expect(readAcceptance(bob, head).sessionId).toBe('s1');
  });

  it('arrives on an ordinary git pull once the glob refspec is in place', () => {
    syncNotesFromRemote(bob); // installs the glob fetchspec

    const head = git(alice, 'rev-parse', 'HEAD');
    writeAcceptance(alice, head, 's1', 0.42);
    pushAcceptanceNotes(alice, 'origin');

    git(bob, 'pull', '-q');
    expect(foldStagedNotes(bob)).toBe(true);
    expect(readAcceptance(bob, head).acceptanceRate).toBe(0.42);
  });

  it('a divergent push unions distinct commits instead of clobbering', () => {
    // Alice annotates the root commit; Bob annotates a second commit without
    // syncing first. Bob's push is rejected non-fast-forward and the retry has
    // to merge rather than drop Alice's.
    const root = git(alice, 'rev-parse', 'HEAD');
    writeAcceptance(alice, root, 'alice-s', 0.9);
    pushAcceptanceNotes(alice, 'origin');

    fs.writeFileSync(path.join(bob, 'second.txt'), 'more\n');
    git(bob, 'add', '.');
    git(bob, 'commit', '-m', 'second');
    const second = git(bob, 'rev-parse', 'HEAD');
    writeAcceptance(bob, second, 'bob-s', 0.1);
    pushAcceptanceNotes(bob, 'origin');

    // Both survived on Bob's side after the reconciling retry…
    expect(readAcceptance(bob, root).sessionId).toBe('alice-s');
    expect(readAcceptance(bob, second).sessionId).toBe('bob-s');
    // …and both are on the remote.
    git(bob, 'push', '-q', 'origin', 'HEAD:main');
    syncNotesFromRemote(alice);
    expect(readAcceptance(alice, second).sessionId).toBe('bob-s');
  });

  it('keeps the local note when both machines annotated the SAME commit', () => {
    // `-s ours`: the local machine measured survival against its own HEAD, so
    // its number is the one that describes its tree.
    const head = git(alice, 'rev-parse', 'HEAD');
    writeAcceptance(alice, head, 'alice-s', 0.9);
    pushAcceptanceNotes(alice, 'origin');

    writeAcceptance(bob, head, 'bob-s', 0.2);
    syncNotesFromRemote(bob);
    expect(readAcceptance(bob, head).sessionId).toBe('bob-s');
  });

  it('is a silent no-op when nothing was ever written', () => {
    expect(() => pushAcceptanceNotes(alice, 'origin')).not.toThrow();
    expect(git(alice, 'ls-remote', 'origin', 'refs/notes/*')).not.toContain('acceptance');
  });

  it('pushes regardless of the prompt-privacy opt-out (it carries no prompt text)', () => {
    // notesIncludePrompts:false means "don't publish my prompt text". An
    // acceptance note is line counts + a session id — strictly less than
    // refs/notes/origin already publishes with the switch off.
    fs.writeFileSync(path.join(alice, '.origin.json'), JSON.stringify({ notesIncludePrompts: false }));
    const head = git(alice, 'rev-parse', 'HEAD');
    writeAcceptance(alice, head, 's1', 0.5);
    pushAcceptanceNotes(alice, 'origin');
    expect(git(alice, 'ls-remote', 'origin', 'refs/notes/*')).toContain('origin-acceptance');
  });
});

describe('resolvePushRemote', () => {
  it('prefers "origin"', () => {
    expect(resolvePushRemote(alice)).toBe('origin');
  });

  it('falls back to the first remote when there is no "origin"', () => {
    git(alice, 'remote', 'rename', 'origin', 'upstream');
    expect(resolvePushRemote(alice)).toBe('upstream');
  });

  it('returns empty for a repo with no remotes', () => {
    git(alice, 'remote', 'remove', 'origin');
    expect(resolvePushRemote(alice)).toBe('');
  });
});
