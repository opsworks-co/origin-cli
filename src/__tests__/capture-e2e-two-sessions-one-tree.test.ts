// END-TO-END: the BUILT binary, two live Claude sessions on ONE working tree.
// The idle one sits at the tree root; the working one has cd-ed into a
// subdirectory, writes a file there, and commits. The commit must be the
// working session's — trailer, Commit row and turn. Session e1095412
// (2026-09-08) lost both of its commits to the idle sibling because the
// candidate narrowing kept the exact-lastCwd match alone.
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

const IDLE_API = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const WORK_API = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const IDLE_CONV = 'e2e-claude-idle-conv-0001';
const WORK_CONV = 'e2e-claude-work-conv-0002';

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';
let starts = 0;
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
          starts++;
          res.end(JSON.stringify({ sessionId: starts === 1 ? IDLE_API : WORK_API, verboseCapture: false }));
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
let repo = '';
let sub = '';
const transcripts: Record<string, string> = {};
const lines: Record<string, string[]> = { [IDLE_CONV]: [], [WORK_CONV]: [] };

function run(cwd: string, conv: string, event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({ session_id: conv, transcript_path: transcripts[conv], cwd, hook_event_name: event, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
function gitHook(cwd: string, name: string, args: string[] = []): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name, ...args], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };
function say(conv: string, text: string) {
  lines[conv].push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
function toolUse(conv: string, id: string, name: string, input: Record<string, unknown>) {
  lines[conv].push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines[conv].push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function killJournalWatchers(): Promise<void> {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    let killed = false;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))) {
      try { const pid = Number(fs.readFileSync(path.join(dir, f), 'utf-8').trim()); if (pid > 0) { process.kill(pid, 'SIGTERM'); killed = true; } } catch { /* none */ }
    }
    if (killed) return;
    await sleep(250);
  }
}

describe.skipIf(!haveDist)('two live sessions on one tree: the commit goes to the one that made it', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-two-')));
    repo = path.join(tmp, 'repo');
    sub = path.join(repo, 'packages', 'cli');
    fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
    for (const c of [IDLE_CONV, WORK_CONV]) { transcripts[c] = path.join(tmp, `${c}.jsonl`); fs.writeFileSync(transcripts[c], ''); }
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e-two', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e' }));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.name', 'E2E']);
    git(repo, ['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    fs.writeFileSync(path.join(sub, 'src', 'a.ts'), 'export const a = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatchers();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the idle session at the root and the working session in packages/cli both register', async () => {
    const a = await run(repo, IDLE_CONV, 'session-start', { source: 'startup' });
    expect(a.code, a.stderr).toBe(0);
    // The idle chat asked one thing earlier and is now parked at the root.
    say(IDLE_CONV, 'what does this repo do?');
    await run(repo, IDLE_CONV, 'user-prompt-submit', { prompt: 'what does this repo do?' });
    await run(repo, IDLE_CONV, 'stop', { stop_hook_active: false });

    const b = await run(sub, WORK_CONV, 'session-start', { source: 'startup' });
    expect(b.code, b.stderr).toBe(0);
    expect(starts).toBe(2);
  }, 60_000 * WINDOWS_SLOWDOWN);

  it('the working session, mid-turn from a subdirectory, keeps its commit', async () => {
    say(WORK_CONV, 'fix a.ts and commit');
    const ups = await run(sub, WORK_CONV, 'user-prompt-submit', { prompt: 'fix a.ts and commit' });
    expect(ups.code, ups.stderr).toBe(0);
    const abs = path.join(sub, 'src', 'a.ts');
    const input = { file_path: abs, content: 'export const a = 2;\n' };
    await run(sub, WORK_CONV, 'pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: 'w-1' });
    fs.writeFileSync(abs, input.content);
    toolUse(WORK_CONV, 'w-1', 'Write', input);
    await run(sub, WORK_CONV, 'post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: 'w-1', tool_response: { filePath: abs, success: true } });
    await sleep(500);

    const cmd = 'cd .. && git add -A && git commit -q -m "fix a"';
    await run(sub, WORK_CONV, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'w-2' });
    git(repo, ['add', '-A']);
    // Git runs prepare-commit-msg from the tree root with COMMIT_EDITMSG.
    const msgFile = path.join(repo, '.git', 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, 'fix a\n');
    const pcm = await gitHook(repo, 'git-prepare-commit-msg', [msgFile]);
    expect(pcm.code, pcm.stderr).toBe(0);
    const trailered = fs.readFileSync(msgFile, 'utf-8');
    expect(trailered, 'no Origin-Session trailer was written').toMatch(/Origin-Session:/);
    expect(trailered).toContain(WORK_API.slice(0, 12));
    expect(trailered).not.toContain(IDLE_API.slice(0, 12));
    git(repo, ['commit', '-q', '-F', msgFile]);
    const sha = git(repo, ['rev-parse', 'HEAD']);
    const pc = await gitHook(repo, 'git-post-commit');
    expect(pc.code, pc.stderr).toBe(0);
    toolUse(WORK_CONV, 'w-2', 'Bash', { command: cmd });
    await run(sub, WORK_CONV, 'post-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'w-2', tool_response: { stdout: '', stderr: '' } });

    // post-commit recorded it on the working session, not the idle one.
    const recorded = hooksLog().split('\n').find((l) => l.includes('recorded commit on session') && l.includes(sha.slice(0, 8)));
    expect(recorded, 'post-commit recorded the commit on no session').toBeTruthy();
    expect(recorded).toContain(WORK_API);
    const attested = hits
      .filter((h) => h.method === 'PATCH' && h.url.includes(WORK_API) && Array.isArray(h.body?.promptChanges))
      .flatMap((h) => h.body.promptChanges)
      .find((r: any) => r.commitSha === sha);
    expect(attested, 'the commit was not attested to the working session\'s turn').toBeTruthy();
    expect(attested.filesChanged).toEqual(['packages/cli/src/a.ts']);
    const onIdle = hits
      .filter((h) => h.method === 'PATCH' && h.url.includes(IDLE_API) && Array.isArray(h.body?.promptChanges))
      .flatMap((h) => h.body.promptChanges)
      .find((r: any) => r.commitSha === sha);
    expect(onIdle, 'the idle session was credited with the commit').toBeUndefined();

    const stop = await run(sub, WORK_CONV, 'stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);
    const rows = hits
      .filter((h) => h.method === 'PATCH' && h.url.includes(WORK_API) && Array.isArray(h.body?.promptChanges))
      .map((h) => h.body.promptChanges).pop();
    const t0 = rows.find((r: any) => r.promptIndex === 0);
    expect(t0.filesChanged).toEqual(['packages/cli/src/a.ts']);
    if (t0.commitSha) expect(t0.commitSha).toBe(sha);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
