// The golden matrix for path comparison. Every case here is one that actually
// shipped broken or was caught by CI within a single night.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizePath, samePath, isInsideRepo, toRepoRelativePath } from '../paths.js';

describe('samePath — the cases that actually broke', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-paths-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('matches a symlinked temp root against its resolved form', () => {
    // macOS: os.tmpdir() is /var/... which is a symlink to /private/var/...
    // A raw === here called one directory two, and the worktree resolver
    // silently stopped resolving.
    const resolved = fs.realpathSync.native(dir);
    expect(samePath(dir, resolved)).toBe(true);
  });

  it('matches regardless of separator style', () => {
    // Windows: `git rev-parse --show-toplevel` answers C:/Users/... while node
    // answers C:\Users\... — the exact mismatch that made the main checkout
    // look like a worktree on every turn.
    const withFwd = dir.split(path.sep).join('/');
    expect(samePath(dir, withFwd)).toBe(true);
  });

  it('ignores a trailing separator', () => {
    expect(samePath(dir, dir + path.sep)).toBe(true);
  });

  it('resolves . and .. segments', () => {
    const noisy = path.join(dir, 'a', '..', '.', 'b', '..');
    expect(samePath(dir, noisy)).toBe(true);
  });

  it('does NOT match a sibling whose name merely starts the same', () => {
    // A prefix test without a separator boundary calls <dir>-other "inside".
    expect(samePath(dir, dir + '-other')).toBe(false);
  });

  it('is false for empty or missing input rather than accidentally true', () => {
    expect(samePath('', '')).toBe(false);
    expect(samePath(dir, null)).toBe(false);
    expect(samePath(undefined, undefined)).toBe(false);
  });
});

describe('isInsideRepo', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-root-'))); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('accepts a file that does not exist yet', () => {
    // The common case when RECORDING a write: the file is being created.
    expect(isInsideRepo(root, path.join(root, 'src', 'deep', 'new.ts'))).toBe(true);
  });

  it('accepts the root itself and relative paths', () => {
    expect(isInsideRepo(root, root)).toBe(true);
    expect(isInsideRepo(root, 'src/a.ts')).toBe(true);
  });

  it('REJECTS out-of-repo absolutes', () => {
    // Origin's own memory notes under ~/.claude were being billed as repo work.
    expect(isInsideRepo(root, path.join(os.homedir(), '.claude', 'memory', 'n.md'))).toBe(false);
    expect(isInsideRepo(root, root + '-other/file.ts')).toBe(false);
  });

  it('rejects a parent-escaping path', () => {
    expect(isInsideRepo(root, path.join(root, '..', 'outside.ts'))).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(isInsideRepo('', '/a/b')).toBe(false);
    expect(isInsideRepo(root, '')).toBe(false);
  });
});

describe('toRepoRelativePath', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rel-'))); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('produces forward slashes, which is what git and the ledger use', () => {
    expect(toRepoRelativePath(root, path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
  });

  it('leaves an already-relative path alone, normalising separators', () => {
    expect(toRepoRelativePath(root, 'src/a.ts')).toBe('src/a.ts');
    expect(toRepoRelativePath(root, 'src\\a.ts')).toBe('src/a.ts');
  });

  it('returns an out-of-repo path unchanged — membership is isInsideRepo\'s job', () => {
    const outside = path.join(os.homedir(), '.claude', 'n.md');
    const got = toRepoRelativePath(root, outside);
    expect(got.startsWith('..')).toBe(false);
    expect(path.isAbsolute(got) || got.includes(':')).toBe(true);
  });
});

describe('normalizePath', () => {
  it('returns empty for empty input instead of the cwd', () => {
    // path.resolve('') is the CWD — a silent, very wrong answer here.
    expect(normalizePath('')).toBe('');
    expect(normalizePath(null)).toBe('');
    expect(normalizePath(undefined)).toBe('');
  });

  it('is idempotent', () => {
    const p = normalizePath(os.tmpdir());
    expect(normalizePath(p)).toBe(p);
  });
});
