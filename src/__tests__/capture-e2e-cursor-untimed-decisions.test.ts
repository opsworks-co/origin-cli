// END-TO-END, Cursor hooks: the BUILT binary, Cursor's hook events, git hooks
// installed, a real repo, a fake API.
//
// Cursor's transcript records no times, so a turn's decision could only reach
// a commit made in the turn still running, from its tool calls (TODO
// f2d0717c). Turn 1 here writes retry.ts through the shell and states a
// decision; turn 2, "commit it", commits it. The hook's own record of when each
// prompt was sent gives the transcript its times, and turn 1's captured diff
// shows its work is the commit — so the commit's memory record carries turn
// 1's decision.
//
// Requires `dist/`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { gitAsync } from './helpers/git-async.js';
import { readAllCommitMemory } from '../memory.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = process.env.ORIGIN_E2E_BIN || path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

let server: http.Server;
let apiUrl = '';
function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: 'e2e-cursor-untimed-0001', verboseCapture: false }));
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

const DECISION = 'Retry with exponential backoff capped at 30s — the API rate-limits bursts';
const retry = [
  'export async function withRetry(fn, attempts = 5) {',
  '  for (let attempt = 0; attempt < attempts; attempt++) {',
  '    try { return await fn(); } catch (err) { lastError = err; }',
  '    await sleepFor(Math.min(30_000, 2 ** attempt * 250));',
  '  }',
  '  throw lastError;',
  '}',
].join('\n') + '\n';

const CONV = 'c0ffee00-e2e0-untm-3333-444455556666';
let repo = '';
let hooksDir = '';
let transcript = '';
let turn = 0;
const lines: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'cursor', event], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* not asserted */ });
  child.stdin.end(JSON.stringify({
    conversation_id: CONV, generation_id: `gen-${turn}`, model: 'cursor-e2e-model',
    session_id: `e2e-cursor-untimed-turn-${turn}`, hook_event_name: event, cursor_version: '2.6.0',
    workspace_roots: [repo], cwd: repo, transcript_path: transcript, ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

// Cursor's transcript: no timestamps anywhere.
function push(o: unknown) {
  lines.push(JSON.stringify(o));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
const say = (text: string) => push({ role: 'user', content: text });
const said = (text: string) => push({ type: 'assistant', role: 'assistant', message: { content: [{ type: 'text', text }] } });
const ranShell = (command: string) => push({ type: 'assistant', role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command } }] } });

async function prompt(text: string) {
  turn++;
  expect((await run('user-prompt-submit', { prompt: text })).code).toBe(0);
  say(text);
}

describe.skipIf(!haveDist)('cursor: a shell-only turn\'s decision rides on the commit a later turn made', () => {
  let tmp = '';
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-cursor-untimed-')));
    repo = path.join(tmp, 'repo');
    hooksDir = path.join(tmp, 'hooks');
    fs.mkdirSync(repo);
    fs.mkdirSync(hooksDir);
    const tdir = path.join(tmp, 'agent-transcripts', CONV);
    fs.mkdirSync(tdir, { recursive: true });
    transcript = path.join(tdir, `${CONV}.jsonl`);
    fs.writeFileSync(transcript, '');
    for (const [name, args] of [
      ['prepare-commit-msg', 'git-prepare-commit-msg "$1" "$2" "$3"'],
      ['post-commit', 'git-post-commit'],
      ['post-rewrite', 'git-post-rewrite "$@"'],
    ] as const) {
      fs.writeFileSync(path.join(hooksDir, name), `#!/bin/sh\n"${process.execPath}" "${BIN}" hooks ${args} >/dev/null 2>&1 || true\n`, { mode: 0o755 });
    }
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer', memoryUpdate: 'both',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['cursor'], orgId: 'org-e2e',
    }));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'E2E');
    git('config', 'user.email', 'e2e@example.com');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), 'uploader\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
  }, 60_000);

  afterAll(async () => {
    try {
      const dir = path.join(os.homedir(), '.origin', 'journals');
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))) {
        const pid = Number(fs.readFileSync(path.join(dir, f), 'utf-8').trim());
        if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      }
    } catch { /* no journal */ }
    server?.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the commit record carries the shell turn\'s decision', async () => {
    expect((await run('session-start', {})).code).toBe(0);

    // Turn 1: a shell write and a decision.
    await prompt('add retry with backoff to the uploader');
    await sleep(500);
    ranShell(`cat > ${path.join(repo, 'retry.ts')} <<'EOF'\n${retry}EOF`);
    fs.writeFileSync(path.join(repo, 'retry.ts'), retry);
    await sleep(1500); // the journal watcher sees the write
    said(`Added retry.ts.\n[Origin: Decision] ${DECISION}`);
    expect((await run('stop', { status: 'completed' })).code).toBe(0);
    await sleep(500);

    // Turn 2: "commit it".
    await prompt('looks good, commit it');
    ranShell('git add retry.ts && git commit -m "add retry with backoff"');
    git('add', 'retry.ts');
    await gitAsync(repo, ['-c', `core.hooksPath=${hooksDir}`, 'commit', '-q', '-m', 'add retry with backoff']);
    const sha = git('rev-parse', 'HEAD');
    said('Committed.');
    expect((await run('stop', { status: 'completed' })).code).toBe(0);
    await sleep(500);

    const record = readAllCommitMemory(repo).find((c) => c.commitSha === sha);
    if (process.env.E2E_DUMP || !record?.decisions?.length) {
      try {
        console.log(fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8').split('\n')
          .filter((l) => /post-commit|memory|decision|shell window|stop\]/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
          .map((l) => l.slice(0, 400)).slice(-40).join('\n'));
      } catch { /* none */ }
    }
    expect(record, 'post-commit wrote no record for the commit').toBeDefined();
    expect(record!.decisions).toEqual([DECISION]);
  }, 300_000);
});
