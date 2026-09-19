// END-TO-END: a session that went quiet is not kept a rival by someone else's save.
//
// "Last seen" for a peer was its state file's mtime, and not everything that
// saves that file is the session. post-commit stamps the new `branch` on every
// session listed for the tree:
//
//   14:06Z  274a6cd2's last own activity
//   14:37Z  [post-commit] branch changed {"from":"…","to":"claude/zealous-payne-637d2b","sessionId":"274a6cd2-…"}   <- ad95e766's commit
//   16:03Z  [post-commit] branch changed {…,"sessionId":"274a6cd2-…"}                                              <- and again
//
// Each rewrite made the dead session "seen" for another ten minutes, so a
// session in a shared checkout stays a rival for as long as its neighbour
// keeps committing — and one sighting marks the neighbour for good.
//
// Built binary, real hooks, real repo, fake API. The quiet peer ran a REAL turn
// (so it is not the resumed-only shape of the sibling test); its recorded times
// are then moved two hours back and the file re-saved, which is exactly what a
// neighbour's branch stamp leaves behind: old activity, fresh mtime.
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

const SESSION_ID = 'e2e-living-session-6161';
const RESUMED_ID = 'e2e-quiet-session-7272';
const SERVER_SESSION = 'e2e-living-0001';

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
          res.end(JSON.stringify({ sessionId: resumed ? 'e2e-quiet-0001' : SERVER_SESSION, verboseCapture: false }));
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

describe.skipIf(!haveDist)('a quiet peer whose state file a neighbour re-saved, through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-quiet-peer-')));
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

  it('the living session is not marked as sharing its checkout', async () => {
    // The peer: a real conversation that ran one real turn here.
    const quietTranscript = path.join(tmp, `${RESUMED_ID}.jsonl`);
    const quietLines: string[] = [];
    const quietSay = (o: unknown) => { quietLines.push(JSON.stringify(o)); fs.writeFileSync(quietTranscript, quietLines.join('\n') + '\n'); };
    fs.writeFileSync(quietTranscript, '');
    const asQuiet = (event: string, payload: Record<string, unknown> = {}) => run(event, payload, RESUMED_ID, quietTranscript);
    expect((await asQuiet('session-start', { source: 'startup' })).code).toBe(0);
    quietSay({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'add a note' }] } });
    expect((await asQuiet('user-prompt-submit', { prompt: 'add a note' })).code).toBe(0);
    const noteInput = { file_path: path.join(repo, 'notes.py'), old_string: 'NOTES = []', new_string: 'NOTES = ["one"]' };
    await asQuiet('pre-tool-use', { tool_name: 'Edit', tool_input: noteInput, tool_use_id: 'q-1' });
    fs.writeFileSync(path.join(repo, 'notes.py'), 'NOTES = ["one"]\n');
    quietSay({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q-1', name: 'Edit', input: noteInput }] } });
    quietSay({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q-1', content: 'ok' }] } });
    await asQuiet('post-tool-use', { tool_name: 'Edit', tool_input: noteInput, tool_use_id: 'q-1', tool_response: { filePath: noteInput.file_path } });
    quietSay({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Added.' }] } });
    expect((await asQuiet('stop', { stop_hook_active: false })).code).toBe(0);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'note']);

    // Two hours pass. Its agent is gone without a session-end, and a
    // neighbour's post-commit has just re-saved its state file.
    const files = stateFilesOf(RESUMED_ID);
    expect(files.length, 'the quiet session left no state file').toBeGreaterThan(0);
    for (const f of files) ageRecordedTimes(f, 2 * 60 * 60 * 1000);
    expect(JSON.parse(fs.readFileSync(files[0], 'utf-8')).status).not.toBe('ENDED');

    // The session the user is working in now.
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

    await edit('tu-1', 'app.py', 'print("old")', 'print("new")');
    await waitFor(() => recorded().includes('"app.py"'), 10_000, 'the journal to record the edit');
    reply('Done.');
    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    const log = hooksLog();
    expect(log).not.toContain('sharing this checkout with other live sessions');
    expect(log).not.toContain('ledger declined: another live session shares this working tree');
    const row = rows().find((r: any) => r.promptIndex === 0);
    expect(row, 'no row after Stop').toBeTruthy();
    expect(row.filesChanged).toEqual(['app.py']);
    expect(['ledger', 'turn-window']).toContain(row.diffSource);
    expect([row.linesAdded, row.linesRemoved]).toEqual([1, 1]);
  }, 180_000 * WINDOWS_SLOWDOWN);
});
