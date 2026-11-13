// `origin review run <runId...>` — run the PR reviews this machine was asked for.
//
// For each run: the packet (the PR, the reviewer, the whole prompt) from the
// API; `git fetch` the PR's head and base; a worktree of its own on `review/<pr>/<run>`
// at that head; tell the server the run started here; run the reviewer agent
// read-only and headless (review-run.ts agentReviewArgv); read its answer
// (structured output, else the result file in the worktree); post it; print
// it; remove the worktree. A missing agent, a non-zero exit or an unreadable
// answer is posted as the run's error, and the next run still goes.
import chalk from 'chalk';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { headlessAgentEnv } from '../agent-env.js';
import { loadConfig } from '../config.js';
import { createBackgroundProject, removeBackgroundProject } from '../antigravity-scope.js';
import { removeCursorScope, writeCursorScope } from '../cursor-scope.js';
import { launchTarget } from '../windows-shim.js';
import { killTree } from '../background-supervisor.js';
import {
  agentReviewArgv, becameShallow, isReviewAgent, parseReviewResult, REVIEW_RESULT_FILE, REVIEW_RESULT_SCHEMA, REVIEW_SCHEMA_FILE,
  reviewBranchName, reviewPromptWithGitRules, reviewWorktreePath, type ReviewAgent, type ReviewArgvFiles, type ReviewPacket, type ReviewResult,
} from '../review-run.js';
import { canonicalRoot, findOnPath, worktreeOfBranch } from './issue-start.js';
import { hydrateWorktreeIgnoredFiles } from '../worktree-hydration.js';

export interface ReviewRunOptions {
  keepWorktree?: boolean;
  json?: boolean;
}

export interface ReviewRunDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  hostname: string;
  log: (line: string) => void;
  error: (line: string) => void;
  api: {
    getReviewRunPacket: (runId: string) => Promise<ReviewPacket>;
    /** The team's API key for the run, as env vars; optional so an older server is no failure. */
    getReviewRunCredentials?: (runId: string) => Promise<{ source?: string; env?: Record<string, string> }>;
    startReviewRun: (runId: string, data: { hostname: string; branch: string; headSha: string | null; instance?: string }) => Promise<unknown>;
    reportReviewRun: (runId: string, data: ReviewReport) => Promise<unknown>;
  };
  /** The `origin review runner` process driving this run; unset when run by hand. */
  runnerInstance?: string;
  /** `reviewerKey` in ~/.origin/config.json: 'machine' never asks for the team's key. Default 'team'. */
  reviewerKey?: 'team' | 'machine';
  /** Runs the agent in the worktree; resolves with its exit code and, when captured, its stdout. */
  run: (exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, captureStdout: boolean) => Promise<{ code: number; stdout: string }>;
  /** The agent's argv; a seam for tests, which inject an agent that is just `node`. */
  agentArgvFor: (agent: ReviewAgent, prompt: string, files: ReviewArgvFiles, opts: { antigravityProject?: string; model?: string | null }) => string[] | null;
}

export type ReviewReport =
  | ({ status: 'done'; headSha: string | null } & ReviewResult)
  | { status: 'error'; error: string; headSha: string | null };

export interface ReviewRunOutcome {
  runId: string;
  ok: boolean;
  branch: string | null;
  worktree: string | null;
  headSha: string | null;
  result: ReviewResult | null;
  error: string | null;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function gitOk(args: string[], cwd: string): boolean {
  try { git(args, cwd); return true; } catch { return false; }
}
function isShallow(cwd: string): string | null {
  try { return git(['rev-parse', '--is-shallow-repository'], cwd); } catch { return null; }
}

/** The remote whose URL names the PR's repo (`owner/name`), else `origin`. */
export function remoteFor(cwd: string, repoFullName: string | null): string {
  if (!repoFullName) return 'origin';
  let out = '';
  try { out = git(['remote', '-v'], cwd); } catch { return 'origin'; }
  const want = repoFullName.toLowerCase();
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
    if (!m) continue;
    const url = m[2].replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
    if (url.endsWith(`/${want}`) || url.endsWith(`:${want}`)) return m[1];
  }
  return 'origin';
}

/**
 * The review's worktree on `branch` at `sha`: the branch's existing worktree
 * reset to the head (a re-run), else a fresh one — a branch left behind
 * without a worktree is dropped first.
 */
export function reviewWorktree(canonical: string, branch: string, at: string, sha: string, onClone?: (relative: string) => void): { path: string; reused: boolean; hydrationWarnings: string[] } {
  gitOk(['worktree', 'prune'], canonical);
  const existing = worktreeOfBranch(canonical, branch);
  if (existing) {
    git(['reset', '--hard', sha], existing);
    return { path: existing, reused: true, hydrationWarnings: hydrateWorktreeIgnoredFiles(canonical, existing, onClone) };
  }
  if (gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], canonical)) git(['branch', '-D', branch], canonical);
  let entries: string[] = [];
  try { entries = fs.readdirSync(at); } catch { /* not there: good */ }
  if (entries.length > 0) throw new Error(`${at} already exists and is not a worktree of ${branch}.`);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  git(['worktree', 'add', '--no-track', '-b', branch, at, sha], canonical);
  return { path: at, reused: false, hydrationWarnings: hydrateWorktreeIgnoredFiles(canonical, at, onClone) };
}

function removeWorktree(canonical: string, wt: string, branch: string): void {
  gitOk(['worktree', 'remove', '--force', wt], canonical);
  gitOk(['branch', '-D', branch], canonical);
}

// The signals that stop `origin review run` / the runner daemon: launchd and
// systemd send SIGTERM (`launchctl kickstart -k`, a stop, an upgrade restart),
// a terminal SIGINT or SIGHUP.
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
// Inside launchd's 20 s ExitTimeOut, so the agent is gone before launchd
// SIGKILLs this process.
const AGENT_KILL_GRACE_MS = 8_000;

export interface AgentProcessDeps {
  platform: NodeJS.Platform;
  /** Calls `onStop` when this process is told to stop; returns the unsubscribe. */
  onStopSignal: (onStop: (signal: NodeJS.Signals) => void) => () => void;
  killTree: (pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform) => void;
  /**
   * SIGKILL what is left of an exited agent's group: only `-pid`, never the
   * bare pid, which may be someone else's by now. A group id stays the
   * group's while any member lives, so it never names a stranger.
   */
  killGroup: (pgid: number) => void;
  exit: (code: number) => void;
  graceMs: number;
}

const REAL_AGENT_PROCESS: AgentProcessDeps = {
  platform: process.platform,
  onStopSignal: (onStop) => {
    for (const s of STOP_SIGNALS) process.on(s, onStop);
    return () => { for (const s of STOP_SIGNALS) process.off(s, onStop); };
  },
  killTree,
  killGroup: (pgid) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* the group is gone */ } },
  exit: (code) => process.exit(code),
  graceMs: AGENT_KILL_GRACE_MS,
};

/**
 * Run the reviewer agent; it never outlives this process. A runner restarted
 * mid-run (`launchctl kickstart -k`) used to leave `claude -p` reviewing for a
 * dead parent — the run already re-queued for the next daemon, its result
 * read by nobody, Claude ignoring the SIGTERM. So the agent runs in its own
 * process group (its MCP servers and tools with it), and a stop signal to
 * this process stops that group, SIGKILL after a grace, before exiting.
 */
export function runAgentProcess(
  exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, captureStdout: boolean,
  deps: AgentProcessDeps = REAL_AGENT_PROCESS,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    // An npm-installed agent on Windows is a .cmd shim: run what it points at (windows-shim.ts).
    const t = launchTarget(exe, args, { platform: deps.platform });
    const child = spawn(t.file, t.args, {
      cwd, stdio: ['ignore', captureStdout ? 'pipe' : 'inherit', 'inherit'], shell: false, env, windowsHide: true,
      // Its own group, so killTree reaches its children. A terminal's Ctrl-C
      // no longer reaches it directly: the stop handler below forwards it.
      detached: deps.platform !== 'win32',
    });
    let stdout = '';
    let exited = false;
    let stopping = false;
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    const unsubscribe = deps.onStopSignal((signal) => {
      if (stopping) return;
      stopping = true;
      const exitCode = SIGNAL_EXIT[signal] ?? 1;
      if (exited || !child.pid) { deps.exit(exitCode); return; }
      const pid = child.pid;
      deps.killTree(pid, 'SIGTERM', deps.platform);
      // SIGKILL the group after the grace; exit once the agent is gone either way.
      const force = setTimeout(() => deps.killTree(pid, 'SIGKILL', deps.platform), deps.graceMs);
      child.once('exit', () => {
        clearTimeout(force);
        deps.exit(exitCode);
      });
    });
    child.on('error', (err) => { unsubscribe(); reject(err); });
    child.on('exit', (code, signal) => {
      exited = true;
      // An MCP server or tool the agent started may still hold its group.
      if (child.pid && deps.platform !== 'win32') deps.killGroup(child.pid);
      if (!stopping) unsubscribe();
      resolve({ code: code ?? (signal ? 1 : 0), stdout });
    });
  });
}

function defaultRun(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, captureStdout: boolean): Promise<{ code: number; stdout: string }> {
  return runAgentProcess(exe, args, cwd, env, captureStdout);
}

export async function defaultReviewRunDeps(): Promise<ReviewRunDeps> {
  const { api } = await import('../api.js');
  return {
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    hostname: os.hostname(),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    api: {
      getReviewRunPacket: (id) => api.getReviewRunPacket(id) as Promise<ReviewPacket>,
      getReviewRunCredentials: (id) => api.getReviewRunCredentials(id) as Promise<{ source?: string; env?: Record<string, string> }>,
      startReviewRun: (id, data) => api.startReviewRun(id, data),
      reportReviewRun: (id, data) => api.reportReviewRun(id, { ...data }),
    },
    reviewerKey: loadConfig()?.reviewerKey === 'machine' ? 'machine' : 'team',
    run: defaultRun,
    agentArgvFor: agentReviewArgv,
  };
}

/**
 * The environment variables carrying the team's key for this run — only the
 * API key names the server may set, so it cannot reach PATH or anything else.
 * Empty when there is no key, the server is older, or asking failed.
 */
export const TEAM_KEY_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const;
async function runCredentials(deps: ReviewRunDeps, runId: string): Promise<Record<string, string>> {
  if (deps.reviewerKey === 'machine' || !deps.api.getReviewRunCredentials) return {};
  try {
    const r = await deps.api.getReviewRunCredentials(runId);
    const out: Record<string, string> = {};
    for (const k of TEAM_KEY_ENV) if (typeof r?.env?.[k] === 'string' && r.env[k]) out[k] = r.env[k];
    return out;
  } catch {
    return {};
  }
}

function toplevel(cwd: string): string | null {
  try { return git(['rev-parse', '--show-toplevel'], cwd); } catch { return null; }
}

function readResultFile(file: string): string | null {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
}

function describe(f: ReviewResult['findings'][number]): string {
  const sev = f.severity === 'high' ? chalk.red('high') : f.severity === 'medium' ? chalk.yellow('medium') : chalk.gray('low');
  return `  ${f.path}${f.line ? `:${f.line}` : ''} [${sev}] ${f.title}`;
}

/** One run, start to finish. Never throws: every failure is the run's error. */
/**
 * The run's packet, asked for again once after a network failure or a
 * timeout (no HTTP status) — a busy server, not an answer. A 4xx/5xx is the
 * server's answer and is not retried.
 */
export async function readPacket(deps: Pick<ReviewRunDeps, 'api' | 'log'> & { sleep?: (ms: number) => Promise<void> }, runId: string): Promise<ReviewPacket> {
  try {
    return await deps.api.getReviewRunPacket(runId);
  } catch (err: any) {
    if (err?.status) throw err;
    deps.log(chalk.gray(`  reading the run failed (${err?.message || err}); trying once more`));
    await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(3000);
    return deps.api.getReviewRunPacket(runId);
  }
}

export async function runOneReview(runId: string, opts: ReviewRunOptions, deps: ReviewRunDeps): Promise<ReviewRunOutcome> {
  const out: ReviewRunOutcome = { runId, ok: false, branch: null, worktree: null, headSha: null, result: null, error: null };
  const fail = async (error: string): Promise<ReviewRunOutcome> => {
    out.error = error;
    deps.error(chalk.red(`✗ ${runId.slice(0, 8)}: ${error}`));
    try { await deps.api.reportReviewRun(runId, { status: 'error', error, headSha: out.headSha }); } catch (err: any) {
      deps.error(chalk.gray(`  (could not report it: ${err?.message || err})`));
    }
    return out;
  };

  let packet: ReviewPacket;
  try { packet = await readPacket(deps, runId); } catch (err: any) {
    out.error = `could not read the run: ${err?.message || err}`;
    deps.error(chalk.red(`✗ ${runId.slice(0, 8)}: ${out.error}`));
    return out;
  }
  const { pr, reviewer } = packet;
  if (!isReviewAgent(reviewer.agent)) return fail(`"${reviewer.agent}" is not an agent this machine can run`);
  const agent: ReviewAgent = reviewer.agent;
  if (packet.run.status === 'done') deps.log(chalk.gray(`${reviewer.name} already reviewed PR #${pr.number}; running it again.`));

  const top = toplevel(deps.cwd);
  if (!top) return fail('not inside a git checkout — cd into the repo and run it again');
  const canonical = canonicalRoot(top);

  // The PR's head, fetched now: the review is of what is on the PR, not of a
  // local branch that may be behind it. Read from a ref of its own, not
  // FETCH_HEAD: every fetch in the checkout rewrites that one file, and on
  // 2026-10-30 a git-notes fetch landing in between made a run record a notes
  // commit as the PR's head, so its verdict counted as one on an older head.
  const remote = remoteFor(canonical, pr.repoFullName);
  const headRef = `refs/remotes/${remote}/${pr.headBranch}`;
  try { git(['fetch', '--quiet', remote, `+refs/heads/${pr.headBranch}:${headRef}`], canonical); } catch (err: any) {
    return fail(`could not fetch ${pr.headBranch} from ${remote}: ${String(err?.stderr || err?.message || err).trim().split('\n').pop()}`);
  }
  let headSha: string;
  try { headSha = git(['rev-parse', '--verify', `${headRef}^{commit}`], canonical); } catch { return fail('could not read the fetched head'); }
  out.headSha = headSha;
  // The base too, so the agent has it and need not fetch (review-run.ts
  // reviewPromptWithGitRules). A failure only leaves the ref as it was.
  const baseRef = `${remote}/${pr.baseBranch}`;
  const baseFetched = gitOk(['fetch', '--quiet', remote, `+refs/heads/${pr.baseBranch}:refs/remotes/${baseRef}`], canonical)
    || gitOk(['rev-parse', '--verify', '--quiet', `refs/remotes/${baseRef}`], canonical);

  const branch = reviewBranchName(pr.number, runId);
  out.branch = branch;
  let wt: string;
  let hydrationWarnings: string[];
  try { ({ path: wt, hydrationWarnings } = reviewWorktree(canonical, branch, reviewWorktreePath(canonical, pr.number, runId), headSha,
    (relative) => deps.log(chalk.gray(`  cloning ${relative} into the worktree…`)))); } catch (err: any) {
    return fail(`could not add a worktree: ${err?.message || err}`);
  }
  out.worktree = wt;
  deps.log(`${chalk.bold(reviewer.name)} (${agent}) reviewing PR #${pr.number} ${chalk.gray(pr.title)}`);
  deps.log(chalk.gray(`  ${wt} on ${branch} at ${headSha.slice(0, 8)}`));
  for (const warning of hydrationWarnings) deps.log(chalk.gray(`  could not hydrate ${warning}`));

  try { await deps.api.startReviewRun(runId, { hostname: deps.hostname, branch, headSha, ...(deps.runnerInstance ? { instance: deps.runnerInstance } : {}) }); } catch (err: any) {
    deps.error(chalk.gray(`  (could not report the start: ${err?.message || err})`));
  }

  // Origin's own files stay out of the worktree (REVIEW_SCHEMA_FILE): the
  // schema always, and codex's answer too, which its CLI writes (`-o`), not
  // the agent. An agent without structured output writes the answer itself,
  // where the prompt says: in the worktree.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-review-'));
  const schemaFile = path.join(tmp, REVIEW_SCHEMA_FILE);
  const outFile = agent === 'codex' ? path.join(tmp, REVIEW_RESULT_FILE) : path.join(wt, packet.resultFile || REVIEW_RESULT_FILE);
  const schema = packet.resultSchema || REVIEW_RESULT_SCHEMA;
  let cursorScope: string | null = null;
  let agyProject: { id: string; file: string } | null = null;
  const shallowBefore = isShallow(canonical);
  try {
    fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
    try { fs.rmSync(outFile, { force: true }); } catch { /* absent */ }
    if (agent === 'cursor') cursorScope = writeCursorScope(wt);
    if (agent === 'antigravity') agyProject = createBackgroundProject(wt, `Origin review: PR #${pr.number}`);

    const prompt = reviewPromptWithGitRules(packet.prompt, baseFetched ? baseRef : null);
    const argv = deps.agentArgvFor(agent, prompt, { schemaFile, outFile, schema }, { antigravityProject: agyProject?.id, model: packet.reviewer.model });
    if (!argv) return await fail(`${agent} has no headless mode here`);
    const exe = findOnPath(argv[0], deps.env, deps.platform);
    if (!exe) return await fail(`${argv[0]} is not installed on this machine (not on PATH)`);

    // The team's API key (Agents page), for this run only; without one — or
    // with `reviewerKey: machine` — the agent runs on whatever this machine
    // is signed into (a Claude or ChatGPT subscription).
    const teamEnv = await runCredentials(deps, runId);
    if (Object.keys(teamEnv).length) deps.log(chalk.gray(`  on the team's ${agent === 'claude' ? 'Anthropic' : 'OpenAI'} API key`));
    else if (deps.reviewerKey === 'machine') deps.log(chalk.gray(`  on this machine's ${agent} sign-in (reviewerKey: machine)`));

    const started = Date.now();
    const r = await deps.run(exe, argv.slice(1), wt, { ...headlessAgentEnv(deps.env), ...teamEnv }, agent === 'claude');
    const secs = Math.round((Date.now() - started) / 1000);
    const result = parseReviewResult(r.stdout) ?? parseReviewResult(readResultFile(outFile));
    if (!result) {
      if (/Not logged in|Please run \/login/i.test(r.stdout)) {
        return await fail(`${argv[0]} on this machine is not signed in — run \`${argv[0]} auth login\` once, or \`origin config set reviewerKey team\` to use the team's API key`);
      }
      return await fail(r.code !== 0
        ? `${argv[0]} exited with code ${r.code} and left no answer`
        : `${argv[0]} finished but its answer could not be read (no JSON on stdout or in ${path.basename(outFile)})`);
    }
    out.result = result;
    try { await deps.api.reportReviewRun(runId, { status: 'done', headSha, ...result }); } catch (err: any) {
      return await fail(`could not post the findings: ${err?.message || err}`);
    }
    out.ok = true;
    const verdict = result.verdict === 'approve' ? chalk.green('approve') : result.verdict === 'request_changes' ? chalk.red('request changes') : chalk.yellow('comment');
    deps.log(`${chalk.green('✓')} ${reviewer.name}: ${verdict} — ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'} ${chalk.gray(`(${secs}s)`)}`);
    if (result.summary) deps.log(chalk.gray(`  ${result.summary}`));
    for (const f of result.findings) deps.log(describe(f));
    return out;
  } finally {
    // The worktree shares the checkout's .git: an agent's `git fetch --depth`
    // made the person's own repo shallow. Undo it.
    if (becameShallow(shallowBefore, isShallow(canonical))) {
      deps.error(chalk.yellow(`  ⚠ ${reviewer.name} made ${canonical} a shallow clone; restoring its history (git fetch --unshallow ${remote})`));
      if (!gitOk(['fetch', '--quiet', '--unshallow', remote], canonical)) {
        deps.error(chalk.yellow(`  ⚠ could not restore it — run: git -C ${canonical} fetch --unshallow ${remote}`));
      }
    }
    removeCursorScope(cursorScope);
    removeBackgroundProject(agyProject?.file);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* fine */ }
    if (opts.keepWorktree) deps.log(chalk.gray(`  worktree kept: ${wt}`));
    else removeWorktree(canonical, wt, branch);
  }
}

export async function reviewRunCommand(ids: string[], opts: ReviewRunOptions = {}, deps?: ReviewRunDeps): Promise<ReviewRunOutcome[]> {
  const d = deps ?? await defaultReviewRunDeps();
  const outcomes: ReviewRunOutcome[] = [];
  for (const id of ids) outcomes.push(await runOneReview(id, opts, d));
  return outcomes;
}

export async function reviewRunAction(ids: string[], opts: ReviewRunOptions = {}): Promise<void> {
  const list = (Array.isArray(ids) ? ids : [ids]).map((s) => String(s).trim()).filter(Boolean);
  if (list.length === 0) {
    console.error(chalk.red('Which runs? origin review run <runId...> — the PR page\'s "Run reviewers" gives the ids.'));
    process.exitCode = 2;
    return;
  }
  const deps = await defaultReviewRunDeps();
  if (opts.json) { deps.log = () => {}; }
  const outcomes = await reviewRunCommand(list, opts, deps);
  if (opts.json) console.log(JSON.stringify(outcomes, null, 2));
  if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
}
