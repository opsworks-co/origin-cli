// The questions around a background run (`origin issue start --background`).
//
// A background run has nobody to ask. Two loops make up for it:
//
//   1. Before it starts — the pre-start pass. The agent reads the issue
//      against the code, read-only and unrecorded (agentPreflightArgv), and
//      answers with a brief of the work or up to 3 questions. Asked in the
//      terminal when there is one; otherwise put on the issue (blocked), and
//      the run does not start.
//   2. After it stops — a run that ends `[Origin: Outcome] blocked — <q>`
//      leaves its question on the issue (the server's issue-clarifications.ts).
//      A person answers there or with `origin issue answer`; the next start
//      resumes that same agent session with the answers when it is on this
//      computer (pickResume), else starts fresh with them in the prompt.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { PREFLIGHT_SCHEMA, RESUMABLE_AGENTS, agentPreflightArgv, parsePreflight, type IssueAgent } from './issue-prompt.js';
import { launchTarget } from './windows-shim.js';

/** One question on the issue, as GET …/issues/:shortId serves it. */
export interface IssueQuestion {
  id: string;
  question: string;
  answer: string | null;
  from: 'run' | 'preflight';
  agent: string | null;
  agentSessionId: string | null;
  /** The Origin session (row id) that asked, when a run did. */
  sessionId: string | null;
}

/** The issue's questions from the API's issue read; [] when it has none (or an older server). */
export function questionsOf(it: any): IssueQuestion[] {
  const list = Array.isArray(it?.clarifications) ? it.clarifications : [];
  return list
    .filter((c: any) => c && typeof c.question === 'string' && c.question.trim())
    .map((c: any) => ({
      id: String(c.id ?? ''),
      question: c.question,
      answer: typeof c.answer === 'string' && c.answer.trim() ? c.answer : null,
      from: c.from === 'preflight' ? 'preflight' : 'run',
      agent: typeof c.agent === 'string' ? c.agent : null,
      agentSessionId: typeof c.agentSessionId === 'string' && c.agentSessionId ? c.agentSessionId : null,
      sessionId: typeof c.sessionId === 'string' && c.sessionId ? c.sessionId : null,
    }));
}

/**
 * The `--agent` name for an agent slug as Origin stores it: sessions record
 * Claude Code as `claude-code` (the capture pipeline's slug), the CLI says `claude`.
 */
export function issueAgentOfSlug(slug: string | null | undefined): string | null {
  const s = (slug || '').toLowerCase();
  if (!s) return null;
  if (s === 'claude-code') return 'claude';
  if (s === 'codex-cli') return 'codex';
  if (s === 'cursor-agent') return 'cursor';
  return s;
}

/**
 * The agent session to resume: the newest question a run of `agent` stopped
 * on, once it — and every question after it — is answered. Null when the
 * newest blocked run was another agent's, an answer is still missing, the
 * agent can't resume headless, or another run came after it.
 *
 * `latestRunSessionId`: the Origin session of the issue's newest run (from
 * the issue read's `runs`), null when that run linked none; undefined when
 * the server didn't say. A run after the one that asked has already gone on
 * (a fresh start with the answers) — resuming the asker would redo its work.
 */
export function pickResume(list: IssueQuestion[], agent: IssueAgent, latestRunSessionId?: string | null): { agentSessionId: string; answers: IssueQuestion[] } | null {
  if (!(RESUMABLE_AGENTS as readonly string[]).includes(agent)) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const q = list[i];
    if (q.from !== 'run') continue;
    if (issueAgentOfSlug(q.agent) !== agent || !q.agentSessionId) return null;
    if (latestRunSessionId !== undefined && q.sessionId && latestRunSessionId !== q.sessionId) return null;
    const since = list.slice(i);
    if (since.some((c) => !c.answer)) return null;
    // Every question that session asked is answered — those are what it hears.
    const answers = since.filter((c) => c.from === 'run' ? c.agentSessionId === q.agentSessionId : true);
    return { agentSessionId: q.agentSessionId, answers };
  }
  return null;
}

/**
 * Is that agent session on this computer, where the run will start? A resume
 * of one that isn't fails at once, so check first and start fresh instead.
 *   claude: ~/.claude/projects/<the worktree's slug>/<id>.jsonl — the worktree
 *           is the same one (same branch), so the slug is too
 *   codex:  its thread in ~/.codex's state db (findCodexRolloutPath)
 */
export async function sessionOnThisComputer(agent: IssueAgent, agentSessionId: string, work: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    if (agent === 'claude') {
      const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
      const file = `${agentSessionId}.jsonl`;
      const slug = path.resolve(work).replace(/[^a-zA-Z0-9]/g, '-');
      if (fs.existsSync(path.join(projects, slug, file))) return true;
      // A long path's folder is cut short with a hash on the end
      // (`…-E2E-3-rate--xhnjbx`): match on the start, then the file.
      const head = slug.slice(0, CLAUDE_SLUG_PREFIX);
      if (slug.length <= CLAUDE_SLUG_PREFIX) return false;
      return fs.readdirSync(projects).some((d) => d.startsWith(head) && fs.existsSync(path.join(projects, d, file)));
    }
    if (agent === 'codex') {
      const { findCodexRolloutPath } = await import('./agents/codex.js');
      const p = findCodexRolloutPath(work, agentSessionId);
      return !!p && fs.existsSync(p);
    }
  } catch { /* can't tell → start fresh */ }
  return false;
}

/** How much of a long project folder name Claude Code keeps before its hash suffix (it keeps 200; match on less). */
const CLAUDE_SLUG_PREFIX = 180;

export interface PreflightResult { ready: boolean; brief: string; questions: string[] }

/** How long the pre-start pass may take before the run starts without it. */
export const PREFLIGHT_TIMEOUT_MS = 4 * 60_000;

/**
 * Run the pre-start pass in `cwd` and read its answer. Null when the agent
 * can't, fails, or runs out of time — the run then starts without a brief.
 */
export async function runPreflight(
  agent: IssueAgent, prompt: string, cwd: string, exe: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<PreflightResult | null> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-preflight-'));
  const schemaFile = path.join(tmp, 'schema.json');
  const outFile = path.join(tmp, 'answer.json');
  try {
    fs.writeFileSync(schemaFile, JSON.stringify(PREFLIGHT_SCHEMA));
    const argv = agentPreflightArgv(agent, prompt, { schemaFile, outFile });
    if (!argv) return null;
    const target = launchTarget(exe, argv.slice(1), { platform: opts.platform ?? process.platform, env: opts.env ?? process.env });
    const stdout = await new Promise<string | null>((resolve) => {
      let out = '';
      let done = false;
      const child = spawn(target.file, target.args, { cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const timer = setTimeout(() => { if (!done) { done = true; try { child.kill(); } catch { /* gone */ } resolve(null); } }, opts.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
      child.stdout?.on('data', (d) => { if (out.length < 2_000_000) out += String(d); });
      child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
      child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve(code === 0 ? out : null); } });
    });
    if (stdout === null) return null;
    let raw = stdout;
    if (agent === 'codex') { try { raw = fs.readFileSync(outFile, 'utf-8'); } catch { /* fall back to stdout */ } }
    return parsePreflight(raw);
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

/**
 * Ask one question in the terminal. Null when there is no terminal to ask in
 * (the web's background start has none) or the person leaves it empty.
 */
export function askInTerminal(question: string, io: { input?: NodeJS.ReadableStream & { isTTY?: boolean }; output?: NodeJS.WritableStream } = {}): Promise<string | null> {
  const input = io.input ?? process.stdin;
  if (!(input as any).isTTY) return Promise.resolve(null);
  const rl = readline.createInterface({ input, output: io.output ?? process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}\n> `, (a) => { rl.close(); resolve(a.trim() ? a.trim() : null); });
    rl.on('SIGINT', () => { rl.close(); resolve(null); });
  });
}
