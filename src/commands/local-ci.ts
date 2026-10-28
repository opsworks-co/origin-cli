// Local CI on the runner (`origin review runner`): one claimed check — the
// repo's fixed test command, set in Origin, never read from the PR — run on
// this machine at the PR's head, and its exit code and the end of its output
// reported back. The server side is apps/api/src/services/local-ci.ts.
//
// The check runs in a detached worktree at the head commit (no branch is made)
// beside the checkout, like a review run's, and the worktree is removed after.
// The command gets a small environment — PATH, HOME and a few basics, plus
// CI=true — not the runner's: a test run has no business with the secrets the
// daemon was started with. It runs through the shell, so `npm ci && npm test`
// works; on a timeout the whole process group is killed.
import chalk from 'chalk';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { remoteFor } from './review-run.js';

export interface ClaimedLocalCheck {
  id: string;
  repoFullName: string;
  prNumber: number;
  headBranch: string;
  headSha: string;
  command: string;
  timeoutSec: number;
  name: string;
}

export interface LocalCheckReport {
  exitCode: number | null;
  timedOut?: boolean;
  durationMs?: number;
  logTail?: string;
  error?: string;
}

/** The end of the output kept and sent (the server keeps as much). */
export const LOG_TAIL_BYTES = 64 * 1024;

const ENV_KEPT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];

/** The command's environment: a few basics from ours, and CI=true. Pure. */
export function localCheckEnv(from: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: 'true', ORIGIN_LOCAL_CI: '1' };
  for (const k of ENV_KEPT) if (from[k] !== undefined) env[k] = from[k];
  return env;
}

/** Keeps only the last `max` characters of everything written to it. */
export class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  push(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.max && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }
  text(): string {
    const all = this.chunks.join('');
    return all.length > this.max ? all.slice(-this.max) : all;
  }
}

/** Where the check's worktree goes: beside the checkout, like a review's. Pure. */
export function localCheckWorktreePath(canonical: string, prNumber: number, checkId: string): string {
  return path.join(path.dirname(canonical), `${path.basename(canonical)}-worktrees`, `local-ci-${prNumber}-${checkId.slice(0, 8)}`);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function gitOk(args: string[], cwd: string): boolean {
  try { git(args, cwd); return true; } catch { return false; }
}

export interface RunCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

/** Run `command` through the shell in `cwd`, killing it (and its children) after `timeoutSec`. */
export function runShellCommand(command: string, cwd: string, timeoutSec: number, env: NodeJS.ProcessEnv): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tail = new TailBuffer(LOG_TAIL_BYTES);
    const groupKill = process.platform !== 'win32';
    const child = spawn(command, { cwd, env, shell: true, detached: groupKill, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (groupKill && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
    }, timeoutSec * 1000);
    child.stdout?.on('data', (d: Buffer) => tail.push(d.toString('utf-8')));
    child.stderr?.on('data', (d: Buffer) => tail.push(d.toString('utf-8')));
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, timedOut, durationMs: Date.now() - started, output: tail.text() });
    };
    child.on('error', (err) => { tail.push(`\n${err.message}\n`); finish(127); });
    child.on('close', (code) => finish(code));
  });
}

export interface LocalCheckDeps {
  log: (line: string) => void;
  report: (id: string, data: LocalCheckReport) => Promise<unknown>;
  run: (command: string, cwd: string, timeoutSec: number, env: NodeJS.ProcessEnv) => Promise<RunCommandResult>;
  env: NodeJS.ProcessEnv;
}

/**
 * Run one claimed check in `canonical` (the repo's main checkout) and report
 * it. Never throws: a check that can't run is reported as such, so it never
 * sits "running" until the server gives up on it.
 */
export async function runLocalCheck(check: ClaimedLocalCheck, canonical: string, deps: LocalCheckDeps): Promise<LocalCheckReport> {
  const say = (r: LocalCheckReport) => {
    deps.log(r.error
      ? chalk.red(`  ✗ ${check.name} on #${check.prNumber}: could not run — ${r.error}`)
      : r.timedOut
        ? chalk.red(`  ✗ ${check.name} on #${check.prNumber}: timed out after ${check.timeoutSec}s`)
        : r.exitCode === 0
          ? chalk.green(`  ✓ ${check.name} on #${check.prNumber}: passed`)
          : chalk.red(`  ✗ ${check.name} on #${check.prNumber}: exit ${r.exitCode}`));
  };
  const send = async (r: LocalCheckReport) => {
    say(r);
    try { await deps.report(check.id, r); } catch (err: any) {
      deps.log(chalk.yellow(`  could not report ${check.id.slice(0, 8)}: ${err?.serverError || err?.message || err}`));
    }
    return r;
  };

  if (!/^[0-9a-f]{40}$/i.test(check.headSha)) return send({ exitCode: null, error: 'the check has no head commit' });
  const remote = remoteFor(canonical, check.repoFullName);
  if (check.headBranch && !gitOk(['fetch', '--quiet', remote, check.headBranch], canonical)) {
    return send({ exitCode: null, error: `could not fetch ${check.headBranch} from ${remote}` });
  }
  if (!gitOk(['cat-file', '-e', `${check.headSha}^{commit}`], canonical)) {
    return send({ exitCode: null, error: `commit ${check.headSha.slice(0, 8)} is not in this clone (the branch moved on?)` });
  }

  const wt = localCheckWorktreePath(canonical, check.prNumber, check.id);
  try {
    gitOk(['worktree', 'prune'], canonical);
    if (fs.existsSync(wt)) gitOk(['worktree', 'remove', '--force', wt], canonical);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(['worktree', 'add', '--detach', wt, check.headSha], canonical);
  } catch (err: any) {
    return send({ exitCode: null, error: `could not make a worktree: ${String(err?.stderr || err?.message || err).trim().split('\n').pop()}` });
  }
  deps.log(chalk.gray(`  ${wt} at ${check.headSha.slice(0, 8)}: ${check.command}`));
  try {
    let r: RunCommandResult;
    try {
      r = await deps.run(check.command, wt, check.timeoutSec, deps.env);
    } catch (err: any) {
      return await send({ exitCode: null, error: `the command could not start: ${err?.message || err}` });
    }
    return await send({ exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, logTail: r.output });
  } finally {
    gitOk(['worktree', 'remove', '--force', wt], canonical);
  }
}
