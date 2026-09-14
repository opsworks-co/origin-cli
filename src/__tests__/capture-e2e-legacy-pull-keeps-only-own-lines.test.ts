// END-TO-END: a legacy-reconstructed turn that pulls keeps only its OWN lines.
//
// TODO 0f2038ef, from session 9f8501f7: "If a turn pulls and the watcher is
// dead (legacy path), it keeps the legacy row, which excludes pulled files per
// file but not per line."
//
// Stop's legacy synthesis diffs the working tree against the turn's shadow.
// `dropForeignCommitsFromCapture` removes a fast-forwarded foreign commit's
// files by NAME, and deliberately keeps any file the turn also edited — but
// that file's section is still measured from the pre-pull shadow, so the
// pulled lines ride along inside it. The ledger (#1542) and the shell window
// (#1611) already measure such a file from the inherited baseline; the legacy
// synthesis did not.
//
// The legacy path is forced as capture-e2e-forced-legacy-under-contention does:
// a second live session in the same tree makes the shadow-window pass stand
// down and the ledger decline.
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

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

const SIBLING_API = 'eeeeeeee-7777-4777-8777-eeeeeeeeeeee';
const WORK_API = 'ffffffff-8888-4888-8888-ffffffffffff';
// The session tag is the first 12 characters of the session id, and the state
// file is keyed by it. Two ids sharing that prefix share ONE state file, so
// the "sibling" is overwritten by the working session and never contends.
const SIBLING_CONV = 'sibling-pull-e2e-0001';
const WORK_CONV = 'working-pull-e2e-0002';

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

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
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

function stateOf(serverId: string): Record<string, any> {
  const dir = path.join(repo, '.git');
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('origin-session') && n.endsWith('.json'))) {
    const st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    if (st.sessionId === serverId) return st;
  }
  throw new Error(`no state file for ${serverId}`);
}

const workRows = (): any[] => foldStopRows(hits
  .filter((h) => h.method === 'PATCH' && h.url.includes(WORK_API) && Array.isArray(h.body?.promptChanges))
  .map((h) => h.body.promptChanges));

/** The unified-diff section of one file in a diff, or '' when it has none. */
function sectionOf(diff: string | null | undefined, file: string): string {
  return String(diff || '').split(/(?=^diff --git )/m).find((s) => s.startsWith(`diff --git a/${file} `)) || '';
}

async function killDaemons(): Promise<void> {
  for (const sub of ['journals', 'heartbeats']) {
    const dir = path.join(os.homedir(), '.origin', sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.lock') || n.endsWith('.pid'))) {
      try { const pid = Number(fs.readFileSync(path.join(dir, f), 'utf-8').trim()); if (pid > 0) process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
  }
  await sleep(300);
}

const SHARED_BASE = Array.from({ length: 10 }, (_, i) => `base_${i} = ${i}`).join('\n') + '\n';
const UPSTREAM_LINES = Array.from({ length: 20 }, (_, i) => `upstream_${i} = ${i}`).join('\n') + '\n';
const OWN_LINE = 'mine = "the turn wrote this"\n';

describe.skipIf(!haveDist)('a legacy-reconstructed turn that pulls keeps only its own lines', () => {
  let upstream = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-legacy-pull-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    for (const c of [SIBLING_CONV, WORK_CONV]) { transcripts[c] = path.join(tmp, `${c}.jsonl`); fs.writeFileSync(transcripts[c], ''); }
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e-legacy-pull', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e' }));

    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'E2E']);
    git(['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, 'shared.py'), SHARED_BASE);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);

    // origin/main moved: someone else's PR, committed by GitHub an hour ago,
    // appending to shared.py and adding a file of its own.
    const earlier = new Date(Date.now() - 60 * 60_000).toISOString();
    git(['checkout', '-q', '-b', 'upstream']);
    fs.writeFileSync(path.join(repo, 'shared.py'), SHARED_BASE + UPSTREAM_LINES);
    fs.writeFileSync(path.join(repo, 'upstream_only.py'), 'only_upstream = True\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'feat: another PR (#9999)\n\nOrigin-Session: 12345678-abc | Claude Code | 3 prompts'], {
      GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_AUTHOR_DATE: earlier,
      GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_DATE: earlier,
    });
    upstream = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killDaemons();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the pulled lines inside a file the turn also edited are not the turn\'s', async () => {
    // A sibling parked in the same checkout forces the legacy reconstruction.
    expect((await run(SIBLING_CONV, 'session-start', { source: 'startup' })).code).toBe(0);
    say(SIBLING_CONV, 'what does this repo do?');
    expect((await run(SIBLING_CONV, 'user-prompt-submit', { prompt: 'what does this repo do?' })).code).toBe(0);
    assistantSays(SIBLING_CONV, 'It is a demo.');
    expect((await run(SIBLING_CONV, 'stop', { stop_hook_active: false })).code).toBe(0);

    expect((await run(WORK_CONV, 'session-start', { source: 'startup' })).code).toBe(0);
    say(WORK_CONV, 'pull main, then add my line to shared.py');
    expect((await run(WORK_CONV, 'user-prompt-submit', { prompt: 'pull main, then add my line to shared.py' })).code).toBe(0);

    // The pull, through Bash.
    const pullInput = { command: `git merge --ff-only ${upstream}` };
    await run(WORK_CONV, 'pre-tool-use', { tool_name: 'Bash', tool_input: pullInput, tool_use_id: 'tu-1' });
    git(['merge', '-q', '--ff-only', upstream]);
    toolUse(WORK_CONV, 'tu-1', 'Bash', pullInput);
    await run(WORK_CONV, 'post-tool-use', { tool_name: 'Bash', tool_input: pullInput, tool_use_id: 'tu-1', tool_response: { stdout: '', stderr: '', interrupted: false } });

    // The turn's own edit, on top of what the pull brought in.
    const sharedAbs = path.join(repo, 'shared.py');
    const editInput = { file_path: sharedAbs, content: SHARED_BASE + UPSTREAM_LINES + OWN_LINE };
    await run(WORK_CONV, 'pre-tool-use', { tool_name: 'Write', tool_input: editInput, tool_use_id: 'tu-2' });
    fs.writeFileSync(sharedAbs, editInput.content);
    toolUse(WORK_CONV, 'tu-2', 'Write', editInput);
    await run(WORK_CONV, 'post-tool-use', { tool_name: 'Write', tool_input: editInput, tool_use_id: 'tu-2', tool_response: { filePath: sharedAbs, success: true } });

    expect((await run(WORK_CONV, 'stop', { stop_hook_active: false })).code).toBe(0);

    // PRECONDITIONS: the legacy path owns the row.
    expect(stateOf(WORK_API).contendingSessionIds || [], 'the sibling was not recorded as contending').toContain(SIBLING_API);
    expect(hooksLog()).toContain('ledger declined: another live session shares this working tree');

    const t0 = workRows().find((r) => r.promptIndex === 0);
    expect(t0, 'no row for the working turn').toBeTruthy();
    expect(t0.diffSource, 'the row must come from the legacy reconstruction').toBeUndefined();

    // Per FILE (already right before this fix): the pull's own file is not claimed.
    expect(t0.filesChanged || []).not.toContain('upstream_only.py');
    expect(t0.filesChanged).toContain('shared.py');

    // Per LINE (the defect): shared.py carries the turn's one line, not the PR's twenty.
    const shared = sectionOf(t0.diff, 'shared.py') || sectionOf(t0.uncommittedDiff, 'shared.py');
    expect(shared, 'no section for shared.py').not.toBe('');
    expect(shared).toContain('+mine = "the turn wrote this"');
    expect(shared, 'the pulled lines were billed to the turn').not.toContain('+upstream_');
    expect([t0.linesAdded, t0.linesRemoved]).toEqual([1, 0]);

    const findings = verifyTurn({
      promptIndex: 0, filesChanged: t0.filesChanged, diff: t0.diff, uncommittedDiff: t0.uncommittedDiff,
      contentUnavailableFiles: t0.contentUnavailableFiles, linesAdded: t0.linesAdded, linesRemoved: t0.linesRemoved,
    } as any).filter((f: { severity?: string }) => f.severity === 'contradiction');
    expect(findings.map((f: { code: string }) => f.code)).toEqual([]);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
