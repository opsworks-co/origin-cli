// END-TO-END: a turn that commits an earlier turn's work and rebases it over an
// upstream change to the same file is not billed that earlier work.
//
// Session 690e594c (2026-09-27). Turn 0 wrote the #1938 fix and left it
// uncommitted. Turn 1 committed it, rebased onto a main where #1937 had also
// edited user-prompt-submit.ts, re-bumped the version and pushed. Row 1 held
// turn 0's +26 in user-prompt-submit.ts — and only there: the files main had not
// touched came out clean, because for them the turn ended with the bytes it
// started with.
//
// Both producers measured an inherited file from the commit the rebase brought
// in. That commit knows nothing of the work that was uncommitted when the turn
// began, so the replay put it back and it read as the turn's. The fix measures
// such a file from the upstream version with the turn's starting dirt merged
// in; what is left is the turn's own.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { gitAsync } from './helpers/git-async.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);
const SESSION_ID = 'e2e-claude-rebase-dirt-session-1';
const API_SESSION = 'e2e-rebase-dirt-0001';

let server: http.Server;
let apiUrl = '';
let repo = '';
let hooksDir = '';
let transcript = '';
const sentRows: Array<{ promptIndex: number; filesChanged?: string[]; diff?: string; linesAdded?: number }> = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        try {
          const body = JSON.parse(raw || '{}');
          if (Array.isArray(body?.promptChanges)) sentRows.push(...body.promptChanges);
        } catch { /* not JSON */ }
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: API_SESSION, verboseCapture: false }));
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

const git = (args: string[]): string =>
  execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' },
  }).trim();

/** A git command that fires the hooks: async, so the fake API can answer them (gitAsync). */
const hookedGit = (args: string[]): Promise<string> =>
  gitAsync(repo, ['-c', `core.hooksPath=${hooksDir}`, ...args], { env: { ...process.env, GIT_EDITOR: 'true' } });

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection — not asserted */ });
  child.stdin.end(JSON.stringify({ session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const lines: string[] = [];
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
  expect((await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id })).code).toBe(0);
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  expect((await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } })).code).toBe(0);
}

async function killJournalWatcher(): Promise<void> {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const lock = fs.readdirSync(dir).find((f) => f.startsWith(SESSION_ID.slice(0, 12)) && f.endsWith('.lock'));
      const pid = lock ? Number(fs.readFileSync(path.join(dir, lock), 'utf-8').trim()) : 0;
      if (pid > 0) { process.kill(pid, 'SIGTERM'); return; }
    } catch { /* no journal yet */ }
    await sleep(250);
  }
}

function sessionState(): any {
  const dir = git(['rev-parse', '--git-common-dir']);
  const abs = path.isAbsolute(dir) ? dir : path.join(repo, dir);
  const file = fs.readdirSync(abs).find((f) => f.startsWith('origin-session') && f.endsWith('.json'));
  expect(file, 'no session state file').toBeTruthy();
  return JSON.parse(fs.readFileSync(path.join(abs, file!), 'utf-8'));
}

const numbered = (n: number, edit: (i: number) => string | null = () => null) =>
  Array.from({ length: n }, (_, i) => edit(i + 1) ?? `export const line${i + 1} = ${i + 1};`).join('\n') + '\n';
const ORIGINAL = numbered(40);
const TURN_A = numbered(40, (i) => (i === 3 ? 'export const line3 = "turn A wrote this";' : null));
const UPSTREAM = numbered(40, (i) => (i === 35 ? 'export const line35 = "upstream wrote this";' : null));

describe.skipIf(!haveDist)('a rebase that replays an earlier turn\'s uncommitted work', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-rebase-dirt-')));
    repo = path.join(tmp, 'repo');
    hooksDir = path.join(tmp, 'hooks');
    fs.mkdirSync(repo);
    fs.mkdirSync(hooksDir);
    transcript = path.join(tmp, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, '');
    // Foreground, so each step sees the hook's work done.
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
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
    }));

    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/hook.ts'), ORIGINAL);
    fs.writeFileSync(path.join(repo, 'src/state.ts'), 'export const state = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    // Another PR lands on main while the session works: same file, other end.
    git(['checkout', '-q', '-b', 'upstream']);
    fs.writeFileSync(path.join(repo, 'src/hook.ts'), UPSTREAM);
    git(['commit', '-q', '-am', 'fix: upstream edits hook.ts too']);
    git(['checkout', '-q', 'main']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('bills the rebasing turn only for what it wrote', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    // Turn 0: writes two files and commits nothing.
    expect((await run('user-prompt-submit', { prompt: 'fix the hook' })).code).toBe(0);
    say('fix the hook');
    await agentWrites('tu-1', 'src/hook.ts', TURN_A);
    await agentWrites('tu-2', 'src/state.ts', 'export const state = 2;\n');
    expect((await run('stop', {})).code).toBe(0);

    // Turn 1: its own one-line file, then commit everything and rebase.
    expect((await run('user-prompt-submit', { prompt: 'merge and release it yourself' })).code).toBe(0);
    say('merge and release it yourself');
    await agentWrites('tu-3', 'version.txt', '0.20260927.1910\n');
    const bash = { tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m fix && git rebase upstream' }, tool_use_id: 'tu-4' };
    expect((await run('pre-tool-use', bash)).code).toBe(0);
    git(['add', '-A']);
    await hookedGit(['commit', '-q', '-m', 'fix(capture): the hook fix']);
    await hookedGit(['rebase', '-q', 'upstream']);
    await sleep(1500); // the journal watcher sees the rebase's rewrites
    toolUse('tu-4', 'Bash', bash.tool_input);
    expect((await run('post-tool-use', { ...bash, tool_response: { stdout: '', stderr: '' } })).code).toBe(0);
    // The rebase put both edits in one file.
    const final = fs.readFileSync(path.join(repo, 'src/hook.ts'), 'utf-8');
    expect(final).toContain('turn A wrote this');
    expect(final).toContain('upstream wrote this');
    expect((await run('stop', {})).code).toBe(0);
    await sleep(500);

    const rows = sessionState().completedPromptMappings || [];
    const turn0 = rows.find((r: any) => r.promptIndex === 0);
    const turn1 = rows.find((r: any) => r.promptIndex === 1);
    expect(turn0?.filesChanged, 'turn 0 keeps its own files').toEqual(expect.arrayContaining(['src/hook.ts', 'src/state.ts']));
    expect(turn1?.filesChanged, 'turn 1 holds only what it wrote').toEqual(['version.txt']);
    expect(turn1?.diff || '').not.toContain('turn A wrote this');
    expect(turn1?.diff || '').not.toContain('upstream wrote this');

    const sentForTurn1 = sentRows.filter((r) => r.promptIndex === 1);
    expect(sentForTurn1.length, 'turn 1 reached the API').toBeGreaterThan(0);
    for (const r of sentForTurn1) {
      expect(r.filesChanged || [], 'no row sent for turn 1 names the replayed file').not.toContain('src/hook.ts');
      expect(r.diff || '').not.toContain('turn A wrote this');
    }
  }, 600_000 * WINDOWS_SLOWDOWN);
});
