// END-TO-END: a turn commits on two branches; the NEXT turn amends one of
// those commits. Through the BUILT binary, the real hook sequence and a fake
// API.
//
// Session 597b3d88 (2026-10-21): turn 1 split six page files, one PR branch
// each, and its Stop sent the row as "the commit patches of several branches"
// (86 files, +14797/-12916). Turn 2 ("review and merge them") ran
// `git commit --amend` on the Dashboard branch to drop three unused imports
// (+1/-4). post-commit attested the amended sha to turn 2 and then CORRECTED
// the fold's attestation to turn 2 as well ("attested turn disagreed with the
// attributed one"). From then on every Stop rebuilt turn 1's row without the
// Dashboard branch — 69 files, +12031/-10273 — and the server credited turn 2
// with the whole +2749/-2625 of a commit it had changed five lines of.
//
// capture-e2e-amend-by-the-next-turn.test.ts pinned the opposite on 2026-09-18
// because there turn 1's row was a LEDGER row, which no later Stop rebuilds. A
// row that is the commit patches is re-derived from `commitTurns` at every
// Stop, so the re-tag moves the whole branch.
//
// The contract now: an amend by another turn is a rewrite shared between two
// turns, like a squash across turns. The amended commit stays attested to the
// turn that made the commit it replaced; that turn is measured on the commit
// it made; the amending turn keeps its ledger row — its own delta — and no
// commit stamp, so the server never records the amended commit as that turn's
// own original.
//
// The hooks here run in the order the live session saw them: post-rewrite
// recorded the pair BEFORE post-commit attested the new sha (both run in the
// background, 15 ms apart that night). The pinned test covers git's own order.
//
// Requires `dist/`. POSIX-only, like the harness it is modelled on
// (capture-e2e-several-branches-real-binary.test.ts).
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
const API_SESSION = 'e2e-amend-branch-session-0001';

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
const SESSION_ID = 'e2e-claude-amend-branch-session-1';

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

/** A git hook, as `origin enable` wires it. */
function gitHook(name: string, argv: string[] = [], stdin = ''): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name, ...argv], {
    cwd: repo, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
  child.stdin.end(stdin);
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

/**
 * A shell command the agent runs. `hooks` fires the git hooks a commit would,
 * in the order given, after git has run.
 */
async function agentShell(id: string, command: string, gitArgs: string[][], hooks: Array<() => Promise<{ code: number | null; stderr: string }>> = []): Promise<string> {
  await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  for (const args of gitArgs) git(args);
  const sha = git(['rev-parse', 'HEAD']);
  for (const hook of hooks) {
    const r = await hook();
    expect(r.code, r.stderr).toBe(0);
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

/** Every copy of a turn's row the session sent, oldest first. */
function rowsOf(promptIndex: number): any[] {
  return patches()
    .filter((b) => Array.isArray(b?.promptChanges))
    .map((b) => b.promptChanges.find((r: any) => r.promptIndex === promptIndex))
    .filter(Boolean);
}
const lastRow = (promptIndex: number) => rowsOf(promptIndex).slice(-1)[0];

describe.skipIf(!haveDist)('a branch commit amended by the NEXT turn, end to end through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-amend-branch-')));
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

  it('the first turn keeps the branch it wrote; the amending turn is sent its delta and no commit', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    // ── Turn 1: a commit on each of two branches ────────────────────────────
    say('split the pages, one PR each');
    expect((await run('user-prompt-submit', { prompt: 'split the pages, one PR each' })).code).toBe(0);
    await sleep(400);
    await agentShell('tu-1', 'git checkout -b split-a', [['checkout', '-q', '-b', 'split-a']]);
    await agentWrites('tu-2', 'a.py', 'A = 1\nA2 = 2\n');
    const aSha = await agentShell('tu-3', 'git add -A && git commit -m "split a"',
      [['add', '-A'], ['commit', '-q', '-m', 'split a']], [() => gitHook('git-post-commit')]);

    await agentShell('tu-4', 'git checkout -b split-b main', [['checkout', '-q', '-b', 'split-b', 'main']]);
    await agentWrites('tu-5', 'b.py', 'import os\nB = 1\nB2 = 2\n');
    const bSha = await agentShell('tu-6', 'git add -A && git commit -m "split b"',
      [['add', '-A'], ['commit', '-q', '-m', 'split b']], [() => gitHook('git-post-commit')]);
    expect(aSha).not.toBe(bSha);

    await agentShell('tu-7', 'git checkout main', [['checkout', '-q', 'main']]);
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    const filesOf = (sha: string) => git(['show', '--no-renames', '--name-only', '--format=', sha]).split('\n').filter(Boolean);
    const branchA = commitDiffScopedToPrompt(repo, baseSha, aSha, filesOf(aSha))!;
    const branchB = commitDiffScopedToPrompt(repo, baseSha, bSha, filesOf(bSha))!;
    const firstAtItsOwnStop = lastRow(0);
    expect(firstAtItsOwnStop, 'no row for the first turn').toBeTruthy();
    expect([...firstAtItsOwnStop.filesChanged].sort()).toEqual([...new Set([...branchA.files, ...branchB.files])].sort());

    // ── Turn 2: drop an unused import, amended into the branch commit ───────
    // post-rewrite reaches the session before post-commit does, as it did on
    // 2026-10-21 (both hooks run in the background).
    say('review and merge them');
    expect((await run('user-prompt-submit', { prompt: 'review and merge them' })).code).toBe(0);
    await sleep(400);
    await agentShell('tu-8', 'git checkout split-b', [['checkout', '-q', 'split-b']]);
    await agentWrites('tu-9', 'b.py', 'B = 1\nB2 = 2\n');
    let amended = '';
    await agentShell('tu-10', 'git add -A && git commit --amend --no-edit',
      [['add', '-A'], ['commit', '-q', '--amend', '--no-edit']], [
        async () => {
          amended = git(['rev-parse', 'HEAD']);
          return gitHook('git-post-rewrite', ['amend'], `${bSha} ${amended}\n`);
        },
        () => gitHook('git-post-commit'),
      ]);
    expect(amended).not.toBe(bSha);
    await agentShell('tu-11', 'git checkout main', [['checkout', '-q', 'main']]);
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    // ── Turn 3: a question; the Stop after the one that folded the pair ─────
    say('is that everything?');
    expect((await run('user-prompt-submit', { prompt: 'is that everything?' })).code).toBe(0);
    await sleep(400);
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    const log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8');
    const stateDir = path.join(repo, '.git');
    const stateFile = fs.readdirSync(stateDir).find((f) => /^origin-session.*\.json$/.test(f));
    expect(stateFile, 'no session state file in .git').toBeTruthy();
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, stateFile!), 'utf-8'));
    const first = lastRow(0);
    const second = lastRow(1);
    // What the hooks decided, for a failure to explain itself: the scratch
    // home is gone by the time anyone reads the report.
    const why = JSON.stringify({
      rows: { first: { files: first?.filesChanged, lines: [first?.linesAdded, first?.linesRemoved], commitSha: first?.commitSha },
        second: { files: second?.filesChanged, lines: [second?.linesAdded, second?.linesRemoved], commitSha: second?.commitSha } },
      commits: { a: aSha.slice(0, 8), b: bSha.slice(0, 8), amended: amended.slice(0, 8) },
      sent: rowsOf(1).map((r) => ({ commitSha: r.commitSha, files: r.filesChanged, lines: [r.linesAdded, r.linesRemoved], keys: Object.keys(r).sort().join(',') })),
      commitTurns: state.commitTurns, preSquash: state.preSquashCommitTurns, folded: state.foldedCommitTurns,
      log: log.split('\n').filter((l) => /\[(stop|post-commit|post-rewrite|user-prompt-submit)\]/.test(l) && /amend|delta|declined|replaced by|attested|recorded|pairs|window|payload|incremental|synthesized|stamp/.test(l)).slice(-80),
    }, null, 2);

    // The pair reached the API.
    const pairs = patches()
      .flatMap((b) => (Array.isArray(b?.gitCapture?.rewrittenCommits) ? b.gitCapture.rewrittenCommits : []));
    expect(pairs, 'no rewrittenCommits pair reached the API').toContainEqual({ from: bSha, to: amended });

    // Turn 1, as last sent: both branches, with b.py as IT wrote it.
    expect(first, 'no row for the first turn').toBeTruthy();
    expect([...first.filesChanged].sort(), why).toEqual([...new Set([...branchA.files, ...branchB.files])].sort());
    expect(first.diff, why).toContain(branchA.diff.trim());
    expect(first.diff, why).toContain('+import os');
    expect([first.linesAdded, first.linesRemoved], why).toEqual([
      branchA.linesAdded + branchB.linesAdded, branchA.linesRemoved + branchB.linesRemoved,
    ]);
    // …stamped with the commit as it stands now, never the superseded original.
    expect(first.commitSha, why).not.toBe(bSha);

    // Turn 2: its delta, and no commit of its own.
    expect(second, 'no row for the amending turn').toBeTruthy();
    expect([...second.filesChanged], why).toEqual(['b.py']);
    expect([second.linesAdded, second.linesRemoved], why).toEqual([0, 1]);
    expect(second.diff, why).toContain('-import os');
    expect(second.diff, why).not.toContain('+B = 1');
    expect(second.commitSha ?? null, why).toBeNull();
    // Nothing the session sent ever named the amended commit as turn 2's own —
    // post-commit's own row for the amend goes out without the stamp.
    expect(rowsOf(1).map((r) => r.commitSha).filter((s) => s === amended), why).toEqual([]);

    // The amended commit is attested to the turn that made the commit it
    // replaced, and that turn's own commit is recorded beside the fold.
    const turnOne = state.promptTurnIds?.[0];
    const turnTwo = state.promptTurnIds?.[1];
    expect(turnOne && turnTwo, why).toBeTruthy();
    const attested = (state.commitTurns || []).map((c: any) => [c.sha, c.turnId]);
    expect(attested, why).toContainEqual([amended, turnOne]);
    expect(attested, why).not.toContainEqual([amended, turnTwo]);
    expect((state.preSquashCommitTurns || []).map((c: any) => [c.sha, c.turnId, c.squash]), why)
      .toContainEqual([bSha, turnOne, amended]);
    expect(log, why).not.toContain('attested turn disagreed with the attributed one — correcting');
  }, 360_000 * WINDOWS_SLOWDOWN);
});
