/**
 * mergeTreeOf — the one place Origin asks git what a merge of two commits
 * would be. mergeOwnDiff reads its tree; commitCombiningTips also reads the
 * conflicted paths. A conflict is an answer (`clean: false`), not a failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mergeTreeOf } from '../git-capture.js';

let repo: string;
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
const commit = (m: string) => { git('add', '-A'); git('commit', '-q', '-m', m); return git('rev-parse', 'HEAD'); };

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'merge-tree-of-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@test.dev');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  write('seed.txt', 'seed\n');
  commit('seed');
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('mergeTreeOf', () => {
  it('a clean merge: both sides in the tree, nothing conflicted', () => {
    git('checkout', '-q', '-b', 'left');
    write('left.txt', 'left\n');
    const left = commit('left');
    git('checkout', '-q', '-b', 'right', 'main');
    write('right.txt', 'right\n');
    const right = commit('right');

    const merged = mergeTreeOf(repo, left, right);
    expect(merged).toMatchObject({ clean: true, conflicted: [] });
    expect(git('show', `${merged!.tree}:left.txt`)).toBe('left');
    expect(git('show', `${merged!.tree}:right.txt`)).toBe('right');
    // Nothing was written to the working tree, index or refs.
    expect(git('status', '--porcelain')).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(right);
  });

  it('a conflict: still a tree, markers included, and the path named', () => {
    git('checkout', '-q', '-b', 'left');
    write('shared.txt', 'left\n');
    const left = commit('left');
    git('checkout', '-q', '-b', 'right', 'main');
    write('shared.txt', 'right\n');
    write('right.txt', 'right\n');
    const right = commit('right');

    const merged = mergeTreeOf(repo, left, right);
    expect(merged).toMatchObject({ clean: false, conflicted: ['shared.txt'] });
    expect(git('show', `${merged!.tree}:shared.txt`)).toContain('<<<<<<<');
    expect(git('show', `${merged!.tree}:right.txt`)).toBe('right');
  });

  it('null when git cannot answer', () => {
    expect(mergeTreeOf(repo, 'deadbeef', git('rev-parse', 'HEAD'))).toBeNull();
  });
});
