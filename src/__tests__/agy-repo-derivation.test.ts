// Regression test for the "origin-demo-12 vs origin-demo-1" bug: an Antigravity
// session whose workspace/project is named "origin-demo-12" edited files under
// /Users/.../origin-demo-1 (the REGISTERED repo), but Origin sent the bare
// workspace name as repoPath → server 403 "Repository not registered" → the
// session was kept local and never showed up.
//
// Fix: deriveAgyRepoPath resolves the repo from the git root of the files agy
// ACTUALLY touched, and only falls back to the workspace path / cwd.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveAgyRepoPath } from '../commands/hooks.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('deriveAgyRepoPath', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-demo-1-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@origin.dev');
    git(repo, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'file1.txt'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'seed');
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('uses the git root of the edited files, NOT the bare workspace name', () => {
    const editedFile = path.join(repo, 'file1.txt');
    // The bug scenario: workspace name is a bare string that is not a real path.
    const result = deriveAgyRepoPath([editedFile], 'origin-demo-12', '/nonexistent');
    expect(result).toBe(repo);
  });

  it('resolves a file in a SUBDIR to the repo toplevel', () => {
    fs.mkdirSync(path.join(repo, 'src'));
    const nested = path.join(repo, 'src', 'deep.txt');
    fs.writeFileSync(nested, 'x\n');
    expect(deriveAgyRepoPath([nested], 'origin-demo-12', '/nonexistent')).toBe(repo);
  });

  it('ignores relative paths (only absolute paths resolve a root)', () => {
    // Relative path can't be resolved without a trusted cwd → falls through to
    // the workspace/cwd fallback rather than mis-attributing.
    const result = deriveAgyRepoPath(['relative/file.txt'], 'origin-demo-12', '/nonexistent');
    expect(result).toBe('origin-demo-12'); // raw fallback (no git root anywhere)
  });

  it('falls back to the workspace path when it IS a real git root and no files touched', () => {
    expect(deriveAgyRepoPath([], repo, '/nonexistent')).toBe(repo);
  });

  it('prefers edited-file root even when the workspace path is a different repo', () => {
    // Two real repos: workspace points at one, edits landed in the other. The
    // edits win — that is the whole point (agy reported the wrong workspace).
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-other-')));
    try {
      git(other, 'init', '-q', '-b', 'main');
      git(other, 'config', 'user.email', 'test@origin.dev');
      git(other, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(other, 'seed.txt'), 'x\n');
      git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'seed');
      const editedFile = path.join(repo, 'file1.txt');
      expect(deriveAgyRepoPath([editedFile], other, '/nonexistent')).toBe(repo);
    } finally {
      try { fs.rmSync(other, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
