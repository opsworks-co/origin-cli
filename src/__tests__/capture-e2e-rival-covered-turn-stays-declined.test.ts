// END-TO-END: a turn a rival session covered stays declined by the ledger
// after the rival goes quiet.
//
// Prod 208f153c (2026-11-04, Ihor): a second Claude session (2419a3eb) worked
// in the same checkout while turn 27 ran. Turn 27's own Stop declined the
// ledger ("another live session shares this working tree"). The rival then
// sat idle, turn 28's prompt stamped it gone, and turn 28's Stop — judging
// contention for turn 28 alone — rebuilt EVERY row from the journal. Turn 27's
// span held the rival's writes, and row 27 went out as +110/-23 of a test the
// rival edited and a package version it bumped.
//
// Built binary, real hooks, real repo, fake API.
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

const SESSION_ID = 'e2e-self-session-8383';
const RESUMED_ID = 'e2e-rival-session-9494';
const SERVER_SESSION = 'e2e-self-0001';

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
          res.end(JSON.stringify({ sessionId: resumed ? 'e2e-rival-0001' : SERVER_SESSION, verboseCapture: false }));
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

/** Every state file the CLI keeps for a conversation: ~/.origin/sessions and the repo's git dir. */
function stateFilesOf(claudeSessionId: string): string[] {
  const dirs = [path.join(os.homedir(), '.origin', 'sessions'), path.join(repo, '.git')];
  const out: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      try { if (fs.readFileSync(full, 'utf-8').includes(claudeSessionId)) out.push(full); } catch { /* not ours */ }
    }
  }
  return out;
}

/** Move every time a state records `ms` into the past, and re-save it NOW. */
function ageRecordedTimes(file: string, ms: number): void {
  const shift = (v: unknown): unknown => {
    if (typeof v === 'number' && v > 1e12) return v - ms;
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)) return new Date(Date.parse(v) - ms).toISOString();
    if (Array.isArray(v)) return v.map(shift);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
    return v;
  };
  fs.writeFileSync(file, JSON.stringify(shift(JSON.parse(fs.readFileSync(file, 'utf-8'))), null, 2));
}

describe.skipIf(!haveDist)('a turn a rival covered, rebuilt after the rival went quiet, through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-rival-covered-')));
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
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
    fs.writeFileSync(path.join(repo, 'notes.py'), 'NOTES = []\n');
    fs.writeFileSync(path.join(repo, 'rival.py'), 'RIVAL = 1\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      console.log('--- hooks.log ---\n' + hooksLog().split('\n')
        .filter((l) => /ledger|contention|promptChanges payload/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
        .map((l) => l.slice(0, 500)).join('\n'));
    }
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('row 0 keeps none of the rival\'s writes after a later Stop', async () => {
    // The rival: a live conversation with a turn open in this checkout.
    const rivalTranscript = path.join(tmp, `${RESUMED_ID}.jsonl`);
    const rivalLines: string[] = [];
    const rivalSay = (o: unknown) => { rivalLines.push(JSON.stringify(o)); fs.writeFileSync(rivalTranscript, rivalLines.join('\n') + '\n'); };
    fs.writeFileSync(rivalTranscript, '');
    const asRival = (event: string, payload: Record<string, unknown> = {}) => run(event, payload, RESUMED_ID, rivalTranscript);
    expect((await asRival('session-start', { source: 'startup' })).code).toBe(0);
    rivalSay({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'bump the rival' }] } });
    expect((await asRival('user-prompt-submit', { prompt: 'bump the rival' })).code).toBe(0);

    // This session's turn 0, while the rival works.
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);
    say('say new instead of old');
    const ups = await run('user-prompt-submit', { prompt: 'say new instead of old' });
    expect(ups.code, ups.stderr).toBe(0);

    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal to exist');
    const { journal } = journalFiles()!;
    const recorded = () => fs.readFileSync(journal, 'utf-8');
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 400 && !recorded().includes('{"f"'); i++) {
      fs.writeFileSync(probe, String(i));
      await sleep(25);
    }
    expect(recorded(), 'the detached journal watcher recorded nothing').toContain('{"f"');
    await sleep(400);

    // The rival writes into the tree mid-turn, through its own hooks.
    const rivalInput = { file_path: path.join(repo, 'rival.py'), old_string: 'RIVAL = 1', new_string: 'RIVAL = 2  # the rival wrote this' };
    await asRival('pre-tool-use', { tool_name: 'Edit', tool_input: rivalInput, tool_use_id: 'r-1' });
    fs.writeFileSync(path.join(repo, 'rival.py'), 'RIVAL = 2  # the rival wrote this\n');
    rivalSay({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r-1', name: 'Edit', input: rivalInput }] } });
    rivalSay({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r-1', content: 'ok' }] } });
    await asRival('post-tool-use', { tool_name: 'Edit', tool_input: rivalInput, tool_use_id: 'r-1', tool_response: { filePath: rivalInput.file_path } });
    await waitFor(() => recorded().includes('"rival.py"'), 10_000, 'the journal to record the rival\'s write');

    await edit('tu-1', 'app.py', 'print("old")', 'print("new")');
    await waitFor(() => recorded().includes('"app.py"'), 10_000, 'the journal to record the edit');
    reply('Done.');
    const stop0 = await run('stop', { stop_hook_active: false });
    expect(stop0.code, stop0.stderr).toBe(0);
    expect(hooksLog(), 'turn 0 ran contended').toContain('ledger declined: another live session shares this working tree');

    // The rival finishes and falls quiet: two hours pass with its agent idle.
    rivalSay({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Bumped.' }] } });
    expect((await asRival('stop', { stop_hook_active: false })).code).toBe(0);
    for (const f of stateFilesOf(RESUMED_ID)) ageRecordedTimes(f, 2 * 60 * 60 * 1000);

    // Turn 1: uncontended, and its Stop rebuilds every row.
    say('add a note');
    const ups1 = await run('user-prompt-submit', { prompt: 'add a note' });
    expect(ups1.code, ups1.stderr).toBe(0);
    await sleep(400);
    await edit('tu-2', 'notes.py', 'NOTES = []', 'NOTES = ["one"]');
    await waitFor(() => recorded().includes('"notes.py"'), 10_000, 'the journal to record the note');
    reply('Added.');
    const stop1 = await run('stop', { stop_hook_active: false });
    expect(stop1.code, stop1.stderr).toBe(0);

    const all = rows();
    const row0 = all.find((r: any) => r.promptIndex === 0);
    const row1 = all.find((r: any) => r.promptIndex === 1);
    expect(row0, 'no row 0').toBeTruthy();
    expect(row0.filesChanged || [], `row 0 (${row0.diffSource})`).not.toContain('rival.py');
    expect(row0.diff || '', 'row 0 diff').not.toContain('the rival wrote this');
    expect(hooksLog()).toMatch(/ledger declined: another live session shared this working tree during the turn \{"promptIndex":0/);
    expect(row1, 'no row 1').toBeTruthy();
    expect(row1.filesChanged).toEqual(['notes.py']);
    // Turn 1 began after the rival was gone: the ledger may still capture it.
    expect(hooksLog()).toMatch(/turn capture taken from the write journal \{"promptIndex":1/);
  }, 180_000 * WINDOWS_SLOWDOWN);
});
