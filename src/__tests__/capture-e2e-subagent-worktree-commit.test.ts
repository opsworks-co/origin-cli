// END-TO-END: the BUILT binary. A Claude session in worktree A spawns
// sub-agents with worktree isolation. Their tool hooks carry the PARENT's
// session_id, so every one of them moves the parent's single `lastCwd`.
//
// Session fd13f970 (2026-09-17) made commits in two sub-agent worktrees minutes
// apart and got opposite results:
//   78043a60e (agent-a47deb…): pre-commit saw lastCwd = a47deb ("narrowed by
//     lastCwd, matched: [fd13f970]"); 900ms later a sibling sub-agent's
//     post-tool-use moved lastCwd to abcef6, prepare-commit-msg re-listed,
//     found nobody in the tree -> "skip — no unambiguous active session", and
//     post-commit fell through to "multiple agent processes running — not
//     guessing". No trailer, no Commit row on the session.
//   109c422b5 (agent-abcef6…): lastCwd happened to point at that worktree at
//     commit time -> trailer written, "recorded commit on session".
// The owner was decided by which sub-agent fired a hook last.
//
// The rule under test: a commit made in a tree where a session's OWN hooks
// (its sub-agents included) fired belongs to that session, whatever lastCwd
// says right now; an unrelated session elsewhere never claims it; a tree no
// session worked in stays unattributed.
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

const PARENT_API = 'fd13f970-32ea-4462-b222-1807ef21d44a';
const OTHER_API = 'cccccccc-3333-4333-8333-cccccccccccc';
const PARENT_CONV = 'e2e-parent-conv-subagents-0001';
const OTHER_CONV = 'e2e-unrelated-conv-0002';

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
          res.end(JSON.stringify({ sessionId: starts === 1 ? PARENT_API : OTHER_API, verboseCapture: false }));
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
const wt: Record<'A' | 'B' | 'B2' | 'C' | 'D' | 'E', string> = { A: '', B: '', B2: '', C: '', D: '', E: '' };
const transcripts: Record<string, string> = {};

function run(cwd: string, conv: string, event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({ session_id: conv, transcript_path: transcripts[conv], cwd, hook_event_name: event, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
function gitHook(cwd: string, name: string, args: string[] = []): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name, ...args], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function killJournalWatchers(): Promise<void> {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))) {
    try { const pid = Number(fs.readFileSync(path.join(dir, f), 'utf-8').trim()); if (pid > 0) process.kill(pid, 'SIGTERM'); } catch { /* none */ }
  }
}

// One Bash tool call, both halves, as a sub-agent (or the parent) fires them.
async function bash(cwd: string, conv: string, id: string, command: string): Promise<void> {
  const pre = await run(cwd, conv, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  expect(pre.code, pre.stderr).toBe(0);
  const post = await run(cwd, conv, 'post-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id, tool_response: { stdout: '', stderr: '' } });
  expect(post.code, post.stderr).toBe(0);
}

// An edit tool call, both hook halves, as a sub-agent fires them from its own
// worktree under the PARENT's session_id. The file is really written between
// the two hooks, exactly as the tool would.
async function writeFile(cwd: string, conv: string, id: string, file: string, content: string): Promise<void> {
  const abs = path.join(cwd, file);
  const toolInput = { file_path: abs, content };
  const pre = await run(cwd, conv, 'pre-tool-use', { tool_name: 'Write', tool_input: toolInput, tool_use_id: id });
  expect(pre.code, pre.stderr).toBe(0);
  fs.writeFileSync(abs, content);
  const post = await run(cwd, conv, 'post-tool-use', {
    tool_name: 'Write', tool_input: toolInput, tool_use_id: id, tool_response: { filePath: abs, success: true },
  });
  expect(post.code, post.stderr).toBe(0);
}

// A read-only tool call: presence in the tree, no write.
async function readFile(cwd: string, conv: string, id: string, file: string): Promise<void> {
  const toolInput = { file_path: path.join(cwd, file) };
  await run(cwd, conv, 'pre-tool-use', { tool_name: 'Read', tool_input: toolInput, tool_use_id: id });
  await run(cwd, conv, 'post-tool-use', { tool_name: 'Read', tool_input: toolInput, tool_use_id: id, tool_response: { file: { content: 'x' } } });
}

// Stage what is in `tree`, drive prepare-commit-msg + commit + post-commit the
// way git does (hooks run from the tree root), and return what landed.
async function commitIn(tree: string, subject: string): Promise<{ sha: string; message: string; recorded: string | undefined }> {
  git(tree, ['add', '-A']);
  const msgFile = git(tree, ['rev-parse', '--git-path', 'COMMIT_EDITMSG']);
  const absMsg = path.isAbsolute(msgFile) ? msgFile : path.join(tree, msgFile);
  fs.writeFileSync(absMsg, `${subject}\n`);
  const pcm = await gitHook(tree, 'git-prepare-commit-msg', [absMsg, 'message']);
  expect(pcm.code, pcm.stderr).toBe(0);
  const message = fs.readFileSync(absMsg, 'utf-8');
  git(tree, ['commit', '-q', '--no-verify', '-F', absMsg]);
  const sha = git(tree, ['rev-parse', 'HEAD']);
  const pc = await gitHook(tree, 'git-post-commit');
  expect(pc.code, pc.stderr).toBe(0);
  const recorded = hooksLog().split('\n').find((l) => l.includes('recorded commit on session') && l.includes(sha.slice(0, 8)));
  return { sha, message, recorded };
}

describe.skipIf(!haveDist)('sub-agent worktree commits belong to the parent session, independent of lastCwd', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-subagent-wt-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    for (const c of [PARENT_CONV, OTHER_CONV]) { transcripts[c] = path.join(tmp, `${c}.jsonl`); fs.writeFileSync(transcripts[c], ''); }
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e-subagent', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e' }));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'E2E']);
    git(repo, ['config', 'user.email', 'e2e@example.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);
    // The real layout: every worktree nested under the main checkout, which is
    // what makes plain path containment useless for telling them apart.
    for (const name of Object.keys(wt) as Array<keyof typeof wt>) {
      const p = path.join(repo, '.claude', 'worktrees', `wt-${name.toLowerCase()}`);
      git(repo, ['worktree', 'add', '-q', '-b', `branch-${name.toLowerCase()}`, p]);
      wt[name] = fs.realpathSync.native(p);
    }
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatchers();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the parent registers in worktree A, the unrelated session in worktree C', async () => {
    const a = await run(wt.A, PARENT_CONV, 'session-start', { source: 'startup' });
    expect(a.code, a.stderr).toBe(0);
    const ups = await run(wt.A, PARENT_CONV, 'user-prompt-submit', { prompt: 'fan out to sub-agents in worktrees' });
    expect(ups.code, ups.stderr).toBe(0);

    const c = await run(wt.C, OTHER_CONV, 'session-start', { source: 'startup' });
    expect(c.code, c.stderr).toBe(0);
    const upc = await run(wt.C, OTHER_CONV, 'user-prompt-submit', { prompt: 'unrelated work in C' });
    expect(upc.code, upc.stderr).toBe(0);
    await bash(wt.C, OTHER_CONV, 'c-1', 'ls');
    expect(starts).toBe(2);
  }, 90_000 * WINDOWS_SLOWDOWN);

  it('(a) a sub-agent commits in B while the parent\'s lastCwd is back in A: the parent owns it', async () => {
    // Sub-agent 1 WRITES in B under the parent's session_id...
    await writeFile(wt.B, PARENT_CONV, 'b-1', 'b.txt', 'sub-agent 1 commit in B\n');
    // ...then the parent (or a sibling sub-agent) fires in A, moving lastCwd.
    await bash(wt.A, PARENT_CONV, 'a-1', 'git status');

    const { sha, message, recorded } = await commitIn(wt.B, 'sub-agent 1 commit in B');
    expect(message, 'no Origin-Session trailer on the sub-agent\'s commit').toMatch(/Origin-Session:/);
    expect(message).toContain(PARENT_API.slice(0, 12));
    expect(message).not.toContain(OTHER_API.slice(0, 12));
    expect(recorded, 'post-commit recorded the commit on no session').toBeTruthy();
    expect(recorded).toContain(PARENT_API);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('(b) a sub-agent commits in B2 while lastCwd still points there: the parent owns it', async () => {
    await writeFile(wt.B2, PARENT_CONV, 'b2-1', 'b2.txt', 'sub-agent 2 commit in B2\n');

    const { message, recorded } = await commitIn(wt.B2, 'sub-agent 2 commit in B2');
    expect(message).toContain(`Origin-Session: ${PARENT_API.slice(0, 12)}`);
    expect(message).not.toContain(OTHER_API.slice(0, 12));
    expect(recorded).toContain(PARENT_API);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('(c) the unrelated session in C never claims a commit made in B, even when it fired last', async () => {
    await writeFile(wt.B, PARENT_CONV, 'b-3', 'b-again.txt', 'second commit in B\n');
    await bash(wt.C, OTHER_CONV, 'c-2', 'ls');

    const { message, recorded } = await commitIn(wt.B, 'second commit in B');
    expect(message).not.toContain(OTHER_API.slice(0, 12));
    expect(message).toContain(PARENT_API.slice(0, 12));
    expect(recorded).toContain(PARENT_API);
    expect(recorded).not.toContain(OTHER_API);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('(d) a commit in D, where no session\'s hooks ever fired, gets no trailer and no session', async () => {
    fs.writeFileSync(path.join(wt.D, 'd.txt'), 'nobody worked here\n');
    const { message, recorded } = await commitIn(wt.D, 'nobody worked here');
    expect(message).not.toMatch(/Origin-Session:/);
    expect(recorded, 'a session was credited with a commit made in a tree nobody worked in').toBeUndefined();
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('(e) a sub-agent that only READ in E does not get a human\'s commit there', async () => {
    // Presence is not work. The sub-agent ran Read in E and wrote nothing; the
    // human then commits their own file while the parent's turn is open.
    // Recording the tree of every tool call — the first version of this fix —
    // stamped the parent's trailer onto this commit.
    fs.writeFileSync(path.join(wt.E, 'human.txt'), 'written by a person\n');
    await readFile(wt.E, PARENT_CONV, 'e-1', 'README.md');
    // The sub-agent's task ends and the parent works on in A — the same
    // lastCwd move that case (a) turns on. All that is left of E is the visit.
    await bash(wt.A, PARENT_CONV, 'e-2', 'git status');

    const { message, recorded } = await commitIn(wt.E, 'a human commit in E');
    expect(message, 'a read-only visit attributed the commit').not.toMatch(/Origin-Session:/);
    expect(recorded, 'a read-only visit got the commit recorded on the session').toBeUndefined();
  }, 120_000 * WINDOWS_SLOWDOWN);
});
