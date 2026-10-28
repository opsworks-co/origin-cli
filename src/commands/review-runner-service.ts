// `origin review runner install|uninstall|status` — the reviewer daemon as a
// user service, so runs queued by PR events drain with no terminal open.
//
// macOS: a launchd agent, ~/Library/LaunchAgents/io.getorigin.review-runner.plist.
// Linux: a systemd user unit, ~/.config/systemd/user/origin-review-runner.service.
// Both restart the daemon on EVERY exit (launchd KeepAlive, systemd
// Restart=always): the daemon exits 0 when `origin upgrade` put a newer binary
// on disk and 1 after repeated poll failures, and in both cases the service
// manager's respawn is what brings it back — on the new binary, with a fresh
// connection pool (see review-runner.ts and benchmark-runner.ts).
//
// The service runs node on the CLI's bin link (`…/bin/origin`), never the
// resolved install folder: `origin upgrade` repoints the link and the old
// folder dies, which is why the url-handler does the same (selfCommand).
// Both files are written by pure builders so their text is testable.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { selfCommand } from '../url-handler.js';

export const SERVICE_LABEL = 'io.getorigin.review-runner';
export const LINUX_UNIT = 'origin-review-runner.service';
export const SERVICE_LOG_NAME = 'review-runner.log';

/** Everything a service file needs; resolved by `serviceSpec`, built into text by the builders. */
export interface ServiceSpec {
  /** The node binary and the CLI entry (bin link), as `selfCommand` gives them. */
  node: string;
  entry: string;
  /** The CLI arguments after the entry: `review runner [--repo …] [--interval n]`. */
  args: string[];
  /** Where the daemon runs: its cwd's repo is one of the checkouts it watches. */
  cwd: string;
  /** Both stdout and stderr go here. */
  logFile: string;
  /** The installing shell's PATH — a service manager's own is too short for git and the agents. */
  pathEnv: string | null;
}

export function serviceLogFile(home: string = os.homedir()): string {
  return path.join(home, '.origin', SERVICE_LOG_NAME);
}

/** Where the service file lives on this platform, or null where there is no user service manager to write for. */
export function serviceFile(platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string | null {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  if (platform === 'linux') return path.join(home, '.config', 'systemd', 'user', LINUX_UNIT);
  return null;
}

/**
 * The daemon's arguments for the service: `--repo` paths made absolute (the
 * service's cwd is not the shell's) and the interval passed through. Pure.
 */
export function runnerServiceArgs(opts: { repo?: string[]; interval?: string }, cwd: string): string[] {
  const args = ['review', 'runner'];
  if (opts.repo && opts.repo.length > 0) args.push('--repo', ...opts.repo.map((p) => path.resolve(cwd, p)));
  if (opts.interval) args.push('--interval', String(opts.interval));
  return args;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The launchd agent (macOS). Pure. */
export function launchdPlist(spec: ServiceSpec): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${SERVICE_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[spec.node, spec.entry, ...spec.args].map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(spec.cwd)}</string>`,
  ];
  if (spec.pathEnv) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>', `    <key>PATH</key><string>${xml(spec.pathEnv)}</string>`, '  </dict>');
  }
  lines.push(
    '  <key>RunAtLoad</key><true/>',
    // true, not {SuccessfulExit: false}: the daemon's exit 0 on upgrade must be respawned too.
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    `  <key>StandardOutPath</key><string>${xml(spec.logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(spec.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  );
  return lines.join('\n');
}

/** systemd's command-line quoting: double quotes, with " \ escaped. */
function unitQuote(s: string): string {
  return `"${s.replace(/(["\\])/g, '\\$1')}"`;
}

/** The systemd user unit (Linux). Pure. */
export function systemdUnit(spec: ServiceSpec): string {
  const lines = [
    '[Unit]',
    'Description=Origin reviewer runner (origin review runner)',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${[spec.node, spec.entry, ...spec.args].map(unitQuote).join(' ')}`,
    `WorkingDirectory=${spec.cwd}`,
  ];
  if (spec.pathEnv) lines.push(`Environment=${unitQuote(`PATH=${spec.pathEnv}`)}`);
  lines.push(
    // always, not on-failure: the daemon's exit 0 on upgrade must be respawned too.
    'Restart=always',
    'RestartSec=5',
    `StandardOutput=append:${spec.logFile}`,
    `StandardError=append:${spec.logFile}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  );
  return lines.join('\n');
}

/** The service file's text for a platform. Pure. */
export function serviceFileText(platform: NodeJS.Platform, spec: ServiceSpec): string {
  if (platform === 'darwin') return launchdPlist(spec);
  if (platform === 'linux') return systemdUnit(spec);
  throw new Error(`no background service on ${platform}: run \`origin review runner\` in a terminal (or a scheduled task running it with --once)`);
}

export interface ServiceStatus {
  installed: boolean;
  file: string | null;
  /** null when the service manager could not be asked. */
  running: boolean | null;
  pid: number | null;
}

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err: any) {
    return { ok: false, out: String(err?.stdout || '') + String(err?.stderr || '') };
  }
}

function launchdTarget(): string {
  return `gui/${os.userInfo().uid}`;
}

export function reviewRunnerServiceStatus(platform: NodeJS.Platform = process.platform): ServiceStatus {
  const file = serviceFile(platform);
  const installed = !!file && fs.existsSync(file);
  if (!installed) return { installed: false, file, running: false, pid: null };
  if (platform === 'darwin') {
    const r = sh('launchctl', ['print', `${launchdTarget()}/${SERVICE_LABEL}`]);
    if (!r.ok) return { installed, file, running: false, pid: null };
    const pid = r.out.match(/^\s*pid = (\d+)/m);
    return { installed, file, running: !!pid, pid: pid ? Number(pid[1]) : null };
  }
  const active = sh('systemctl', ['--user', 'is-active', LINUX_UNIT]);
  const pidOut = sh('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', LINUX_UNIT]);
  const pid = Number(pidOut.out.trim());
  return { installed, file, running: active.out.trim() === 'active', pid: pid > 0 ? pid : null };
}

/** The spec for this install: this CLI, these args, the shell's PATH, `~/.origin/review-runner.log`. */
export function serviceSpec(opts: { repo?: string[]; interval?: string }, cwd: string = process.cwd()): ServiceSpec {
  const [node, entry] = selfCommand();
  return { node, entry, args: runnerServiceArgs(opts, cwd), cwd, logFile: serviceLogFile(), pathEnv: process.env.PATH || null };
}

/**
 * Write the service file and start (or restart) the service. Returns the
 * file. Throws with the manager's output when it refuses.
 */
export function installReviewRunnerService(spec: ServiceSpec, platform: NodeJS.Platform = process.platform): string {
  const file = serviceFile(platform);
  if (!file) throw new Error(serviceFileText(platform, spec)); // the "no service here" message
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
  fs.writeFileSync(file, serviceFileText(platform, spec));
  if (platform === 'darwin') {
    // Out first so a re-install picks up the new file; a service not loaded is fine.
    sh('launchctl', ['bootout', `${launchdTarget()}/${SERVICE_LABEL}`]);
    const r = sh('launchctl', ['bootstrap', launchdTarget(), file]);
    if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out.trim() || 'unknown error'}`);
    return file;
  }
  const reload = sh('systemctl', ['--user', 'daemon-reload']);
  if (!reload.ok) throw new Error(`systemctl --user daemon-reload failed: ${reload.out.trim() || 'is systemd running your user session?'}`);
  const enable = sh('systemctl', ['--user', 'enable', '--now', LINUX_UNIT]);
  if (!enable.ok) throw new Error(`systemctl --user enable failed: ${enable.out.trim()}`);
  sh('systemctl', ['--user', 'restart', LINUX_UNIT]); // a re-install picks up the new file
  return file;
}

/** Stop the service and remove its file. False when there was none. */
export function uninstallReviewRunnerService(platform: NodeJS.Platform = process.platform): boolean {
  const file = serviceFile(platform);
  if (!file || !fs.existsSync(file)) return false;
  if (platform === 'darwin') {
    sh('launchctl', ['bootout', `${launchdTarget()}/${SERVICE_LABEL}`]);
  } else {
    sh('systemctl', ['--user', 'disable', '--now', LINUX_UNIT]);
  }
  fs.rmSync(file, { force: true });
  if (platform === 'linux') sh('systemctl', ['--user', 'daemon-reload']);
  return true;
}
