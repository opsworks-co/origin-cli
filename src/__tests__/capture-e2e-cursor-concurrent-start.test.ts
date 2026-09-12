// END-TO-END, Cursor, the BUILT binary: session-start and the chat's first
// prompt fire CONCURRENTLY and the chat must still be ONE session.
//
// Prod 2026-09-09, conversation da82f522. Cursor fired sessionStart on the
// main checkout under the composer id (f9213cfd) and, 3.4s later, the first
// prompt from the linked worktree under the real conversation id — while
// session-start's `session/start` was still in flight:
//
//   02:19:05.140  [session-start]        reserved state before registering  local-82aaa929
//   02:19:05.140  [session-start]        calling api.startSession
//   02:19:05.969  [session-start]        api returned 5431ff0f
//   02:19:07.5    [session-start]        state saved 5431ff0f
//   02:19:08.084  [user-prompt-submit]   agent-filtered match  local-82aaa929  ← read before the save
//   02:19:08.115  [user-prompt-submit]   adopting empty worktree-bootstrap session
//   02:19:08.147  [user-prompt-submit]   migrating local session to server
//   02:19:08.425  [user-prompt-submit]   local session migrated → e24477e2   ← the twin
//
// Two rows for eleven minutes: 5431ff0f (composer id, a heartbeat feeding it
// the shared state file) and e24477e2 (the real chat). Three things had to
// change: a pending reservation is never registered by its adopter, a stale
// reservation write re-reads the file and takes the registered id, and
// session-start's final save folds the adopter's turn and identity in
// instead of overwriting them.
//
// The fake API delays `session/start` so the prompt hook lands inside the
// registration window every time. Two delays, because the two orderings
// exercise different halves: a long delay makes the prompt hook save FIRST
// (session-start merges); a short one makes session-start save first (the
// prompt hook's save adopts the registered id). Both must end the same way.
//
// Requires `dist/`. POSIX-only, like the other harnesses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN, isWindows } from './helpers/windows-e2e.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';
let sessionsMinted = 0;
let startDelayMs = 0;

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
          sessionsMinted += 1;
          const id = `e2e-race-000${sessionsMinted}`;
          setTimeout(() => res.end(JSON.stringify({ sessionId: id, verboseCapture: false })), startDelayMs);
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

let tmp = '';
let turn = 0;

/** One hook, Cursor's way: its verbatim key set on stdin, `session_id` rotating per turn. */
function run(
  event: string,
  opts: { cwd: string; roots: string[]; conversation: string; transcript: string; payload?: Record<string, unknown> },
): Promise<{ code: number | null; stderr: string }> {
  turn += 1;
  const child = spawn(process.execPath, [BIN, 'hooks', 'cursor', event], {
    cwd: opts.cwd,
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* not asserted */ });
  child.stdin.end(JSON.stringify({
    conversation_id: opts.conversation,
    generation_id: `gen-${turn}`,
    model: 'cursor-e2e-model',
    model_id: 'e2e-model',
    is_background_agent: false,
    composer_mode: 'agent',
    session_id: `e2e-cursor-turn-${turn}`,
    hook_event_name: event,
    cursor_version: '2.6.0',
    workspace_roots: opts.roots,
    cwd: opts.cwd,
    transcript_path: opts.transcript,
    ...(opts.payload || {}),
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'E2E']);
  git(dir, ['config', 'user.email', 'e2e@example.com']);
  fs.writeFileSync(path.join(dir, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
}

function transcriptFor(conversation: string): string {
  const tdir = path.join(tmp, 'agent-transcripts', conversation);
  fs.mkdirSync(tdir, { recursive: true });
  const p = path.join(tdir, `${conversation}.jsonl`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  return p;
}
function say(transcript: string, text: string): void {
  fs.appendFileSync(transcript, JSON.stringify({ role: 'user', content: text }) + '\n');
}

const startHits = () => hits.filter((h) => h.method === 'POST' && h.url.startsWith('/api/mcp/session/start'));
const patchesTo = (sessionId: string) => hits.filter((h) => h.method === 'PATCH' && h.url === `/api/mcp/session/${sessionId}`);
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };
const readState = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const pidFileFor = (sessionId: string) => path.join(os.homedir(), '.origin', 'heartbeats', `${sessionId}.pid`);

function killPidFile(file: string): void {
  try {
    const pid = Number(fs.readFileSync(file, 'utf-8').trim());
    if (pid > 0) process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}
function killDaemons(): void {
  for (const dir of ['heartbeats', 'journals']) {
    const d = path.join(os.homedir(), '.origin', dir);
    let entries: string[] = [];
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const f of entries) if (f.endsWith('.pid') || f.endsWith('.lock')) killPidFile(path.join(d, f));
  }
}

/**
 * The prod shape: sessionStart on the main checkout under a composer id, the
 * first prompt from a linked worktree under the real conversation id, the
 * prompt hook launched as soon as the reservation is on disk — i.e. while
 * `session/start` is in flight.
 */
async function raceOneChat(label: string, delayMs: number): Promise<{ sessionId: string; stateFile: string; wt: string; conv: string; transcript: string; logFrom: number }> {
  const COMPOSER = `c0c0c0c0-${label}-4000-8000-000000000001`;
  const CONV = `e2e2e2e2-${label}-4000-8000-000000000002`;
  const main = path.join(tmp, `repo-${label}`);
  initRepo(main);
  const wt = path.join(tmp, `repo-${label}-wt`);
  git(main, ['worktree', 'add', '-q', '-b', `feat/race-${label}`, wt]);
  const transcript = transcriptFor(CONV);
  const stateFile = path.join(main, '.git', `origin-session-${COMPOSER.slice(0, 12)}.json`);
  const startsBefore = startHits().length;
  const logFrom = hooksLog().length;
  startDelayMs = delayMs;

  const startP = run('session-start', {
    cwd: main, roots: [main], conversation: COMPOSER, transcript: transcriptFor(COMPOSER), payload: { source: 'startup' },
  });
  await waitFor(
    () => hooksLog().slice(logFrom).includes(`"sessionId":"local-`) && hooksLog().slice(logFrom).includes(`"sessionTag":"${COMPOSER.slice(0, 12)}"`),
    20_000,
    'session-start to publish its reservation',
  );
  say(transcript, 'hello from the worktree');
  const upsP = run('user-prompt-submit', {
    cwd: wt, roots: [wt], conversation: CONV, transcript, payload: { prompt: 'hello from the worktree' },
  });
  const [start, ups] = await Promise.all([startP, upsP]);
  expect(start.code, start.stderr).toBe(0);
  expect(ups.code, ups.stderr).toBe(0);

  // THE INVARIANT: one chat, one `session/start`.
  const starts = startHits().slice(startsBefore);
  expect(starts.length, `a second /session/start means a twin\n${hooksLog().slice(logFrom).split('\n').filter((l) => /session-start\]|user-prompt-submit\]|session-state\]/.test(l) && !/HOOK|stdin|context injected|rules file/.test(l)).map((l) => l.slice(0, 220)).join('\n')}`).toBe(1);
  expect(starts[0].body.agentSessionId, 'the handshake registers under the composer id').toBe(COMPOSER);
  const sessionId = `e2e-race-000${sessionsMinted}`;

  // One state file, on the registered id, holding the worktree prompt and identity.
  const st = readState(stateFile);
  expect(st.sessionId).toBe(sessionId);
  expect(st.pendingRegistration).toBeUndefined();
  expect(st.prompts, 'the prompt filed against the reservation must survive').toEqual(['hello from the worktree']);
  expect(st.agentSessionId, 'the row is the chat, not the handshake').toBe(CONV);
  expect(fs.realpathSync.native(st.repoPath)).toBe(fs.realpathSync.native(wt));
  expect(st.branch).toBe(`feat/race-${label}`);
  expect(st.headShaAtStart, 'moved onto the worktree, it needs a baseline there — not main\'s').toBeTruthy();
  const log = hooksLog().slice(logFrom);
  expect(log).toContain('adopting empty worktree-bootstrap session');
  expect(log, 'the adopter must never register the reservation itself').not.toContain('local session migrated');

  // The server row learns the chat's id and branch.
  await waitFor(
    () => patchesTo(sessionId).some((h) => h.body?.agentSessionId === CONV) && patchesTo(sessionId).some((h) => h.body?.branch === `feat/race-${label}`),
    10_000,
    `a PATCH carrying agentSessionId ${CONV} and the worktree branch to ${sessionId}`,
  );
  return { sessionId, stateFile, wt, conv: CONV, transcript, logFrom };
}

// HELD BACK from the Windows sweep — the one file of the 15 that did not earn
// its place. Windows record: pass, pass, FAIL across three runs, against 13
// files that passed all three. macOS: 4 for 4.
//
//   AssertionError: the prompt filed against the reservation must survive:
//     expected [] to deeply equal [ 'hello from the worktree' ]
//
// That is a LOST PROMPT, not a mis-sorted one, in exactly the scenario this
// file is named for — so it may be a real Windows capture defect rather than a
// flaky test, and #1568 tracks tracing the reservation fold before anyone
// assumes the test is at fault. Enabling it now would put a rotating red on
// the Windows leg for every other PR, which is the opposite of what lifting
// these skips is for.
//
// This is a deliberate, evidenced, single-file exception with an owner — not
// the blanket `!posix` that helpers/windows-e2e.ts exists to complain about.
describe.skipIf(!haveDist || isWindows)('cursor: session-start and the first prompt race, one session (built binary)', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-cursor-race-')));
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['cursor'], orgId: 'org-e2e',
    }));
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      console.log('--- hooks.log ---\n' + hooksLog().split('\n').filter((l) => /user-prompt-submit\]|session-start\]|session-state\]|findStateForHook|heartbeat\]|stop\]/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l)).map((l) => l.slice(0, 500)).join('\n'));
      console.log('--- hits ---\n' + hits.map((h) => `${h.method} ${h.url} ${JSON.stringify(h.body).slice(0, 200)}`).join('\n'));
    }
    killDaemons();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('slow registration: the prompt hook saves first and session-start folds its turn in', async () => {
    const r = await raceOneChat('aaaa', 2_000);
    // Whichever side saved last, the merge left one heartbeat, on the registered id.
    await waitFor(() => fs.existsSync(pidFileFor(r.sessionId)), 10_000, 'the heartbeat daemon on the registered id');
    const daemons = fs.readdirSync(path.join(os.homedir(), '.origin', 'heartbeats')).filter((f) => f.endsWith('.pid'));
    expect(daemons.filter((f) => f.startsWith('local-')), 'no daemon may stay on the placeholder').toEqual([]);

    // The turn closes on the same row.
    const stop = await run('stop', { cwd: r.wt, roots: [r.wt], conversation: r.conv, transcript: r.transcript, payload: { status: 'completed' } });
    expect(stop.code, stop.stderr).toBe(0);
    expect(startHits().length).toBe(1);
    const rows = patchesTo(r.sessionId).filter((h) => Array.isArray(h.body?.promptChanges)).map((h) => h.body.promptChanges);
    expect(rows.length, 'Stop must land its capture on the registered row').toBeGreaterThan(0);
    expect(rows[rows.length - 1].map((x: any) => x.promptIndex)).toEqual([0]);
    expect(readState(r.stateFile).sessionId).toBe(r.sessionId);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('fast registration: session-start saves first and the prompt hook\'s stale write adopts its id', async () => {
    const r = await raceOneChat('bbbb', 150);
    expect(startHits().length).toBe(2);
    await waitFor(() => fs.existsSync(pidFileFor(r.sessionId)), 10_000, 'the heartbeat daemon on the registered id');
    const stop = await run('stop', { cwd: r.wt, roots: [r.wt], conversation: r.conv, transcript: r.transcript, payload: { status: 'completed' } });
    expect(stop.code, stop.stderr).toBe(0);
    expect(startHits().length).toBe(2);
    expect(readState(r.stateFile).sessionId).toBe(r.sessionId);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
