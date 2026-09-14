/**
 * `readFileAtRev` must read hidden repo paths.
 *
 * Session 9a1ef9e3 turn 3 checked out `origin/main` and the ledger billed
 * `.github/workflows/test.yml` as a 312-line creation. The cwd-escape guard
 * was `relPath.startsWith('.')`, which also matches `.github/…`. A miss
 * there is a miss in every producer that uses this helper for a before-state
 * (inherited window, shadow baseline, Codex hunk anchoring).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { isUnsafeGitShowPath, readFileAtRev } from '../git-capture.js';

const gitIn = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

describe('isUnsafeGitShowPath', () => {
  it('allows hidden repo paths and ordinary relatives', () => {
    expect(isUnsafeGitShowPath('.github/workflows/test.yml')).toBe(false);
    expect(isUnsafeGitShowPath('.gitignore')).toBe(false);
    expect(isUnsafeGitShowPath('.origin/state.json')).toBe(false);
    expect(isUnsafeGitShowPath('src/git-capture.ts')).toBe(false);
  });

  it('rejects cwd-relative, parent, and absolute paths', () => {
    expect(isUnsafeGitShowPath('./src/foo.ts')).toBe(true);
    expect(isUnsafeGitShowPath('../secret')).toBe(true);
    expect(isUnsafeGitShowPath('foo/../bar')).toBe(true);
    expect(isUnsafeGitShowPath('/etc/passwd')).toBe(true);
    expect(isUnsafeGitShowPath('C:\\Windows\\system.ini')).toBe(true);
    expect(isUnsafeGitShowPath('')).toBe(true);
  });
});

describe('readFileAtRev reads hidden repo paths', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-dotfile-')));
    gitIn(dir, ['init', '-q', '-b', 'main']);
    gitIn(dir, ['config', 'user.email', 't@t.co']);
    gitIn(dir, ['config', 'user.name', 'T']);
    gitIn(dir, ['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'test.yml'), 'name: ci\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '-q', '-m', 'seed']);
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns .github and .gitignore content at HEAD', () => {
    const sha = gitIn(dir, ['rev-parse', 'HEAD']);
    expect(readFileAtRev(dir, sha, '.github/workflows/test.yml')).toBe('name: ci\n');
    expect(readFileAtRev(dir, sha, '.gitignore')).toBe('node_modules\n');
  });

  it('still refuses ./ and ../ so git cannot resolve against cwd', () => {
    const sha = gitIn(dir, ['rev-parse', 'HEAD']);
    expect(readFileAtRev(dir, sha, './.github/workflows/test.yml')).toBeNull();
    expect(readFileAtRev(dir, sha, '../.github/workflows/test.yml')).toBeNull();
  });
});
