// A turn whose only tool call was a DIRECTORY listing captured another
// checkout's work.
//
// Live session 5c281376 (agy, repo kotleta): prompt 0 asked a clarifying
// question and ran nothing but `list_dir`. It was stored as 9 files, +136/-1,
// and linked to commit c81adc2c — a seven-week-old commit on a DIFFERENT
// branch. Prompt 1, which actually wrote mandelbrot.py, was correct.
//
// Two compounding causes, both covered here:
//
//  1. deriveAgyRoots resolved each touched path with
//     getWorkingGitRoot(path.dirname(p)). agy's `list_dir` reports the
//     DIRECTORY itself, so dirname() climbed one level ABOVE the worktree —
//     out of the repo entirely — and the transcript's only real evidence was
//     discarded.
//  2. It then fell through to agy's workspacePaths[0], which flips between the
//     worktree and the main project directory across fires of one
//     conversation. Landing on the main checkout meant the turn diffed the
//     worktree's baseline against the MAIN tree, reporting the whole
//     branch-to-branch delta as one turn's work.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveAgyRoots, agyDetectSessionCommit } from '../commands/hooks.js';
import { samePath } from '../paths.js';

// samePath, not toBe: deriveAgyRoots answers with whatever `git rev-parse
// --show-toplevel` printed, and on Windows git prints FORWARD slashes while
// `path.join` below builds the same directory with backslashes. Comparing the
// two spellings with string identity is the exact bug paths.ts exists to stop
// — asserted that way, these passed on Ubuntu and failed on every Windows run.
function expectSameDir(actual: string | null | undefined, expected: string): void {
  expect(samePath(actual, expected), `${actual} should name the same directory as ${expected}`).toBe(true);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('agy root resolution for directory paths', () => {
  let main: string;
  let worktree: string;

  beforeEach(() => {
    main = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dir-main-')));
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.email', 'test@origin.dev');
    git(main, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(main, 'README.md'), 'hi\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'seed');
    // Mirror agy's layout: <holder>/<branch>, where <holder> is NOT a repo.
    const holder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dir-wt-')));
    worktree = path.join(holder, 'refactor_code_structure');
    git(main, 'worktree', 'add', '-q', '-b', 'refactor_code_structure', worktree);
  });

  afterEach(() => {
    try { git(main, 'worktree', 'remove', '--force', worktree); } catch { /* ignore */ }
    for (const d of [path.dirname(worktree), main]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('resolves a DIRECTORY path to its own repo, not its parent', () => {
    // What `list_dir` reports. dirname() of this is the holder dir, which is
    // not a repo — the old code got null here and threw the evidence away.
    const roots = deriveAgyRoots([worktree], undefined, '/nonexistent');
    expectSameDir(roots.workRoot, worktree);
    expectSameDir(roots.repoPath, main);
  });

  it('still resolves a FILE path via its parent directory', () => {
    const file = path.join(worktree, 'nested', 'x.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x\n');
    expectSameDir(deriveAgyRoots([file], undefined, '/nonexistent').workRoot, worktree);
  });

  it('prefers the touched path over a workspacePaths[0] pointing elsewhere', () => {
    // THE bug: agy handed workspacePaths[0] = the main checkout on some fires.
    // The transcript's own evidence must win.
    const roots = deriveAgyRoots([worktree], main, '/nonexistent');
    expectSameDir(roots.workRoot, worktree);
  });

  it('resolves a path that no longer exists without throwing', () => {
    const gone = path.join(worktree, 'deleted-since.ts');
    expectSameDir(deriveAgyRoots([gone], undefined, '/nonexistent').workRoot, worktree);
  });

  it('never credits a commit made BEFORE the session started', () => {
    // The backstop. Even with a baseline pointing at an older tip — so the
    // revision walk enumerates a whole branch delta — a commit that predates
    // the session cannot be its work. Without this, session 5c281376 stamped a
    // seven-week-old commit onto a turn that only asked a question.
    const base = git(main, 'rev-parse', 'HEAD');
    // A commit made "before" the session: it exists at the baseline's tip.
    fs.writeFileSync(path.join(main, 'old.txt'), 'old\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'pre-existing work');
    const preExisting = git(main, 'rev-parse', 'HEAD');

    // Unguarded, the walk hands back that commit.
    expect(agyDetectSessionCommit(main, base).commitSha).toBe(preExisting);

    // Guarded with a session that started an hour from now, it does not.
    const startedLater = Date.now() + 3_600_000;
    expect(agyDetectSessionCommit(main, base, startedLater).commitSha).toBeUndefined();

    // And a session that started before the commit still gets it.
    expect(agyDetectSessionCommit(main, base, Date.now() - 3_600_000).commitSha).toBe(preExisting);
  });
});
