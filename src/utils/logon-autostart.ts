/**
 * Windows logon auto-start for the watcher daemons.
 *
 * The watchers spawn detached, but a detached process still dies with the
 * login session — so surviving a reboot needs a persistence hook. We used to
 * register one with `schtasks /Create /F /SC ONLOGON`. That does not work on a
 * default Windows 11 install: Defender's behavioral ML classifies the
 * `schtasks /Create /SC ONLOGON` command line itself as
 * `Trojan:Win32/Commando.A!ml` — creating a logon task from a script is a
 * textbook malware persistence pattern, and the heuristic does not care that
 * the payload is node.exe. Defender blocks the call, `origin enable` swallowed
 * the error and printed success, and the tasks never existed. Observed on this
 * machine six times across two weeks: watchers alive for the session, gone
 * after every reboot, no warning anywhere.
 *
 * So we persist with a plain file instead: a `.cmd` in the per-user Startup
 * folder. No subprocess, no scheduler, no registry — a file write Defender has
 * no reason to look at. It also needs no elevation and is trivially reversible
 * (delete the file). The registry Run key was the other candidate; it is just
 * as heuristically radioactive as schtasks and buys nothing here.
 *
 * The .cmd runs `origin <subcommand> --ensure`, NOT the watcher itself: the
 * `--ensure` path re-spawns the daemon detached with `windowsHide` and exits
 * immediately, so the watcher ends up with no console attached and survives
 * the .cmd's console closing. Running the daemon inline instead would either
 * pin a console window open for the whole session or (via `start /b`) leave it
 * attached to a console that is about to be destroyed, which kills it.
 *
 * Cost of this approach: the .cmd's own console flashes for a few hundred ms
 * at logon while node boots. A `.lnk` could hide that, but writing the Shell
 * Link binary by hand is a lot of fragile code and the COM route means
 * spawning a script host — another persistence-shaped command line. A brief
 * flash beats persistence that silently does not exist.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { isWindows } from './platform.js';

export interface LogonAutoStartResult {
  registered: boolean;
  /** Machine-readable outcome, e.g. `startup-cmd-created` or `write-failed: …`. */
  reason: string;
  /** Absolute path to the Startup entry, when one was written or is current. */
  file?: string;
}

/**
 * The per-user Startup folder. `%APPDATA%` is authoritative when set (it moves
 * with a redirected profile); the homedir join is the fallback.
 */
export function startupFolder(): string {
  const appData = process.env.APPDATA;
  const base = appData && appData.trim()
    ? appData
    : path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** Absolute path of the Startup entry for a given registration name. */
export function startupEntryPath(name: string): string {
  return path.join(startupFolder(), `${name}.cmd`);
}

function startupCmdBody(name: string, entryScript: string, subcommand: string): string {
  // CRLF: this is a batch file read by cmd.exe.
  return [
    '@echo off',
    `REM ${name} — Origin watcher auto-start. Written by \`origin enable\`.`,
    'REM Safe to delete: capture keeps working this session, it just stops',
    'REM surviving reboots until the next `origin enable`.',
    `"${process.execPath}" "${entryScript}" ${subcommand} --ensure --quiet`,
    '',
  ].join('\r\n');
}

/**
 * Drop (or refresh) the Startup entry that relaunches a watcher at logon.
 * Windows-only; a no-op that reports why on every other platform. Idempotent —
 * rewrites only when the desired command line differs from what is on disk.
 */
export function registerLogonAutoStart(opts: {
  /** Registration name; also the legacy Scheduled Task name we clean up. */
  name: string;
  /** Absolute path to the CLI's dist/index.js. */
  entryScript: string;
  /** The watcher subcommand, e.g. `codex-watch`. */
  subcommand: string;
}): LogonAutoStartResult {
  const { name, entryScript, subcommand } = opts;
  if (!isWindows()) return { registered: false, reason: 'not-windows' };
  if (!entryScript) return { registered: false, reason: 'no-entry-script' };

  const dir = startupFolder();
  const file = startupEntryPath(name);
  const body = startupCmdBody(name, entryScript, subcommand);

  try {
    if (!fs.existsSync(dir)) return { registered: false, reason: `no-startup-folder: ${dir}` };
    let current: string | null = null;
    try { current = fs.readFileSync(file, 'utf-8'); } catch { /* absent — write it */ }
    if (current === body) {
      removeLegacyLogonTask(name);
      return { registered: true, reason: 'startup-cmd-current', file };
    }
    fs.writeFileSync(file, body, 'utf-8');
    removeLegacyLogonTask(name);
    return { registered: true, reason: 'startup-cmd-created', file };
  } catch (err) {
    return { registered: false, reason: `startup-cmd-failed: ${String(err)}`, file };
  }
}

/** Remove a Startup entry. Reports success when there was nothing to remove. */
export function unregisterLogonAutoStart(name: string): LogonAutoStartResult {
  if (!isWindows()) return { registered: false, reason: 'not-windows' };
  const file = startupEntryPath(name);
  try {
    fs.rmSync(file, { force: true });
    return { registered: false, reason: 'startup-cmd-removed', file };
  } catch (err) {
    return { registered: false, reason: `startup-cmd-remove-failed: ${String(err)}`, file };
  }
}

/**
 * Best-effort removal of the old `schtasks` logon task, for the machines where
 * it DID get created (Defender off, or an older Windows build). Leaving it
 * behind is not dangerous — a double start is a no-op against the watcher's
 * pid file — but it is stale persistence pointing at a path that `origin
 * upgrade` may move. `/Delete` is not the pattern Defender flags; `/Create` is.
 */
function removeLegacyLogonTask(taskName: string): void {
  try {
    execFileSync('schtasks', ['/Delete', '/F', '/TN', taskName], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { /* task absent, or schtasks unavailable — nothing to clean up */ }
}
