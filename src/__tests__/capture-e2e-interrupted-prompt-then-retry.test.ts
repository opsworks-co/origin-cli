// END-TO-END: an interrupted prompt whose hook was killed, then a retry.
//
// Prod d027b430 (2026-09-27). At 14:59:01 the user sent "next task from the
// list" and interrupted it two seconds later; the interrupt killed its
// user-prompt-submit before it saved anything. At 14:59:30 they sent "next task
// from the list, 74c99e04 is done already", whose hook DID save it — as index
// 11, the slot the killed prompt should have had. The transcript held both, so
// it numbered the retry 12.
//
// From then on two index spaces disagreed. Stop sent the hook's row 11 (turnId,
// the retry's work) AND the transcript's row 12 (no turnId, the same work);
// `reconcilePromptHistory` matched the short prompt as a prefix of the long one
// and appended the long one again, so post-commit billed the next commit to a
// turnId-less index 12 as well. The release gate flagged turns 11/12 as
// identical_change_in_two_turns.
//
// The fix: the submit hook appends prompts the transcript holds that no hook
// recorded BEFORE the incoming one, so the retry takes the index the
// transcript gives it; and a prompt that merely starts with another one's
// words is not that prompt.
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

const SESSION_ID = 'e2e-interrupted-retry-4567';
const FIRST = 'add the first module';
const INTERRUPTED = 'next task from the list';
const RETRY = 'next task from the list, 74c99e04 is done already';

let server: http.Server;
let apiUrl = '';
let repo = '';
let transcript = '';
const lines: string[] = [];
const sentRows: Array<{ promptIndex: number; promptText?: string; turnId?: string; filesChanged?: string[] }> = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        try {
          const body = JSON.parse(raw || '{}');
          if (Array.isArray(body?.promptChanges)) sentRows.push(...body.promptChanges);
        } catch { /* not JSON */ }
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: 'e2e-interrupted-0001', verboseCapture: false }));
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
    cwd: repo,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({
    session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[], cwd = repo): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function append(entry: Record<string, unknown>) {
  lines.push(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
const say = (text: string) => append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
}
async function agentWrites(id: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

function state(): Record<string, any> {
  const dir = path.join(repo, '.git');
  const f = fs.readdirSync(dir).find((n) => n.startsWith('origin-session') && n.endsWith('.json'));
  if (!f) throw new Error('no session state file');
  return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function killJournalWatcher(): Promise<void> {
  let journal: string | undefined;
  try { journal = state().writeJournalPath; } catch { /* none */ }
  if (!journal) return;
  const lock = journal.replace(/\.jsonl$/, '.lock');
  try {
    const pid = Number(fs.readFileSync(lock, 'utf-8').trim());
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* no lock */ }
  try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ }
  await sleep(200);
}

describe.skipIf(!haveDist)('an interrupted prompt whose hook was killed, then a retry', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-interrupted-')));
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
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('gives the retry one index, the one the transcript gives it', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    // Turn 0: an ordinary turn. Claude runs the hook before it writes the
    // user entry, so the hook fires first.
    expect((await run('user-prompt-submit', { prompt: FIRST })).code).toBe(0);
    say(FIRST);
    await agentWrites('tu-1', 'src/one.ts', 'export const one = 1;\n');
    expect((await run('stop', {})).code).toBe(0);

    // Turn 1: sent, interrupted two seconds in. Its hook was killed — which
    // leaves nothing on disk — and an interrupted turn fires no Stop.
    say(INTERRUPTED);
    say('[Request interrupted by user]');

    // Turn 2: the retry. Its hook runs, then the entry lands, then the work.
    expect((await run('user-prompt-submit', { prompt: RETRY })).code).toBe(0);
    const atSubmit = state();
    expect(atSubmit.prompts).toEqual([FIRST, INTERRUPTED, RETRY]);
    expect(atSubmit.promptTurnIds?.[2], 'the retry owns the turn id at ITS index').toBeTruthy();
    expect(atSubmit.activeTurn ?? null).toBeNull();
    say(RETRY);
    await agentWrites('tu-2', 'src/two.ts', 'export const two = 2;\n');
    git(['add', 'src/two.ts']);
    git(['commit', '-q', '-m', 'add two']);
    expect((await run('stop', {})).code).toBe(0);
    await sleep(500);

    const s = state();
    expect(s.prompts, 'the retry is in the list once').toEqual([FIRST, INTERRUPTED, RETRY]);

    const withRetryText = sentRows.filter((r) => r.promptText === RETRY);
    expect(withRetryText.length, 'the retry reached the API').toBeGreaterThan(0);
    expect(
      [...new Set(withRetryText.map((r) => r.promptIndex))],
      'every row carrying the retry text is the same row',
    ).toEqual([2]);
    // The retry's work never lands on the interrupted prompt's row.
    const onInterrupted = sentRows.filter((r) => r.promptIndex === 1);
    expect(onInterrupted.flatMap((r) => r.filesChanged || [])).not.toContain('src/two.ts');
  }, 120_000 * WINDOWS_SLOWDOWN);
});
