// END-TO-END: a turn that commits, in a linked worktree, what an earlier turn's
// sub-agent wrote there is not billed that work.
//
// Session 9f3d6bd2 (2026-09-27). Turn 1 started a background sub-agent in its
// own worktree; it wrote a 139-line test there and left it uncommitted. Turn 2
// began, and the sub-agent committed the file in its worktree. Turn 2's shadow
// is of the main checkout — another HEAD, without the file — so the commit
// patch measured the file from its parent and turn 2 was sent the +139 again,
// beside turn 1's own +139. The submit hook had snapshotted the worktree as
// turn 2 began, bytes and all, but only in a slot the next prompt overwrites.
//
// And turn 1's own row went out chat-only: the shadow window is repoPath's
// tree, the file was in another checkout, and "empty" blanked the row.
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
const SESSION_ID = 'e2e-claude-subagent-wt-dirt-1';
const API_SESSION = 'e2e-subagent-wt-dirt-0001';

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

const git = (args: string[], opts: { cwd?: string } = {}): string =>
  execFileSync('git', args, {
    cwd: opts.cwd || repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' },
  }).trim();

/** A git command that fires the hooks: async, so the fake API can answer them (gitAsync). */
const hookedGit = (args: string[], opts: { cwd?: string } = {}): Promise<string> =>
  gitAsync(opts.cwd || repo, ['-c', `core.hooksPath=${hooksDir}`, ...args], { env: { ...process.env, GIT_EDITOR: 'true' } });

function run(event: string, payload: Record<string, unknown> = {}, cwd = repo): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection — not asserted */ });
  child.stdin.end(JSON.stringify({ session_id: SESSION_ID, transcript_path: transcript, cwd, hook_event_name: event, ...payload }));
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

async function agentWrites(id: string, file: string, content: string, tree = repo) {
  const abs = path.join(tree, file);
  const input = { file_path: abs, content };
  expect((await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id }, tree)).code).toBe(0);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  expect((await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } }, tree)).code).toBe(0);
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

const TEST = Array.from({ length: 30 }, (_, i) => `it('case ${i}', () => {});`).join('\n') + '\n';

describe.skipIf(!haveDist)("an earlier turn's worktree work committed by the next turn", () => {
  let tmp = '';
  let wt = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-subagent-wt-dirt-')));
    repo = path.join(tmp, 'repo');
    hooksDir = path.join(tmp, 'hooks');
    fs.mkdirSync(repo);
    fs.mkdirSync(hooksDir);
    transcript = path.join(tmp, `${SESSION_ID}.jsonl`);
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
    fs.writeFileSync(path.join(repo, 'src/hook.ts'), 'export const hook = 1;\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    // The session works on a branch; the sub-agent gets its own worktree off main.
    git(['checkout', '-q', '-b', 'fix']);
    fs.writeFileSync(path.join(repo, 'src/hook.ts'), 'export const hook = 2;\n');
    git(['commit', '-q', '-am', 'fix: the session\'s earlier commit']);
    wt = path.join(repo, '.claude', 'worktrees', 'agent-e2e');
    git(['worktree', 'add', '-q', '-b', 'agent', wt, 'main']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("bills the sub-agent's file to the turn that wrote it, once", async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    // Turn 0: the sub-agent writes a test in its worktree and commits nothing.
    expect((await run('user-prompt-submit', { prompt: 'fix it, and add a test' })).code).toBe(0);
    say('fix it, and add a test');
    await agentWrites('tu-1', 'src/agent.test.ts', TEST, wt);
    expect((await run('stop', {})).code).toBe(0);
    const turn0Row = (sessionState().completedPromptMappings || []).find((r: any) => r.promptIndex === 0);
    expect(JSON.stringify(turn0Row?.filesChanged || []), 'turn 0 keeps the file its sub-agent wrote').toContain('agent.test.ts');
    expect(turn0Row?.linesAdded, 'turn 0 carries the whole file').toBe(30);
    expect(turn0Row?.diff || '').toContain('case 0');

    // Turn 1: the sub-agent commits its file; the turn commits its own change.
    expect((await run('user-prompt-submit', { prompt: 'merge and release both yourself' })).code).toBe(0);
    say('merge and release both yourself');
    const state1 = sessionState();
    expect(state1.promptWorkTreeShadows?.find((s: any) => s.promptIndex === 1), 'the worktree start of turn 1 is kept').toBeTruthy();
    const commitInWt = { tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m test' }, tool_use_id: 'tu-2' };
    expect((await run('pre-tool-use', commitInWt, wt)).code).toBe(0);
    git(['add', '-A'], { cwd: wt });
    await hookedGit(['commit', '-q', '-m', 'test: the sub-agent\'s file'], { cwd: wt });
    toolUse('tu-2', 'Bash', commitInWt.tool_input);
    expect((await run('post-tool-use', { ...commitInWt, tool_response: { stdout: '', stderr: '' } }, wt)).code).toBe(0);
    await agentWrites('tu-3', 'version.txt', '0.20260927.1619\n');
    const commitHere = { tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m bump' }, tool_use_id: 'tu-4' };
    expect((await run('pre-tool-use', commitHere)).code).toBe(0);
    git(['add', 'version.txt']);
    await hookedGit(['commit', '-q', '-m', 'chore: bump']);
    toolUse('tu-4', 'Bash', commitHere.tool_input);
    expect((await run('post-tool-use', { ...commitHere, tool_response: { stdout: '', stderr: '' } })).code).toBe(0);
    expect((await run('stop', {})).code).toBe(0);
    // The next prompt re-captures the turn before it; that must not undo it.
    expect((await run('user-prompt-submit', { prompt: 'all done here?' })).code).toBe(0);
    say('all done here?');
    expect((await run('stop', {})).code).toBe(0);
    await sleep(500);

    const rows = sessionState().completedPromptMappings || [];
    const turn1 = rows.find((r: any) => r.promptIndex === 1);
    const turn0 = rows.find((r: any) => r.promptIndex === 0);
    expect(JSON.stringify(turn0?.filesChanged || []), 'turn 0 still holds its file after the later turns').toContain('agent.test.ts');
    const sentForTurn0 = sentRows.filter((r) => r.promptIndex === 0);
    expect(JSON.stringify(sentForTurn0[sentForTurn0.length - 1]?.filesChanged || []), 'the last row sent for turn 0 names the file').toContain('agent.test.ts');
    expect(turn1?.filesChanged || [], 'turn 1 holds its own file').toContain('version.txt');
    expect(JSON.stringify(turn1?.filesChanged || []), 'turn 1 is not billed the sub-agent\'s file').not.toContain('agent.test.ts');
    expect(turn1?.diff || '').not.toContain('case 0');

    // Every producer: post-commit sends the worktree commit mid-turn, from the
    // turn's start in THAT worktree, where the file already was.
    const sentForTurn1 = sentRows.filter((r) => r.promptIndex === 1);
    expect(sentForTurn1.length, 'turn 1 reached the API').toBeGreaterThan(0);
    for (const r of sentForTurn1) {
      expect(JSON.stringify(r.filesChanged || []), 'a row sent for turn 1 names the sub-agent\'s file').not.toContain('agent.test.ts');
      expect(r.diff || '').not.toContain('case 0');
    }
  }, 600_000 * WINDOWS_SLOWDOWN);
});
