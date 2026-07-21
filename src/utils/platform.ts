/**
 * Platform detection — the single source of truth for OS branching.
 *
 * The CLI shells out to Unix-only tools (`which`, `pgrep`, `sqlite3`,
 * `#!/bin/sh` hooks) that don't exist on native Windows. Every OS branch
 * routes through the helpers here so the Windows fallbacks live in one place
 * and stay testable — these are FUNCTIONS, not module-load constants, so a
 * test can `Object.defineProperty(process, 'platform', …)` and re-evaluate.
 *
 * WSL note: WSL2 reports `process.platform === 'linux'` and ships the full
 * Unix toolchain, so it already works and is treated as Linux. `isWSL()` only
 * exists for the rare spot that must tell WSL apart from a bare Linux host —
 * never branch Windows behavior on it.
 */
import os from 'os';
import fs from 'fs';

/** True on native Windows (PowerShell/cmd). NOT true under WSL (that is linux). */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

let wslCache: boolean | undefined;

/**
 * True when running under the Windows Subsystem for Linux. WSL is Linux for
 * every tool we shell out to, so this should almost never gate behavior — use
 * it only where the WSL-vs-native distinction genuinely matters.
 */
export function isWSL(): boolean {
  if (wslCache !== undefined) return wslCache;
  if (process.platform !== 'linux') return (wslCache = false);
  try {
    if (/microsoft|wsl/i.test(os.release())) return (wslCache = true);
  } catch { /* fall through to /proc/version */ }
  try {
    return (wslCache = /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf-8')));
  } catch {
    return (wslCache = false);
  }
}

/** Test-only: clear the memoized WSL detection after mutating process.platform. */
export function __resetPlatformCache(): void {
  wslCache = undefined;
}

/**
 * The binary-lookup command for this platform: `where` on native Windows,
 * `which` on macOS/Linux/WSL. Prefer `findExecutable` (utils/exec) over
 * calling this directly — it also normalizes the multi-line `where` output.
 */
export function whichCommand(): string {
  return isWindows() ? 'where' : 'which';
}
