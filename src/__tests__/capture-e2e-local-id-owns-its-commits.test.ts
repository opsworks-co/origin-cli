// END-TO-END through the built binary: a session that started LOCAL (its
// session/start failed) and reached the server later still owns the commits
// it made while local.
//
// prepare-commit-msg stamps the session's CURRENT id into each commit, so a
// commit made before promotion carries `Origin-Session: local-<6 hex>`. #2032
// made the server remember that id; the CLI's ownership checks compared the
// trailer with the current (server) id only, so after promotion the session's
// own local-trailered commits read as ANOTHER session's. GitHub's squash of
// the session's own PR — committed by GitHub, recorded by nobody — was then
// refused: missing from every commit list the session sent.
//
// Requires `dist/` (`pnpm --filter @origin/cli run build`).
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

const CONV = 'e2e-local-then-promoted-0001';
const SERVER_ID = 'f00dfeed-1234-4abc-8def-0123456789ab';

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';
// While true, session/start fails — the session runs under its `local-` id.
let failStarts = true;

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
          if (failStarts) { res.statusCode = 503; res.end(JSON.stringify({ error: 'unavailable' })); return; }
          res.end(JSON.stringify({ sessionId: SERVER_ID, verboseCapture: false }));
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

let tmp = '';
let repo = '';
let transcript = '';
const lines: string[] = [];

function spawnBin(args: string[], stdin: string | null): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (c) => { stderr += c; });
  child.stdout!.on('data', () => { /* context injection */ });
  if (stdin != null) child.stdin!.end(stdin);
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
const run = (event: string, payload: Record<string, unknown> = {}) => spawnBin(['hooks', 'claude-code', event],
  JSON.stringify({ session_id: CONV, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));
const gitHook = (name: string, args: string[] = []) => spawnBin(['hooks', name, ...args], null);
const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
async function writeTool(id: string, rel: string, content: string) {
  const abs = path.join(repo, rel);
  const input = { file_path: abs, content };
  await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}
/** `git commit` with the real prepare-commit-msg and post-commit hooks. */
async function commitWithHooks(message: string): Promise<string> {
  const msgFile = path.resolve(repo, git(['rev-parse', '--git-dir']), 'COMMIT_EDITMSG');
  fs.writeFileSync(msgFile, message);
  const pcm = await gitHook('git-prepare-commit-msg', [msgFile]);
  expect(pcm.code, pcm.stderr).toBe(0);
  git(['commit', '-q', '-F', msgFile]);
  const pc = await gitHook('git-post-commit');
  expect(pc.code, pc.stderr).toBe(0);
  return git(['rev-parse', 'HEAD']);
}
const stateFile = () => path.join(repo, '.git', `origin-session-${CONV.slice(0, 12)}.json`);
const readState = () => JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
/** Every sha a payload to the server session listed in its gitCapture. */
function capturedShas(): string[] {
  const out: string[] = [];
  for (const h of hits) {
    if (!(h.url.includes(SERVER_ID) || h.body?.sessionId === SERVER_ID)) continue;
    const gc = h.body?.gitCapture;
    for (const s of gc?.commitShas || []) out.push(s);
    for (const d of gc?.commitDetails || []) out.push(d.sha);
  }
  return out;
}
const same = (a: string, b: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

describe.skipIf(!haveDist)('a promoted session still owns the commits it made under its local id', () => {
  let localId = '';
  let squash = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-local-id-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    transcript = path.join(tmp, `${CONV}.jsonl`);
    fs.writeFileSync(transcript, '');
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e-local-id', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e' }));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(['add', '.']);
    const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
    git(['commit', '-q', '-m', 'base'], { GIT_AUTHOR_DATE: earlier, GIT_COMMITTER_DATE: earlier });
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the session starts local and its commit carries the local id', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);
    localId = readState().sessionId;
    expect(localId.startsWith('local-'), `session id ${localId}`).toBe(true);
    await sleep(1100); // committer dates have one-second resolution
    say('add the feature and commit');
    expect((await run('user-prompt-submit', { prompt: 'add the feature and commit' })).code).toBe(0);
    expect(readState().sessionId).toBe(localId);
    await writeTool('t1-1', 'src/feature.ts', 'export const feature = 1;\n');
    git(['add', '-A']);
    await commitWithHooks('feat: the feature\n');
    expect(git(['log', '-1', '--format=%B'])).toContain(`Origin-Session: ${localId.slice(0, 12)} |`);
    toolUse('t1-2', 'Bash', { command: 'git add -A && git commit -m "feat: the feature"' });
    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);
    expect(readState().sessionId).toBe(localId);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('the next prompt reaches the server and keeps the local id', async () => {
    failStarts = false;
    say('the PR was squash-merged; pull main and tidy up');
    const ups = await run('user-prompt-submit', { prompt: 'the PR was squash-merged; pull main and tidy up' });
    expect(ups.code, ups.stderr).toBe(0);
    const st = readState();
    expect(st.sessionId).toBe(SERVER_ID);
    expect(st.localSessionId).toBe(localId);
    const promote = hits.find((h) => h.url.startsWith('/api/mcp/session/start') && h.body?.localSessionId);
    expect(promote?.body?.localSessionId).toBe(localId);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it("GitHub's squash of the session's own PR, trailered with its local id, is the session's", async () => {
    // What `git pull` brings back after the PR merged: GitHub commits a squash
    // whose body keeps the PR commits' trailers. Nobody's post-commit saw it.
    const body = git(['log', '-1', '--format=%B']);
    git(['reset', '-q', '--hard', 'HEAD~1']);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'feature.ts'), 'export const feature = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', `feat: the feature (#12)\n\n* ${body}`], {
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
    });
    squash = git(['rev-parse', 'HEAD']);
    expect(git(['log', '-1', '--format=%B'])).toContain(`Origin-Session: ${localId.slice(0, 12)} |`);
    toolUse('t2-1', 'Bash', { command: 'git pull' });
    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);
    expect(capturedShas().some((s) => same(s, squash)), 'the session never sent its own squash').toBe(true);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
