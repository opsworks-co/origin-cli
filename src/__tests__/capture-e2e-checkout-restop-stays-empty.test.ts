// END-TO-END: a turn that only checks out someone else's commit stays empty
// on every Stop, not only the first.
//
// Session c5487aa9 turn 3 ("go ahead", 2026-09-15) merged #1642 on GitHub and
// ran `git checkout --detach origin/main`, which wrote #1642's 12 files. The
// first Stop dropped the commit and stored a chat-only turn, then recorded the
// write journal's view of the turn as `write_journal` ledger edits. The re-Stop
// read those edits as the turn's own files, exempted them from the
// foreign-commit drop, and the safety net rebuilt the row:
//
//   [stop] dropped concurrent session commits from turn capture {"dropped":["fcd9ca71"],"files":12}
//   [stop] synthesized current prompt mapping (safety net) {"promptIndex":2,"files":5,...}
//
// Built binary, real hook sequence, real repo, fake API.
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

const SESSION_ID = 'e2e-restop-session-4321';
const SERVER_SESSION = 'e2e-restop-0001';

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

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({
    session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload,
  }));
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

const UPSTREAM_FILES = ['upstream_a.py', 'upstream_b.py'];

// Skipped on Windows at birth with no failure and no POSIX-only construct —
// same audit as #1551 (`realpathSync.native`, inherited env, `path.join`,
// `execFileSync`, Node's SIGTERM). Held files need a recorded Windows miss;
// this one never had one. Timeouts already use WINDOWS_SLOWDOWN.
describe.skipIf(!haveDist)('a re-Stop after a mid-turn checkout, through the built binary', () => {
  let tmp = '';
  let upstream = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-restop-')));
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
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);

    // Another session's PR, squash-merged on GitHub.
    git(['checkout', '-q', '-b', 'upstream']);
    for (const f of UPSTREAM_FILES) {
      fs.writeFileSync(path.join(repo, f), Array.from({ length: 30 }, (_, i) => `${f.replace('.py', '')}_${i} = ${i}`).join('\n') + '\n');
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'fix(codex): resume the exact native conversation (#1642)\n\nOrigin-Session: f53bd03d-2fd | Codex | 31 prompts'], {
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
    });
    upstream = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      console.log('--- hooks.log ---\n' + hooksLog().split('\n')
        .filter((l) => /ledger|stop\]|shadow window|probe/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
        .map((l) => l.slice(0, 600)).join('\n'));
    }
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the turn stays empty on the first Stop and on the re-Stop', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    say('go ahead');
    const ups = await run('user-prompt-submit', { prompt: 'go ahead' });
    expect(ups.code, ups.stderr).toBe(0);

    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal to exist');
    const { journal } = journalFiles()!;
    const recorded = () => fs.readFileSync(journal, 'utf-8');
    // c5487aa9 shared its worktree with a second live session, so every Stop
    // logged `ledger declined: another live session shares this working tree`
    // and the safety net's row was the one stored. Without this the ledger
    // subtracts the checkout on its own and the leak never shows. The marker
    // is what detectLiveContention writes when it finds that peer.
    fs.writeFileSync(`${journal}.contended`, JSON.stringify({ at: Date.now(), peers: ['a-sibling-session'] }));
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 400 && !recorded().includes('{"f"'); i++) {
      fs.writeFileSync(probe, String(i));
      await sleep(25);
    }
    expect(recorded(), 'the detached journal watcher recorded nothing').toContain('{"f"');
    await sleep(400);

    // The turn's only action: check the other PR out, through Bash.
    const checkoutInput = { command: `git checkout -q --detach ${upstream}` };
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: checkoutInput, tool_use_id: 'tu-1' });
    git(['checkout', '-q', '--detach', upstream]);
    toolUse('tu-1', 'Bash', checkoutInput);
    await run('post-tool-use', { tool_name: 'Bash', tool_input: checkoutInput, tool_use_id: 'tu-1', tool_response: { stdout: '', stderr: '', interrupted: false } });
    await waitFor(() => UPSTREAM_FILES.every((f) => recorded().includes(f)), 10_000, 'the journal to record the checkout');

    reply('Checked out.');
    const first = await run('stop', { stop_hook_active: false });
    expect(first.code, first.stderr).toBe(0);
    const afterFirst = rows().find((r: any) => r.promptIndex === 0);
    expect(afterFirst, 'no row after the first Stop').toBeTruthy();
    expect(afterFirst.filesChanged || []).toEqual([]);

    // The same turn stops again — the agent answered once more.
    reply('Still just a checkout.');
    const second = await run('stop', { stop_hook_active: false });
    expect(second.code, second.stderr).toBe(0);
    const t = rows().find((r: any) => r.promptIndex === 0);
    expect(t.filesChanged || []).toEqual([]);
    for (const f of UPSTREAM_FILES) expect(String(t.diff || '')).not.toContain(f);
    expect(hooksLog()).not.toMatch(/synthesized current prompt mapping \(safety net\) \{"promptIndex":0,"files":[1-9]/);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
