// END-TO-END: a turn's commit patch joined from two branches keeps BOTH
// branches' sections of a file they both changed when a LATER Stop sends the
// turn's saved row — through the built binary and the real hook sequence.
//
// Session df8cc9aa turn 34 committed on two PR branches that each bumped the
// CLI version. Its writes were shell commands, so the transcript held no edit
// for it and the merge kept the SAVED row object itself. Stop's last-line
// tidy-up (normalizeTurnDiff: one section per file, first seen wins) then cut
// the second branch's package.json out of that object, and the reuse pass sent
// it: +717/-19 over 88,309 bytes where the full patch is 90,595 —
// verify-capture's "row says +717/-19, stored diff contains +714/-16", a
// contradiction that blocks a CLI release once the session ends.
//
// Requires `dist/` (CI builds before it tests). POSIX-only, like the harness
// it is modelled on (capture-e2e-amend-real-binary.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { diffTotals, parseUnifiedDiff } from '../capture-verify.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';
const API_SESSION = 'e2e-reused-row-session-0001';

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
const SESSION_ID = 'e2e-claude-reused-row-1';

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

describe.skipIf(!haveDist)('a reused row of a turn that committed on two branches', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-reused-row-')));
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
    fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "vodka",\n  "version": "1.0.0"\n}\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const bump = (version: string) => fs.writeFileSync(path.join(repo, 'package.json'), `{\n  "name": "vodka",\n  "version": "${version}"\n}\n`);
  const turn0 = () => patches()
    .filter((b) => Array.isArray(b?.promptChanges))
    .map((b) => b.promptChanges.find((r: any) => r.promptIndex === 0))
    .filter(Boolean);

  it('every later Stop sends both branches\' package.json, and the counts match the text', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);
    say('fix both and bump the version on each PR');
    const ups = await run('user-prompt-submit', { prompt: 'fix both and bump the version on each PR' });
    expect(ups.code, ups.stderr).toBe(0);
    await sleep(400);

    // Shell writes only: the transcript holds no edit for this turn.
    await agentShell('tu-1', 'git checkout -b fix-a', [['checkout', '-q', '-b', 'fix-a']]);
    bump('1.0.1');
    fs.writeFileSync(path.join(repo, 'a.py'), 'A = 1\n');
    await agentShell('tu-2', 'npm version patch && git commit -am "fix a"', [['add', '-A'], ['commit', '-q', '-m', 'fix a']], true);
    await agentShell('tu-3', 'git checkout -b fix-b main', [['checkout', '-q', '-b', 'fix-b', 'main']]);
    bump('1.0.2');
    fs.writeFileSync(path.join(repo, 'b.py'), 'B = 1\n');
    await agentShell('tu-4', 'npm version patch && git commit -am "fix b"', [['add', '-A'], ['commit', '-q', '-m', 'fix b']], true);
    await agentShell('tu-5', 'git checkout main', [['checkout', '-q', 'main']]);
    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);
    const first = turn0().pop();
    expect(first, 'no row for the committing turn').toBeTruthy();
    expect((first.diff.match(/^diff --git a\/package\.json /gm) || []).length, first.diff).toBe(2);

    // Two chat-only follow-ups: the first one's Stop still rebuilds turn 0
    // (it was not closed at the previous Stop); the second one reuses it.
    for (const prompt of ['thanks, anything else?', 'ok, and now?']) {
      say(prompt);
      const u = await run('user-prompt-submit', { prompt });
      expect(u.code, u.stderr).toBe(0);
      await sleep(400);
      const s = await run('stop', { stop_hook_active: false });
      expect(s.code, s.stderr).toBe(0);
    }
    const log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8');
    expect(log, 'the last Stop did not reuse the settled turn').toMatch(/settled turns \{"reused":[1-9]/);

    const last = turn0().pop();
    expect(last.diff).toContain('+  "version": "1.0.1"');
    expect(last.diff).toContain('+  "version": "1.0.2"');
    const t = diffTotals(parseUnifiedDiff(last.diff));
    expect([last.linesAdded, last.linesRemoved], last.diff).toEqual([t.added, t.removed]);
    expect(last.diff.length).toBe(first.diff.length);
  }, 180_000 * WINDOWS_SLOWDOWN);
});
