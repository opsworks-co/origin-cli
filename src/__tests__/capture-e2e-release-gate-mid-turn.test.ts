// END-TO-END: the release gate, run from inside the turn that just committed.
//
// `scripts/release-cli.sh` puts `origin verify-capture --fail-on-contradiction`
// between the version bump and the tag. An agent runs that script from inside
// its own turn, and typically in the SAME turn it just committed in — "merge it
// and release" is one turn, not two. At that moment post-commit has already SET
// the session header (`applyAuthoredTotals`, the instant `git commit` ran)
// while the row for the turn that ran it is appended by Stop, at the END of the
// turn. So the header carries work no turn carries yet, and both header rules
// read that as work no turn saw.
//
// The gate then failed on the releasing session itself, and the way past it was
// `--allow-contradictions` — which does not silence that one session, it
// silences the check for every OTHER session in the range. The check exists to
// be read before a tag; a check that always fails is one nobody reads.
//
// Crafted state files cannot show this: the question is whether the REAL hooks
// leave a session in that shape, so this drives the built binary through
// session-start → prompt → write → commit → post-commit, and runs the gate
// before Stop, the way the script would.
//
// Requires `dist/` (locally: `pnpm --filter @origin/cli run build`).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

// Runs on Windows: see helpers/windows-e2e.ts for what was audited before
// the capture-e2e skip was lifted, and why the timeouts are scaled there.

const SESSION_ID = 'e2e-gate-session-5678';
let server: http.Server;
let apiUrl = '';
let repo = '';
let transcript = '';
const lines: string[] = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: 'e2e-gate-0001', verboseCapture: false }));
        } else if (u.startsWith('/api/pricing')) {
          res.end(JSON.stringify({ models: {} }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

/** One agent hook, payload on stdin, exactly as Claude Code runs it. */
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
    session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

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

// ── Failure legibility ──────────────────────────────────────────────────
//
// This helper used to turn an unparseable stdout into `totals = {}`, which the
// assertions below then read as `undefined` — indistinguishable from a gate
// that ran fine and graded nothing. The sibling test
// (`release-gate-windows-on-turns.test.ts`) wore exactly that and it cost two
// separate misdiagnoses of the native-Windows job on 2026-09-11: a missing
// %USERPROFILE% (#1533) and the postAction update-check banner appended to
// STDOUT after the JSON (#1544). Neither says anything about itself through an
// empty object.
//
// So parsing is separated from running, and a stdout that is not JSON names
// itself — with the exit code, the command's own stderr, and both ends of what
// it actually wrote. The exit code stays an ASSERTION here rather than a
// throw: `--json --fail-on-contradiction` prints its JSON and only then sets
// exitCode, and "the gate failed on the session running it" is the defect this
// test exists to catch.

interface GateRun { code: number | null; out: string; err: string }

/** `origin verify-capture --fail-on-contradiction`, as release-cli.sh runs it. */
function releaseGate(): Promise<GateRun> {
  const child = spawn(process.execPath, [BIN, 'verify-capture', '--json', '--fail-on-contradiction'], {
    cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  // Drained, not just piped: an unread stderr can fill its buffer and stall the
  // child, and it is the only place a diagnostic from the command itself lands.
  child.stderr.on('data', (c) => { err += c; });
  child.on('error', (e) => { err += `\nspawn error: ${e.message}`; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

/** What the command was and what it said — quoted into every failure below. */
function context(run: GateRun): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length} bytes total)` : s || '(empty)');
  return [
    `  command: ${process.execPath} ${BIN} verify-capture --json --fail-on-contradiction`,
    `  cwd:     ${repo}`,
    `  exit:    ${run.code}`,
    `  stderr:  ${clip(run.err.trim(), 2000)}`,
    `  stdout:  ${clip(run.out, 500)}`,
  ].join('\n');
}

/**
 * The gate's totals, or a failure that says stdout was not JSON. Never
 * substitutes an empty object for "the command did not answer".
 */
function totals(run: GateRun): Record<string, number> {
  let parsed: { totals?: Record<string, number> | null };
  try {
    parsed = JSON.parse(run.out) as { totals?: Record<string, number> | null };
  } catch (e: unknown) {
    const why = e instanceof Error ? e.message : String(e);
    // Pollution is appended, so the tail is where the cause usually is — a
    // trailing banner, a warning, a progress line. Quote both ends.
    const tail = run.out.length > 500 ? `\n  stdout tail: ${JSON.stringify(run.out.slice(-300))}` : '';
    throw new Error(
      `verify-capture --json wrote stdout that is not JSON: ${why}\n`
      + 'Something on this path appended to stdout, which is the command\'s machine-readable output.\n'
      + `${context(run)}${tail}`,
    );
  }
  if (!parsed.totals) {
    throw new Error(`verify-capture --json returned no totals block.\n${context(run)}`);
  }
  return parsed.totals;
}

const git = (args: string[], cwd = repo): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

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
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

/** The session's own state file — what the gate reads. */
function state(): Record<string, any> {
  const dir = path.join(repo, '.git');
  const f = fs.readdirSync(dir).find((n) => n.startsWith('origin-session') && n.endsWith('.json'));
  if (!f) throw new Error('no session state file');
  return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The detached journal watcher would outlive the test by its idle window. */
async function killJournalWatcher(): Promise<void> {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  let lock: string | undefined;
  try {
    const j = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl') && f.startsWith(SESSION_ID.slice(0, 12)));
    if (j) lock = path.join(dir, j.replace(/\.jsonl$/, '.lock'));
  } catch { return; }
  if (!lock) return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(lock, 'utf-8').trim());
      if (pid > 0) { process.kill(pid, 'SIGTERM'); return; }
    } catch { /* no lock yet */ }
    await sleep(250);
  }
}

describe.skipIf(!haveDist)('the release gate on the session running it', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gate-e2e-')));
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
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('does not fail on the turn that just committed, and fails again once Stop lands', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    // Turn 0: a write, closed by Stop. This is the row the gate can check.
    say('add a module');
    expect((await run('user-prompt-submit', { prompt: 'add a module' })).code).toBe(0);
    await agentWrites('tu-1', 'src/mod.ts', 'export const a = 1;\n');
    expect((await run('stop', {})).code).toBe(0);

    // Turn 1: the release turn — write, commit, and the gate, all before Stop.
    say('ship it');
    expect((await run('user-prompt-submit', { prompt: 'ship it' })).code).toBe(0);
    await agentWrites('tu-2', 'src/ship.ts', Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');

    const cmd = 'git add -A && git commit -q -m "ship"';
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'tu-3' });
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'ship']);
    expect((await gitHook('git-post-commit')).code).toBe(0);
    toolUse('tu-3', 'Bash', { command: cmd });
    await run('post-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'tu-3', tool_response: { stdout: '', stderr: '' } });

    // THE RELEASE MOMENT. The state the real hooks left: a turn open, and a
    // header post-commit already wrote for work whose row Stop has not
    // appended. If this precondition ever stops holding, the assertions below
    // would pass for the wrong reason.
    const mid = state();
    expect(mid.activeTurn?.index, 'turn 1 should still be open').toBe(1);
    expect(mid.status).not.toBe('ENDED');
    expect(mid.linesAdded, 'post-commit should have written the header').toBeGreaterThan(0);
    const rows = mid.completedPromptMappings || [];
    expect(rows.map((r: any) => r.promptIndex), 'only turn 0 has a row yet').toEqual([0]);
    const inRows = rows.reduce((n: number, r: any) => n + (r.linesAdded || 0), 0);
    expect(mid.linesAdded, 'the header must exceed the rows — the defect this fixes')
      .toBeGreaterThan(inRows);

    const gate = await releaseGate();
    expect(gate.code, `the gate must not fail on the session running it\n${context(gate)}`).toBe(0);
    const mids = totals(gate);
    expect(mids.sessionsHeaderNotChecked, `and must say it held the header back\n${context(gate)}`).toBe(1);
    expect(mids.sessionsWithHeaderContradiction, context(gate)).toBe(0);

    // Stop writes turn 1's row. The header is comparable again from here, and
    // a session that is genuinely inconsistent is caught exactly as before.
    expect((await run('stop', {})).code).toBe(0);
    const after = state();
    expect(after.activeTurn ?? null, 'Stop closes the turn').toBeNull();
    expect((after.completedPromptMappings || []).map((r: any) => r.promptIndex)).toEqual([0, 1]);
    const graded = await releaseGate();
    expect(totals(graded).sessionsHeaderNotChecked,
      `nothing is held back once the turn closes\n${context(graded)}`).toBe(0);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
