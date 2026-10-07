// END-TO-END, Codex: Stop sends each row what its prompt cost, by model.
//
// A Codex rollout writes a running token total after every model call; each
// prompt's share is how much it grew while that prompt was answered, on the
// model its turn_context names. Before this, Codex rows carried no usage at
// all (prod session fffb0f2b, 2026-09-29: 0 of 2 rows).
//
// Drives the built binary's real Codex hooks against a rollout on disk.
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

const THREAD = '01a0e2e0-0000-7000-8000-00000000c05d';
const SERVER_SESSION = 'e2e-codex-turn-cost-0001';

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


const at = new Date(Date.now() - 5 * 60_000).toISOString();
const total = (input: number, cached: number, output: number) => push({
  timestamp: at, type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } },
});
async function turn(n: number, prompt: string, model: string, usage: () => void) {
  push({ timestamp: at, type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${n}` } });
  // The hook runs before the prompt is in the rollout. Written first, on a
  // loaded box the heartbeat adopted it from the rollout and the hook appended
  // it again. Real sessions don't show that (0 of 11 prod Codex sessions
  // repeat their first prompt, 2026-09-29), so the test keeps this order.
  const submit = await run('user-prompt-submit', { prompt, turn_id: `turn-${n}` });
  expect(submit.code, submit.stderr).toBe(0);
  push({ timestamp: at, type: 'turn_context', payload: { turn_id: `turn-${n}`, model } });
  push({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } });
  push({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } });
  usage();
  push({ timestamp: at, type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${n}`, last_agent_message: 'done' } });
  const stop = await run('stop', { turn_id: `turn-${n}`, last_assistant_message: 'done' });
  expect(stop.code, stop.stderr).toBe(0);
}

describe.skipIf(!haveDist)('each Codex turn\'s cost by model, through the built binary', () => {
  beforeAll(async () => {
    await startFakeApi();
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-codex-turn-cost-')));
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

  it('Stop sends every row its own share, and the shares add up to the session', async () => {
    push({ timestamp: at, type: 'session_meta', payload: { id: THREAD, cwd: repo, cli_version: '0.155.0' } });
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    await turn(1, 'explain the build', 'gpt-6-astra', () => { total(10_000, 4_000, 300); total(25_000, 16_000, 700); });
    await turn(2, 'and the tests?', 'gpt-6-mini', () => { total(55_000, 36_000, 800); });

    const last = (i: number) => rowsFor().filter((r) => r.promptIndex === i).pop();
    expect(last(0)?.modelUsage).toEqual([
      { model: 'gpt-6-astra', inputTokens: 9_000, outputTokens: 700, cacheReadTokens: 16_000, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    ]);
    expect(last(1)?.modelUsage).toEqual([
      { model: 'gpt-6-mini', inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 20_000, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    ]);
    // The session was sent the counts the rows divide.
    const session = hits.filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${SERVER_SESSION}`) && h.body?.inputTokens).pop()!.body;
    expect({ i: session.inputTokens, o: session.outputTokens, c: session.cacheReadTokens }).toEqual({ i: 19_000, o: 800, c: 36_000 });
  }, 240_000 * WINDOWS_SLOWDOWN);
});
