// END-TO-END (OR-45 checkpoints 3C/3C.1): a GitHub Copilot CLI turn's proven
// lines reach the commit's note, through the BUILT binary and the real hooks.
//
// Copilot fires no tool-level hook. post-commit therefore reads the running
// prompt's events.jsonl (G2): a successful edit of a path the commit changed
// attests the commit to that turn. There is no live ledger, so the post-commit
// note is commit-level; agentStop reads the log with the Copilot extractor and
// upgrades it with exactly the lines of the edit whose tool.execution_complete
// said `success: true` (G1). A rejected call claims nothing, even when a human
// then made that very change and committed it with the rest. A commit the log
// does not prove — an edit of a same-named file elsewhere — stays commit-level,
// and SessionEnd keeps the line note it found.
//
// Requires `dist/` (CI builds before it tests).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
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
          res.end(JSON.stringify({ sessionId: 'e2e-copilot-line-session', verboseCapture: false }));
        } else if (u.startsWith('/api/pricing')) {
          res.end(JSON.stringify({ models: {} }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    holdIdleConnections(server);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      apiUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

let repo = '';
let events = '';
// First 12 characters name the state file, so they differ from every other capture-e2e session.
const SESSION_ID = 'cpline-e2e-5b7e-4c1d-9a2f-3e8d6c0b1a2f';

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'copilot', event], {
    cwd: repo,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* not asserted */ });
  // Copilot's payload is camelCase; the hook normalizes it.
  child.stdin.end(JSON.stringify({ timestamp: Date.now(), cwd: repo, sessionId: SESSION_ID, transcriptPath: events, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const append = (e: Record<string, unknown>) => fs.appendFileSync(events, JSON.stringify(e) + '\n');
const hooksLog = () => {
  try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; }
};
// Copilot's user-prompt-submit re-runs itself DETACHED (spawnBackgroundHook):
// the hook returns at once and the capture — the turn's start-state among it —
// lands seconds later. The agent's work starts once that start-state exists.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function submitSettled(promptIndex: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const f = fs.readdirSync(path.join(repo, '.git')).find((n) => n.startsWith(`origin-session-${SESSION_ID.slice(0, 12)}`) && n.endsWith('.json'));
      const st = f ? JSON.parse(fs.readFileSync(path.join(repo, '.git', f), 'utf-8')) : null;
      if ((st?.promptShadows || []).some((sh: any) => sh?.promptIndex === promptIndex && sh?.shadowSha)) return;
    } catch { /* mid-write — retry */ }
    await sleep(100);
  }
  throw new Error(`the background prompt-submit of turn ${promptIndex} never recorded its start-state`);
}
const why = () => hooksLog().split('\n')
  .filter((l) => /\[(post-commit|stop|line-claims)\]/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
  .slice(-30).map((l) => l.slice(0, 300)).join('\n');

describe.skipIf(!haveDist)('a Copilot turn\'s proven lines reach the note, end to end through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-cpline-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    events = path.join(tmp, 'session-state', SESSION_ID, 'events.jsonl');
    fs.mkdirSync(path.dirname(events), { recursive: true });
    fs.writeFileSync(events, JSON.stringify({ type: 'session.start', data: { sessionId: SESSION_ID } }) + '\n');

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['copilot'], orgId: 'org-e2e',
    }));

    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const postCommit = (): Promise<{ code: number | null; stderr: string }> => new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'hooks', 'git-post-commit'], { cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  const recordedLine = (sha: string) => hooksLog().split('\n').find((l) => l.includes('recorded commit on session') && l.includes(sha.slice(0, 8)));
  const record = (sha: string) => JSON.parse(git(['notes', '--ref=origin', 'show', sha])).attribution_record;

  it('post-commit attests the Copilot turn from its events log; agentStop writes only the successful edit\'s lines', async () => {
    const start = await run('session-start', { source: 'new', initialPrompt: 'make it say hello' });
    expect(start.code, start.stderr).toBe(0);

    // ── Turn 1: a proven edit, a rejected create, one commit.
    const prompt1 = 'make it say hello';
    append({ type: 'user.message', data: { content: prompt1 } });
    const ups1 = await run('user-prompt-submit', { prompt: prompt1 });
    expect(ups1.code, ups1.stderr).toBe(0);
    await submitSettled(0);
    const app = path.join(repo, 'app.py');
    append({ type: 'tool.execution_start', data: { toolCallId: 'call_ok', toolName: 'edit', arguments: { path: app, old_str: 'print("old")', new_str: 'print("hello")' } } });
    fs.writeFileSync(app, fs.readFileSync(app, 'utf-8').replace('print("old")', 'print("hello")'));
    append({ type: 'tool.execution_complete', data: { toolCallId: 'call_ok', success: true } });
    append({ type: 'tool.execution_start', data: { toolCallId: 'call_bad', toolName: 'create', arguments: { path: path.join(repo, 'human.txt'), file_text: 'typed by hand\n' } } });
    append({ type: 'tool.execution_complete', data: { toolCallId: 'call_bad', success: false, error: { message: 'Permission denied' } } });
    // The human writes that file themselves and commits everything.
    fs.writeFileSync(path.join(repo, 'human.txt'), 'typed by hand\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'say hello']);
    const first = git(['rev-parse', 'HEAD']);
    const pc1 = await postCommit();
    expect(pc1.code, pc1.stderr).toBe(0);
    expect(recordedLine(first), `post-commit recorded the commit on no session\n${why()}`).toBeTruthy();
    // G2: the events log proves the running turn made it.
    expect(recordedLine(first), `post-commit attested no Copilot turn\n${why()}`).not.toContain('(no active turn)');
    // No tool hook, no live ledger: nothing to project yet.
    expect(record(first).attribution_level, `post-commit note\n${why()}`).toBe('commit');

    append({ type: 'assistant.message', data: { content: 'It says hello now.' } });
    const stop1 = await run('stop', { stopReason: 'end_turn' });
    expect(stop1.code, stop1.stderr).toBe(0);
    const line = [{ path: 'app.py', ranges: [{ start_line: 2, end_line: 2, iteration_index: 0 }] }];
    expect(record(first).attribution_level, `after agentStop\n${why()}`).toBe('line');
    expect(record(first).contributions[0].agent).toEqual({ id: 'copilot' });
    expect(record(first).contributions[0].files).toEqual(line);

    // ── Turn 2: Copilot creates lib/app.py; the human edits the root app.py
    // and commits only that. Same basename, different file: no proof.
    const prompt2 = 'add a library module';
    append({ type: 'user.message', data: { content: prompt2 } });
    const ups2 = await run('user-prompt-submit', { prompt: prompt2 });
    expect(ups2.code, ups2.stderr).toBe(0);
    await submitSettled(1);
    fs.mkdirSync(path.join(repo, 'lib'));
    append({ type: 'tool.execution_start', data: { toolCallId: 'call_lib', toolName: 'create', arguments: { path: path.join(repo, 'lib', 'app.py'), file_text: 'VALUE = 1\n' } } });
    fs.writeFileSync(path.join(repo, 'lib', 'app.py'), 'VALUE = 1\n');
    append({ type: 'tool.execution_complete', data: { toolCallId: 'call_lib', success: true } });
    fs.writeFileSync(app, fs.readFileSync(app, 'utf-8').replace('main()\n', 'main()  # by hand\n'));
    git(['add', 'app.py']);
    git(['commit', '-q', '-m', 'by hand']);
    const second = git(['rev-parse', 'HEAD']);
    const pc2 = await postCommit();
    expect(pc2.code, pc2.stderr).toBe(0);
    expect(recordedLine(second), `post-commit recorded the second commit on no session\n${why()}`).toBeTruthy();
    expect(recordedLine(second)).toContain('(no active turn)');
    append({ type: 'assistant.message', data: { content: 'Added lib/app.py.' } });
    const stop2 = await run('stop', { stopReason: 'end_turn' });
    expect(stop2.code, stop2.stderr).toBe(0);
    expect(record(second).attribution_level, `second commit after agentStop\n${why()}`).toBe('commit');
    expect(record(second).contributions[0]).not.toHaveProperty('files');

    // ── SessionEnd keeps the first commit's line note.
    const end = await run('session-end', { reason: 'complete' });
    expect(end.code, end.stderr).toBe(0);
    expect(record(first).attribution_level, `after SessionEnd\n${why()}`).toBe('line');
    expect(record(first).contributions[0].files).toEqual(line);
    expect(record(second).attribution_level).toBe('commit');
  }, 180_000 * WINDOWS_SLOWDOWN);
});
