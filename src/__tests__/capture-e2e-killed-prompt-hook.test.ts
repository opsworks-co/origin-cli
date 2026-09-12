// END-TO-END: a prompt whose own hook never finished still gets a baseline.
//
// user-prompt-submit pre-persists the prompt to the API queue and THEN does its
// git work — captureGitState, a shadow commit. The harness kills the hook when
// the next prompt overlaps that work, which the code comment at the pre-persist
// records happening on session e24477e2. The prompt then reaches state only
// through Stop's transcript reconcile, and `recordPromptShadow` never ran for
// it, because that call lives in the hook that died.
//
// With no start-state the turn used to fall back to the SESSION's start, so its
// diff spanned every turn since; its blob hops duplicated earlier turns', the
// API's findEchoWindowIndexes correctly classified it as a re-capture, and the
// read path blanked it. Session d5cc625b turns 2 and 8 rendered empty on the
// dashboard exactly this way, having been SENT +817/-4 and +1117/-7.
//
// The kill is simulated by never running the prompt hook for turn 2 at all —
// which is what a killed hook leaves behind, since the state file is written
// only after the turn boundary is complete.
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

const SESSION_ID = 'e2e-killed-hook-3456';
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
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: 'e2e-killed-0001', verboseCapture: false }));
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

describe.skipIf(!haveDist)('a prompt whose hook was killed', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-killed-')));
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

  it('is anchored by Stop instead of borrowing the session start', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    // Turn 1: a normal turn — hook runs, so it is anchored.
    say('add the first module');
    expect((await run('user-prompt-submit', { prompt: 'add the first module' })).code).toBe(0);
    await agentWrites('tu-1', 'src/one.ts', 'export const one = 1;\n');
    expect((await run('stop', {})).code).toBe(0);

    const afterTurn1 = state();
    expect(afterTurn1.promptShadows?.map((s: any) => s.promptIndex)).toEqual([0]);
    // The baseline Stop just cut is turn 2's start-state. Hold it to prove
    // that is what turn 2 ends up anchored to.
    const cutAtEndOfTurn1 = afterTurn1.prePromptSha;
    expect(cutAtEndOfTurn1).toBeTruthy();

    // Turn 2: THE KILLED HOOK. The prompt reaches the transcript, but
    // user-prompt-submit never completes, so nothing anchors it.
    say('add the second module');
    await killJournalWatcher();
    await agentWrites('tu-2', 'src/two.ts', 'export const two = 2;\n');
    expect((await run('stop', {})).code).toBe(0);

    const s = state();
    // Stop's reconcile pulled the prompt in — that part always worked.
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).toBe('add the second module');

    // THE FIX: turn 2 is anchored to the shadow cut at the end of turn 1,
    // not left to fall back to the session's start.
    const anchored = (s.promptShadows || []).map((x: any) => x.promptIndex);
    expect(anchored, 'turn 2 must have a baseline').toContain(1);
    expect(
      (s.promptShadows || []).find((x: any) => x.promptIndex === 1)?.shadowSha,
      'and it must be the tree as turn 2 found it',
    ).toBe(cutAtEndOfTurn1);

    // Nothing was falsely marked lost: the baseline was recoverable.
    expect(s.promptsWithoutBaseline || []).not.toContain(1);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
