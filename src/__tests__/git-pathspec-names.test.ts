/**
 * A mutating git command names exactly the paths it rewrites; nothing else in
 * a shell command does. See git-pathspec-names.ts and command-named-evidence.test.ts,
 * whose rule for non-git text (never a bare name, never a passing directory
 * mention) this must not loosen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileNamedInCommand } from '../commands/hooks.js';
import {
  fileNamedByGitRevisionPathspec,
  fileNamedByGitPathspec,
  filesTurnNamedByGitPathspec,
  gitPathspecsNamed,
  recordGitPathspecs,
} from '../git-pathspec-names.js';

describe('gitPathspecsNamed', () => {
  it('names a root file and a directory after `--`', () => {
    expect(gitPathspecsNamed('git checkout HEAD~1 -- package.json')).toEqual(['package.json']);
    expect(gitPathspecsNamed('git checkout HEAD~1 -- lib/')).toEqual(['lib']);
    expect(fileNamedByGitPathspec('git checkout HEAD~1 -- lib', 'lib/a.py')).toBe(true);
    expect(fileNamedByGitPathspec('git checkout HEAD~1 -- lib', 'library.py')).toBe(false);
  });

  it('distinguishes revision materialization from conflict resolution and index restore', () => {
    expect(fileNamedByGitRevisionPathspec('git checkout refs/pull/2835/head -- package.json', 'package.json')).toBe(true);
    expect(fileNamedByGitRevisionPathspec('git checkout --theirs -- package.json', 'package.json')).toBe(false);
    expect(fileNamedByGitRevisionPathspec('git checkout -- package.json', 'package.json')).toBe(false);
    expect(fileNamedByGitRevisionPathspec('git restore --source=HEAD~2 docs', 'docs/a.md')).toBe(true);
    expect(fileNamedByGitRevisionPathspec('git restore docs', 'docs/a.md')).toBe(false);
  });

  it('a revision already in the tree\'s history names nothing as git\'s', () => {
    const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-revpath-')));
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', ...a], { cwd: tree, stdio: 'pipe' });
    try {
      g('init', '-q', '-b', 'main', '.');
      fs.writeFileSync(path.join(tree, 'f.txt'), '1\n'); g('add', '-A'); g('commit', '-q', '-m', 'a');
      fs.writeFileSync(path.join(tree, 'f.txt'), '2\n'); g('commit', '-q', '-am', 'b');
      g('checkout', '-q', '-b', 'pr'); fs.writeFileSync(path.join(tree, 'f.txt'), '3\n'); g('commit', '-q', '-am', 'c');
      g('checkout', '-q', 'main');

      expect(fileNamedByGitRevisionPathspec('git checkout HEAD~1 -- f.txt', 'f.txt', tree)).toBe(false);
      expect(fileNamedByGitRevisionPathspec('git restore --source=HEAD~1 f.txt', 'f.txt', tree)).toBe(false);
      expect(fileNamedByGitRevisionPathspec('git checkout pr -- f.txt', 'f.txt', tree)).toBe(true);
      expect(fileNamedByGitRevisionPathspec('git restore -s pr f.txt', 'f.txt', tree)).toBe(true);
      expect(fileNamedByGitRevisionPathspec('git checkout no-such-ref -- f.txt', 'f.txt', tree)).toBe(false);
    } finally { fs.rmSync(tree, { recursive: true, force: true }); }
  });

  it('reads rm, mv and restore arguments, and each segment of a compound command', () => {
    expect(gitPathspecsNamed('git rm -r -q src/legacy && rm NOTES.md').sort()).toEqual(['src/legacy']);
    expect(gitPathspecsNamed('git mv olddir newdir').sort()).toEqual(['newdir', 'olddir']);
    expect(gitPathspecsNamed('git restore --source=HEAD~2 docs').sort()).toEqual(['docs']);
    expect(gitPathspecsNamed('git restore -s HEAD~2 --staged docs').sort()).toEqual(['docs']);
    expect(gitPathspecsNamed('cd x; git add . && git checkout -- config.py').sort()).toEqual(['config.py']);
    expect(gitPathspecsNamed('git -C packages/cli checkout -- src').sort()).toEqual(['packages/cli/src']);
    expect(gitPathspecsNamed('git checkout -- .github/workflows/ci.yml')).toEqual(['.github/workflows/ci.yml']);
    expect(gitPathspecsNamed('git checkout -- .')).toEqual(['']);
  });

  it('names nothing for a checkout of a branch, a read-only git command, or non-git text', () => {
    expect(gitPathspecsNamed('git checkout main')).toEqual([]);
    expect(gitPathspecsNamed('git checkout -b feature')).toEqual([]);
    expect(gitPathspecsNamed('git log -- package.json')).toEqual([]);
    expect(gitPathspecsNamed('git diff HEAD -- src')).toEqual([]);
    expect(gitPathspecsNamed('ls src && cat hooks.ts')).toEqual([]);
    expect(gitPathspecsNamed("echo 'git checkout -- x'")).toEqual([]);
    expect(gitPathspecsNamed('git checkout -- "*.py"')).toEqual([]);
  });

  it('fileNamedInCommand keeps its rule for non-git text and gains git pathspecs', () => {
    expect(fileNamedInCommand('tee README.md', 'README.md')).toBe(false);
    expect(fileNamedInCommand('cat hooks.ts', 'hooks.ts')).toBe(false);
    expect(fileNamedInCommand('ls src', 'src/a.ts')).toBe(false);
    expect(fileNamedInCommand('git checkout HEAD~1 -- package.json', 'package.json')).toBe(true);
    expect(fileNamedInCommand('git rm -r src/legacy', 'src/legacy/a.py')).toBe(true);
    expect(fileNamedInCommand('git rm -r src/legacy', 'src/other.py')).toBe(false);
  });
});

describe('a revert names the files of the commit it reverts', () => {
  let repo: string;
  const git = (a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'git-pathspec-')));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'me@example.com']); git(['config', 'user.name', 'Me']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'a.py'), 'a\n'); fs.writeFileSync(path.join(repo, 'b.py'), 'b\n');
    git(['add', '-A']); git(['commit', '-qm', 'base']);
    fs.writeFileSync(path.join(repo, 'b.py'), 'b2\n');
    git(['add', '-A']); git(['commit', '-qm', 'change b']);
  });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it('resolves the revision against the tree, and is recorded per turn', () => {
    expect(gitPathspecsNamed('git revert --no-commit HEAD', repo)).toEqual(['b.py']);
    expect(gitPathspecsNamed('git revert --no-commit HEAD')).toEqual([]);
    const state: any = {};
    recordGitPathspecs(state, 2, 'git revert --no-commit HEAD', repo);
    recordGitPathspecs(state, 2, 'git checkout HEAD~1 -- lib', repo);
    expect([...filesTurnNamedByGitPathspec(state, 2, ['a.py', 'b.py', 'lib/x.py'])].sort()).toEqual(['b.py', 'lib/x.py']);
    expect(filesTurnNamedByGitPathspec(state, 1, ['b.py']).size).toBe(0);
  });
});
