// A session that moves into a linked git worktree writes files somewhere
// `state.repoPath` cannot see, so the turn's shell-write window came back
// empty and the turn shipped `edits: []`.
//
// Measured on session 81d65cb5: a turn that produced a commit of +249/-16
// across 6 files — all written in a worktree under /private/tmp — was captured
// as +40 on ONE file it never touched, because a concurrent session's dirt was
// all the main checkout's window had to offer.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sessionWorkTree, shellWindowTarget, samePath } from '../session-worktree.js';
import { getWorkingGitRoot, getGitCommonDir } from '../session-state.js';

const deps = { gitRoot: getWorkingGitRoot, gitCommonDir: getGitCommonDir };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function mkrepo(prefix: string): string {
  // realpathSync.native: macOS temp dirs are symlinked (/var -> /private/var)
  // and Windows leaves 8.3 short components, so the raw path is not what git
  // reports back.
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'test@origin.dev');
  git(d, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(d, 'seed.txt'), 'hi\n');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'seed');
  return d;
}

describe('sessionWorkTree', () => {
  let repo: string;
  let wt: string;

  beforeEach(() => {
    repo = mkrepo('origin-wt-main-');
    wt = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wt-linked-')));
    fs.rmSync(wt, { recursive: true, force: true });
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  });

  afterEach(() => {
    for (const d of [wt, repo]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('follows the session into a linked worktree of the same repo', () => {
    // samePath, not toBe: on Windows `git rev-parse --show-toplevel` answers
    // with forward slashes while the test's own path carries backslashes. The
    // raw-string comparison failed on the Windows runner and was a REAL bug —
    // hooks.ts compared the resolved tree to repoPath with `===`.
    expect(samePath(sessionWorkTree(repo, wt, deps), wt)).toBe(true);
    // A cwd deeper inside the worktree resolves to the worktree top.
    const nested = path.join(wt, 'sub');
    fs.mkdirSync(nested, { recursive: true });
    expect(samePath(sessionWorkTree(repo, nested, deps), wt)).toBe(true);
  });

  it('returns a path that compares equal to repoPath on any platform', () => {
    // The regression this guards: a returned path in git's separator style
    // flows into state and is later string-compared against repoPath.
    const resolved = sessionWorkTree(repo, wt, deps);
    expect(samePath(resolved, wt)).toBe(true);
    // Canonical for THIS platform — path.resolve is a no-op on an already
    // normalised path, so this catches git's forward-slash form on Windows
    // without hard-coding a separator.
    expect(resolved).toBe(path.resolve(resolved));
  });

  it('stays on repoPath when the session never left it', () => {
    expect(samePath(sessionWorkTree(repo, repo, deps), repo)).toBe(true);
    expect(samePath(sessionWorkTree(repo, path.join(repo, 'sub'), deps), repo)).toBe(true);
  });

  it('REFUSES to follow a cwd into an unrelated repository', () => {
    // The dangerous case: without the common-dir check, a session whose cwd
    // wandered elsewhere would have another repo's diff attributed to it.
    const other = mkrepo('origin-wt-other-');
    try {
      expect(samePath(sessionWorkTree(repo, other, deps), repo)).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('falls back to repoPath on a non-repo or missing cwd', () => {
    const plain = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wt-plain-')));
    try {
      expect(samePath(sessionWorkTree(repo, plain, deps), repo)).toBe(true);
      expect(samePath(sessionWorkTree(repo, '/nonexistent/nowhere', deps), repo)).toBe(true);
      expect(samePath(sessionWorkTree(repo, null, deps), repo)).toBe(true);
      expect(samePath(sessionWorkTree(repo, undefined, deps), repo)).toBe(true);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('returns empty when there is no repo identity at all', () => {
    expect(sessionWorkTree(null, wt, deps)).toBe('');
  });
});

describe('shellWindowTarget', () => {
  it('uses the worktree pair when it belongs to this turn', () => {
    const state = { repoPath: '/main', prePromptWorkTree: { path: '/wt', sha: 'aaa', promptIndex: 3 } };
    expect(shellWindowTarget(state, 3, 'main-sha', '/wt')).toEqual({ repoPath: '/wt', baseline: 'aaa' });
  });

  it('never mixes a worktree baseline with the main tree', () => {
    // The failure this guards: diffing /main's files against a shadow whose
    // tree came from /wt reports the entire branch delta as the turn's work.
    const state = { repoPath: '/main', prePromptWorkTree: { path: '/wt', sha: 'aaa', promptIndex: 3 } };
    // Session moved back to the main checkout → the worktree pair is stale.
    expect(shellWindowTarget(state, 3, 'main-sha', '/main'))
      .toEqual({ repoPath: '/main', baseline: 'main-sha' });
  });

  it('ignores a baseline captured for a different turn', () => {
    const state = { repoPath: '/main', prePromptWorkTree: { path: '/wt', sha: 'aaa', promptIndex: 2 } };
    expect(shellWindowTarget(state, 3, 'main-sha', '/wt'))
      .toEqual({ repoPath: '/main', baseline: 'main-sha' });
  });

  it('falls back cleanly when no worktree baseline exists', () => {
    expect(shellWindowTarget({ repoPath: '/main' }, 0, 'main-sha', '/main'))
      .toEqual({ repoPath: '/main', baseline: 'main-sha' });
    expect(shellWindowTarget({ repoPath: '/main', prePromptWorkTree: null }, 0, null, '/main'))
      .toEqual({ repoPath: '/main', baseline: null });
  });
});
