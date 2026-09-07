// END-TO-END: `git commit --amend` through the BUILT binary and the REAL hook
// sequence, against a fake API.
//
// Prod vodka 5adc4b18 (2026-09-06): a turn committed three files, then amended
// the same commit to fold in a fourth. The unit test for the rescue was green
// and the page still read "2 commits total +996/-4" for +509/-3 of work,
// because nothing exercised the path the hooks actually take: post-commit
// records both shas, the rescue runs inside the session-scoped diff, and the
// `rewrittenCommits` pair has to reach the API for the orphan to leave the
// session. This drives exactly that — two post-commit hooks, one Stop — and
// asserts what the server needs, nothing else.
//
// Requires `dist/` (CI builds before it tests). POSIX-only, like the harness
// it is modelled on (capture-e2e-real-binary.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { commitDiffScopedToPrompt } from '../git-capture.js';

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
          res.end(JSON.stringify({ sessionId: 'e2e-amend-session-0001', verboseCapture: false }));
        } else if (u.startsWith('/api/pricing')) {
          res.end(JSON.stringify({ models: {} }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
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
const SESSION_ID = 'e2e-claude-amend-session-1';

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

/** The agent commits through its shell; git fires post-commit, wired to us. */
async function agentCommits(id: string, command: string, gitArgs: string[]): Promise<string> {
  await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  git(['add', '-A']);
  git(gitArgs);
  const sha = git(['rev-parse', 'HEAD']);
  const pc = await gitHook('git-post-commit');
  expect(pc.code, pc.stderr).toBe(0);
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
const patches = () => hits.filter((h) => h.method === 'PATCH' && /^\/api\/mcp\/session\/e2e-amend-session-0001/.test(h.url)).map((h) => h.body);

describe.skipIf(!haveDist || !posix)('git commit --amend end to end through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-amend-')));
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

    git(['init', '-q']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# vodka\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    baseSha = git(['rev-parse', 'HEAD']);
  }, 60_000);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('an amend that folds in a file reaches the API as a rewrite, and the orphan leaves the turn', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);
    say('do some more stuff');
    const ups = await run('user-prompt-submit', { prompt: 'do some more stuff' });
    expect(ups.code, ups.stderr).toBe(0);
    await sleep(400);

    // The commit as it first landed: shelf + readme.
    await agentWrites('tu-1', 'shelf.py', 'JARS = []\n');
    await agentWrites('tu-2', 'README.md', '# vodka\n\nA shelf.\n');
    const original = await agentCommits('tu-3',
      'git add -A && git commit -q -m "Add a shelf that remembers which jars are steeping."',
      ['commit', '-q', '-m', 'Add a shelf that remembers which jars are steeping.']);

    // The forgotten file, folded into the SAME commit.
    await agentWrites('tu-4', 'infuse.py', 'from shelf import JARS\n');
    const amended = await agentCommits('tu-5',
      'git add -A && git commit --amend --no-edit',
      ['commit', '-q', '--amend', '--no-edit']);
    expect(amended).not.toBe(original);

    const stop = await run('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    // The server's half (#1418) can only act on a pair the CLI names. Prod
    // never received one for the vodka amend — that absence IS the bug.
    const pairs = patches()
      .flatMap((b) => (Array.isArray(b?.gitCapture?.rewrittenCommits) ? b.gitCapture.rewrittenCommits : []));
    expect(pairs, 'no rewrittenCommits pair reached the API').toContainEqual({ from: original, to: amended });

    // After the amend, the turn wears the rewrite and only the rewrite.
    const rowsAfterAmend = patches()
      .filter((b) => Array.isArray(b?.promptChanges))
      .map((b) => b.promptChanges.find((r: any) => r.promptIndex === 0))
      .filter(Boolean);
    const last = rowsAfterAmend[rowsAfterAmend.length - 1];
    expect(last, 'no row for the committing turn').toBeTruthy();
    if (last.commitSha) expect(last.commitSha).toBe(amended);
    expect([...last.filesChanged].sort()).toEqual(['README.md', 'infuse.py', 'shelf.py']);

    // The turn's work is entirely in its (amended) commit and the tree is
    // clean, so the row carries git's own patch from the turn's baseline —
    // the same diff the commit badge reads — not the ledger's rendering.
    // Byte-identical, and hooks.log says the substitution happened.
    const exact = commitDiffScopedToPrompt(repo, baseSha, amended, ['README.md', 'infuse.py', 'shelf.py']);
    expect(exact?.diff, 'no scoped patch for the amended commit').toBeTruthy();
    expect(last.diff).toBe(exact!.diff);
    expect([last.linesAdded, last.linesRemoved]).toEqual([exact!.linesAdded, exact!.linesRemoved]);
    const log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8');
    expect(log).toContain('ledger diff replaced by the commit patch');

    // And the session's sha list, wherever it was last sent, holds the
    // rewrite and not the orphan.
    const shaLists = patches().map((b) => b?.gitCapture?.commitShas).filter(Array.isArray);
    const lastList = shaLists[shaLists.length - 1] as string[];
    expect(lastList, 'no commitShas reached the API').toBeTruthy();
    expect(lastList).toContain(amended);
    expect(lastList).not.toContain(original);
  }, 120_000);
});
