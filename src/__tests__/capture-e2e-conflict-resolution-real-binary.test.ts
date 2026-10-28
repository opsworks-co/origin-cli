// END-TO-END: a shell write that resolves a merge conflict is measured from the
// CONFLICTED file git left, not from the turn's start.
//
// Origin TODO 1de72a6e. A turn that runs `git merge <branch>` and stops on a
// conflict has the file on disk holding both sides and the markers — put
// there by git, not by the turn. When the turn then writes the file through a
// shell command (a heredoc, sed, `git checkout --theirs`), the probe and the
// ledger both measured that write from the turn's shadow baseline, so the row
// billed the turn for the incoming branch's lines it merely kept. Live session
// 8a0a80ae turn 1 ("merge PR 2467 and cut the CLI release"): package.json and
// package-lock.json recorded as `command_probe` edits whose old content is the
// turn's start and whose new content holds `<<<<<<<`.
//
// The same start-measuring billed the turn the files the merge brought in
// CLEANLY (a new file, an auto-merged one): the journal saw git write them,
// and against the turn's start they read as the turn's creations.
//
// This drives the built binary through the shape and checks what reaches the
// API: the resolution's own line is the turn's; the incoming branch's line it
// kept is not; the files the merge brought in untouched are not named.
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
const SESSION_ID = 'e2e-claude-conflict-resolution-session-1';
const API_SESSION = 'e2e-conflict-resolution-0001';
const CONFLICTED = 'api/settings.ts';
const BROUGHT_CLEANLY = ['api/scheduler.ts', 'api/audit.ts'];
const INCOMING_LINE = 'export const b = 2; // audit';
const RESOLVED_LINE = 'export const c = 1; // resolved';

let server: http.Server;
let apiUrl = '';
let repo = '';
let transcript = '';
type Row = { promptIndex: number; filesChanged?: string[]; diff?: string; editsJson?: string; linesAdded?: number; linesRemoved?: number };
const sentRows: Row[] = [];

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
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** `waitFor` that gives up quietly: the journal is wanted, not required. */
async function settle(cond: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  try { await waitFor(cond, timeoutMs, what); return true; } catch (e) { console.log(String(e)); return false; }
}

/** The journal the session is using, once the detached watcher has made it. */
function journalPath(): string | null {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return null;
  const j = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl') && f.startsWith(SESSION_ID.slice(0, 12)));
  return j ? path.join(dir, j) : null;
}
const writesIn = (): number => {
  const j = journalPath();
  if (!j) return 0;
  try { return fs.readFileSync(j, 'utf-8').split('\n').filter((l) => l.startsWith('{"f"')).length; } catch { return 0; }
};

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
  await sleep(1000); // the journal watcher sees the writes
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

/** The `+` lines of a unified diff, without the marker. */
const addedLines = (diff: string): string[] =>
  diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));

/** Every edit in a row's editsJson for `file`. */
function editsOf(row: Row, file: string): Array<{ oldContent?: string; newContent?: string; evidence?: string }> {
  try {
    const parsed = JSON.parse(row.editsJson || '[]');
    const list: any[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.edits) ? parsed.edits : []);
    return list.filter((e) => e && e.file === file);
  } catch { return []; }
}

describe.skipIf(!haveDist)('a shell write that resolves a merge conflict', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-conflict-resolution-')));
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
    // The branch to merge: another session's work.
    git(['checkout', '-q', '-b', 'feat/audit']);
    write('api/settings.ts', `export const a = 1;\n${INCOMING_LINE}\n`);
    write('api/scheduler.ts', 'export const jobs = ["audit-retention"];\n');
    write('api/audit.ts', 'export const retention = 90;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'feat(audit): retention']);
    // main moved on and conflicts with it in settings.ts only.
    git(['checkout', '-q', 'main']);
    write('api/settings.ts', 'export const a = 1;\nexport const b = 3; // api keys\n');
    git(['commit', '-q', '-am', 'feat(api-keys): expiry']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    // The hook log's capture lines, for a failure's sake: which producer
    // built the row and what the ledger decided.
    if (process.env.ORIGIN_E2E_DUMP_LOG) {
      try {
        const log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8');
        console.log(log.split('\n').filter((l) => /\[(ledger|stop|post-tool-use|journal[^\]]*)\]|journal/.test(l) && !/HOOK|stdin|findStateForHook/.test(l)).join('\n'));
        const jdir = path.join(os.homedir(), '.origin', 'journals');
        for (const f of fs.readdirSync(jdir)) {
          const p = path.join(jdir, f);
          if (!fs.statSync(p).isFile()) { console.log(`--- journal dir ${f}: ${fs.readdirSync(p).join(', ')}`); continue; }
          console.log(`--- journal ${f} (${fs.statSync(p).size} bytes) ---\n` + fs.readFileSync(p, 'utf-8').slice(0, 4000));
        }
      } catch (e) { console.log('no log', String(e)); }
    }
    await killJournalWatcher();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('bills the turn its resolution, not the incoming branch', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);
    expect((await run('user-prompt-submit', { prompt: 'merge the audit branch' })).code).toBe(0);
    say('merge the audit branch');

    // Give the detached journal watcher time to be RECORDING before the
    // merge, so the ledger — the producer that owns the row wherever the
    // watcher runs — sees every write. The row is asserted whichever
    // producer builds it: where recursive file watching delivers nothing
    // (capture-e2e-real-binary's liveness check fails the same way there),
    // the ledger declines and the shadow-diff safety net is what reaches
    // the API, and it must be right too.
    await waitFor(() => journalPath() !== null, 10_000, 'the session journal to exist');
    const probeFile = path.join(repo, '.probe');
    for (let i = 0; i < 400 && writesIn() === 0; i++) {
      fs.writeFileSync(probeFile, String(i));
      await sleep(25);
    }
    const watcherRecords = writesIn() > 0;
    if (!watcherRecords) console.log('the detached journal watcher recorded nothing: the row will come from the safety net');
    fs.rmSync(probeFile, { force: true });
    await sleep(400);
    const beforeMerge = writesIn();

    await bash('tu-1', 'git -c core.hooksPath=/dev/null merge feat/audit', () => {
      try { git(['merge', 'feat/audit']); } catch { /* stops on the conflict */ }
    });
    // The merge wrote the three files (and the one it conflicts on).
    if (watcherRecords) await settle(() => writesIn() >= beforeMerge + 3, 10_000, 'the journal to record the merge\'s writes');
    // What git left: both sides and the markers in one file, the other two
    // merged cleanly and staged.
    const conflicted = fs.readFileSync(path.join(repo, CONFLICTED), 'utf-8');
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain(INCOMING_LINE);
    expect(fs.existsSync(path.join(repo, 'api/audit.ts'))).toBe(true);

    // The resolution: keep the incoming line, add one of the turn's own.
    const resolved = `export const a = 1;\n${INCOMING_LINE}\n${RESOLVED_LINE}\n`;
    const beforeResolve = writesIn();
    await bash('tu-2', `cat > ${CONFLICTED} <<'EOF'\n${resolved}EOF`, () => {
      write(CONFLICTED, resolved);
    });
    if (watcherRecords) await settle(() => writesIn() > beforeResolve, 10_000, 'the journal to record the resolving write');
    await bash('tu-3', `git add ${CONFLICTED}`, () => {
      git(['add', CONFLICTED]);
    });
    expect((await run('stop', {})).code).toBe(0);
    await sleep(500);

    // The merge is still in progress: the turn committed nothing.
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);

    // What reached the API, for the failure's sake.
    for (const r of sentRows.filter((x) => x.promptIndex === 0)) {
      console.log(`row: files=${JSON.stringify(r.filesChanged)} +${r.linesAdded}/-${r.linesRemoved}\n${r.diff || '(no diff)'}`);
    }

    // The probe's own record of the resolving write starts from the
    // conflicted file, not from the turn's start.
    const probe = (sessionState().liveEdits || [])
      .filter((e: any) => e.promptIndex === 0)
      .flatMap((e: any) => (e.edits || []).filter((x: any) => x.file === CONFLICTED));
    expect(probe.length, 'the resolving write reached the ledger').toBeGreaterThan(0);
    for (const e of probe) {
      expect(String(e.oldContent || ''), `${e.evidence}: measured from the conflicted file`).toContain('<<<<<<<');
      expect(String(e.newContent || '')).toBe(resolved);
    }

    const sent = sentRows.filter((r) => r.promptIndex === 0);
    expect(sent.length, 'the turn reached the API').toBeGreaterThan(0);
    const row = sent[sent.length - 1];
    // The files the merge brought in cleanly are git's, not the turn's.
    for (const f of BROUGHT_CLEANLY) {
      expect(row.filesChanged || [], `the row does not name ${f}`).not.toContain(f);
      expect(String(row.editsJson || ''), `editsJson does not hold ${f}`).not.toContain(`"file":"${f}"`);
    }
    // The resolution is the turn's; the incoming line it kept is not.
    expect(row.filesChanged || []).toContain(CONFLICTED);
    const added = addedLines(String(row.diff || ''));
    expect(added, 'the resolved line is the turn\'s').toContain(RESOLVED_LINE);
    expect(added, 'the incoming branch\'s line is not the turn\'s').not.toContain(INCOMING_LINE);
    expect(row.linesAdded, 'one added line: the resolution').toBe(1);
    for (const e of editsOf(row, CONFLICTED)) {
      if (e.oldContent !== undefined) expect(e.oldContent, `${e.evidence}: editsJson old content`).toContain('<<<<<<<');
    }
  }, 600_000 * WINDOWS_SLOWDOWN);
});
