// END-TO-END: the BUILT binary, a merge session that replays a live sibling's
// commit into its own worktree and fast-forwards over a GitHub squash.
//
// Neither commit is the merge session's. The sibling's replayed commit keeps
// the sibling's `Origin-Session` trailer first (prepare-commit-msg appends the
// merge session's after it), and the squash is committed by GitHub. Every
// payload the merge session sends must leave both out: a sha in
// `gitCapture.commitShas` or `gitCapture.commitDetails` links the Commit row
// to the session for good, and the header then counts it.
//
// Prod session 6c21a6d8 (2026-09-16) authored 4 small commits and served 45.
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

const SIB_API = 'cccccccc-3333-4333-8333-cccccccccccc';
const MERGE_API = 'dddddddd-4444-4444-8444-dddddddddddd';
const SIB_CONV = 'e2e-claude-sibling-conv-0001';
const MERGE_CONV = 'e2e-claude-merge-conv-0002';
const PULL_API = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
// A Gemini session: Claude Code's SessionEnd is handled as a Stop, Gemini's
// reaches the session-end body.
const PULL_CONV = 'e2e-gemini-pull-conv-0003';
const GEMINI_EVENT: Record<string, string> = {
  'session-start': 'SessionStart', 'user-prompt-submit': 'BeforeAgent', stop: 'AfterAgent', 'session-end': 'SessionEnd',
};

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
          res.end(JSON.stringify({ sessionId: [SIB_API, MERGE_API, PULL_API][starts - 1], verboseCapture: false }));
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

let tmp = '';
let repo = '';
let wtSib = '';
let wtMerge = '';
let wtPull = '';
const transcripts: Record<string, string> = {};
const lines: Record<string, string[]> = { [SIB_CONV]: [], [MERGE_CONV]: [], [PULL_CONV]: [] };

function run(cwd: string, conv: string, event: string, payload: Record<string, unknown> = {}): Promise<{ code: number | null; stderr: string }> {
  const gemini = conv === PULL_CONV;
  if (gemini) payload = { hook_event_name: GEMINI_EVENT[event], timestamp: new Date().toISOString(), ...payload };
  const child = spawn(process.execPath, [BIN, 'hooks', gemini ? 'gemini' : 'claude-code', event], {
    cwd, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* context injection */ });
  child.stdin.end(JSON.stringify({ session_id: conv, transcript_path: transcripts[conv], cwd, hook_event_name: event, ...payload }));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
function gitHook(cwd: string, name: string, args: string[] = []): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name, ...args], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}
const git = (cwd: string, args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };
function say(conv: string, text: string) {
  if (conv === PULL_CONV) {
    lines[conv].push(JSON.stringify({ id: `u-${lines[conv].length}`, timestamp: new Date().toISOString(), type: 'user', content: [{ text }] }));
    fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
    return;
  }
  lines[conv].push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
function toolUse(conv: string, id: string, name: string, input: Record<string, unknown>, output = 'ok') {
  lines[conv].push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
  lines[conv].push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] } }));
  fs.writeFileSync(transcripts[conv], lines[conv].join('\n') + '\n');
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function killJournalWatchers(): Promise<void> {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    let killed = false;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))) {
      try { const pid = Number(fs.readFileSync(path.join(dir, f), 'utf-8').trim()); if (pid > 0) { process.kill(pid, 'SIGTERM'); killed = true; } } catch { /* none */ }
    }
    if (killed) return;
    await sleep(250);
  }
}

/** Write a file through a Write tool call, as Claude Code does. */
async function writeTool(cwd: string, conv: string, id: string, rel: string, content: string) {
  const abs = path.join(cwd, rel);
  const input = { file_path: abs, content };
  await run(cwd, conv, 'pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  toolUse(conv, id, 'Write', input);
  await run(cwd, conv, 'post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: id, tool_response: { filePath: abs, success: true } });
}

/** `git commit` with the real prepare-commit-msg and post-commit hooks. */
async function commitWithHooks(cwd: string, message: string, extraCommitArgs: string[] = []): Promise<string> {
  const gitDir = git(cwd, ['rev-parse', '--git-dir']);
  const msgFile = path.resolve(cwd, gitDir, 'COMMIT_EDITMSG');
  fs.writeFileSync(msgFile, message);
  const pcm = await gitHook(cwd, 'git-prepare-commit-msg', [msgFile]);
  expect(pcm.code, pcm.stderr).toBe(0);
  git(cwd, ['commit', '-q', '--allow-empty', ...extraCommitArgs, '-F', msgFile]);
  const pc = await gitHook(cwd, 'git-post-commit');
  expect(pc.code, pc.stderr).toBe(0);
  return git(cwd, ['rev-parse', 'HEAD']);
}

const sent = (sessionId: string) => hits.filter((h) => h.url.includes(sessionId) || h.body?.sessionId === sessionId);
/** Every sha any payload to this session put in a gitCapture. */
function capturedShas(sessionId: string): Array<{ sha: string; where: string; url: string }> {
  const out: Array<{ sha: string; where: string; url: string }> = [];
  for (const h of sent(sessionId)) {
    const gc = h.body?.gitCapture;
    if (!gc) continue;
    for (const s of gc.commitShas || []) out.push({ sha: s, where: 'commitShas', url: `${h.method} ${h.url}` });
    for (const d of gc.commitDetails || []) out.push({ sha: d.sha, where: 'commitDetails', url: `${h.method} ${h.url}` });
  }
  // A mirrored git note links the Commit row to the session it names: the
  // server's import-note sets Commit.sessionId when that session exists.
  for (const h of hits) {
    if (h.method === 'POST' && h.url === `/api/sessions/${sessionId}/import-note` && h.body?.sha) {
      out.push({ sha: h.body.sha, where: 'import-note', url: `${h.method} ${h.url}` });
    }
  }
  return out;
}
/** The session the commit's local `refs/notes/origin` note names, if any. */
function noteSession(cwd: string, sha: string): string | null {
  try { return JSON.parse(git(cwd, ['notes', '--ref=origin', 'show', sha]))?.origin?.sessionId ?? null; } catch { return null; }
}
const same = (a: string, b: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

describe.skipIf(!haveDist)('a merge session does not claim the commits it replays or pulls', () => {
  let own = '';
  let sibling = '';
  let replayed = '';
  let squash = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-foreign-')));
    repo = path.join(tmp, 'repo');
    wtSib = path.join(tmp, 'wt-sibling');
    wtMerge = path.join(tmp, 'wt-merge');
    wtPull = path.join(tmp, 'wt-pull');
    fs.mkdirSync(repo, { recursive: true });
    for (const c of [SIB_CONV, MERGE_CONV, PULL_CONV]) { transcripts[c] = path.join(tmp, `${c}.jsonl`); fs.writeFileSync(transcripts[c], ''); }
    const originDir = path.join(os.homedir(), '.origin');
    fs.mkdirSync(originDir, { recursive: true });
    fs.writeFileSync(path.join(originDir, 'config.json'), JSON.stringify({ apiUrl, apiKey: 'org_sk_e2e_test_key', orgId: 'org-e2e', keyType: 'team', accountType: 'developer' }));
    fs.writeFileSync(path.join(originDir, 'agent.json'), JSON.stringify({ machineId: 'machine-e2e-foreign', hostname: 'e2e', detectedTools: ['claude'], orgId: 'org-e2e' }));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'E2E']);
    git(repo, ['config', 'user.email', 'e2e@example.com']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'base']);
    git(repo, ['worktree', 'add', '-q', '-b', 'sibling-pr', wtSib]);
    git(repo, ['worktree', 'add', '-q', '-b', 'merge-work', wtMerge]);
    git(repo, ['worktree', 'add', '-q', '-b', 'pull-only', wtPull]);
    // Committer dates have one-second resolution, and ownership refuses any
    // commit older than the session.
    await sleep(1100);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatchers();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the three sessions register, one per worktree', async () => {
    const a = await run(wtSib, SIB_CONV, 'session-start', { source: 'startup' });
    expect(a.code, a.stderr).toBe(0);
    const b = await run(wtMerge, MERGE_CONV, 'session-start', { source: 'startup' });
    expect(b.code, b.stderr).toBe(0);
    const c = await run(wtPull, PULL_CONV, 'session-start', { source: 'startup' });
    expect(c.code, c.stderr).toBe(0);
    expect(starts).toBe(3);
    await sleep(1100);
  }, 60_000 * WINDOWS_SLOWDOWN);

  it('the sibling commits its own work on its PR branch', async () => {
    say(SIB_CONV, 'add the sibling feature and commit');
    await run(wtSib, SIB_CONV, 'user-prompt-submit', { prompt: 'add the sibling feature and commit' });
    await writeTool(wtSib, SIB_CONV, 's-1', 'src/sibling.ts', 'export const sibling = 1;\n');
    git(wtSib, ['add', '-A']);
    sibling = await commitWithHooks(wtSib, 'feat: sibling feature\n');
    expect(git(wtSib, ['log', '-1', '--format=%B'])).toContain(`Origin-Session: ${SIB_API.slice(0, 12)}`);
    toolUse(SIB_CONV, 's-2', 'Bash', { command: 'git add -A && git commit -m "feat: sibling feature"' });
    await run(wtSib, SIB_CONV, 'stop', { stop_hook_active: false });
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('the merge session commits its own work', async () => {
    say(MERGE_CONV, 'write the merge notes and commit');
    await run(wtMerge, MERGE_CONV, 'user-prompt-submit', { prompt: 'write the merge notes and commit' });
    await writeTool(wtMerge, MERGE_CONV, 'm-1', 'src/own.ts', 'export const own = 1;\n');
    git(wtMerge, ['add', '-A']);
    own = await commitWithHooks(wtMerge, 'feat: own work\n');
    toolUse(MERGE_CONV, 'm-2', 'Bash', { command: 'git add -A && git commit -m "feat: own work"' });
    const stop = await run(wtMerge, MERGE_CONV, 'stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);
    expect(capturedShas(MERGE_API).some((c) => same(c.sha, own)), 'the merge session never sent its own commit').toBe(true);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('the merge session replays the sibling commit and fast-forwards over a GitHub squash', async () => {
    say(MERGE_CONV, 'rebase the sibling PR onto our branch and pull main');
    await run(wtMerge, MERGE_CONV, 'user-prompt-submit', { prompt: 'rebase the sibling PR onto our branch and pull main' });
    await sleep(1100);

    // `git cherry-pick` keeps the sibling's message; prepare-commit-msg then
    // appends the merge session's own trailer after the sibling's.
    const cmd = `git cherry-pick ${sibling.slice(0, 9)}`;
    await run(wtMerge, MERGE_CONV, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'm-3' });
    git(wtMerge, ['cherry-pick', '-n', sibling]);
    replayed = await commitWithHooks(wtMerge, git(wtMerge, ['log', '-1', '--format=%B', sibling]) + '\n');
    const replayedBody = git(wtMerge, ['log', '-1', '--format=%B', replayed]);
    expect(replayedBody.indexOf(SIB_API.slice(0, 12)), 'the replay does not name the sibling first').toBeGreaterThanOrEqual(0);
    expect(hooksLog()).toContain('SKIP recording: trailer names another live session');
    toolUse(MERGE_CONV, 'm-3', 'Bash', { command: cmd }, `[merge-work ${replayed.slice(0, 7)}] feat: sibling feature\n 1 file changed, 1 insertion(+)`);
    await run(wtMerge, MERGE_CONV, 'post-tool-use', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'm-3', tool_response: { stdout: `[merge-work ${replayed.slice(0, 7)}] feat: sibling feature`, stderr: '' } });

    // A squash-merge of somebody else's PR, committed by GitHub, arriving by a
    // fast-forward pull. No trailer, and no post-commit: a pull runs none.
    await sleep(1100);
    fs.writeFileSync(path.join(wtMerge, '.probe'), '');
    const tree = git(wtMerge, ['write-tree']);
    const parent = git(wtMerge, ['rev-parse', 'HEAD']);
    // A squash's tree carries a real change; build it in a throwaway index.
    const idx = path.join(tmp, 'squash-index');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: wtMerge, input: 'export const upstream = 1;\n', encoding: 'utf-8' }).trim();
    git(wtMerge, ['read-tree', tree], { GIT_INDEX_FILE: idx });
    git(wtMerge, ['update-index', '--add', '--cacheinfo', `100644,${blob},src/upstream.ts`], { GIT_INDEX_FILE: idx });
    const squashTree = git(wtMerge, ['write-tree'], { GIT_INDEX_FILE: idx });
    squash = execFileSync('git', ['commit-tree', squashTree, '-p', parent, '-m', 'fix: upstream change (#99)'], {
      cwd: wtMerge, encoding: 'utf-8',
      env: { ...process.env, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com' },
    }).trim();
    git(wtMerge, ['merge', '-q', '--ff-only', squash]);
    toolUse(MERGE_CONV, 'm-4', 'Bash', { command: 'git pull --ff-only' }, 'Fast-forward');

    const stop = await run(wtMerge, MERGE_CONV, 'stop', { stop_hook_active: false });
    expect(stop.code, stop.stderr).toBe(0);
  }, 180_000 * WINDOWS_SLOWDOWN);

  it('no payload the merge session sent carries the replayed commit or the squash', () => {
    const all = capturedShas(MERGE_API);
    const leaked = all.filter((c) => same(c.sha, replayed) || same(c.sha, squash) || same(c.sha, sibling))
      .map((c) => `${c.url} ${c.where} ${c.sha.slice(0, 8)}${same(c.sha, squash) ? ' (squash)' : ' (sibling)'}`);
    expect(leaked, 'foreign commits reached the merge session').toEqual([]);
    expect(all.some((c) => same(c.sha, own))).toBe(true);
    expect(noteSession(wtMerge, replayed), 'the replayed commit\'s note names the merge session').not.toBe(MERGE_API);
    expect(noteSession(wtMerge, squash), 'the squash\'s note names the merge session').not.toBe(MERGE_API);
    expect(noteSession(wtMerge, own)).toBe(MERGE_API);
  });

  it('session end sends neither', async () => {
    const end = await run(wtMerge, MERGE_CONV, 'session-end', { reason: 'other' });
    expect(end.code, end.stderr).toBe(0);
    const leaked = capturedShas(MERGE_API).filter((c) => same(c.sha, replayed) || same(c.sha, squash) || same(c.sha, sibling))
      .map((c) => `${c.url} ${c.where} ${c.sha.slice(0, 8)}`);
    expect(leaked, 'foreign commits reached the merge session at session end').toEqual([]);
    expect(noteSession(wtMerge, replayed)).not.toBe(MERGE_API);
    expect(noteSession(wtMerge, squash)).not.toBe(MERGE_API);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('the replayed commit does not put an origin-sessions entry on the merge session', () => {
    // post-commit publishes the session's origin-sessions entry on every
    // commit. For a commit it just refused as another session's, that entry
    // must not name the commit.
    let listing = '';
    try { listing = git(repo, ['log', 'origin-sessions', '--format=%H']); } catch { return; }
    for (const commit of listing.split('\n').filter(Boolean)) {
      let files = '';
      try { files = git(repo, ['show', '--name-only', '--format=', commit]); } catch { continue; }
      for (const f of files.split('\n').filter((x) => x.includes(MERGE_API.slice(0, 8)) && x.endsWith('.json'))) {
        let content = '';
        try { content = git(repo, ['show', `${commit}:${f}`]); } catch { continue; }
        expect(content.includes(replayed), `origin-sessions ${f} at ${commit.slice(0, 8)} names the replayed commit`).toBe(false);
      }
    }
  });

  it('a session that commits nothing and only pulls names none of the pulled commits at session end', async () => {
    // session-end has no authored snapshot to send for this session, so the
    // payload and the git notes used to be the raw session-start..HEAD walk:
    // the merge session's own commit, the sibling's replay and the squash.
    say(PULL_CONV, 'pull the merge branch');
    await run(wtPull, PULL_CONV, 'user-prompt-submit', { prompt: 'pull the merge branch' });
    // Origin's injected context files are untracked here and committed on the
    // merge branch; a real pull would refuse the same way.
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) fs.rmSync(path.join(wtPull, f), { force: true });
    git(wtPull, ['merge', '-q', '--ff-only', squash]);
    // Untracked work of its own, so session-end has a diff to send at all.
    fs.writeFileSync(path.join(wtPull, 'notes.md'), 'pulled\n');
    const stop = await run(wtPull, PULL_CONV, 'stop', { prompt: 'pull the merge branch', prompt_response: 'Pulled.' });
    expect(stop.code, stop.stderr).toBe(0);
    const end = await run(wtPull, PULL_CONV, 'session-end', { reason: 'exit' });
    expect(end.code, end.stderr).toBe(0);
    expect(hooksLog().split('\n').some((l) => l.includes('[session-end] state loaded') && l.includes(PULL_API)),
      'SessionEnd was handed to Stop — this scenario must reach the session-end body').toBe(true);
    const pulled = [own, replayed, squash];
    const leaked = capturedShas(PULL_API).filter((c) => pulled.some((p) => same(c.sha, p)))
      .map((c) => `${c.url} ${c.where} ${c.sha.slice(0, 8)}`);
    expect(leaked, 'pulled commits reached the session that only pulled').toEqual([]);
    for (const sha of pulled) expect(noteSession(wtPull, sha), `note on ${sha.slice(0, 8)}`).not.toBe(PULL_API);

    // Nor their LINES. With no commit of its own, the session's diff is its
    // uncommitted work — not the session-start..worktree view, which holds
    // every pulled commit's content.
    const foreignContent = ['export const own = 1', 'export const sibling = 1', 'export const upstream = 1'];
    const diffs = sent(PULL_API)
      .filter((h) => typeof h.body?.gitCapture?.diff === 'string')
      .map((h) => ({ url: `${h.method} ${h.url}`, diff: h.body.gitCapture.diff as string }));
    const leakedLines = diffs.flatMap((d) => foreignContent.filter((c) => d.diff.includes(c)).map((c) => `${d.url}: ${c}`));
    expect(leakedLines, 'pulled commits\' lines reached the session diff').toEqual([]);
    const endDiff = diffs.filter((d) => d.url.includes('/session/end')).pop();
    expect(endDiff?.diff, 'session end sent no diff of the session\'s own work').toContain('pulled');
  }, 180_000 * WINDOWS_SLOWDOWN);
});
