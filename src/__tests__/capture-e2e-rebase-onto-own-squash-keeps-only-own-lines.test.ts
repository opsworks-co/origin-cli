// END-TO-END, the BUILT binary: a turn that rebases its branch onto a main that
// already holds the squash of its OWN earlier turn's PR is not billed that
// PR's lines again.
//
// Origin TODO c97040eb, from session 24e45142 (2026-09-23, CLI .1713). Turn 6
// ("fix e87a35d5") wrote five files and committed them on the PR branch; the
// PR was squash-merged to main; turn 7 ("fix ec55247e too") ran
// `git rebase origin/main` and made its own small change. Its stored row was
// the same five files, +266/-10 — turn 6's commit, byte for byte — under
// `diffSource: 'ledger'`, with no commit of its own. The rebase checks out
// main's tree and drops the already-applied commit; to the write journal that
// is every one of those files rewritten inside turn 7, and the turn's
// before-state for them was read from a baseline that predates the squash.
//
// What that turn actually ran was `gh pr merge --squash --delete-branch`:
// gh checks out the STALE local main (every file of the PR reverts to before
// it), then pulls (they all come back as the squash). The journal saw each
// file written twice inside the turn; the ledger's before-state for them was
// the reverted copy, and the difference was the PR. #1831 (cli-v0.20260923.2332)
// made a tree-moving command's rewrites git's, not the turn's, and its replay
// named 5/5 of that turn's billed files. #1811 (cli-v0.20260923.1805) made a
// squash carrying this session's trailer not "inherited". Both shipped after
// that session's CLI (.1713), which is why the TODO could still be filed.
//
// Turn 2 here is the rebase variant; turn 3 is the command the session ran.
// Both go through the journal (ledger) path with Origin's git hooks wired as
// `origin enable` wires them — and both are GREEN on cli-v0.20260923.1713 too
// (checked with ORIGIN_E2E_BIN at that tag), so neither is the exact trigger:
// 24e45142's journal is gone, and what made the ledger read the reverted copy
// as the turn's before-state could not be replayed. This is a guard for the
// two shapes, not a proof of the fix; #1831's own replay on the real repo is.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { holdIdleConnections } from './helpers/fake-api-keepalive.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { verifyTurn } from '../capture-verify.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { foldStopRows } from './helpers/fold-stop-rows.js';
import { gitAsync } from './helpers/git-async.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = process.env.ORIGIN_E2E_BIN || path.join(cliRoot, 'dist', 'index.js');
const haveDist = fs.existsSync(BIN);
const SESSION_ID = 'e2e-claude-own-squash-rebase-1';
const API_SESSION = 'e2e-own-squash-rebase-0001';

type Hit = { method: string; url: string; body: any };
const hits: Hit[] = [];
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
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        hits.push({ method: req.method || '', url: req.url || '', body });
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

const git = (args: string[], opts: { env?: Record<string, string> } = {}): string =>
  execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true', ...(opts.env || {}) },
  }).trim();

/** A git command that fires the hooks: async, so the fake API can answer them (gitAsync). */
const hookedGit = (args: string[]): Promise<string> =>
  gitAsync(repo, ['-c', `core.hooksPath=${hooksDir}`, ...args], { env: { ...process.env, GIT_EDITOR: 'true' } });

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
const hooksLog = () => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } };

const lines: string[] = [];
function say(text: string) {
  lines.push(JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
}
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

/** The agent runs a shell command through Bash, with Origin's git hooks live. */
async function agentRuns(id: string, command: string, gitArgs: string[]) {
  const input = { command };
  expect((await run('pre-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id })).code).toBe(0);
  await hookedGit(gitArgs);
  toolUse(id, 'Bash', input);
  expect((await run('post-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: id, tool_response: { stdout: '', stderr: '', interrupted: false } })).code).toBe(0);
}

function journalFiles(): { journal: string; lock: string } | null {
  const dir = path.join(os.homedir(), '.origin', 'journals');
  if (!fs.existsSync(dir)) return null;
  const j = fs.readdirSync(dir).find((f) => f.startsWith(SESSION_ID.slice(0, 12)) && f.endsWith('.jsonl'));
  if (!j) return null;
  return { journal: path.join(dir, j), lock: path.join(dir, j.replace(/\.jsonl$/, '.lock')) };
}
function writesIn(): number {
  const jf = journalFiles();
  if (!jf) return 0;
  try { return fs.readFileSync(jf.journal, 'utf-8').split('\n').filter((l) => l.startsWith('{"f"')).length; } catch { return 0; }
}
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (cond()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}
async function killJournalWatcher(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const jf = journalFiles();
    try { const pid = jf ? Number(fs.readFileSync(jf.lock, 'utf-8').trim()) : 0; if (pid > 0) { process.kill(pid, 'SIGTERM'); return; } } catch { /* not yet */ }
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
const rows = (): any[] => foldStopRows(hits
  .filter((h) => h.method === 'PATCH' && Array.isArray(h.body?.promptChanges))
  .map((h) => h.body.promptChanges));
function sectionOf(diff: string | null | undefined, file: string): string {
  return String(diff || '').split(/(?=^diff --git )/m).find((s) => s.startsWith(`diff --git a/${file} `)) || '';
}
const trailerOf = (sha: string) => (git(['show', '-s', '--format=%B', sha]).match(/^Origin-Session: .*$/m) || [''])[0];

const SHARED_BASE = Array.from({ length: 10 }, (_, i) => `base_${i} = ${i}`).join('\n') + '\n';
const FEATURE_LINES = Array.from({ length: 20 }, (_, i) => `feature_${i} = ${i}`).join('\n') + '\n';
const FEATURE_FILE = 'feature = True\n';
const TWEAK = 'tweak = "turn 2 wrote this"\n';

describe.skipIf(!haveDist)('a rebase onto the squash of the session\'s own earlier turn', () => {
  let tmp = '';
  let featureCommit = '';
  let squash = '';
  let tweakCommit = '';
  let squash2 = '';

  beforeAll(async () => {
    await startFakeApi();
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-e2e-own-squash-')));
    repo = path.join(tmp, 'repo');
    hooksDir = path.join(tmp, 'hooks');
    fs.mkdirSync(repo);
    fs.mkdirSync(hooksDir);
    transcript = path.join(tmp, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, '');
    // The hooks `origin enable` wires, run in the foreground so every
    // assertion sees their work done. post-rewrite reads git's pairs on stdin.
    for (const [name, args] of [
      ['prepare-commit-msg', 'git-prepare-commit-msg "$1" "$2" "$3"'],
      ['post-commit', 'git-post-commit'],
      ['post-rewrite', 'git-post-rewrite "$1"'],
      ['post-checkout', 'git-post-checkout "$1" "$2" "$3"'],
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
    fs.writeFileSync(path.join(repo, 'shared.py'), SHARED_BASE);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    // A remote-tracking main, as a clone has.
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }, 60_000 * WINDOWS_SLOWDOWN);

  afterAll(async () => {
    await killJournalWatcher();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('turn 1: writes the feature on a branch and commits it', async () => {
    expect((await run('session-start', { source: 'startup' })).code).toBe(0);
    say('add the feature on a branch and commit');
    expect((await run('user-prompt-submit', { prompt: 'add the feature on a branch and commit' })).code).toBe(0);
    await waitFor(() => journalFiles() !== null, 10_000, 'the session journal');

    await agentRuns('tu-1', 'git checkout -b feature', ['checkout', '-q', '-b', 'feature']);
    const before = writesIn();
    await agentWrites('tu-2', 'shared.py', SHARED_BASE + FEATURE_LINES);
    await agentWrites('tu-3', 'feature.py', FEATURE_FILE);
    await waitFor(() => writesIn() >= before + 2, 10_000, 'the journal to record both writes');
    await agentRuns('tu-4', 'git add -A && git commit -m "feat: the feature"', ['add', '-A']);
    await hookedGit(['commit', '-q', '-m', 'feat: the feature']);
    featureCommit = git(['rev-parse', 'HEAD']);
    expect(trailerOf(featureCommit), 'the session\'s own commit carries its trailer').toContain('Origin-Session:');
    await sleep(300);

    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);
    const t1 = rows().find((r) => r.promptIndex === 0);
    expect(t1, 'no row for turn 1').toBeTruthy();
    expect([...t1.filesChanged].sort()).toEqual(['feature.py', 'shared.py']);
    expect(t1.linesAdded).toBe(21);
    expect(t1.linesRemoved).toBe(0);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('GitHub squash-merges the PR onto main, keeping the trailer', () => {
    // A squash of the branch's tree onto main, committed by GitHub, with the
    // branch commit's trailer in its body — what `gh pr merge --squash` leaves.
    // Plumbing, so the working tree (still on `feature`) is not touched.
    const message = `feat: the feature (#42)\n\n${trailerOf(featureCommit)}\n`;
    const tree = git(['rev-parse', `${featureCommit}^{tree}`]);
    const main = git(['rev-parse', 'refs/heads/main']);
    squash = git(['commit-tree', tree, '-p', main, '-m', message], {
      env: { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' },
    });
    git(['update-ref', 'refs/heads/main', squash]);
    git(['update-ref', 'refs/remotes/origin/main', squash]);
    expect(git(['rev-parse', 'origin/main'])).toBe(squash);
    expect(trailerOf(squash)).toBe(trailerOf(featureCommit));
  });

  it('turn 2: rebases onto main and makes one small change — and is billed that change only', async () => {
    say('rebase onto main and add the tweak');
    expect((await run('user-prompt-submit', { prompt: 'rebase onto main and add the tweak' })).code).toBe(0);

    // The rebase drops the already-applied feature commit and leaves the
    // branch at the squash. To the journal, every file the squash touched was
    // just rewritten inside this turn.
    const before = writesIn();
    await agentRuns('tu-5', 'git fetch && git rebase origin/main', ['rebase', '-q', 'origin/main']);
    expect(git(['rev-parse', 'HEAD']), 'the rebase should leave the branch at the squash').toBe(squash);

    // The turn's own work, on top, committed on the branch.
    await agentWrites('tu-6', 'shared.py', SHARED_BASE + FEATURE_LINES + TWEAK);
    await waitFor(() => writesIn() > before, 10_000, 'the journal to record the tweak');
    await agentRuns('tu-7', 'git commit -am "fix: the tweak"', ['add', '-A']);
    await hookedGit(['commit', '-q', '-m', 'fix: the tweak']);
    tweakCommit = git(['rev-parse', 'HEAD']);
    await sleep(300);

    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    // PRECONDITION: the ledger answered for this turn, as it did for 24e45142.
    expect(hooksLog()).toMatch(/turn capture taken from the write journal \{"promptIndex":1,/);

    const t2 = rows().find((r) => r.promptIndex === 1);
    expect(t2, 'no row for turn 2').toBeTruthy();
    expect(t2.diffSource).toBe('ledger');
    // Per FILE: the squash's own file is not this turn's.
    expect(t2.filesChanged).toEqual(['shared.py']);
    // Per LINE: shared.py carries the tweak, not the twenty feature lines.
    const shared = sectionOf(t2.diff, 'shared.py');
    expect(shared, 'no section for shared.py').not.toBe('');
    expect(shared).toContain('+tweak = "turn 2 wrote this"');
    expect(shared, 'the squash\'s lines were billed to the rebasing turn again').not.toContain('+feature_');
    expect([t2.linesAdded, t2.linesRemoved]).toEqual([1, 0]);
    expect(t2.commitSha || null, 'the squash is not this turn\'s commit').not.toBe(squash);
    if (t2.commitSha) expect(tweakCommit.startsWith(t2.commitSha) || t2.commitSha.startsWith(tweakCommit)).toBe(true);

    // Turn 1 still owns its work.
    const t1 = rows().find((r) => r.promptIndex === 0);
    expect([...t1.filesChanged].sort()).toEqual(['feature.py', 'shared.py']);
    expect(t1.linesAdded).toBe(21);

    for (const t of [t1, t2]) {
      const findings = verifyTurn({
        promptIndex: t.promptIndex, filesChanged: t.filesChanged, diff: t.diff, uncommittedDiff: t.uncommittedDiff,
        contentUnavailableFiles: t.contentUnavailableFiles, linesAdded: t.linesAdded, linesRemoved: t.linesRemoved,
      } as any).filter((f: { severity?: string }) => f.severity === 'contradiction');
      expect(findings.map((f: { code: string }) => f.code), `turn ${t.promptIndex}`).toEqual([]);
    }
    // The session never claimed the squash as a commit of this turn.
    const state = sessionState();
    const ownerOfSquash = (state.commitTurns || []).find((c: any) => squash.startsWith(c.sha) || c.sha.startsWith(squash));
    expect(ownerOfSquash?.turnId ?? null, 'the squash was attested to a turn').not.toBe((state.promptTurnIds || [])[1]);
  }, 120_000 * WINDOWS_SLOWDOWN);

  it('GitHub squash-merges the second PR onto main; the local main is stale', () => {
    const message = `fix: the tweak (#43)\n\n${trailerOf(tweakCommit)}\n`;
    const tree = git(['rev-parse', `${tweakCommit}^{tree}`]);
    squash2 = git(['commit-tree', tree, '-p', squash, '-m', message], {
      env: { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' },
    });
    git(['update-ref', 'refs/remotes/origin/main', squash2]);
    // The local main was never pulled after the first squash: it still sits
    // at the base, which is what makes gh's checkout revert the PR's files.
    git(['update-ref', 'refs/heads/main', git(['rev-parse', 'refs/remotes/origin/main~2'])]);
    expect(git(['show', 'main:shared.py'])).toBe(SHARED_BASE.trimEnd());   // git() trims
  });

  it('turn 3: `gh pr merge --squash --delete-branch` — a stale checkout and a pull bill the turn nothing', async () => {
    say('merge the PR');
    expect((await run('user-prompt-submit', { prompt: 'merge the PR' })).code).toBe(0);

    // What gh does, step by step, under the one command the agent typed:
    // checkout the stale local main (the PR's files revert), pull it forward
    // (they come back as the squash), delete the branch.
    const command = 'gh pr merge 43 --squash --delete-branch';
    const before = writesIn();
    expect((await run('pre-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu-8' })).code).toBe(0);
    await hookedGit(['checkout', '-q', 'main']);
    expect(fs.readFileSync(path.join(repo, 'shared.py'), 'utf-8'), 'the stale checkout reverts the PR').toBe(SHARED_BASE);
    await hookedGit(['merge', '-q', '--ff-only', 'origin/main']);
    git(['branch', '-q', '-D', 'feature']);
    expect(fs.readFileSync(path.join(repo, 'shared.py'), 'utf-8')).toBe(SHARED_BASE + FEATURE_LINES + TWEAK);
    toolUse('tu-8', 'Bash', { command });
    expect((await run('post-tool-use', { tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu-8', tool_response: { stdout: '✓ Squashed and merged', stderr: '', interrupted: false } })).code).toBe(0);
    await waitFor(() => writesIn() > before, 10_000, 'the journal to see the checkout rewrite the files');
    await sleep(300);

    expect((await run('stop', { stop_hook_active: false })).code).toBe(0);

    const t3 = rows().find((r) => r.promptIndex === 2);
    expect(t3, 'no row for turn 3').toBeTruthy();
    expect(t3.filesChanged || [], 'the merge turn was billed the PR it merged').toEqual([]);
    expect([t3.linesAdded || 0, t3.linesRemoved || 0]).toEqual([0, 0]);
    expect(String(t3.diff || '')).not.toContain('+feature_');
    expect(String(t3.diff || '')).not.toContain('+tweak');
    // The earlier turns keep their own work.
    expect(rows().find((r) => r.promptIndex === 0).linesAdded).toBe(21);
    expect(rows().find((r) => r.promptIndex === 1).linesAdded).toBe(1);
  }, 120_000 * WINDOWS_SLOWDOWN);
});
