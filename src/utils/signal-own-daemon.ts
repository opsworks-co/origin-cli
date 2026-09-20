// Signal a daemon named by a PID FILE — only if that pid is still the daemon.
//
// A pid file outlives its process whenever the process does not get to clean
// up: the heartbeat is SIGKILLed by a sleeping Mac, a watcher dies with the
// machine. The number is then free, and the OS hands it to whatever starts
// next. `process.kill(pidFromFile)` with no further question sends the signal
// to THAT process: on a developer's machine an editor or another agent, days
// after the session that wrote the file; in this repo's own test suite, which
// goes through ~1,500 pids a second and wraps the pid space in about a minute,
// a vitest fork or a `git` child inside a hook.
//
// "Alive" is not the question — the stranger is alive too. The question is
// whether the command line is the one we started.
import { debugLog } from '../debug-log.js';
import { processInfo } from './process-detect.js';

export type SignalOutcome =
  /** The signal was sent. */
  | 'signalled'
  /** Nothing holds that pid (or the pid is unusable). */
  | 'gone'
  /** Something holds it, and its command line is not ours. */
  | 'not-ours'
  /** Something holds it and we could not read its command line: not signalled. */
  | 'unknown';

export interface SignalDeps {
  processInfo: (pid: number) => { ppid: number; command: string } | null;
  kill: (pid: number, signal?: NodeJS.Signals | 0) => void;
}

const REAL: SignalDeps = {
  processInfo,
  kill: (pid, signal) => { process.kill(pid, signal as NodeJS.Signals | 0); },
};

/**
 * Send `signal` to `pid` when `isOurs` accepts its command line.
 *
 * Refuses when in doubt. Every daemon this guards also stops on its own once
 * its pid file is gone or taken over, and each caller removes that file, so a
 * daemon left unsignalled is gone within a tick — while a stranger signalled is
 * not recoverable. Never throws.
 */
export function signalOwnDaemon(
  pid: number,
  what: string,
  isOurs: (command: string) => boolean,
  signal: NodeJS.Signals = 'SIGTERM',
  deps: SignalDeps = REAL,
): SignalOutcome {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return 'gone';
  // Liveness first: it is free. The usual stale pid file names a DEAD process
  // (SIGKILL, a reboot), and reading a command line is a `ps` spawn — on
  // Windows a whole Win32_Process snapshot, about a second — inside hooks that
  // have timed out before. Session-start pays it once per orphaned session.
  let alive = false;
  try { deps.kill(pid, 0); alive = true; } catch (err: unknown) {
    // EPERM: it exists and belongs to someone else — certainly not ours to stop.
    alive = (err as { code?: string } | null)?.code === 'EPERM';
  }
  if (!alive) return 'gone';
  let info: { ppid: number; command: string } | null = null;
  try { info = deps.processInfo(pid); } catch { info = null; }
  if (!info || !info.command) {
    debugLog('daemon', 'pid file names a live process whose command could not be read — not signalled', { what, pid });
    return 'unknown';
  }
  let ours = false;
  try { ours = isOurs(info.command); } catch { ours = false; }
  if (!ours) {
    debugLog('daemon', 'pid file names a process that is not ours — not signalled', {
      what, pid, command: info.command.slice(0, 160),
    });
    return 'not-ours';
  }
  try { deps.kill(pid, signal); } catch { return 'gone'; }
  return 'signalled';
}

/** The heartbeat daemon `startHeartbeat` spawns for `sessionId`: `node …/heartbeat.js <sessionId> …`. */
export function isHeartbeatFor(sessionId: string): (command: string) => boolean {
  return (command) => !!sessionId && /heartbeat(\.[cm]?js)?\b/i.test(command) && command.includes(sessionId);
}

/** A CLI daemon started as `node <entry> <subcommand>` (`transcript-watch`, `codex-watch`). */
export function isCliDaemon(subcommand: string): (command: string) => boolean {
  const re = new RegExp(`(^|[\\s"'])${subcommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s"'])`);
  return (command) => re.test(command);
}
