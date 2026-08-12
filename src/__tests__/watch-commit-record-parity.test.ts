// A commit captured on Windows must produce the same RECORD as the same commit
// captured on macOS.
//
// Origin has two per-commit memory writers:
//   - hooks.ts handlePostCommit — the git post-commit hook. Fires wherever hooks
//     fire, which in practice is macOS/Linux and CLI agents.
//   - transcript-watch.ts recordCommitMemory — the hook-independent watcher,
//     auto-started on Windows ONLY (AUTO_START_PLATFORMS = ['win32']), because
//     GUI agents there never fire their lifecycle hooks.
//
// The hook path wrote `decisions` (from [Origin: Decision] markers) and the real
// `branch`; the watcher wrote neither — branch: null, decisions absent. So the
// same Cursor commit produced a rich record on a Mac and a bare one on Windows,
// and the "why" a reader actually wants was platform-dependent. Live proof:
// commit 21727e6, captured by the watcher, carried no decisions at all while its
// own session rollup carried one.
//
// Branch is resolved rather than copied from HEAD: the hook runs AT commit time
// so "the branch I am on" is exact, but the watcher can be recording minutes
// later, or catching up a backlog, by which point HEAD has moved.

import { describe, it, expect } from 'vitest';
import { commitBranch } from '../transcript-watch.js';

// Stands in for git. Keys are the first argument, values the stdout.
function fakeGit(responses: Record<string, string>): (args: string[]) => string {
  return (args: string[]) => {
    if (args[0] === 'for-each-ref') return responses.containing ?? '';
    if (args[0] === 'rev-parse') return responses.head ?? '';
    throw new Error(`unexpected git ${args[0]}`);
  };
}

describe('commitBranch', () => {
  it('prefers the current branch when it contains the commit', () => {
    // The ordinary case: the commit was just made here, and several branches
    // legitimately contain it (main plus the feature branch).
    const run = fakeGit({ containing: 'main\nadd-popoka-rows\n', head: 'add-popoka-rows' });
    expect(commitBranch(run, 'abc1234')).toBe('add-popoka-rows');
  });

  it('uses the only containing branch when HEAD is elsewhere', () => {
    // Catching up a commit made on a branch we have since left. Unambiguous, so
    // it is safe to name.
    const run = fakeGit({ containing: 'feature-x\n', head: 'main' });
    expect(commitBranch(run, 'abc1234')).toBe('feature-x');
  });

  it('returns null when several branches contain it and none is current', () => {
    // Nothing here distinguishes the branches, and inventing one would attach a
    // commit to work it was not part of. Absent beats wrong.
    const run = fakeGit({ containing: 'main\nrelease\nfeature-y\n', head: 'unrelated' });
    expect(commitBranch(run, 'abc1234')).toBeNull();
  });

  it('returns null when no branch contains the commit', () => {
    const run = fakeGit({ containing: '', head: 'main' });
    expect(commitBranch(run, 'abc1234')).toBeNull();
  });

  it('ignores a detached HEAD rather than recording the literal string "HEAD"', () => {
    // git rev-parse --abbrev-ref HEAD prints "HEAD" when detached. Treating that
    // as a branch name would write branch: "HEAD" into memory.
    const run = fakeGit({ containing: 'main\nother\n', head: 'HEAD' });
    expect(commitBranch(run, 'abc1234')).toBeNull();
  });

  it('still resolves a detached HEAD when exactly one branch contains it', () => {
    const run = fakeGit({ containing: 'main\n', head: 'HEAD' });
    expect(commitBranch(run, 'abc1234')).toBe('main');
  });

  it('returns null instead of throwing when git fails', () => {
    // A repo git cannot answer for must not take the whole memory write down.
    const run = () => { throw new Error('not a git repository'); };
    expect(commitBranch(run, 'abc1234')).toBeNull();
  });

  it('tolerates blank lines and stray whitespace in git output', () => {
    const run = fakeGit({ containing: '\n  main  \n\n', head: 'main' });
    expect(commitBranch(run, 'abc1234')).toBe('main');
  });
});
