// END-TO-END: a commit a rebase or cherry-pick replays is not the turn's work.
//
// git runs prepare-commit-msg and post-commit for every commit a rebase or a
// cherry-pick writes. Session 6c21a6d8 (2026-09-16) merged other agents' PRs by
// rebasing their branches, and took them over: prepare-commit-msg stamped its
// own `Origin-Session` trailer on Codex's trailer-less commits, post-commit
// recorded every replayed copy on the session and attested it to the running
// turn, and a turn that wrote no code read +581/-15.
//
// Driven through the built binary with Origin's git hooks wired by
// `core.hooksPath`, as `origin enable --global` wires them. The session's own
// commit is the control: it must still get the trailer and the attestation.
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
const SESSION_ID = 'e2e-claude-replay-session-1';
const API_SESSION = 'e2e-replay-session-0001';

let server: http.Server;
let apiUrl = '';
let repo = '';
let hooksDir = '';
let transcript = '';

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
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

const git = (args: string[], opts: { hooks?: boolean; env?: Record<string, string> } = {}): string =>
  execFileSync('git', [...(opts.hooks ? ['-c', `core.hooksPath=${hooksDir}`] : []), ...args], {
    cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true', ...(opts.env || {}) },
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
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

/** The agent writes through its Write tool, so the running turn holds the file. */
async function agentWrites(id: string, file: string, content: string) {
  const abs = path.join(repo, file);
  const input = { file_path: abs, content };
  expect((await run('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id })).code).toBe(0);
  fs.writeFileSync(abs, content);
  toolUse(id, 'Write', input);
  expect((await run('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } })).code).toBe(0);
}

/** The session-start journal watcher outlives the test unless it is stopped. */
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

function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}

/** Another agent's commit, made before this session with no Origin hooks — no trailer. */
function strangersCommit(file: string, subject: string): string {
  fs.writeFileSync(path.join(repo, file), `export const ${file.replace(/\W/g, '_')} = 1;\n`);
  git(['add', '-A']);
  git(['commit', '-q', '-m', subject]);
  return git(['rev-parse', 'HEAD']);
}

function sessionState(): any {
  const dir = git(['rev-parse', '--git-common-dir']);
  const abs = path.isAbsolute(dir) ? dir : path.join(repo, dir);
  const file = fs.readdirSync(abs).find((f) => f.startsWith('origin-session') && f.endsWith('.json'));
  expect(file, 'no session state file').toBeTruthy();
  return JSON.parse(fs.readFileSync(path.join(abs, file!), 'utf-8'));
}

const trailerOf = (sha: string) => (git(['show', '-s', '--format=%B', sha]).match(/^Origin-Session: .*$/m) || [''])[0];
const noteOn = (sha: string): string | null => { try { return git(['notes', '--ref=origin', 'show', sha]); } catch { return null; } };
const recorded = (state: any, sha: string) => (state.sessionCommitShas || []).some((s: string) => sha.startsWith(s) || s.startsWith(sha));
const attested = (state: any, sha: string) => (state.commitTurns || []).some((c: any) => sha.startsWith(c.sha) || c.sha.startsWith(sha));

describe.skipIf(!haveDist)('a replayed commit through the built binary', () => {
  let tmp = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-replay-')));
    repo = path.join(tmp, 'repo');
    hooksDir = path.join(tmp, 'hooks');
    fs.mkdirSync(repo);
    fs.mkdirSync(hooksDir);
    transcript = path.join(tmp, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, '');
    // Foreground here, so each assertion sees the hook's work already done.
    // The fix does not depend on it: the reflog still names a replay after the
    // rebase has finished, which is when the real, backgrounded hook reads it.
    for (const [name, args] of [
      ['prepare-commit-msg', 'git-prepare-commit-msg "$1" "$2" "$3"'],
      ['post-commit', 'git-post-commit'],
    ] as const) {
      fs.writeFileSync(path.join(hooksDir, name), `#!/bin/sh\n"${process.execPath}" "${BIN}" hooks ${args} >/dev/null 2>&1 || true\n`, { mode: 0o755 });
    }

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
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    // holdIdleConnections keeps the hooks' keep-alive sockets open; close() waits on them.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('keeps the session\'s own commit and takes none of the replayed copies', async () => {
    // Two other agents' work, on their own branches, before the session.
    git(['checkout', '-q', '-b', 'codex/track-created-worktrees']);
    strangersCommit('worktrees.ts', 'fix(capture): track worktrees created mid-session');
    git(['checkout', '-q', '-b', 'codex/release-gate', 'main']);
    const picked = strangersCommit('release.ts', 'fix(release): keep explicitly ended sessions final');
    git(['checkout', '-q', 'main']);

    expect((await run('session-start', { source: 'startup' })).code).toBe(0);
    say('review and merge the open PRs');
    expect((await run('user-prompt-submit', { prompt: 'review and merge the open PRs' })).code).toBe(0);
    // The turn's own commit — the control.
    await agentWrites('tu-1', 'version.txt', '0.20260916.307\n');
    const bump = { tool_name: 'Bash', tool_input: { command: 'commit the bump, rebase and cherry-pick the PRs' }, tool_use_id: 'tu-2' };
    expect((await run('pre-tool-use', bump)).code).toBe(0);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'chore(cli): bump version'], { hooks: true });
    const own = git(['rev-parse', 'HEAD']);

    // Rebase the stranger's branch onto the session's commit…
    git(['checkout', '-q', 'codex/track-created-worktrees']);
    git(['rebase', '-q', 'main'], { hooks: true });
    const rebased = git(['rev-parse', 'HEAD']);
    expect(git(['show', '-s', '--format=%s', rebased])).toBe('fix(capture): track worktrees created mid-session');

    // …and cherry-pick the other one onto main.
    git(['checkout', '-q', 'main']);
    git(['cherry-pick', picked], { hooks: true });
    const cherryPicked = git(['rev-parse', 'HEAD']);
    expect(cherryPicked).not.toBe(picked);

    expect((await run('post-tool-use', { ...bump, tool_response: { stdout: '', stderr: '' } })).code).toBe(0);

    const state = sessionState();

    // Control: the session's own commit is still the session's and the turn's.
    expect(trailerOf(own), 'the session\'s own commit lost its trailer').toMatch(/^Origin-Session: /);
    expect(recorded(state, own), 'the session\'s own commit is not recorded').toBe(true);
    expect(attested(state, own), 'the session\'s own commit is not attested to the turn').toBe(true);

    for (const [what, sha] of [['rebased', rebased], ['cherry-picked', cherryPicked]] as const) {
      expect(trailerOf(sha), `the ${what} copy was stamped with this session's trailer`).toBe('');
      expect(recorded(state, sha), `the ${what} copy was recorded on the session`).toBe(false);
      expect(attested(state, sha), `the ${what} copy was attested to the turn`).toBe(false);
      expect(noteOn(sha), `the ${what} copy carries this session's note`).toBeNull();
    }
  }, 600_000 * WINDOWS_SLOWDOWN);
});
