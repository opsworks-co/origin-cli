import { describe, it, expect } from 'vitest';
import { isFilesystemRootPath } from '../session-state.js';

// session-start skips registering a non-git session anchored at a bare
// filesystem root. The Codex app's internal LLM subroutines (ambient-suggestion
// safety filter, title generation) fire the full hook trio with cwd="/" — each
// one registered a repo-less junk session with tokens estimated from the
// meta-prompt text. No real coding session runs at the filesystem root, so
// dropping the whole lifecycle there is safe for every agent.
describe('isFilesystemRootPath', () => {
  it('matches the unix filesystem root', () => {
    expect(isFilesystemRootPath('/')).toBe(true);
    expect(isFilesystemRootPath('//')).toBe(true); // normalizes to root
  });

  it('does NOT match real directories', () => {
    expect(isFilesystemRootPath('/Users/x')).toBe(false);
    expect(isFilesystemRootPath('/Users/x/code/origin')).toBe(false);
    expect(isFilesystemRootPath('/tmp')).toBe(false);
  });

  it('does NOT match relative paths (they resolve inside cwd)', () => {
    expect(isFilesystemRootPath('.')).toBe(false);
    expect(isFilesystemRootPath('some-dir')).toBe(false);
  });

  it('ignores empty input', () => {
    expect(isFilesystemRootPath('')).toBe(false);
    expect(isFilesystemRootPath(null)).toBe(false);
    expect(isFilesystemRootPath(undefined)).toBe(false);
  });
});
