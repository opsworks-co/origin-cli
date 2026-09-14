// END-TO-END: one turn commits on two sibling branches, through the BUILT
// binary and the REAL hook sequence, against a fake API.
//
// Session 049d69db row 15 (2026-09-14) opened PR branches from one main commit
// and committed on each. The card read "+9 -1, 2 files" beside "4 commits
// total +866/-179": Stop sent one range off whichever branch was checked out,
// and none once the tree had moved on. The unit test drives the function; this
// drives the hooks that feed it — post-commit on each branch, then one Stop
// from a tree that is on neither.
//
// Requires `dist/` (CI builds before it tests). POSIX-only, like the harness
// it is modelled on (capture-e2e-amend-real-binary.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { commitDiffScopedToPrompt } from '../git-capture.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';
const API_SESSION = 'e2e-branches-session-0001';

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
      const addr = server.address() as { port: number };
      apiUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

let repo = '';
let transcript = '';
let baseSha = '';
const SESSION_ID = 'e2e-claude-branches-session-1';

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection — not asserted */ });
  child.stdin.end(JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: transcript,
    cwd: repo,
    hook_event_name: event,
    ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

/** The git post-commit hook, as `origin enable` wires it. */
function gitHook(name: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name], {
    cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

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
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

/** A shell command the agent runs; `commit` fires post-commit, wired to us. */
async function agentShell(id: string, command: string, gitArgs: string[][], commit = false): Promise<string> {
  await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  for (const args of gitArgs) git(args);
  const sha = git(['rev-parse', 'HEAD']);
  if (commit) {
    const pc = await gitHook('git-post-commit');
    expect(pc.code, pc.stderr).toBe(0);
  }
  toolUse(id, 'Bash', { command });
  await run('post-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id, tool_response: { stdout: '', stderr: '' } });
  return sha;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function journalFiles(): { journal: string; lock: string } | null {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return null;
  const j = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl') && f.startsWith(SESSION_ID.slice(0, 12)));
  if (!j) return null;
  return { journal: path.join(dir, j), lock: path.join(dir, j.replace(/\.jsonl$/, '.lock')) };
}

async function killJournalWatcher(): Promise<void> {
  const jf = journalFiles();
  if (!jf) return;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(jf.lock, 'utf-8').trim());
      if (pid > 0) { process.kill(pid, 'SIGTERM'); return; }
    } catch { /* no lock yet */ }
    await sleep(250);
  }
}

/** Every PATCH the session sent, oldest first. */
const patches = () => hits.filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${API_SESSION}`)).map((h) => h.body);

describe.skipIf(!haveDist)('a turn that commits on two branches, end to end through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-branches-')));
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
    fs.writeFileSync(path.join(repo, 'README.md'), '# vodka\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    baseSha = git(['rev-parse', 'HEAD']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the turn row carries both branches\' patches after the tree leaves them', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);
    say('open a PR for each fix');
    const ups = await run('user-prompt-submit', { prompt: 'open a PR for each fix' });
    expect(ups.code, ups.stderr).toBe(0);
    await sleep(400);

    // Two PR branches off one main commit, both touching README.md.
    await agentShell('tu-1', 'git checkout -b fix-a', [['checkout', '-q', '-b', 'fix-a']]);
    await agentWrites('tu-2', 'a.py', 'A = 1\nA2 = 2\n');
    await agentWrites('tu-3', 'README.md', '# vodka\n\nFix A.\n');
    const aSha = await agentShell('tu-4', 'git add -A && git commit -m "fix a"',
      [['add', '-A'], ['commit', '-q', '-m', 'fix a']], true);

    await agentShell('tu-5', 'git checkout -b fix-b main', [['checkout', '-q', '-b', 'fix-b', 'main']]);
    await agentWrites('tu-6', 'b.py', 'B = 1\nB2 = 2\nB3 = 3\n');
    await agentWrites('tu-7', 'README.md', '# vodka\n\nFix B.\n');
    const bSha = await agentShell('tu-8', 'git add -A && git commit -m "fix b"',
      [['add', '-A'], ['commit', '-q', '-m', 'fix b']], true);
    expect(aSha).not.toBe(bSha);

    // Done: back to main, which holds neither branch.
    await agentShell('tu-9', 'git checkout main', [['checkout', '-q', 'main']]);
    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    const rows = patches()
      .filter((b) => Array.isArray(b?.promptChanges))
      .map((b) => b.promptChanges.find((r: any) => r.promptIndex === 0))
      .filter(Boolean);
    const last = rows[rows.length - 1];
    expect(last, 'no row for the committing turn').toBeTruthy();
    const log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8');
    // What Stop and post-commit decided, for a failure to explain itself: the
    // scratch home is gone by the time anyone reads the report.
    const why = JSON.stringify({
      row: { filesChanged: last.filesChanged, lines: [last.linesAdded, last.linesRemoved], diff: (last.diff || '').slice(0, 300) },
      commits: { a: aSha.slice(0, 8), b: bSha.slice(0, 8) },
      log: log.split('\n').filter((l) => /\[(stop|post-commit|git-post-commit)\]|commit patch/.test(l)).slice(-40),
    }, null, 2);

    // Each branch's files as git names them. Session-start writes Origin's
    // managed CLAUDE.md into the repo and `git add -A` commits it on both
    // branches; each branch is measured from its parent, which predates it.
    // (The server drops that path on read — see isAutoManagedPath.)
    const filesOf = (sha: string) => git(['show', '--no-renames', '--name-only', '--format=', sha]).split('\n').filter(Boolean);
    const branchA = commitDiffScopedToPrompt(repo, baseSha, aSha, filesOf(aSha))!;
    const branchB = commitDiffScopedToPrompt(repo, baseSha, bSha, filesOf(bSha))!;
    expect(filesOf(aSha)).toEqual(expect.arrayContaining(['README.md', 'a.py']));
    expect(filesOf(bSha)).toEqual(expect.arrayContaining(['README.md', 'b.py']));
    expect([...last.filesChanged].sort(), why).toEqual([...new Set([...filesOf(aSha), ...filesOf(bSha)])].sort());
    expect(last.diff).toContain(branchA.diff.trim());
    expect(last.diff).toContain(branchB.diff.trim());
    expect([last.linesAdded, last.linesRemoved]).toEqual([
      branchA.linesAdded + branchB.linesAdded,
      branchA.linesRemoved + branchB.linesRemoved,
    ]);
    expect(log).toContain('ledger diff replaced by the commit patches of several branches');
  }, 120_000 * WINDOWS_SLOWDOWN);
});
