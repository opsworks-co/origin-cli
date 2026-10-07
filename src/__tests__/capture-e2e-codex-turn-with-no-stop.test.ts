// END-TO-END, Codex: a turn that ends in an error gets its row even though
// Codex fires no Stop for it (TODO 6d70bb43).
//
// Rows come from Stop. a7bd7e32 (2026-09-18): the chat's last turn ran 20
// commands and ended "You've hit your usage limit"; no Stop fired, nothing
// later re-derived it, and 22 prompts left 21 rows. The heartbeat now reads
// the rollout's `task_complete` and, once Codex's Stop timeout has passed
// with the turn still open, runs the Stop hook itself.
//
// Drives the built binary's real hooks and its real heartbeat daemon.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const THREAD = '01a0e2e0-0000-7000-8000-00000000c0de';
const SERVER_SESSION = 'e2e-codex-nostop-0001';
const PROMPT = 'rename alpha to beta';

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';
let home = '';
let repo = '';
let rollout = '';
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
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) res.end(JSON.stringify({ sessionId: SERVER_SESSION, verboseCapture: false }));
        else if (u.startsWith('/api/pricing')) res.end(JSON.stringify({ models: {} }));
        else res.end(JSON.stringify({ ok: true }));
      });
    });
    holdIdleConnections(server);
    server.listen(0, '127.0.0.1', () => {
      apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

const env = () => ({ ...process.env, HOME: home, USERPROFILE: home, ORIGIN_LIVE_CAPTURE: '1' });

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'codex', event], { cwd: repo, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.resume();
  child.stdin.end(JSON.stringify({ session_id: THREAD, cwd: repo, transcript_path: rollout, model: 'gpt-5-codex', ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

function push(o: Record<string, unknown>) {
  lines.push(JSON.stringify(o));
  fs.writeFileSync(rollout, lines.join('\n') + '\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rowsFor(): any[] {
  return hits
    .filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${SERVER_SESSION}`) && Array.isArray(h.body?.promptChanges))
    .flatMap((h) => h.body.promptChanges);
}

describe.skipIf(!haveDist)('a Codex turn that ends in an error, through the built binary and its heartbeat', () => {
  beforeAll(async () => {
    await startFakeApi();
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-codex-nostop-')));
    repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: env() }).trim();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, 'a.py'), 'NAME = "alpha"\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);

    const origin = path.join(home, '.origin');
    fs.mkdirSync(origin, { recursive: true });
    fs.writeFileSync(path.join(origin, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(origin, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['codex'], orgId: 'org-e2e' }));

    // Codex's layout: a state DB (unreadable here, so the lookup falls back to
    // the rollout on disk) and the rollout under sessions/YYYY/MM/DD.
    const codex = path.join(home, '.codex');
    const day = path.join(codex, 'sessions', '2026', '09', '28');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(codex, 'state_5.sqlite'), '');
    rollout = path.join(day, `rollout-2026-09-28T10-00-00-${THREAD}.jsonl`);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    const dir = path.join(home, '.origin', 'heartbeats');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.pid'))) {
      try { process.kill(Number(fs.readFileSync(path.join(dir, f), 'utf8')), 'SIGTERM'); } catch { /* exited */ }
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  });

  it('the heartbeat runs the Stop Codex never fired, and the read-only turn gets its row', async () => {
    const started = new Date(Date.now() - 20 * 60_000);
    push({ timestamp: started.toISOString(), type: 'session_meta', payload: { id: THREAD, cwd: repo, cli_version: '0.145.0' } });
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    push({ timestamp: started.toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } });
    push({ timestamp: started.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] } });
    const submit = await run('user-prompt-submit', { prompt: PROMPT, turn_id: 'turn-1' });
    expect(submit.code, submit.stderr).toBe(0);

    // The agent only reads (the real turn ran 20 commands and changed no
    // file, so the live diff push had nothing to send), then the turn dies on
    // Codex's usage limit 12 minutes ago — past Codex's 600 s Stop timeout —
    // and no Stop hook fires.
    push({ timestamp: started.toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'cat a.py' }) } });
    push({ timestamp: started.toISOString(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'NAME = "alpha"' } });
    push({ timestamp: new Date(Date.now() - 12 * 60_000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: null, error: { message: "You've hit your usage limit." } } });

    // The heartbeat ticks every 30 s; its Stop then has to finish.
    const deadline = Date.now() + 150_000 * WINDOWS_SLOWDOWN;
    while (Date.now() < deadline && !rowsFor().some((r) => r.promptIndex === 0)) await sleep(500);

    const rows = rowsFor();
    const row = rows.filter((r) => r.promptIndex === 0).pop();
    expect(row, 'the errored turn got no row').toBeTruthy();
    expect(String(row.promptText || '')).toContain('rename alpha');
    expect(row.filesChanged || []).toEqual([]);
    const log = fs.readFileSync(path.join(home, '.origin', 'hooks.log'), 'utf-8');
    expect(log).toContain('codex turn ended with no Stop');
  }, 240_000 * WINDOWS_SLOWDOWN);
});
