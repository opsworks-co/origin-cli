// END-TO-END: a turn Stop closed keeps Stop's row when the next prompt is
// typed in the middle of a background job's pathspec checkout.
//
// Session 874ff028 turn 6. Stop built the right row (4 files, +517/-74). A
// background shell job the agent had started then committed a WIP commit, ran
// `git checkout <older main> -- packages/cli/src` (HEAD unchanged) and only
// later put the tree back with `git checkout HEAD -- packages/cli/src &&
// git reset --soft HEAD~1 && git reset`. The user's next prompt landed while
// the old source was on disk:
//
//   1. the prompt hook's retroactive capture REPLACED Stop's turn-6 row with a
//      diff against the reverted tree — 19 files, +129/-1059, including the 8
//      files of another session's PR (#1676) that the turn never edited;
//   2. turn 7's Stop then showed the mirror, the restoration, as its own work.
//
// No commit enters either window, so every foreign-commit guard misses it.
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
import { WINDOWS_SLOWDOWN, isWindows } from './helpers/windows-e2e.js';
import { foldStopRows } from './helpers/fold-stop-rows.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SESSION_ID = 'e2e-restored-tree-5678';
const SERVER_SESSION = 'e2e-restored-0001';

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

/** A tool call as the agent performs it: PreToolUse → the write → PostToolUse. */
async function agentWrites(id: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
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

const PR_FILES = ['src/pr_one.py', 'src/pr_two.py'];
const TURN_FILE = 'src/mine.py';
const numbered = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}_${i} = ${i}`).join('\n') + '\n';

describe.skipIf(!haveDist || isWindows)('a pathspec checkout straddling the next prompt, through the built binary', () => {
  let tmp = '';
  let older = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-restored-')));
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
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    fs.writeFileSync(path.join(repo, TURN_FILE), numbered('mine', 5));
    for (const f of PR_FILES) fs.writeFileSync(path.join(repo, f), numbered(path.basename(f, '.py'), 5));
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    older = git(['rev-parse', 'HEAD']);

    // Another session's PR, merged on main before this session began (#1676 in
    // the incident): an ancestor of HEAD the turn never touched.
    for (const f of PR_FILES) fs.writeFileSync(path.join(repo, f), numbered(path.basename(f, '.py'), 40));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'fix(capture): recover completed turns before the next prompt (#1676)\n\nOrigin-Session: 805c1429-c4f | Codex | 6 prompts'], {
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
      GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@else.dev',
      GIT_COMMITTER_DATE: '2026-09-10T20:00:00 +0000', GIT_AUTHOR_DATE: '2026-09-10T20:00:00 +0000',
    });
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      console.log('--- hooks.log ---\n' + hooksLog().split('\n')
        .filter((l) => !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
        .map((l) => l.slice(0, 600)).join('\n'));
    }
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('turn 1 keeps Stop\'s row and neither turn carries the restored files', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    say('make the change');
    const ups1 = await run('user-prompt-submit', { prompt: 'make the change' });
    expect(ups1.code, ups1.stderr).toBe(0);

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

    await agentWrites('tu-1', TURN_FILE, numbered('mine', 5) + 'mine_new = "turn one"\n');
    reply('Done.');
    const stop1 = await run('stop', { stop_hook_active: false });
    expect(stop1.code, stop1.stderr).toBe(0);
    const afterStop = rows().find((r: any) => r.promptIndex === 0);
    expect(afterStop?.filesChanged, 'Stop built the turn row').toEqual([TURN_FILE]);

    // A background job the agent started: a WIP commit, then a pathspec
    // checkout of an OLDER commit. HEAD does not move back; no hook fires.
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'wip']);
    git(['checkout', older, '--', 'src']);
    await waitFor(() => PR_FILES.every((f) => recorded().includes(f)), 10_000, 'the journal to record the checkout');

    // The user types the next prompt while the old source is on disk.
    say('now explain it');
    const ups2 = await run('user-prompt-submit', { prompt: 'now explain it' });
    expect(ups2.code, ups2.stderr).toBe(0);

    // The job puts everything back.
    git(['checkout', 'HEAD', '--', 'src']);
    git(['reset', '-q', '--soft', 'HEAD~1']);
    git(['reset', '-q']);
    await sleep(600);

    reply('It adds one line.');
    const stop2 = await run('stop', { stop_hook_active: false });
    expect(stop2.code, stop2.stderr).toBe(0);

    const all = rows();
    const one = all.find((r: any) => r.promptIndex === 0);
    const two = all.find((r: any) => r.promptIndex === 1);
    expect(one, 'no row for turn 1').toBeTruthy();
    expect(one.filesChanged).toEqual([TURN_FILE]);
    expect(String(one.diff || '')).toContain('+mine_new = "turn one"');
    for (const f of PR_FILES) expect(String(one.diff || '')).not.toContain(f);
    expect([one.linesAdded, one.linesRemoved]).toEqual([1, 0]);

    const twoFiles = (two?.filesChanged || []) as string[];
    for (const f of [...PR_FILES, TURN_FILE]) {
      expect(twoFiles).not.toContain(f);
      expect(String(two?.diff || '')).not.toContain(f);
    }
  }, 120_000 * WINDOWS_SLOWDOWN);
});
