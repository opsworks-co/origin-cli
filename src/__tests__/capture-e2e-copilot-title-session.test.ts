// END-TO-END: the GitHub Copilot desktop app's chat-naming side session,
// through the BUILT binary, against a fake API.
//
// To title a new chat the app runs a second Copilot session in the same
// worktree whose only prompt is "Name this session based on the user's first
// message: <user_message>…</user_message>". It fires every Copilot hook, and
// Origin registered it as a session of its own (prod 586d9dd8, 2026-09-29):
// titled with that prompt, left RUNNING, and its state file in the worktree
// was kept as a candidate owner of the real chat's commits.
//
// The hook order is the one hooks.log recorded for it: userPromptSubmitted
// BEFORE sessionStart (which carries the same text as `initialPrompt`), then
// agentStop and sessionEnd with no prompt at all.
//
// Requires `dist/` (CI builds before it tests).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';

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
          res.end(JSON.stringify({ sessionId: 'e2e-copilot-real-chat', verboseCapture: false }));
        } else if (u.startsWith('/api/pricing')) {
          res.end(JSON.stringify({ models: {} }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    holdIdleConnections(server);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      apiUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

let repo = '';
// First 12 characters name the state file, so they differ from every other capture-e2e session.
const TITLE_SESSION = 'cptitle-e2e-8cfb-4e32-b3a1-2d6c8a0b1e2f';
const REAL_SESSION = 'cpreal-e2e-d0a3-4798-8ba5-953c94405c36';
const TITLE_PROMPT = "Name this session based on the user's first message:\n\n<user_message>\ncheck what's in this repo\n</user_message>";

function run(event: string, payload: Record<string, unknown>): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'copilot', event], {
    cwd: repo,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* not asserted */ });
  child.stdin.end(JSON.stringify({ timestamp: Date.now(), cwd: repo, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

const starts = () => hits.filter((h) => h.method === 'POST' && h.url.startsWith('/api/mcp/session/start'));
const stateFiles = () => fs.readdirSync(path.join(repo, '.git')).filter((f) => f.startsWith('origin-session-'));

describe.skipIf(!haveDist)('the Copilot app\'s chat-naming session end to end through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-cptitle-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['copilot'], orgId: 'org-e2e',
    }));

    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('registers no session, sends nothing, and leaves no state file for the naming session', async () => {
    const ups = await run('user-prompt-submit', { sessionId: TITLE_SESSION, prompt: TITLE_PROMPT });
    expect(ups.code, ups.stderr).toBe(0);
    const start = await run('session-start', { sessionId: TITLE_SESSION, source: 'new', initialPrompt: TITLE_PROMPT });
    expect(start.code, start.stderr).toBe(0);
    const stop = await run('stop', { sessionId: TITLE_SESSION, stopReason: 'end_turn' });
    expect(stop.code, stop.stderr).toBe(0);
    const end = await run('session-end', { sessionId: TITLE_SESSION, reason: 'complete' });
    expect(end.code, end.stderr).toBe(0);

    expect(starts(), 'the naming session reached session/start').toHaveLength(0);
    expect(hits.filter((h) => h.url.startsWith('/api/mcp/session')), 'the naming session sent session traffic').toHaveLength(0);
    expect(stateFiles(), 'the naming session left a state file in the worktree').toEqual([]);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('the real chat in the same worktree is still captured', async () => {
    const start = await run('session-start', { sessionId: REAL_SESSION, source: 'new', initialPrompt: "check what's in this repo" });
    expect(start.code, start.stderr).toBe(0);

    expect(starts(), 'the real chat never reached session/start').toHaveLength(1);
    expect(stateFiles().some((f) => f.startsWith(`origin-session-${REAL_SESSION.slice(0, 12)}`)),
      `no state file for the real chat: ${stateFiles().join(', ')}`).toBe(true);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
