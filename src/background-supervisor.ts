// `origin issue run-supervise <record>` — the process that watches a
// background run (`origin issue start --background`).
//
// It starts the agent in a process group of its own, its output to the run's
// log, and waits. When the agent exits it writes how, then ends the run's
// Origin session (headless-run-end.ts). When the agent outlives the run's
// time limit it stops the whole group (the agent and every tool process it
// started), TERM and then KILL, and writes that it timed out.
//
// A wall-clock limit, not an idle one: headless agents print nothing until
// they finish, so "no output for a while" is what a healthy run looks like.
// A run with no limit can hang forever: a `cursor-agent -p` whose backend
// answered nothing sat at 0% CPU, Running, until it was killed by hand
// (2026-10-12).
//
// Node rather than a shell wrapper: putting a child in its own process group
// from `sh` needs job control, which dash (/bin/sh on Debian and Ubuntu)
// refuses without a terminal.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import { ANTIGRAVITY_REFUSAL, removeBackgroundProject } from './antigravity-scope.js';
import { launchTarget } from './windows-shim.js';
import { removeCursorScope } from './cursor-scope.js';

/** How long a background run may take, unless `--timeout` says otherwise. */
export const DEFAULT_BACKGROUND_TIMEOUT_MIN = 120;

/** After TERM, how long the agent gets to stop before KILL. */
const KILL_GRACE_MS = 10_000;

/** The parts of a run record the supervisor reads. */
export interface SupervisedRun {
  argv: string[];
  worktree: string;
  log: string;
  /** Minutes; 0 or absent = no limit. */
  timeoutMin?: number;
  agentPid?: number;
}

export interface SuperviseOptions {
  platform?: NodeJS.Platform;
  /** Ends the run's Origin session once the agent is gone. */
  onEnded?: (recordFile: string) => Promise<void>;
  /** For tests: the limit in ms, instead of the record's minutes. */
  timeoutMs?: number;
  graceMs?: number;
}

/** "120 min", or seconds for a limit under a minute. */
export function describeLimit(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`;
}

/** Stop a process and everything it started. */
export function killTree(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  if (!pid) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, signal); } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

/** Run the agent of `recordFile` to the end, or to its time limit. Resolves with its exit code. */
export function superviseRun(recordFile: string, opts: SuperviseOptions = {}): Promise<number> {
  const platform = opts.platform ?? process.platform;
  const run = JSON.parse(fs.readFileSync(recordFile, 'utf-8')) as SupervisedRun;
  const [bin, ...args] = run.argv;
  const limitMs = opts.timeoutMs ?? (run.timeoutMin && run.timeoutMin > 0 ? run.timeoutMin * 60_000 : 0);
  const fd = fs.openSync(run.log, 'a');
  const line = (s: string) => { try { fs.writeSync(fd, `${s}\n`); } catch { /* log gone */ } };

  return new Promise<number>((resolve) => {
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const refusedSomething = () => {
      if (!(run as { antigravityProjectFile?: string | null }).antigravityProjectFile) return false;
      try {
        const buf = fs.readFileSync(run.log, 'utf-8');
        return ANTIGRAVITY_REFUSAL.test(buf.slice(-4000));
      } catch { return false; }
    };

    const finish = async (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) line(`[origin] agent timed out after ${describeLimit(limitMs)}`);
      // Headless agy exits 0 after refusing an ungranted command, having done
      // nothing: that is a failed run, not a finished one.
      if (code === 0 && refusedSomething()) {
        line('[origin] agent stopped: it needed a permission this run does not grant');
        code = 3;
      }
      line(`[origin] agent exited with code ${code}`);
      removeBackgroundProject((run as { antigravityProjectFile?: string | null }).antigravityProjectFile);
      removeCursorScope((run as { cursorScopeFile?: string | null }).cursorScopeFile);
      try { fs.closeSync(fd); } catch { /* fine */ }
      try { await opts.onEnded?.(recordFile); } catch { /* the idle sweep is the fallback */ }
      resolve(code);
    };

    // An npm-installed agent on Windows is a .cmd shim: run what it points at (windows-shim.ts).
    let target: { file: string; args: string[] };
    try { target = launchTarget(bin, args, { platform }); } catch (err: any) {
      line(`[origin] could not start ${bin}: ${err?.message || err}`);
      void finish(127);
      return;
    }
    const child = spawn(target.file, target.args, {
      cwd: run.worktree,
      // Its own process group, so the time limit stops its tools too.
      detached: platform !== 'win32',
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    child.on('error', (err) => { line(`[origin] could not start ${bin}: ${err.message}`); void finish(127); });
    child.on('exit', (code, signal) => {
      void finish(timedOut ? 124 : code ?? (signal ? 128 + (({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 } as Record<string, number>)[signal] ?? 1) : 1));
    });

    if (child.pid) {
      try {
        const rec = JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
        fs.writeFileSync(recordFile, JSON.stringify({ ...rec, agentPid: child.pid }, null, 2) + '\n');
      } catch { /* the record is a convenience */ }
    }

    if (limitMs > 0 && child.pid) {
      const pid = child.pid;
      timer = setTimeout(() => {
        timedOut = true;
        killTree(pid, 'SIGTERM', platform);
        killTimer = setTimeout(() => killTree(pid, 'SIGKILL', platform), opts.graceMs ?? KILL_GRACE_MS);
      }, limitMs);
    }
  });
}

/** `origin issue run-supervise <record>`: started detached by `origin issue start --background`. */
export async function runSuperviseAction(recordFile: string): Promise<void> {
  const { runEndedAction } = await import('./headless-run-end.js');
  const code = await superviseRun(recordFile, { onEnded: runEndedAction });
  const published = code === 0 ? await publishRun(recordFile) : null;
  await reportRunEnd(recordFile, code, published);
  process.exitCode = code;
}

/**
 * A clean run's work leaves the machine: push its branch and open its pull
 * request (issue-publish.ts). Writes the outcome to the run's log and returns
 * it for the issue's Start dialog. Off when the run was started --no-publish.
 */
async function publishRun(recordFile: string): Promise<string | null> {
  try {
    const rec = JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
    if (rec.publish === false || !rec.branch || !rec.worktree || !rec.shortId) return null;
    const { publishIssueBranch, describePublish } = await import('./issue-publish.js');
    const line = describePublish(publishIssueBranch({
      cwd: rec.worktree, branch: rec.branch, shortId: rec.shortId, title: rec.title || rec.shortId,
      agent: rec.agent || 'agent', pullRequest: rec.pullRequest ?? null, hostIssue: rec.hostIssue ?? null,
    }));
    if (rec.log) { try { fs.appendFileSync(rec.log, `[origin] ${line}\n`); } catch { /* log gone */ } }
    return line;
  } catch { return null; }
}

/** done / failed / timed_out, from the supervisor's exit code. Pure. */
export function runEndStatus(code: number): 'done' | 'failed' | 'timed_out' {
  return code === 0 ? 'done' : code === 124 ? 'timed_out' : 'failed';
}

/** The log's last lines — why a run failed, for the issue's Start dialog. Pure. */
export function logTail(text: string, lines = 20): string {
  return text.split('\n').filter((l) => l.trim()).slice(-lines).join('\n').slice(-2000);
}

/** Tell the issue's Start dialog how the run ended. Best effort. */
async function reportRunEnd(recordFile: string, code: number, published: string | null = null): Promise<void> {
  try {
    const rec = JSON.parse(fs.readFileSync(recordFile, 'utf-8')) as { repoId?: string | null; serverRunId?: string | null; shortId?: string; log?: string };
    if (!rec.repoId || !rec.serverRunId || !rec.shortId) return;
    let detail: string | null = null;
    if (code !== 0 && rec.log) { try { detail = logTail(fs.readFileSync(rec.log, 'utf-8')); } catch { detail = null; } }
    if (code === 0) detail = published;
    const { api } = await import('./api.js');
    await api.endIssueRun(rec.repoId, rec.shortId, rec.serverRunId, { status: runEndStatus(code), exitCode: code, detail });
  } catch { /* the run still shows in `origin issue runs` */ }
}
