// END-TO-END, the BUILT binary: a script-driven write in a linked worktree,
// while a live sibling in the MAIN checkout has the same repo-relative path
// open.
//
// This is session 97846e3a (Cursor, worktree `cursor-resume-turn-numbering`).
// Its turn ran `node packages/cli/scripts/version-bump.cjs`, so the +1/-1 on
// `packages/cli/package.json` had no Edit/Write tool call behind it and the
// turn window was the only path that could see it. The window DID see it and
// logged it as skipped:
//
//   [stop] shell window edits captured {"promptIndex":0,"files":1,"skipped":4,
//     "skipReasons":{"ignored":1,"foreign":["packages/cli/package.json", …]}}
//
// `foreign` because three live siblings — two in
// `.claude/worktrees/memory-todo-review-9b9248`, one in
// `~/.cursor/worktrees/origin/05c3` — carried that path in their own claims.
// None of them could have written OUR copy of it; a worktree's
// `packages/cli/package.json` is a different file on disk. The bump reached
// the session header (post-commit reads git) and no turn's capture, which is
// the `header_file_unclaimed_by_turns` contradiction `verify-capture` reports.
// Stored rows are final, so it blocks `release:cli:check` permanently.
//
// The journal is switched OFF for the worktree session on purpose. That is the
// state 97846e3a was actually in — its journal recorded one turn mark and zero
// writes — and it leaves the turn window as the sole evidence path, which is
// the path under test. With a journal running, `recordJournalEdits` would
// claim the file first and the defect would be invisible here.
//
// Requires `dist/`. POSIX-only, like the other harnesses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const MAIN_API = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';
const WT_API = 'bbbbbbbb-4444-4444-8444-bbbbbbbbbbbb';
const MAIN_CONV = 'e2e-xwt-main-conv-0001';
const WT_CONV = 'd0d0cafe-e2e0-5555-6666-777788889999';

const BUMPED = 'packages/cli/package.json';
const BUMPER = 'packages/cli/scripts/version-bump.cjs';

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
          res.end(JSON.stringify({ sessionId: starts === 1 ? MAIN_API : WT_API, verboseCapture: false }));
        } else if (u.startsWith('/api/pricing')) {
          res.end(JSON.stringify({ models: {} }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

let tmp = '';
let repo = '';
let wt = '';
let mainTranscript = '';
let wtTranscript = '';
const mainLines: string[] = [];
const wtLines: string[] = [];

/** The sibling: a Claude Code session living in the MAIN checkout. */
function runMain(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'claude-code', event], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({
    session_id: MAIN_CONV, transcript_path: mainTranscript, cwd: repo, hook_event_name: event, ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

/** Ours: a Cursor session whose workspace root is the LINKED WORKTREE. */
let wtTurn = 0;
function runWt(event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'cursor', event], {
    cwd: wt,
    // See the header: 97846e3a had no journal evidence, and the turn window is
    // the path this test is about.
    env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1', ORIGIN_WRITE_JOURNAL: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({
    conversation_id: WT_CONV,
    generation_id: `gen-${wtTurn}`,
    model: 'cursor-e2e-model',
    model_id: 'e2e-model',
    composer_mode: 'agent',
    session_id: `e2e-xwt-turn-${wtTurn}`,
    hook_event_name: event,
    cursor_version: '2.6.0',
    workspace_roots: [wt],
    cwd: wt,
    transcript_path: wtTranscript,
    ...payload,
  }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sayMain(text: string) {
  mainLines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(mainTranscript, mainLines.join('\n') + '\n');
}
function mainToolUse(id: string, name: string, input: Record<string, unknown>) {
  mainLines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  mainLines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  fs.writeFileSync(mainTranscript, mainLines.join('\n') + '\n');
}
function sayWt(text: string) {
  wtLines.push(JSON.stringify({ role: 'user', content: text }));
  fs.writeFileSync(wtTranscript, wtLines.join('\n') + '\n');
}

/**
 * Every file the MAIN-checkout sibling claims, read from its state file in the
 * common git dir — the same registry `uncommittedExcludeUnion` walks.
 */
function siblingClaims(): string[] {
  const gitDir = path.join(repo, '.git');
  const out: string[] = [];
  for (const f of fs.readdirSync(gitDir).filter((n) => n.startsWith('origin-session') && n.endsWith('.json'))) {
    let st: any;
    try { st = JSON.parse(fs.readFileSync(path.join(gitDir, f), 'utf-8')); } catch { continue; }
    if (st?.claudeSessionId !== MAIN_CONV && st?.agentSessionId !== MAIN_CONV) continue;
    for (const m of st.completedPromptMappings || []) out.push(...(m.filesChanged || []));
    for (const b of st.liveEdits || []) for (const e of b.edits || []) if (e?.file) out.push(e.file);
  }
  return out.map((f) => (path.isAbsolute(f) ? path.relative(repo, f) : f));
}

function rowsFor(sessionId: string): any[] {
  const p = hits
    .filter((h) => h.method === 'PATCH' && h.url.includes(sessionId) && Array.isArray(h.body?.promptChanges))
    .map((h) => h.body.promptChanges);
  return p.length ? p[p.length - 1] : [];
}

describe.skipIf(!haveDist)('a script-driven write in a worktree survives a sibling in the main checkout', () => {
  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-xwt-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'packages', 'cli', 'scripts'), { recursive: true });

    mainTranscript = path.join(tmp, `${MAIN_CONV}.jsonl`);
    fs.writeFileSync(mainTranscript, '');
    const tdir = path.join(tmp, 'agent-transcripts', WT_CONV);
    fs.mkdirSync(tdir, { recursive: true });
    wtTranscript = path.join(tdir, `${WT_CONV}.jsonl`);
    fs.writeFileSync(wtTranscript, '');

    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({
      apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer',
    }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({
      machineId: 'machine-e2e-xwt', hostname: 'e2e', detectedTools: ['claude', 'cursor'], orgId: 'org-e2e',
    }));

    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'E2E']);
    git(repo, ['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    fs.writeFileSync(path.join(repo, BUMPED), JSON.stringify({ name: '@origin/cli', version: '0.20260909.2214' }, null, 2) + '\n');
    // The real script: it derives the path itself, so the command text that
    // runs it never NAMES the file. That is what leaves the write with only
    // window evidence — `command_named` would have rescued it.
    fs.writeFileSync(path.join(repo, BUMPER), [
      'const fs = require("fs");',
      'const path = require("path");',
      'const p = path.join(__dirname, "..", "package.json");',
      'const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));',
      'pkg.version = "0.20260909.2300";',
      'fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\\n");',
    ].join('\n') + '\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);

    wt = path.join(tmp, 'linked');
    git(repo, ['worktree', 'add', '-q', '-b', 'feature', wt]);
    wt = fs.realpathSync.native(wt);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { /* ignore */ }
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the sibling in the main checkout claims packages/cli/package.json', async () => {
    const start = await runMain('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    sayMain('bump the version here too');
    const ups = await runMain('user-prompt-submit', { prompt: 'bump the version here too' });
    expect(ups.code, ups.stderr).toBe(0);

    const abs = path.join(repo, BUMPED);
    const content = JSON.stringify({ name: '@origin/cli', version: '0.20260909.2299' }, null, 2) + '\n';
    const input = { file_path: abs, content };
    await runMain('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: 'm-1' });
    fs.writeFileSync(abs, content);
    mainToolUse('m-1', 'Write', input);
    await runMain('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: 'm-1', tool_response: { filePath: abs, success: true } });
    const stop = await runMain('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    if (process.env.E2E_DUMP) {
      console.log('--- hits ---');
      for (const h of hits) console.log(h.method, h.url, JSON.stringify(h.body).slice(0, 400));
    }
    // It really did claim the contested path — otherwise the rest of this test
    // proves nothing. Asserted on the STATE FILE, not the API: the state files
    // in the common git dir are what `uncommittedExcludeUnion` actually reads.
    expect(siblingClaims()).toContain(BUMPED);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('the worktree turn keeps its own version bump', async () => {
    wtTurn = 1;
    const start = await runWt('session-start', { source: 'startup' });
    expect(start.code, start.stderr).toBe(0);

    sayWt('bump the CLI version and open a PR');
    const ups = await runWt('user-prompt-submit', { prompt: 'bump the CLI version and open a PR' });
    expect(ups.code, ups.stderr).toBe(0);

    // The write: a spawned child process, no tool call, no afterFileEdit hook.
    execFileSync(process.execPath, [path.join(wt, BUMPER)], { cwd: wt });
    expect(JSON.parse(fs.readFileSync(path.join(wt, BUMPED), 'utf-8')).version).toBe('0.20260909.2300');
    await sleep(300);

    const stop = await runWt('stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);

    const rows = rowsFor(WT_API);
    expect(rows.length, 'the worktree session sent no rows').toBeGreaterThan(0);
    const turn0 = rows.find((r: any) => r.promptIndex === 0);
    expect(turn0, 'no row for turn 0').toBeTruthy();
    expect(
      turn0.filesChanged || [],
      'the version bump was dropped from the turn — the sibling in the main checkout took it',
    ).toContain(BUMPED);
    // The turn claims its own file and not the sibling's other work.
    expect(turn0.filesChanged).toEqual([BUMPED]);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
