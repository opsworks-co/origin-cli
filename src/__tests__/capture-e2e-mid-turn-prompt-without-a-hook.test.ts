// END-TO-END: a mid-turn prompt whose SUBMIT HOOK NEVER COMPLETED still gets
// its own turn, and the work and commit made after it (TODO e840ccd5).
//
// capture-e2e-mid-turn-prompt-commits-its-work covers a mid-turn prompt whose
// submit hook ran: it minted the turn id and marked the journal at absorption.
// Prod c085f0af turn 7/8 (2026-09-26) had no submit record at all for the
// absorbed "next task from the list" (the hook was killed under load): no turn
// id, no journal mark, no start — so everything after it, including the test
// file and commit 9d002f9a, stayed on turn 7 (+378) and turn 8 was empty.
// #1938's recovery only runs at the NEXT submit, too late for this turn.
//
// Same scenario as that test, minus the absorbed prompt's hook.
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

const SESSION_ID = 'mc-e2e-midturn-nohook-3232';
const RESUMED_ID = 'unused';
const SERVER_SESSION = 'e2e-midturn-nohook-0001';

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
          const resumed = String(body?.claudeSessionId || body?.agentSessionId || JSON.stringify(body)).includes(RESUMED_ID);
          res.end(JSON.stringify({ sessionId: resumed ? 'e2e-oldconv-0001' : SERVER_SESSION, verboseCapture: false }));
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

function spawnBin(args: string[], stdin?: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(stdin ?? '');
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const run = (event: string, payload: Record<string, unknown> = {}, sessionId = SESSION_ID, transcriptPath = transcript) =>
  spawnBin(['hooks', 'claude-code', event], JSON.stringify({
    session_id: sessionId, transcript_path: transcriptPath, cwd: repo, hook_event_name: event, ...payload,
  }));

/** The git post-commit hook, as `origin enable` wires it. */
function gitHook(name: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name], { cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
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

/** An Edit the agent made, through the hooks that frame it. */
async function edit(id: string, file: string, oldString: string, newString: string): Promise<void> {
  const abs = path.join(repo, file);
  const input = { file_path: abs, old_string: oldString, new_string: newString };
  await run('pre-tool-use', { tool_name: 'Edit', tool_input: input, tool_use_id: id });
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf-8').replace(oldString, newString));
  toolUse(id, 'Edit', input);
  await run('post-tool-use', { tool_name: 'Edit', tool_input: input, tool_use_id: id, tool_response: { filePath: abs } });
}

/** What Claude Code writes when the running turn absorbs a message the user sent meanwhile. */
function absorbMidTurn(text: string) {
  const at = new Date().toISOString();
  lines.push(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: text }));
  lines.push(JSON.stringify({
    type: 'attachment', isSidechain: false, timestamp: at,
    attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: at },
  }));
  lines.push(JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: at, content: text, reason: 'absorbed_mid_turn' }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

const FILES = ['a.py', 'b.py', 'c.py'];
const PROMPTS = ['rename alpha', 'and while you are there, rename beta too', 'now gamma'];

describe.skipIf(!haveDist)('a mid-turn prompt whose submit hook never ran, through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-midturn-nohook-')));
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
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    for (const f of FILES) fs.writeFileSync(path.join(repo, f), `NAME = "old_${f[0]}"\n`);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      console.log('--- hooks.log ---\n' + hooksLog().split('\n')
        .filter((l) => /ledger\]|\[stop\]|user-prompt-submit\]/.test(l) && /promptIndex|payload|captured|shadow|window|kept|merged/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
        .map((l) => l.slice(27, 420)).join('\n'));
      console.log('--- rows ---\n' + JSON.stringify(rows().map((r: any) => [r.promptIndex, r.promptText, r.filesChanged, r.linesAdded, r.linesRemoved, r.commitSha, r.commitShas, r.turnId, r.diffSource])));
      console.log('--- journal ---\n' + (journalFiles() ? fs.readFileSync(journalFiles()!.journal, 'utf-8').split('\n').map((l) => l.slice(0, 200)).join('\n') : 'none'));
    }
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function commit(id: string, file: string, message: string): Promise<string> {
    const cmd = `git add ${file} && git commit -q -m "${message}"`;
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: id });
    git(['add', file]);
    git(['commit', '-q', '-m', message]);
    const sha = git(['rev-parse', 'HEAD']);
    const pc = await gitHook('git-post-commit');
    expect(pc.code, pc.stderr).toBe(0);
    toolUse(id, 'Bash', { command: cmd });
    await run('post-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: id, tool_response: { stdout: '', stderr: '' } });
    return sha;
  }

  it('the absorbed prompt still gets its own turn, and the work and commit made after it', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    say(PROMPTS[0]);
    expect((await run('user-prompt-submit', { prompt: PROMPTS[0] })).code).toBe(0);
    await edit('tu-1', 'a.py', 'old_a', 'new_a');
    const first = await commit('tu-2', 'a.py', 'rename alpha');

    // The user types while the turn runs; Claude Code absorbs it. Its submit
    // hook is killed before it records anything — so no hook runs here.
    absorbMidTurn(PROMPTS[1]);
    await edit('tu-3', 'b.py', 'old_b', 'new_b');
    const second = await commit('tu-4', 'b.py', 'rename beta');
    reply('Both renamed and committed.');
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    const got = rows().sort((x: any, y: any) => x.promptIndex - y.promptIndex);
    expect(got.map((r: any) => r.promptIndex)).toEqual([0, 1]);
    const [a, b] = got;
    // Its own turn: an id of its own, not the interrupted turn's.
    expect(b.turnId, 'the absorbed prompt got no turn id').toBeTruthy();
    expect(b.turnId).not.toBe(a.turnId);
    expect([...(b.filesChanged || [])], 'the mid-turn prompt lost the work done after it').toEqual(['b.py']);
    expect(String(b.diff || '') + String(b.uncommittedDiff || '')).toContain('new_b');
    expect(b.commitSha, 'the commit made after the mid-turn prompt is not on its row').toBe(second);
    expect([...(a.filesChanged || [])], 'the interrupted turn took the later work').toEqual(['a.py']);
    expect(String(a.diff || '') + String(a.uncommittedDiff || '')).not.toContain('new_b');
    expect(a.commitSha).toBe(first);
  }, 180_000 * WINDOWS_SLOWDOWN);
});
