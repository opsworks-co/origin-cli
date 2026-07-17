// A restore must never overwrite uncommitted work it failed to stash.
//
// handleRestore's next step is destructive (`git reset --hard` / `read-tree` +
// `checkout-index -a -f`), and the pre-restore auto-stash is the ONLY recovery
// path. The old inline code swallowed both a failed `git status` and a failed
// `git stash push`, then reset anyway — silently destroying the user's work with
// a "restore succeeded" message. assessRestoreSafety is the extracted decision;
// these tests drive it against a REAL repo, including a genuinely failing stash.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assessRestoreSafety } from '../restore-safety.js';

describe('assessRestoreSafety', () => {
  let repo: string;

  function git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: repo, encoding: 'utf-8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  }
  const runGit = (args: string[]) => git(...args);

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-restore-'));
    git('init', '-q', '-b', 'main', '.');
    git('config', 'user.email', 't@t.co');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'committed\n');
    git('add', '-A');
    git('commit', '-qm', 'c1');
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('clean tree → safe, nothing stashed', () => {
    const r = assessRestoreSafety(runGit, 'stash-x');
    expect(r).toEqual({ safe: true, stashed: false });
  });

  it('dirty tree that stashes → safe and stashed, and the work is recoverable', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'UNCOMMITTED EDIT\n');
    const r = assessRestoreSafety(runGit, 'origin-restore-test');
    expect(r.safe).toBe(true);
    expect(r.stashed).toBe(true);
    // The stash actually holds the work — this is the recovery path the caller
    // promises the user.
    expect(git('stash', 'list')).toContain('origin-restore-test');
    git('stash', 'pop');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('UNCOMMITTED EDIT\n');
  });

  it('dirty tree whose stash FAILS → NOT safe, and the work is left untouched', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'PRECIOUS UNSAVED WORK\n');
    // Force `git stash push` to fail the way it does in the wild: a stale
    // index.lock. (git status still works; stash cannot take the index lock.)
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');

    const r = assessRestoreSafety(runGit, 'stash-y');
    expect(r.safe).toBe(false);          // THE fix: caller must abort, not reset
    expect(r.stashed).toBe(false);
    expect(r.reason).toMatch(/could not be stashed/);

    // And the whole point: the working tree is exactly as the user left it.
    fs.rmSync(path.join(repo, '.git', 'index.lock'));
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('PRECIOUS UNSAVED WORK\n');
  });

  it('when `git status` itself fails → NOT safe (cleanliness unknown)', () => {
    // A runGit that throws on status but not otherwise. If we can't tell whether
    // the tree is dirty, assume it might be and refuse.
    const failingStatus = (args: string[]): string => {
      if (args[0] === 'status') throw new Error('git status exploded');
      return git(...args);
    };
    const r = assessRestoreSafety(failingStatus, 'stash-z');
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/could not check/);
  });
});
