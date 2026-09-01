// Regression test for the bug where an Antigravity turn that CREATED a file
// reported "0 files changed / +0 −0".
//
// agy runs its turns inside its OWN linked git worktree
// (~/.gemini/antigravity/worktrees/<project>/<branch>). deriveAgyRepoPath
// collapsed that to the CANONICAL repo via getGitRoot — correct for repo
// identity, but the agy handler used that one path for git capture too. So the
// baseline shadow snapshotted the MAIN checkout's tree, captureAgyDiff
// snapshotted that same untouched tree again, and the delta was empty. Observed
// live on session 45d71da1: agy wrote random_password.py into
// ~/.gemini/antigravity/worktrees/kotleta/debug_unresolved_changes, and the
// session showed 0 files, +0/−0, labelled with the MAIN checkout's branch.
//
// Fix: deriveAgyRoots keeps the two apart — repoPath (canonical, for identity)
// and workRoot (the worktree, for every git operation that captures work).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveAgyRoots, deriveAgyRepoPath } from '../commands/hooks.js';
import { samePath } from '../paths.js';
import { createShadowCommit, captureAgyDiff } from '../git-capture.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('agy worktree diff capture', () => {
  let main: string;
  let worktree: string;

  beforeEach(() => {
    main = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-main-')));
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.email', 'test@origin.dev');
    git(main, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(main, 'README.md'), 'hi\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'seed');
    // The agy worktree — a linked worktree on its own branch, living OUTSIDE
    // the main checkout (agy puts it under ~/.gemini/antigravity/worktrees).
    worktree = path.join(fs.realpathSync.native(os.tmpdir()), `agy-wt-${process.pid}`);
    git(main, 'worktree', 'add', '-q', '-b', 'agy-branch', worktree);
  });

  afterEach(() => {
    try { git(main, 'worktree', 'remove', '--force', worktree); } catch { /* ignore */ }
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(main, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reports the canonical repo for identity but the worktree for git work', () => {
    const edited = path.join(worktree, 'random_password.py');
    fs.writeFileSync(edited, 'import random\n');
    const roots = deriveAgyRoots([edited], undefined, '/nonexistent');
    // samePath, not toBe: these come back the way `git rev-parse
    // --show-toplevel` spells them, which on Windows is FORWARD slashes —
    // while `path.join` built `main`/`worktree` with backslashes. Same
    // directory, two spellings; string identity is the bug paths.ts exists to
    // stop, and asserting it here passed on Ubuntu and failed on Windows.
    expect(samePath(roots.repoPath, main)).toBe(true);      // identity: the registered repo
    expect(samePath(roots.workRoot, worktree)).toBe(true);  // capture: where the edits landed
    // The legacy single-root helper keeps returning identity, unchanged.
    expect(samePath(deriveAgyRepoPath([edited], undefined, '/nonexistent'), main)).toBe(true);
  });

  it('captures a file created in the worktree (canonical root sees nothing)', () => {
    // Baseline BEFORE the edit, as pre-tool-use does.
    const baseFromWorktree = createShadowCommit(worktree, 'agy-start-test') || git(worktree, 'rev-parse', 'HEAD');
    const baseFromMain = createShadowCommit(main, 'agy-start-test-main') || git(main, 'rev-parse', 'HEAD');

    fs.writeFileSync(path.join(worktree, 'random_password.py'), 'import random\nprint(1)\n');

    // The fix: capture from the working root.
    const good = captureAgyDiff(worktree, baseFromWorktree);
    expect(good.filesChanged).toContain('random_password.py');
    expect(good.linesAdded).toBeGreaterThan(0);

    // The bug: capture from the canonical root never sees the edit at all.
    const bad = captureAgyDiff(main, baseFromMain);
    expect(bad.filesChanged).toEqual([]);
    expect(bad.linesAdded).toBe(0);
  });

  it('resolves the WORKTREE branch, not the main checkout branch', () => {
    const edited = path.join(worktree, 'random_password.py');
    fs.writeFileSync(edited, 'x\n');
    const { workRoot, repoPath } = deriveAgyRoots([edited], undefined, '/nonexistent');
    expect(git(workRoot, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agy-branch');
    expect(git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});
