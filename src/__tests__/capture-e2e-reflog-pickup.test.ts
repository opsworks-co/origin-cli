// END-TO-END: attribution read back from git's own record (reflog-pickup.ts),
// through the built binary and real git hooks.
//
//  1. The agent writes a file and its turn Stops; the human commits it from an
//     IDE whose git runs no hooks. The next hooked commit's post-commit finds
//     that commit in the HEAD reflog with no note, and the session's turn
//     window proves it: the note names the session.
//  2. `git reset --soft HEAD~1` and commit again: the dropped commit's note
//     (another session's, written by hand here so only a carry can explain it)
//     reaches the redone commit.
//  3. `git merge --squash feat` and commit: the squashed commit's note reaches
//     the squash commit.
//
// ORIGIN_E2E_BIN=<released dist/index.js> runs the same scenario on a build
// without the change: all three notes stay unattributed.
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

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const u = req.url || '';
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

describe.skipIf(!haveDist)('attribution read back from the reflog and SQUASH_MSG', () => {
  const sessionId = 'e2e-claude-reflog-pickup-1';
  let tmp = '';
  let repo = '';
  let hooksDir = '';
  let transcript = '';
  const lines: string[] = [];

  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' },
  }).trim();
  const hookedGit = (args: string[]): Promise<string> =>
    gitAsync(repo, ['-c', `core.hooksPath=${hooksDir}`, ...args], { env: { ...process.env, GIT_EDITOR: 'true' } });
  const noteOf = (sha: string): any => { try { return JSON.parse(git(['notes', '--ref=origin', 'show', sha])); } catch { return null; } };
  const sessionsOn = (sha: string): string[] => {
    const n = noteOf(sha);
    const ids = new Set<string>((n?.attribution_record?.contributions ?? []).map((c: any) => c.session?.id).filter(Boolean));
    if (n?.origin?.sessionId) ids.add(n.origin.sessionId);
    return [...ids].sort();
  };
  /** post-commit is backgrounded: wait until the note shows what is expected, or time out. */
  async function waitFor(sha: string, ok: (ids: string[]) => boolean): Promise<string[]> {
    const deadline = Date.now() + 60_000 * WINDOWS_SLOWDOWN;
    let ids = sessionsOn(sha);
    while (!ok(ids) && Date.now() < deadline) {
      await sleep(500);
      ids = sessionsOn(sha);
    }
    return ids;
  }
  function annotate(sha: string, id: string) {
    const ref = `https://origin.example.com/sessions/${id}`;
    git(['notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify({
      origin: { version: 1, sessionId: id, agent: 'codex', model: 'gpt-5', promptCount: 1, originUrl: ref },
      attribution_record: {
        schema_version: '1.0', revision: { vcs: 'git', id: sha }, attribution_level: 'commit',
        recorded_at: '2026-10-01T00:00:00Z', producer: { name: 'origin-cli', version: '0.1.0' },
        contributions: [{ evidence: 'session_capture', agent: { id: 'codex' }, model: { id: 'gpt-5' }, session: { id, reference_uri: ref } }],
      },
    }), sha]);
  }

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
  async function agentWrites(id: string, file: string, content: string) {
    const abs = path.join(repo, file);
    const input = { file_path: abs, content };
    expect((await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id })).code).toBe(0);
    fs.writeFileSync(abs, content);
    append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input }] } });
    append({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
    expect((await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } })).code).toBe(0);
  }
  async function killJournalWatcher(): Promise<void> {
    const dir = path.join(os.homedir(), '.origin', 'journals');
    try {
      const lock = fs.readdirSync(dir).find((f) => f.startsWith(sessionId.slice(0, 12)) && f.endsWith('.lock'));
      const pid = lock ? Number(fs.readFileSync(path.join(dir, lock), 'utf-8').trim()) : 0;
      if (pid > 0) process.kill(pid, 'SIGTERM');
    } catch { /* no journal */ }
  }
  const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };

  beforeAll(async () => {
    await startFakeApi();
    // Two commits a few seconds apart must not wait out the minute a real
    // backgrounded post-commit is given.
    process.env.ORIGIN_REFLOG_PICKUP_SETTLE_MS = '0';
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-reflog-pickup-')));
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e',
    }));
    repo = path.join(tmp, 'repo');
    hooksDir = path.join(tmp, 'hooks');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(hooksDir);
    transcript = path.join(tmp, `${sessionId}.jsonl`);
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
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    delete process.env.ORIGIN_REFLOG_PICKUP_SETTLE_MS;
    await killJournalWatcher();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('an IDE commit of the turn\'s work, a reset redone, and a local squash all keep their attribution', async () => {
    try {
      expect((await run('session-start', { source: 'startup' })).code).toBe(0);
      expect((await run('user-prompt-submit', { prompt: 'add the retry helper' })).code).toBe(0);
      append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'add the retry helper' }] } });
      await agentWrites('tu-1', 'retry.ts', 'export function retry() {\n  return 3;\n}\n');
      append({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added retry.ts.' }] } });
      expect((await run('stop', {})).code).toBe(0);

      // 1. The human commits the agent's file from an IDE: no hook runs.
      git(['add', 'retry.ts']);
      git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'add retry (from the IDE)']);
      const ide = git(['rev-parse', 'HEAD']);
      expect(noteOf(ide), 'no hook ran for the IDE commit').toBeNull();
      // The next commit that does run the hooks looks back.
      fs.writeFileSync(path.join(repo, 'notes.md'), 'by hand\n');
      git(['add', 'notes.md']);
      await hookedGit(['commit', '-q', '-m', 'notes']);
      const ideIds = await waitFor(ide, (ids) => ids.length > 0);
      expect(ideIds, 'the IDE commit is the session\'s, proved by its turn window').toEqual([`api-${sessionId}`]);
      expect(hooksLog()).toContain('unseen commit attributed by its turn window');

      // 2. Reset and redo: the dropped commit's note is carried.
      fs.writeFileSync(path.join(repo, 'dropped.txt'), 'dropped\n');
      git(['add', 'dropped.txt']);
      git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'to be redone']);
      const dropped = git(['rev-parse', 'HEAD']);
      annotate(dropped, 'sess-redo');
      git(['reset', '-q', '--soft', 'HEAD~1']);
      await hookedGit(['commit', '-q', '-m', 'redone']);
      const redone = git(['rev-parse', 'HEAD']);
      expect(await waitFor(redone, (ids) => ids.includes('sess-redo'))).toContain('sess-redo');

      // 3. A local squash merge: the squashed commit's note is carried.
      git(['checkout', '-q', '-b', 'feat']);
      fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature\n');
      git(['add', 'feat.txt']);
      git(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'feature']);
      const feat = git(['rev-parse', 'HEAD']);
      annotate(feat, 'sess-squashed');
      git(['checkout', '-q', 'main']);
      git(['merge', '-q', '--squash', 'feat']);
      await hookedGit(['commit', '-q', '-m', 'squash feat']);
      const squash = git(['rev-parse', 'HEAD']);
      expect(await waitFor(squash, (ids) => ids.includes('sess-squashed'))).toContain('sess-squashed');
    } finally {
      if (process.env.E2E_DUMP) {
        try { fs.copyFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), process.env.E2E_DUMP); } catch { /* no log */ }
      }
    }
  }, 600_000 * WINDOWS_SLOWDOWN);
});
