// END-TO-END, the BUILT binary: a commit made in a SIBLING worktree for the
// same session must not rewrite a closed turn of the session's own tree.
//
// Session fd13f970 (2026-09-17). The session worked in worktree A on branch
// fix/rewrite-pair-proof-gaps. Turn 0 created a test file and committed; turn 1
// edited that file, rewrite-proof.ts and package.json and committed. Its Stop
// sent the right row — {"i":1,"f":3,"a":65,"r":10,"c":"17ada308"} — and every
// Stop for the next hour kept it. That PR was squash-merged to main (d813a284).
//
// Turn 6 spawned subagents with worktree isolation. One committed 109c422b in
// worktree B, a branch cut from a main that already held the squash, and its
// post-commit ran for the parent session. Inside it the amend/rebase rescue
// judged the session's commits from B's HEAD: turn 0's and turn 1's commits
// were not reachable from there, the squash on B's main had their parent and
// their final tree, so it recorded both as squashed into d813a284 and folded
// `commitTurns` onto that one sha — keeping the EARLIER turn's attestation.
// Turn 1 was left owning no commit. From the next Stop (in A, whose HEAD still
// held both commits) the commit-patch pass declined turn 1 as "the turn made no
// commit", and the ledger's own rendering went out instead:
// {"i":1,"f":1,"a":337,"r":0} — rewrite-proof.ts and package.json gone.
//
// Requires `dist/`. POSIX-only, like the other harnesses.
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

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const API_SESSION = 'e2e-sibling-wt-session-0001';
const CONV = 'e2e-sibling-wt-conv-0001';

const TEST_FILE = 'src/proof.test.ts';
const PROOF = 'src/proof.ts';
const OTHER = 'src/transfer.ts';

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

let tmp = '';
let repo = '';
let wtA = '';
let wtB = '';
let transcript = '';
const lines: string[] = [];

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Claude Code hook. `cwd` is where the tool ran: a subagent's is its own worktree. */
function run(event: string, cwd: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({
    session_id: CONV, transcript_path: transcript, cwd, hook_event_name: event, ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

/** The git post-commit hook, as `origin enable` wires it — no stdin, only its cwd. */
function gitHook(name: string, cwd: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name], {
    cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

async function agentWrites(tree: string, id: string, file: string, content: string) {
  const abs = path.join(tree, file);
  const input = { file_path: abs, content };
  await run('pre-tool-use', tree, { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run('post-tool-use', tree, { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

async function agentCommits(tree: string, id: string, message: string): Promise<string> {
  const command = `git add -A && git commit -q -m "${message}"`;
  await run('pre-tool-use', tree, { tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  git(tree, ['add', '-A']);
  git(tree, ['commit', '-q', '-m', message]);
  const sha = git(tree, ['rev-parse', 'HEAD']);
  const pc = await gitHook('git-post-commit', tree);
  expect(pc.code, pc.stderr).toBe(0);
  toolUse(id, 'Bash', { command });
  await run('post-tool-use', tree, { tool_name: 'Bash', tool_input: { command }, tool_use_id: id, tool_response: { stdout: '', stderr: '' } });
  return sha;
}

async function killJournalWatchers(): Promise<void> {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))) {
    try {
      const pid = Number(fs.readFileSync(path.join(dir, f), 'utf-8').trim());
      if (pid > 0) process.kill(pid, 'SIGTERM');
    } catch { /* gone */ }
  }
}

const rows = () => foldStopRows(
  hits
    .filter((h) => h.method === 'PATCH' && h.url.includes(API_SESSION) && Array.isArray(h.body?.promptChanges))
    .map((h) => h.body.promptChanges),
);

function sessionState(): any {
  const gitDir = path.join(repo, '.git');
  for (const f of fs.readdirSync(gitDir).filter((n) => n.startsWith('origin-session') && n.endsWith('.json'))) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(gitDir, f), 'utf-8'));
      if (st?.claudeSessionId === CONV || st?.agentSessionId === CONV) return st;
    } catch { /* not ours */ }
  }
  return null;
}

describe.skipIf(!haveDist)('a commit in a sibling worktree leaves the session\'s closed turns alone', () => {
  let turn0Commit = '';
  let turn1Commit = '';
  let turn1Row: any = null;

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-sibling-wt-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    transcript = path.join(tmp, `${CONV}.jsonl`);
    fs.writeFileSync(transcript, '');

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e-sibling-wt', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
    }));

    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'E2E']);
    git(repo, ['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, PROOF), 'export function proof() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(repo, OTHER), 'export const transfer = 0;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);

    wtA = path.join(tmp, 'worktrees', 'frosty');
    fs.mkdirSync(path.dirname(wtA), { recursive: true });
    git(repo, ['worktree', 'add', '-q', '-b', 'fix/proof-gaps', wtA]);
    wtA = fs.realpathSync.native(wtA);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatchers();
    for (const wt of [wtB, wtA]) {
      if (!wt) continue;
      try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('turns 0 and 1 commit in worktree A, and turn 1 goes out with both of its files', async () => {
    const start = await run('session-start', wtA, { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    say('add a proof test');
    expect((await run('user-prompt-submit', wtA, { prompt: 'add a proof test' })).code).toBe(0);
    await sleep(400);
    await agentWrites(wtA, 't0-1', TEST_FILE, 'import { proof } from "./proof";\n\ntest("proof", () => {\n  expect(proof()).toBe(1);\n});\n');
    turn0Commit = await agentCommits(wtA, 't0-2', 'test: proof');
    expect((await run('stop', wtA, { stop_hook_active: false })).code).toBe(0);

    say('close the gaps');
    expect((await run('user-prompt-submit', wtA, { prompt: 'close the gaps' })).code).toBe(0);
    await sleep(400);
    await agentWrites(wtA, 't1-1', TEST_FILE, 'import { proof } from "./proof";\n\ntest("proof", () => {\n  expect(proof()).toBe(2);\n});\n\ntest("gap", () => {\n  expect(proof()).toBeGreaterThan(1);\n});\n');
    await agentWrites(wtA, 't1-2', PROOF, 'export function proof() {\n  return 2;\n}\n');
    turn1Commit = await agentCommits(wtA, 't1-3', 'fix: proof gaps');
    expect((await run('stop', wtA, { stop_hook_active: false })).code).toBe(0);

    turn1Row = rows().find((r: any) => r.promptIndex === 1);
    expect(turn1Row, 'no row for turn 1').toBeTruthy();
    expect([...turn1Row.filesChanged].sort()).toEqual([TEST_FILE, PROOF]);
    expect(turn1Row.commitPatch, 'turn 1 did not go out as its commit patch').toBe(true);
    expect(sessionState()?.commitTurns?.map((c: any) => c.sha)).toEqual([turn0Commit, turn1Commit]);
  }, 180_000 * WINDOWS_SLOWDOWN);

  it('a subagent commits in worktree B (off a main that squash-merged A\'s branch); turn 1 keeps its row', async () => {
    // The PR is squash-merged on main: parent = A's base, tree = turn 1's tree.
    git(repo, ['merge', '-q', '--squash', 'fix/proof-gaps']);
    git(repo, ['commit', '-q', '-m', 'fix: proof gaps (#1)']);
    const squash = git(repo, ['rev-parse', 'HEAD']);

    say('review the transfer PR with subagents');
    expect((await run('user-prompt-submit', wtA, { prompt: 'review the transfer PR with subagents' })).code).toBe(0);
    await sleep(400);

    // A subagent with worktree isolation: its tree is cut from that main.
    wtB = path.join(tmp, 'worktrees', 'agent-b');
    git(repo, ['worktree', 'add', '-q', '-b', 'pr-2', wtB, squash]);
    wtB = fs.realpathSync.native(wtB);
    await agentWrites(wtB, 't2-1', OTHER, 'export const transfer = 1;\n');
    const sibling = await agentCommits(wtB, 't2-2', 'fix: transfer');
    expect(git(repo, ['rev-parse', `${sibling}^`])).toBe(squash);

    const stop = await run('stop', wtA, { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    if (process.env.E2E_DUMP) {
      console.log(JSON.stringify(rows().map((r: any) => ({
        i: r.promptIndex, f: r.filesChanged, a: r.linesAdded, r: r.linesRemoved, c: r.commitSha, p: r.commitPatch,
      })), null, 2));
      console.log(JSON.stringify(sessionState()?.commitTurns, null, 2));
      console.log(JSON.stringify(sessionState()?.rewrittenCommits, null, 2));
    }

    // The sibling's commit is attached to the turn that made it…
    const turnIds: string[] = sessionState()?.promptTurnIds || [];
    const attested = (sessionState()?.commitTurns || []).map((c: any) => [c.sha, c.turnId]);
    expect(attested).toContainEqual([sibling, turnIds[2]]);
    // …and nothing more: A's commits are still on A's HEAD, so B's view of
    // them is not a rewrite, and turn 1 still owns its commit.
    expect(attested, 'turn 1 lost its commit to a fold judged from the sibling worktree').toContainEqual([turn1Commit, turnIds[1]]);
    expect(attested).toContainEqual([turn0Commit, turnIds[0]]);
    expect(sessionState()?.rewrittenCommits || []).toEqual([]);

    const row: any = rows().find((r: any) => r.promptIndex === 1);
    expect(row, 'no row for turn 1').toBeTruthy();
    expect([...row.filesChanged].sort(), 'turn 1 lost a file').toEqual([TEST_FILE, PROOF]);
    expect([row.linesAdded, row.linesRemoved]).toEqual([turn1Row.linesAdded, turn1Row.linesRemoved]);
    expect(row.diff).toBe(turn1Row.diff);
    expect(row.commitPatch, 'turn 1 is no longer its commit patch').toBe(true);
  }, 180_000 * WINDOWS_SLOWDOWN);
});
