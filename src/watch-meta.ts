// ---------------------------------------------------------------------------
// Which CODE VERSION a watcher daemon is actually running
// ---------------------------------------------------------------------------
//
// `origin upgrade` restarts the watchers after it installs, so the daemons pick
// up the new code. But a daemon can be stale WITHOUT an install happening in
// that invocation:
//
//   • the CLI arrived some other way (`npm install -g`, a tarball, a repo
//     build) and never went through `origin upgrade` at all, or
//   • a previous `origin upgrade` installed while this daemon was already
//     running and something restarted it back onto the old entry point.
//
// In those cases `origin upgrade` prints "Already up to date!" and returns
// before it reaches the restart, and the daemon keeps executing whatever it
// loaded at spawn — until a reboot or its 24h lifetime cap. Observed live: the
// codex watcher ran 0.20260804.2042 for 20+ minutes after the machine was on
// 0.20260805.2011, so it was capturing sessions without a fix that had already
// shipped.
//
// The pid file holds only a pid, which cannot answer "and what code is that?".
// Each watcher now drops a sidecar next to it recording the version it booted
// with, so `origin upgrade` can cycle a stale daemon even on the up-to-date
// path.
//
// A daemon that predates this sidecar reports `unknown` and is treated as
// stale, so every already-running watcher self-heals exactly once. A restart is
// cheap and idempotent (the fresh daemon re-reads all its state from disk), so
// erring toward restarting is the safe direction.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface WatchMeta {
  pid: number;
  version: string;
  startedAt: string;
}

/** Sidecar path for a watcher's pid file: `<name>.pid` → `<name>.meta.json`. */
export function watchMetaPath(pidFile: string): string {
  return pidFile.replace(/\.pid$/, '') + '.meta.json';
}

/**
 * This CLI build's version. Resolved the same way as commands/upgrade.ts —
 * via fileURLToPath, NOT `new URL(...).pathname`, which prepends a bogus slash
 * before the drive letter on Windows and made every read fall back to 0.0.0.
 * dist/watch-meta.js → one level up is the package root.
 */
export function cliVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Record the version this daemon booted with. Best-effort; never throws. */
export function writeWatchMeta(pidFile: string, version = cliVersion(), pid = process.pid): void {
  try {
    const p = watchMetaPath(pidFile);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const meta: WatchMeta = { pid, version, startedAt: new Date().toISOString() };
    fs.writeFileSync(p, JSON.stringify(meta), { mode: 0o600 });
  } catch { /* the sidecar is an optimisation — losing it just forces a restart */ }
}

export function readWatchMeta(pidFile: string): WatchMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(watchMetaPath(pidFile), 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.pid !== 'number' || typeof parsed.version !== 'string') return null;
    return parsed as WatchMeta;
  } catch {
    return null;
  }
}

export function removeWatchMeta(pidFile: string): void {
  try { fs.unlinkSync(watchMetaPath(pidFile)); } catch { /* ignore */ }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = alive but owned by another user; only ESRCH means "no such pid".
    return err?.code === 'EPERM';
  }
}

export type WatchFreshness = 'not-running' | 'current' | 'stale';

/**
 * Whether the daemon owning `pidFile` is running `installedVersion`.
 *
 * `stale` covers three cases, all of which want a restart: a recorded version
 * that differs, a sidecar from a DIFFERENT pid (the daemon was replaced without
 * rewriting it), and no sidecar at all (a daemon predating this mechanism).
 */
export function watchFreshness(pidFile: string, installedVersion = cliVersion()): WatchFreshness {
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch {
    return 'not-running';
  }
  if (!pidAlive(pid)) return 'not-running';
  const meta = readWatchMeta(pidFile);
  if (!meta || meta.pid !== pid) return 'stale';
  return meta.version === installedVersion ? 'current' : 'stale';
}
