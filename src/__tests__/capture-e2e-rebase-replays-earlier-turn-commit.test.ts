// END-TO-END: a turn that rebases an EARLIER turn's commit over an upstream
// change to the same file is not billed that earlier turn's lines.
//
// Session 127d3303 (2026-09-30). Turn 0 wrote four files and committed them.
// Turn 1 started clean, rebased that commit onto a main where #1994 had also
// edited insights-scope.ts, kept both sides of a one-line conflict, and
// merged the PR; GitHub squashed it. Row 1 was right at turn 1's own Stop.
// Every later Stop re-derived it with turn 0's +41/-7 in insights-scope.ts.
//
// The squash replaced the rebased commit in `commitTurns`, which names
// survivors only. The rebased commit still sat in turn 1's git window, matched
// no attestation, fell to the session-level "is it ours" test and counted as
// turn 1's OWN — so turn 1 was measured from main, before turn 0's work. The
// owner lookup now follows the rewrite chain (commitTurnOf).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { gitAsync } from './helpers/git-async.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

let server: http.Server;
let apiUrl = '';
const sentRows: Array<{ sessionId: string; promptIndex: number; filesChanged?: string[]; diff?: string }> = [];

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
        try {
          const body = JSON.parse(raw || '{}');
          const sid = /\/api\/mcp\/session\/([^/?]+)/.exec(u)?.[1] || '';
          if (Array.isArray(body?.promptChanges)) sentRows.push(...body.promptChanges.map((r: any) => ({ ...r, sessionId: sid })));
        } catch { /* not JSON */ }
        if (req.method === 'POST' && u.startsWith('/api/mcp/session/start')) {
          let agentSession = '';
          try { agentSession = JSON.parse(raw).agentSessionId || ''; } catch { /* ignore */ }
          res.end(JSON.stringify({ sessionId: `api-${agentSession || 'x'}`, verboseCapture: false }));
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const numbered = (n: number, edit: (i: number) => string | null = () => null) =>
  Array.from({ length: n }, (_, i) => edit(i + 1) ?? `export const line${i + 1} = ${i + 1};`).join('\n') + '\n';
const ORIGINAL = numbered(40);
/** Turn 0's edit: a new line after line 3. */
const TURN_0 = numbered(40, (i) => (i === 3 ? 'export const line3 = 3;\nexport const turn0 = "turn 0 wrote this";' : null));

/** One session in one repo: turn 0 commits, turn 1 rebases it onto `upstream`. */
function scenario(sessionId: string, upstream: string, resolved: string | null) {
  let repo = '';
  let hooksDir = '';
  let transcript = '';
  const lines: string[] = [];

  // No hooks here: a hooked command blocks the fake API (hookedGit below).
  const git = (args: string[], opts: { allowFail?: boolean } = {}): string => {
    try {
      return execFileSync('git', args, {
        cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' },
      }).trim();
    } catch (err) {
      if (opts.allowFail) return '';
      throw err;
    }
  };

  /** A git command that fires the hooks: async, so the fake API can answer them (gitAsync). */
  const hookedGit = (args: string[], opts: { allowFail?: boolean } = {}): Promise<string> =>
    gitAsync(repo, ['-c', `core.hooksPath=${hooksDir}`, ...args], { env: { ...process.env, GIT_EDITOR: 'true' }, allowFail: opts.allowFail });

  function run(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null }> {
    const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
      cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => { /* context injection — not asserted */ });
    child.stderr.on('data', () => { /* not asserted */ });
    child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }));
    return new Promise((resolve) => child.on('close', (code) => resolve({ code })));
  }

  function append(entry: Record<string, unknown>) {
    lines.push(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
    fs.writeFileSync(transcript, lines.join('\n') + '\n');
  }
  const say = (text: string) => append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  function toolUse(id: string, name: string, input: Record<string, unknown>) {
    append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  }

  async function agentWrites(id: string, file: string, content: string) {
    const abs = path.join(repo, file);
    const input = { file_path: abs, content };
    expect((await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id })).code).toBe(0);
    fs.writeFileSync(abs, content);
    toolUse(id, 'Write', input);
    expect((await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } })).code).toBe(0);
  }

  async function agentRuns(id: string, command: string, body: () => void | Promise<void>) {
    const bash = { tool_name: 'Bash', tool_input: { command }, tool_use_id: id };
    expect((await run('pre-tool-use', bash)).code).toBe(0);
    await body();
    await sleep(1500); // the journal watcher sees the rewrites
    toolUse(id, 'Bash', bash.tool_input);
    expect((await run('post-tool-use', { ...bash, tool_response: { stdout: '', stderr: '' } })).code).toBe(0);
  }

  /**
   * Hold the turn inside the stopped replay until the heartbeat has ticked in
   * it. A tick there measured HEAD (the replay's base) against a tree holding
   * the picked commit and sent turn 0's files as turn 1's; whether one fell in
   * the window was timing, so the case failed only on a loaded host. Waits for
   * the tick's verdict — skipped (hooks.log) or a row sent for turn 1 — not a
   * duration.
   */
  async function heartbeatTicksDuringTheReplay(): Promise<void> {
    const log = path.join(os.homedir(), '.origin', 'hooks.log');
    const from = fs.existsSync(log) ? fs.statSync(log).size : 0;
    const rowsBefore = sentRows.length;
    const deadline = Date.now() + 120_000 * WINDOWS_SLOWDOWN;
    while (Date.now() < deadline) {
      const tail = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').slice(from) : '';
      if (tail.split('\n').some((l) => l.includes('skip tick: a replay is in progress') && l.includes(sessionId))) return;
      if (sentRows.slice(rowsBefore).some((r) => r.sessionId === `api-${sessionId}` && r.promptIndex === 1)) return;
      await sleep(250);
    }
    throw new Error('no heartbeat tick while the replay was stopped');
  }

  function sessionState(): any {
    const dir = git(['rev-parse', '--git-common-dir']);
    const abs = path.isAbsolute(dir) ? dir : path.join(repo, dir);
    const file = fs.readdirSync(abs).find((f) => f.startsWith('origin-session') && f.endsWith('.json'));
    expect(file, 'no session state file').toBeTruthy();
    return JSON.parse(fs.readFileSync(path.join(abs, file!), 'utf-8'));
  }

  async function killJournalWatcher(): Promise<void> {
    const dir = path.join(os.homedir(), '.origin', 'journals');
    try {
      const lock = fs.readdirSync(dir).find((f) => f.startsWith(sessionId.slice(0, 12)) && f.endsWith('.lock'));
      const pid = lock ? Number(fs.readFileSync(path.join(dir, lock), 'utf-8').trim()) : 0;
      if (pid > 0) process.kill(pid, 'SIGTERM');
    } catch { /* no journal */ }
  }

  return {
    async setUp(tmp: string) {
      repo = path.join(tmp, sessionId, 'repo');
      hooksDir = path.join(tmp, sessionId, 'hooks');
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(hooksDir);
      transcript = path.join(tmp, sessionId, `${sessionId}.jsonl`);
      fs.writeFileSync(transcript, '');
      for (const [name, args] of [
        ['prepare-commit-msg', 'git-prepare-commit-msg "$1" "$2" "$3"'],
        ['post-commit', 'git-post-commit'],
        ['post-rewrite', 'git-post-rewrite "$@"'],
      ] as const) {
        fs.writeFileSync(path.join(hooksDir, name), `#!/bin/sh\n"${process.execPath}" "${BIN}" hooks ${args} >/dev/null 2>&1 || true\n`, { mode: 0o755 });
      }
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.name', 'E2E']);
      git(['config', 'user.email', 'e2e@example.com']);
      git(['config', 'commit.gpgsign', 'false']);
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src/scope.ts'), ORIGINAL);
      fs.writeFileSync(path.join(repo, 'src/route.ts'), 'export const route = 1;\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'base']);
      // Another PR lands on main while the session works: same file.
      git(['checkout', '-q', '-b', 'upstream']);
      fs.writeFileSync(path.join(repo, 'src/scope.ts'), upstream);
      git(['commit', '-q', '-am', 'fix: upstream edits scope.ts too']);
      git(['checkout', '-q', '-b', 'feature', 'main']);
    },

    async play() {
      expect((await run('session-start', { source: 'startup' })).code).toBe(0);

      // Turn 0: writes two files and commits them.
      expect((await run('user-prompt-submit', { prompt: 'fix the scope' })).code).toBe(0);
      say('fix the scope');
      await agentWrites('tu-1', 'src/scope.ts', TURN_0);
      await agentWrites('tu-2', 'src/route.ts', 'export const route = 2;\n');
      await agentRuns('tu-3', 'git add -A && git commit -m fix', async () => {
        git(['add', '-A']);
        await hookedGit(['commit', '-q', '-m', 'fix: the scope']);
      });
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);

      // Turn 1: starts clean, rebases turn 0's commit onto upstream.
      expect((await run('user-prompt-submit', { prompt: 'merge it' })).code).toBe(0);
      say('merge it');
      await agentRuns('tu-4', 'git rebase upstream', async () => {
        await hookedGit(['rebase', '-q', 'upstream'], { allowFail: resolved !== null });
      });
      if (resolved !== null) {
        // The conflict: keep both sides, as the agent did.
        expect(fs.readFileSync(path.join(repo, 'src/scope.ts'), 'utf-8')).toContain('<<<<<<<');
        await heartbeatTicksDuringTheReplay();
        await agentWrites('tu-5', 'src/scope.ts', resolved);
        await agentRuns('tu-6', 'git add src/scope.ts && git rebase --continue', async () => {
          git(['add', 'src/scope.ts']);
          await hookedGit(['rebase', '--continue']);
        });
      }
      const final = fs.readFileSync(path.join(repo, 'src/scope.ts'), 'utf-8');
      expect(final).toContain('turn 0 wrote this');
      expect(final).toContain('upstream wrote this');
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);
      const atItsStop = (sessionState().completedPromptMappings || []).find((r: any) => r.promptIndex === 1);

      // Later turns re-derive every row at their Stop. Turn 2 only talks.
      // Then the forge squash-merges the rebased branch (the session merged it
      // with `gh api …/merge`), and turn 3 branches off the result — the
      // squash replaces the rebased commit in the session's records, which is
      // what left that commit unattributed.
      expect((await run('user-prompt-submit', { prompt: 'verify it' })).code).toBe(0);
      say('verify it');
      append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'verified' }] } });
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);
      expect((await run('user-prompt-submit', { prompt: 'fix the next thing' })).code).toBe(0);
      say('fix the next thing');
      git(['checkout', '-q', 'upstream']);
      git(['merge', '-q', '--squash', 'feature']);
      git(['commit', '-q', '-m', 'fix: the scope (#1)']);
      git(['branch', '-q', '-D', 'feature']);
      await agentRuns('tu-7', 'git checkout -b next upstream', async () => {
        await hookedGit(['checkout', '-q', '-b', 'next', 'upstream']);
      });
      await agentWrites('tu-8', 'src/next.ts', 'export const next = 1;\n');
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);

      const rows = sessionState().completedPromptMappings || [];
      return {
        turn0: rows.find((r: any) => r.promptIndex === 0),
        turn1: rows.find((r: any) => r.promptIndex === 1),
        atItsStop,
        sent1: sentRows.filter((r) => r.sessionId === `api-${sessionId}` && r.promptIndex === 1),
      };
    },

    killJournalWatcher,
  };
}

describe.skipIf(!haveDist)('a rebase that replays an earlier turn\'s commit', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-rebase-commit-')));
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
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const cases = [
    {
      name: 'upstream edited another part of the file',
      sessionId: 'e2e-claude-rebase-commit-far-1',
      upstream: numbered(40, (i) => (i === 35 ? 'export const line35 = "upstream wrote this";' : null)),
      resolved: null,
    },
    {
      name: 'the replay conflicted and the turn kept both sides',
      sessionId: 'e2e-claude-rebase-commit-conflict-1',
      upstream: numbered(40, (i) => (i === 3 ? 'export const line3 = 3;\nexport const upstream = "upstream wrote this";' : null)),
      resolved: numbered(40, (i) => (i === 3
        ? 'export const line3 = 3;\nexport const upstream = "upstream wrote this";\nexport const turn0 = "turn 0 wrote this";'
        : null)),
    },
  ];

  for (const c of cases) {
    it(`bills the rebasing turn nothing when ${c.name}`, async () => {
      const s = scenario(c.sessionId, c.upstream, c.resolved);
      try {
        await s.setUp(tmp);
        const { turn0, turn1, atItsStop, sent1 } = await s.play();
        expect(atItsStop?.filesChanged || [], 'at its own Stop').not.toContain('src/scope.ts');
        expect(turn0?.filesChanged, 'turn 0 keeps its own files').toEqual(expect.arrayContaining(['src/scope.ts', 'src/route.ts']));
        expect(turn1?.filesChanged || [], 'turn 1 wrote nothing of its own').not.toContain('src/scope.ts');
        expect(turn1?.diff || '').not.toContain('turn 0 wrote this');
        for (const r of sent1) {
          expect(r.filesChanged || [], 'no row sent for turn 1 names the replayed file').not.toContain('src/scope.ts');
          expect(r.diff || '').not.toContain('turn 0 wrote this');
        }
      } finally {
        await s.killJournalWatcher();
      }
    }, 600_000 * WINDOWS_SLOWDOWN);
  }
});
