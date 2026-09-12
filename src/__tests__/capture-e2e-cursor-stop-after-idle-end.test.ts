// END-TO-END, Cursor, the BUILT binary: a Stop that arrives after the
// heartbeat idle-ended the chat's session, from a linked WORKTREE, with the
// archived twin's mirror still lying around, lands on the chat's own session.
//
// Prod 2026-09-09, conversation da82f522: the session (e24477e2, worktree)
// was retired ENDED at 04:24; the agent kept working; at 05:41–06:03 its file
// edits and Stop found no live repo state, fell to the mirror, and adopted
// 5431ff0f — the archived twin's leftover RUNNING mirror (composer id, six
// copied prompts, main checkout). Two things let that happen: the mirror
// fallback took a row naming another chat, and Stop's own archive recovery
// matched `repoPath` against the PRIMARY checkout, so the worktree session's
// exact-chat ENDED archive was never considered.
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
          res.end(JSON.stringify({ sessionId: `e2e-idle-stop-000${sessionsMinted}`, verboseCapture: false }));
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
function run(event: string, opts: { cwd: string; roots: string[]; conversation: string; transcript: string; payload?: Record<string, unknown> }): Promise<{ code: number | null; stderr: string }> {
  turn += 1;
  const child = spawn(process.execPath, [BIN, 'hooks', 'cursor', event], { cwd: opts.cwd, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* not asserted */ });
  child.stdin.end(JSON.stringify({
    conversation_id: opts.conversation, generation_id: `gen-${turn}`, model: 'cursor-e2e-model', model_id: 'e2e-model',
    is_background_agent: false, composer_mode: 'agent', session_id: `e2e-cursor-turn-${turn}`, hook_event_name: event,
    cursor_version: '2.6.0', workspace_roots: opts.roots, cwd: opts.cwd, transcript_path: opts.transcript, ...(opts.payload || {}),
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'E2E']); git(dir, ['config', 'user.email', 'e2e@example.com']);
  fs.writeFileSync(path.join(dir, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
  git(dir, ['add', '.']); git(dir, ['commit', '-q', '-m', 'base']);
}
function transcriptFor(conversation: string): string {
  const tdir = path.join(tmp, 'agent-transcripts', conversation);
  fs.mkdirSync(tdir, { recursive: true });
  const p = path.join(tdir, `${conversation}.jsonl`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  return p;
}
const say = (t: string, text: string) => fs.appendFileSync(t, JSON.stringify({ role: 'user', content: text }) + '\n');
const startHits = () => hits.filter((h) => h.method === 'POST' && h.url.startsWith('/api/mcp/session/start'));
const patchesTo = (id: string) => hits.filter((h) => h.method === 'PATCH' && h.url === `/api/mcp/session/${id}`);
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };
const readState = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'));
function killDaemons(): void {
  for (const dir of ['heartbeats', 'journals']) {
    const d = path.join(os.homedir(), '.origin', dir);
    let entries: string[] = [];
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.pid') && !f.endsWith('.lock')) continue;
      try { const pid = Number(fs.readFileSync(path.join(d, f), 'utf-8').trim()); if (pid > 0) process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      try { fs.unlinkSync(path.join(d, f)); } catch { /* ignore */ }
    }
  }
}

describe.skipIf(!haveDist)('cursor: a Stop after the idle end lands on the chat\'s own session, not a leftover mirror (built binary)', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-cursor-idle-stop-')));
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(path.join(originDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['cursor'], orgId: 'org-e2e' }));
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      console.log('--- hooks.log ---\n' + hooksLog().split('\n').filter((l) => /stop\]|findStateForHook|user-prompt-submit\]/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l)).map((l) => l.slice(0, 400)).join('\n'));
      console.log('--- hits ---\n' + hits.map((h) => `${h.method} ${h.url} ${JSON.stringify(h.body).slice(0, 160)}`).join('\n'));
    }
    killDaemons();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('resumes the exact-chat ENDED archive from the worktree and ignores the other chat\'s RUNNING mirror', async () => {
    const CHAT = 'da82f522-e2e0-4444-8888-cccc0000dddd';
    const COMPOSER = 'f9213cfd-e2e0-4444-8888-cccc0000eeee';
    const main = path.join(tmp, 'repo');
    initRepo(main);
    const wt = path.join(tmp, 'repo-wt');
    git(main, ['worktree', 'add', '-q', '-b', 'cursor/e2e', wt]);
    const transcript = transcriptFor(CHAT);

    // Turn 1 in the worktree: the chat's session exists and has a turn.
    say(transcript, 'first prompt');
    const ups = await run('user-prompt-submit', { cwd: wt, roots: [wt], conversation: CHAT, transcript, payload: { prompt: 'first prompt' } });
    expect(ups.code, ups.stderr).toBe(0);
    const stop1 = await run('stop', { cwd: wt, roots: [wt], conversation: CHAT, transcript, payload: { status: 'completed' } });
    expect(stop1.code, stop1.stderr).toBe(0);
    expect(startHits().length).toBe(1);
    const sessionId = 'e2e-idle-stop-0001';
    const stateFile = path.join(main, '.git', `origin-session-${CHAT.slice(0, 12)}.json`);
    expect(readState(stateFile).sessionId).toBe(sessionId);
    killDaemons();

    // The heartbeat's idle end: state ENDED in the repo file and in the mirror.
    const ended = readState(stateFile);
    ended.status = 'ENDED'; ended.endedAt = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(ended, null, 2));
    const mirrorDir = path.join(os.homedir(), '.origin', 'sessions');
    fs.writeFileSync(path.join(mirrorDir, `${sessionId.slice(0, 12)}.json`), JSON.stringify(ended));

    // The landmine: another chat's RUNNING mirror on the primary checkout —
    // the archived twin whose daemon was killed before it could clean up.
    fs.writeFileSync(path.join(mirrorDir, 'twin-5431ff0f.json'), JSON.stringify({
      sessionId: 'twin-5431ff0f', sessionTag: COMPOSER.slice(0, 12), claudeSessionId: '', agentSessionId: COMPOSER,
      model: 'cursor-e2e-model', agentSlug: 'cursor', repoPath: main, canonicalRepoPath: main, lastCwd: main, branch: 'main',
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(), prompts: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], status: 'RUNNING',
    }));

    // The agent keeps working in the same chat; its next Stop arrives with no
    // prompt hook in between (the turn had started before the reap).
    say(transcript, 'second prompt');
    const patchesBefore = patchesTo(sessionId).length;
    const stop2 = await run('stop', { cwd: wt, roots: [wt], conversation: CHAT, transcript, payload: { status: 'completed' } });
    expect(stop2.code, stop2.stderr).toBe(0);

    expect(hooksLog()).toContain('mirror rows for another chat are not candidates');
    expect(hooksLog()).toContain("[stop] resuming ended session from archive (same chat)");
    expect(patchesTo('twin-5431ff0f').length, 'nothing may reach the other chat\'s row').toBe(0);
    expect(patchesTo(sessionId).length, 'the turn lands on the chat\'s own session').toBeGreaterThan(patchesBefore);
    expect(startHits().length, 'no twin minted').toBe(1);
    const revived = readState(stateFile);
    expect(revived.sessionId).toBe(sessionId);
    expect(revived.status).toBe('RUNNING');
    expect(revived.endedAt).toBeUndefined();
  }, 120_000 * WINDOWS_SLOWDOWN);
});
