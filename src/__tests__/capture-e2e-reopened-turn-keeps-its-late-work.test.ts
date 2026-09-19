// END-TO-END: a turn that goes on after its Stop keeps the work it did then.
//
// Stop closes a turn that changed nothing and saves its row blank + chatOnly.
// A background task then re-invokes the agent (no new prompt), it writes a file
// through the shell, and the user types the next prompt before another Stop
// fires. The submit hook re-captures the previous turn — and used to keep the
// blank, because `previousMappingKept` answered 'chat-only' without asking
// whether the turn had been re-opened since that Stop. The late write never
// reached any row (found by the independent review of #1713, which reproduced
// it through the built binary; it was the same on main before #1713).
//
// Drives the built binary: Stop (workless) → tool hooks around a shell write →
// next prompt with NO Stop in between → the turn's row must carry the file.
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
// ORIGIN_E2E_BIN runs the same scenario through another build — the installed
// release, to watch this test fail without the fix.
const BIN = process.env.ORIGIN_E2E_BIN || path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SESSION_ID = 'e2e-reopened-session-5521';
const SERVER_SESSION = 'e2e-reopened-0001';

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
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
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        hits.push({ method: req.method || '', url: req.url || '', body });
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
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
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

function append(entry: Record<string, unknown>) {
  lines.push(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
const say = (text: string) => append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const reply = (text: string) => append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
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

function stateFile(): string {
  const dir = path.join(repo, '.git');
  const f = fs.readdirSync(dir).filter((n) => n.startsWith('origin-session-') && n.endsWith('.json'))
    .map((n) => path.join(dir, n))
    .find((p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')).sessionId === SERVER_SESSION; } catch { return false; } });
  if (!f) throw new Error('no state file for the session');
  return f;
}

/** The row for `promptIndex` in the newest Stop PATCH. */
function lastSentRow(promptIndex: number): any {
  const patches = hits.filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${SERVER_SESSION}`)
    && Array.isArray(h.body?.promptChanges) && h.body.promptChanges.some((p: any) => p.promptIndex === promptIndex));
  return patches.at(-1)?.body.promptChanges.find((p: any) => p.promptIndex === promptIndex);
}

describe.skipIf(!haveDist)('a turn re-opened after its Stop, through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-reopened-')));
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
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n\n\nmain()\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) console.log(hooksLog().split('\n').filter((l) => /user-prompt-submit|\[stop\]|post-tool-use|pre-tool-use|ledger|journal/.test(l) && !/HOOK (INVOKED|COMPLETE)|\[stdin\]/.test(l)).map((l) => l.slice(0, 400)).join('\n'));
    await killJournalWatcher();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the next prompt recovers the late shell write instead of keeping Stop\'s blank', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);

    // Turn 1: a question. Its Stop finds nothing and saves the row chat-only.
    say('anything in the logs?');
    expect((await run('user-prompt-submit', { prompt: 'anything in the logs?' })).code).toBe(0);
    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal to exist');
    reply('Nothing unusual.');
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);
    const savedBlank = JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).completedPromptMappings.find((m: any) => m.promptIndex === 0);
    expect(savedBlank?.chatOnly, 'precondition: Stop saved turn 1 as chat-only').toBe(true);
    expect(savedBlank?.filesChanged || []).toEqual([]);

    // The turn goes on with no new prompt (a background task re-invoked the
    // agent): tool hooks fire around a shell write.
    const cmd = { command: "printf 'print(\"late\")\\n' >> app.py" };
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: cmd, tool_use_id: 'tu-late' });
    fs.appendFileSync(path.join(repo, 'app.py'), 'print("late")\n');
    toolUse('tu-late', 'Bash', cmd);
    await run('post-tool-use', { tool_name: 'Bash', tool_input: cmd, tool_use_id: 'tu-late', tool_response: { stdout: '', stderr: '', interrupted: false } });
    // Meanwhile something ELSE writes into the tree — no tool call, no command
    // naming it. The recovery must not bill the turn for it.
    fs.writeFileSync(path.join(repo, 'stranger.txt'), 'not the agent\n');

    // The user types the next prompt BEFORE any Stop.
    say('ok, now rename main');
    const beforeSubmit = hits.length;
    expect((await run('user-prompt-submit', { prompt: 'ok, now rename main' })).code).toBe(0);

    expect(hooksLog()).not.toMatch(/kept existing previous-prompt mapping \(chat-only\) \{"promptIndex":0/);
    expect(hooksLog()).toMatch(/chat-only turn re-opened since its Stop \{"promptIndex":0,"wrote":\["app\.py"\],"withoutRecord":1/);
    const recovered = JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).completedPromptMappings.find((m: any) => m.promptIndex === 0);
    expect(recovered?.filesChanged, 'the late write never reached turn 1\'s saved row').toContain('app.py');
    expect(recovered?.filesChanged, 'a file with no write record rode along').not.toContain('stranger.txt');
    expect(String(recovered?.diff || '') + String(recovered?.uncommittedDiff || '')).not.toContain('stranger.txt');
    expect(String(recovered?.diff || '') + String(recovered?.uncommittedDiff || '')).toContain('late');

    // …and it reaches the server: from the submit's own send, or the Stop after.
    reply('Renamed.');
    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);
    const sent = hits.slice(beforeSubmit)
      .filter((h) => h.method === 'PATCH' && Array.isArray(h.body?.promptChanges))
      .map((h) => h.body.promptChanges.find((p: any) => p.promptIndex === 0)).filter(Boolean);
    expect(sent.length, 'turn 1 was never re-sent after the late write').toBeGreaterThan(0);
    expect(sent.at(-1).filesChanged, 'the last row sent for turn 1 lost the late write').toContain('app.py');
    // (Not asserted: whether that Stop also bills `stranger.txt`. Its
    // turn-window pass takes everything that changed between the turn's two
    // shadows, and in a solo checkout a hook-less writer is indistinguishable
    // from the agent. That is Stop's model, not this rule's.)

    // ── Re-opening alone is not enough ────────────────────────────────────
    // Turn 2's Stop just ran and found nothing of its own. The agent is
    // re-invoked and runs a write-shaped command that touches NOTHING in the
    // repo; a stranger writes a file; the next prompt arrives before a Stop.
    //
    // A write-shaped command, not a Read: a Read sets activeTurn in memory and
    // saves nothing, so the state on disk stays closed and the old
    // not-re-opened branch keeps the blank — on main too, which made an
    // earlier version of this scenario pass with the rule deleted (review of
    // #1726). The shell-write note IS saved, and with it the re-open.
    const turn2 = JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).completedPromptMappings.find((m: any) => m.promptIndex === 1);
    expect(turn2?.chatOnly, 'precondition: Stop saved turn 2 as chat-only').toBe(true);
    const outside = path.join(tmp, 'scratch-outside-the-repo');
    const noop = { command: `mkdir -p ${outside}` };
    await run('pre-tool-use', { tool_name: 'Bash', tool_input: noop, tool_use_id: 'tu-noop' });
    fs.mkdirSync(outside, { recursive: true });
    toolUse('tu-noop', 'Bash', noop);
    await run('post-tool-use', { tool_name: 'Bash', tool_input: noop, tool_use_id: 'tu-noop', tool_response: { stdout: '', stderr: '', interrupted: false } });
    fs.writeFileSync(path.join(repo, 'stranger2.txt'), 'still not the agent\n');
    say('and the third thing');
    expect((await run('user-prompt-submit', { prompt: 'and the third thing' })).code).toBe(0);
    // The NEW rule answered: the turn WAS re-opened, and had no record.
    expect(hooksLog()).toMatch(/chat-only turn re-opened since its Stop \{"promptIndex":1,"wrote":\[\],"withoutRecord":[1-9]/);
    const kept = JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).completedPromptMappings.find((m: any) => m.promptIndex === 1);
    expect(kept?.filesChanged || [], 'a turn with no write record was billed for a stranger\'s write').toEqual([]);
    expect(kept?.chatOnly).toBe(true);
  }, 240_000 * WINDOWS_SLOWDOWN);
});
