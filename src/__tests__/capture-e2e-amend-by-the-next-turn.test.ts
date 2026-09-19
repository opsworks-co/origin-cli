// END-TO-END: a commit one turn made and the NEXT turn amended, through the
// BUILT binary and the real hook sequence, against a fake API.
//
// Turn 1 commits shelf.py. Turn 2 writes infuse.py and runs `git commit
// --amend`. Turn 3 only asks a question, so a Stop runs AFTER the rewrite pair
// has folded the session's commit records.
//
// The review of #1724 reported this shape as a defect: with the fold keeping
// the EARLIEST attestation per survivor, turn 1 would own the amended commit,
// be measured against it and be billed infuse.py, and turn 2 would have made no
// commit. That reproduces only on a hand-built state. Through the hooks it does
// not: post-commit attests the amended sha to the running turn and corrects an
// attestation that names another one ("attested turn disagreed with the
// attributed one"), so the amended commit ends up on turn 2, turn 1 is declined
// by the commit-patch pass and keeps the row its own Stop sent.
//
// Nothing pinned that, and the fold's "keep the earliest" rule is one reorder
// away from undoing it. This asserts what reaches the server, at the amending
// Stop AND the one after it.
//
// Requires `dist/`. POSIX-only, like the harness it is modelled on
// (capture-e2e-amend-real-binary.test.ts).
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
          res.end(JSON.stringify({ sessionId: 'e2e-xturn-amend-session-0001', verboseCapture: false }));
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
const SESSION_ID = 'e2e-claude-xturn-amend-session-1';

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
const patches = () => hits.filter((h) => h.method === 'PATCH' && /^\/api\/mcp\/session\/e2e-xturn-amend-session-0001/.test(h.url)).map((h) => h.body);


/** git's post-rewrite hook: `amend` on argv, "<old> <new>" on stdin. */
function gitPostRewrite(oldSha: string, newSha: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'git-post-rewrite', 'amend'], {
    cwd: repo, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
  child.stdin.end(`${oldSha} ${newSha}\n`);
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

/** The last row the session sent for a turn. */
function lastRow(promptIndex: number): any {
  const rows = patches()
    .filter((b) => Array.isArray(b?.promptChanges))
    .map((b) => b.promptChanges.find((r: any) => r.promptIndex === promptIndex))
    .filter(Boolean);
  return rows[rows.length - 1];
}

describe.skipIf(!haveDist)('a commit amended by the NEXT turn, end to end through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-xturn-amend-')));
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
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('each turn is sent its own work: the first without the amendment, the second with it', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    // ── Turn 1: a commit ────────────────────────────────────────────────────
    say('add a shelf');
    expect((await run('user-prompt-submit', { prompt: 'add a shelf' })).code).toBe(0);
    await sleep(400);
    await agentWrites('tu-1', 'shelf.py', 'JARS = []\n');
    const original = await agentCommits('tu-2',
      'git add -A && git commit -q -m "Add a shelf."', ['commit', '-q', '-m', 'Add a shelf.']);
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    const firstAtItsOwnStop = lastRow(0);
    expect(firstAtItsOwnStop, 'no row for the first turn').toBeTruthy();
    expect([...firstAtItsOwnStop.filesChanged]).toEqual(['shelf.py']);

    // ── Turn 2: more work, folded into the SAME commit ──────────────────────
    say('you forgot the infusion, amend it in');
    expect((await run('user-prompt-submit', { prompt: 'you forgot the infusion, amend it in' })).code).toBe(0);
    await sleep(400);
    await agentWrites('tu-3', 'infuse.py', 'from shelf import JARS\n');
    const amended = await agentCommits('tu-4',
      'git add -A && git commit --amend --no-edit', ['commit', '-q', '--amend', '--no-edit']);
    expect(amended).not.toBe(original);
    const pr = await gitPostRewrite(original, amended);
    expect(pr.code, pr.stderr).toBe(0);
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    // ── Turn 3: nothing but a question ──────────────────────────────────────
    // The amending Stop still sees both attestations; the pair folds them
    // during it. It is the NEXT Stop that measures turn 1 against the amended
    // commit — and every Stop after it.
    say('is that everything?');
    expect((await run('user-prompt-submit', { prompt: 'is that everything?' })).code).toBe(0);
    await sleep(400);
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    // The pair reached the API — the server's half acts only on a pair it is sent.
    const pairs = patches()
      .flatMap((b) => (Array.isArray(b?.gitCapture?.rewrittenCommits) ? b.gitCapture.rewrittenCommits : []));
    expect(pairs, 'no rewrittenCommits pair reached the API').toContainEqual({ from: original, to: amended });

    // Turn 1, as last sent: its own commit's work, never the amendment.
    const first = lastRow(0);
    expect([...first.filesChanged].sort(), 'the first turn was billed the amendment').toEqual(['shelf.py']);
    expect(first.diff).not.toContain('infuse.py');
    expect([first.linesAdded, first.linesRemoved]).toEqual([1, 0]);

    // Turn 2: the amendment, and a commit to its name.
    const second = lastRow(1);
    expect(second, 'no row for the amending turn').toBeTruthy();
    expect([...second.filesChanged].sort()).toEqual(['infuse.py']);
    expect([second.linesAdded, second.linesRemoved]).toEqual([1, 0]);
    expect(second.commitSha, 'the amending turn made no commit').toBe(amended);
    // Turn 1's stamp, when it carries one, is never the superseded original.
    if (first.commitSha) expect(first.commitSha, 'a row stamped with a superseded sha').toBe(amended);

    // The amended commit is attested to the turn that made it.
    const stateDir = path.join(repo, '.git');
    const stateFile = fs.readdirSync(stateDir).find((f) => /^origin-session.*\.json$/.test(f));
    expect(stateFile, 'no session state file in .git').toBeTruthy();
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, stateFile!), 'utf-8'));
    const turnTwo = state.promptTurnIds?.[1];
    expect(turnTwo, 'the amending turn has no id').toBeTruthy();
    expect((state.commitTurns || []).map((c: any) => [c.sha, c.turnId])).toEqual([[amended, turnTwo]]);
  }, 180_000 * WINDOWS_SLOWDOWN);
});
