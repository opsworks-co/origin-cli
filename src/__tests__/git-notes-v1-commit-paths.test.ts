// END-TO-END through the built binary: both commit paths that write a note
// embed a valid v1 attribution record for the commit they annotate.
//
//   - the normal git path: the post-commit hook (`hooks git-post-commit`,
//     exactly how the generated hook invokes it, with ORIGIN_COMMIT_SHA);
//   - the recovery path: a commit that never ran a git hook (Cursor's and
//     Codex's commits often don't) gets its note from Stop.
//
// The record is built by one shared writer (attribution-note.ts), so the full
// eight-agent matrix is pinned against that writer in git-notes-v1-writer.test.ts;
// this file proves the two hook paths actually reach it.
//
// Requires `dist/` (`pnpm --filter @origin/cli run build`). POSIX-only, like
// the harness it is modelled on (capture-e2e-notes-only-own-commits.test.ts).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { readRecord } from '../attribution-record.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);
const SERVER_ID = 'e2e-v1-session-0001';

let sessionId = '';
let agent = 'claude-code';
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

function spawnBin(args: string[], stdin: string, env: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: repo, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection — not asserted */ });
  child.stdin.end(stdin);
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
const run = (event: string, payload: Record<string, unknown> = {}) => spawnBin(['hooks', agent, event],
  JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, ...env } }).trim();
const note = (sha: string): any => {
  try { return JSON.parse(git(['notes', '--ref=origin', 'show', sha])); } catch { return null; }
};
function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

async function setupRepo(): Promise<void> {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-v1-')));
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

async function stop(): Promise<void> {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  const res = await run('stop', { stop_hook_active: false, last_assistant_message: 'done' });
  expect(res.code, res.stderr).toBe(0);
}

function expectRecordFor(sha: string, expectedAgent: string): any {
  const n = note(sha);
  expect(n, `no note on ${sha.slice(0, 8)}`).not.toBeNull();
  // Legacy envelope, as every existing reader expects it.
  expect(n.origin.sessionId).toBe(SERVER_ID);
  expect(n.origin.version).toBe(1);
  const record = n.attribution_record;
  expect(record, 'note has no attribution_record').toBeDefined();
  expect(readRecord(record).status).toBe('exact');
  expect(record.revision).toEqual({ vcs: 'git', id: sha });
  expect(record.contributions[0].agent).toEqual({ id: expectedAgent });
  expect(record.contributions[0].session.id).toBe(SERVER_ID);
  // Connected to a server that knows the session: the record points at it.
  expect(record.contributions[0].session.reference_uri).toBe(`${apiUrl}/sessions/${SERVER_ID}`);
  const serialized = JSON.stringify(record);
  expect(serialized).not.toContain('greeting');
  return record;
}

describe.skipIf(!haveDist)('both commit paths embed the v1 record', () => {
  beforeAll(startFakeApi);
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('normal git path: the post-commit hook writes the record for the commit it fired on', async () => {
    sessionId = 'e2e-v1-post-commit-1234';
    agent = 'claude-code';
    await setupRepo();
    await startTurn('fix the greeting and commit');
    fs.writeFileSync(path.join(repo, 'app.py'), 'print("new")\n');
    git(['commit', '-qam', 'fix greeting']);
    const sha = git(['rev-parse', 'HEAD']);
    // What the generated post-commit hook runs (backgrounded there; awaited here).
    const res = await spawnBin(['hooks', 'git-post-commit'], '', { ORIGIN_COMMIT_SHA: sha });
    expect(res.code, res.stderr).toBe(0);
    expectRecordFor(sha, 'claude-code');
  }, 120_000 * WINDOWS_SLOWDOWN);

  for (const recoveringAgent of ['claude-code', 'gemini']) {
    it(`recovery path (${recoveringAgent}): Stop notes a commit that ran no git hook`, async () => {
      sessionId = `e2e-v1-stop-${recoveringAgent}-1234`;
      agent = recoveringAgent;
      await setupRepo();
      await startTurn('fix the greeting and commit');
      fs.writeFileSync(path.join(repo, 'app.py'), 'print("new")\n');
      // The fixture git config disables hooks, like an agent whose commits
      // bypass them: no post-commit, so no note until Stop.
      git(['commit', '-qam', 'fix greeting']);
      const sha = git(['rev-parse', 'HEAD']);
      expect(note(sha)).toBeNull();
      await stop();
      expectRecordFor(sha, recoveringAgent);
    }, 120_000 * WINDOWS_SLOWDOWN);
  }
});
