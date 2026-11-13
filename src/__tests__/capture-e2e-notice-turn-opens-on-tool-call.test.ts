// END-TO-END: a turn Claude Code runs on a background job's completion notice
// fires no UserPromptSubmit, so the session's turn stamps said "closed" while
// the agent worked, and the Orchestrator's Agents now panel showed it waiting
// for you (this session, 2026-11-04: "waiting 8m" mid-release). The first tool
// call after the Stop now stamps implicitTurnStartedAt, which the heartbeat
// reports as the turn's start; the notice turn's own Stop closes it.
//
// Built binary, real hook sequence, real repo, fake API.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { foldStopRows } from './helpers/fold-stop-rows.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SESSION_ID = 'e2e-notice-turn-session-77';
const SERVER_SESSION = 'e2e-notice-turn-0001';

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';
let repo = '';
let transcript = '';
const lines: string[] = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        hits.push({ method: req.method || '', url: req.url || '', body });
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: SERVER_SESSION, verboseCapture: false }));
        } else if (u.startsWith('/api/pricing')) {
          res.end(JSON.stringify({ models: {} }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    holdIdleConnections(server);
    server.listen(0, '127.0.0.1', () => {
      apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({
    session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function reply(text: string) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function journalFiles(): { journal: string; lock: string } | null {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return null;
  const j = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl') && f.startsWith(SESSION_ID.slice(0, 12)));
  return j ? { journal: path.join(dir, j), lock: path.join(dir, j.replace(/\.jsonl$/, '.lock')) } : null;
}

async function killJournalWatcher(): Promise<void> {
  const jf = journalFiles();
  if (!jf) return;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(jf.lock, 'utf-8').trim());
      if (pid > 0) { process.kill(pid, 'SIGTERM'); return; }
    } catch { /* no lock yet */ }
    await sleep(250);
  }
}

function hooksLog(): string {
  try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; }
}

function rows(): any[] {
  return foldStopRows(hits
    .filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${SERVER_SESSION}`))
    .map((h) => h.body)
    .filter((b) => b && Array.isArray(b.promptChanges)));
}


function stateFile(): any {
  const gitDir = path.join(repo, '.git');
  const f = fs.readdirSync(gitDir).find((n) => /^origin-session.*\.json$/.test(n));
  return f ? JSON.parse(fs.readFileSync(path.join(gitDir, f), 'utf-8')) : null;
}

describe.skipIf(!haveDist)('a tool call after Stop with no prompt opens a turn, through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-notice-turn-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    transcript = path.join(tmp, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, '');
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
    }));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, 'app.py'), 'print("hi")\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('stamps the notice turn at its first tool call and its Stop closes it', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    // A normal prompt turn that launches a background job, then stops.
    say('run the release in the background');
    expect((await run('user-prompt-submit', { prompt: 'run the release in the background' })).code).toBe(0);
    const bg = { command: 'sleep 1', run_in_background: true };
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: bg, tool_use_id: 'tu-1' });
    toolUse('tu-1', 'Bash', bg);
    await run('post-tool-use', { tool_name: 'Bash', tool_input: bg, tool_use_id: 'tu-1', tool_response: { stdout: '', stderr: '' } });
    reply('Started; I will check when it finishes.');
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    const afterStop = stateFile();
    expect(afterStop.lastTurnClosedAt).toBeGreaterThanOrEqual(afterStop.currentTurnStartedAt);
    expect(afterStop.implicitTurnStartedAt ?? 0).toBeLessThan(afterStop.lastTurnClosedAt);

    // The job finishes; Claude Code runs a turn on the notice — no prompt hook.
    await sleep(20);
    const read = { file_path: path.join(repo, 'app.py') };
    await run('pre-tool-use', { tool_name: 'Read', tool_input: read, tool_use_id: 'tu-2' });
    const working = stateFile();
    expect(working.implicitTurnStartedAt).toBeGreaterThan(working.lastTurnClosedAt);
    expect(working.currentTurnStartedAt).toBe(afterStop.currentTurnStartedAt); // capture's turn clock untouched
    const stamped = working.implicitTurnStartedAt;

    // A second tool call in the same notice turn keeps the first stamp.
    await run('post-tool-use', { tool_name: 'Read', tool_input: read, tool_use_id: 'tu-2', tool_response: 'print("hi")' });
    await run('pre-tool-use', { tool_name: 'Read', tool_input: read, tool_use_id: 'tu-3' });
    expect(stateFile().implicitTurnStartedAt).toBe(stamped);

    // The notice turn's Stop closes it: the agent waits for you again.
    reply('The release finished.');
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);
    const done = stateFile();
    expect(done.lastTurnClosedAt).toBeGreaterThan(stamped);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
