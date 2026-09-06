// END-TO-END, Cursor: the BUILT binary, Cursor's real hook sequence and
// payload keys, a real repo, a fake API.
//
// Cursor's `session_id` rotates per turn and `conversation_id` is the stable
// chat id; its hooks are sessionStart / beforeSubmitPrompt / afterFileEdit /
// stop. The Claude Code harness cannot see any of that. This spawns
// `dist/index.js hooks cursor <event>` exactly as Cursor does and asserts the
// Stop row is the ledger's — and that the second turn, whose prompt Cursor
// folded into a running generation and never announced (no beforeSubmitPrompt),
// is still marked when afterFileEdit discovers it, so its writes are its own.
//
// Requires `dist/`. POSIX-only, like the other harnesses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { verifyTurn, parseUnifiedDiff } from '../capture-verify.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);
const posix = process.platform !== 'win32';

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
          res.end(JSON.stringify({ sessionId: 'e2e-cursor-session-0001', verboseCapture: false }));
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
const CONV = 'c0ffee00-e2e0-2222-3333-444455556666';
let turnSessionId = 0;

/** One hook, Cursor's way: its verbatim key set on stdin, `session_id` rotating per turn. */
function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'cursor', event], {
    cwd: repo,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* not asserted */ });
  child.stdin.end(JSON.stringify({
    conversation_id: CONV,
    generation_id: `gen-${turnSessionId}`,
    model: 'cursor-e2e-model',
    model_id: 'e2e-model',
    is_background_agent: false,
    composer_mode: 'agent',
    session_id: `e2e-cursor-turn-${turnSessionId}`,
    hook_event_name: event,
    cursor_version: '2.6.0',
    workspace_roots: [repo],
    cwd: repo,
    transcript_path: transcript,
    ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}

// Cursor's agent transcript: `{role:'user'}` lines and tool_use assistant lines.
const lines: string[] = [];
function say(text: string) {
  lines.push(JSON.stringify({ role: 'user', content: text }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function wrote(file: string, contents: string) {
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { path: path.join(repo, file), contents } }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

function journalFiles(): { journal: string; lock: string } | null {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return null;
  const j = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  if (!j) return null;
  return { journal: path.join(dir, j), lock: path.join(dir, j.replace(/\.jsonl$/, '.lock')) };
}
function writesIn(): number {
  const jf = journalFiles();
  if (!jf) return 0;
  try { return fs.readFileSync(jf.journal, 'utf-8').split('\n').filter((l) => l.startsWith('{"f"')).length; } catch { return 0; }
}
function marksIn(): number {
  const jf = journalFiles();
  if (!jf) return 0;
  try { return (fs.readFileSync(jf.journal, 'utf-8').match(/"k":"t"/g) || []).length; } catch { return 0; }
}
function lastRows(): any[] {
  const p = hits.filter((h) => h.method === 'PATCH' && Array.isArray(h.body?.promptChanges)).map((h) => h.body.promptChanges);
  return p.length ? p[p.length - 1] : [];
}
async function killJournalWatcher(): Promise<void> {
  const jf = journalFiles();
  if (!jf) return;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const pid = Number(fs.readFileSync(jf.lock, 'utf-8').trim()); if (pid > 0) { process.kill(pid, 'SIGTERM'); return; } } catch { /* not yet */ }
    await sleep(250);
  }
}

describe.skipIf(!haveDist || !posix)('cursor capture end to end through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-cursor-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const tdir = path.join(tmp, 'agent-transcripts', CONV);
    fs.mkdirSync(tdir, { recursive: true });
    transcript = path.join(tdir, `${CONV}.jsonl`);
    fs.writeFileSync(transcript, '');

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['cursor'], orgId: 'org-e2e',
    }));

    git(['init', '-q']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      try {
        const jdir = path.join(os.homedir(), '.origin', 'journals');
        for (const f of fs.readdirSync(jdir).filter((n) => n.endsWith('.jsonl'))) {
          console.log(`--- journal ${f} ---\n` + fs.readFileSync(path.join(jdir, f), 'utf-8'));
        }
      } catch (e) { console.log('no journal dir', String(e)); }
      try {
        const log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8').split('\n').filter((l) => /ledger|journal|stop\]|post-tool-use\]|after-file-edit|adopted|pre-mark|antigravity capture|codex-watch/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l));
        console.log('--- hooks.log ---\n' + log.map((l) => l.slice(0, 600)).join('\n'));
      } catch { /* none */ }
    }
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('turn 1: announced by beforeSubmitPrompt, captured from the ledger', async () => {
    turnSessionId = 1;
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);
    say('change the greeting');
    const ups = await run('user-prompt-submit', { prompt: 'change the greeting' });
    expect(ups.code, ups.stderr).toBe(0);

    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal to exist');
    expect(marksIn()).toBe(1);
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 400 && writesIn() === 0; i++) { fs.writeFileSync(probe, String(i)); await sleep(25); }
    expect(writesIn(), 'the detached journal watcher recorded nothing').toBeGreaterThan(0);
    const before = writesIn();
    await sleep(400);

    const content = 'def main():\n    print("new")\n\n\nmain()\n';
    fs.writeFileSync(path.join(repo, 'app.py'), content);
    wrote('app.py', content);
    await waitFor(() => writesIn() > before, 10_000, 'the journal to record the write');
    const afe = await run('after-file-edit', { file_path: path.join(repo, 'app.py'), edits: [] });
    expect(afe.code, afe.stderr).toBe(0);

    const stop = await run('stop', { status: 'completed' });
    expect(stop.code, stop.stderr).toBe(0);
    const t1 = lastRows().find((r: any) => r.promptIndex === 0);
    expect(t1, 'no row for turn 1').toBeTruthy();
    expect(t1.diffSource).toBe('ledger');
    expect(t1.filesChanged).toEqual(['app.py']);
    expect(t1.diff).toContain('-    print("old")');
    expect(t1.diff).toContain('+    print("new")');
    expect(t1.linesAdded).toBe(1);
    expect(t1.linesRemoved).toBe(1);
    expect(parseUnifiedDiff(t1.diff).files[0].isNew).toBe(false);
    expect(verifyTurn({ promptIndex: 0, filesChanged: t1.filesChanged, diff: t1.diff, linesAdded: t1.linesAdded, linesRemoved: t1.linesRemoved })).toEqual([]);
  }, 120_000);

  it('turn 2: never announced — discovered by afterFileEdit, still marked, still its own', async () => {
    turnSessionId = 2;
    // Cursor folded this prompt into the running generation: it is in the
    // transcript, and NO beforeSubmitPrompt fires for it.
    say('now leave a note');
    const before = writesIn();
    const marksBefore = marksIn();
    fs.writeFileSync(path.join(repo, 'notes.md'), 'remember this\n');
    wrote('notes.md', 'remember this\n');
    await waitFor(() => writesIn() > before, 10_000, 'the journal to record the write');
    const afe = await run('after-file-edit', { file_path: path.join(repo, 'notes.md'), edits: [] });
    expect(afe.code, afe.stderr).toBe(0);
    // The adopted turn got its own mark in the journal.
    expect(marksIn()).toBe(marksBefore + 1);

    const stop = await run('stop', { status: 'completed' });
    expect(stop.code, stop.stderr).toBe(0);
    const rows = lastRows();
    const t2 = rows.find((r: any) => r.promptIndex === 1);
    expect(t2, 'no row for turn 2').toBeTruthy();
    expect(t2.filesChanged).toEqual(['notes.md']);
    expect(t2.diff).toContain('+remember this');
    expect(t2.diff).not.toContain('print("new")');
    const t1 = rows.find((r: any) => r.promptIndex === 0);
    expect(t1.filesChanged).toEqual(['app.py']);
    expect(t1.diff).not.toContain('remember this');
  }, 120_000);
});
