// END-TO-END: a long Claude session's turns stay each other's strangers when
// every 874ff028 hazard happens in ONE session.
//
// Session 874ff028 (RCCE-423) combined, in one run of prompts: a committed turn,
// a background job that made a WIP commit and path-checked-out an older tree
// across the next prompt, a `wip` commit reset away and recommitted under the
// same subject, a multi-hundred-KB uncommitted turn whose Stop update could not
// be delivered and sat in the queue, and a newer snapshot behind it. Each cause
// has its own regression test (#1681-#1695, #1719); this one runs them
// together through the built binary, the real hook sequence, git's own hooks
// wired by `core.hooksPath` as `origin enable --global` wires them, and a fake
// API that folds rows the way the PATCH handler does.
//
// Every turn is checked on exact files, commit SHAs, diff/uncommittedDiff
// markers and counts — not line totals alone.
//
// What it caught (RCCE-423): the turns' rows were already right, but every
// Stop and session end still listed the two reset-away WIP commits in the
// session's `commitShas` and never sent them as `abandonedCommits`. The server
// kept them on the session, and the read path badged turn 2's reset-away
// commit onto turn 1.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { foldStopRows } from './helpers/fold-stop-rows.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SESSION_ID = 'e2e-isolated-turns-4230';
const SERVER_SESSION = 'e2e-isolated-0423';

type Hit = { method: string; url: string; body: any; status: number };
const hits: Hit[] = [];
let failPatches = false;
let server: http.Server;
let apiUrl = '';
let repo = '';
let hooksDir = '';
let transcript = '';
const lines: string[] = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        const u = req.url || '';
        res.setHeader('content-type', 'application/json');
        // The API is down for session updates while the big turn closes.
        const down = failPatches && req.method === 'PATCH' && u.startsWith('/api/mcp/session/');
        hits.push({ method: req.method || '', url: u, body, status: down ? 503 : 200 });
        if (down) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'unavailable' }));
        } else if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: SERVER_SESSION, verboseCapture: false }));
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

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({
    session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true', ...env },
  }).trim();
// Inside the scenario git runs Origin's hooks, which call the fake API served
// by THIS process: a synchronous git call would block the event loop and every
// hook request would time out.
const execFileP = promisify(execFile);
const gitA = async (args: string[], env: Record<string, string> = {}): Promise<string> =>
  (await execFileP('git', args, {
    cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_EDITOR: 'true', ...env },
  })).stdout.trim();
const head = () => gitA(['rev-parse', 'HEAD']);

function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
function reply(text: string) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

/** A Write tool call as the agent performs it: PreToolUse → the write → PostToolUse. */
async function agentWrites(id: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  expect((await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id })).code).toBe(0);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  expect((await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } })).code).toBe(0);
}

/** A Bash tool call whose body is git work done in this process. */
async function agentShell(id: string, command: string, body: () => Promise<void>) {
  const input = { command };
  expect((await run('pre-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id })).code).toBe(0);
  await body();
  toolUse(id, 'Bash', input);
  expect((await run('post-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id, tool_response: { stdout: '', stderr: '' } })).code).toBe(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function journalFiles(): { journal: string; lock: string } | null {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return null;
  const j = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl') && f.startsWith(SESSION_ID.slice(0, 12)));
  return j ? { journal: path.join(dir, j), lock: path.join(dir, j.replace(/\.jsonl$/, '.lock')) } : null;
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

function hooksLog(): string {
  try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; }
}

const queued = (): string[] => {
  const dir = path.join(os.homedir(), '.origin', 'queue');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
};

/** Session-update PATCHes the API accepted, in arrival order. */
const accepted = () => hits.filter((h) => h.method === 'PATCH' && h.status === 200
  && h.url.startsWith(`/api/mcp/session/${SERVER_SESSION}`) && h.body && typeof h.body === 'object');

/** Rows as the server stores them: last write per promptIndex, stale captures refused. */
const rows = (): any[] => foldStopRows(accepted().map((h) => h.body).filter((b) => Array.isArray(b.promptChanges)));
const row = (i: number): any => rows().find((r) => r.promptIndex === i);
const text = (r: any) => `${r?.diff || ''}\n${r?.uncommittedDiff || ''}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** Every sha any accepted payload stamped on turn `i`, in arrival order. The server keeps the first (fill-only). */
const stamps = (i: number): string[] => accepted().flatMap((h) => (h.body.promptChanges || [])
  .filter((r: any) => r.promptIndex === i && typeof r.commitSha === 'string' && r.commitSha)
  .map((r: any) => r.commitSha));
const CONTENT = ['filesChanged', 'diff', 'uncommittedDiff', 'linesAdded', 'linesRemoved', 'turnId'];

const numbered = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `export const ${tag}_${i} = ${i};`).join('\n') + '\n';
const BASE: Record<string, string> = {
  'src/alpha.ts': numbered('alpha', 120),
  'src/beta.ts': numbered('beta', 120),
  'src/gamma.ts': numbered('gamma', 120),
};
const PR_FILE = 'src/pr_one.ts';

// Marker lines: each is written by exactly one turn.
const T1_ALPHA = 'export const T1_ALPHA_MARKER = "turn one alpha";';
const T1_GAMMA = 'export const T1_GAMMA_MARKER = "turn one gamma";';
const T2_BETA_A = 'export const T2_BETA_FIRST = "turn two, reset away";';
const T2_BETA_B = 'export const T2_BETA_FINAL = "turn two, recommitted";';
const T3_BIG = 'src/generated/big_table.ts';
const T3_MARKER = 'T3_BIG_ROW';
const T3_LINES = 6000;
const T4_DELTA = 'src/delta.ts';
const T4_MARKER = 'export const T4_DELTA_MARKER = "turn four";';
// Content that only ever lived in a commit reset away: none of it may reach
// the session's diff, files or counts.
const BG_ONLY_FILE = 'src/bg_scratch.ts';
const BG_ONLY = 'export const BG_ONLY_MARKER = "background wip only";';
const WIP2_ONLY_FILE = 'src/wip_probe.ts';
const WIP2_ONLY = 'export const WIP2_ONLY_MARKER = "turn two wip only";';

describe.skipIf(!haveDist)('a long session with every 874ff028 hazard, through the built binary', () => {
  let tmp = '';
  let older = '';
  let foreign = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-isolated-')));
    repo = path.join(tmp, 'repo');
    hooksDir = path.join(tmp, 'hooks');
    fs.mkdirSync(repo);
    fs.mkdirSync(hooksDir);
    transcript = path.join(tmp, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, '');

    // git's hooks as `origin enable --global` installs them, run in the
    // foreground so each step sees the hook's work already done.
    const node = `"${process.execPath}" "${BIN}" hooks`;
    const hookBodies: Record<string, string> = {
      'prepare-commit-msg': `${node} git-prepare-commit-msg "$1" "$2" "$3"`,
      'post-commit': `ORIGIN_COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null)" ${node} git-post-commit`,
      'post-rewrite': `${node} git-post-rewrite "$@"`,
      'post-checkout': `${node} git-post-checkout "$1" "$2" "$3"`,
    };
    for (const [name, body] of Object.entries(hookBodies)) {
      fs.writeFileSync(path.join(hooksDir, name), `#!/bin/sh\n${body} >/dev/null 2>&1 || true\n`, { mode: 0o755 });
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
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    for (const [f, c] of Object.entries(BASE)) fs.writeFileSync(path.join(repo, f), c);
    fs.writeFileSync(path.join(repo, PR_FILE), numbered('pr_one', 5));
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    older = git(['rev-parse', 'HEAD']);

    // Another session's PR merged on main before this session began.
    fs.writeFileSync(path.join(repo, PR_FILE), numbered('pr_one', 60));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'fix(capture): another session\'s PR (#1676)\n\nOrigin-Session: 805c1429-c4f | Codex | 6 prompts'], {
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
      GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@else.dev',
      GIT_COMMITTER_DATE: '2026-09-10T20:00:00 +0000', GIT_AUTHOR_DATE: '2026-09-10T20:00:00 +0000',
    });
    foreign = git(['rev-parse', 'HEAD']);

    // From here on every git command runs Origin's git hooks.
    git(['config', 'core.hooksPath', hooksDir]);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      console.log('--- hooks.log ---\n' + hooksLog().split('\n')
        .filter((l) => !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
        .map((l) => l.slice(0, 500)).join('\n'));
      console.log('--- PATCHes ---\n' + hits.filter((h) => h.method === 'PATCH').map((h) => JSON.stringify({
        status: h.status,
        keys: Object.keys(h.body || {}).filter((k) => k !== 'transcript'),
        rows: (h.body?.promptChanges || []).map((r: any) => ({
          i: r.promptIndex, t: r.turnId, f: r.filesChanged, a: r.linesAdded, r: r.linesRemoved,
          c: r.commitSha, at: r.capturedAt, d: String(r.diff || '').length, u: String(r.uncommittedDiff || '').length,
        })),
        commitTurns: h.body?.commitTurns,
        rewrites: h.body?.rewrittenCommits || h.body?.gitCapture?.rewrittenCommits,
        abandoned: h.body?.gitCapture?.abandonedCommits,
        git: h.body?.gitCapture && {
          shas: h.body.gitCapture.commitShas, snap: h.body.gitCapture.snapshot,
          a: h.body.gitCapture.linesAdded, r: h.body.gitCapture.linesRemoved,
          d: String(h.body.gitCapture.diff || '').length, u: String(h.body.gitCapture.uncommittedDiff || '').length,
        },
        files: h.body?.filesChanged,
      })).join('\n'));
    }
    await killJournalWatcher();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('each turn keeps exactly its own files, commits and lines', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    // ── Turn 1: commits alpha, leaves gamma uncommitted ──────────────────
    say('change alpha and gamma, commit alpha');
    expect((await run('user-prompt-submit', { prompt: 'change alpha and gamma, commit alpha' })).code).toBe(0);

    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal to exist');
    const { journal } = journalFiles()!;
    const recorded = () => fs.readFileSync(journal, 'utf-8');
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 400 && !recorded().includes('{"f"'); i++) {
      fs.writeFileSync(probe, String(i));
      await sleep(25);
    }
    expect(recorded(), 'the detached journal watcher recorded nothing').toContain('{"f"');
    await sleep(400);

    await agentWrites('tu-1a', 'src/alpha.ts', BASE['src/alpha.ts'] + T1_ALPHA + '\n');
    await agentWrites('tu-1b', 'src/gamma.ts', BASE['src/gamma.ts'] + T1_GAMMA + '\n');
    let commitA = '';
    await agentShell('tu-1c', 'git add src/alpha.ts && git commit -m "feat(alpha): turn one"', async () => {
      await gitA(['add', 'src/alpha.ts']);
      await gitA(['commit', '-q', '-m', 'feat(alpha): turn one']);
      commitA = await head();
    });
    reply('Alpha committed, gamma edited.');
    const stop1 = await run('stop', { stop_hook_active: false });
    expect(stop1.code, stop1.stderr).toBe(0);
    const turn1AtStop = clone(row(0));
    expect(turn1AtStop?.filesChanged, 'Stop built turn 1').toEqual(['src/alpha.ts', 'src/gamma.ts']);

    // ── Background job between Stop and the next prompt ─────────────────
    // WIP commit of the leftover work, then an older tree path-checked out.
    // HEAD does not move back.
    // Its scratch file exists only in that commit: written, committed and
    // removed from the tree before anything else sees it.
    fs.writeFileSync(path.join(repo, BG_ONLY_FILE), BG_ONLY + '\n');
    await gitA(['add', '-A']);
    await gitA(['commit', '-q', '-m', 'wip']);
    const wipBackground = await head();
    fs.rmSync(path.join(repo, BG_ONLY_FILE));
    await gitA(['checkout', older, '--', 'src']);
    await waitFor(() => recorded().includes(PR_FILE), 10_000, 'the journal to record the checkout');

    // ── Turn 2: prompt lands on the reverted tree; the job restores it ──
    say('now change beta');
    expect((await run('user-prompt-submit', { prompt: 'now change beta' })).code).toBe(0);
    await gitA(['checkout', 'HEAD', '--', 'src']);
    await gitA(['reset', '-q', '--soft', 'HEAD~1']);
    await gitA(['reset', '-q']);
    // Checking out HEAD's `src` put the WIP's scratch file back; the job
    // clears it again, so its content is left in the reset-away commit only.
    fs.rmSync(path.join(repo, BG_ONLY_FILE));
    await sleep(600);

    await agentWrites('tu-2a', 'src/beta.ts', BASE['src/beta.ts'] + T2_BETA_A + '\n');
    let wipThrownAway = '';
    let commitB = '';
    await agentShell('tu-2b', 'git add src/beta.ts && git commit -m wip', async () => {
      fs.writeFileSync(path.join(repo, WIP2_ONLY_FILE), WIP2_ONLY + '\n');
      await gitA(['add', 'src/beta.ts', WIP2_ONLY_FILE]);
      await gitA(['commit', '-q', '-m', 'wip']);
      wipThrownAway = await head();
    });
    await agentShell('tu-2c', 'git reset --soft HEAD~1 && git reset', async () => {
      await gitA(['reset', '-q', '--soft', 'HEAD~1']);
      await gitA(['reset', '-q']);
      fs.rmSync(path.join(repo, WIP2_ONLY_FILE));
    });
    await agentWrites('tu-2d', 'src/beta.ts', BASE['src/beta.ts'] + T2_BETA_A + '\n' + T2_BETA_B + '\n');
    await agentShell('tu-2e', 'git add src/beta.ts && git commit -m wip', async () => {
      await gitA(['add', 'src/beta.ts']);
      await gitA(['commit', '-q', '-m', 'wip']);
      commitB = await head();
    });
    reply('Beta committed.');
    const stop2 = await run('stop', { stop_hook_active: false });
    expect(stop2.code, stop2.stderr).toBe(0);
    const turn2AtStop = clone(row(1));

    // ── Turn 3: a big uncommitted file; its Stop update cannot land ─────
    say('generate the big table');
    expect((await run('user-prompt-submit', { prompt: 'generate the big table' })).code).toBe(0);
    const big = Array.from({ length: T3_LINES }, (_, i) => `  { id: ${i}, key: "${T3_MARKER}_${i}", value: "${'x'.repeat(24)}" },`).join('\n');
    await agentWrites('tu-3a', T3_BIG, `export const table = [\n${big}\n];\n`);
    reply('Generated.');
    failPatches = true;
    const stop3 = await run('stop', { stop_hook_active: false });
    failPatches = false;
    expect(stop3.code, stop3.stderr).toBe(0);
    expect(queued().length, 'the undelivered Stop update was not queued').toBeGreaterThan(0);

    // ── Turn 4: a small edit; its Stop supersedes the queued snapshot ───
    say('add delta');
    expect((await run('user-prompt-submit', { prompt: 'add delta' })).code).toBe(0);
    await agentWrites('tu-4a', T4_DELTA, T4_MARKER + '\n');
    reply('Added.');
    const stop4 = await run('stop', { stop_hook_active: false });
    expect(stop4.code, stop4.stderr).toBe(0);
    const stop4Hit = accepted().length - 1;

    // The queued big update is replayed by a background drain or dropped.
    await waitFor(() => queued().length === 0, 60_000, 'the update queue to drain');
    await sleep(500);

    const end = await run('session-end', { reason: 'prompt_input_exit' });
    expect(end.code, end.stderr).toBe(0);

    if (process.env.E2E_DUMP) {
      console.log('SHAS', JSON.stringify({ commitA, wipBackground, wipThrownAway, commitB, foreign }));
    }

    // ── Assertions ───────────────────────────────────────────────────────
    const all = rows();
    expect(all.map((r) => r.promptIndex), 'every turn reached the stored rows').toEqual([0, 1, 2, 3]);

    // Turn 1: unchanged since its Stop, and only its own work.
    const one = row(0);
    for (const k of CONTENT) expect(one[k], `turn 1 ${k} changed after its Stop`).toEqual(turn1AtStop[k]);
    expect(one.filesChanged).toEqual(['src/alpha.ts', 'src/gamma.ts']);
    expect(text(one)).toContain(T1_ALPHA);
    expect(text(one)).toContain(T1_GAMMA);
    expect([one.linesAdded, one.linesRemoved]).toEqual([2, 0]);
    for (const m of [T2_BETA_A, T2_BETA_B, T3_MARKER, T4_MARKER, PR_FILE]) expect(text(one)).not.toContain(m);

    // Turn 2: beta only — no restoration, no turn-1 lines.
    const two = row(1);
    for (const k of CONTENT) expect(two[k], `turn 2 ${k} changed after its Stop`).toEqual(turn2AtStop[k]);
    expect(two.filesChanged).toEqual(['src/beta.ts']);
    expect(text(two)).toContain(T2_BETA_B);
    for (const m of [T1_ALPHA, T1_GAMMA, T3_MARKER, T4_MARKER, 'src/gamma.ts', 'src/alpha.ts', PR_FILE]) {
      expect(text(two), `turn 2 carries ${m}`).not.toContain(m);
    }

    // Turn 3: the big file only, uncommitted.
    const three = row(2);
    expect(three.filesChanged).toEqual([T3_BIG]);
    expect(three.linesAdded).toBe(T3_LINES + 2);
    for (const m of [T1_ALPHA, T1_GAMMA, T2_BETA_A, T2_BETA_B, T4_MARKER, PR_FILE]) {
      expect(text(three), `turn 3 carries ${m}`).not.toContain(m);
    }

    // Turn 4: delta only — not the cumulative uncommitted tree.
    const four = row(3);
    expect(four.filesChanged).toEqual([T4_DELTA]);
    expect([four.linesAdded, four.linesRemoved]).toEqual([1, 0]);
    for (const m of [T1_ALPHA, T1_GAMMA, T2_BETA_B, T3_MARKER, PR_FILE]) {
      expect(text(four), `turn 4 carries ${m}`).not.toContain(m);
    }

    // turnIds are distinct and stable.
    expect(new Set(all.map((r) => r.turnId)).size).toBe(4);

    // ── Commits ──────────────────────────────────────────────────────────
    // Turn 1's first stamp — the one the server keeps — is its commit, and
    // turn 2's commit is the last word on turn 2. A reset-away WIP commit is
    // stamped on no turn but the one that made it.
    //
    // Not asserted: the heartbeat's in-flight row, when the prompt baseline is
    // a shadow commit (a dirty tree at submit), names the session's FIRST
    // commit whatever turn is open. Whether a tick lands in a turn is timing;
    // the server refuses that stamp (the commit is attested to turn 1).
    expect(stamps(0)[0], 'turn 1 is not stamped with its commit first').toBe(commitA);
    expect(stamps(1).at(-1), 'turn 2 does not end on its commit').toBe(commitB);
    for (const i of [1, 2, 3]) expect(stamps(i), `turn ${i + 1} stamped with the background WIP`).not.toContain(wipBackground);
    for (const i of [0, 2, 3]) expect(stamps(i), `turn ${i + 1} stamped with turn 2's WIP`).not.toContain(wipThrownAway);
    for (const i of [0, 2, 3]) expect(stamps(i), `turn ${i + 1} stamped with turn 2's commit`).not.toContain(commitB);

    // The attestation names the committing turn.
    const last = accepted().filter((h) => Array.isArray(h.body.commitTurns)).at(-1)!.body;
    const attested = new Map<string, string>((last.commitTurns as any[]).map((c) => [c.sha, c.turnId]));
    expect(attested.get(commitA)).toBe(one.turnId);
    expect(attested.get(commitB)).toBe(two.turnId);
    expect(attested.has(foreign)).toBe(false);

    // The session's commits are the two that shipped. The reset-away WIP
    // commits are sent as abandoned, so the server takes them off the session
    // (#1681) instead of badging them onto a turn.
    const snapshots = accepted().filter((h) => h.body.gitCapture?.snapshot);
    const final = snapshots.at(-1)!.body.gitCapture;
    expect(new Set(final.commitShas), 'the session header lists reset-away commits').toEqual(new Set([commitA, commitB]));
    expect(new Set(final.abandonedCommits || []), 'reset-away commits not sent as abandoned').toEqual(new Set([wipBackground, wipThrownAway]));

    // …and the session's DIFF says the same as its sha list: no line, file or
    // count from a reset-away commit. The sha list alone was already right
    // while the diff still carried them.
    const finalBody = snapshots.at(-1)!.body;
    const sessionDiff = String(final.diff || '');
    for (const m of [BG_ONLY, WIP2_ONLY]) expect(sessionDiff, `session diff carries ${m}`).not.toContain(m);
    for (const f of [BG_ONLY_FILE, WIP2_ONLY_FILE]) {
      expect(sessionDiff, `session diff names ${f}`).not.toContain(f);
      expect(finalBody.filesChanged || [], `session files name ${f}`).not.toContain(f);
    }
    expect(sessionDiff.length, 'the session diff was cut, counts cannot be checked against it').toBeLessThan(500_000);
    const signed = (sign: '+' | '-') => sessionDiff.split('\n')
      .filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).length;
    expect([final.linesAdded, final.linesRemoved], 'session counts are not the diff\'s').toEqual([signed('+'), signed('-')]);
    for (const t of all) {
      for (const m of [BG_ONLY, WIP2_ONLY]) expect(text(t), `turn ${t.promptIndex + 1} carries ${m}`).not.toContain(m);
    }

    // No rewrite pair invented from the reset-away WIP commits.
    const pairs = accepted().flatMap((h) => h.body.rewrittenCommits || h.body.gitCapture?.rewrittenCommits || []);
    for (const p of pairs) {
      expect([wipThrownAway, wipBackground], `false rewrite ${p.from} → ${p.to}`).not.toContain(p.from);
    }

    // Session-level commits: the session's own, never the foreign PR.
    for (const h of accepted()) {
      expect(h.body.gitCapture?.commitShas || [], 'the foreign PR is on the session').not.toContain(foreign);
      expect(h.body.gitCapture?.abandonedCommits || [], 'a shipped commit sent as abandoned').not.toContain(commitA);
      expect(h.body.gitCapture?.abandonedCommits || []).not.toContain(commitB);
    }

    // A queued snapshot never lands after a newer one.
    const capturedAt = (b: any) => Math.max(0, ...(b.promptChanges || []).map((r: any) => r.capturedAt || 0));
    const stop4At = capturedAt(accepted()[stop4Hit].body);
    for (const h of accepted().slice(stop4Hit + 1).filter((x) => x.body.gitCapture?.snapshot && Array.isArray(x.body.promptChanges))) {
      expect(capturedAt(h.body), 'an older snapshot replaced a newer one').toBeGreaterThanOrEqual(stop4At);
    }
  }, 300_000 * WINDOWS_SLOWDOWN);
});
