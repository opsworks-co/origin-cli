// END-TO-END, the BUILT binary: a prompt hook that cannot get the state lock
// still files its prompt, under the session the server registered.
//
// The state save lock (#1702) is taken by every writer of a session's state
// file. When it first landed it THREW on timeout, and `user-prompt-submit`'s
// auto-create runs its save inside a `try` whose `catch` is written for API
// failures: a lock timeout was reported as "auto-create failed, falling back
// to local", and the prompt was filed under a `local-<uuid>` id the server has
// never seen and 404s. Measured on the built binary with a live peer holding
// the lock: exit 0, 40.6s, prompts 1 -> 1.
//
// `claude-hook-lock.ts` already sets the policy for this codebase and says
// why: wait a bounded time, then proceed WITHOUT the lock — "a rare lost
// update on state is recoverable, a killed hook is not". This harness pins
// both halves of that: the hook returns well inside Codex's 10s hook budget,
// and the prompt lands on the registered row.
//
// Requires `dist/`. POSIX-only, like the other harnesses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN, isWindows } from './helpers/windows-e2e.js';

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
          res.end(JSON.stringify({ sessionId: `e2e-lock-000${sessionsMinted}`, verboseCapture: false }));
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

let tmp = '';
let turn = 0;

function run(event: string, opts: { cwd: string; conversation: string; transcript: string; payload?: Record<string, unknown> }): Promise<{ code: number | null; stderr: string; tookMs: number }> {
  turn += 1;
  const began = Date.now();
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
    session_id: `e2e-lock-turn-${turn}`,
    hook_event_name: event,
    cursor_version: '2.6.0',
    workspace_roots: [opts.cwd],
    cwd: opts.cwd,
    transcript_path: opts.transcript,
    ...(opts.payload || {}),
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr, tookMs: Date.now() - began })));
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'E2E']);
  git(dir, ['config', 'user.email', 'e2e@example.com']);
  fs.writeFileSync(path.join(dir, 'app.py'), 'print("old")\n');
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

/**
 * Hold the very lock the hook is about to want, exactly the way a live peer
 * process holds it: the lock directory plus an identity file named for a pid
 * that is alive (this test process), so the dead-owner reaper cannot take it.
 */
function holdStateLock(statePath: string): () => void {
  const canonical = path.join(fs.realpathSync.native(path.dirname(statePath)), path.basename(statePath));
  const dir = path.join(os.homedir(), '.origin', 'state-locks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, `${crypto.createHash('sha256').update(canonical).digest('hex')}.state-save-lock`);
  fs.mkdirSync(lockPath, { recursive: true });
  const identity = path.join(lockPath, `${process.pid}-held-by-the-test`);
  fs.writeFileSync(identity, '');
  return () => {
    try { fs.unlinkSync(identity); } catch { /* already gone */ }
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* already gone */ }
  };
}

function killDaemons(): void {
  for (const dir of ['heartbeats', 'journals']) {
    const d = path.join(os.homedir(), '.origin', dir);
    let entries: string[] = [];
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.pid') && !f.endsWith('.lock')) continue;
      const file = path.join(d, f);
      try {
        const pid = Number(fs.readFileSync(file, 'utf-8').trim());
        if (pid > 0) process.kill(pid, 'SIGTERM');
      } catch { /* already gone */ }
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
}

// Codex kills SessionStart and UserPromptSubmit at 10s (`commands/enable.ts`),
// and `withClaudeHookLock` may already have spent time before the save. The
// wait for the state lock has to fit inside what is left of that budget.
const CODEX_HOOK_BUDGET_MS = 10_000;

describe.skipIf(!haveDist || isWindows)('a held state lock never costs the prompt (built binary)', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-lock-timeout-')));
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
    killDaemons();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('auto-create: the prompt lands on the registered session, not a local- phantom', async () => {
    const CONV = 'dddddddd-1111-4000-8000-000000000001';
    const repo = path.join(tmp, 'repo-autocreate');
    initRepo(repo);
    const transcript = transcriptFor(CONV);
    fs.appendFileSync(transcript, JSON.stringify({ role: 'user', content: 'prompt under a held lock' }) + '\n');
    // The tag auto-create will use is the conversation anchor, so the state
    // file — and its lock — are known before the hook ever runs.
    const stateFile = path.join(repo, '.git', `origin-session-${CONV.slice(0, 12)}.json`);
    const startsBefore = hits.filter((h) => h.url.startsWith('/api/mcp/session/start')).length;
    const logFrom = hooksLog().length;

    const release = holdStateLock(stateFile);
    let r: { code: number | null; stderr: string; tookMs: number };
    try {
      r = await run('user-prompt-submit', { cwd: repo, conversation: CONV, transcript, payload: { prompt: 'prompt under a held lock' } });
    } finally { release(); }

    expect(r.code, r.stderr).toBe(0);
    const minted = hits.filter((h) => h.url.startsWith('/api/mcp/session/start')).slice(startsBefore);
    expect(minted.length, 'auto-create registers the session').toBe(1);
    const sessionId = `e2e-lock-000${sessionsMinted}`;

    expect(fs.existsSync(stateFile), `no state file at ${stateFile}\n${hooksLog().slice(logFrom).split('\n').filter((l) => /user-prompt-submit\]|session-state\]/.test(l)).map((l) => l.slice(0, 240)).join('\n')}`).toBe(true);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(st.prompts, 'a lock it could not take must never cost the prompt').toEqual(['prompt under a held lock']);
    expect(st.sessionId, 'the prompt belongs to the registered session, not a local- phantom the server 404s').toBe(sessionId);

    // No second state file was minted under a `local-` id for this repo.
    const localRows = fs.readdirSync(path.join(repo, '.git'))
      .filter((f) => f.startsWith('origin-session-'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(repo, '.git', f), 'utf-8')))
      .filter((s) => typeof s.sessionId === 'string' && s.sessionId.startsWith('local-'));
    expect(localRows, 'a failed save must not fork the session into a local- row').toEqual([]);

    const log = hooksLog().slice(logFrom);
    expect(log, 'the wait must end by proceeding unlocked, and say so').toContain('saving without the state lock');
    expect(log, 'a lock timeout is not an API failure').not.toContain('auto-create failed, falling back to local');
    expect(r.tookMs, `the hook must return inside Codex's ${CODEX_HOOK_BUDGET_MS}ms budget, took ${r.tookMs}ms`).toBeLessThan(CODEX_HOOK_BUDGET_MS);
  }, 180_000 * WINDOWS_SLOWDOWN);

  it('an established session: a held lock costs neither the prompt nor the hook', async () => {
    const CONV = 'dddddddd-2222-4000-8000-000000000002';
    const repo = path.join(tmp, 'repo-established');
    initRepo(repo);
    const transcript = transcriptFor(CONV);
    const stateFile = path.join(repo, '.git', `origin-session-${CONV.slice(0, 12)}.json`);

    const start = await run('session-start', { cwd: repo, conversation: CONV, transcript, payload: { source: 'startup' } });
    expect(start.code, start.stderr).toBe(0);
    const registered = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).sessionId;
    expect(registered.startsWith('e2e-lock-')).toBe(true);

    fs.appendFileSync(transcript, JSON.stringify({ role: 'user', content: 'second prompt under a held lock' }) + '\n');
    const release = holdStateLock(stateFile);
    let r: { code: number | null; stderr: string; tookMs: number };
    try {
      r = await run('user-prompt-submit', { cwd: repo, conversation: CONV, transcript, payload: { prompt: 'second prompt under a held lock' } });
    } finally { release(); }

    expect(r.code, r.stderr).toBe(0);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(st.sessionId).toBe(registered);
    expect(st.prompts).toEqual(['second prompt under a held lock']);
    expect(r.tookMs, `the hook must return inside Codex's ${CODEX_HOOK_BUDGET_MS}ms budget, took ${r.tookMs}ms`).toBeLessThan(CODEX_HOOK_BUDGET_MS);
  }, 180_000 * WINDOWS_SLOWDOWN);
});
