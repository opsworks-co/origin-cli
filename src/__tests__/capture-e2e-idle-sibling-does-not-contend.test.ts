// END-TO-END: an IDLE session in the same working tree is not a rival.
//
// Live, 2026-10-14: session 9c1b8c40 (claude-code) sat in worktree
// nostalgic-germain RUNNING but idle — last Stop 01:25:32Z, `activeTurn: null`,
// never ended. Session 3cadaee2 took its first prompt in the same tree at
// 01:32:27Z. The prompt hook saw a non-ENDED peer seen within ten minutes and
// recorded it in `contendingSessionIds`; a peer that never ends is never
// stamped gone, so the mark covered every turn. The ledger logged "ledger
// declined: another live session shares this working tree", the turn window
// stood down too, and turn 1 shipped only its Write-tool file
// (RepoImportPanel.tsx +390) while the three shell-written files — Repos.tsx
// −360, light-remap.css, raw-gray-baseline.json — reached the session header
// and no turn: `header_file_unclaimed_by_turns`.
//
// A peer whose last turn closed before this turn began, with nothing since,
// could not have written during it. The guard below keeps the protection for
// a peer that really is working at the same time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { foldStopRows } from './helpers/fold-stop-rows.js';
import { stopBackgroundDaemons } from './helpers/background-daemons.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SIBLING_API = 'cccccccc-7777-4777-8777-cccccccccccc';
const WORK_API = 'dddddddd-8888-4888-8888-dddddddddddd';
// Fresh conversation ids per test (see freshRepo): a claude-code conversation
// follows its id across trees, so reusing one would resume the previous test's
// session instead of starting a new one here.
let SIBLING_CONV = 'e2e-idle-sibling-conv-0001';
let WORK_CONV = 'e2e-idle-work-conv-0002';
let testRun = 0;

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
          res.end(JSON.stringify({ sessionId: starts === 1 ? SIBLING_API : WORK_API, verboseCapture: false }));
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
let repo = '';
const transcripts: Record<string, string> = {};
let lines: Record<string, string[]> = { [SIBLING_CONV]: [], [WORK_CONV]: [] };

function run(conv: string, event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({ session_id: conv, transcript_path: transcripts[conv], cwd: repo, hook_event_name: event, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function say(conv: string, text: string) {
  lines[conv].push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
function toolUse(conv: string, id: string, name: string, input: Record<string, unknown>) {
  lines[conv].push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines[conv].push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
function assistantSays(conv: string, text: string) {
  lines[conv].push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
async function agentWrites(conv: string, id: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  await run(conv, 'pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(conv, id, 'Write', input);
  await run(conv, 'post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

/** The state file of one session, found by its server id. */
function stateOf(serverId: string): Record<string, any> {
  const dir = path.join(repo, '.git');
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('origin-session') && n.endsWith('.json'))) {
    const st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    if (st.sessionId === serverId) return st;
  }
  throw new Error(`no state file for ${serverId}`);
}

const workPayloads = () => hits
  .filter((h) => h.method === 'PATCH' && h.url.includes(WORK_API) && Array.isArray(h.body?.promptChanges))
  .map((h) => h.body.promptChanges);
const workRows = (): any[] => foldStopRows(workPayloads());
const diffFiles = (diff: string | null | undefined): string[] =>
  [...String(diff || '').matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);

/** Journal watchers and heartbeat daemons of BOTH sessions, by their own pid files — and wait until they are gone. */
async function killDaemons(): Promise<void> {
  await stopBackgroundDaemons();
}


async function agentShell(conv: string, id: string, command: string, writes: Record<string, string>) {
  const input = { command };
  await run(conv, 'pre-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id });
  for (const [file, content] of Object.entries(writes)) {
    const abs = path.join(repo, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  toolUse(conv, id, 'Bash', input);
  await run(conv, 'post-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id, tool_response: { stdout: '', stderr: '', interrupted: false } });
}

async function freshRepo(): Promise<void> {
  await killDaemons();
  hits.length = 0;
  starts = 0;
  // On POSIX the previous test's sessions were ended by their heartbeat's
  // SIGTERM handler; Windows' TerminateProcess runs no handler, so they are
  // still RUNNING and the same conversation ids would resume them.
  testRun += 1;
  SIBLING_CONV = `e2e-idle-sibling-conv-0001-t${testRun}`;
  WORK_CONV = `e2e-idle-work-conv-0002-t${testRun}`;
  lines = { [SIBLING_CONV]: [], [WORK_CONV]: [] };
  repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
  for (const c of [SIBLING_CONV, WORK_CONV]) { transcripts[c] = path.join(repo, '..', `${path.basename(repo)}-${c}.jsonl`); fs.writeFileSync(transcripts[c], ''); }
  git(['init', '-q']);
  git(['config', 'user.name', 'E2E']);
  git(['config', 'user.email', 'e2e@example.com']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(repo, 'src', 'page.tsx'), Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
}

/** The work session: one turn that writes one file with Write and two through the shell. */
async function workTurn(): Promise<void> {
  expect((await run(WORK_CONV, 'session-start', { source: 'startup' })).code).toBe(0);
  say(WORK_CONV, 'make importing look prettier');
  expect((await run(WORK_CONV, 'user-prompt-submit', { prompt: 'make importing look prettier' })).code).toBe(0);
  await agentWrites(WORK_CONV, 'tu-w1', 'src/panel.tsx', 'export const Panel = () => null;\nexport const pretty = true;\n');
  await agentShell(WORK_CONV, 'tu-s1', "python3 rewrite.py src/page.tsx && sed -i '' 1d src/style.css", {
    'src/page.tsx': Array.from({ length: 10 }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n',
    'src/style.css': '.pretty { color: blue; }\n',
  });
  assistantSays(WORK_CONV, 'Moved the import UI into a panel and trimmed the page.');
  expect((await run(WORK_CONV, 'stop', { stop_hook_active: false })).code).toBe(0);
}

describe.skipIf(!haveDist)('an idle session in the same tree does not contend', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-idle-peer-')));
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e-idle-peer', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e' }));
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killDaemons();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a sibling whose last turn closed before this turn began leaves the shell-written files on the turn', async () => {
    await freshRepo();
    // The sibling: ran a turn here, Stopped, and is still RUNNING — never ended.
    expect((await run(SIBLING_CONV, 'session-start', { source: 'startup' })).code).toBe(0);
    say(SIBLING_CONV, 'merge it');
    expect((await run(SIBLING_CONV, 'user-prompt-submit', { prompt: 'merge it' })).code).toBe(0);
    assistantSays(SIBLING_CONV, 'Merged.');
    expect((await run(SIBLING_CONV, 'stop', { stop_hook_active: false })).code).toBe(0);
    await sleep(50);

    await workTurn();

    expect(stateOf(SIBLING_API).status, 'the sibling must still be live for this to test anything').not.toBe('ENDED');
    expect(stateOf(WORK_API).contendingSessionIds || [], 'an idle sibling was recorded as a rival').not.toContain(SIBLING_API);
    const t0 = workRows().find((r) => r.promptIndex === 0);
    expect(t0, 'no row for the working turn').toBeTruthy();
    expect([...(t0.filesChanged || [])].sort()).toEqual(['src/page.tsx', 'src/panel.tsx', 'src/style.css']);
    const shown = new Set([...diffFiles(t0.diff), ...diffFiles(t0.uncommittedDiff)]);
    for (const f of ['src/page.tsx', 'src/panel.tsx', 'src/style.css']) expect(shown.has(f), `${f} has no content on the row`).toBe(true);
    expect(t0.linesRemoved, 'the shell trim of src/page.tsx is the turn\'s').toBeGreaterThanOrEqual(30);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('GUARD: a sibling with a turn open during this one still contends', async () => {
    await freshRepo();
    const logStart = hooksLog().length;
    // The sibling took a prompt and is still working when this session starts.
    expect((await run(SIBLING_CONV, 'session-start', { source: 'startup' })).code).toBe(0);
    say(SIBLING_CONV, 'refactor the page');
    expect((await run(SIBLING_CONV, 'user-prompt-submit', { prompt: 'refactor the page' })).code).toBe(0);

    await workTurn();

    expect(stateOf(WORK_API).contendingSessionIds || [], 'a working sibling must be recorded').toContain(SIBLING_API);
    expect(hooksLog().slice(logStart)).toContain('ledger declined: another live session shares this working tree');
    const t0 = workRows().find((r) => r.promptIndex === 0);
    expect(t0, 'no row for the working turn').toBeTruthy();
    // Neither exact path may own a contested turn.
    expect(t0.diffSource).not.toBe('ledger');
    expect(t0.diffSource).not.toBe('turn-window');
  }, 120_000 * WINDOWS_SLOWDOWN);
});
