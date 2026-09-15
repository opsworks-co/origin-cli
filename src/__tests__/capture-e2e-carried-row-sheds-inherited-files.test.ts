// END-TO-END: an earlier turn's saved row does not keep re-sending another
// commit's files.
//
// Session c5487aa9 turn 3 ("go ahead") only ran `git checkout --detach
// origin/main`, and a pre-#1648 re-Stop saved it as 5 of #1642's files in
// `completedPromptMappings`, with the checkout's `write_journal` edits in the
// ledger. After upgrading to the fixed CLI every later Stop still re-sent that
// saved row: nothing re-checks an earlier turn, and the shadow-window pass
// declines a contended tree and a window spanning inherited commits.
//
// This test writes the saved row the old CLI left (the state file is the only
// place it lives), runs the next turn through the built binary, and reads what
// Stop sends for the earlier turn.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN, isWindows } from './helpers/windows-e2e.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// ORIGIN_E2E_BIN runs the same scenario through another build — the installed
// release, to watch this test fail without the fix.
const BIN = process.env.ORIGIN_E2E_BIN || path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SESSION_ID = 'e2e-carried-session-7788';
const SERVER_SESSION = 'e2e-carried-0001';

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

function append(entry: Record<string, unknown>) {
  lines.push(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
const say = (text: string) => append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const reply = (text: string) => append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
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

function stateFile(): string {
  const dir = path.join(repo, '.git');
  const f = fs.readdirSync(dir).filter((n) => n.startsWith('origin-session-') && n.endsWith('.json'))
    .map((n) => path.join(dir, n))
    .find((p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')).sessionId === SERVER_SESSION; } catch { return false; } });
  if (!f) throw new Error('no state file for the session');
  return f;
}

/** The row for `promptIndex` in the newest Stop PATCH. */
function lastSentRow(promptIndex: number): any {
  const patches = hits.filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${SERVER_SESSION}`)
    && Array.isArray(h.body?.promptChanges) && h.body.promptChanges.some((p: any) => p.promptIndex === promptIndex));
  return patches.at(-1)?.body.promptChanges.find((p: any) => p.promptIndex === promptIndex);
}

const UPSTREAM_FILES = ['upstream_a.py', 'upstream_b.py'];

describe.skipIf(!haveDist || isWindows)('an earlier turn saved with another commit\'s files, through the built binary', () => {
  let tmp = '';
  let base = '';
  let upstream = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-carried-')));
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
    base = git(['rev-parse', 'HEAD']);

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
        .filter((l) => /ledger|stop\]|shadow window|inherited/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
        .map((l) => l.slice(0, 600)).join('\n'));
    }
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the next Stop sends the earlier turn without the checkout\'s files', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    // Turn 1: only a checkout of the other PR.
    say('go ahead');
    expect((await run('user-prompt-submit', { prompt: 'go ahead' })).code).toBe(0);
    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal to exist');
    const { journal } = journalFiles()!;
    // c5487aa9 shared its worktree with a second live session, so the ledger
    // declined every Stop. See capture-e2e-checkout-restop-stays-empty.
    fs.writeFileSync(`${journal}.contended`, JSON.stringify({ at: Date.now(), peers: ['a-sibling-session'] }));
    const recorded = () => fs.readFileSync(journal, 'utf-8');
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 400 && !recorded().includes('{"f"'); i++) {
      fs.writeFileSync(probe, String(i));
      await sleep(25);
    }
    expect(recorded(), 'the detached journal watcher recorded nothing').toContain('{"f"');
    await sleep(400);

    const checkoutInput = { command: `git checkout -q --detach ${upstream}` };
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: checkoutInput, tool_use_id: 'tu-1' });
    git(['checkout', '-q', '--detach', upstream]);
    toolUse('tu-1', 'Bash', checkoutInput);
    await run('post-tool-use', { tool_name: 'Bash', tool_input: checkoutInput, tool_use_id: 'tu-1', tool_response: { stdout: '', stderr: '', interrupted: false } });
    reply('Checked out.');
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    // Turn 2: a question. Its submit hook re-captures the turn right before it,
    // which would overwrite a saved row for turn 1 — in c5487aa9 the saved
    // turn was several prompts back, where only Stop's carried rows reach it.
    // So the old CLI's row is written after the submit, before the Stop.
    say('what changed?');
    expect((await run('user-prompt-submit', { prompt: 'what changed?' })).code).toBe(0);

    // What a pre-#1648 CLI saved for turn 1: the checkout's files as its row,
    // and the journal's view of them in the ledger.
    const sf = stateFile();
    const state = JSON.parse(fs.readFileSync(sf, 'utf-8'));
    const poisoned = {
      promptIndex: 0, promptText: 'go ahead',
      filesChanged: UPSTREAM_FILES,
      diff: `${git(['diff', base, upstream, '--', ...UPSTREAM_FILES])}\n`,
      uncommittedDiff: '', linesAdded: 60, linesRemoved: 0,
    };
    state.completedPromptMappings = [poisoned, ...(state.completedPromptMappings || []).filter((m: any) => m.promptIndex !== 0)];
    state.liveEdits = [
      ...(state.liveEdits || []),
      {
        promptIndex: 0, toolName: 'origin:write-journal', capturedAt: new Date().toISOString(),
        edits: UPSTREAM_FILES.map((file) => ({
          file, op: 'create', newContent: fs.readFileSync(path.join(repo, file), 'utf-8'),
          source: 'uncommitted', evidence: 'write_journal',
        })),
      },
    ];
    fs.writeFileSync(sf, JSON.stringify(state, null, 2));

    // Turn 2's Stop re-sends turn 1 from the saved row.
    reply('Nothing of ours.');
    const second = await run('stop', { stop_hook_active: false });
    expect(second.code, second.stderr).toBe(0);

    const t1 = lastSentRow(0);
    expect(t1, 'the second Stop sent no row for turn 1').toBeTruthy();
    expect(t1.filesChanged || []).toEqual([]);
    for (const f of UPSTREAM_FILES) {
      expect(String(t1.diff || '')).not.toContain(f);
      expect(String(t1.editsJson || '')).not.toContain(`"file":"${f}"`);
    }
    expect(t1.contentAuthoritative).toBe(true);
    expect(t1.inheritedFiles, 'an internal marker went out on the wire').toBeUndefined();
    expect(hooksLog()).toMatch(/inherited files dropped from an earlier turn \{"promptIndex":0/);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
