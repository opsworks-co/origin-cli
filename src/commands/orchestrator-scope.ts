// `origin orchestrator …` — hand the Orchestrator a scope and let it split it
// into issues (apps/api services/orchestrator/scopes.ts).
//
//   scope "<text>" [--epic <id>]   split a scope (or an existing epic) for this repo
//   scopes                         list them, with progress
//   approve <scopeId>              the draft's tasks become issues
//   discard <scopeId>
//   split <scopeId> [--background] the runner's part (hidden): run a read-only
//                                  agent in this checkout and post its tasks
//
// The runner (`origin review runner`) claims a split run like any orchestrator
// run and launches `origin orchestrator split <id> --background` in a checkout
// (orchestrator-launch.ts). --background returns at once with the split going
// in a detached child, so a slow agent never holds the runner's poll loop; the
// child posts the tasks (or the error) itself.
import chalk from 'chalk';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { api } from '../api.js';
import { headlessAgentEnv } from '../agent-env.js';
import { isConnectedMode } from '../config.js';
import { agentReviewArgv, isReviewAgent } from '../review-run.js';
import { findOnPath } from './issue-start.js';
import { runAgentProcess } from './review-run.js';

export interface SplitPacket {
  scopeId: string;
  runId: string;
  repoId: string;
  agent: string;
  prompt: string;
  schema: Record<string, unknown>;
}

export interface SplitDeps {
  getPacket: (scopeId: string) => Promise<SplitPacket>;
  postResult: (scopeId: string, data: { ok: boolean; result?: unknown; error?: string }) => Promise<unknown>;
  run: (exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string }>;
  findExe: (name: string) => string | null;
  env: NodeJS.ProcessEnv;
  tmpDir: () => string;
  log: (msg: string) => void;
}

const AGENTS_WITH_SPLIT = new Set(['claude', 'codex', 'gemini', 'cursor', 'copilot']);

/** The agent's answer: codex's -o file, else stdout (claude's JSON envelope, or text with JSON in it). */
export function splitAnswer(stdout: string, outFile: string | null): string {
  if (outFile) {
    try {
      const s = fs.readFileSync(outFile, 'utf-8');
      if (s.trim()) return s;
    } catch { /* not written */ }
  }
  return stdout;
}

/** Parse what the agent printed into JSON the server normalizes; null when there is none. */
export function parseAgentJson(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* fenced, or with prose */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch { /* no */ } }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* no */ } }
  return null;
}

/** Run the split here and post the answer. Never throws: every failure is posted as the scope's error. */
export async function runSplit(scopeId: string, cwd: string, deps: SplitDeps): Promise<{ ok: boolean; error?: string }> {
  let packet: SplitPacket;
  try {
    packet = await deps.getPacket(scopeId);
  } catch (err: any) {
    // Nothing to post to when the packet itself is out of reach.
    return { ok: false, error: `could not read the scope: ${err?.message || err}` };
  }
  const fail = async (error: string) => {
    deps.log(chalk.red(`  ✗ ${error}`));
    await deps.postResult(scopeId, { ok: false, error }).catch(() => {});
    return { ok: false, error };
  };
  const agent = packet.agent;
  if (!AGENTS_WITH_SPLIT.has(agent) || !isReviewAgent(agent)) return fail(`${agent} cannot split a scope (use claude, codex, gemini, cursor or copilot)`);
  const tmp = fs.mkdtempSync(path.join(deps.tmpDir(), 'origin-split-'));
  try {
    const schemaFile = path.join(tmp, 'schema.json');
    const outFile = path.join(tmp, 'answer.json');
    fs.writeFileSync(schemaFile, JSON.stringify(packet.schema));
    const argv = agentReviewArgv(agent, packet.prompt, { schemaFile, outFile, schema: packet.schema as any });
    if (!argv) return fail(`${agent} has no headless mode here`);
    const exe = deps.findExe(argv[0]);
    if (!exe) return fail(`${argv[0]} is not installed on this machine (not on PATH)`);
    deps.log(chalk.gray(`  splitting with ${agent} in ${cwd}…`));
    let r: { code: number; stdout: string };
    try {
      r = await deps.run(exe, argv.slice(1), cwd, headlessAgentEnv(deps.env));
    } catch (err: any) {
      return fail(`${argv[0]} could not start: ${err?.message || err}`);
    }
    const answer = parseAgentJson(splitAnswer(r.stdout, agent === 'codex' ? outFile : null));
    if (answer == null) {
      return fail(r.code !== 0 ? `${argv[0]} exited with code ${r.code} and gave no tasks` : `${argv[0]} finished but printed no JSON with tasks`);
    }
    await deps.postResult(scopeId, { ok: true, result: answer });
    deps.log(chalk.green('  ✓ tasks posted'));
    return { ok: true };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function defaultSplitDeps(): SplitDeps {
  return {
    getPacket: (id) => api.getSplitPacket(id) as Promise<SplitPacket>,
    postResult: (id, data) => api.postSplitResult(id, data),
    // Every agent's stdout: the answer is printed, not written into the checkout.
    run: (exe, args, cwd, env) => runAgentProcess(exe, args, cwd, env, true),
    findExe: (name) => findOnPath(name, process.env, process.platform),
    env: process.env,
    tmpDir: () => os.tmpdir(),
    log: (m) => console.log(m),
  };
}

/** `split <scopeId> [--background]`. Background: start a detached copy of this command and return. */
export async function orchestratorSplitAction(scopeId: string, opts: { background?: boolean } = {}): Promise<void> {
  if (opts.background) {
    const dir = path.join(os.homedir(), '.origin', 'agent-runs');
    fs.mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, `split-${scopeId.replace(/[^A-Za-z0-9-]/g, '')}.log`);
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [process.argv[1], 'orchestrator', 'split', scopeId], {
      cwd: process.cwd(), detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, NO_COLOR: '1' }, windowsHide: true,
    });
    child.unref();
    fs.closeSync(fd);
    console.log(`Splitting scope ${scopeId} in the background (log: ${logFile})`);
    return;
  }
  let cwd = process.cwd();
  try { cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8' }).trim() || cwd; } catch { /* not a checkout: run where we are */ }
  const r = await runSplit(scopeId, cwd, defaultSplitDeps());
  if (!r.ok) process.exitCode = 1;
}

// ── The person's commands ───────────────────────────────────────────────────

async function repoIdHere(): Promise<string> {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  let remote = '';
  try { remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf-8' }).trim(); } catch { /* no remote */ }
  const route = await api.previewRoute({ repoPath: root, ...(remote ? { repoUrl: remote } : {}) });
  const id = (route as any)?.repo?.id;
  if (!id) throw new Error('This checkout is not a repo on Origin yet (run `origin enable` here first), or pass --repo-id');
  return id;
}

function needLogin(): boolean {
  if (isConnectedMode()) return false;
  console.error(chalk.red('The Orchestrator lives on Origin: run `origin login` first.'));
  process.exitCode = 1;
  return true;
}

interface ScopeLike {
  id: string; status: string; epicShortId: string; text: string; agent: string | null; error: string | null;
  tasks: Array<{ key: string; title: string; type: string; priority: number; dependsOn: string[] }>;
  progress: { total: number; closed: number; inProgress: number; open: number } | null;
}

function printScope(s: ScopeLike): void {
  const head = s.text.split('\n')[0].slice(0, 90);
  const status = s.status === 'approved' && s.progress
    ? chalk.green(`approved · ${s.progress.closed}/${s.progress.total} done, ${s.progress.inProgress} in progress`)
    : s.status === 'failed' ? chalk.red('failed') : s.status === 'draft' ? chalk.yellow('waiting for your approval') : chalk.cyan(s.status);
  console.log(`  ${chalk.bold(s.epicShortId)}  ${head}`);
  console.log(`    ${status}  ${chalk.gray(s.id)}`);
  if (s.error) console.log(`    ${chalk.red(s.error)}`);
  if (s.status === 'draft') {
    for (const t of s.tasks) console.log(`    ${t.key}. ${t.title} ${chalk.gray(`[${t.type} P${t.priority}${t.dependsOn.length ? ` after ${t.dependsOn.join(', ')}` : ''}]`)}`);
    console.log(chalk.gray(`    approve: origin orchestrator approve ${s.id}`));
  }
}

export async function orchestratorScopeAction(text: string | undefined, opts: { epic?: string; repoId?: string; json?: boolean } = {}): Promise<void> {
  if (needLogin()) return;
  if (!text?.trim() && !opts.epic) {
    console.error(chalk.red('Describe the scope, e.g. origin orchestrator scope "Add CSV export to the reports page", or pass --epic <id>'));
    process.exitCode = 1;
    return;
  }
  try {
    const repoId = opts.repoId || await repoIdHere();
    const s = await api.createScope({ repoId, text: text?.trim() || null, epicShortId: opts.epic || null }) as ScopeLike;
    if (opts.json) { console.log(JSON.stringify(s, null, 2)); return; }
    console.log(s.status === 'failed' ? chalk.red(`\n  Could not split it: ${s.error}\n`) : chalk.green(`\n  Scope ${s.epicShortId} is being split${s.agent ? ` by ${s.agent} on your runner` : ''}.`));
    if (s.status !== 'failed') console.log(chalk.gray(`  See it with: origin orchestrator scopes  (or on the Orchestrator page)\n`));
    if (s.status === 'failed') process.exitCode = 1;
  } catch (err: any) {
    console.error(chalk.red(err?.message || String(err)));
    process.exitCode = 1;
  }
}

export async function orchestratorScopesAction(opts: { json?: boolean } = {}): Promise<void> {
  if (needLogin()) return;
  try {
    const { scopes } = await api.listScopes() as { scopes: ScopeLike[] };
    if (opts.json) { console.log(JSON.stringify(scopes, null, 2)); return; }
    if (!scopes.length) { console.log(chalk.gray('No scopes yet. Start one: origin orchestrator scope "<what you want done>"')); return; }
    console.log('');
    for (const s of scopes) { printScope(s); console.log(''); }
  } catch (err: any) {
    console.error(chalk.red(err?.message || String(err)));
    process.exitCode = 1;
  }
}

export async function orchestratorApproveAction(scopeId: string): Promise<void> {
  if (needLogin()) return;
  try {
    const s = await api.approveScope(scopeId) as ScopeLike & { issues: Array<{ shortId: string; title: string }> };
    console.log(chalk.green(`\n  ${s.issues.length} issue${s.issues.length === 1 ? '' : 's'} made under ${s.epicShortId}; the Orchestrator takes them on its next check:`));
    for (const i of s.issues) console.log(`    ${i.shortId}  ${i.title}`);
    console.log('');
  } catch (err: any) {
    console.error(chalk.red(err?.message || String(err)));
    process.exitCode = 1;
  }
}

export async function orchestratorDiscardAction(scopeId: string): Promise<void> {
  if (needLogin()) return;
  try {
    await api.discardScope(scopeId);
    console.log(chalk.gray('  Discarded.'));
  } catch (err: any) {
    console.error(chalk.red(err?.message || String(err)));
    process.exitCode = 1;
  }
}
