// `origin issue cloud <id> --runner codex --env <env>` — hand an issue to
// Codex cloud from this machine.
//
// Codex cloud has no public API, so Origin's server can't start it the way it
// starts Copilot, Cursor or Devin. This runs where the person's own Codex CLI
// is signed in to ChatGPT: it submits the task (`codex cloud exec`), reports
// a run to the issue (agent `codex-cloud`, with the task id), then follows
// the task (`codex cloud list --json`) and reports how it ended. The web's
// Start ▸ Codex cloud opens a `getorigin://issue/cloud` link that runs this
// detached (url-handler.ts). If this machine sleeps or the process dies, the
// server gives the run up after a day (apps/api cloud-run-status.ts).
//
// Codex works on a diff in its own cloud; a pull request is made from
// ChatGPT, on a `codex/…` branch — the issue's Attempts pair the run with it.

import chalk from 'chalk';
import { execFile, execFileSync } from 'child_process';
import os from 'os';
import { buildIssuePrompt, CLOUD_ENV, CLOUD_RUNNERS, type CloudRunner } from '../issue-prompt.js';
import { canonicalRoot, defaultMemoryLines, findOnPath, loadMemoryModules, resolveIssue, type IssueStartDeps } from './issue-start.js';

export const CODEX_CLOUD_AGENT = 'codex-cloud';
const POLL_MS = 60_000;
const DEFAULT_TIMEOUT_HOURS = 12;

export interface IssueCloudOptions {
  runner?: string;
  env?: string;
  /** Give up following the task after this many hours (default 12). */
  timeout?: string | number;
}

export interface CloudExecResult { code: number; stdout: string; stderr: string }

export interface IssueCloudDeps extends Pick<IssueStartDeps, 'cwd' | 'env' | 'platform' | 'log' | 'error' | 'connected' | 'memoryLines' | 'openTodos'> {
  api: (NonNullable<IssueStartDeps['api']> & {
    noteIssueRun?: (repoId: string, shortId: string, runId: string, detail: string) => Promise<any>;
  }) | null;
  /** Runs a command to its end, capturing its output. */
  exec: (bin: string, args: string[], cwd: string) => Promise<CloudExecResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The repo's default branch, for the task to start from; null = let Codex pick. */
  defaultBranch: (cwd: string) => string | null;
}

export type CloudTaskState = 'pending' | 'done' | 'failed';

/** The task id at the end of the URL `codex cloud exec` prints. Pure. */
export function taskIdFromExecOutput(stdout: string): { id: string; url: string } | null {
  const urls = stdout.split(/\s+/).filter((w) => /^https?:\/\/\S+$/.test(w));
  const url = urls[urls.length - 1];
  if (!url) return null;
  const id = url.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() || '';
  return /^[A-Za-z0-9_-]{4,200}$/.test(id) ? { id, url } : null;
}

/** A task's state, read from `codex cloud list --json`. Null when the task isn't in it. Pure. */
export function taskStateFromList(json: string, id: string): { state: CloudTaskState; detail: string } | null {
  let tasks: any[];
  try { tasks = JSON.parse(json)?.tasks; } catch { return null; }
  const t = Array.isArray(tasks) ? tasks.find((x) => x?.id === id) : null;
  if (!t) return null;
  const s = t.summary || {};
  const stats = typeof s.files_changed === 'number'
    ? `: ${s.files_changed} file${s.files_changed === 1 ? '' : 's'}, +${s.lines_added ?? 0} -${s.lines_removed ?? 0}`
    : '';
  switch (String(t.status || '').toLowerCase()) {
    case 'ready':
    case 'applied': return { state: 'done', detail: `Codex finished${stats}` };
    case 'error': return { state: 'failed', detail: 'Codex cloud reported an error' };
    default: return { state: 'pending', detail: '' };
  }
}

function defaultExec(bin: string, args: string[], cwd: string): Promise<CloudExecResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function defaultBranchOf(cwd: string): string | null {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return ref.replace(/^origin\//, '') || null;
  } catch { return null; }
}

async function defaultCloudDeps(): Promise<IssueCloudDeps> {
  await loadMemoryModules();
  const [{ api }, { isConnectedMode }, { getOpenTodos }] = await Promise.all([
    import('../api.js'), import('../config.js'), import('../todo.js'),
  ]);
  return {
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    connected: isConnectedMode,
    api: { previewRoute: api.previewRoute, getIssue: api.getIssue, updateIssue: api.updateIssue, startIssueRun: api.startIssueRun, endIssueRun: api.endIssueRun, noteIssueRun: api.noteIssueRun },
    memoryLines: defaultMemoryLines,
    openTodos: (repoPath) => getOpenTodos(repoPath).map((t) => ({ id: t.id, text: t.text })),
    exec: defaultExec,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    defaultBranch: defaultBranchOf,
  };
}

export interface IssueCloudResult { taskId: string | null; url: string | null; state: CloudTaskState | 'timed_out' | 'not_started' }

export async function issueCloudCommand(id: string, opts: IssueCloudOptions, injected?: Partial<IssueCloudDeps>): Promise<IssueCloudResult> {
  // Tests pass every dependency; a real run loads the defaults.
  const deps: IssueCloudDeps = injected?.exec ? (injected as IssueCloudDeps) : { ...(await defaultCloudDeps()), ...(injected || {}) };
  const notStarted: IssueCloudResult = { taskId: null, url: null, state: 'not_started' };
  const runner = (opts.runner || 'codex') as CloudRunner;
  if (!(CLOUD_RUNNERS as readonly string[]).includes(runner)) {
    deps.error(chalk.red(`--runner takes ${CLOUD_RUNNERS.join(', ')}; not "${opts.runner}".`));
    process.exitCode = 2;
    return notStarted;
  }
  const env = (opts.env || '').trim();
  if (!CLOUD_ENV.test(env)) {
    deps.error(chalk.red('--env is the Codex cloud environment to run in (its id, or its name in `codex cloud`).'));
    process.exitCode = 2;
    return notStarted;
  }
  const codex = findOnPath('codex', deps.env, deps.platform);
  if (!codex) {
    deps.error(chalk.red('The Codex CLI is not installed here: npm i -g @openai/codex, then `codex login` with your ChatGPT account.'));
    process.exitCode = 1;
    return notStarted;
  }

  const canonical = canonicalRoot(deps.cwd);
  const issue = await resolveIssue(id, { work: deps.cwd, canonical }, deps);
  if (!issue || !issue.repoId || !deps.api) {
    deps.error(chalk.red(`No issue ${id} on Origin for this repo — Codex cloud runs are reported to an Origin issue.`));
    process.exitCode = 1;
    return notStarted;
  }
  const api = deps.api;
  const repoId = issue.repoId;

  let memory: string[] = [];
  if (!issue.agentPrompt) {
    try { memory = deps.memoryLines(canonical, issue); } catch { memory = []; }
  }
  // Codex cloud works on a branch of its own: the prompt names none.
  const prompt = issue.agentPrompt ?? buildIssuePrompt({
    shortId: issue.shortId, title: issue.title, description: issue.description, type: issue.type,
    branch: null, memoryTodoId: issue.memoryTodoId, memory, hostIssue: issue.hostIssue ?? null,
    pullRequest: null, clarifications: issue.questions ?? [],
  });

  let runId: string | null = null;
  try {
    const r = await api.startIssueRun?.(repoId, issue.shortId, { agent: CODEX_CLOUD_AGENT, branch: null, background: true, hostname: os.hostname() });
    runId = typeof r?.id === 'string' ? r.id : null;
  } catch (err: any) {
    deps.error(chalk.yellow(`Could not report the run to Origin (${err?.message || err}); submitting anyway.`));
  }
  const end = async (status: 'done' | 'failed' | 'timed_out', detail: string, exitCode: number) => {
    if (!runId) return;
    try { await api.endIssueRun?.(repoId, issue.shortId, runId, { status, exitCode, detail }); } catch { /* the server's deadline ends it */ }
  };

  const base = deps.defaultBranch(canonical);
  const sub = await deps.exec(codex, ['cloud', 'exec', '--env', env, ...(base ? ['--branch', base] : []), prompt], canonical);
  const task = sub.code === 0 ? taskIdFromExecOutput(sub.stdout) : null;
  if (!task) {
    const why = (sub.stderr || sub.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 500) || `codex exited ${sub.code}`;
    deps.error(chalk.red(`Codex cloud did not take the task: ${why}`));
    await end('failed', `codex cloud exec: ${why}`, sub.code || 1);
    process.exitCode = 1;
    return notStarted;
  }
  deps.log(chalk.green(`✓ Codex cloud is on ${issue.shortId}: ${task.url}`));
  if (runId) {
    try { await api.noteIssueRun?.(repoId, issue.shortId, runId, `task ${task.id} ${task.url}`); } catch { /* status only */ }
  }

  const hours = Number(opts.timeout ?? DEFAULT_TIMEOUT_HOURS);
  const deadline = deps.now() + (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TIMEOUT_HOURS) * 3_600_000;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    const list = await deps.exec(codex, ['cloud', 'list', '--json', '--env', env, '--limit', '20'], canonical);
    let state = list.code === 0 ? taskStateFromList(list.stdout, task.id) : null;
    if (!state) {
      // Off the first page: ask for the one task. Exit 0 = ready.
      const st = await deps.exec(codex, ['cloud', 'status', task.id], canonical);
      if (st.code === 0) state = { state: 'done', detail: 'Codex finished' };
      else if (/\bERROR\b/.test(st.stdout)) state = { state: 'failed', detail: 'Codex cloud reported an error' };
    }
    if (!state || state.state === 'pending') continue;
    deps.log(state.state === 'done' ? chalk.green(`✓ ${state.detail}. Make the pull request from ${task.url}`) : chalk.red(state.detail));
    await end(state.state, `${state.detail} — ${task.url}`, state.state === 'done' ? 0 : 1);
    return { taskId: task.id, url: task.url, state: state.state };
  }
  deps.error(chalk.yellow(`Stopped following ${task.url} after ${hours} h; it may still finish there.`));
  await end('timed_out', `Not finished after ${hours} h — ${task.url}`, 124);
  return { taskId: task.id, url: task.url, state: 'timed_out' };
}

export async function issueCloudAction(id: string, opts: IssueCloudOptions): Promise<void> {
  await issueCloudCommand(id, opts);
}
