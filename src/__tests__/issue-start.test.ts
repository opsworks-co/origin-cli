import { fileURLToPath } from 'url';
// `origin issue start <id>`: hand an issue to an agent — resolve it (API,
// local store, repo-memory TODO), put the checkout on issue/<id>-<slug>
// (refusing a dirty tree), build the prompt, leave a one-shot link for the
// agent's session, and launch the agent with argv (or print the prompt).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  agentBackgroundArgv, agentLaunchArgv, agentPreflightArgv, branchNamesIssue, buildIssuePrompt, extractAcceptanceCriteria, issueBranchName, parsePreflight,
  issueStartCommandLine as startCommandText, mentionedPaths, slugify, ISSUE_PROMPT_MAX_CHARS,
} from '../issue-prompt.js';
import {
  ISSUE_LINK_TTL_MS, linkPendingIssue, pendingIssueLinkPath, takePendingIssueLink, writePendingIssueLink,
  readSessionClaims, dropSessionClaim,
} from '../issue-link.js';
import { pickResume, sessionOnThisComputer } from '../issue-clarify.js';
import { checkoutIssueBranch, findOnPath, issueStartCommand, issueWorktreePath, listBackgroundRuns, resolveIssue, type IssueStartDeps } from '../commands/issue-start.js';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-issue-start-')));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'init');
  return dir;
}

const WIN = process.platform === 'win32';

/**
 * An agent that runs `body` (node source), installed the way npm installs one:
 * a node script on its shebang, or on Windows a `.cmd` shim over
 * node_modules/<name>/cli.js (npm's cmd-shim, as written for claude, codex,
 * gemini…). Returns the path `findOnPath` finds it at.
 */
function writeAgent(binDir: string, name: string, body: string): string {
  if (!WIN) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    return file;
  }
  const script = path.join(binDir, 'node_modules', name, 'cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `${body}\n`);
  fs.writeFileSync(path.join(binDir, `${name}.cmd`), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${name}\\cli.js" %*`, '',
  ].join('\r\n'));
  return findOnPath(name, { PATH: binDir }, 'win32')!;
}

/** A fake agent that records its argv as JSON, one file per run. */
function fakeAgent(binDir: string, name: string, outFile: string): string {
  return writeAgent(binDir, name, `require('fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.argv.slice(2)));`);
}

function deps(repo: string, over: Partial<IssueStartDeps> = {}): Partial<IssueStartDeps> & { logs: string[]; copied: string[]; updates: any[] } {
  const logs: string[] = [];
  const copied: string[] = [];
  const updates: any[] = [];
  return {
    logs, copied, updates,
    cwd: repo,
    env: { PATH: '' },
    platform: process.platform,
    log: (l) => logs.push(l),
    error: (l) => logs.push(l),
    connected: () => false,
    api: null,
    memoryLines: () => [],
    openTodos: () => [],
    copy: (t) => { copied.push(t); return true; },
    // A test never pushes for real; the publish tests inject their own.
    publish: () => 'Did not push: test',
    // Never probe the real agents' sign-in from a test.
    signedIn: async () => null,
    // Nor run the real pre-start pass, ask on the real terminal, or look for real sessions.
    preflight: async () => null,
    ask: async () => null,
    hasSession: async () => false,
    ...over,
  };
}

describe('issue prompt (shared with the API)', () => {
  it('names the branch issue/<shortId>-<slug>', () => {
    expect(issueBranchName('ISS-12', 'Fix the login: redirect loop!')).toBe('issue/ISS-12-fix-the-login-redirect-loop');
    expect(issueBranchName('ori-a3f2', '')).toBe('issue/ori-a3f2');
    expect(slugify('A'.repeat(80)).length).toBeLessThanOrEqual(40);
    expect(branchNamesIssue('issue/ori-a3f2-fix-it', 'ori-a3f2')).toBe(true);
    expect(branchNamesIssue('issue/ori-a3f2-fix-it', 'ori-b')).toBe(false);
    expect(branchNamesIssue('feature/ori-a3f2', 'ori-a3f2')).toBe(false);
  });

  it('carries title, body, acceptance criteria and the closing instruction', () => {
    const p = buildIssuePrompt({
      shortId: 'ISS-12', title: 'Retry webhook delivery', type: 'bug', branch: 'issue/ISS-12-retry',
      description: 'Deliveries to apps/api/src/services/webhook.ts drop on 502.\n\n## Acceptance criteria\n- [ ] retries 3 times\n- [ ] logs the last error',
      memory: ['Decision (abcd1234): keep retries in the worker'],
    });
    expect(p).toContain('Work on issue ISS-12 (bug): Retry webhook delivery');
    expect(p).toContain('Deliveries to apps/api/src/services/webhook.ts drop on 502.');
    expect(p).toContain('Acceptance criteria:\n- retries 3 times\n- logs the last error');
    expect(p).toContain('keep retries in the worker');
    expect(p).toContain('`issue/ISS-12-retry`');
    expect(p).not.toContain('[Origin: Closes]');
  });

  it('tells the agent which epic the issue is part of, and an epic which issues are under it', () => {
    const story = buildIssuePrompt({
      shortId: 'APP-2', title: 'Add the cart page', type: 'feature',
      parent: { shortId: 'APP-50', title: 'Checkout v2', type: 'epic', description: 'Replace the old checkout.\n\nKeep the API.', url: 'https://acme.atlassian.net/browse/APP-50' },
    });
    expect(story).toContain('Part of epic APP-50: Checkout v2\nhttps://acme.atlassian.net/browse/APP-50\nWhat the epic says:\nReplace the old checkout.\n\nKeep the API.');
    const epic = buildIssuePrompt({
      shortId: 'APP-50', title: 'Checkout v2', type: 'epic',
      children: [{ shortId: 'APP-2', title: 'Add the cart page', status: 'closed' }, { shortId: 'APP-3', title: 'Pay with cards', status: 'open' }],
    });
    expect(epic).toContain('Work on issue APP-50 (epic): Checkout v2');
    expect(epic).toContain('The issues under this one, and where each stands');
    expect(epic).toContain('- APP-2 Add the cart page (closed)\n- APP-3 Pay with cards (open)');
    // A plain issue says nothing about a tree, and a huge epic stays within the cap.
    expect(buildIssuePrompt({ shortId: 'X-1', title: 't' })).not.toMatch(/Part of|under this one/);
    const big = buildIssuePrompt({ shortId: 'X-1', title: 't', maxChars: 1500, parent: { shortId: 'E-1', title: 'e', description: 'word '.repeat(2000) }, children: Array.from({ length: 80 }, (_, i) => ({ shortId: `X-${i}`, title: 'x'.repeat(100), status: 'open' })) });
    expect(big.length).toBeLessThanOrEqual(1500);
    expect(big).toContain('[Origin: Outcome]');
  });

  it('asks a memory TODO to be closed with its id', () => {
    const p = buildIssuePrompt({ shortId: '1a2b3c4d', title: 't', memoryTodoId: '1a2b3c4d' });
    expect(p).toContain('[Origin: Closes] 1a2b3c4d');
  });

  it('stays under the cap with a huge body and memory, keeping the closing', () => {
    const p = buildIssuePrompt({
      shortId: 'X-1', title: 'big', description: 'word '.repeat(5000), memoryTodoId: 'deadbeef',
      memory: Array.from({ length: 200 }, (_, i) => `memory line ${i} ${'x'.repeat(100)}`),
    });
    expect(p.length).toBeLessThanOrEqual(ISSUE_PROMPT_MAX_CHARS);
    expect(p).toContain('[Origin: Closes] deadbeef');
    expect(p).toContain('memory line 0');
  });

  it('reads acceptance criteria from a checklist too, and finds paths', () => {
    expect(extractAcceptanceCriteria('Do it\n- [ ] one\n- [x] two').criteria).toEqual(['one', 'two']);
    expect(mentionedPaths('see `src/a.ts` and docs/CLI.md, e.g. not this')).toEqual(['src/a.ts', 'docs/CLI.md']);
  });

  it('carries answered questions (newest first when they don\'t all fit), not open ones, and a brief', () => {
    const p = buildIssuePrompt({
      shortId: 'ISS-1', title: 't', brief: 'The code is in src/x.ts.',
      clarifications: [{ question: 'Old?', answer: 'old answer' }, { question: 'Open?', answer: null }, { question: 'New?', answer: 'line one\nline two' }],
    });
    expect(p).toContain('Questions asked about this issue, and the answers (follow them):\n- Q: Old?\n  A: old answer\n- Q: New?\n  A: line one\n     line two');
    expect(p).not.toContain('Open?');
    expect(p).toContain('The code is in src/x.ts.');
    const many = buildIssuePrompt({ shortId: 'ISS-1', title: 't', maxChars: 2000, clarifications: Array.from({ length: 30 }, (_, i) => ({ question: `q${i}`, answer: 'a'.repeat(100) })) });
    expect(many.length).toBeLessThanOrEqual(2000);
    expect(many).toContain('Q: q29');
    expect(many).not.toContain('Q: q0\n');
    expect(many).toContain('[Origin: Outcome]');
  });

  it('resumes claude and codex headless; the others never resume', () => {
    const g = '/repo/.git';
    expect(agentBackgroundArgv('claude', 'p', g, { resumeSessionId: 's1' })).toEqual(['claude', '-p', 'p', '--resume', 's1', '--permission-mode', 'auto']);
    expect(agentBackgroundArgv('codex', 'p', g, { resumeSessionId: 's1' })).toEqual(['codex', 'exec', '-s', 'workspace-write', '--add-dir', g, 'resume', 's1', 'p']);
    expect(agentBackgroundArgv('gemini', 'p', g, { resumeSessionId: 's1' })).toEqual(agentBackgroundArgv('gemini', 'p', g));
  });

  it('the pre-start pass is read-only and unrecorded, and its answer is read from either agent', () => {
    const files = { schemaFile: '/t/s.json', outFile: '/t/o.json' };
    const c = agentPreflightArgv('claude', 'p', files)!;
    expect(c).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--output-format', 'json']));
    const x = agentPreflightArgv('codex', 'p', files)!;
    expect(x).toEqual(expect.arrayContaining(['-s', 'read-only', '--ephemeral', '--disable', 'hooks', '--output-schema', '/t/s.json', '-o', '/t/o.json']));
    expect(agentPreflightArgv('gemini', 'p', files)).toBeNull();
    // claude --output-format json: the answer is the result text.
    expect(parsePreflight(JSON.stringify({ type: 'result', result: '{"ready":true,"brief":"b","questions":[]}' }))).toEqual({ ready: true, brief: 'b', questions: [] });
    expect(parsePreflight(JSON.stringify({ result: 'x', structured_output: { ready: false, brief: '', questions: ['q?'] } }))).toEqual({ ready: false, brief: '', questions: ['q?'] });
    // ready with questions is not ready; at most 3.
    expect(parsePreflight('{"ready":true,"brief":"","questions":["a","b","c","d"]}')).toEqual({ ready: false, brief: '', questions: ['a', 'b', 'c'] });
    expect(parsePreflight('not json')).toBeNull();
  });

  it('finds a Claude session in its project folder, also when a long path\'s folder is cut short with a hash', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-claude-home-'));
    try {
      const env = { CLAUDE_CONFIG_DIR: home };
      const short = '/w/app';
      fs.mkdirSync(path.join(home, 'projects', '-w-app'), { recursive: true });
      fs.writeFileSync(path.join(home, 'projects', '-w-app', 's1.jsonl'), '{}\n');
      expect(await sessionOnThisComputer('claude', 's1', short, env)).toBe(true);
      expect(await sessionOnThisComputer('claude', 's2', short, env)).toBe(false);
      // Claude Code keeps 200 characters of a long slug, then adds -<hash>.
      const long = `/w/${'deep/'.repeat(50)}E2E-3-rate-limit-webhook-deliveries`;
      const slug = path.resolve(long).replace(/[^a-zA-Z0-9]/g, '-');
      const cut = `${slug.slice(0, 200)}-xhnjbx`;
      fs.mkdirSync(path.join(home, 'projects', cut), { recursive: true });
      fs.writeFileSync(path.join(home, 'projects', cut, 's3.jsonl'), '{}\n');
      expect(await sessionOnThisComputer('claude', 's3', long, env)).toBe(true);
      expect(await sessionOnThisComputer('claude', 's3', '/w/other', env)).toBe(false);
      expect(await sessionOnThisComputer('gemini', 's1', short, env)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('picks the session to resume: the newest blocked run of that agent, once everything since is answered', () => {
    const run = (o: any) => ({ id: 'x', question: 'q', answer: 'a', from: 'run', agent: 'claude', agentSessionId: 's1', ...o });
    expect(pickResume([run({})], 'claude')).toMatchObject({ agentSessionId: 's1' });
    // Origin records Claude Code sessions as claude-code.
    expect(pickResume([run({ agent: 'claude-code' })], 'claude')).toMatchObject({ agentSessionId: 's1' });
    expect(pickResume([run({ answer: null })], 'claude')).toBeNull();
    expect(pickResume([run({}), run({ from: 'preflight', agentSessionId: null, answer: null })], 'claude')).toBeNull();
    expect(pickResume([run({}), run({ agent: 'codex', agentSessionId: 's2' })], 'claude')).toBeNull();
    expect(pickResume([run({ agentSessionId: 's0', question: 'older' }), run({ question: 'newer' })], 'claude')!.answers.map((a) => a.question)).toEqual(['newer']);
    expect(pickResume([run({ agent: 'gemini' })], 'gemini')).toBeNull();
    expect(pickResume([run({ agentSessionId: null })], 'claude')).toBeNull();
    // A run after the one that asked has gone on already: don't resume the asker.
    const asked = run({ sessionId: 'row-1' });
    expect(pickResume([asked], 'claude', 'row-1')).toMatchObject({ agentSessionId: 's1' });
    expect(pickResume([asked], 'claude', 'row-2')).toBeNull();
    expect(pickResume([asked], 'claude', null)).toBeNull();
    expect(pickResume([asked], 'claude', undefined)).toMatchObject({ agentSessionId: 's1' });
  });

  it('runs headless with each agent\'s scoped unattended mode', () => {
    const g = '/repo/.git';
    expect(agentBackgroundArgv('claude', 'p', g)).toEqual(['claude', '-p', 'p', '--permission-mode', 'auto']);
    expect(agentBackgroundArgv('codex', 'p', g)).toEqual(['codex', 'exec', '-s', 'workspace-write', '--add-dir', g, 'p']);
    // Headless Gemini refuses an untrusted folder ("not running in a trusted
    // directory", 2026-10-13); --skip-trust trusts the run's worktree only.
    expect(agentBackgroundArgv('gemini', 'p', g)).toEqual(['gemini', '-p', 'p', '--approval-mode', 'auto_edit', '--skip-trust']);
    // Headless cursor-agent refuses a folder it has not seen, and every run's
    // worktree is new (2026-10-12: "Do you trust the contents of this
    // directory?", exit 1). --trust, never --force: no command allowance.
    expect(agentBackgroundArgv('cursor', 'p', g)).toEqual(['cursor-agent', '-p', 'p', '--trust']);
    expect(agentBackgroundArgv('copilot', 'p', g)).toEqual(['copilot', '-p', 'p', '--allow-tool', 'write', '--allow-tool', 'shell(git:*)']);
    // A project of the run's own scopes it (antigravity-scope.ts): accept-edits
    // alone refused `git status` headless and ended the run.
    expect(agentBackgroundArgv('antigravity', 'p', g, { antigravityProject: 'proj-1' })).toEqual(['agy', '-p', 'p', '--project', 'proj-1', '--print-timeout', '120m']);
    expect(agentBackgroundArgv('print', 'p', g)).toBeNull();
    // No agent gets a blanket bypass, Antigravity included.
    for (const a of ['claude', 'codex', 'gemini', 'cursor', 'copilot', 'antigravity'] as const) {
      expect(agentBackgroundArgv(a, 'p', g, { antigravityProject: 'proj-1' })!.join(' ')).not.toMatch(/--force|--yolo|dangerously|bypass/);
    }
  });

  it('launches with argv, never a shell string', () => {
    expect(agentLaunchArgv('claude', 'p q')).toEqual(['claude', 'p q']);
    expect(agentLaunchArgv('codex', 'p')).toEqual(['codex', 'p']);
    expect(agentLaunchArgv('gemini', 'p')).toEqual(['gemini', '-i', 'p']);
    expect(agentLaunchArgv('cursor', 'p')).toEqual(['cursor-agent', 'p']);
    expect(agentLaunchArgv('copilot', 'p')).toEqual(['copilot', '-i', 'p']);
    expect(agentLaunchArgv('antigravity', 'p')).toEqual(['agy', '-i', 'p']);
    expect(agentLaunchArgv('print', 'p')).toBeNull();
    expect(startCommandText('ISS-12', 'codex')).toBe('origin issue start ISS-12 --agent codex');
  });
});

describe('resolving the issue', () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });
  const roots = () => ({ work: repo, canonical: repo });

  it('reads it from the API in the repo route-preview names', async () => {
    const seen: string[] = [];
    const api = {
      previewRoute: async () => ({ repo: { id: 'repo-1' } }),
      getIssue: async (repoId: string, id: string) => { seen.push(`${repoId}/${id}`); return { shortId: id, title: 'From API', status: 'open', source: null }; },
      updateIssue: async () => ({}),
    };
    const it = await resolveIssue('ISS-1', roots(), { api, connected: () => true, openTodos: () => [], error: () => {} });
    expect(seen).toEqual(['repo-1/ISS-1']);
    expect(it).toMatchObject({ shortId: 'ISS-1', origin: 'api', repoId: 'repo-1', memoryTodoId: null });
  });

  it('a memory issue on the API closes its TODO by the shortId', async () => {
    const api = {
      previewRoute: async () => ({ repo: { id: 'repo-1' } }),
      getIssue: async () => ({ shortId: 'cafe1234', title: 'todo text', status: 'open', source: 'memory' }),
      updateIssue: async () => ({}),
    };
    const it = await resolveIssue('cafe1234', roots(), { api, connected: () => true, openTodos: () => [], error: () => {} });
    expect(it?.memoryTodoId).toBe('cafe1234');
  });

  it('falls back to the local store when the API has no such issue', async () => {
    fs.mkdirSync(path.join(repo, '.origin', 'issues'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.origin', 'issues', 'ori-ab12.json'), JSON.stringify({ id: 'ori-ab12', title: 'Local one', status: 'open', sessions: [] }));
    const api = {
      previewRoute: async () => ({ repo: { id: 'repo-1' } }),
      getIssue: async () => { throw Object.assign(new Error('Issue not found'), { status: 404 }); },
      updateIssue: async () => ({}),
    };
    const it = await resolveIssue('ori-ab', roots(), { api, connected: () => true, openTodos: () => [], error: () => {} });
    expect(it).toMatchObject({ shortId: 'ori-ab12', title: 'Local one', origin: 'local' });
  });

  it('says Origin was not asked when it timed out or failed; a 404 is an answer', async () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const slow = { previewRoute: async () => { throw abort; }, getIssue: async () => ({}), updateIssue: async () => ({}) };
    const a: any = {};
    expect(await resolveIssue('dep-179', roots(), { api: slow, connected: () => true, openTodos: () => [], error: () => {} }, a)).toBeNull();
    expect(a.originUnreachable).toBe('it did not answer in time');

    const errs: string[] = [];
    const broken = { previewRoute: async () => ({ repo: { id: 'repo-1' } }), getIssue: async () => { throw Object.assign(new Error('Bad gateway'), { status: 502 }); }, updateIssue: async () => ({}) };
    const b: any = {};
    expect(await resolveIssue('dep-179', roots(), { api: broken, connected: () => true, openTodos: () => [], error: (l) => errs.push(l) }, b)).toBeNull();
    expect(b.originUnreachable).toBe('HTTP 502: Bad gateway');
    expect(errs.join()).toContain('Could not read dep-179 from Origin');

    const missing = { previewRoute: async () => ({ repo: { id: 'repo-1' } }), getIssue: async () => { throw Object.assign(new Error('Issue not found'), { status: 404 }); }, updateIssue: async () => ({}) };
    const c: any = {};
    expect(await resolveIssue('dep-179', roots(), { api: missing, connected: () => true, openTodos: () => [], error: () => {} }, c)).toBeNull();
    expect(c.originUnreachable).toBeUndefined();
  });

  it('accepts an open repo-memory TODO id', async () => {
    const it = await resolveIssue('beef', roots(), {
      api: null, connected: () => false, error: () => {},
      openTodos: () => [{ id: 'beef5678', text: 'Retry the upload when the API is down' }],
    });
    expect(it).toMatchObject({ shortId: 'beef5678', origin: 'memory-todo', memoryTodoId: 'beef5678', title: 'Retry the upload when the API is down' });
  });
});

describe('the issue branch', () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it('creates it from the default branch, and switches back to it later', () => {
    sh(repo, 'checkout', '-q', '-b', 'elsewhere');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'elsewhere');
    const r = checkoutIssueBranch(repo, 'issue/X-1-thing');
    expect(r).toEqual({ created: true, base: 'main' });
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('issue/X-1-thing');
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false); // based on main, not on `elsewhere`
    sh(repo, 'checkout', '-q', 'main');
    expect(checkoutIssueBranch(repo, 'issue/X-1-thing')).toEqual({ created: false, base: null });
  });

  it('refuses a dirty tree and never stashes; untracked files are fine', () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    expect(checkoutIssueBranch(repo, 'issue/X-2').created).toBe(true);
    sh(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edited\n');
    expect(() => checkoutIssueBranch(repo, 'issue/X-3')).toThrow(/uncommitted changes[\s\S]*--no-branch/);
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('edited\n');
    expect(sh(repo, 'stash', 'list')).toBe('');
  });
});

describe('origin issue start', () => {
  let repo: string;
  let bin: string;
  beforeEach(() => {
    repo = makeRepo();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-issue-bin-'));
    process.exitCode = undefined;
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const apiFor = (updates: any[]) => ({
    previewRoute: async () => ({ repo: { id: 'repo-1' } }),
    getIssue: async (_r: string, id: string) => ({ shortId: id, title: 'Retry webhook delivery', description: 'It drops on 502.', status: 'open', source: null }),
    updateIssue: async (repoId: string, shortId: string, data: any) => { updates.push({ repoId, shortId, data }); return {}; },
  });

  for (const [agent, binName, expectedArgs] of [
    ['claude', 'claude', (p: string) => [p]],
    ['codex', 'codex', (p: string) => [p]],
    ['gemini', 'gemini', (p: string) => ['-i', p]],
    ['cursor', 'cursor-agent', (p: string) => [p]],
    ['copilot', 'copilot', (p: string) => ['-i', p]],
    ['antigravity', 'agy', (p: string) => ['-i', p]],
  ] as const) {
    it(`launches ${agent} with the prompt as argv`, async () => {
      const out = path.join(bin, `${binName}.argv.json`);
      const exe = fakeAgent(bin, binName, out);
      const updates: any[] = [];
      const d = deps(repo, { env: { PATH: bin }, connected: () => true, api: apiFor(updates) });
      const r = await issueStartCommand('ISS-12', { agent }, d);
      expect(r?.launched?.[0]).toBe(exe);
      const argv = JSON.parse(fs.readFileSync(out, 'utf-8'));
      expect(argv).toEqual(expectedArgs(r!.prompt));
      expect(r!.prompt).toContain('Work on issue ISS-12: Retry webhook delivery');
      expect(r!.branch).toBe('issue/ISS-12-retry-webhook-delivery');
      expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('issue/ISS-12-retry-webhook-delivery');
      expect(updates).toEqual([{ repoId: 'repo-1', shortId: 'ISS-12', data: { status: 'in-progress' } }]);
      // The link the agent's session-start will take.
      const link = JSON.parse(fs.readFileSync(pendingIssueLinkPath(repo)!, 'utf-8'));
      expect(link).toMatchObject({ shortId: 'ISS-12', repoId: 'repo-1', agent, runId: null }); // apiFor reports no run
    });
  }

  it('after a clean exit, pushes the branch and opens its PR; not after a failure, nor with --no-publish', async () => {
    const out = path.join(bin, 'claude.argv.json');
    fakeAgent(bin, 'claude', out);
    const calls: any[] = [];
    const ends: any[] = [];
    const api = {
      ...apiFor([]),
      startIssueRun: async () => ({ id: 'run-1' }),
      endIssueRun: async (_r: string, _s: string, _id: string, data: any) => { ends.push(data); return {}; },
    };
    const publish = (input: any) => { calls.push(input); return 'Opened pull request https://github.com/o/r/pull/7'; };
    const d = deps(repo, { env: { PATH: bin }, connected: () => true, api, publish, run: async () => 0 });
    await issueStartCommand('ISS-12', { agent: 'claude' }, d);
    expect(calls).toEqual([expect.objectContaining({ cwd: repo, branch: 'issue/ISS-12-retry-webhook-delivery', shortId: 'ISS-12', agent: 'claude', pullRequest: null })]);
    expect(ends).toEqual([{ status: 'done', exitCode: 0, detail: 'Opened pull request https://github.com/o/r/pull/7' }]);
    expect(d.logs.some((l) => l.includes('Opened pull request https://github.com/o/r/pull/7'))).toBe(true);

    calls.length = 0; ends.length = 0;
    await issueStartCommand('ISS-12', { agent: 'claude' }, deps(repo, { env: { PATH: bin }, connected: () => true, api, publish, run: async () => 1 }));
    expect(calls).toEqual([]);
    expect(ends).toEqual([{ status: 'failed', exitCode: 1, detail: null }]);
    process.exitCode = 0;

    await issueStartCommand('ISS-12', { agent: 'claude', publish: false }, deps(repo, { env: { PATH: bin }, connected: () => true, api, publish, run: async () => 0 }));
    expect(calls).toEqual([]);
  });

  it("the link the agent's session-start takes names the run reported for it", async () => {
    fakeAgent(bin, 'claude', path.join(bin, 'claude.argv.json'));
    let seen: any = null;
    const api = { ...apiFor([]), startIssueRun: async () => ({ id: 'run-7' }), endIssueRun: async () => ({}) };
    // Read the link the moment the agent would start, as its session-start does.
    const run = async () => { seen = JSON.parse(fs.readFileSync(pendingIssueLinkPath(repo)!, 'utf-8')); return 0; };
    await issueStartCommand('ISS-12', { agent: 'claude', publish: false }, deps(repo, { env: { PATH: bin }, connected: () => true, api, run }));
    expect(seen).toMatchObject({ shortId: 'ISS-12', repoId: 'repo-1', runId: 'run-7' });
  });

  it('a lookup Origin never answered is not reported as "no issue matches"', async () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const d = deps(repo, { connected: () => true, api: { ...apiFor([]), previewRoute: async () => { throw abort; } } });
    expect(await issueStartCommand('dep-179', { agent: 'claude' }, d)).toBeNull();
    const out = d.logs.join('\n');
    expect(out).toContain('Could not look up "dep-179" on Origin: it did not answer in time.');
    expect(out).not.toContain('No issue or open TODO matches');
    process.exitCode = undefined;

    const d404 = deps(repo, { connected: () => true, api: { ...apiFor([]), getIssue: async () => { throw Object.assign(new Error('nope'), { status: 404 }); } } });
    expect(await issueStartCommand('dep-179', { agent: 'claude' }, d404)).toBeNull();
    expect(d404.logs.join('\n')).toContain('No issue or open TODO matches "dep-179"');
    process.exitCode = undefined;
  });

  it("a race arm works on the issue's branch plus its agent; a review fix can't be raced", async () => {
    fakeAgent(bin, 'claude', path.join(bin, 'claude.argv.json'));
    const r = await issueStartCommand('ISS-12', { agent: 'claude', branchSuffix: 'claude', publish: false }, deps(repo, { env: { PATH: bin }, connected: () => true, api: apiFor([]), run: async () => 0 }));
    expect(r?.branch).toBe('issue/ISS-12-retry-webhook-delivery-claude');
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('issue/ISS-12-retry-webhook-delivery-claude');

    const review = { ...apiFor([]), getIssue: async (_r: string, id: string) => ({ shortId: id, title: 'Review: a.ts', status: 'open', source: null, workBranch: 'claude/totals', pullRequest: 7 }) };
    const d = deps(repo, { env: { PATH: bin }, connected: () => true, api: review, run: async () => 0 });
    expect(await issueStartCommand('ISS-13', { agent: 'claude', branchSuffix: 'claude' }, d)).toBeNull();
    expect(process.exitCode).toBe(2);
    expect(d.logs.join('\n')).toContain('a race needs a branch per agent');
    process.exitCode = undefined;
  });

  it('stops when someone is already on the issue, names them, and starts with --force', async () => {
    const out = path.join(bin, 'claude.argv.json');
    const exe = fakeAgent(bin, 'claude', out);
    const now = new Date().toISOString();
    const busyIssue = (_r: string, id: string) => ({
      shortId: id, title: 'Retry webhook delivery', status: 'in-progress', source: null,
      sessions: [{ sessionId: 'sess-ihor-1234', state: 'running', userName: 'Ihor', agent: { name: 'Codex', slug: 'codex' }, createdAt: now }],
      runs: [],
    });
    const updates: any[] = [];
    const api = { ...apiFor(updates), getIssue: async (r: string, id: string) => busyIssue(r, id) };

    const d = deps(repo, { env: { PATH: bin }, connected: () => true, api });
    expect(await issueStartCommand('ISS-12', { agent: 'claude' }, d)).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(d.logs.join('\n')).toContain('Ihor is already working on ISS-12 with Codex');
    expect(d.logs.join('\n')).toContain('--force');
    expect(fs.existsSync(out)).toBe(false); // nothing launched
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // nothing checked out
    process.exitCode = undefined;

    const r = await issueStartCommand('ISS-12', { agent: 'claude', force: true }, deps(repo, { env: { PATH: bin }, connected: () => true, api, run: async () => 0, publish: () => 'published' }));
    expect(r?.launched?.[0]).toBe(exe);
  });

  it('hands over the prompt edited on Origin as written, without building one', async () => {
    const out = path.join(bin, 'claude.argv.json');
    fakeAgent(bin, 'claude', out);
    let memoryAsked = false;
    const d = deps(repo, {
      env: { PATH: bin }, connected: () => true,
      memoryLines: () => { memoryAsked = true; return ['m']; },
      api: { ...apiFor([]), getIssue: async (_r: string, id: string) => ({ shortId: id, title: 'T', status: 'open', agentPrompt: 'Do exactly this.\nNothing else.' }) },
    });
    const r = await issueStartCommand('ISS-12', { agent: 'claude' }, d);
    expect(r!.prompt).toBe('Do exactly this.\nNothing else.');
    expect(JSON.parse(fs.readFileSync(out, 'utf-8'))).toEqual(['Do exactly this.\nNothing else.']);
    expect(memoryAsked).toBe(false);
    expect(d.logs.join('\n')).toContain('Using the prompt edited on Origin');
  });

  it('prints the prompt for cursor when cursor-agent is missing, saves and copies it', async () => {
    const d = deps(repo, { connected: () => true, api: apiFor([]) });
    const r = await issueStartCommand('ISS-12', { agent: 'cursor', branch: false }, d);
    expect(r?.launched).toBeNull();
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // --no-branch
    const file = path.join(repo, '.origin', 'issue-prompts', 'ISS-12.md');
    expect(fs.readFileSync(file, 'utf-8')).toBe(r!.prompt + '\n');
    expect(d.copied).toEqual([r!.prompt]);
    expect(d.logs.join('\n')).toContain("cursor-agent is not on your PATH");
    expect(d.logs.join('\n')).toContain("Cursor's chat");
  });

  it('falls back to printing when the agent is not on PATH', async () => {
    const d = deps(repo, { env: { PATH: bin }, connected: () => true, api: apiFor([]) });
    const r = await issueStartCommand('ISS-12', { agent: 'claude' }, d);
    expect(r?.launched).toBeNull();
    expect(r?.promptFile).toBe(path.join(repo, '.origin', 'issue-prompts', 'ISS-12.md'));
    expect(d.logs.join('\n')).toContain('claude is not on your PATH');
  });

  describe('--worktree', () => {
    const cleanup: string[] = [];
    afterEach(() => { for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

    it('starts the agent in a new worktree beside the repo, leaving a dirty checkout alone', async () => {
      fs.writeFileSync(path.join(repo, 'a.txt'), 'edited, uncommitted\n');
      const out = path.join(bin, 'claude.argv.json');
      // Records where it ran, too.
      writeAgent(bin, 'claude', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));`);
      const d = deps(repo, { env: { PATH: bin }, connected: () => true, api: apiFor([]) });
      const r = await issueStartCommand('ISS-12', { agent: 'claude', worktree: true }, d);
      const wt = issueWorktreePath(repo, 'issue/ISS-12-retry-webhook-delivery');
      cleanup.push(path.dirname(wt));
      expect(wt).toBe(path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'ISS-12-retry-webhook-delivery'));
      expect(r?.worktree).toBe(wt);
      expect(fs.realpathSync(JSON.parse(fs.readFileSync(out, 'utf-8')).cwd)).toBe(fs.realpathSync(wt));
      expect(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('issue/ISS-12-retry-webhook-delivery');
      // The main checkout kept its branch and its edit.
      expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('edited, uncommitted\n');
      // The issue link is left for the session that starts in the worktree.
      expect(JSON.parse(fs.readFileSync(pendingIssueLinkPath(wt)!, 'utf-8'))).toMatchObject({ shortId: 'ISS-12' });
    });

    it('reuses the worktree the branch is already checked out in, and takes a path', async () => {
      const at = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wt-')), 'here');
      cleanup.push(path.dirname(at));
      const d = deps(repo, { connected: () => true, api: apiFor([]) });
      const first = await issueStartCommand('ISS-12', { agent: 'print', worktree: at }, d);
      expect(first?.worktree).toBe(at);
      const again = await issueStartCommand('ISS-12', { agent: 'print', worktree: true }, d);
      // .native: os.tmpdir() can be an 8.3 short path on Windows (RUNNER~1).
      expect(fs.realpathSync.native(again!.worktree!)).toBe(fs.realpathSync.native(at));
      expect(d.logs.join('\n')).toContain('already checked out in');
    });

    it('a worktree deleted by hand is made again, not reused', async () => {
      const d = deps(repo, { connected: () => true, api: apiFor([]) });
      const first = await issueStartCommand('ISS-12', { agent: 'print', worktree: true }, d);
      cleanup.push(path.dirname(first!.worktree!));
      fs.rmSync(first!.worktree!, { recursive: true, force: true });
      const again = await issueStartCommand('ISS-12', { agent: 'print', worktree: true }, d);
      expect(again?.worktree).toBe(first!.worktree);
      expect(fs.existsSync(path.join(again!.worktree!, 'a.txt'))).toBe(true);
    });

    it('refuses --worktree with --no-branch, and a path that holds something else', async () => {
      expect(await issueStartCommand('ISS-12', { agent: 'print', worktree: true, branch: false }, deps(repo, { connected: () => true, api: apiFor([]) }))).toBeNull();
      const busy = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wt-busy-'));
      cleanup.push(busy);
      fs.writeFileSync(path.join(busy, 'x'), '');
      expect(await issueStartCommand('ISS-12', { agent: 'print', worktree: busy }, deps(repo, { connected: () => true, api: apiFor([]) }))).toBeNull();
    });

    it('a dirty checkout without --worktree is pointed at it', async () => {
      fs.writeFileSync(path.join(repo, 'a.txt'), 'edited\n');
      const d = deps(repo, { connected: () => true, api: apiFor([]) });
      expect(await issueStartCommand('ISS-12', { agent: 'print' }, d)).toBeNull();
      expect(d.logs.join('\n')).toContain('--worktree');
    });
  });

  describe('--background', () => {
    const cleanup: string[] = [];
    afterEach(() => { for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

    it('runs the agent headless in its own worktree, logs it, and lists the run', async () => {
      const out = path.join(bin, 'claude.run.json');
      const exe = writeAgent(bin, 'claude', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), child: process.env.CLAUDE_CODE_CHILD_SESSION ?? null, headless: process.env.ORIGIN_HEADLESS_RUN ?? null, endBudget: process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS ?? null }));\nconsole.log('working');`);
      const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-runs-'));
      cleanup.push(runsDir);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
      const prev = process.env.CLAUDE_CODE_CHILD_SESSION;
      process.env.CLAUDE_CODE_CHILD_SESSION = '1';
      try {
        // Stands in for `origin`: records the supervisor call, then runs the
        // agent from the record and writes the exit line, as the supervisor does.
        const supervised = path.join(bin, 'supervise.json');
        const selfEntry = path.join(bin, 'origin-self.cjs');
        fs.writeFileSync(selfEntry, [
          "const fs = require('fs'); const { spawnSync } = require('child_process');",
          `fs.writeFileSync(${JSON.stringify(supervised)}, JSON.stringify(process.argv.slice(2)));`,
          'const run = JSON.parse(fs.readFileSync(process.argv[4], "utf-8"));',
          // Like the supervisor, a Windows shim runs the script it points at (windows-shim.ts).
          'const [bin, ...args] = /\\.cmd$/i.test(run.argv[0]) ? [process.execPath, require("path").join(require("path").dirname(run.argv[0]), "node_modules", "claude", "cli.js"), ...run.argv.slice(1)] : run.argv;',
          'const r = spawnSync(bin, args, { cwd: run.worktree, encoding: "utf-8" });',
          'fs.appendFileSync(run.log, (r.stdout || "") + "[origin] agent exited with code " + r.status + "\\n");',
        ].join('\n'));
        const d = deps(repo, { env: { PATH: bin }, connected: () => true, api: apiFor([]), runsDir, self: [process.execPath, selfEntry] });
        const r = await issueStartCommand('ISS-12', { agent: 'claude', background: true }, d);
        cleanup.push(path.dirname(r!.worktree!));
        expect(r!.worktree).toBe(issueWorktreePath(repo, 'issue/ISS-12-retry-webhook-delivery'));
        expect(r!.background!.log.startsWith(runsDir)).toBe(true);
        // Detached: wait for it to finish.
        for (let i = 0; i < 100 && !/exited with code/.test(fs.existsSync(r!.background!.log) ? fs.readFileSync(r!.background!.log, 'utf-8') : ''); i++) await new Promise((x) => setTimeout(x, 50));
        const ran = JSON.parse(fs.readFileSync(out, 'utf-8'));
        expect(fs.realpathSync(ran.cwd)).toBe(fs.realpathSync(r!.worktree!));
        expect(ran.argv).toEqual(['-p', r!.prompt, '--permission-mode', 'auto']);
        expect(ran.child).toBeNull(); // the caller's session markers stayed behind
        // Marked headless, so Origin's SessionEnd ends the session, with time to do it.
        expect(ran.headless).toBe('1');
        expect(ran.endBudget).toBe('60000');
        expect(fs.readFileSync(r!.background!.log, 'utf-8')).toMatch(/working\n\[origin\] agent exited with code 0/);
        // The supervisor was started with the run's record: what to run, where, for how long.
        expect(JSON.parse(fs.readFileSync(supervised, 'utf-8'))).toEqual(['issue', 'run-supervise', r!.background!.record]);
        expect(JSON.parse(fs.readFileSync(r!.background!.record, 'utf-8'))).toMatchObject({
          shortId: 'ISS-12', agent: 'claude', worktree: r!.worktree, timeoutMin: 120,
          // The supervisor pushes the branch and opens the PR after a clean exit.
          publish: true, pullRequest: null, branch: 'issue/ISS-12-retry-webhook-delivery',
          argv: [exe, '-p', r!.prompt, '--permission-mode', 'auto'],
        });
        const runs = listBackgroundRuns(runsDir, () => false);
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ shortId: 'ISS-12', agent: 'claude', state: 'done', exitCode: 0 });
        expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('dirty\n');
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION; else process.env.CLAUDE_CODE_CHILD_SESSION = prev;
      }
    });

    it('--timeout sets the run\'s limit; 0 is none; nonsense is refused before anything starts', async () => {
      writeAgent(bin, 'claude', 'process.exit(0);');
      const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-runs-'));
      cleanup.push(runsDir);
      const started: string[] = [];
      const base = { env: { PATH: bin }, connected: () => true, api: apiFor([]), runsDir, spawnBackground: (rec: string) => { started.push(rec); return 4242; } };
      for (const [timeout, want] of [[15, 15], ['0', 0]] as const) {
        const r = await issueStartCommand('ISS-12', { agent: 'claude', background: true, timeout }, deps(repo, base));
        cleanup.push(path.dirname(r!.worktree!));
        expect(JSON.parse(fs.readFileSync(r!.background!.record, 'utf-8')).timeoutMin).toBe(want);
      }
      const d = deps(repo, base);
      expect(await issueStartCommand('ISS-12', { agent: 'claude', background: true, timeout: 'soon' }, d)).toBeNull();
      expect(d.logs.join('\n')).toContain('--timeout takes minutes');
      expect(started).toHaveLength(2);
    });

    it('`issue runs` reports a run stopped at its limit as timed out', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-runs-'));
      cleanup.push(dir);
      const log = path.join(dir, 'a.log');
      fs.writeFileSync(log, 'working\n[origin] agent timed out after 120 min\n[origin] agent exited with code 124\n');
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ shortId: 'ISS-1', agent: 'cursor', pid: 1, log, worktree: '/w', startedAt: '2026-10-13T00:00:00Z' }));
      expect(listBackgroundRuns(dir, () => false)[0]).toMatchObject({ state: 'timed out', exitCode: 124 });
    });

    describe('questions: the pre-start pass and going on after an answer', () => {
      const runsDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-runs-')); cleanup.push(d); return d; };
      const record = (r: any) => JSON.parse(fs.readFileSync(r!.background!.record, 'utf-8'));
      const withQuestions = (questions: any[], over: any = {}) => ({
        ...apiFor([]),
        getIssue: async (_r: string, id: string) => ({ shortId: id, title: 'Retry webhook delivery', description: 'It drops on 502.', status: 'open', source: null, clarifications: questions }),
        ...over,
      });

      it('asks the pass\'s questions in the terminal, keeps the answers on the issue, and starts with them and the brief', async () => {
        const exe = writeAgent(bin, 'claude', 'process.exit(0);');
        const posted: any[] = [];
        const pfCalls: any[] = [];
        const api = withQuestions([], {
          postIssueQuestions: async (_r: string, _s: string, data: any) => {
            posted.push(data);
            return { clarifications: data.questions.map((q: any, i: number) => ({ id: `q${i}`, ...q, from: 'preflight', agent: 'claude', agentSessionId: null })) };
          },
        });
        const d = deps(repo, {
          env: { PATH: bin }, connected: () => true, api, runsDir: runsDir(), spawnBackground: () => 4242,
          preflight: async (agent, prompt, cwd, bin) => { pfCalls.push({ agent, prompt, cwd, bin }); return { ready: false, brief: 'Retries live in apps/api/src/services/webhook.ts.', questions: ['Retry how many times?'] }; },
          ask: async () => '3 times, then give up',
        });
        const r = await issueStartCommand('ISS-12', { agent: 'claude', background: true }, d);
        cleanup.push(path.dirname(r!.worktree!));
        expect(pfCalls).toHaveLength(1);
        expect(pfCalls[0]).toMatchObject({ agent: 'claude', bin: exe, cwd: r!.worktree });
        expect(pfCalls[0].prompt).toContain('do not make the change');
        expect(pfCalls[0].prompt).toContain('Work on issue ISS-12: Retry webhook delivery');
        expect(posted).toEqual([{ questions: [{ question: 'Retry how many times?', answer: '3 times, then give up' }], agent: 'claude' }]);
        expect(r!.prompt).toContain('Q: Retry how many times?');
        expect(r!.prompt).toContain('A: 3 times, then give up');
        expect(r!.prompt).toContain('Retries live in apps/api/src/services/webhook.ts.');
        expect(record(r).argv).toEqual([exe, '-p', r!.prompt, '--permission-mode', 'auto']);
      });

      it('an unanswered question goes on the issue and nothing starts', async () => {
        writeAgent(bin, 'claude', 'process.exit(0);');
        const posted: any[] = [];
        const started: string[] = [];
        const api = withQuestions([], { postIssueQuestions: async (_r: string, _s: string, data: any) => { posted.push(data); return { clarifications: [] }; } });
        const d = deps(repo, {
          env: { PATH: bin }, connected: () => true, api, runsDir: runsDir(), spawnBackground: (rec: string) => { started.push(rec); return 1; },
          preflight: async () => ({ ready: false, brief: '', questions: ['Which endpoint?'] }),
          ask: async () => null,
        });
        const r = await issueStartCommand('ISS-12', { agent: 'claude', background: true }, d);
        cleanup.push(path.dirname(issueWorktreePath(repo, 'issue/ISS-12-retry-webhook-delivery')));
        expect(r).toBeNull();
        expect(started).toEqual([]);
        expect(posted[0].questions).toEqual([{ question: 'Which endpoint?', answer: null }]);
        expect(d.logs.join('\n')).toContain('origin issue answer ISS-12');
      });

      it('--no-preflight, an agent that can\'t, and a race arm skip the pass', async () => {
        writeAgent(bin, 'claude', 'process.exit(0);');
        writeAgent(bin, 'gemini', 'process.exit(0);');
        let calls = 0;
        const base = { env: { PATH: bin }, connected: () => true, api: apiFor([]), runsDir: runsDir(), spawnBackground: () => 1, preflight: async () => { calls++; return null; } };
        for (const opts of [{ agent: 'claude', preflight: false }, { agent: 'gemini' }, { agent: 'claude', branchSuffix: 'claude' }]) {
          const r = await issueStartCommand('ISS-12', { background: true, ...opts }, deps(repo, base));
          cleanup.push(path.dirname(r!.worktree!));
        }
        expect(calls).toBe(0);
      });

      it('goes on with the session that asked, once answered, when it is on this computer', async () => {
        const exe = writeAgent(bin, 'claude', 'process.exit(0);');
        const api = withQuestions([
          { id: 'a', question: 'Retry how many times?', answer: '3', from: 'run', agent: 'claude', agentSessionId: 'sess-1111-2222' },
        ]);
        let pf = 0;
        const looked: any[] = [];
        const d = deps(repo, {
          env: { PATH: bin }, connected: () => true, api, runsDir: runsDir(), spawnBackground: () => 1,
          preflight: async () => { pf++; return null; },
          hasSession: async (agent, id, work) => { looked.push({ agent, id, work }); return true; },
        });
        const r = await issueStartCommand('ISS-12', { agent: 'claude', background: true }, d);
        cleanup.push(path.dirname(r!.worktree!));
        expect(looked).toEqual([{ agent: 'claude', id: 'sess-1111-2222', work: r!.worktree }]);
        expect(pf).toBe(0);
        expect(r!.prompt).toContain('You stopped working on issue ISS-12 to ask for input');
        expect(r!.prompt).toContain('A: 3');
        expect(r!.prompt).toContain('[Origin: Outcome]');
        expect(r!.prompt).not.toContain('It drops on 502.');
        expect(record(r).argv).toEqual([exe, '-p', r!.prompt, '--resume', 'sess-1111-2222', '--permission-mode', 'auto']);
      });

      it('goes on with the asker only while its run is the newest: a later run already went on with the answers', async () => {
        const exe = writeAgent(bin, 'claude', 'process.exit(0);');
        const q = { id: 'a', question: 'Retry how many times?', answer: '3', from: 'run', agent: 'claude', agentSessionId: 'sess-1', sessionId: 'row-1' };
        for (const [runs, resumed] of [[[{ sessionId: 'row-1' }], true], [[{ sessionId: 'row-2' }, { sessionId: 'row-1' }], false]] as const) {
          const api = { ...apiFor([]), getIssue: async (_r: string, id: string) => ({ shortId: id, title: 'Retry webhook delivery', status: 'open', source: null, clarifications: [q], runs }) };
          const d = deps(repo, { env: { PATH: bin }, connected: () => true, api, runsDir: runsDir(), spawnBackground: () => 1, hasSession: async () => true });
          const r = await issueStartCommand('ISS-12', { agent: 'claude', background: true }, d);
          cleanup.push(path.dirname(r!.worktree!));
          expect(record(r).argv.includes('--resume')).toBe(resumed);
          expect(record(r).argv[0]).toBe(exe);
        }
      });

      it('starts fresh, with the answers in the prompt, when the session is elsewhere, another agent asked, or --no-resume', async () => {
        const exe = writeAgent(bin, 'claude', 'process.exit(0);');
        const q = { id: 'a', question: 'Retry how many times?', answer: '3', from: 'run', agent: 'claude', agentSessionId: 'sess-1' };
        const cases: Array<[any[], any, boolean]> = [
          [[q], {}, false],
          [[{ ...q, agent: 'codex' }], {}, true],
          [[q], { resume: false }, true],
        ];
        for (const [questions, opts, has] of cases) {
          const d = deps(repo, { env: { PATH: bin }, connected: () => true, api: withQuestions(questions), runsDir: runsDir(), spawnBackground: () => 1, hasSession: async () => has });
          const r = await issueStartCommand('ISS-12', { agent: 'claude', background: true, ...opts }, d);
          cleanup.push(path.dirname(r!.worktree!));
          expect(record(r).argv).toEqual([exe, '-p', r!.prompt, '--permission-mode', 'auto']);
          expect(r!.prompt).toContain('Work on issue ISS-12');
          expect(r!.prompt).toContain('Q: Retry how many times?\n  A: 3');
        }
      });
    });

    it('refuses print, and a missing agent CLI', async () => {
      expect(await issueStartCommand('ISS-12', { agent: 'print', background: true }, deps(repo))).toBeNull();
      const d = deps(repo, { env: { PATH: bin }, connected: () => true, api: apiFor([]) });
      const r = await issueStartCommand('ISS-12', { agent: 'codex', background: true }, d);
      expect(r).toBeNull();
      expect(fs.existsSync(issueWorktreePath(repo, 'issue/ISS-12-retry-webhook-delivery'))).toBe(false);
      expect(d.logs.join('\n')).toContain('codex is not on your PATH');
    });

    it('refuses a signed-out agent before making a worktree, and fails the run on the issue', async () => {
      writeAgent(bin, 'claude', "console.log('should not run')");
      const runs: any[] = [];
      const api = {
        ...apiFor([]),
        startIssueRun: async (_r: string, _s: string, data: any) => { runs.push({ start: data }); return { id: 'run-1' }; },
        endIssueRun: async (_r: string, _s: string, id: string, data: any) => { runs.push({ end: id, ...data }); },
      };
      const asked: string[] = [];
      const d = deps(repo, { env: { PATH: bin }, connected: () => true, api, signedIn: async (a) => { asked.push(a); return false; } });
      const r = await issueStartCommand('ISS-12', { agent: 'claude', background: true }, d);
      expect(r).toBeNull();
      expect(process.exitCode).toBe(1);
      expect(asked).toEqual(['claude']);
      expect(fs.existsSync(issueWorktreePath(repo, 'issue/ISS-12-retry-webhook-delivery'))).toBe(false);
      expect(d.logs.join('\n')).toContain('claude is not signed in on this computer');
      expect(runs[1]).toMatchObject({ end: 'run-1', status: 'failed', exitCode: 1 });
      expect(runs[1].detail).toContain('origin agents login claude');
    });
  });

  it('refuses a dirty tree before anything else happens', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edited\n');
    const updates: any[] = [];
    const d = deps(repo, { connected: () => true, api: apiFor(updates) });
    const r = await issueStartCommand('ISS-12', { agent: 'print' }, d);
    expect(r).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(updates).toEqual([]);
    expect(fs.existsSync(pendingIssueLinkPath(repo)!)).toBe(false);
  });

  it('a GitHub issue: #123 finds it, the branch is issue/123-<slug>, the prompt names #123 and asks for Fixes', async () => {
    const asked: string[] = [];
    const d = deps(repo, {
      connected: () => true,
      api: {
        ...apiFor([]),
        getIssue: async (_r: string, id: string) => {
          asked.push(id);
          return { shortId: '123', title: 'Login redirect loops', status: 'open', source: 'github', provider: 'github', hostNumber: 123, hostUrl: 'https://github.com/acme/app/issues/123' };
        },
      },
    });
    const r = await issueStartCommand('#123', { agent: 'print' }, d);
    expect(asked).toEqual(['123']);
    expect(r!.branch).toBe('issue/123-login-redirect-loops');
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('issue/123-login-redirect-loops');
    expect(r!.prompt).toContain('Work on GitHub issue #123: Login redirect loops');
    expect(r!.prompt).toContain('mention #123 in the commit message');
    expect(r!.prompt).toContain('put `Fixes #123` in its description so GitHub closes the issue');
  });

  it('a repo-memory TODO gets the Closes line', async () => {
    const d = deps(repo, { openTodos: () => [{ id: 'beef5678', text: 'Retry the upload' }] });
    const r = await issueStartCommand('beef5678', { agent: 'print', branch: false }, d);
    expect(r?.prompt).toContain('[Origin: Closes] beef5678');
  });

  it('rejects an unknown agent', async () => {
    const d = deps(repo);
    expect(await issueStartCommand('X', { agent: 'vim' }, d)).toBeNull();
    expect(process.exitCode).toBe(2);
  });

  it('findOnPath finds only executables', () => {
    fs.writeFileSync(path.join(bin, 'notexec'), 'x');
    fs.chmodSync(path.join(bin, 'notexec'), 0o644);
    // Windows has no execute bit: an extensionless file is not on PATHEXT, so not a program.
    expect(findOnPath('notexec', { PATH: bin }, WIN ? 'win32' : 'linux')).toBeNull();
    const exe = fakeAgent(bin, 'codex', path.join(bin, 'x.json'));
    expect(findOnPath('codex', { PATH: bin }, WIN ? 'win32' : 'linux')).toBe(exe);
    if (WIN) expect(exe).toBe(path.join(bin, 'codex.CMD'));
  });

  // The prompt is an issue's title and body: anyone who can file an issue
  // writes it. On Windows the agent is a .cmd shim, and cmd.exe would run
  // `& calc` in it — the shim is never run, its node script is.
  it('a prompt full of shell metacharacters reaches the agent byte for byte', async () => {
    const out = path.join(bin, 'claude.argv.json');
    const marker = path.join(bin, 'pwned');
    const nasty = [
      `Fix "quoted" & echo pwned > ${marker} | more ^& %PATH% %%CD%% !PATH! ^`,
      `a\\"b \\\\" c' $(touch ${marker}) \`touch ${marker}\` ; rm -rf x\t<in >out 2>&1 ||| &&`,
      '"',
    ].join('\n');
    fakeAgent(bin, 'claude', out);
    const d = deps(repo, {
      env: { PATH: bin }, connected: () => true,
      api: { ...apiFor([]), getIssue: async (_r: string, id: string) => ({ shortId: id, title: 'T', status: 'open', agentPrompt: nasty }) },
    });
    const r = await issueStartCommand('ISS-12', { agent: 'claude' }, d);
    expect(r?.launched).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(out, 'utf-8'))).toEqual([nasty]);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('the session → issue link', () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it('is taken once', () => {
    writePendingIssueLink(repo, { shortId: 'ISS-1', repoId: 'r' });
    expect(takePendingIssueLink(repo)?.shortId).toBe('ISS-1');
    expect(takePendingIssueLink(repo)).toBeNull();
    expect(fs.readdirSync(path.join(repo, '.git')).filter((f) => f.startsWith('origin-issue-link'))).toEqual([]);
  });

  it('expires after an hour', () => {
    const t0 = Date.now();
    writePendingIssueLink(repo, { shortId: 'ISS-1', repoId: 'r' }, t0);
    expect(takePendingIssueLink(repo, t0 + ISSUE_LINK_TTL_MS + 1)).toBeNull();
  });

  it('lives in a linked worktree\'s own git dir', () => {
    const wt = path.join(repo, 'wt');
    sh(repo, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
    const file = writePendingIssueLink(wt, { shortId: 'ISS-9', repoId: 'r' });
    expect(file).toBe(path.join(fs.realpathSync.native(repo), '.git', 'worktrees', 'wt', 'origin-issue-link.json'));
    expect(takePendingIssueLink(repo)).toBeNull(); // not the main checkout's
    expect(takePendingIssueLink(wt)?.shortId).toBe('ISS-9');
  });

  it('session-start links the new session on the API, once', async () => {
    writePendingIssueLink(repo, { shortId: 'ISS-1', repoId: 'repo-1' });
    const calls: string[] = [];
    const link = async (r: string, s: string, sid: string, run?: string | null) => { calls.push(`${r}/${s}/${sid}/${run}`); };
    await linkPendingIssue(repo, 'sess-1', link);
    await linkPendingIssue(repo, 'sess-2', link);
    expect(calls).toEqual(['repo-1/ISS-1/sess-1/undefined']); // an old CLI's link: no runId at all

    writePendingIssueLink(repo, { shortId: 'ISS-1', repoId: 'repo-1', runId: 'run-3' });
    await linkPendingIssue(repo, 'sess-3', link);
    expect(calls[1]).toBe('repo-1/ISS-1/sess-3/run-3');
    writePendingIssueLink(repo, { shortId: 'ISS-1', repoId: 'repo-1', runId: null });
    await linkPendingIssue(repo, 'sess-4', link);
    expect(calls[2]).toBe('repo-1/ISS-1/sess-4/null');
  });

  it('the claim the link took is kept for the agent, per session, and dropped when it ends', async () => {
    writePendingIssueLink(repo, { shortId: 'ISS-1', repoId: 'repo-1', runId: 'run-1' });
    await linkPendingIssue(repo, 'sess-1', async () => ({ ok: true, claim: { claimed: true, shortId: 'ISS-1', claimToken: 'tok-1', leaseExpiresAt: '2026-10-15T20:00:00.000Z' } }));
    expect(readSessionClaims(repo, 'sess-1')).toEqual([{ repoId: 'repo-1', shortId: 'ISS-1', claimToken: 'tok-1', leaseExpiresAt: '2026-10-15T20:00:00.000Z' }]);
    expect(readSessionClaims(repo, 'sess-2')).toEqual([]);
    const file = path.join(fs.realpathSync.native(repo), '.git', 'origin-task-claims', 'sess-1.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    dropSessionClaim(repo, 'sess-1', 'repo-1', 'ISS-1');
    expect(readSessionClaims(repo, 'sess-1')).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);

    // Someone else holds it: linked, nothing kept.
    writePendingIssueLink(repo, { shortId: 'ISS-2', repoId: 'repo-1' });
    await linkPendingIssue(repo, 'sess-3', async () => ({ ok: true, claim: { claimed: false, reason: 'claimed' } }));
    expect(readSessionClaims(repo, 'sess-3')).toEqual([]);
  });

  it('a local-only issue records the session in .origin/issues', async () => {
    fs.mkdirSync(path.join(repo, '.origin', 'issues'), { recursive: true });
    const f = path.join(repo, '.origin', 'issues', 'ori-1.json');
    fs.writeFileSync(f, JSON.stringify({ id: 'ori-1', title: 't', sessions: [] }));
    writePendingIssueLink(repo, { shortId: 'ori-1', repoId: null });
    await linkPendingIssue(repo, 'sess-9', async () => { throw new Error('must not call the API'); });
    expect(JSON.parse(fs.readFileSync(f, 'utf-8')).sessions).toEqual(['sess-9']);
  });
});

// The take happens inside handleSessionStart, after session/start answered;
// pinned by reading the source, as every-producer-stamps does for its re-send.
describe("session-start's half of the link", () => {
  it('links the server session id right after session/start returns', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks', 'session-start.ts'), 'utf-8');
    const returned = src.indexOf("debugLog('session-start', 'api returned'");
    const linked = src.indexOf('await linkPendingIssue(');
    expect(returned).toBeGreaterThan(-1);
    expect(linked).toBeGreaterThan(returned);
    // Inside the same connected try — before the catch that falls back to a local session.
    expect(src.slice(returned, linked)).not.toContain('} catch (apiErr');
    expect(src.slice(linked, linked + 300)).toContain('api.linkIssueSession(repoId, shortId, sid, 5000, runId)');
  });
});

describe('a review fix: the pull request branch', () => {
  it('a branch that exists only on the remote is tracked, not re-created from the default branch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-pr-branch-'));
    const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();
    try {
      const remote = path.join(root, 'r.git');
      g(root, 'init', '-q', '--bare', '-b', 'main', remote);
      const a = path.join(root, 'a');
      g(root, 'clone', '-q', remote, a);
      g(a, 'config', 'user.email', 't@e.com'); g(a, 'config', 'user.name', 'T');
      fs.writeFileSync(path.join(a, 'x.txt'), 'base\n'); g(a, 'add', '.'); g(a, 'commit', '-qm', 'base'); g(a, 'push', '-q', 'origin', 'main');
      g(a, 'checkout', '-q', '-b', 'claude/totals');
      fs.writeFileSync(path.join(a, 'x.txt'), 'pr work\n'); g(a, 'commit', '-qam', 'pr'); g(a, 'push', '-q', 'origin', 'claude/totals');
      const prTip = g(a, 'rev-parse', 'HEAD');

      // A reviewer's machine: cloned before the PR branch existed.
      const b = path.join(root, 'b');
      g(root, 'clone', '-q', '--branch', 'main', '--single-branch', remote, b);
      const r = checkoutIssueBranch(b, 'claude/totals');
      expect(r).toEqual({ created: false, base: 'origin/claude/totals' });
      expect(g(b, 'rev-parse', 'HEAD')).toBe(prTip);
      // A plain `git push` — what the agent runs — updates the PR's branch.
      g(b, 'config', 'user.email', 'r@e.com'); g(b, 'config', 'user.name', 'R');
      fs.writeFileSync(path.join(b, 'x.txt'), 'review fix\n'); g(b, 'commit', '-qam', 'fix');
      g(b, 'push', '-q');
      expect(g(remote, 'rev-parse', 'claude/totals')).toBe(g(b, 'rev-parse', 'HEAD'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the prompt pushes to the pull request instead of opening one, and the command names its branch', () => {
    const p = buildIssuePrompt({ shortId: 'ori-ab12', title: 'Review: a.ts:3', branch: 'claude/totals', pullRequest: 7 });
    expect(p).toContain('push the branch so pull request #7 updates. Do not open a new pull request.');
    expect(buildIssuePrompt({ shortId: 'ori-ab12', title: 't', branch: 'issue/x' })).not.toContain('pull request #');
    expect(startCommandText('ori-ab12', 'claude', 'claude/totals')).toBe('origin issue start ori-ab12 --agent claude --branch claude/totals');
    expect(startCommandText('ori-ab12', 'claude', "we'ird name")).toBe("origin issue start ori-ab12 --agent claude --branch 'we'\\''ird name'");
    expect(startCommandText('ori-ab12')).toBe('origin issue start ori-ab12 --agent claude');
  });
});

describe('background run end, as the Start dialog hears it', () => {
  it('maps the exit code and keeps the log tail short', async () => {
    const { runEndStatus, logTail } = await import('../background-supervisor.js');
    expect(runEndStatus(0)).toBe('done');
    expect(runEndStatus(124)).toBe('timed_out');
    expect(runEndStatus(1)).toBe('failed');
    const log = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n\n';
    expect(logTail(log, 3)).toBe('line 47\nline 48\nline 49');
  });
});

describe('issueBusy and the force link', () => {
  it('counts a live session and an unfinished recent run, once each', async () => {
    const { issueBusy, parseIssueLaunchUrl, issueLaunchUrl } = await import('../issue-prompt.js');
    const now = Date.parse('2026-10-13T02:00:00Z');
    expect(issueBusy({
      sessions: [{ sessionId: 's1', state: 'running', userName: 'Ihor', agent: { name: 'Codex' }, createdAt: '2026-10-13T01:50:00Z' }, { state: 'done' }],
      runs: [
        { status: 'started', agent: 'codex', startedAt: '2026-10-13T01:49:00Z' },              // the run behind s1
        { status: 'started', agent: 'antigravity', startedAt: '2026-10-13T01:58:00Z', mine: true },
        { status: 'failed', agent: 'claude', startedAt: '2026-10-13T01:59:00Z' },
        { status: 'started', agent: 'claude', startedAt: '2026-10-12T20:00:00Z' },             // stale
      ],
    }, now).map((b) => `${b.who}/${b.agent}`)).toEqual(['Ihor/Codex', 'You/antigravity']);
    const url = issueLaunchUrl('r1', 'ISS-1', 'claude', null, { background: true, force: true });
    expect(url).toContain('&force=1');
    expect(parseIssueLaunchUrl(url)).toMatchObject({ background: true, force: true });
    expect(parseIssueLaunchUrl(issueLaunchUrl('r1', 'ISS-1', 'claude'))?.force).toBeFalsy();
  });
});
