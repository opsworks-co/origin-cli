// END-TO-END, Antigravity: the BUILT binary, agy's real hook sequence, a real
// repo, a fake API.
//
// The Claude Code harness proved the assembly for one agent. Antigravity has
// its own event set (PreToolUse / PostToolUse / Stop, no prompt-submit), its
// own payload shape, its own handler that short-circuits ahead of the shared
// dispatcher — and until now no journal at all, because the journal was only
// ever started from user-prompt-submit. This spawns `dist/index.js hooks
// antigravity <event>` exactly as agy does and asserts the Stop row is the
// ledger's: files, diff and counts from one observed text.
//
// Requires `dist/`. POSIX-only, like the Claude Code harness.
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
          res.end(JSON.stringify({ sessionId: 'e2e-agy-session-0001', enforcementRules: [] }));
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
const CID = 'e2e0agy0-1111-2222-3333-444455556666';
const TAG = `agy-${CID.slice(0, 12)}`;

function run(event: string, payload: Record<string, unknown>): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'antigravity', event], {
    cwd: repo,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', (c) => { stdout += c; });
  child.stdin.end(JSON.stringify({ conversationId: CID, workspacePaths: [repo], cwd: repo, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr, stdout })));
}

const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}

// agy's transcript: USER_INPUT and TOOL_CALL steps.
const steps: any[] = [];
let stepClock = Date.now() - 60_000;
function userSays(text: string) {
  steps.push({ step_index: steps.length, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
    created_at: new Date(stepClock += 1000).toISOString(), content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
  fs.writeFileSync(transcript, steps.map((s) => JSON.stringify(s)).join('\n'));
}
function toolWrote(file: string) {
  steps.push({ step_index: steps.length, source: 'MODEL', type: 'TOOL_CALL', status: 'DONE',
    created_at: new Date(stepClock += 1000).toISOString(), content: 'working',
    tool_calls: [{ name: 'write_file', args: { file_path: path.join(repo, file) } }] });
  fs.writeFileSync(transcript, steps.map((s) => JSON.stringify(s)).join('\n'));
}

function journalPath(): string {
  return path.join(os.homedir(), '.origin', 'journals', `${TAG}.jsonl`);
}
function writesIn(): number {
  try { return fs.readFileSync(journalPath(), 'utf-8').split('\n').filter((l) => l.startsWith('{"f"')).length; } catch { return 0; }
}
function rowsSent(): any[] {
  return hits.filter((h) => h.method === 'PATCH' && Array.isArray(h.body?.promptChanges)).map((h) => h.body.promptChanges);
}

async function killJournalWatcher(): Promise<void> {
  const lock = path.join(os.homedir(), '.origin', 'journals', `${TAG}.lock`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(lock, 'utf-8').trim());
      if (pid > 0) { process.kill(pid, 'SIGTERM'); return; }
    } catch { /* not yet */ }
    await sleep(250);
  }
}

describe.skipIf(!haveDist || !posix)('antigravity capture end to end through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-agy-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    transcript = path.join(tmp, 'agy-transcript.jsonl');
    fs.writeFileSync(transcript, '');

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['antigravity'], orgId: 'org-e2e',
    }));
    // agy's own transcript watcher is a separate detached process; a fresh
    // lock keeps it out so the JOURNAL watcher is the only spawn under test.
    const agyLock = path.join(originDir, 'agy-watch', `${CID}.lock`);
    fs.mkdirSync(path.dirname(agyLock), { recursive: true });
    fs.writeFileSync(agyLock, String(Date.now()));

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

  it('turn 1: the write journal opens at pre-tool-use and the Stop row is the ledger\'s', async () => {
    const abs = path.join(repo, 'app.py');
    const pre = await run('pre-tool-use', { toolCall: { name: 'write_file', args: { file_path: abs } } });
    expect(pre.code, pre.stderr).toBe(0);
    // agy reads its decision from stdout — nothing else may be printed there.
    expect(JSON.parse(pre.stdout.trim().split('\n').pop() || '{}').decision).toBe('allow');

    // The detached journal watcher must be alive and recording, with the turn
    // already marked — BEFORE the tool's write lands.
    await waitFor(() => fs.existsSync(journalPath()), 10_000, 'the agy session journal to exist');
    expect(fs.readFileSync(journalPath(), 'utf-8')).toMatch(/"id":"t_/);
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 400 && writesIn() === 0; i++) { fs.writeFileSync(probe, String(i)); await sleep(25); }
    expect(writesIn(), 'the detached journal watcher recorded nothing').toBeGreaterThan(0);
    const before = writesIn();
    await sleep(400);

    fs.writeFileSync(abs, 'def main():\n    print("new")\n\n\nmain()\n');
    await waitFor(() => writesIn() > before, 10_000, 'the journal to record the write');
    userSays('change the greeting');
    toolWrote('app.py');
    const post = await run('post-tool-use', { transcriptPath: transcript, toolCall: { name: 'write_file', args: { file_path: abs } } });
    expect(post.code, post.stderr).toBe(0);

    const stop = await run('stop', { transcriptPath: transcript });
    expect(stop.code, stop.stderr).toBe(0);

    const sent = rowsSent();
    expect(sent.length, 'no per-turn rows reached the API').toBeGreaterThan(0);
    const t1 = sent[sent.length - 1].find((r: any) => r.promptIndex === 0);
    expect(t1, 'no row for turn 1').toBeTruthy();
    expect(t1.diffSource).toBe('ledger');
    expect(t1.turnId).toMatch(/^t_/);
    expect(t1.filesChanged).toEqual(['app.py']);
    expect(t1.diff).toContain('-    print("old")');
    expect(t1.diff).toContain('+    print("new")');
    expect(t1.diff).not.toContain('+def main():');
    expect(t1.linesAdded).toBe(1);
    expect(t1.linesRemoved).toBe(1);
    expect(parseUnifiedDiff(t1.diff).files[0].isNew).toBe(false);
    expect(verifyTurn({ promptIndex: 0, filesChanged: t1.filesChanged, diff: t1.diff, linesAdded: t1.linesAdded, linesRemoved: t1.linesRemoved })).toEqual([]);
  }, 120_000);

  it('turn 2: its own mark, its own write, nothing of turn 1', async () => {
    const abs = path.join(repo, 'notes.md');
    const pre = await run('pre-tool-use', { toolCall: { name: 'write_file', args: { file_path: abs } } });
    expect(pre.code, pre.stderr).toBe(0);
    const marks = () => (fs.readFileSync(journalPath(), 'utf-8').match(/"k":"t","t":[0-9]+,"id":"t_/g) || []).length;
    expect(marks()).toBe(2);
    const before = writesIn();
    fs.writeFileSync(abs, 'remember this\n');
    await waitFor(() => writesIn() > before, 10_000, 'the journal to record the write');
    userSays('leave a note');
    toolWrote('notes.md');
    await run('post-tool-use', { transcriptPath: transcript, toolCall: { name: 'write_file', args: { file_path: abs } } });
    const stop = await run('stop', { transcriptPath: transcript });
    expect(stop.code, stop.stderr).toBe(0);

    const sent = rowsSent();
    const rows = sent[sent.length - 1];
    const t2 = rows.find((r: any) => r.promptIndex === 1);
    expect(t2, 'no row for turn 2').toBeTruthy();
    expect(t2.diffSource).toBe('ledger');
    expect(t2.filesChanged).toEqual(['notes.md']);
    expect(t2.diff).toContain('+remember this');
    expect(t2.diff).not.toContain('print("new")');
    expect(t2.linesAdded).toBe(1);
    expect(t2.linesRemoved).toBe(0);
    expect(parseUnifiedDiff(t2.diff).files[0].isNew).toBe(true);
    const t1 = rows.find((r: any) => r.promptIndex === 0);
    expect(t1.turnId).not.toBe(t2.turnId);
    expect(verifyTurn({ promptIndex: 1, filesChanged: t2.filesChanged, diff: t2.diff, linesAdded: t2.linesAdded, linesRemoved: t2.linesRemoved })).toEqual([]);
  }, 120_000);
});
