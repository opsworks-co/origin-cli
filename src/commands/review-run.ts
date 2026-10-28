// `origin review run <runId...>` — run the PR reviews this machine was asked for.
//
// For each run: the packet (the PR, the reviewer, the whole prompt) from the
// API; `git fetch` the PR's head; a worktree of its own on `review/<pr>/<run>`
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
import {
  agentReviewArgv, isReviewAgent, parseReviewResult, REVIEW_RESULT_FILE, REVIEW_RESULT_SCHEMA, REVIEW_SCHEMA_FILE,
  reviewBranchName, reviewWorktreePath, type ReviewAgent, type ReviewArgvFiles, type ReviewPacket, type ReviewResult,
} from '../review-run.js';
import { canonicalRoot, findOnPath, worktreeOfBranch } from './issue-start.js';

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
    startReviewRun: (runId: string, data: { hostname: string; branch: string; headSha: string | null }) => Promise<unknown>;
    reportReviewRun: (runId: string, data: ReviewReport) => Promise<unknown>;
  };
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
export function reviewWorktree(canonical: string, branch: string, at: string, sha: string): { path: string; reused: boolean } {
  gitOk(['worktree', 'prune'], canonical);
  const existing = worktreeOfBranch(canonical, branch);
  if (existing) {
    git(['reset', '--hard', sha], existing);
    return { path: existing, reused: true };
  }
  if (gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], canonical)) git(['branch', '-D', branch], canonical);
  let entries: string[] = [];
  try { entries = fs.readdirSync(at); } catch { /* not there: good */ }
  if (entries.length > 0) throw new Error(`${at} already exists and is not a worktree of ${branch}.`);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  git(['worktree', 'add', '--no-track', '-b', branch, at, sha], canonical);
  return { path: at, reused: false };
}

function removeWorktree(canonical: string, wt: string, branch: string): void {
  gitOk(['worktree', 'remove', '--force', wt], canonical);
  gitOk(['branch', '-D', branch], canonical);
}

function defaultRun(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, captureStdout: boolean): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    // An npm-installed agent on Windows is a .cmd shim: run what it points at (windows-shim.ts).
    const t = launchTarget(exe, args);
    const child = spawn(t.file, t.args, { cwd, stdio: ['ignore', captureStdout ? 'pipe' : 'inherit', 'inherit'], shell: false, env, windowsHide: true });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), stdout }));
  });
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
  try { packet = await deps.api.getReviewRunPacket(runId); } catch (err: any) {
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
  // local branch that may be behind it.
  const remote = remoteFor(canonical, pr.repoFullName);
  try { git(['fetch', '--quiet', remote, pr.headBranch], canonical); } catch (err: any) {
    return fail(`could not fetch ${pr.headBranch} from ${remote}: ${String(err?.stderr || err?.message || err).trim().split('\n').pop()}`);
  }
  let headSha: string;
  try { headSha = git(['rev-parse', 'FETCH_HEAD'], canonical); } catch { return fail('could not read the fetched head'); }
  out.headSha = headSha;

  const branch = reviewBranchName(pr.number, runId);
  out.branch = branch;
  let wt: string;
  try { wt = reviewWorktree(canonical, branch, reviewWorktreePath(canonical, pr.number, runId), headSha).path; } catch (err: any) {
    return fail(`could not add a worktree: ${err?.message || err}`);
  }
  out.worktree = wt;
  deps.log(`${chalk.bold(reviewer.name)} (${agent}) reviewing PR #${pr.number} ${chalk.gray(pr.title)}`);
  deps.log(chalk.gray(`  ${wt} on ${branch} at ${headSha.slice(0, 8)}`));

  try { await deps.api.startReviewRun(runId, { hostname: deps.hostname, branch, headSha }); } catch (err: any) {
    deps.error(chalk.gray(`  (could not report the start: ${err?.message || err})`));
  }

  const schemaFile = path.join(wt, REVIEW_SCHEMA_FILE);
  const outFile = path.join(wt, packet.resultFile || REVIEW_RESULT_FILE);
  const schema = packet.resultSchema || REVIEW_RESULT_SCHEMA;
  let cursorScope: string | null = null;
  let agyProject: { id: string; file: string } | null = null;
  try {
    fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
    try { fs.rmSync(outFile, { force: true }); } catch { /* absent */ }
    if (agent === 'cursor') cursorScope = writeCursorScope(wt);
    if (agent === 'antigravity') agyProject = createBackgroundProject(wt, `Origin review: PR #${pr.number}`);

    const argv = deps.agentArgvFor(agent, packet.prompt, { schemaFile, outFile, schema }, { antigravityProject: agyProject?.id, model: packet.reviewer.model });
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
    removeCursorScope(cursorScope);
    removeBackgroundProject(agyProject?.file);
    try { fs.rmSync(schemaFile, { force: true }); } catch { /* fine */ }
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
