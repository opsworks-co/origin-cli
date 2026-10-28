// END-TO-END: a turn that rebases another session's PR branch, hits a
// conflict and backs out is not billed that PR.
//
// Live session 4c7cbc7e (cli 0.20261021.2146), prompt 2 "merge them": the turn
// checked out a PR branch and ran `git -c core.hooksPath=/dev/null rebase
// <main>`, which stopped on a conflict. post-tool-use recorded the PR's 31
// files as git's and, one line later, 13 of them as the turn's own
// `command_probe` edits — conflict markers included. Every Stop sent the row
// with no files (the ledger proved the turn wrote nothing), but a row naming no
// files keeps its watched edits, so the editsJson went out with the PR in it
// and the card read 9 files, +320/-26, "uncommitted".
//
// This drives the built binary through the same shape, hooks off for the
// rebase as the agent ran it, and checks what reaches the API.
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
const SESSION_ID = 'e2e-claude-stopped-rebase-session-1';
const API_SESSION = 'e2e-stopped-rebase-0001';
const PR_FILES = ['api/settings.ts', 'api/scheduler.ts', 'api/audit.ts'];

let server: http.Server;
let apiUrl = '';
let repo = '';
let transcript = '';
const sentRows: Array<{ promptIndex: number; filesChanged?: string[]; diff?: string; editsJson?: string }> = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        try {
          const body = JSON.parse(raw || '{}');
          if (Array.isArray(body?.promptChanges)) sentRows.push(...body.promptChanges);
        } catch { /* not JSON */ }
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

const git = (args: string[]): string =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' },
  }).trim();

function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection — not asserted */ });
  child.stdin.end(JSON.stringify({ session_id: SESSION_ID, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const lines: string[] = [];
function append(entry: Record<string, unknown>) {
  lines.push(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
const say = (text: string) => append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
}

/** A Bash call as Claude Code runs it: pre hook, the command, post hook. */
async function bash(id: string, command: string, act: () => void) {
  const call = { tool_name: 'Bash', tool_input: { command }, tool_use_id: id };
  expect((await run('pre-tool-use', call)).code).toBe(0);
  act();
  await sleep(1000); // the journal watcher sees the rewrites
  toolUse(id, 'Bash', call.tool_input);
  expect((await run('post-tool-use', { ...call, tool_response: { stdout: '', stderr: '' } })).code).toBe(0);
}

async function killJournalWatcher(): Promise<void> {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const lock = fs.readdirSync(dir).find((f) => f.startsWith(SESSION_ID.slice(0, 12)) && f.endsWith('.lock'));
      const pid = lock ? Number(fs.readFileSync(path.join(dir, lock), 'utf-8').trim()) : 0;
      if (pid > 0) { process.kill(pid, 'SIGTERM'); return; }
    } catch { /* no journal yet */ }
    await sleep(250);
  }
}

function sessionState(): any {
  const dir = git(['rev-parse', '--git-common-dir']);
  const abs = path.isAbsolute(dir) ? dir : path.join(repo, dir);
  const file = fs.readdirSync(abs).find((f) => f.startsWith('origin-session') && f.endsWith('.json'));
  expect(file, 'no session state file').toBeTruthy();
  return JSON.parse(fs.readFileSync(path.join(abs, file!), 'utf-8'));
}

const write = (f: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), body);
};

describe.skipIf(!haveDist)('a turn that rebases another session\'s PR and stops on a conflict', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-stopped-rebase-')));
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
    git(['config', 'commit.gpgsign', 'false']);
    write('api/settings.ts', 'export const a = 1;\nexport const b = 1;\n');
    write('api/scheduler.ts', 'export const jobs = [];\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    // Another session's PR.
    git(['checkout', '-q', '-b', 'feat/audit']);
    write('api/settings.ts', 'export const a = 1;\nexport const b = 2; // audit\n');
    write('api/scheduler.ts', 'export const jobs = ["audit-retention"];\n');
    write('api/audit.ts', 'export const retention = 90;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'feat(audit): retention']);
    // main moved on and conflicts with it.
    git(['checkout', '-q', 'main']);
    write('api/settings.ts', 'export const a = 1;\nexport const b = 3; // api keys\n');
    git(['commit', '-q', '-am', 'feat(api-keys): expiry']);
    // The session's own branch, where it starts.
    git(['checkout', '-q', '-b', 'feat/trackers']);
    write('web/trackers.ts', 'export const gtm = false;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'fix(security): trackers']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('sends no row and no edit for the PR\'s files', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);
    expect((await run('user-prompt-submit', { prompt: 'merge them' })).code).toBe(0);
    say('merge them');

    await bash('tu-1', 'git checkout feat/audit && git -c core.hooksPath=/dev/null rebase main', () => {
      git(['checkout', '-q', 'feat/audit']);
      try { git(['rebase', 'main']); } catch { /* stops on the conflict */ }
    });
    // The window the bug lived in: the stopped pick's files dirty, markers in one.
    expect(fs.readFileSync(path.join(repo, 'api/settings.ts'), 'utf-8')).toContain('<<<<<<<');
    await bash('tu-2', 'git rebase --abort && git checkout feat/trackers', () => {
      git(['rebase', '--abort']);
      git(['checkout', '-q', 'feat/trackers']);
    });
    expect((await run('stop', {})).code).toBe(0);
    await sleep(500);

    const probe = (sessionState().liveEdits || [])
      .filter((e: any) => e.promptIndex === 0)
      .flatMap((e: any) => (e.edits || []).map((x: any) => x.file));
    for (const f of PR_FILES) expect(probe, `no live edit holds ${f}`).not.toContain(f);

    const sent = sentRows.filter((r) => r.promptIndex === 0);
    expect(sent.length, 'the turn reached the API').toBeGreaterThan(0);
    for (const r of sent) {
      for (const f of PR_FILES) {
        expect(r.filesChanged || [], `no row names ${f}`).not.toContain(f);
        expect(String(r.editsJson || ''), `no editsJson holds ${f}`).not.toContain(`"file":"${f}"`);
      }
      expect(String(r.editsJson || '') + (r.diff || '')).not.toContain('<<<<<<<');
    }
  }, 600_000 * WINDOWS_SLOWDOWN);

  // The follow-up (#2595's open gap): the turn resolves the conflict in a
  // shell write that names the file. That write is the turn's — measured from
  // the conflicted file git left, not from the turn's start, so what the
  // incoming side applied on its own is not billed as the turn's lines.
  it('a named shell resolution is measured from the conflicted file', async () => {
    expect((await run('user-prompt-submit', { prompt: 'rebase it and resolve the conflict' })).code).toBe(0);
    say('rebase it and resolve the conflict');
    await bash('tu-3', 'git checkout feat/audit && git -c core.hooksPath=/dev/null rebase main', () => {
      git(['checkout', '-q', 'feat/audit']);
      try { git(['rebase', 'main']); } catch { /* stops on the conflict */ }
    });
    const conflicted = fs.readFileSync(path.join(repo, 'api/settings.ts'), 'utf-8');
    expect(conflicted).toContain('<<<<<<<');
    const resolved = 'export const a = 1;\nexport const b = 3; // api keys + audit\n';
    const abs = path.join(repo, 'api/settings.ts');
    await bash('tu-4', `cat > ${abs} <<'EOF'\n${resolved}EOF`, () => fs.writeFileSync(abs, resolved));
    await bash('tu-5', 'git add -A && git -c core.hooksPath=/dev/null rebase --continue', () => {
      git(['add', '-A']);
      git(['rebase', '--continue']);
    });
    expect((await run('stop', {})).code).toBe(0);
    await sleep(500);

    const edit = (sessionState().liveEdits || [])
      .filter((e: any) => e.promptIndex === 1)
      .flatMap((e: any) => e.edits || [])
      .find((x: any) => x.file === 'api/settings.ts' && x.evidence === 'command_named');
    expect(edit, 'the resolution is the turn\'s edit').toBeTruthy();
    expect(edit.oldContent).toBe(conflicted);
    expect(edit.newContent).toBe(resolved);

    const sent = sentRows.filter((r) => r.promptIndex === 1 && r.editsJson);
    expect(sent.length, 'turn 2\'s edits reached the API').toBeGreaterThan(0);
    const last = JSON.parse(String(sent[sent.length - 1].editsJson));
    const named = (last.edits || []).filter((x: any) => x.file === 'api/settings.ts' && x.evidence === 'command_named');
    expect(named.length).toBeGreaterThan(0);
    for (const x of named) expect(x.oldContent, 'measured from the conflicted file').toContain('<<<<<<<');
  }, 600_000 * WINDOWS_SLOWDOWN);
});
