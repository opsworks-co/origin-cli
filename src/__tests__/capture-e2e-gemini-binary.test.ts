// END-TO-END: a Gemini CLI session through the BUILT binary and the REAL hook
// sequence, against a fake API.
//
// Gemini is the agent in this family whose SessionEnd is a real end. Cursor,
// Codex, Claude Code and Copilot hand SessionEnd to Stop
// (`agentsWithFakeSessionEnd`, commands/hooks/session-end.ts), so the
// session-end body — its ledger, shadow-window and commit-patch passes, and
// resolveTurn's side-by-side check beside them — ran in no capture-e2e
// scenario until this one. No golden recorded a Gemini session either.
//
// The hooks fire as `origin enable` installs them (geminiHookEvents in
// commands/enable.ts): SessionStart → session-start, BeforeAgent →
// user-prompt-submit, BeforeTool/AfterTool → pre/post-tool-use, AfterAgent →
// stop, SessionEnd → session-end. The transcript is the chats JSONL Gemini CLI
// writes: a header line, `$set` metadata lines, `user` rows, and `gemini` rows
// that carry `toolCalls`.
//
// Requires `dist/` (CI builds before it tests). Runs on native Windows too,
// like the harness it is modelled on (capture-e2e-real-binary.test.ts): see
// helpers/windows-e2e.ts for the audit that lifted the POSIX-only gate.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { expectGoldenTurns, trackTestFailures } from './helpers/golden-turns.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let server: http.Server;
let apiUrl = '';
const API_SESSION = 'e2e-gemini-session-0001';

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
// The agent's own session id. Its first 12 characters name the state file and
// the journal, so they must differ from every other capture-e2e session.
const SESSION_ID = 'gem-e2e-7c1d-4f2a-9b3e-5d6c8a0b1e2f';
const GEMINI_EVENT: Record<string, string> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'BeforeAgent',
  'pre-tool-use': 'BeforeTool',
  'post-tool-use': 'AfterTool',
  stop: 'AfterAgent',
  'session-end': 'SessionEnd',
};

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'gemini', event], {
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
    hook_event_name: GEMINI_EVENT[event],
    timestamp: new Date().toISOString(),
    ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

// ─── the transcript, as Gemini CLI writes it ────────────────────────────────

const lines: string[] = [];
let rowSeq = 0;
const iso = () => new Date().toISOString();
const flush = () => fs.writeFileSync(transcript, lines.join('\n') + '\n');
function append(row: Record<string, unknown>) {
  lines.push(JSON.stringify(row));
  lines.push(JSON.stringify({ $set: { lastUpdated: iso() } }));
  flush();
}
const TOKENS = { input: 1200, output: 80, cached: 0, thoughts: 0, tool: 0, total: 1280 };
function say(text: string) {
  append({ id: `u-${++rowSeq}`, timestamp: iso(), type: 'user', content: [{ text }] });
}
function reply(text: string) {
  append({ id: `g-${++rowSeq}`, timestamp: iso(), type: 'gemini', content: text, thoughts: [], tokens: TOKENS, model: 'gemini-2.5-pro' });
}
function toolCall(callId: string, name: string, args: Record<string, unknown>, output: string) {
  append({
    id: `g-${++rowSeq}`, timestamp: iso(), type: 'gemini', content: '', thoughts: [], tokens: TOKENS, model: 'gemini-2.5-pro',
    toolCalls: [{
      id: callId, name, args,
      result: [{ functionResponse: { id: callId, name, response: { output } } }],
      status: 'success', timestamp: iso(),
    }],
  });
}

async function agentWrites(callId: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const args = { file_path: abs, content };
  await run('pre-tool-use', { tool_name: 'write_file', tool_input: args, tool_call_id: callId });
  fs.writeFileSync(abs, content);
  toolCall(callId, 'write_file', args, `Successfully wrote to ${abs}`);
  await run('post-tool-use', { tool_name: 'write_file', tool_input: args, tool_call_id: callId, tool_response: { llmContent: `Successfully wrote to ${abs}` } });
}

async function agentReplaces(callId: string, file: string, oldString: string, newString: string) {
  const abs = path.join(repo, file);
  const args = { file_path: abs, old_string: oldString, new_string: newString, instruction: 'edit' };
  await run('pre-tool-use', { tool_name: 'replace', tool_input: args, tool_call_id: callId });
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf-8').replace(oldString, newString));
  toolCall(callId, 'replace', args, `Successfully modified file: ${abs}`);
  await run('post-tool-use', { tool_name: 'replace', tool_input: args, tool_call_id: callId, tool_response: { llmContent: `Successfully modified file: ${abs}` } });
}

// ─── harness plumbing ───────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A per-worker home is reused across files: this session's journal is the one
// that did not exist before it started.
let journalsBefore = new Set<string>();
const journalDir = () => path.join(os.homedir(), '.origin', 'journals');
function journalFiles(): { journal: string; lock: string } | null {
  if (!fs.existsSync(journalDir())) return null;
  const j = fs.readdirSync(journalDir()).find((f) => f.endsWith('.jsonl') && !journalsBefore.has(f));
  if (!j) return null;
  return { journal: path.join(journalDir(), j), lock: path.join(journalDir(), j.replace(/\.jsonl$/, '.lock')) };
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

const hooksLog = () => {
  try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; }
};
/** What the hooks decided, for a failure to explain itself: the scratch home is gone by report time. */
const why = () => hooksLog().split('\n')
  .filter((l) => /\[(session-end|stop|ledger)\]/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l))
  .slice(-40).map((l) => l.slice(0, 400)).join('\n');

const endRequests = () => hits.filter((h) => h.method === 'POST' && h.url.startsWith('/api/mcp/session/end'));
/**
 * The SessionEnd hook's own end, not whichever end came last. The heartbeat
 * posts a bare end of its own (sessionId, prompt, durationMs, the saved rows,
 * no editsJson) once the agent has looked dead for three 30s ticks. On a slow
 * runner that lands after the hook's, and the golden read its rows: every
 * turn's editedFiles came back empty. Only the hook sends the transcript.
 */
const hookEnd = () => endRequests().filter((h) => typeof h.body?.transcript === 'string').pop();

/** The origin-managed context file session-start writes is bookkeeping, not the session's work. */
const ownFiles = (row: any) => [...(row?.filesChanged || [])].filter((f: string) => f !== 'GEMINI.md').sort();

describe.skipIf(!haveDist)('a Gemini session end to end through the built binary', () => {
  const failures = trackTestFailures();
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-gemini-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    transcript = path.join(tmp, 'chats', `session-${SESSION_ID}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    lines.push(JSON.stringify({ sessionId: SESSION_ID, projectHash: 'e2e', startTime: iso(), lastUpdated: iso(), kind: 'main' }));
    lines.push(JSON.stringify({ $set: { lastUpdated: iso() } }));
    flush();

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['gemini'], orgId: 'org-e2e',
    }));
    journalsBefore = new Set(fs.existsSync(journalDir()) ? fs.readdirSync(journalDir()) : []);

    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('two turns and a real SessionEnd: the session ends over the API with both turns', async () => {
    const start = await run('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);
    expect(hits.some((h) => h.url.startsWith('/api/mcp/session/start')), 'no session/start reached the API').toBe(true);

    // Turn 1: a region replace and a whole-file write.
    say('make the greeting say hello');
    const ups1 = await run('user-prompt-submit', { prompt: 'make the greeting say hello' });
    expect(ups1.code, ups1.stderr).toBe(0);

    // The detached journal watcher must be recording before the agent writes,
    // or the ledger has nothing to answer with.
    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal to exist');
    const { journal } = journalFiles()!;
    const writesIn = () => fs.readFileSync(journal, 'utf-8').split('\n').filter((l) => l.startsWith('{"f"')).length;
    for (let i = 0; i < 400 && writesIn() === 0; i++) {
      fs.writeFileSync(path.join(repo, '.probe'), String(i));
      await sleep(25);
    }
    expect(writesIn(), 'the detached journal watcher recorded nothing — it is not running').toBeGreaterThan(0);
    await sleep(400);

    await agentReplaces('replace_1', 'app.py', 'print("old")', 'print("hello")');
    await agentWrites('write_file_1', 'README.md', '# demo\n\nSays hello.\n');
    reply('The greeting now says hello.');
    await waitFor(() => writesIn() >= 3, 10_000, 'the journal to record both writes');
    const stop1 = await run('stop', { prompt: 'make the greeting say hello', prompt_response: 'The greeting now says hello.' });
    expect(stop1.code, stop1.stderr).toBe(0);

    // Turn 2: a new file.
    say('leave a note about it');
    const ups2 = await run('user-prompt-submit', { prompt: 'leave a note about it' });
    expect(ups2.code, ups2.stderr).toBe(0);
    await sleep(400);
    await agentWrites('write_file_2', 'notes.md', 'remember the greeting\n');
    reply('Noted.');
    await waitFor(() => writesIn() >= 4, 10_000, 'the journal to record the note');
    const stop2 = await run('stop', { prompt: 'leave a note about it', prompt_response: 'Noted.' });
    expect(stop2.code, stop2.stderr).toBe(0);

    // Gemini's SessionEnd on exit ends the session: the real session-end body.
    const end = await run('session-end', { reason: 'exit' });
    expect(end.code, end.stderr).toBe(0);
    expect(hooksLog(), 'SessionEnd was handed to Stop — this scenario must reach the session-end body').not.toMatch(/fake sessionEnd/);

    expect(endRequests().length, `no session/end reached the API\n${why()}`).toBeGreaterThan(0);
    const ended = hookEnd();
    expect(ended, `no session/end from the SessionEnd hook\n${why()}`).toBeDefined();
    const rows: any[] = ended!.body?.promptChanges || [];
    const turn = (i: number) => rows.find((r) => r.promptIndex === i);
    expect(ownFiles(turn(0)), `turn 1 at session end\n${why()}`).toEqual(['README.md', 'app.py']);
    expect(turn(0).diff).toContain('+    print("hello")');
    expect(turn(0).diff).toContain('+Says hello.');
    expect(ownFiles(turn(1)), `turn 2 at session end\n${why()}`).toEqual(['notes.md']);
    expect(turn(1).diff).toContain('+remember the greeting');

    // The point of this scenario: session-end ran the passes, and resolveTurn
    // beside them, and the two agree.
    const summaries = hooksLog().split('\n')
      .map((l) => /\[session-end\] resolver side by side (\{.*\})\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => JSON.parse(m[1]));
    expect(summaries.length, `session-end logged no resolver summary\n${why()}`).toBeGreaterThan(0);
    const last = summaries[summaries.length - 1];
    expect(last.differ, `the resolver disagreed with the passes at session end\n${why()}`).toBe(0);
    expect(last.agree + last.unavailable).toBeGreaterThanOrEqual(2);
  }, 180_000 * WINDOWS_SLOWDOWN);

  it('golden: the turn rows the session ended with match the recorded baseline', () => {
    const rows: any[] = hookEnd()?.body?.promptChanges || [];
    expectGoldenTurns('gemini-binary', rows, {
      repo, roots: [tmp], sent: hits.flatMap((h) => (Array.isArray(h.body?.promptChanges) ? h.body.promptChanges : [])),
      failedBefore: failures(), requests: hits, sessionId: API_SESSION,
    });
  });
});
