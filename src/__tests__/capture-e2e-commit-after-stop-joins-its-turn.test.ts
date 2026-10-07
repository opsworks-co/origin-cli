// END-TO-END: a commit the agent makes AFTER its turn's Stop, with no prompt in
// between, is attested to that turn, and the turn's row carries BOTH commits.
//
// Session df8cc9aa turn 27 ("is the release live?", 2026-10-02). The turn
// committed fix A on branch fix-a, the host squash-merged it and the branch was
// deleted, and the turn went on editing on main. Its Stop ran. A background
// task then re-invoked the agent with no new prompt, and it cut fix-b off the
// new main and committed B. post-commit recorded B with "(no active turn)" —
// the turn was closed and `running > lastClosed` was false — so `commitTurns`
// held A alone, and every later Stop sent the row as A's +65/-3 under a chip
// reading "2 commits net +89/-5". post-commit now re-opens the closed turn when
// the agent's own shell call, started after the Stop and still open, commits
// (closedTurnIsCommittingAfterItsStop).
//
// ORIGIN_E2E_BIN=<released dist/index.js> runs the same scenario on a build
// without the fix.
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
const BIN = process.env.ORIGIN_E2E_BIN || path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);

let server: http.Server;
let apiUrl = '';
const sentRows: Array<{ sessionId: string; promptIndex: number; filesChanged?: string[]; diff?: string; commitSha?: string | null; linesAdded?: number; linesRemoved?: number }> = [];

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

const BASE = 'export function backup() {\n  return copyFile();\n}\n';
const FIX_A = 'export function backup() {\n  removeLeftover();\n  return copyFile();\n}\n\nfunction removeLeftover() {\n  // a killed run leaves a partial file\n}\n';
const FIX_B = 'export function backup() {\n  removeLeftover();\n  return vacuumInto();\n}\n\nfunction removeLeftover() {\n  // a killed run leaves a partial file\n}\n\nfunction vacuumInto() {\n  // writers cannot restart a VACUUM INTO\n}\n';

function scenario(sessionId: string) {
  let repo = '';
  let hooksDir = '';
  let transcript = '';
  const lines: string[] = [];

  // No hooks here: a hooked command blocks the fake API (hookedGit below).
  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' },
  }).trim();

  /** A git command that fires the hooks: async, so the fake API can answer them (gitAsync). */
  const hookedGit = (args: string[]): Promise<string> =>
    gitAsync(repo, ['-c', `core.hooksPath=${hooksDir}`, ...args], { env: { ...process.env, GIT_EDITOR: 'true' } });

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
  const reply = (text: string) => append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
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
      fs.writeFileSync(path.join(repo, 'src/backup.ts'), BASE);
      git(['add', '.']);
      git(['commit', '-q', '-m', 'base']);
    },

    async play() {
      const base = git(['rev-parse', 'HEAD']);
      expect((await run('session-start', { source: 'startup' })).code).toBe(0);

      // Turn 0: fix A on its own branch, committed.
      expect((await run('user-prompt-submit', { prompt: 'is the release live?' })).code).toBe(0);
      say('is the release live?');
      await agentRuns('tu-1', 'git checkout -b fix-a', () => { git(['checkout', '-q', '-b', 'fix-a']); });
      await agentWrites('tu-2', 'src/backup.ts', FIX_A);
      await agentRuns('tu-3', 'git add -A && git commit -m "fix: remove the leftover"', async () => {
        git(['add', '-A']);
        await hookedGit(['commit', '-q', '-m', 'fix: remove the leftover']);
      });
      const shaA = git(['rev-parse', 'HEAD']);
      // The host squash-merges fix-a; the tree moves to the new main and the
      // branch is deleted. None of this is the session's commit.
      await agentRuns('tu-4', 'gh pr merge --squash --delete-branch && git checkout main', () => {
        git(['checkout', '-q', 'main']);
        git(['merge', '-q', '--squash', 'fix-a']);
        git(['commit', '-q', '-m', 'fix: remove the leftover (#1)']);
        git(['branch', '-q', '-D', 'fix-a']);
      });
      // The turn goes on: fix B on a branch cut from the new main, uncommitted,
      // and Stops.
      await agentRuns('tu-5', 'git checkout -b fix-b', () => { git(['checkout', '-q', '-b', 'fix-b']); });
      await agentWrites('tu-6', 'src/backup.ts', FIX_B);
      reply('A is merged; B is ready.');
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);

      // A background task re-invokes the agent — no new prompt — and it
      // commits B. The command neither writes a file nor moves the tree, so no
      // tool hook re-opens the turn (in df8cc9aa the branch was cut in an
      // earlier re-opening that a task notification's submit then ended).
      await agentRuns('tu-7', 'git add -A && git commit -m "fix: vacuum into"', async () => {
        git(['add', '-A']);
        await hookedGit(['commit', '-q', '-m', 'fix: vacuum into']);
      });
      const shaB = git(['rev-parse', 'HEAD']);
      reply('B is committed.');
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);

      const numstat = git(['diff', '--numstat', base, shaB, '--', 'src/backup.ts']).split('\t');
      const st = sessionState();
      return {
        shaA, shaB,
        want: { added: Number(numstat[0]), removed: Number(numstat[1]) },
        turnIds: st.promptTurnIds || [],
        commitTurns: [...(st.commitTurns || []), ...(st.foldedCommitTurns || [])],
        row0: (st.completedPromptMappings || []).find((r: any) => r.promptIndex === 0),
        lastSent0: sentRows.filter((r) => r.sessionId === `api-${sessionId}` && r.promptIndex === 0).pop(),
        hooksLog: (() => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } })(),
      };
    },

    killJournalWatcher,
  };
}

describe.skipIf(!haveDist)('a commit made after the turn\'s Stop, with no prompt since', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-commit-after-stop-')));
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

  it('is attested to that turn, and the turn\'s row carries both of its commits', async () => {
    const s = scenario('e2e-claude-commit-after-stop-1');
    try {
      await s.setUp(tmp);
      const { shaA, shaB, want, turnIds, commitTurns, row0, lastSent0, hooksLog } = await s.play();
      expect(commitTurns.find((c: any) => c.sha === shaA)?.turnId, 'A (or the record it was folded into) attested to turn 0').toBe(turnIds[0]);
      expect(commitTurns.find((c: any) => c.sha === shaB)?.turnId, 'B, made after the Stop, attested to turn 0').toBe(turnIds[0]);
      // Both commits composed: what the file became, measured from the turn's start.
      expect([row0?.linesAdded, row0?.linesRemoved], 'stored row = base → B').toEqual([want.added, want.removed]);
      expect([lastSent0?.linesAdded, lastSent0?.linesRemoved], 'last row sent = base → B').toEqual([want.added, want.removed]);
      expect(lastSent0?.diff || '').toContain('vacuumInto');
      expect(lastSent0?.diff || '').toContain('removeLeftover');
      // The rule itself fired, not some other path that happens to open the turn.
      expect(hooksLog).toContain('re-opened the closed turn to attest a commit made after its Stop');
    } finally {
      if (process.env.E2E_DUMP) {
        try { fs.copyFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), process.env.E2E_DUMP); } catch { /* no log */ }
      }
      await s.killJournalWatcher();
    }
  }, 600_000 * WINDOWS_SLOWDOWN);
});
