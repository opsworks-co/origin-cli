// `origin review runner install|uninstall|status`: the launchd and systemd
// files the pure builders write, where they go, and the action's dispatch.
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  launchdPlist, systemdUnit, serviceFile, serviceFileText, serviceLogFile, runnerServiceArgs,
  SERVICE_LABEL, LINUX_UNIT, type ServiceSpec,
} from '../commands/review-runner-service.js';
import { reviewRunnerServiceAction, type ReviewRunnerServiceDeps } from '../commands/review-runner.js';

const spec: ServiceSpec = {
  node: '/usr/local/bin/node',
  entry: '/Users/me/.npm-global/bin/origin',
  args: ['review', 'runner', '--repo', '/Users/me/src/app', '--interval', '30'],
  cwd: '/Users/me/src/app',
  logFile: '/Users/me/.origin/review-runner.log',
  pathEnv: '/Users/me/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
};

describe('launchdPlist', () => {
  const plist = launchdPlist(spec);

  it('runs node on the bin link with the daemon arguments, from the install cwd, with the shell PATH', () => {
    expect(plist).toContain(`<key>Label</key><string>${SERVICE_LABEL}</string>`);
    expect(plist).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/me\/\.npm-global\/bin\/origin<\/string>\s*<string>review<\/string>\s*<string>runner<\/string>\s*<string>--repo<\/string>\s*<string>\/Users\/me\/src\/app<\/string>\s*<string>--interval<\/string>\s*<string>30<\/string>\s*<\/array>/);
    expect(plist).toContain('<key>WorkingDirectory</key><string>/Users/me/src/app</string>');
    expect(plist).toContain('<key>PATH</key><string>/Users/me/.npm-global/bin:/usr/local/bin:/usr/bin:/bin</string>');
  });

  it('respawns on every exit (the upgrade exit is 0) and logs to ~/.origin/review-runner.log', () => {
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>StandardOutPath</key><string>/Users/me/.origin/review-runner.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key><string>/Users/me/.origin/review-runner.log</string>');
  });

  it('is valid XML: a path with & < > is escaped, and no PATH leaves the environment out', () => {
    const odd = launchdPlist({ ...spec, cwd: '/Users/me/a&b<c>', pathEnv: null });
    expect(odd).toContain('<string>/Users/me/a&amp;b&lt;c&gt;</string>');
    expect(odd).not.toContain('EnvironmentVariables');
    if (process.platform === 'darwin') {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-plist-')), 'x.plist');
      fs.writeFileSync(f, odd);
      expect(() => execFileSync('plutil', ['-lint', f], { stdio: 'pipe' })).not.toThrow();
    }
  });
});

describe('systemdUnit', () => {
  const unit = systemdUnit(spec);

  it('runs the same command, restarts always, appends both streams to the log, and is wanted by the user session', () => {
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/Users/me/.npm-global/bin/origin" "review" "runner" "--repo" "/Users/me/src/app" "--interval" "30"');
    expect(unit).toContain('WorkingDirectory=/Users/me/src/app');
    expect(unit).toContain('Environment="PATH=/Users/me/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('StandardOutput=append:/Users/me/.origin/review-runner.log');
    expect(unit).toContain('StandardError=append:/Users/me/.origin/review-runner.log');
    expect(unit).toMatch(/\[Install\]\nWantedBy=default\.target/);
  });

  it('quotes a path with a space or a quote in ExecStart', () => {
    const odd = systemdUnit({ ...spec, entry: '/home/me/my "bin"/origin', args: ['review', 'runner', '--repo', '/home/me/src dir'], pathEnv: null });
    expect(odd).toContain('ExecStart="/usr/local/bin/node" "/home/me/my \\"bin\\"/origin" "review" "runner" "--repo" "/home/me/src dir"');
    expect(odd).not.toContain('Environment=');
  });
});

describe('where the service lives', () => {
  it('a LaunchAgent on macOS, a systemd user unit on Linux, nowhere on Windows', () => {
    expect(serviceFile('darwin', '/Users/me')).toBe(`/Users/me/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
    expect(serviceFile('linux', '/home/me')).toBe(`/home/me/.config/systemd/user/${LINUX_UNIT}`);
    expect(serviceFile('win32', 'C:\\Users\\me')).toBeNull();
    expect(serviceLogFile('/home/me')).toBe('/home/me/.origin/review-runner.log');
    expect(serviceFileText('darwin', spec)).toContain('<plist');
    expect(serviceFileText('linux', spec)).toContain('[Service]');
    expect(() => serviceFileText('win32', spec)).toThrow(/no background service on win32/);
  });

  it('the daemon arguments make --repo absolute (the service does not run in the shell\'s cwd) and pass the interval', () => {
    expect(runnerServiceArgs({}, '/x')).toEqual(['review', 'runner']);
    expect(runnerServiceArgs({ repo: ['../lib', '/abs/app'], interval: '20' }, '/x/app')).toEqual(['review', 'runner', '--repo', '/x/lib', '/abs/app', '--interval', '20']);
  });
});

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function fakeDeps(over: Partial<ReviewRunnerServiceDeps> = {}) {
  const lines: string[] = [];
  const exits: number[] = [];
  const deps: ReviewRunnerServiceDeps = {
    platform: 'darwin',
    cwd: '/nowhere',
    discover: () => [],
    log: (l) => lines.push(l),
    spec: (opts, cwd) => ({ ...spec, args: runnerServiceArgs(opts, cwd), cwd }),
    install: vi.fn(() => '/Users/me/Library/LaunchAgents/x.plist'),
    uninstall: vi.fn(() => true),
    status: vi.fn(() => ({ installed: true, file: '/f', running: true, pid: 42 })),
    exit: (code) => { exits.push(code); },
    ...over,
  };
  return { deps, lines, exits };
}

describe('origin review runner install | uninstall | status', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-runner-svc-'));
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  g(app, 'init', '-q', '-b', 'main');
  g(app, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');

  it('install refuses with nothing to watch, so the service cannot be a ten-second crash loop', async () => {
    const { deps, lines, exits } = fakeDeps();
    await reviewRunnerServiceAction('install', {}, deps);
    expect(exits).toEqual([2]);
    expect(lines.join('\n')).toMatch(/No checkout to watch/);
    expect(deps.install).not.toHaveBeenCalled();
  });

  it('install writes the service for the checkouts it would watch, with the options it was given', async () => {
    const { deps, lines, exits } = fakeDeps({ cwd: tmp, discover: () => [app] });
    await reviewRunnerServiceAction('install', { repo: [app], interval: '30' }, deps);
    expect(exits).toEqual([]);
    expect(deps.install).toHaveBeenCalledWith(expect.objectContaining({ cwd: tmp, args: ['review', 'runner', '--repo', app, '--interval', '30'] }), 'darwin');
    expect(lines.join('\n')).toMatch(/installed as a background service/);
    expect(lines.join('\n')).toMatch(/acme\/app/);
    expect(lines.join('\n')).toMatch(/review-runner\.log/);
  });

  it('a refused install exits 1 with the manager\'s reason', async () => {
    const { deps, lines, exits } = fakeDeps({ cwd: app, install: vi.fn(() => { throw new Error('launchctl bootstrap failed: Input/output error'); }) });
    await reviewRunnerServiceAction('install', {}, deps);
    expect(exits).toEqual([1]);
    expect(lines.join('\n')).toMatch(/Could not install the service: launchctl bootstrap failed/);
  });

  it('status says running with the pid, installed-but-stopped, or not installed', async () => {
    const running = fakeDeps();
    await reviewRunnerServiceAction('status', {}, running.deps);
    expect(running.lines.join('\n')).toMatch(/running \(pid 42\)/);
    const stopped = fakeDeps({ status: () => ({ installed: true, file: '/f', running: false, pid: null }) });
    await reviewRunnerServiceAction('status', {}, stopped.deps);
    expect(stopped.lines.join('\n')).toMatch(/installed but not running/);
    const none = fakeDeps({ status: () => ({ installed: false, file: '/f', running: false, pid: null }) });
    await reviewRunnerServiceAction('status', {}, none.deps);
    expect(none.lines.join('\n')).toMatch(/Not installed.*origin review runner install/);
  });

  it('uninstall reports what it removed; an unknown action exits 2', async () => {
    const some = fakeDeps();
    await reviewRunnerServiceAction('uninstall', {}, some.deps);
    expect(some.lines.join('\n')).toMatch(/Removed the reviewer runner service/);
    const none = fakeDeps({ uninstall: () => false });
    await reviewRunnerServiceAction('uninstall', {}, none.deps);
    expect(none.lines.join('\n')).toMatch(/Nothing to remove/);
    const bad = fakeDeps();
    await reviewRunnerServiceAction('reinstall', {}, bad.deps);
    expect(bad.exits).toEqual([2]);
    expect(bad.lines.join('\n')).toMatch(/Unknown action "reinstall"/);
  });
});
