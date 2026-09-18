// END-TO-END: a turn that switches branch and THEN edits keeps those edits.
//
// Session ed0e33c8 row 23 (2026-09-18) ran
// `git checkout -q -B claude/platform-shots-fullheight origin/main`, which
// rewrote 36 files, and then edited DossierViewer.tsx and Dossiers.module.css.
// Its row was stored EMPTY, and the release gate read the session as
// `header_exceeds_turns`:
//
//   [ledger] turn capture taken from the write journal {"promptIndex":23,"inherited":36,"files":0,"unavailable":5,"netZero":31}
//   [stop] promptChanges payload [{"i":23,"f":0,"a":0,"r":0,"d":0,"c":null}]
//
// post-checkout wrote a FENCE into the journal, and a fence ended the turn's
// span. The watcher had already recorded the 36 rewrites (it is faster than a
// git hook that has to start node), so the span held exactly those: they
// cancelled against the inherited commit, the ledger called that a usable
// capture, and replaced the row wholesale with nothing. The two edits sat
// behind the fence, in no turn at all.
//
// Built binary, real hook sequence, real repo, fake API — and the hooks in the
// order prod ran them: the rewrites, then the fence, then the edits.
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

const SESSION_ID = 'e2e-fenced-session-7788';
const SERVER_SESSION = 'e2e-fenced-0001';

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
          res.end(JSON.stringify({ sessionId: SERVER_SESSION, verboseCapture: false }));
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

const run = (event: string, payload: Record<string, unknown> = {}) =>
  spawnBin(['hooks', 'claude-code', event], JSON.stringify({
    session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload,
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

// What main gained while this session was away: the other session's work.
const UPSTREAM_ONLY = ['upstream_a.py', 'upstream_b.py'];

describe.skipIf(!haveDist)('edits made after a mid-turn checkout, through the built binary', () => {
  let tmp = '';
  let upstream = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-fenced-')));
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
    fs.writeFileSync(path.join(repo, 'viewer.py'), 'FRAME = "short"\nSTRIPS = "black"\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    git(['branch', 'stale-work']);

    // main moves on: another session's PR, squash-merged on GitHub. It
    // rewrites viewer.py — the file this turn will then edit on top.
    for (const f of UPSTREAM_ONLY) {
      fs.writeFileSync(path.join(repo, f), Array.from({ length: 30 }, (_, i) => `${f.replace('.py', '')}_${i} = ${i}`).join('\n') + '\n');
    }
    fs.writeFileSync(path.join(repo, 'viewer.py'), 'FRAME = "short"\nSTRIPS = "black"\nCAPTION = "fig"\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'feat(platform): captions (#98)\n\nOrigin-Session: 47b6f0e4-923 | Claude Code | 22 prompts'], {
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
    });
    upstream = git(['rev-parse', 'HEAD']);
    // The session resumes in a worktree still parked on the old branch.
    git(['checkout', '-q', 'stale-work']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      console.log('--- hooks.log ---\n' + hooksLog().split('\n')
        .filter((l) => /ledger|stop\]|shadow window|post-checkout/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
        .map((l) => l.slice(0, 600)).join('\n'));
      const jf = journalFiles();
      if (jf) console.log('--- journal ---\n' + fs.readFileSync(jf.journal, 'utf-8'));
    }
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the row holds the two edits, and none of the branch it switched to', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    say('make the screenshots full height and drop the black strips');
    const ups = await run('user-prompt-submit', { prompt: 'make the screenshots full height and drop the black strips' });
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

    // 1. The turn starts from fresh main, on a new branch.
    const prevHead = git(['rev-parse', 'HEAD']);
    const checkoutInput = { command: 'git checkout -q -B feature/full-height main' };
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: checkoutInput, tool_use_id: 'tu-1' });
    git(['checkout', '-q', '-B', 'feature/full-height', 'main']);
    // 2. The watcher sees the rewrites first …
    await waitFor(() => [...UPSTREAM_ONLY, 'viewer.py'].every((f) => recorded().includes(`"${f}"`)), 10_000, 'the journal to record the checkout');
    // 3. … and git's post-checkout hook lands its fence behind them.
    const fence = await spawnBin(['hooks', 'git-post-checkout', prevHead, upstream, '1']);
    expect(fence.code, fence.stderr).toBe(0);
    expect(recorded()).toContain('"k":"f"');
    toolUse('tu-1', 'Bash', checkoutInput);
    await run('post-tool-use', { tool_name: 'Bash', tool_input: checkoutInput, tool_use_id: 'tu-1', tool_response: { stdout: '', stderr: '', interrupted: false } });

    // 4. Then the work: one file the checkout had just rewritten, one it had not.
    const writesBefore = recorded().split('\n').length;
    await edit('tu-2', 'viewer.py', 'FRAME = "short"', 'FRAME = "full"');
    await edit('tu-3', 'app.py', 'print("old")', 'print("new")');
    await waitFor(() => {
      const tail = recorded().split('\n').slice(writesBefore - 1).join('\n');
      return tail.includes('"viewer.py"') && tail.includes('"app.py"');
    }, 10_000, 'the journal to record both edits');

    reply('Full height, no strips.');
    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    const row = rows().find((r: any) => r.promptIndex === 0);
    expect(row, 'no row after Stop').toBeTruthy();
    expect([...(row.filesChanged || [])].sort()).toEqual(['app.py', 'viewer.py']);
    const diff = String(row.diff || '');
    expect(diff).toContain('+FRAME = "full"');
    expect(diff).toContain('+    print("new")');
    // The branch it switched to is somebody else's work: the line main added
    // to viewer.py is context here, never an addition.
    expect(diff).not.toContain('+CAPTION');
    for (const f of UPSTREAM_ONLY) expect(diff).not.toContain(f);
    expect([row.linesAdded, row.linesRemoved]).toEqual([2, 2]);
    // And it is the LEDGER that says so — the producer that emptied the row.
    expect(hooksLog()).toMatch(/turn capture taken from the write journal \{"promptIndex":0,[^}]*"files":2,/);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
