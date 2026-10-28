import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as exec from '../utils/exec.js';
import { TURN_TREES_REF, pinTurnTree } from '../git-capture.js';
import { getWorkingTreeSha } from '../commands/hooks/session-end.js';

// A turn's restore point is the `git stash create` tree recorded at Stop. That
// commit is dangling, and the session's snapshot branch — its only other
// holder — is deleted at session end, so gc pruned the code and "Restore this
// turn" failed on older turns (59 of 592 recorded trees gone on this repo).

let repo: string;
function git(args: string[]) { return exec.git(args, { cwd: repo }).trim(); }
function exists(sha: string) { return exec.gitDetailed(['cat-file', '-e', sha], { cwd: repo }).status === 0; }
function prune() { git(['-c', 'gc.reflogExpire=now', '-c', 'gc.reflogExpireUnreachable=now', 'reflog', 'expire', '--all']); git(['gc', '--prune=now', '--quiet']); }
function dirty(content: string) {
  fs.writeFileSync(path.join(repo, 'a.txt'), content);
  return git(['rev-parse', `${git(['stash', 'create'])}^{tree}`]);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-tree-pin-'));
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'base']);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('turn tree pinning', () => {
  it('an unpinned stash-create tree is pruned by gc (the bug)', () => {
    const tree = dirty('turn 1\n');
    prune();
    expect(exists(tree)).toBe(false);
  });

  it('getWorkingTreeSha pins the tree it returns, so gc keeps it', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'turn 1\n');
    const tree = getWorkingTreeSha(repo)!;
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    prune();
    expect(exists(tree)).toBe(true);
    expect(git(['rev-parse', `${TURN_TREES_REF}^{tree}`])).toBe(tree);
  });

  it('keeps every turn, not just the last, and skips a tree equal to the tip', () => {
    const t1 = dirty('turn 1\n');
    const t2 = dirty('turn 2\n');
    expect(pinTurnTree(repo, t1)).toBe(true);
    expect(pinTurnTree(repo, t2)).toBe(true);
    expect(pinTurnTree(repo, t2)).toBe(true);
    expect(git(['rev-list', '--count', TURN_TREES_REF])).toBe('2');
    prune();
    expect(exists(t1)).toBe(true);
    expect(exists(t2)).toBe(true);
  });

  it('refuses a non-sha and an unknown tree without throwing', () => {
    expect(pinTurnTree(repo, null)).toBe(false);
    expect(pinTurnTree(repo, 'HEAD')).toBe(false);
    expect(pinTurnTree(repo, 'f'.repeat(40))).toBe(false);
    expect(exec.gitDetailed(['rev-parse', '--verify', '--quiet', TURN_TREES_REF], { cwd: repo }).status).not.toBe(0);
  });
});
