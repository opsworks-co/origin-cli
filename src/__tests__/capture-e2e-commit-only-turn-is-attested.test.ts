// END-TO-END: a turn that only runs `git commit` gets the commit attested to it,
// and gains none of the earlier turn's content.
//
// Session df8cc9aa (2026-10-01). Turn 4 wrote hooks.ts + three tests and left
// them uncommitted; turn 6 committed them. A turn whose only act is the
// commit has no captures of its own, so nothing opened it and post-commit
// recorded the commit with "(no active turn)": no turn attested, nothing for
// the server's commit attestation or its git-only content match (#1482) to
// place. post-commit now opens the running turn when that turn's in-flight
// shell call commits (runningTurnIsCommitting).
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
const sentRows: Array<{ sessionId: string; promptIndex: number; filesChanged?: string[]; diff?: string; commitSha?: string | null }> = [];

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


function scenario(sessionId: string) {
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
      fs.writeFileSync(path.join(repo, 'src/scope.ts'), 'export const scope = 1;\n');
      git(['add', '.']);
      git(['commit', '-q', '-m', 'base']);
    },

    async play() {
      expect((await run('session-start', { source: 'startup' })).code).toBe(0);

      // Turn 0 writes two files and leaves them uncommitted.
      expect((await run('user-prompt-submit', { prompt: 'fix the scope' })).code).toBe(0);
      say('fix the scope');
      await agentWrites('tu-1', 'src/scope.ts', 'export const scope = 2;\nexport const reason = "turn zero wrote this";\n');
      await agentWrites('tu-2', 'src/route.ts', 'export const route = "turn zero added this file";\n');
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);

      // Turn 1 only commits.
      expect((await run('user-prompt-submit', { prompt: 'commit it' })).code).toBe(0);
      say('commit it');
      await agentRuns('tu-3', 'git add -A && git commit -m fix', async () => {
        git(['add', '-A']);
        await hookedGit(['commit', '-q', '-m', 'fix: the scope']);
      });
      const sha = git(['rev-parse', 'HEAD']);
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);
      const atItsStop = (sessionState().completedPromptMappings || []).find((r: any) => r.promptIndex === 1);

      // A later turn re-derives every row at its Stop.
      expect((await run('user-prompt-submit', { prompt: 'thanks' })).code).toBe(0);
      say('thanks');
      append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
      expect((await run('stop', {})).code).toBe(0);
      await sleep(500);

      const st = sessionState();
      const rows = st.completedPromptMappings || [];
      return {
        sha,
        turn0: rows.find((r: any) => r.promptIndex === 0),
        turn1: rows.find((r: any) => r.promptIndex === 1),
        turnIds: st.promptTurnIds || [],
        commitTurns: st.commitTurns || [],
        sentWithCommit: sentRows.filter((r: any) => r.sessionId === `api-${sessionId}` && r.commitSha === sha),
        atItsStop,
        lastSent1: sentRows.filter((r: any) => r.sessionId === `api-${sessionId}` && r.promptIndex === 1).pop(),
      };
    },

    killJournalWatcher,
  };
}

describe.skipIf(!haveDist)('a turn that only commits an earlier turn\'s work', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-commit-only-')));
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

  it('attests the commit to the turn that ran it, keeps it there, and moves no content onto it', async () => {
    const s = scenario('e2e-claude-commit-only-turn-1');
    try {
      await s.setUp(tmp);
      const { sha, turn0, turn1, turnIds, commitTurns, sentWithCommit, atItsStop, lastSent1 } = await s.play();
      const attested = commitTurns.find((c: any) => c.sha === sha);
      expect(attested?.turnId, 'attested to turn 1').toBe(turnIds[1]);
      expect(sentWithCommit.map((r: any) => r.promptIndex), 'post-commit sends the commit with turn 1').toContain(1);
      // The card sits under the committing turn: its stamp survives its own
      // Stop and a later one, and is never handed to turn 0.
      expect(atItsStop?.commitSha, 'turn 1 at its own Stop').toBe(sha);
      expect(turn1?.commitSha, 'turn 1 after a later Stop').toBe(sha);
      expect(lastSent1?.commitSha, 'the last row sent for turn 1').toBe(sha);
      expect(turn0?.commitSha ?? null, 'turn 0 does not take it').toBeNull();
      expect(turn1?.filesChanged || [], 'the committing turn wrote nothing').toEqual([]);
      expect(turn1?.diff || '').not.toContain('turn zero');
      expect(turn0?.filesChanged, 'turn 0 keeps its own files').toEqual(expect.arrayContaining(['src/scope.ts', 'src/route.ts']));
    } finally {
      await s.killJournalWatcher();
    }
  }, 600_000 * WINDOWS_SLOWDOWN);
});
