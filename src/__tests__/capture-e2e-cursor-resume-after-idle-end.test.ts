// END-TO-END, Cursor, the BUILT binary: the same chat must stay ONE session.
//
// Prod 2026-09-08, conversation 7b2b1608. The heartbeat retired session
// 49b1c722 after 20 idle minutes; the user kept typing in the same Cursor chat;
// the next prompt found no live state, skipped the ENDED archive, auto-created
// twin c1e361a4, and Cursor's transcript replay copied the first session's
// prompts into it. The server could not reopen 49b1c722 either: its row still
// carried the composer id from the main-checkout handshake (dad65359) while
// the chat was 7b2b1608, and every resume rung keys on that id.
//
// Two scenarios, both through `dist/index.js hooks cursor <event>` with
// Cursor's verbatim payload keys against a fake API:
//   1. the session is ended the way the heartbeat ends it (state retired
//      ENDED, archive written, daemon gone) and the chat's next prompt lands
//      on the SAME session id — no second /session/start;
//   2. a session registered from the main checkout under a composer id, whose
//      first prompt arrives from a linked worktree under the real conversation
//      id, pushes that id to the server row.
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
let sessionsMinted = 0;

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
          sessionsMinted += 1;
          res.end(JSON.stringify({ sessionId: `e2e-resume-000${sessionsMinted}`, verboseCapture: false }));
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

let tmp = '';
let turn = 0;

/** One hook, Cursor's way: its verbatim key set on stdin, `session_id` rotating per turn. */
function run(
  event: string,
  opts: { cwd: string; roots: string[]; conversation: string; transcript: string; payload?: Record<string, unknown> },
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'cursor', event], {
    cwd: opts.cwd,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* not asserted */ });
  child.stdin.end(JSON.stringify({
    conversation_id: opts.conversation,
    generation_id: `gen-${turn}`,
    model: 'cursor-e2e-model',
    model_id: 'e2e-model',
    is_background_agent: false,
    composer_mode: 'agent',
    session_id: `e2e-cursor-turn-${turn}`,
    hook_event_name: event,
    cursor_version: '2.6.0',
    workspace_roots: opts.roots,
    cwd: opts.cwd,
    transcript_path: opts.transcript,
    ...(opts.payload || {}),
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'E2E']);
  git(dir, ['config', 'user.email', 'e2e@example.com']);
  fs.writeFileSync(path.join(dir, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
}

function transcriptFor(conversation: string): string {
  const tdir = path.join(tmp, 'agent-transcripts', conversation);
  fs.mkdirSync(tdir, { recursive: true });
  const p = path.join(tdir, `${conversation}.jsonl`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  return p;
}
function say(transcript: string, text: string): void {
  fs.appendFileSync(transcript, JSON.stringify({ role: 'user', content: text }) + '\n');
}

const startHits = () => hits.filter((h) => h.method === 'POST' && h.url.startsWith('/api/mcp/session/start'));
const patchesTo = (sessionId: string) => hits.filter((h) => h.method === 'PATCH' && h.url === `/api/mcp/session/${sessionId}`);
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };
const readState = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const pidFileFor = (sessionId: string) => path.join(os.homedir(), '.origin', 'heartbeats', `${sessionId}.pid`);

function killPidFile(file: string): void {
  try {
    const pid = Number(fs.readFileSync(file, 'utf-8').trim());
    if (pid > 0) process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}
function killDaemons(): void {
  for (const dir of ['heartbeats', 'journals']) {
    const d = path.join(os.homedir(), '.origin', dir);
    let entries: string[] = [];
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const f of entries) if (f.endsWith('.pid') || f.endsWith('.lock')) killPidFile(path.join(d, f));
  }
}

describe.skipIf(!haveDist)('cursor: the same chat stays one session across an idle end (built binary)', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-cursor-resume-')));
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['cursor'], orgId: 'org-e2e',
    }));
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      console.log('--- hooks.log ---\n' + hooksLog().split('\n').filter((l) => /user-prompt-submit\]|session-start\]|findStateForHook|archive|stop\]/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l)).map((l) => l.slice(0, 500)).join('\n'));
      console.log('--- hits ---\n' + hits.map((h) => `${h.method} ${h.url} ${JSON.stringify(h.body).slice(0, 200)}`).join('\n'));
    }
    killDaemons();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('scenario 1: after the heartbeat retired the session, the next prompt in the chat resumes it — no twin', async () => {
    const CONV = 'aa11bb22-e2e0-4444-8888-cccc0000dddd';
    const repo = path.join(tmp, 'repo-a');
    initRepo(repo);
    const transcript = transcriptFor(CONV);
    const stateFile = path.join(repo, '.git', `origin-session-${CONV.slice(0, 12)}.json`);

    // Turn 1 — no sessionStart (Cursor fires it roughly once per launch), so the
    // prompt hook auto-creates.
    turn = 1;
    say(transcript, 'first prompt');
    const ups1 = await run('user-prompt-submit', { cwd: repo, roots: [repo], conversation: CONV, transcript, payload: { prompt: 'first prompt' } });
    expect(ups1.code, ups1.stderr).toBe(0);
    expect(startHits().length).toBe(1);
    expect(startHits()[0].body.agentSessionId, 'auto-create must advertise the conversation id').toBe(CONV);
    const sessionId = 'e2e-resume-0001';
    expect(readState(stateFile).sessionId).toBe(sessionId);
    const stop1 = await run('stop', { cwd: repo, roots: [repo], conversation: CONV, transcript, payload: { status: 'completed' } });
    expect(stop1.code, stop1.stderr).toBe(0);
    await waitFor(() => fs.existsSync(pidFileFor(sessionId)), 10_000, 'the heartbeat daemon to start');

    // The heartbeat's idle end, exactly as endSession() leaves things: the
    // state file retired ENDED, the archive written, the daemon gone.
    const ended = readState(stateFile);
    ended.status = 'ENDED';
    ended.endedAt = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(ended, null, 2));
    const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, `${sessionId.slice(0, 12)}.json`), JSON.stringify(ended));
    killPidFile(pidFileFor(sessionId));

    // Turn 2 — the user keeps typing in the SAME chat.
    turn = 2;
    say(transcript, 'second prompt');
    const patchesBefore = patchesTo(sessionId).length;
    const ups2 = await run('user-prompt-submit', { cwd: repo, roots: [repo], conversation: CONV, transcript, payload: { prompt: 'second prompt' } });
    expect(ups2.code, ups2.stderr).toBe(0);

    // THE FIX: no second session was minted; the ended one is live again.
    expect(startHits().length, 'a second /session/start means a twin').toBe(1);
    expect(hooksLog()).toContain('resuming ended session from archive (same chat)');
    const revived = readState(stateFile);
    expect(revived.sessionId).toBe(sessionId);
    expect(revived.status).toBe('RUNNING');
    expect(revived.endedAt).toBeUndefined();
    expect(revived.prompts.length, 'numbering must continue, not restart at prompt 0').toBe(2);
    expect(patchesTo(sessionId).length, 'the prompt must reach the same server row').toBeGreaterThan(patchesBefore);
    await waitFor(() => fs.existsSync(pidFileFor(sessionId)), 10_000, 'the heartbeat daemon to be restarted');

    const stop2 = await run('stop', { cwd: repo, roots: [repo], conversation: CONV, transcript, payload: { status: 'completed' } });
    expect(stop2.code, stop2.stderr).toBe(0);
    const rows = patchesTo(sessionId).filter((h) => Array.isArray(h.body?.promptChanges)).map((h) => h.body.promptChanges);
    const last = rows[rows.length - 1] || [];
    expect(last.map((r: any) => r.promptIndex).sort()).toEqual([0, 1]);
    expect(startHits().length).toBe(1);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('scenario 2: a main-checkout handshake adopted from a worktree pushes the real conversation id to the server', async () => {
    const COMPOSER = 'c0c0c0c0-0000-4000-8000-000000000001';
    const CONV = 'e2e2e2e2-0000-4000-8000-000000000002';
    const main = path.join(tmp, 'repo-b');
    initRepo(main);
    const wt = path.join(tmp, 'repo-b-wt');
    git(main, ['worktree', 'add', '-q', '-b', 'feat/e2e', wt]);
    const transcript = transcriptFor(CONV);

    // Cursor's sessionStart: fired on the MAIN checkout, under the composer id.
    turn = 3;
    const start = await run('session-start', { cwd: main, roots: [main], conversation: COMPOSER, transcript: transcriptFor(COMPOSER), payload: { source: 'startup' } });
    expect(start.code, start.stderr).toBe(0);
    expect(startHits().length).toBe(2);
    expect(startHits()[1].body.agentSessionId).toBe(COMPOSER);
    const sessionId = 'e2e-resume-0002';

    // The first prompt arrives from the linked worktree under the chat's REAL id.
    turn = 4;
    say(transcript, 'hello from the worktree');
    const ups = await run('user-prompt-submit', { cwd: wt, roots: [wt], conversation: CONV, transcript, payload: { prompt: 'hello from the worktree' } });
    expect(ups.code, ups.stderr).toBe(0);
    expect(startHits().length, 'the worktree prompt must adopt the handshake, not mint a twin').toBe(2);
    expect(hooksLog()).toContain('adopting empty worktree-bootstrap session');

    // THE FIX: the server row learns the conversation id it was missing.
    await waitFor(
      () => patchesTo(sessionId).some((h) => h.body?.agentSessionId === CONV),
      10_000,
      `a PATCH carrying agentSessionId ${CONV}`,
    );
  }, 120_000 * WINDOWS_SLOWDOWN);
});
