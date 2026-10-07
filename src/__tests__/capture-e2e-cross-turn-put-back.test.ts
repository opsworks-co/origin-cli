// END-TO-END: a change one turn moved off the tree and the next turn put back
// is neither turn's — through the BUILT binary and the real hook sequence.
//
// Session df8cc9aa (2026-10-01): turn 8 wrote a fix; turn 9 saved it to the
// scratchpad and reset the files to prove the new test failed without it
// (+6/-306); turn 10, a prompt that arrived mid-work, copied it back and
// committed, and the commit patch billed it the whole fix again (+309/-9).
// verify-capture: "the same ordered additions and deletions on turns 8, 10".
//
// Requires `dist/` (CI builds before it tests). POSIX-only, like the harness
// it is modelled on (capture-e2e-several-branches-real-binary.test.ts).
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
const API_SESSION = 'e2e-put-back-session-0001';

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
          res.end(JSON.stringify({ sessionId: API_SESSION, verboseCapture: false }));
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
let transcript = '';
const SESSION_ID = 'e2e-claude-put-back-1';

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection — not asserted */ });
  child.stdin.end(JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: transcript,
    cwd: repo,
    hook_event_name: event,
    ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

/** The git post-commit hook, as `origin enable` wires it. */
function gitHook(name: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name], {
    cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const lines: string[] = [];
function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

async function agentWrites(id: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

/** A shell command the agent runs; `commit` fires post-commit, wired to us. */
async function agentShell(id: string, command: string, gitArgs: string[][], commit = false): Promise<string> {
  await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  for (const args of gitArgs) git(args);
  const sha = git(['rev-parse', 'HEAD']);
  if (commit) {
    const pc = await gitHook('git-post-commit');
    expect(pc.code, pc.stderr).toBe(0);
  }
  toolUse(id, 'Bash', { command });
  await run('post-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id, tool_response: { stdout: '', stderr: '' } });
  return sha;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function journalFiles(): { journal: string; lock: string } | null {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return null;
  const j = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl') && f.startsWith(SESSION_ID.slice(0, 12)));
  if (!j) return null;
  return { journal: path.join(dir, j), lock: path.join(dir, j.replace(/\.jsonl$/, '.lock')) };
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

/** Every PATCH the session sent, oldest first. */
const patches = () => hits.filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${API_SESSION}`)).map((h) => h.body);

describe.skipIf(!haveDist)('a change moved off the tree on one turn and put back on the next', () => {
  let tmp = '';
  let stash = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-put-back-')));
    repo = path.join(tmp, 'repo');
    stash = path.join(tmp, 'stash');
    fs.mkdirSync(repo);
    fs.mkdirSync(stash);
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
    fs.writeFileSync(path.join(repo, 'hook.py'), 'def run():\n    return 1\n');
    fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const rowOf = (i: number) => patches()
    .filter((b) => Array.isArray(b?.promptChanges))
    .map((b) => b.promptChanges.find((r: any) => r.promptIndex === i))
    .filter(Boolean)
    .pop();

  async function turn(prompt: string, work: () => Promise<void>) {
    say(prompt);
    const ups = await run('user-prompt-submit', { prompt });
    expect(ups.code, ups.stderr).toBe(0);
    await sleep(400);
    await work();
    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);
  }

  it('the writing turn keeps the fix; the moving and restoring turns carry only their own work', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    const fix = 'def run():\n    return verdict()\n\n\ndef verdict():\n    return 2\n';
    const marker = 'MARK = "replay"\nKIND = "pick"\n';
    await turn('fix the replay verdict gap', async () => {
      await agentWrites('tu-1', 'hook.py', fix);
      await agentWrites('tu-2', 'marker.py', marker);
    });
    await turn('once it passes, open the PR', async () => {
      // Prove the new test fails without the fix: move it aside, reset.
      fs.copyFileSync(path.join(repo, 'hook.py'), path.join(stash, 'hook.py'));
      fs.renameSync(path.join(repo, 'marker.py'), path.join(stash, 'marker.py'));
      await agentShell('tu-3', `cp hook.py ${stash}/ && mv marker.py ${stash}/ && git checkout -- hook.py`, [['checkout', '--', 'hook.py']]);
    });
    await turn('and cut a release after the merge', async () => {
      fs.copyFileSync(path.join(stash, 'hook.py'), path.join(repo, 'hook.py'));
      fs.copyFileSync(path.join(stash, 'marker.py'), path.join(repo, 'marker.py'));
      fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "version": "1.0.1"\n}\n');
      await agentShell('tu-4', `cp ${stash}/hook.py ${stash}/marker.py . && npm version patch && git commit -am "fix"`,
        [['add', '-A'], ['commit', '-q', '-m', 'fix the replay verdict gap']], true);
    });
    await turn('is it live?', async () => { /* chat only */ });

    const log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8');
    const why = log.split('\n').filter((l) => /put back|commit patch|turn window|settled turns/.test(l)).slice(-20).join('\n');
    const [r0, r1, r2] = [rowOf(0), rowOf(1), rowOf(2)];
    expect(r0, why).toBeTruthy();
    expect([...r0.filesChanged].sort(), why).toEqual(['hook.py', 'marker.py']);
    expect(r1.filesChanged, why).toEqual([]);
    expect([r1.linesAdded, r1.linesRemoved], why).toEqual([0, 0]);
    expect(r2.filesChanged, why).toEqual(['package.json']);
    expect([r2.linesAdded, r2.linesRemoved], why).toEqual([1, 1]);
    expect(r2.diff).not.toContain('hook.py');
    expect(log).toContain('a change one turn took off and the next put back left both rows');
  }, 180_000 * WINDOWS_SLOWDOWN);
});
