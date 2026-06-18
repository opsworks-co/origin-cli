/**
 * Regression tests for the pre-push hook's refs/notes/origin push.
 *
 * Symptom (from ~/.origin/hooks.log): every pre-push logged
 * `notes push skipped` because `git push origin refs/notes/origin` was
 * rejected non-fast-forward whenever another worktree/machine had pushed
 * newer notes since this clone last synced. Notes silently stopped
 * propagating to the remote.
 *
 * Fix under test: on push rejection, handlePrePush fetches the remote
 * notes ref, merges it into the local one (`git notes merge -s ours` —
 * per-commit JSON notes, keep the local note on a same-commit conflict),
 * and retries the push once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handlePrePush } from '../commands/hooks.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function configureUser(repo: string): void {
  git(repo, 'config', 'user.email', 'test@origin.dev');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  // Neutralize globally-installed git hooks (core.hooksPath → Origin's real
  // hooks on dev machines): fixture commits/pushes must not auto-write or
  // auto-push notes, or the divergence this suite sets up gets corrupted.
  git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
}

describe('handlePrePush refs/notes/origin', () => {
  let baseDir: string;
  let bareRemote: string;
  let repoA: string;
  let repoB: string;
  let c1: string;
  let c2: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-prepush-')));
    bareRemote = path.join(baseDir, 'remote.git');
    fs.mkdirSync(bareRemote);
    git(bareRemote, 'init', '-q', '--bare', '-b', 'main');

    // repoA seeds the remote with two commits and a note on C1.
    repoA = path.join(baseDir, 'repoA');
    fs.mkdirSync(repoA);
    git(repoA, 'init', '-q', '-b', 'main');
    configureUser(repoA);
    fs.writeFileSync(path.join(repoA, 'a.txt'), 'a\n');
    git(repoA, 'add', '.');
    git(repoA, 'commit', '-q', '-m', 'C1');
    c1 = git(repoA, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repoA, 'b.txt'), 'b\n');
    git(repoA, 'add', '.');
    git(repoA, 'commit', '-q', '-m', 'C2');
    c2 = git(repoA, 'rev-parse', 'HEAD');
    git(repoA, 'remote', 'add', 'origin', bareRemote);
    git(repoA, 'push', '-q', 'origin', 'main');
    git(repoA, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"session-a"}}', c1);
    git(repoA, 'push', '-q', 'origin', 'refs/notes/origin');

    // repoB clones AFTER the remote already has notes (clone doesn't fetch
    // refs/notes/*), then writes its own note — its local notes ref shares
    // no history with the remote's, so a plain push is rejected non-ff.
    repoB = path.join(baseDir, 'repoB');
    git(baseDir, 'clone', '-q', bareRemote, repoB);
    configureUser(repoB);
    git(repoB, 'notes', '--ref=origin', 'add', '-m', '{"origin":{"sessionId":"session-b"}}', c2);
  });

  afterEach(() => {
    process.chdir(origCwd);
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function remoteNoteFor(sha: string): string {
    // Verify against a fresh fetch of the remote's notes ref, not local state.
    git(repoB, 'fetch', '-q', '--no-tags', 'origin', '+refs/notes/origin:refs/notes/verify');
    return git(repoB, 'notes', '--ref=verify', 'show', sha);
  }

  it('precondition: a plain push of divergent notes is rejected', () => {
    expect(() => git(repoB, 'push', '-q', 'origin', 'refs/notes/origin')).toThrow();
  });

  it('merges remote notes and retries so both sides\' notes reach the remote', async () => {
    process.chdir(repoB);

    await handlePrePush();

    // The remote now carries repoA's note on C1 AND repoB's note on C2.
    expect(remoteNoteFor(c1)).toContain('session-a');
    expect(remoteNoteFor(c2)).toContain('session-b');
  });

  it('keeps the local note when both sides annotated the same commit', async () => {
    // repoA also annotates C2 and pushes (fast-forward — repoA is in sync
    // with the remote), so the remote's note on C2 now conflicts with repoB's.
    git(repoA, 'notes', '--ref=origin', 'add', '-f', '-m', '{"origin":{"sessionId":"session-a-conflict"}}', c2);
    git(repoA, 'push', '-q', 'origin', 'refs/notes/origin');

    process.chdir(repoB);
    await handlePrePush();

    // -s ours: repoB's JSON note on C2 survives intact (not concatenated).
    const note = remoteNoteFor(c2);
    expect(note).toBe('{"origin":{"sessionId":"session-b"}}');
    // repoA's untouched note on C1 still propagated.
    expect(remoteNoteFor(c1)).toContain('session-a');
  });

  it('pushes cleanly with no remote divergence (fast-forward case)', async () => {
    // Sync repoB's notes with the remote first, then add a new note — the
    // push should succeed on the first attempt, no merge needed.
    git(repoB, 'fetch', '-q', '--no-tags', 'origin', '+refs/notes/origin:refs/notes/origin');
    git(repoB, 'notes', '--ref=origin', 'add', '-f', '-m', '{"origin":{"sessionId":"session-b2"}}', c2);
    process.chdir(repoB);

    await handlePrePush();

    expect(remoteNoteFor(c2)).toContain('session-b2');
  });
});
