// Regression for the "every session shows main" bug. getGitRoot collapses a
// linked worktree to the MAIN repo (so repo identity stays canonical), so
// SessionState.repoPath points at the main checkout. Reading the branch from
// repoPath then returns the main checkout's branch ("main") for every
// worktree session. resolveSessionBranch must prefer the live working dir
// (the worktree) so the session shows the branch it's actually on.

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { resolveSessionBranch, getBranch } from '../session-state.js';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('resolveSessionBranch (worktree branch tracking)', () => {
  it('returns the worktree branch, not the collapsed main repo branch', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-branch-'));
    try {
      const main = path.join(tmp, 'repo');
      fs.mkdirSync(main);
      git(main, ['init', '-q', '-b', 'main']);
      git(main, ['config', 'user.email', 't@t.co']);
      git(main, ['config', 'user.name', 'T']);
      fs.writeFileSync(path.join(main, 'f.txt'), 'hello\n');
      git(main, ['add', '-A']);
      git(main, ['commit', '-q', '-m', 'init']);

      // Linked worktree on its own branch — mirrors how agents run.
      const wt = path.join(tmp, 'wt');
      git(main, ['worktree', 'add', '-q', '-b', 'feature/x', wt]);

      // Sanity: the two checkouts really are on different branches.
      expect(getBranch(main)).toBe('main');
      expect(getBranch(wt)).toBe('feature/x');

      // The bug: state.repoPath is collapsed to the main repo. Reading branch
      // from it alone yields "main" for the worktree session.
      expect(resolveSessionBranch({ repoPath: main })).toBe('main');

      // The fix: a worktree cwd hint wins over the collapsed repoPath.
      expect(resolveSessionBranch({ repoPath: main }, wt)).toBe('feature/x');

      // And lastCwd (persisted worktree cwd) is used when no hint is passed —
      // this is the stop/end path that only has `state`.
      expect(resolveSessionBranch({ repoPath: main, lastCwd: wt })).toBe('feature/x');
    } finally {
      // `git worktree add` registers admin files; rm -rf the whole tmp tree.
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to repoPath when no working-dir cwd is known', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-branch-'));
    try {
      git(tmp, ['init', '-q', '-b', 'trunk']);
      git(tmp, ['config', 'user.email', 't@t.co']);
      git(tmp, ['config', 'user.name', 'T']);
      fs.writeFileSync(path.join(tmp, 'f.txt'), 'x\n');
      git(tmp, ['add', '-A']);
      git(tmp, ['commit', '-q', '-m', 'init']);
      expect(resolveSessionBranch({ repoPath: tmp })).toBe('trunk');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
