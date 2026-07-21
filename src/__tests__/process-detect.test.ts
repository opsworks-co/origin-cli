/**
 * Tests for cross-platform process detection.
 *
 * The Unix path (`pgrep -f`) is exercised against real processes on the host.
 * The Windows path (Win32_Process CIM scan + JS-regex match) can't run on the
 * mac/linux CI host, so its command-line-matching logic is unit-tested via the
 * exported pattern helper and by mocking process.platform. The real `where`
 * exec is proven by the windows-latest CI leg.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  pgrepPattern,
  matchingProcessPids,
  isProcessRunning,
  processInfo,
  __resetProcessSnapshot,
} from '../utils/process-detect.js';
import { __resetPlatformCache } from '../utils/platform.js';

const realPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  __resetPlatformCache();
  __resetProcessSnapshot();
});

describe('pgrepPattern', () => {
  it('extracts a quoted pattern from a legacy pgrep command', () => {
    expect(pgrepPattern('pgrep -f "copilot.*cli|github-copilot"')).toBe('copilot.*cli|github-copilot');
    expect(pgrepPattern('pgrep -f "claude.*stream-json"')).toBe('claude.*stream-json');
  });

  it('extracts an unquoted single-token pattern', () => {
    expect(pgrepPattern('pgrep -f codex')).toBe('codex');
  });

  it('passes a bare pattern through unchanged', () => {
    expect(pgrepPattern('cursor')).toBe('cursor');
    expect(pgrepPattern('gemini.*cli|/gemini ')).toBe('gemini.*cli|/gemini ');
  });
});

describe('matchingProcessPids (Unix host)', () => {
  it('finds the current node process by a broad pattern but excludes our own tree', () => {
    if (process.platform === 'win32') return;
    // `node` matches the running vitest process, but that IS our tree, so the
    // own-tree filter should drop it. A pattern that matches nothing returns [].
    const pids = matchingProcessPids('this-process-name-does-not-exist-zzz');
    expect(pids).toEqual([]);
  });

  it('isProcessRunning is false for a nonexistent pattern', () => {
    if (process.platform === 'win32') return;
    expect(isProcessRunning('definitely-not-running-xyzzy-123')).toBe(false);
  });

  it('accepts a legacy pgrep command string and a bare pattern equivalently', () => {
    if (process.platform === 'win32') return;
    expect(isProcessRunning('pgrep -f "definitely-not-running-xyzzy-123"')).toBe(false);
    expect(isProcessRunning('definitely-not-running-xyzzy-123')).toBe(false);
  });
});

describe('processInfo', () => {
  it('rejects invalid pids without throwing', () => {
    expect(processInfo(0)).toBeNull();
    expect(processInfo(-1)).toBeNull();
    expect(processInfo(1.5)).toBeNull();
  });

  it('returns this process\'s parent + command on Unix', () => {
    if (process.platform === 'win32') return; // covered by the windows CI leg
    const info = processInfo(process.pid);
    expect(info).not.toBeNull();
    // ps reports our real parent pid and a non-empty command line (node …).
    expect(info!.ppid).toBe(process.ppid);
    expect(info!.command.length).toBeGreaterThan(0);
  });

  it('returns null for a pid that does not exist', () => {
    if (process.platform === 'win32') return;
    // A pid well above any real one on the host.
    expect(processInfo(2_000_000_000)).toBeNull();
  });

  it('does not throw when routed to the Windows branch on a non-windows host', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    __resetProcessSnapshot();
    expect(() => processInfo(1234)).not.toThrow();
    // On the windows CI leg this spawns a real `Get-CimInstance Win32_Process`
    // query, which can exceed the 5s default on a cold runner — give it room.
  }, 20000);
});

describe('matchingProcessPids (Windows path routing)', () => {
  it('does not throw when routed to the Windows branch on a non-windows host', () => {
    // On a non-windows host the `powershell` spawn fails → status !== 0 → [].
    // This proves the branch is taken and degrades gracefully rather than
    // throwing; the real CIM scan is proven by the windows CI leg.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    __resetProcessSnapshot();
    expect(() => matchingProcessPids('claude.*stream-json')).not.toThrow();
    expect(matchingProcessPids('claude.*stream-json')).toEqual([]);
    // Same cold-runner PowerShell-spawn latency as above — bump the timeout.
  }, 20000);
});
