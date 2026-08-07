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
  // Stamped as the daemon polls. A live pid only proves the PROCESS exists —
  // a watcher wedged on a hung git call looks identical to a healthy one from
  // the outside. This is the difference between "running" and "working".
  // Absent on daemons from builds before it existed.
  lastCycleAt?: string;
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

// Throttle: the daemons poll every 8s and this only feeds a health readout, so
// a write per 30s is plenty and keeps the disk quiet.
const TOUCH_THROTTLE_MS = 30_000;
const lastTouchedAt = new Map<string, number>();

/**
 * Mark that the daemon owning `pidFile` just finished a poll cycle. Only the
 * owning process stamps its own sidecar, so a stale file from a dead daemon
 * can never look fresh.
 */
export function touchWatchMeta(pidFile: string, now = Date.now()): void {
  try {
    const p = watchMetaPath(pidFile);
    if (now - (lastTouchedAt.get(p) || 0) < TOUCH_THROTTLE_MS) return;
    const meta = readWatchMeta(pidFile);
    if (!meta || meta.pid !== process.pid) return;
    lastTouchedAt.set(p, now);
    fs.writeFileSync(p, JSON.stringify({ ...meta, lastCycleAt: new Date(now).toISOString() }), { mode: 0o600 });
  } catch { /* health telemetry is never worth failing a cycle over */ }
}

// A daemon that hasn't completed a cycle in this long has stopped working even
// if its process is still there. Poll is 8s, so this is ~37 missed cycles —
// far past any plausible slow git call.
export const STALLED_AFTER_MS = 5 * 60_000;

export type WatchHealthState = 'ok' | 'stale-build' | 'stalled' | 'dead' | 'stopped';

export interface WatchHealth {
  state: WatchHealthState;
  pid?: number;
  version?: string;
  startedAt?: string;
  lastCycleAt?: string;
  sinceLastCycleMs?: number;
}

/**
 * What a watcher daemon is actually doing right now.
 *
 * Distinguishes the states that matter operationally, which `watchFreshness`
 * (built for the restart decision) collapses:
 *
 *   stopped     no pid file — cleanly stopped, or never started
 *   dead        pid file, no process — it crashed; NOTHING is being captured
 *   stalled     process alive but not polling — wedged; also capturing nothing
 *   stale-build polling fine, but on older code than the installed CLI
 *   ok          alive and polling on the current build
 */
export function watchHealth(
  pidFile: string,
  installedVersion = cliVersion(),
  now = Date.now(),
): WatchHealth {
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch {
    return { state: 'stopped' };
  }
  const meta = readWatchMeta(pidFile);
  const base: WatchHealth = {
    state: 'ok',
    pid,
    version: meta?.version,
    startedAt: meta?.startedAt,
    lastCycleAt: meta?.lastCycleAt,
  };
  if (!pidAlive(pid)) return { ...base, state: 'dead' };
  if (meta?.lastCycleAt) {
    const since = now - new Date(meta.lastCycleAt).getTime();
    if (Number.isFinite(since) && since > STALLED_AFTER_MS) {
      return { ...base, state: 'stalled', sinceLastCycleMs: since };
    }
    base.sinceLastCycleMs = Math.max(0, since);
  }
  if (meta && meta.version !== installedVersion) return { ...base, state: 'stale-build' };
  return base;
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
