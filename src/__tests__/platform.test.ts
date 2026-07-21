/**
 * Tests for cross-platform OS detection + executable lookup.
 *
 * The CLI shells out to Unix-only tools (`which`, `pgrep`, `sqlite3`) that
 * don't exist on native Windows. These helpers are the single branch point,
 * so they're mocked/exercised here by overriding `process.platform` (the
 * helpers read it at call time, not module load, precisely so this works).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { isWindows, isWSL, whichCommand, __resetPlatformCache } from '../utils/platform.js';
import { findExecutable } from '../utils/exec.js';

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  __resetPlatformCache();
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  __resetPlatformCache();
  vi.restoreAllMocks();
});

describe('isWindows', () => {
  it('is true only on win32', () => {
    setPlatform('win32');
    expect(isWindows()).toBe(true);
    setPlatform('linux');
    expect(isWindows()).toBe(false);
    setPlatform('darwin');
    expect(isWindows()).toBe(false);
  });
});

describe('whichCommand', () => {
  it('is `where` on native Windows and `which` elsewhere', () => {
    setPlatform('win32');
    expect(whichCommand()).toBe('where');
    setPlatform('linux');
    expect(whichCommand()).toBe('which');
    setPlatform('darwin');
    expect(whichCommand()).toBe('which');
  });
});

describe('isWSL', () => {
  it('is always false on non-linux platforms', () => {
    setPlatform('win32');
    expect(isWSL()).toBe(false);
    setPlatform('darwin');
    expect(isWSL()).toBe(false);
  });
});

describe('findExecutable', () => {
  // Exercises the REAL host lookup — `which node` on mac/linux, `where node`
  // on the windows-latest CI leg (node is on PATH since it runs these tests).
  it('resolves a known executable to an absolute path', () => {
    const p = findExecutable('node');
    expect(p).toBeTruthy();
    expect(p).toMatch(/node/i);
  });

  it('returns null for a name that does not exist', () => {
    const p = findExecutable('definitely-not-a-real-binary-xyzzy');
    expect(p).toBeNull();
  });
});
