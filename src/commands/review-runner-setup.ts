// `origin review runner setup --clone <url...>` — make a fresh box a runner.
//
// Settings → Runners → "Add a host" (apps/api services/runner-hosts.ts) gives
// one command to paste on the box over the person's own SSH. install.sh
// installs the CLI, logs in with the command's one-time token, and runs this
// with everything after --runner:
//
//   1. clones each --clone URL into <dir>/<owner>/<name> (default dir
//      ~/origin-runner), or fetches a checkout already there, with the box's
//      own git access — Origin never hands out repo credentials;
//   2. warns when no reviewer agent (claude, codex) is on PATH;
//   3. on Linux, turns on lingering so the systemd user service keeps running
//      after the SSH session ends;
//   4. installs `origin review runner --repo <clones> [--parallel n] [--scope s]`
//      as the service (review-runner-service.ts).
//
// It is safe to run again: after fixing git access, the same line clones what
// is missing and re-installs the service.
import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDetailed } from '../utils/exec.js';
import { findOnPath } from './issue-start.js';
import { installReviewRunnerService, serviceLogFile, serviceSpec, type ServiceSpec } from './review-runner-service.js';

export interface RunnerSetupOptions {
  clone?: string[];
  dir?: string;
  parallel?: string;
  scope?: string;
  interval?: string;
  localCi?: boolean;
  localCiOnly?: boolean;
}

export interface RunnerSetupDeps {
  platform: NodeJS.Platform;
  home: string;
  log: (line: string) => void;
  /** Is there a git checkout at `dir`? */
  isCheckout: (dir: string) => boolean;
  mkdirp: (dir: string) => void;
  /** git with these args; never prompts (no terminal to answer it). */
  git: (args: string[], cwd?: string) => { status: number; stderr: string };
  onPath: (bin: string) => boolean;
  /** `loginctl enable-linger` for the current user. */
  linger: () => { ok: boolean; out: string };
  spec: (opts: RunnerSetupOptions & { repo: string[] }, cwd: string) => ServiceSpec;
  install: (spec: ServiceSpec, platform: NodeJS.Platform) => string;
  exit: (code: number) => void;
}

const AGENTS = ['claude', 'codex'];

/**
 * Where a clone URL lands: `<dir>/<path on the host>` without `.git` — for
 * `https://github.com/acme/api.git` and `git@github.com:acme/api.git` alike,
 * `<dir>/acme/api`. Null for a URL with no usable path. Pure.
 */
export function cloneTarget(url: string, dir: string): string | null {
  let p: string;
  const scp = /^[\w.-]+@[\w.-]+:(?!\/\/)(.+)$/.exec(url);
  if (scp) p = scp[1];
  else {
    try {
      p = new URL(url).pathname;
    } catch {
      return null;
    }
  }
  const segs = p.replace(/\.git\/?$/i, '').split('/').filter(Boolean);
  if (segs.length === 0 || segs.some((s) => s === '.' || s === '..' || !/^[A-Za-z0-9._~-]+$/.test(s))) return null;
  return path.join(dir, ...segs);
}

function defaultDeps(): RunnerSetupDeps {
  const noPrompt = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
  return {
    platform: process.platform,
    home: os.homedir(),
    log: (l) => console.log(l),
    isCheckout: (dir) => fs.existsSync(path.join(dir, '.git')),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    git: (args, cwd) => {
      const r = runDetailed('git', args, { cwd, timeoutMs: 15 * 60_000, env: noPrompt });
      return { status: r.status, stderr: r.stderr };
    },
    onPath: (bin) => !!findOnPath(bin, process.env),
    linger: () => {
      const r = runDetailed('loginctl', ['enable-linger'], { timeoutMs: 15_000 });
      return { ok: r.status === 0, out: (r.stderr || r.stdout).trim() };
    },
    spec: (opts, cwd) => serviceSpec(opts, cwd),
    install: installReviewRunnerService,
    exit: (code) => { process.exitCode = code; },
  };
}

/** git's last meaningful line of complaint. */
function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || 'unknown error';
}

export async function runnerSetupCommand(opts: RunnerSetupOptions = {}, deps: RunnerSetupDeps = defaultDeps()): Promise<void> {
  const { log } = deps;
  const urls = [...new Set(opts.clone ?? [])];
  if (urls.length === 0) {
    log(chalk.red('Nothing to clone: pass --clone <git url> for each repo this runner should review.'));
    log(chalk.gray('  Settings → Runners → Add a host gives the whole command.'));
    deps.exit(2);
    return;
  }
  if (opts.scope !== undefined && opts.scope !== 'mine' && opts.scope !== 'workspace') {
    log(chalk.red(`--scope must be mine or workspace, not "${opts.scope}".`));
    deps.exit(2);
    return;
  }
  const dir = path.resolve(deps.home, opts.dir || 'origin-runner');
  log(chalk.bold('\nSetting up this machine as a reviewer runner'));
  log(chalk.gray(`  checkouts in ${dir}\n`));

  const ready: string[] = [];
  const failed: string[] = [];
  for (const url of urls) {
    const target = cloneTarget(url, dir);
    if (!target) {
      log(chalk.red(`  ✗ ${url}: not a git URL this can clone`));
      failed.push(url);
      continue;
    }
    if (deps.isCheckout(target)) {
      const r = deps.git(['fetch', '--quiet', 'origin'], target);
      log(r.status === 0
        ? chalk.green(`  ✓ ${target} (already here, fetched)`)
        : chalk.yellow(`  ! ${target} is already here, but fetching failed: ${lastLine(r.stderr)}`));
      ready.push(target);
      continue;
    }
    deps.mkdirp(path.dirname(target));
    const r = deps.git(['clone', '--quiet', url, target]);
    if (r.status === 0) {
      log(chalk.green(`  ✓ cloned ${url}`));
      ready.push(target);
    } else {
      log(chalk.red(`  ✗ could not clone ${url}: ${lastLine(r.stderr)}`));
      failed.push(url);
    }
  }

  if (failed.length > 0) {
    log('');
    log(chalk.yellow('This machine needs read access to the repos it could not clone. For example:'));
    log(chalk.gray('  GitHub: gh auth login && gh auth setup-git   (or add an SSH deploy key)'));
    log(chalk.gray('  Any host: a git credential helper, or an SSH key; --clone also takes git@host:owner/name.git'));
    log(chalk.gray('  Then run the same setup line again: what is already cloned is kept.'));
  }
  if (ready.length === 0) {
    deps.exit(1);
    return;
  }

  if (!opts.localCiOnly && !AGENTS.some((a) => deps.onPath(a))) {
    log('');
    log(chalk.yellow('No reviewer agent on PATH (claude or codex). Install one and sign in here, or reviewer runs on this machine will fail.'));
  }

  if (deps.platform === 'linux') {
    const l = deps.linger();
    if (!l.ok) {
      log('');
      log(chalk.yellow(`Could not turn on lingering (${l.out || 'loginctl failed'}): the runner stops when you log out.`));
      log(chalk.gray(`  Fix: sudo loginctl enable-linger ${os.userInfo().username}`));
    }
  }

  let file: string;
  try {
    file = deps.install(deps.spec({ ...opts, repo: ready }, dir), deps.platform);
  } catch (err: any) {
    log('');
    log(chalk.red(`Could not install the runner service: ${err?.message || err}`));
    log(chalk.gray(`  You can run it in the foreground instead: origin review runner --repo ${ready.join(' ')}`));
    deps.exit(1);
    return;
  }
  log('');
  log(chalk.green('✓ Runner installed as a background service') + chalk.gray(` (${file})`));
  log(chalk.gray(`  log: ${serviceLogFile(deps.home)}`));
  log(chalk.gray('  It shows up in Settings → Runners within a minute.'));
  if (failed.length > 0) deps.exit(1);
}
