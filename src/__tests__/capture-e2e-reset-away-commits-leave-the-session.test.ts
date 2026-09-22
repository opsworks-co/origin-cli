// END-TO-END: commits a session reset away leave it — its sha list, its diff,
// its files and its counts — even when nothing else is left to send.
//
// RCCE-423 (874ff028). post-commit ingests every commit the moment it is made,
// so the server holds a WIP commit before the session throws it away. The CLI
// must then say so (`gitCapture.abandonedCommits`, #1681), and:
//
//   1. a session whose only commit was reset away, on a clean tree: git
//      proves it authored nothing, so Stop sends an EMPTY snapshot with the
//      abandonment — the session diff post-commit stored before the reset is
//      replaced by the true answer. (Without that proof — pre-session dirt —
//      the abandonment rides a metadata-only carrier with no `diff` field.)
//   2. a background job's WIP commit, made after Stop closed the turn and then
//      reset away, is not the closed turn's work — on the wire, and (through
//      the recorded fixture) in the row the server stores;
//   3. a session that kept A and B around a reset-away WIP sends a snapshot
//      whose diff, files and counts are A and B's alone.
//
// Built binary, real hook sequence, git's hooks wired by `core.hooksPath`,
// fake API. With ORIGIN_UPDATE_GOLDEN=1 each scenario records what the API
// accepted to golden/abandoned-payloads/, which apps/api replays through the
// real route and SQLite (session-reset-away-commits-real-db.test.ts).
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
import { ingestRequests } from './helpers/golden-turns.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.join(here, '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);
const FIXTURE_DIR = path.join(here, 'golden', 'abandoned-payloads');

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
let serverSession = '';
let server: http.Server;
let apiUrl = '';
let tmpRoot = '';

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        const u = req.url || '';
        hits.push({ method: req.method || '', url: u, body });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          res.end(JSON.stringify({ sessionId: serverSession, verboseCapture: false }));
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

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MARKER = 'WIP_ONLY_MARKER';

/** One Claude session in its own repo. */
function session(name: string) {
  const claudeId = `e2e-reset-away-${name}`;
  const repo = path.join(tmpRoot, name);
  const hooksDir = path.join(tmpRoot, `${name}-hooks`);
  const transcript = path.join(tmpRoot, `${claudeId}.jsonl`);
  const lines: string[] = [];
  const write = () => fs.writeFileSync(transcript, lines.join('\n') + '\n');
  const entry = (type: string, role: string, content: unknown[]) =>
    lines.push(JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role, content } }));

  // Inside a scenario git runs Origin's hooks, which call the fake API served by
  // THIS process — a synchronous git call would block it.
  const git = async (...args: string[]): Promise<string> =>
    (await execFileP('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_EDITOR: 'true' } })).stdout.trim();
  const gitSync = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();

  const run = (event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> => {
    const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
      cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', () => { /* context injection */ });
    child.stdin.end(JSON.stringify({ session_id: claudeId, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));
    return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
  };
  const hook = async (event: string, payload: Record<string, unknown> = {}) => {
    const r = await run(event, payload);
    expect(r.code, `${event}: ${r.stderr}`).toBe(0);
  };

  return {
    repo,
    git,
    init() {
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(transcript, '');
      const node = `"${process.execPath}" "${BIN}" hooks`;
      const bodies: Record<string, string> = {
        'prepare-commit-msg': `${node} git-prepare-commit-msg "$1" "$2" "$3"`,
        'post-commit': `ORIGIN_COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null)" ${node} git-post-commit`,
        'post-rewrite': `${node} git-post-rewrite "$@"`,
        'post-checkout': `${node} git-post-checkout "$1" "$2" "$3"`,
      };
      for (const [n, b] of Object.entries(bodies)) {
        fs.writeFileSync(path.join(hooksDir, n), `#!/bin/sh\n${b} >/dev/null 2>&1 || true\n`, { mode: 0o755 });
      }
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      gitSync('config', 'user.name', 'E2E');
      gitSync('config', 'user.email', 'e2e@example.com');
      gitSync('config', 'commit.gpgsign', 'false');
      fs.mkdirSync(path.join(repo, 'src'));
      // Origin writes its context files at session start; they are not work.
      fs.writeFileSync(path.join(repo, '.gitignore'), 'CLAUDE.md\nAGENTS.md\n');
      fs.writeFileSync(path.join(repo, 'src', 'base.ts'), 'export const BASE = 1;\n');
      gitSync('add', '.');
      gitSync('commit', '-q', '-m', 'base');
      gitSync('config', 'core.hooksPath', hooksDir);
      return gitSync('rev-parse', 'HEAD');
    },
    hook,
    async prompt(text: string) {
      entry('user', 'user', [{ type: 'text', text }]); write();
      await hook('user-prompt-submit', { prompt: text });
    },
    async writes(id: string, file: string, content: string) {
      const abs = path.join(repo, file);
      const input = { file_path: abs, content };
      await hook('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
      fs.writeFileSync(abs, content);
      entry('assistant', 'assistant', [{ type: 'tool_use', id, name: 'Write', input }]);
      entry('user', 'user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]); write();
      await hook('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
    },
    async shell(id: string, command: string, body: () => Promise<void>) {
      const input = { command };
      await hook('pre-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id });
      await body();
      entry('assistant', 'assistant', [{ type: 'tool_use', id, name: 'Bash', input }]);
      entry('user', 'user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]); write();
      await hook('post-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id, tool_response: { stdout: '', stderr: '' } });
    },
    reply(text: string) { entry('assistant', 'assistant', [{ type: 'text', text }]); write(); },
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

/** This scenario's ingest requests, in arrival order. */
const ingested = (sid: string): Array<{ kind: 'patch' | 'end'; body: any }> => ingestRequests(hits, sid);
const commitShasOf = (b: any): string[] => b?.gitCapture?.commitShas || [];

function record(name: string, roles: Record<string, string>, repo: string) {
  if (process.env.ORIGIN_UPDATE_GOLDEN !== '1') return;
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_DIR, `${name}.json`), JSON.stringify({
    note: 'Recorded by packages/cli capture-e2e-reset-away-commits-leave-the-session with ORIGIN_UPDATE_GOLDEN=1. Replayed by apps/api session-reset-away-commits-real-db.test.ts.',
    roots: [repo, tmpRoot],
    roles,
    marker: MARKER,
    requests: ingested(serverSession),
  }, null, 1) + '\n');
}

describe.skipIf(!haveDist || isWindows)('commits a session reset away leave it, through the built binary', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-reset-away-')));
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
      const dump = '--- hooks.log ---\n' + log.split('\n')
        .filter((l) => /\[stop\]|\[ledger\]|abandon/.test(l) && !/HOOK (INVOKED|COMPLETE)|findStateForHook/.test(l))
        .map((l) => l.slice(0, 400)).join('\n')
        + '\n--- requests ---\n' + hits.map((h) => `${h.method} ${h.url} ${JSON.stringify(Object.keys(h.body || {}))}`).join('\n');
      // A path writes the dump there; any other value prints it.
      if (process.env.E2E_DUMP.includes(path.sep)) fs.writeFileSync(process.env.E2E_DUMP, dump); else console.log(dump);
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a session whose only commit was reset away, on a clean tree, still takes it off the server', async () => {
    serverSession = 'e2e-reset-away-all-0001';
    const s = session('all-reset');
    const base = s.init();
    try {
      await s.hook('session-start', { source: 'startup' });
      await s.prompt('try something');
      await s.writes('tu-1', 'src/wip_only.ts', `export const ${MARKER} = 1;\n`);
      let wip = '';
      await s.shell('tu-2', 'git add src/wip_only.ts && git commit -m wip', async () => {
        await s.git('add', 'src/wip_only.ts');
        await s.git('commit', '-q', '-m', 'wip');
        wip = await s.git('rev-parse', 'HEAD');
      });
      // post-commit ingested it: the server now holds the WIP commit.
      expect(ingested(serverSession).some((r) => commitShasOf(r.body).includes(wip)), 'post-commit did not ingest the WIP').toBe(true);
      const beforeReset = ingested(serverSession).length;

      await s.shell('tu-3', `git reset --hard ${base}`, async () => { await s.git('reset', '-q', '--hard', base); });
      expect(await s.git('status', '--porcelain'), 'the tree is not clean').toBe('');
      s.reply('Never mind, dropped it.');
      await s.hook('stop', { stop_hook_active: false });
      const afterStop = ingested(serverSession).length;
      // Claude Code's SessionEnd is a Stop (it also fires on reconnect); the
      // heartbeat's own end later carries no gitCapture. So this is the last
      // payload that can name the abandoned commit, and it must.
      await s.hook('session-end', { reason: 'prompt_input_exit' });
      await sleep(300);

      const named = (r: { body: any }) => (r.body.gitCapture?.abandonedCommits || []).includes(wip);
      const after = ingested(serverSession).slice(beforeReset);
      expect(ingested(serverSession).slice(beforeReset, afterStop).some(named), 'Stop did not send the abandonment').toBe(true);
      // git proves the session authored nothing — no live commit, the tree is
      // its start's — so Stop sends the true, empty snapshot, which replaces the
      // session diff post-commit stored before the reset.
      const empty = ingested(serverSession).slice(beforeReset, afterStop)
        .filter((r) => named(r) && r.body.gitCapture.snapshot === true);
      expect(empty.length, 'Stop did not send the proven-empty snapshot').toBeGreaterThan(0);
      for (const r of empty) {
        expect([r.body.gitCapture.diff, r.body.gitCapture.linesAdded, r.body.gitCapture.linesRemoved]).toEqual(['', 0, 0]);
        expect(r.body.gitCapture.commitShas).toEqual([]);
      }
      const fromEnd = ingested(serverSession).slice(afterStop).filter(named);
      expect(fromEnd.length, 'SessionEnd did not repeat the abandonment').toBeGreaterThan(0);
      expect(fromEnd.at(-1)!.body.gitCapture.abandonedCommits, 'SessionEnd sent an incomplete list').toEqual([wip]);

      for (const r of after) {
        const g = r.body.gitCapture;
        if (!g) continue;
        // Nothing survived, so nothing may be claimed: no WIP sha, no WIP line.
        expect(commitShasOf(r.body), `a ${r.kind} after the reset lists the WIP`).not.toContain(wip);
        expect(String(g.diff ?? ''), `a ${r.kind} after the reset carries the WIP's line`).not.toContain(MARKER);
        if ((g.abandonedCommits || []).length > 0 && !g.snapshot) {
          // A metadata-only carrier: no diff to replace SessionDiff with, and
          // no files or counts made up to get it through.
          expect('diff' in g, `a metadata-only ${r.kind} carries a diff field`).toBe(false);
          expect(g.linesAdded ?? 0).toBe(0);
          expect(g.linesRemoved ?? 0).toBe(0);
          expect(g.commitDetails ?? []).toEqual([]);
        }
        expect(String(g.diff ?? ''), `a ${r.kind} after the reset names the WIP's file`).not.toContain('wip_only.ts');
      }
      // Not asserted: the body's top-level `filesChanged` is the transcript's
      // list of files the agent wrote (a file written and reverted with no
      // commit at all is on it too). The read path reconciles it against the
      // session diff; apps/api session-reset-away-commits-real-db.test.ts
      // checks the served header.
      record('claude-code-all-reset-away', { base, wip }, s.repo);
    } finally {
      await s.killJournalWatcher();
    }
  }, 300_000 * WINDOWS_SLOWDOWN);

  // The live shape (session ccd07b34): the file was written from the SHELL, so
  // no tool call ever named it and the only evidence is the journal's. Every
  // row came out empty — and an empty row names nothing to trim its ledger
  // against, so turn 2 still shipped the journal's `delete src/wip_only.ts`
  // (the reset taking the file off disk) and the read path drew a card of -1
  // for a file no commit and no tree holds.
  //
  // What leaves and what stays is a SPLIT, not a sweep. The card is a claim
  // about the repository and it goes: no diff, no counts, no `filesChanged`.
  // The record that the agent ran `cat > src/wip_only.ts` is a fact about what
  // happened and it stays, because the session discarding the work afterwards
  // does not unmake the act. Only the watcher's own evidence — the journal's
  // delete, which is the reset itself, not the agent — is dropped.
  it('a shell-written WIP that was reset away keeps its command, loses its card', async () => {
    serverSession = 'e2e-reset-away-shell-0001';
    const s = session('shell-reset');
    const base = s.init();
    try {
      await s.hook('session-start', { source: 'startup' });
      await s.prompt('write it from the shell and commit');
      const abs = path.join(s.repo, 'src', 'wip_only.ts');
      await s.shell('sh-1', `cat > src/wip_only.ts`, async () => {
        await fs.promises.writeFile(abs, `export const ${MARKER} = 1;\n`);
      });
      let wip = '';
      await s.shell('sh-2', 'git add -A && git commit -m wip', async () => {
        await s.git('add', '-A');
        await s.git('commit', '-q', '-m', 'wip');
        wip = await s.git('rev-parse', 'HEAD');
      });
      s.reply('committed it');
      await s.hook('stop', { stop_hook_active: false });

      await s.prompt('never mind, throw it away');
      // Counted here, not before the prompt: a payload sent while the commit
      // was still on the branch described the repository truthfully.
      const beforeReset = ingested(serverSession).length;
      await s.shell('sh-3', `git reset --hard ${base}`, async () => { await s.git('reset', '-q', '--hard', base); });
      expect(await s.git('status', '--porcelain'), 'the tree is not clean').toBe('');
      s.reply('dropped it');
      await s.hook('stop', { stop_hook_active: false });
      await s.hook('session-end', { reason: 'prompt_input_exit' });
      await sleep(300);

      const after = ingested(serverSession).slice(beforeReset);
      expect(after.some((r) => (r.body.gitCapture?.abandonedCommits || []).includes(wip)),
        'the abandonment was never sent').toBe(true);
      // Every ledger edit on the WIP file, with the evidence that saw it.
      const wipEdits = (b: any): string[] => (b?.promptChanges || []).flatMap((pc: any) => {
        try {
          return ((JSON.parse(String(pc?.editsJson || '{}')).edits || []) as Array<{ file?: unknown; evidence?: unknown }>)
            .filter((e) => String(e?.file || '') === 'src/wip_only.ts')
            .map((e) => String(e?.evidence || ''));
        } catch { return []; }
      });
      // The watcher's own evidence, from trim-watched-edits.ts.
      const WATCHED_ONLY = ['write_journal', 'command_probe', 'turn_window'];
      let sawTheCommand = false;
      for (const r of after) {
        for (const evidence of wipEdits(r.body)) {
          expect(WATCHED_ONLY, `a ${r.kind} ledger still holds the watcher's own ${evidence} on the reset-away file`)
            .not.toContain(evidence);
          sawTheCommand = true;
        }
        expect(String(r.body.gitCapture?.diff ?? ''), `a ${r.kind} carries the WIP's line`).not.toContain(MARKER);
        // The rows lose the CARD. The file is in no commit and no tree, so
        // naming it or drawing its lines would describe a repository that does
        // not exist — however the file got written.
        for (const pc of (r.body.promptChanges || [])) {
          expect(pc.filesChanged || [], `a ${r.kind} row still names the reset-away file`)
            .not.toContain('src/wip_only.ts');
          expect(String(pc.diff || '') + String(pc.uncommittedDiff || ''),
            `a ${r.kind} row still carries the reset-away file's diff`).not.toContain(MARKER);
        }
      }
      // ...and the RECORD survives. Without this the test would also pass if
      // the ledger were swept empty, which is the behaviour we decided against.
      expect(sawTheCommand, 'the shell command that wrote the file was erased from every ledger').toBe(true);
    } finally {
      await s.killJournalWatcher();
    }
  }, 300_000 * WINDOWS_SLOWDOWN);

  it('a background WIP commit made after Stop and then reset away is not the closed turn\'s work', async () => {
    serverSession = 'e2e-reset-away-background-0001';
    const s = session('background');
    const base = s.init();
    try {
      await s.hook('session-start', { source: 'startup' });
      await s.prompt('change alpha and gamma, commit alpha');
      await s.writes('tu-1', 'src/alpha.ts', 'export const ALPHA_MARKER = 1;\n');
      await s.writes('tu-2', 'src/gamma.ts', 'export const GAMMA_MARKER = 1;\n');
      let a = '';
      await s.shell('tu-3', 'git add src/alpha.ts && git commit -m "feat: alpha"', async () => {
        await s.git('add', 'src/alpha.ts'); await s.git('commit', '-q', '-m', 'feat: alpha');
        a = await s.git('rev-parse', 'HEAD');
      });
      s.reply('Alpha committed, gamma left dirty.');
      await s.hook('stop', { stop_hook_active: false });

      // A background job the turn started: it commits its own scratch file
      // together with the turn's dirty gamma, then throws that commit away.
      fs.writeFileSync(path.join(s.repo, 'src', 'bg_only.ts'), `export const ${MARKER} = 1;\n`);
      await s.git('add', '-A');
      await s.git('commit', '-q', '-m', 'wip');
      const wip = await s.git('rev-parse', 'HEAD');
      await s.git('reset', '-q', '--hard', a);
      fs.rmSync(path.join(s.repo, 'src', 'bg_only.ts'), { force: true });
      // gamma is the turn's own work and comes back with the reset.
      fs.writeFileSync(path.join(s.repo, 'src', 'gamma.ts'), 'export const GAMMA_MARKER = 1;\n');

      await s.prompt('now beta');
      await s.writes('tu-4', 'src/beta.ts', 'export const BETA_MARKER = 1;\n');
      s.reply('Done.');
      await s.hook('stop', { stop_hook_active: false });
      await s.hook('session-end', { reason: 'prompt_input_exit' });
      await sleep(300);

      const rows = ingested(serverSession).flatMap((r) => (r.body.promptChanges || []) as any[]);
      const turnOne = rows.filter((r) => r.promptIndex === 0);
      const last = turnOne.at(-1);
      expect(last, 'no row for the closed turn').toBeTruthy();
      expect(String(last.diff || '') + String(last.uncommittedDiff || ''),
        'the closed turn is sent the reset-away WIP\'s work').not.toContain(MARKER);
      expect(last.filesChanged || []).not.toContain('src/bg_only.ts');
      const snapshot = ingested(serverSession).filter((r) => r.body.gitCapture?.snapshot).at(-1)!.body.gitCapture;
      expect(snapshot.abandonedCommits, 'the background WIP was not sent as abandoned').toEqual([wip]);
      expect(String(snapshot.diff || '')).not.toContain(MARKER);
      record('claude-code-background-wip-reset-away', { base, a, wip }, s.repo);
    } finally {
      await s.killJournalWatcher();
    }
  }, 300_000 * WINDOWS_SLOWDOWN);

  it('A survives, a WIP is reset away, B survives: the session is A and B, by sha and by content', async () => {
    serverSession = 'e2e-reset-away-mixed-0001';
    const s = session('mixed');
    const base = s.init();
    try {
      await s.hook('session-start', { source: 'startup' });
      await s.prompt('add a and b');
      await s.writes('tu-1', 'src/a.ts', 'export const A_MARKER = 1;\n');
      let a = '';
      await s.shell('tu-2', 'git add src/a.ts && git commit -m "feat: a"', async () => {
        await s.git('add', 'src/a.ts'); await s.git('commit', '-q', '-m', 'feat: a');
        a = await s.git('rev-parse', 'HEAD');
      });
      await s.writes('tu-3', 'src/b.ts', 'export const B_FIRST = 1;\n');
      await s.writes('tu-4', 'src/wip_only.ts', `export const ${MARKER} = 1;\n`);
      let wip = '';
      await s.shell('tu-5', 'git add -A src && git commit -m wip', async () => {
        await s.git('add', 'src'); await s.git('commit', '-q', '-m', 'wip');
        wip = await s.git('rev-parse', 'HEAD');
      });
      await s.shell('tu-6', 'git reset --hard HEAD~1', async () => { await s.git('reset', '-q', '--hard', 'HEAD~1'); });
      await s.writes('tu-7', 'src/b.ts', 'export const B_FINAL = 2;\n');
      let b = '';
      await s.shell('tu-8', 'git add src/b.ts && git commit -m wip', async () => {
        await s.git('add', 'src/b.ts'); await s.git('commit', '-q', '-m', 'wip');
        b = await s.git('rev-parse', 'HEAD');
      });
      s.reply('Done.');
      await s.hook('stop', { stop_hook_active: false });
      const afterStop = ingested(serverSession).length;
      await s.hook('session-end', { reason: 'prompt_input_exit' });
      await sleep(300);

      const snapshotIn = (from: number, to?: number) =>
        ingested(serverSession).slice(from, to).filter((r) => r.body.gitCapture?.snapshot).at(-1);
      for (const [kind, last] of [['Stop', snapshotIn(0, afterStop)], ['SessionEnd', snapshotIn(afterStop)]] as const) {
        expect(last, `no ${kind} snapshot`).toBeTruthy();
        const g = last!.body.gitCapture;
        expect(new Set(g.commitShas), `${kind}: the session's commits`).toEqual(new Set([a, b]));
        expect(g.abandonedCommits, `${kind}: the reset-away WIP`).toEqual([wip]);
        const diff = String(g.diff || '');
        expect(diff).toContain('A_MARKER');
        expect(diff).toContain('B_FINAL');
        expect(diff, `${kind}: the WIP's line is in the session diff`).not.toContain(MARKER);
        expect(diff, `${kind}: the WIP's version of b.ts is in the session diff`).not.toContain('B_FIRST');
        expect(diff).not.toContain('wip_only.ts');
        const signed = (sign: string) => diff.split('\n').filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).length;
        expect([g.linesAdded, g.linesRemoved], `${kind}: counts are not the diff's`).toEqual([signed('+'), signed('-')]);
      }
      record('claude-code-mixed-reset-away', { base, a, wip, b }, s.repo);
    } finally {
      await s.killJournalWatcher();
    }
  }, 300_000 * WINDOWS_SLOWDOWN);
});
