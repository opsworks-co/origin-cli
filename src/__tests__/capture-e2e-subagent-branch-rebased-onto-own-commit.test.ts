// END-TO-END: a turn's sub-agent branch, rebased onto one of the turn's own
// commits, is still a branch of the turn at the next Stop.
//
// Session df8cc9aa row 42 (CLI 0.20261003.2355, 2026-10-04). The turn made
// 62a18070 (later on main) and dd0c1357 on its own branch, and its sub-agent
// committed two commits on another branch in its own worktree. The first Stop
// sent both branches (+510/-55). The sub-agent then rebased its branch onto
// main, which by then held 62a18070. Every later Stop chained the rebased
// commits onto 62a18070 — an ancestor of both — called that chain reachable,
// took the single range off HEAD, and sent +88/-30 beside the commit chip's
// "4 commits total +513/-58".
//
// Here: the turn commits A on `fix`, the sub-agent commits S1, S2 on `agent`
// in its worktree, the turn commits B on `fix`, Stop; then the sub-agent
// rebases `agent` onto A and the turn Stops again. The row must still carry
// all four commits.
//
// Requires `dist/`. POSIX-only, like the harness it is modelled on.
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
const SESSION_ID = 'e2e-claude-subagent-rebased-branch-1';
const API_SESSION = 'e2e-subagent-rebased-branch-0001';

let server: http.Server;
let apiUrl = '';
let repo = '';
let hooksDir = '';
let transcript = '';
const sentRows: Array<{ promptIndex: number; filesChanged?: string[]; diff?: string; linesAdded?: number; linesRemoved?: number; commitSha?: string; patchCommits?: string[] }> = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        try {
          const body = JSON.parse(raw || '{}');
          if (req.method === 'PATCH' && Array.isArray(body?.promptChanges)) sentRows.push(...body.promptChanges);
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

/** A shell command the agent runs in `tree`, whose git calls fire the hooks. */
async function agentShell(id: string, command: string, gitCalls: string[][], tree = repo): Promise<string> {
  const call = { tool_name: 'Bash', tool_input: { command }, tool_use_id: id };
  expect((await run('pre-tool-use', call, tree)).code).toBe(0);
  for (const args of gitCalls) await hookedGit(args, { cwd: tree });
  toolUse(id, 'Bash', call.tool_input);
  expect((await run('post-tool-use', { ...call, tool_response: { stdout: '', stderr: '' } }, tree)).code).toBe(0);
  return git(['rev-parse', 'HEAD'], { cwd: tree });
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

const body = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';

describe.skipIf(!haveDist)("a sub-agent's branch rebased onto the turn's own commit", () => {
  let tmp = '';
  let wt = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-subagent-rebased-')));
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
    fs.writeFileSync(path.join(repo, 'src/base.ts'), 'export const base = 1;\n');
    // Origin's context files and the sub-agent's worktree would otherwise ride
    // along in `git add -A` (the worktree as a gitlink).
    fs.writeFileSync(path.join(repo, '.gitignore'), 'CLAUDE.md\nAGENTS.md\nGEMINI.md\n.claude/\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    git(['checkout', '-q', '-b', 'fix']);
    wt = path.join(repo, '.claude', 'worktrees', 'agent-e2e');
    git(['worktree', 'add', '-q', '-b', 'agent', wt, 'main']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a later Stop still sends every live commit of the turn', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);
    expect((await run('user-prompt-submit', { prompt: 'fix it, and have a sub-agent fix the other thing' })).code).toBe(0);
    say('fix it, and have a sub-agent fix the other thing');

    // 1. The turn edits and commits on its own branch.
    await agentWrites('tu-1', 'src/a.ts', body('a', 5));
    const a = await agentShell('tu-2', 'git add -A && git commit -m a', [['add', '-A'], ['commit', '-q', '-m', 'fix: a']]);

    // 2. The sub-agent commits twice on its branch, in its own worktree.
    await agentWrites('tu-3', 'src/s1.ts', body('s', 7), wt);
    const s1 = await agentShell('tu-4', 'git add -A && git commit -m s1', [['add', '-A'], ['commit', '-q', '-m', 'feat: s1']], wt);
    await agentWrites('tu-5', 'src/s2.ts', body('t', 11), wt);
    const s2 = await agentShell('tu-6', 'git add -A && git commit -m s2', [['add', '-A'], ['commit', '-q', '-m', 'feat: s2']], wt);

    // …and the turn commits again on its branch.
    await agentWrites('tu-7', 'src/b.ts', body('b', 3));
    const b = await agentShell('tu-8', 'git add -A && git commit -m b', [['add', '-A'], ['commit', '-q', '-m', 'fix: b']]);
    expect((await run('stop', {})).code).toBe(0);
    await sleep(300);

    // 3. The sub-agent rebases its branch onto the turn's first commit — the
    //    df8cc9aa shape, where main had taken the turn's 62a18070 by then.
    await agentShell('tu-9', `git rebase ${a.slice(0, 12)}`, [['rebase', '-q', a]], wt);
    const s1r = git(['rev-parse', 'HEAD~1'], { cwd: wt });
    const s2r = git(['rev-parse', 'HEAD'], { cwd: wt });
    expect(s2r).not.toBe(s2);
    expect(git(['merge-base', '--is-ancestor', a, s2r]).length).toBe(0);

    // 4. A later Stop of the same turn.
    const before = sentRows.length;
    expect((await run('stop', {})).code).toBe(0);
    await sleep(500);

    const state = sessionState();
    const log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8');
    const sent = sentRows.slice(before).filter((r) => r.promptIndex === 0);
    const row = sent[sent.length - 1];
    const why = JSON.stringify({
      commits: { a, b, s1, s2, s1r, s2r },
      commitTurns: state.commitTurns, rewrittenCommits: state.rewrittenCommits,
      row: row && { files: row.filesChanged, lines: [row.linesAdded, row.linesRemoved], commitSha: row.commitSha, patchCommits: row.patchCommits },
      log: log.split('\n').filter((l) => /commit patch|several branches|post-rewrite|post-commit/.test(l)).slice(-30),
    }, null, 2);
    expect(row, `no row for the turn after the rebase\n${why}`).toBeTruthy();
    // The sub-agent's commits are the turn's, under their rebased shas.
    const attested = (state.commitTurns || []).map((c: any) => c.sha);
    expect(attested, why).toEqual(expect.arrayContaining([a, b, s1r, s2r]));

    // 5. The row's diff covers every live commit: both of the turn's own and
    //    both of the sub-agent's, rebased.
    expect([...(row!.filesChanged || [])].sort(), why).toEqual(['src/a.ts', 'src/b.ts', 'src/s1.ts', 'src/s2.ts']);
    expect([row!.linesAdded, row!.linesRemoved], why).toEqual([5 + 3 + 7 + 11, 0]);
    for (const tag of ['a0', 'b0', 's0', 't0']) expect(row!.diff || '', why).toContain(`export const ${tag} = 0;`);
    expect(row!.patchCommits || [], why).toEqual(expect.arrayContaining([a, b, s1r, s2r]));
  }, 600_000 * WINDOWS_SLOWDOWN);
});
