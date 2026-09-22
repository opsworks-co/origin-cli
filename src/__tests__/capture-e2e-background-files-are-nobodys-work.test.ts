// END-TO-END: a file that exists only because a background job put it there,
// and that no agent ever wrote, belongs to no turn.
//
// RCCE-423 (874ff028), the two shapes seen while building the composite
// scenario:
//
//   1. the job creates a scratch file after Stop closed the turn, the next
//      prompt lands while it is on disk, and the job deletes it during the
//      next turn. The prompt hook credits the closed turn with the file (the
//      late-work pass, #1684) and nothing takes it back: the closed turn ends
//      up naming a file that exists in no tree and no commit.
//   2. the job restores the tree with `git checkout HEAD -- src`, which brings
//      back files the WIP commit held. The restoration happens inside the next
//      turn's window, so that turn is credited with work its agent never did.
//
// Built binary, real hook sequence, fake API.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN, isWindows } from './helpers/windows-e2e.js';
import { foldStopRows } from './helpers/fold-stop-rows.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', '..', 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let serverSession = '';
let server: http.Server;
let apiUrl = '';
let tmpRoot = '';

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = 'src/job_scratch.ts';
const SCRATCH_MARKER = 'JOB_SCRATCH_MARKER';

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
        if (req.method === 'POST' && (req.url || '').startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: serverSession, verboseCapture: false }));
        } else if ((req.url || '').startsWith('/api/pricing')) {
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

/** One Claude session in its own repo, with Origin's git hooks wired. */
function session(name: string) {
  const claudeId = `e2e-bgfiles-${name}`;
  const repo = path.join(tmpRoot, name);
  const hooksDir = path.join(tmpRoot, `${name}-hooks`);
  const transcript = path.join(tmpRoot, `${claudeId}.jsonl`);
  const lines: string[] = [];
  const flush = () => fs.writeFileSync(transcript, lines.join('\n') + '\n');
  const entry = (type: string, role: string, content: unknown[]) =>
    lines.push(JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role, content } }));
  const gitSync = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  const git = async (...a: string[]): Promise<string> =>
    (await execFileP('git', a, { cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_EDITOR: 'true' } })).stdout.trim();

  const hook = async (event: string, payload: Record<string, unknown> = {}) => {
    const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
      cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', () => { /* context injection */ });
    child.stdin.end(JSON.stringify({ session_id: claudeId, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code, `${event}: ${stderr}`).toBe(0);
  };

  return {
    repo,
    git,
    init(files: Record<string, string>) {
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(transcript, '');
      const node = `"${process.execPath}" "${BIN}" hooks`;
      for (const [n, b] of Object.entries({
        'prepare-commit-msg': `${node} git-prepare-commit-msg "$1" "$2" "$3"`,
        'post-commit': `ORIGIN_COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null)" ${node} git-post-commit`,
        'post-checkout': `${node} git-post-checkout "$1" "$2" "$3"`,
      })) fs.writeFileSync(path.join(hooksDir, n), `#!/bin/sh\n${b} >/dev/null 2>&1 || true\n`, { mode: 0o755 });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      gitSync('config', 'user.name', 'E2E');
      gitSync('config', 'user.email', 'e2e@example.com');
      gitSync('config', 'commit.gpgsign', 'false');
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\nCLAUDE.md\nAGENTS.md\n');
      for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), c);
      gitSync('add', '.');
      gitSync('commit', '-q', '-m', 'base');
      gitSync('config', 'core.hooksPath', hooksDir);
      return gitSync('rev-parse', 'HEAD');
    },
    hook,
    /** The detached journal watcher has to be recording before the turn's work. */
    async waitForJournal() {
      const dir = path.join(os.homedir(), '.origin', 'journals');
      const file = () => {
        try { return fs.readdirSync(dir).find((f) => f.startsWith(claudeId.slice(0, 12)) && f.endsWith('.jsonl')); }
        catch { return undefined; }
      };
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !file()) await sleep(50);
      const probe = path.join(repo, '.probe');
      const recorded = () => { try { return fs.readFileSync(path.join(dir, file()!), 'utf-8'); } catch { return ''; } };
      for (let i = 0; i < 400 && !recorded().includes('{"f"'); i++) {
        fs.writeFileSync(probe, String(i));
        await sleep(25);
      }
      expect(recorded(), 'the journal watcher recorded nothing').toContain('{"f"');
      await sleep(400);
    },
    async prompt(text: string) {
      entry('user', 'user', [{ type: 'text', text }]); flush();
      await hook('user-prompt-submit', { prompt: text });
    },
    async writes(id: string, file: string, content: string) {
      const abs = path.join(repo, file);
      const input = { file_path: abs, content };
      await hook('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      entry('assistant', 'assistant', [{ type: 'tool_use', id, name: 'Write', input }]);
      entry('user', 'user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]); flush();
      await hook('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
    },
    reply(text: string) { entry('assistant', 'assistant', [{ type: 'text', text }]); flush(); },
    async killJournalWatcher() {
      const dir = path.join(os.homedir(), '.origin', 'journals');
      try {
        const lock = fs.readdirSync(dir).find((f) => f.startsWith(claudeId.slice(0, 12)) && f.endsWith('.lock'));
        const pid = lock ? Number(fs.readFileSync(path.join(dir, lock), 'utf-8').trim()) : 0;
        if (pid > 0) process.kill(pid, 'SIGTERM');
      } catch { /* none */ }
    },
  };
}

const rows = () => foldStopRows(hits
  .filter((h) => h.method === 'PATCH' && h.url.startsWith(`/api/mcp/session/${serverSession}`))
  .map((h) => h.body)
  .filter((b) => b && Array.isArray(b.promptChanges)));
const row = (i: number): any => rows().find((r) => r.promptIndex === i);
const textOf = (r: any) => `${r?.diff || ''}\n${r?.uncommittedDiff || ''}`;

describe.skipIf(!haveDist || isWindows)('files only a background job touched, through the built binary', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-bgfiles-')));
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
    }));
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    if (process.env.E2E_DUMP) {
      let log = '';
      try { log = fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { /* none */ }
      const dump = log.split('\n')
        .filter((l) => /\[stop\]|\[ledger\]|late|restor|shadow/.test(l) && !/HOOK (INVOKED|COMPLETE)|findStateForHook/.test(l))
        .map((l) => l.slice(0, 400)).join('\n');
      if (process.env.E2E_DUMP.includes(path.sep)) fs.writeFileSync(process.env.E2E_DUMP, dump); else console.log(dump);
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a scratch file a job created after Stop and deleted again is on no turn', async () => {
    serverSession = 'e2e-bgfiles-created-0001';
    hits.length = 0;
    const s = session('created');
    s.init({ 'src/alpha.ts': 'export const ALPHA = 1;\n', 'src/beta.ts': 'export const BETA = 1;\n' });
    try {
      await s.hook('session-start', { source: 'startup' });
      await s.prompt('change alpha');
      await s.waitForJournal();
      await s.writes('tu-1', 'src/alpha.ts', 'export const ALPHA = 1;\nexport const ALPHA_TURN_ONE = 2;\n');
      s.reply('Done.');
      await s.hook('stop', { stop_hook_active: false });

      // The job writes its scratch file after the turn closed…
      fs.writeFileSync(path.join(s.repo, SCRATCH), `export const ${SCRATCH_MARKER} = 1;\n`);
      await sleep(400);
      // …the next prompt lands while it is on disk…
      await s.prompt('now beta');
      // …and the job clears it again.
      fs.rmSync(path.join(s.repo, SCRATCH));
      await sleep(400);
      await s.writes('tu-2', 'src/beta.ts', 'export const BETA = 1;\nexport const BETA_TURN_TWO = 2;\n');
      s.reply('Done.');
      await s.hook('stop', { stop_hook_active: false });
      await sleep(300);

      const one = row(0);
      const two = row(1);
      expect(one.filesChanged, 'the closed turn kept the job scratch file').toEqual(['src/alpha.ts']);
      expect(textOf(one)).not.toContain(SCRATCH_MARKER);
      expect(two.filesChanged).toEqual(['src/beta.ts']);
      expect(textOf(two)).not.toContain(SCRATCH_MARKER);
    } finally {
      await s.killJournalWatcher();
    }
  }, 300_000 * WINDOWS_SLOWDOWN);

  it('files a job\'s checkout restores mid-turn are not the running turn\'s work', async () => {
    serverSession = 'e2e-bgfiles-restored-0001';
    hits.length = 0;
    const s = session('restored');
    s.init({ 'src/alpha.ts': 'export const ALPHA = 1;\n', 'src/beta.ts': 'export const BETA = 1;\n' });
    try {
      await s.hook('session-start', { source: 'startup' });
      await s.prompt('change alpha');
      await s.waitForJournal();
      await s.writes('tu-1', 'src/alpha.ts', 'export const ALPHA = 1;\nexport const ALPHA_TURN_ONE = 2;\n');
      s.reply('Done.');
      await s.hook('stop', { stop_hook_active: false });

      // The job commits a scratch file of its own, then takes the tree back to
      // an older `src` — HEAD stays on the commit, so no hook fires for it.
      fs.writeFileSync(path.join(s.repo, SCRATCH), `export const ${SCRATCH_MARKER} = 1;\n`);
      await s.git('add', '-A');
      await s.git('commit', '-q', '-m', 'wip');
      const wip = await s.git('rev-parse', 'HEAD');
      await s.git('checkout', `${wip}~1`, '--', 'src');
      await sleep(400);

      // The next prompt lands on the reverted tree; the job then puts HEAD's
      // `src` back — which brings its scratch file into this turn's window —
      // and rolls the commit away.
      await s.prompt('now beta');
      await s.git('checkout', 'HEAD', '--', 'src');
      await s.git('reset', '-q', '--soft', 'HEAD~1');
      await s.git('reset', '-q');
      await sleep(600);

      await s.writes('tu-2', 'src/beta.ts', 'export const BETA = 1;\nexport const BETA_TURN_TWO = 2;\n');
      s.reply('Done.');
      await s.hook('stop', { stop_hook_active: false });
      await sleep(300);

      const two = row(1);
      expect(two.filesChanged, 'the restoration became the turn\'s work').toEqual(['src/beta.ts']);
      expect(textOf(two)).not.toContain(SCRATCH_MARKER);
      expect(textOf(two)).not.toContain('ALPHA_TURN_ONE');
    } finally {
      await s.killJournalWatcher();
    }
  }, 300_000 * WINDOWS_SLOWDOWN);
});
