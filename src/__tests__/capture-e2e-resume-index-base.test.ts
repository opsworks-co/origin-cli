// END-TO-END, the BUILT binary: a RESUMED conversation writes its turns on
// its own rows.
//
// Prod 8a626742 (2026-09-09). A Claude Code conversation with 21 earlier turns
// was resumed; session-start seeded `promptIndexBase: 21` correctly, and the
// transcript numbered the new turn 21. Then four writers used the launch's
// LOCAL counter (0) as if it were the row: the ledger passes looked ids and
// shadows up by row, the prompt-history clip kept rows below `prompts.length`,
// post-commit sent the commit under index 0, and the daemon's end payload
// replayed the saved mappings at 0..2 with no ids. Row 21 was created late by
// the one writer that converted; row 2 — a chat-only turn from the day before
// — took the next turn's commit patch; rows 22/23 never existed; both commits
// rendered one turn early. Unit tests of each piece were green; only the
// assembled hook sequence shows it.
//
// The scenario: a transcript with 21 old prompts, `session-start
// {source:'resume'}`, one turn that writes and commits, one chat-only turn.
// Every per-turn row any hook sends must sit at row 21 or 22 — nothing at 0.
//
// Requires `dist/`. POSIX-only, like the other harnesses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
const SERVER_SESSION = 'e2e-resume-base-0001';

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
    server.listen(0, '127.0.0.1', () => {
      apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

let repo = '';
let transcript = '';
const SESSION_ID = 'e2e-claude-resume-5678';
const PRIOR_TURNS = 21;

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
    session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

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
function flush() { fs.writeFileSync(transcript, lines.join('\n') + '\n'); }
function sayAt(text: string, at: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'text', text }] } }));
  lines.push(JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: `done: ${text}` }] } }));
  flush();
}
function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  flush();
}
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  flush();
}
async function agentWrites(id: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every per-turn row any hook sent, in order. */
function allRows(): any[] {
  return hits
    .filter((h) => (h.method === 'PATCH' || h.method === 'POST') && Array.isArray(h.body?.promptChanges))
    .flatMap((h) => h.body.promptChanges);
}
function lastStopRows(): any[] {
  const p = hits
    .filter((h) => h.method === 'PATCH' && h.url.includes(SERVER_SESSION) && Array.isArray(h.body?.promptChanges))
    .map((h) => h.body);
  return p.length ? p[p.length - 1].promptChanges : [];
}
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

describe.skipIf(!haveDist)('a resumed conversation writes on its own rows', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-resume-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    transcript = path.join(tmp, `${SESSION_ID}.jsonl`);

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
    }));

    git(['init', '-q']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);

    // The conversation so far: 21 turns from yesterday, all before this
    // launch — the cutoff keeps them out of this session's totals and counts
    // them into the base.
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    for (let i = 0; i < PRIOR_TURNS; i++) {
      sayAt(`earlier turn ${i}`, new Date(yesterday + i * 60_000).toISOString());
    }
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('turn 22: the first turn after the resume writes, commits, and lands on row 21', async () => {
    const start = await run('session-start', { source: 'resume' });
    expect(start.code, start.stderr).toBe(0);

    say('resumed: change the greeting and commit');
    const ups = await run('user-prompt-submit', { prompt: 'resumed: change the greeting and commit' });
    expect(ups.code, ups.stderr).toBe(0);

    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal to exist');
    const { journal } = journalFiles()!;
    const writesIn = () => fs.readFileSync(journal, 'utf-8').split('\n').filter((l) => l.startsWith('{"f"')).length;
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 400 && writesIn() === 0; i++) {
      fs.writeFileSync(probe, String(i));
      await sleep(25);
    }
    expect(writesIn(), 'the detached journal watcher recorded nothing').toBeGreaterThan(0);
    await sleep(400);

    await agentWrites('tu-1', 'app.py', 'def main():\n    print("new")\n\n\nmain()\n');
    await waitFor(() => writesIn() >= 2, 10_000, 'the journal to record the write');

    const cmd = 'git add -A && git commit -q -m "new greeting"';
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'tu-2' });
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'new greeting']);
    const sha = git(['rev-parse', 'HEAD']);
    const pc = await gitHook('git-post-commit');
    expect(pc.code, pc.stderr).toBe(0);
    toolUse('tu-2', 'Bash', { command: cmd });
    await run('post-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'tu-2', tool_response: { stdout: '', stderr: '' } });

    // THE BUG, first writer: post-commit stamped the commit under local 0.
    const attested = allRows().find((r: any) => r.commitSha === sha);
    expect(attested, 'post-commit never stamped the commit on any turn').toBeTruthy();
    expect(attested.promptIndex, 'the commit was sent under the LOCAL index').toBe(PRIOR_TURNS);
    expect(attested.turnId).toMatch(/^t_/);
    expect(attested.filesChanged).toEqual(['app.py']);

    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    // THE BUG, second and third writers: the clip kept row 0 and dropped row
    // 21; the ledger then replaced row 0's mapping with this turn's work.
    const rows = lastStopRows();
    expect(rows.length, 'Stop sent no per-turn rows').toBeGreaterThanOrEqual(1);
    const t = rows.find((r: any) => r.promptIndex === PRIOR_TURNS);
    expect(t, `no row for the resumed turn at ${PRIOR_TURNS}; rows were at ${rows.map((r: any) => r.promptIndex).join(',')}`).toBeTruthy();
    expect(t.turnId).toMatch(/^t_/);
    expect(t.filesChanged).toEqual(['app.py']);
    expect(t.diff).toContain('+    print("new")');
    expect(t.linesAdded).toBe(1);
    expect(t.linesRemoved).toBe(1);
    if (t.commitSha) expect(t.commitSha).toBe(sha);

    // Nothing from before the resume is re-sent, and nothing lands at 0.
    for (const r of allRows()) {
      expect(r.promptIndex, `a hook wrote row ${r.promptIndex}, which belongs to a turn from before the resume`).toBeGreaterThanOrEqual(PRIOR_TURNS);
    }
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('turn 23: a chat-only turn is row 22, and row 21 keeps its work', async () => {
    say('thanks, what did we change?');
    await run('user-prompt-submit', { prompt: 'thanks, what did we change?' });
    lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'The greeting.' }] } }));
    flush();
    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    const rows = lastStopRows();
    const t2 = rows.find((r: any) => r.promptIndex === PRIOR_TURNS + 1);
    expect(t2, `no row at ${PRIOR_TURNS + 1}; rows were at ${rows.map((r: any) => r.promptIndex).join(',')}`).toBeTruthy();
    expect(t2.filesChanged).toEqual([]);
    expect(t2.linesAdded || 0).toBe(0);
    const t1 = rows.find((r: any) => r.promptIndex === PRIOR_TURNS);
    expect(t1).toBeTruthy();
    expect(t1.filesChanged).toEqual(['app.py']);
    expect(t1.linesAdded).toBe(1);
    for (const r of allRows()) expect(r.promptIndex).toBeGreaterThanOrEqual(PRIOR_TURNS);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
