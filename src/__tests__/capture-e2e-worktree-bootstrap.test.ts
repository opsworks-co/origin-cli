// END-TO-END: the BUILT binary, a main-checkout handshake adopted into a
// linked worktree whose branch is already ahead of main.
//
// This is how Claude Code's desktop app starts a worktree session: the first
// SessionStart fires on the primary checkout, the harness creates the
// worktree, and a second SessionStart fires there with a new conversation
// id. Origin adopts the empty handshake rather than minting a twin. Session
// e1095412 (2026-09-08) showed the adoption kept MAIN's baseline: the
// worktree was fourteen commits ahead, and the session's first Stop stored a
// header of +6431/-2115 across eight commits it had not made.
//
// Same shape as capture-e2e-real-binary.test.ts: real hooks, real git, a
// fake API. Requires `dist/`. POSIX-only.
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
          res.end(JSON.stringify({ sessionId: 'e2e-session-wt-0001', verboseCapture: false }));
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
let main = '';
let wt = '';
let transcript = '';
const MAIN_SESSION = 'e2e-claude-main-handshake-0001';
const WT_SESSION = 'e2e-claude-worktree-conv-0002';

function run(cwd: string, sessionId: string, event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd, hook_event_name: event, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
function gitHook(cwd: string, name: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };

const lines: string[] = [];
function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
async function agentWrites(id: string, file: string, content: string) {
  const abs = path.join(wt, file);
  const input = { file_path: abs, content };
  await run(wt, WT_SESSION, 'pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run(wt, WT_SESSION, 'post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function killJournalWatchers(): Promise<void> {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    let killed = false;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))) {
      try {
        const pid = Number(fs.readFileSync(path.join(dir, f), 'utf-8').trim());
        if (pid > 0) { process.kill(pid, 'SIGTERM'); killed = true; }
      } catch { /* no lock yet */ }
    }
    if (killed) return;
    await sleep(250);
  }
}
const stopPayloads = () => hits
  .filter((h) => h.method === 'PATCH' && /^\/api\/mcp\/session\/e2e-session-wt-0001/.test(h.url))
  .map((h) => h.body).filter((b) => b && Array.isArray(b.promptChanges));

describe.skipIf(!haveDist)('a main handshake adopted into a worktree that is ahead of main', () => {
  let wtHead = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-wt-')));
    main = path.join(tmp, 'repo');
    fs.mkdirSync(main);
    transcript = path.join(tmp, `${WT_SESSION}.jsonl`);
    fs.writeFileSync(transcript, '');
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e-wt', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
    }));

    git(main, ['init', '-q']);
    git(main, ['config', 'user.name', 'E2E']);
    git(main, ['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(main, '.gitignore'), '.claude/\n.probe\n');
    fs.writeFileSync(path.join(main, 'README.md'), '# demo\n');
    git(main, ['add', '.']);
    git(main, ['commit', '-q', '-m', 'base']);
    // The worktree branch already carries a 40-line commit main does not.
    wt = path.join(main, '.claude', 'worktrees', 'wt');
    git(main, ['worktree', 'add', '-q', '-b', 'feature', wt, 'main']);
    fs.writeFileSync(path.join(wt, 'ahead.py'), Array.from({ length: 40 }, (_, i) => `AHEAD_${i} = ${i}`).join('\n') + '\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', 'work already on the branch']);
    wtHead = git(wt, ['rev-parse', 'HEAD']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatchers();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('adopts the handshake and starts from the worktree HEAD', async () => {
    const first = await run(main, MAIN_SESSION, 'session-start', { source: 'startup' });
    expect(first.code, first.stderr).toBe(0);
    const second = await run(wt, WT_SESSION, 'session-start', { source: 'startup' });
    expect(second.code, second.stderr).toBe(0);

    // One session at the API, not a twin.
    expect(hits.filter((h) => h.method === 'POST' && h.url.startsWith('/api/mcp/session/start'))).toHaveLength(1);
    const adopted = hooksLog().split('\n').find((l) => l.includes('adopting empty worktree-bootstrap session'));
    expect(adopted, 'the worktree start did not adopt the main handshake').toBeTruthy();
    expect(adopted).toContain(`"headShaAtStart":"${wtHead.slice(0, 12)}"`);
  }, 60_000 * WINDOWS_SLOWDOWN);

  it('turn 1: a Stop before any commit claims the one uncommitted line, not the branch', async () => {
    // e1095412's shape exactly: no commit recorded yet, so the session-level
    // snapshot falls back to the trailer walk over headShaAtStart..HEAD. With
    // main's baseline that range IS the branch, and its 40-line commit —
    // local committer, no trailer — passes the ownership predicate.
    say('add a note');
    const ups = await run(wt, WT_SESSION, 'user-prompt-submit', { prompt: 'add a note' });
    expect(ups.code, ups.stderr).toBe(0);
    await agentWrites('tu-1', 'notes.md', 'remember this\n');
    await sleep(500);
    const stop = await run(wt, WT_SESSION, 'stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    const payloads = stopPayloads();
    expect(payloads.length, 'Stop sent no per-turn rows').toBeGreaterThan(0);
    const t1 = payloads[payloads.length - 1].promptChanges.find((r: any) => r.promptIndex === 0);
    expect(t1, 'no row for turn 1').toBeTruthy();
    expect(t1.filesChanged).toEqual(['notes.md']);
    expect([t1.linesAdded, t1.linesRemoved]).toEqual([1, 0]);

    const headers = hits.filter((h) => h.method === 'PATCH' && h.body?.gitCapture).map((h) => h.body.gitCapture);
    expect(headers.length, 'Stop sent no session-level capture').toBeGreaterThan(0);
    const header = headers[headers.length - 1];
    expect(header.diff || '').not.toContain('AHEAD_');
    expect(header.commitShas || []).not.toContain(wtHead);
    expect(header.linesAdded).toBe(1);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('turn 2: commits, and the turn and the header carry that commit only', async () => {
    say('now commit it');
    const ups = await run(wt, WT_SESSION, 'user-prompt-submit', { prompt: 'now commit it' });
    expect(ups.code, ups.stderr).toBe(0);
    const cmd = 'git add -A && git commit -q -m "add a note"';
    await run(wt, WT_SESSION, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'tu-2' });
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', 'add a note']);
    const sha = git(wt, ['rev-parse', 'HEAD']);
    const pc = await gitHook(wt, 'git-post-commit');
    expect(pc.code, pc.stderr).toBe(0);
    toolUse('tu-2', 'Bash', { command: cmd });
    await run(wt, WT_SESSION, 'post-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'tu-2', tool_response: { stdout: '', stderr: '' } });

    const stop = await run(wt, WT_SESSION, 'stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    // The committing turn carries the commit; turn 1 keeps its write.
    const payloads = stopPayloads();
    const rows = payloads[payloads.length - 1].promptChanges;
    const t1 = rows.find((r: any) => r.promptIndex === 0);
    expect(t1.filesChanged).toEqual(['notes.md']);
    const t2 = rows.find((r: any) => r.promptIndex === 1);
    expect(t2, 'no row for turn 2').toBeTruthy();
    if (t2.commitSha) expect(t2.commitSha).toBe(sha);
    expect(t2.filesChanged || []).not.toContain('ahead.py');

    // The header: the same one line. Never the 40 lines the branch was
    // already ahead by — that commit was made before this session existed.
    const captures = hits
      .filter((h) => h.method === 'PATCH' && h.body?.gitCapture)
      .map((h) => h.body.gitCapture);
    // post-commit's fast PATCH is a COMMIT CARRIER — commitDetails only, no
    // diff field and no line totals (the server leaves the session diff
    // alone for it). It must still not carry the pre-session commit.
    for (const carrier of captures.filter((c) => typeof c.diff !== 'string')) {
      expect(carrier.commitShas || []).not.toContain(wtHead);
      expect(carrier.linesAdded).toBeUndefined();
      for (const d of carrier.commitDetails || []) expect(d.patch || '').not.toContain('AHEAD_');
    }
    const headers = captures.filter((c) => typeof c.diff === 'string');
    expect(headers.length, 'nothing sent a session-level capture').toBeGreaterThan(0);
    for (const header of headers) {
      expect(header.diff || '').not.toContain('AHEAD_');
      expect(header.commitShas || []).not.toContain(wtHead);
      expect(header.linesAdded).toBeLessThanOrEqual(1);
    }
    const last = headers[headers.length - 1];
    expect(last.commitShas).toEqual([sha]);
    expect(last.diff).toContain('+remember this');
  }, 120_000 * WINDOWS_SLOWDOWN);
});
