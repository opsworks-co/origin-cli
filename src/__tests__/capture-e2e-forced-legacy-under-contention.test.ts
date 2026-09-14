// END-TO-END: the LEGACY reconstruction, forced the way production forces it.
//
// capture-e2e-chat-only-turn-claims-session-files used to pin the legacy
// path's defect — a row naming a file it cannot show — by killing the journal
// watcher. #1585's complete-window capture (`diffSource: 'turn-window'`) now
// answers those turns, so the file's assertions hold by construction and its
// own COVERAGE NOTE says the legacy path is no longer exercised (TODO
// 452a8cca).
//
// This forces it without touching Origin's state: a second live session in the
// SAME working tree. user-prompt-submit records the peer
// (`noteCheckoutContention` → `contendingSessionIds`), which makes
// preferShadowRangeForTurns stand down, and the ledger declines with "another
// live session shares this working tree". Nothing else can own the turn, so
// the legacy reconstruction produces the row — exactly what a shared checkout
// does in production.
//
// Asserted: the row really is legacy (no diffSource), it names no file it
// cannot show, and an over-budget legacy diff is cut at file boundaries and
// declares what did not fit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { verifyTurn } from '../capture-verify.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { foldStopRows } from './helpers/fold-stop-rows.js';
import { expectGoldenTurns, trackTestFailures } from './helpers/golden-turns.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SIBLING_API = 'cccccccc-5555-4555-8555-cccccccccccc';
const WORK_API = 'dddddddd-6666-4666-8666-dddddddddddd';
const SIBLING_CONV = 'e2e-legacy-sibling-conv-0001';
const WORK_CONV = 'e2e-legacy-work-conv-0002';

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
          res.end(JSON.stringify({ sessionId: starts === 1 ? SIBLING_API : WORK_API, verboseCapture: false }));
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
const transcripts: Record<string, string> = {};
const lines: Record<string, string[]> = { [SIBLING_CONV]: [], [WORK_CONV]: [] };

function run(conv: string, event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({ session_id: conv, transcript_path: transcripts[conv], cwd: repo, hook_event_name: event, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function say(conv: string, text: string) {
  lines[conv].push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
function toolUse(conv: string, id: string, name: string, input: Record<string, unknown>) {
  lines[conv].push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines[conv].push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
function assistantSays(conv: string, text: string) {
  lines[conv].push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
async function agentWrites(conv: string, id: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  await run(conv, 'pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(conv, id, 'Write', input);
  await run(conv, 'post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

/** The state file of one session, found by its server id. */
function stateOf(serverId: string): Record<string, any> {
  const dir = path.join(repo, '.git');
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('origin-session') && n.endsWith('.json'))) {
    const st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    if (st.sessionId === serverId) return st;
  }
  throw new Error(`no state file for ${serverId}`);
}

const workPayloads = () => hits
  .filter((h) => h.method === 'PATCH' && h.url.includes(WORK_API) && Array.isArray(h.body?.promptChanges))
  .map((h) => h.body.promptChanges);
const workRows = (): any[] => foldStopRows(workPayloads());
const diffFiles = (diff: string | null | undefined): string[] =>
  [...String(diff || '').matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);

/** Journal watchers and heartbeat daemons of BOTH sessions, by their own pid files. */
async function killDaemons(): Promise<void> {
  const pidFiles: string[] = [];
  for (const sub of ['journals', 'heartbeats']) {
    const dir = path.join(os.homedir(), '.origin', sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.lock') || n.endsWith('.pid'))) pidFiles.push(path.join(dir, f));
  }
  for (const f of pidFiles) {
    try { const pid = Number(fs.readFileSync(f, 'utf-8').trim()); if (pid > 0) process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  await sleep(300);
}

describe.skipIf(!haveDist)('a shared checkout forces the legacy reconstruction', () => {
  const failures = trackTestFailures();

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-legacy-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    for (const c of [SIBLING_CONV, WORK_CONV]) { transcripts[c] = path.join(tmp, `${c}.jsonl`); fs.writeFileSync(transcripts[c], ''); }
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e-legacy', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e' }));
    git(['init', '-q']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killDaemons();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a live sibling in the same tree leaves the turn to the legacy path, which names only what it shows', async () => {
    // The sibling: a chat parked in the same checkout, still live.
    expect((await run(SIBLING_CONV, 'session-start', { source: 'startup' })).code).toBe(0);
    say(SIBLING_CONV, 'what does this repo do?');
    expect((await run(SIBLING_CONV, 'user-prompt-submit', { prompt: 'what does this repo do?' })).code).toBe(0);
    assistantSays(SIBLING_CONV, 'It is a demo.');
    expect((await run(SIBLING_CONV, 'stop', { stop_hook_active: false })).code).toBe(0);

    // The working session, in the same tree.
    expect((await run(WORK_CONV, 'session-start', { source: 'startup' })).code).toBe(0);
    say(WORK_CONV, 'add a module');
    expect((await run(WORK_CONV, 'user-prompt-submit', { prompt: 'add a module' })).code).toBe(0);
    await agentWrites(WORK_CONV, 'tu-1', 'src/mod.ts', 'export const answer = 42;\nexport const also = true;\n');
    expect((await run(WORK_CONV, 'stop', { stop_hook_active: false })).code).toBe(0);

    // PRECONDITIONS: contention was recorded and the ledger stood down. Without
    // these the assertions below could pass on a ledger or window row.
    expect(stateOf(WORK_API).contendingSessionIds || [], 'the sibling was not recorded as contending').toContain(SIBLING_API);
    expect(hooksLog()).toContain('ledger declined: another live session shares this working tree');

    const t0 = workRows().find((r) => r.promptIndex === 0);
    expect(t0, 'no row for the working turn').toBeTruthy();
    expect(t0.diffSource, 'the row must come from the legacy reconstruction').toBeUndefined();
    expect(t0.filesChanged).toContain('src/mod.ts');
    expect(t0.diff).toContain('+export const answer = 42;');

    // THE LEGACY DEFECT: every file the row names must be one it can show.
    const carried = new Set([...diffFiles(t0.diff), ...diffFiles(t0.uncommittedDiff), ...(t0.contentUnavailableFiles || []), ...(t0.outOfRepoFiles || [])]);
    expect((t0.filesChanged || []).filter((f: string) => !carried.has(f)), 'legacy row claims files it stores no content for').toEqual([]);
    const findings = verifyTurn({
      promptIndex: 0, filesChanged: t0.filesChanged, diff: t0.diff, uncommittedDiff: t0.uncommittedDiff,
      contentUnavailableFiles: t0.contentUnavailableFiles, linesAdded: t0.linesAdded, linesRemoved: t0.linesRemoved,
    } as any).filter((f: { severity?: string }) => f.severity === 'contradiction');
    expect(findings.map((f: { code: string }) => f.code)).toEqual([]);
  }, 120_000 * WINDOWS_SLOWDOWN);

  // Recorded here, before the over-budget turn: that turn's ~200 KB diffs are
  // re-sent by every capture, and a payload fixture including them ran to 1 MB.
  // The legacy row this freezes — sent and stored — is the small one above;
  // the budget-cut behaviour below is pinned by its own assertions.
  it('golden: the working session\'s legacy turn rows match the recorded baseline', () => {
    const payloads = workPayloads();
    expectGoldenTurns('claude-code-forced-legacy-contention', foldStopRows(payloads), {
      repo, roots: [tmp], sent: payloads.flat(), failedBefore: failures(),
      requests: hits, sessionId: WORK_API,
    });
  });

  it('an over-budget legacy diff is cut at file boundaries and names what did not fit', async () => {
    const big = (seed: string) =>
      Array.from({ length: 1200 }, (_, i) => `export const ${seed}_${i} = ${i}; // ${seed.repeat(4)}`).join('\n') + '\n';
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `src/bulk/${n}.ts`);

    say(WORK_CONV, 'generate the bulk modules');
    expect((await run(WORK_CONV, 'user-prompt-submit', { prompt: 'generate the bulk modules' })).code).toBe(0);
    // A shell loop: no tool call describes these writes.
    for (const [i, f] of files.entries()) {
      const abs = path.join(repo, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, big(`M${i}`));
    }
    assistantSays(WORK_CONV, 'Generated the bulk modules with a shell loop.');
    expect((await run(WORK_CONV, 'stop', { stop_hook_active: false })).code).toBe(0);

    const turn = workRows().find((r) => r.promptIndex === 1);
    expect(turn, 'no row for the bulk turn').toBeTruthy();
    expect(turn.diffSource, 'the row must come from the legacy reconstruction').toBeUndefined();

    expect(String(turn.diff || '').length).toBeGreaterThan(0);
    expect(turn.contentUnavailableFiles?.length, 'the row must say what did not fit').toBeGreaterThan(0);
    for (const section of String(turn.diff).split(/(?=^diff --git )/m).filter(Boolean)) {
      expect(section, 'a stored section must carry a hunk header').toMatch(/^diff --git .*\n[\s\S]*@@ /);
    }
    const shown = new Set(diffFiles(turn.diff));
    const unavailable: string[] = turn.contentUnavailableFiles || [];
    for (const f of files) expect(shown.has(f) || unavailable.includes(f), `${f} is neither shown nor declared unavailable`).toBe(true);
    for (const f of turn.filesChanged || []) expect(shown.has(f) || unavailable.includes(f), `${f} claimed with no content and no declaration`).toBe(true);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
