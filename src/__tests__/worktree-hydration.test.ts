// worktree-hydration.ts: the pieces that don't need a second worktree. The
// clone itself is covered end to end in issue-start, local-ci and review-run.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findRegularFile, hydrateWorktreeIgnoredFiles } from '../worktree-hydration.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hydrate-'));
  cleanup.push(d);
  return d;
}

describe('findRegularFile', () => {
  it('finds a top-level file behind more package dirs than the old entry budget', () => {
    const root = tmpdir();
    for (let i = 0; i < 600; i++) fs.mkdirSync(path.join(root, `pkg-${i}`));
    fs.writeFileSync(path.join(root, '.package-lock.json'), '{}');
    expect(findRegularFile(root)).toBe(path.join(root, '.package-lock.json'));
  });

  it('returns null for a tree with no regular file, and undefined when it gives up', () => {
    const empty = tmpdir();
    fs.mkdirSync(path.join(empty, 'a', 'b'), { recursive: true });
    expect(findRegularFile(empty)).toBeNull();

    const wide = tmpdir();
    for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(wide, `d${i}`, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(wide, 'd4', 'deep', 'index.js'), '');
    expect(findRegularFile(wide, 3)).toBeUndefined();
    expect(findRegularFile(wide)).toBe(path.join(wide, 'd4', 'deep', 'index.js'));
  });
});

describe('hydrateWorktreeIgnoredFiles', () => {
  it('names each directory before cloning it', () => {
    const dir = tmpdir();
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'init');
    fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), '');
    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt);

    const named: string[] = [];
    hydrateWorktreeIgnoredFiles(repo, wt, (relative) => named.push(relative));
    expect(named).toEqual(['node_modules']);
  });
});
