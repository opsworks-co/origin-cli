import { describe, it, expect } from 'vitest';
import { isCoworkContainerPath } from '../session-state.js';

// session-start skips registering a throwaway "workspace" session when a bare
// `claude` is launched AT the openclaw cowork container (no repo, no work) —
// the ~40s warm-up/probe launches that flooded the Sessions list. This pins
// the container-detection so it drops ONLY the empty container, never a repo
// inside it and never an unrelated `~/workspace` project.
describe('isCoworkContainerPath', () => {
  it('matches the bare .openclaw/workspace container', () => {
    expect(isCoworkContainerPath('/Users/x/.openclaw/workspace')).toBe(true);
    expect(isCoworkContainerPath('/Users/x/.openclaw/workspace/')).toBe(true); // trailing slash
    expect(isCoworkContainerPath('/home/user/.openclaw/workspace')).toBe(true);
  });

  it('does NOT match a repo SUBDIR inside the container (real work is tracked)', () => {
    expect(isCoworkContainerPath('/Users/x/.openclaw/workspace/my-repo')).toBe(false);
    expect(isCoworkContainerPath('/Users/x/.openclaw/workspace/a/b')).toBe(false);
  });

  it('does NOT match a bare ~/workspace (commonly a real project dir)', () => {
    expect(isCoworkContainerPath('/Users/x/workspace')).toBe(false);
    expect(isCoworkContainerPath('/Users/x/projects/workspace')).toBe(false);
  });

  it('does NOT match unrelated paths or empty input', () => {
    expect(isCoworkContainerPath('/Users/x/code/origin')).toBe(false);
    expect(isCoworkContainerPath('')).toBe(false);
    expect(isCoworkContainerPath(null)).toBe(false);
    expect(isCoworkContainerPath(undefined)).toBe(false);
  });
});
