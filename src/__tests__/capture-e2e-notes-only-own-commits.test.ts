// END-TO-END through the built binary: a session's note lands on the session's
// commits, not on everything HEAD moved past.
//
// `writeGitNotes` writes one payload onto every sha it is handed. Pulling main
// used to stamp the session onto every squash-merge that came along: 15
// bursts, 330 notes on refs/notes/origin (2026-06-12..08-27), 116 from one
// session at once. Stop has dropped foreign commits since #1114; a session end
// that is a REAL end (Gemini here) still noted the raw session-start..HEAD
// range, with `-f`, whenever the session had no commit of its own.
//
// Requires `dist/` (`pnpm --filter @origin/cli run build`).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
let sessionId = '';
let agent = 'claude-code';
const SERVER_ID = 'e2e-notes-session-0001';

let server: http.Server;
let apiUrl = '';
let repo = '';
let tmp = '';
let transcript = '';
const lines: string[] = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      req.on('data', () => { /* drain */ });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) res.end(JSON.stringify({ sessionId: SERVER_ID, verboseCapture: false }));
        else if (u.startsWith('/api/pricing')) res.end(JSON.stringify({ models: {} }));
        else res.end(JSON.stringify({ ok: true }));
      });
    });
    holdIdleConnections(server);
    server.listen(0, '127.0.0.1', () => { apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; resolve(); });
  });
}

function spawnBin(args: string[], stdin?: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: repo, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
  child.stdin.end(stdin ?? '');
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
const run = (event: string, payload: Record<string, unknown> = {}) => spawnBin(['hooks', agent, event],
  JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, ...env } }).trim();
const noteSession = (sha: string): string | null => {
  try { return JSON.parse(git(['notes', '--ref=origin', 'show', sha])).origin.sessionId; } catch { return null; }
};
function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

async function setupRepo(): Promise<void> {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-notes-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  transcript = path.join(tmp, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '');
  lines.length = 0;
  const originDir = path.join(os.homedir(), '.origin');
  fs.mkdirSync(originDir, { recursive: true });
  fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
  fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e' }));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'E2E']);
  git(['config', 'user.email', 'e2e@example.com']);
  fs.writeFileSync(path.join(repo, 'app.py'), 'print("old")\n');
  git(['add', '.']);
  const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
  git(['commit', '-q', '-m', 'base'], { GIT_AUTHOR_DATE: earlier, GIT_COMMITTER_DATE: earlier });
}

async function startTurn(prompt: string): Promise<void> {
  expect((await run('session-start', { source: 'startup' })).code).toBe(0);
  say(prompt);
  expect((await run('user-prompt-submit', { prompt })).code).toBe(0);
  await new Promise((r) => setTimeout(r, 1100)); // commits must be a later second than startedAt
}

/** What `git pull` brings: someone else's PR, squash-merged by GitHub just now. */
function pullSquash(file: string): string {
  fs.writeFileSync(path.join(repo, file), 'THEIRS = 1\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', `their ${file} (#77)`], { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_AUTHOR_NAME: 'Other', GIT_AUTHOR_EMAIL: 'other@example.com' });
  return git(['rev-parse', 'HEAD']);
}

async function stop(): Promise<void> {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  const res = await run('stop', { stop_hook_active: false, last_assistant_message: 'done' });
  expect(res.code, res.stderr).toBe(0);
}

describe.skipIf(!haveDist)('a session notes only its own commits', () => {
  beforeAll(startFakeApi);
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('a session that only pulled notes nothing — its end range is all somebody else\'s', async () => {
    // The burst shape: no commit of its own, so session end had no authored
    // snapshot and noted the raw session-start..HEAD range with `-f`.
    // Gemini: its SessionEnd is a real end. Claude, Cursor, Codex and Copilot
    // route SessionEnd to Stop, which already drops foreign commits.
    sessionId = 'e2e-notes-pull-only-1234';
    agent = 'gemini';
    await setupRepo();
    await startTurn('pull main and look around');
    const a = pullSquash('a.py');
    const b = pullSquash('b.py');
    const c = pullSquash('c.py');
    await stop();
    for (const sha of [a, b, c]) expect(noteSession(sha), `Stop noted pulled ${sha.slice(0, 8)}`).toBeNull();
    const end = await run('session-end', { reason: 'other' });
    expect(end.code, end.stderr).toBe(0);
    for (const sha of [a, b, c]) expect(noteSession(sha), `session end noted pulled ${sha.slice(0, 8)}`).toBeNull();
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('the session\'s own commit keeps its note beside a pulled one', async () => {
    sessionId = 'e2e-notes-own-commit-1234';
    agent = 'claude-code';
    await setupRepo();
    await startTurn('fix the greeting, commit, then pull main');
    fs.writeFileSync(path.join(repo, 'app.py'), 'print("new")\n');
    git(['commit', '-qam', 'fix greeting']);
    const ours = git(['rev-parse', 'HEAD']);
    const squash = pullSquash('theirs.py');
    await stop();
    expect(noteSession(squash)).toBeNull();
    expect(noteSession(ours)).toBe(SERVER_ID);
    const end = await run('session-end', { reason: 'other' });
    expect(end.code, end.stderr).toBe(0);
    expect(noteSession(squash)).toBeNull();
    expect(noteSession(ours)).toBe(SERVER_ID);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
