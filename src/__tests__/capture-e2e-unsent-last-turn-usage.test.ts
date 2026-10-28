// END-TO-END: a last turn whose Stop died after closing it still gets its
// usage, by a Stop run again with what the heartbeat sends.
//
// Prod fb6968b3: the last turn ("can i close this session?") was chat-only.
// Its Stop exited 1 between markTurnClosedOnDisk and markStopSentOnDisk
// (stopClosing.turn 6, stopSentTurnIndex 5, activeTurn null). Nothing re-sent
// it: stopAbandonedTurn needs the turn to be `activeTurn`, which a chat-only
// turn never is, and the heartbeat's idle end sends no tokens. The row kept no
// usage and the session's totals missed the reply's 222 output tokens.
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
import { markTurnClosedOnDisk } from '../session-state.js';
import { STOP_ABANDONED_AFTER_MS, closedTurnLeftUnsent } from '../turn-commit-scope.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SESSION_ID = 'e2e-unsent-usage-5678';
const SERVER_SESSION = 'e2e-unsent-usage-0001';

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

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
let replies = 0;
function reply(text: string, outputTokens: number) {
  replies++;
  lines.push(JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: {
      role: 'assistant', id: `msg_${replies}`, model: 'claude-opus-5-5', content: [{ type: 'text', text }],
      usage: { input_tokens: 5, output_tokens: outputTokens, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } },
    },
  }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
function hooksLog(): string {
  try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; }
}

const stateFile = (): string => {
  const gitDir = path.join(repo, '.git');
  const f = fs.readdirSync(gitDir).find((n) => n.startsWith('origin-session-') && n.endsWith('.json'));
  if (!f) throw new Error('no session state file');
  return path.join(gitDir, f);
};
const readState = () => JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
const patches = () => hits
  .filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${SERVER_SESSION}`))
  .map((h) => h.body);
const rows = (): any[] => foldStopRows(patches().filter((b) => b && Array.isArray(b.promptChanges)));
const turnOutput = (row: any): number =>
  (row?.modelUsage || []).reduce((a: number, m: any) => a + (m.outputTokens || 0), 0);

describe.skipIf(!haveDist)('a last turn whose Stop died after closing it, through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-unsent-')));
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
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the heartbeat picks the turn, and the Stop it runs sends the turn\'s usage and the whole session\'s totals', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    say('what does app.py do?');
    expect((await run('user-prompt-submit', { prompt: 'what does app.py do?' })).code).toBe(0);
    reply('It prints hi.', 300);
    const first = await run('stop', { stop_hook_active: false });
    expect(first.code, first.stderr).toBe(0);
    expect(readState().stopSentTurnIndex).toBe(0);

    say('can i close this session?');
    expect((await run('user-prompt-submit', { prompt: 'can i close this session?' })).code).toBe(0);
    reply('Yes.', 222);

    // The Stop that died: it closed turn 1 on disk, then exited before sending.
    const s0 = readState();
    const tag = path.basename(stateFile()).replace(/^origin-session-/, '').replace(/\.json$/, '');
    const closedAt = Date.now() - STOP_ABANDONED_AFTER_MS - 60_000;
    expect(markTurnClosedOnDisk(repo, tag, s0.prompts.length - 1, closedAt)).toBe(true);
    const dead = readState();
    expect(dead.stopSentTurnIndex).toBe(0);
    expect(dead.activeTurn ?? null).toBeNull();
    expect(rows().find((r: any) => r.promptIndex === 1)?.modelUsage).toBeFalsy();

    // What the heartbeat decides on its next tick.
    expect(closedTurnLeftUnsent(dead, new Set())).toBe(1);
    expect(closedTurnLeftUnsent(dead, new Set([1]))).toBeNull();

    // A heartbeat tick: the daemon pings once as it starts. It runs the Stop
    // hook for the turn, detached; wait for that Stop to send the row.
    const pidFile = path.join(tmp, 'hb.pid');
    const hb = spawn(process.execPath, [path.join(cliRoot, 'dist', 'heartbeat.js'),
      SERVER_SESSION, apiUrl, 'org_sk_e2e_test_key', pidFile, String(process.pid), stateFile()], {
      cwd: repo, env: process.env, stdio: 'ignore',
    });
    try {
      await waitFor(() => turnOutput(rows().find((r: any) => r.promptIndex === 1)) > 0, 60_000 * WINDOWS_SLOWDOWN, 'the re-run Stop to send the last turn');
      await waitFor(() => readState().stopSentTurnIndex === 1, 20_000 * WINDOWS_SLOWDOWN, 'the re-run Stop to record sending it');
    } finally {
      hb.kill('SIGTERM');
    }
    expect(hooksLog()).toContain('running Stop for it again');

    const t1 = rows().find((r: any) => r.promptIndex === 1);
    expect(t1, 'no row for the last turn').toBeTruthy();
    expect(turnOutput(t1)).toBe(222);
    const withTotals = patches().filter((b) => b && typeof b.outputTokens === 'number');
    expect(withTotals.at(-1)?.outputTokens).toBe(300 + 222);

    const after = readState();
    expect(after.stopSentTurnIndex).toBe(1);
    expect(closedTurnLeftUnsent(after, new Set())).toBeNull();
  }, 120_000 * WINDOWS_SLOWDOWN);
});
