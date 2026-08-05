// `origin ignore repo` — machine-wide repo exclusion. These cover the pure
// matching logic that the session-start / auto-create / migration gates rely on:
// an ignored entry must match itself and everything nested under it, but never a
// sibling that merely shares a name prefix, and must survive ~-expansion and
// (on case-insensitive filesystems) case variance.
import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { normalizeRepoPath, matchIgnoredRepo } from '../ignore-repos.js';

const HOME = os.homedir();

describe('normalizeRepoPath', () => {
  it('expands a leading ~ to the home dir', () => {
    expect(normalizeRepoPath('~/.openclaw/workspace')).toBe(path.join(HOME, '.openclaw/workspace'));
    expect(normalizeRepoPath('~')).toBe(HOME);
  });
  it('resolves to an absolute path and strips a trailing separator', () => {
    expect(normalizeRepoPath('/a/b/')).toBe(path.resolve('/a/b'));
  });
  it('returns empty for empty/nullish input', () => {
    expect(normalizeRepoPath('')).toBe('');
    expect(normalizeRepoPath(undefined)).toBe('');
    expect(normalizeRepoPath(null)).toBe('');
  });
});

describe('matchIgnoredRepo', () => {
  const IGNORED = ['~/.openclaw/workspace'];

  it('matches the exact repo and returns the ORIGINAL entry (for display)', () => {
    expect(matchIgnoredRepo(path.join(HOME, '.openclaw/workspace'), IGNORED)).toBe('~/.openclaw/workspace');
  });

  it('matches a path NESTED under an ignored entry (worktrees, subdirs)', () => {
    expect(matchIgnoredRepo(path.join(HOME, '.openclaw/workspace/sub/dir'), IGNORED)).toBe('~/.openclaw/workspace');
  });

  it('does NOT match a sibling that only shares a name prefix (separator boundary)', () => {
    expect(matchIgnoredRepo(path.join(HOME, '.openclaw/workspace-2'), IGNORED)).toBeNull();
    expect(matchIgnoredRepo(path.join(HOME, '.openclaw/workspaceX'), IGNORED)).toBeNull();
  });

  it('does NOT match an unrelated repo', () => {
    expect(matchIgnoredRepo('/Users/x/Documents/Coding/origin', IGNORED)).toBeNull();
  });

  it('normalizes both sides — ~, abs, and trailing slash all match the same entry', () => {
    const abs = path.join(HOME, '.openclaw/workspace');
    expect(matchIgnoredRepo(abs + '/', IGNORED)).toBe('~/.openclaw/workspace');
    expect(matchIgnoredRepo(abs, [abs])).toBe(abs);
    expect(matchIgnoredRepo(abs, [abs + '/'])).toBe(abs + '/');
  });

  it('returns null for empty inputs (no repo, or empty list)', () => {
    expect(matchIgnoredRepo('', IGNORED)).toBeNull();
    expect(matchIgnoredRepo(path.join(HOME, '.openclaw/workspace'), [])).toBeNull();
    expect(matchIgnoredRepo(path.join(HOME, '.openclaw/workspace'), undefined)).toBeNull();
  });

  it('is case-insensitive on darwin/win32, case-sensitive on linux', () => {
    const entry = path.join(HOME, '.openclaw/Workspace');
    const variant = path.join(HOME, '.openclaw/workspace');
    const res = matchIgnoredRepo(variant, [entry]);
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(res).toBe(entry);
    } else {
      expect(res).toBeNull();
    }
  });

  it('matches when ANY of several entries covers the repo', () => {
    const list = ['/tmp/other', '~/.openclaw/workspace', '/var/x'];
    expect(matchIgnoredRepo(path.join(HOME, '.openclaw/workspace'), list)).toBe('~/.openclaw/workspace');
  });
});
