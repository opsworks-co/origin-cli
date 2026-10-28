// Reviewer agents, the CLI side: the pure helpers (review-run.ts) and one
// `origin review run` against a real temp git repo with a fake API and a fake
// agent (plain `node`) — the worktree on review/<pr>/<run> at the fetched
// head, the start and result posted, the worktree gone afterwards.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  agentReviewArgv, parseReviewLaunchUrl, parseReviewResult, reviewBranchName, reviewLaunchUrl, reviewWorktreePath,
  REVIEW_RESULT_FILE, REVIEW_RESULT_SCHEMA, type ReviewPacket,
} from '../review-run.js';
import { remoteFor, reviewRunCommand, reviewWorktree, type ReviewReport, type ReviewRunDeps } from '../commands/review-run.js';
import { reviewLaunchScript, reviewBackgroundCommandLine, reviewLogFile } from '../url-handler.js';

const RUN = '3f2a9c1e-7b4d-4e8a-9f10-aaaaaaaaaaaa';
const FILES = { schemaFile: '/w/.origin-review-schema.json', outFile: '/w/.origin-review-result.json', schema: REVIEW_RESULT_SCHEMA };

describe('names', () => {
  it('branch and worktree carry the PR number and the run\'s short id', () => {
    expect(reviewBranchName(42, RUN)).toBe('review/42/3f2a9c1e');
    expect(reviewWorktreePath('/code/app', 42, RUN)).toBe(path.join('/code', 'app-worktrees', 'review-42-3f2a9c1e'));
  });
});

describe('argv', () => {
  it('claude: print mode, plan permissions, the schema inline; hooks and the session stay on', () => {
    const a = agentReviewArgv('claude', 'look', FILES)!;
    expect(a.slice(0, 5)).toEqual(['claude', '-p', 'look', '--permission-mode', 'plan']);
    expect(a).toContain('--json-schema');
    expect(JSON.parse(a[a.indexOf('--json-schema') + 1])).toEqual(REVIEW_RESULT_SCHEMA);
    expect(a).not.toContain('--no-session-persistence');
    expect(a.join(' ')).not.toContain('disableAllHooks');
  });
  it('codex: read-only exec with the schema and out files', () => {
    expect(agentReviewArgv('codex', 'look', FILES)).toEqual(['codex', 'exec', '-s', 'read-only', '--skip-git-repo-check', '--output-schema', FILES.schemaFile, '-o', FILES.outFile, 'look']);
  });
  it('the others run headless without edit rights', () => {
    expect(agentReviewArgv('gemini', 'look', FILES)).toEqual(['gemini', '-p', 'look', '--approval-mode', 'default', '--skip-trust']);
    expect(agentReviewArgv('cursor', 'look', FILES)).toEqual(['cursor-agent', '-p', 'look', '--trust']);
    expect(agentReviewArgv('copilot', 'look', FILES)).toEqual(['copilot', '-p', 'look']);
    expect(agentReviewArgv('antigravity', 'look', FILES, { antigravityProject: 'p1' })).toEqual(['agy', '-p', 'look', '--project', 'p1', '--print-timeout', '120m']);
  });
  it("the reviewer's model (its own, else its agent's from Agents) goes on as each CLI's model flag; agy takes none", () => {
    const model = { model: 'claude-opus-4-7' };
    expect(agentReviewArgv('claude', 'look', FILES, model)!.slice(-2)).toEqual(['--model', 'claude-opus-4-7']);
    expect(agentReviewArgv('codex', 'look', FILES, { model: 'gpt-5.6' })).toEqual(['codex', 'exec', '-s', 'read-only', '--skip-git-repo-check', '-m', 'gpt-5.6', '--output-schema', FILES.schemaFile, '-o', FILES.outFile, 'look']);
    expect(agentReviewArgv('gemini', 'look', FILES, model)!.slice(-2)).toEqual(['-m', 'claude-opus-4-7']);
    expect(agentReviewArgv('cursor', 'look', FILES, model)!.slice(-2)).toEqual(['--model', 'claude-opus-4-7']);
    expect(agentReviewArgv('copilot', 'look', FILES, model)).toEqual(['copilot', '-p', 'look', '--model', 'claude-opus-4-7']);
    expect(agentReviewArgv('antigravity', 'look', FILES, { antigravityProject: 'p1', ...model })).not.toContain('claude-opus-4-7');
    expect(agentReviewArgv('claude', 'look', FILES, { model: '  ' })).not.toContain('--model');
  });
});

describe('parseReviewResult', () => {
  const answer = { verdict: 'request_changes', summary: 'one bug', findings: [{ path: 'a.ts', line: 3, severity: 'high', title: 'null deref', detail: 'x', failureScenario: 'y', confidence: 'confirmed' }] };
  it('reads a bare object', () => {
    expect(parseReviewResult(JSON.stringify(answer))).toEqual(answer);
  });
  it("reads claude's print-mode envelope: structured_output first, then a result string", () => {
    expect(parseReviewResult(JSON.stringify({ type: 'result', structured_output: answer, result: 'ignored' }))).toEqual(answer);
    expect(parseReviewResult(JSON.stringify({ type: 'result', result: `Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` }))).toEqual(answer);
  });
  it('reads a fenced block and an object inside prose', () => {
    expect(parseReviewResult(`Sure.\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\nDone.`)).toEqual(answer);
    expect(parseReviewResult(`Answer: ${JSON.stringify(answer)} — that is all`)).toEqual(answer);
  });
  it('normalises severity, confidence, verdict and line; drops a finding without a path or title', () => {
    const r = parseReviewResult(JSON.stringify({ verdict: 'Changes Requested', summary: 's', findings: [
      { path: 'a.ts', line: '12', severity: 'CRITICAL', title: 't', detail: 'd', confidence: 'sure' },
      { path: 'b.ts', line: 0, severity: 'nit', title: 'u', detail: '' , failure_scenario: 'fs' },
      { line: 1, severity: 'high', title: 'no path' },
    ] }))!;
    expect(r.verdict).toBe('request_changes');
    expect(r.findings).toEqual([
      { path: 'a.ts', line: 12, severity: 'high', title: 't', detail: 'd', failureScenario: null, confidence: 'plausible' },
      { path: 'b.ts', line: null, severity: 'low', title: 'u', detail: 'u', failureScenario: 'fs', confidence: 'plausible' },
    ]);
    expect(parseReviewResult(JSON.stringify({ verdict: 'LGTM', summary: 'fine', findings: [] }))!.verdict).toBe('approve');
  });
  it('is null for nothing, prose, or an unrelated object', () => {
    expect(parseReviewResult('')).toBeNull();
    expect(parseReviewResult('I could not review this.')).toBeNull();
    expect(parseReviewResult(JSON.stringify({ ready: true, brief: 'x' }))).toBeNull();
  });
});

describe('the launch link', () => {
  it('round-trips, carrying ids only', () => {
    const url = reviewLaunchUrl('repo-1', [RUN, 'b2'], 42, 'acme/app');
    expect(url).toBe(`getorigin://review/run?repo=repo-1&runs=${encodeURIComponent(`${RUN},b2`)}&pr=42&name=acme%2Fapp`);
    expect(parseReviewLaunchUrl(url)).toEqual({ repoId: 'repo-1', runIds: [RUN, 'b2'], prNumber: 42, repoName: 'acme/app' });
    expect(parseReviewLaunchUrl(reviewLaunchUrl('r', ['x'], 7))).toEqual({ repoId: 'r', runIds: ['x'], prNumber: 7, repoName: null });
  });
  it('refuses anything that is not a plain id, a bad PR number, or another link', () => {
    expect(parseReviewLaunchUrl('getorigin://review/run?repo=r&runs=a;rm&pr=1')).toBeNull();
    expect(parseReviewLaunchUrl('getorigin://review/run?repo=r&runs=&pr=1')).toBeNull();
    expect(parseReviewLaunchUrl('getorigin://review/run?repo=r&runs=a&pr=0')).toBeNull();
    expect(parseReviewLaunchUrl('getorigin://review/run?repo=r&runs=a&pr=x')).toBeNull();
    expect(parseReviewLaunchUrl('getorigin://issue/start?repo=r&issue=a&agent=claude')).toBeNull();
    expect(parseReviewLaunchUrl('getorigin://review/run?repo=r&runs=a&pr=1&name=../etc')).toEqual({ repoId: 'r', runIds: ['a'], prNumber: 1, repoName: null });
  });
  it('the terminal script cds into the checkout and runs origin review run with every id quoted', () => {
    const s = reviewLaunchScript("/Users/me/it's here", { repoId: 'r', runIds: ['a1', 'b2'], prNumber: 9, repoName: null }, ['/usr/bin/node', '/opt/origin/index.js']);
    expect(s).toContain(`cd '/Users/me/it'\\''s here' || exit 1`);
    const run = s.split('\n').find((l) => l.includes('review run'))!;
    expect(run.startsWith('exec "${SHELL:-/bin/sh}" -ilc ')).toBe(true);
    const inner = execFileSync('sh', ['-c', `printf %s ${run.slice('exec "${SHELL:-/bin/sh}" -ilc '.length)}`], { encoding: 'utf-8' });
    expect(inner).toBe(`'/usr/bin/node' '/opt/origin/index.js' review run 'a1' 'b2'; exec "\${SHELL:-/bin/sh}" -il`);
    const none = reviewLaunchScript(null, { repoId: 'r', runIds: ['a1'], prNumber: 9, repoName: 'acme/app' }, ['n', 'o']);
    expect(none).toContain('could not find a checkout of acme/app');
    expect(none).toContain('origin review run a1');
  });
  it('a background review runs origin review run with every id quoted, then says how it ended on macOS', () => {
    const req = { repoId: 'r', runIds: ['a1', "b'2"], prNumber: 9, repoName: null };
    const linux = reviewBackgroundCommandLine(req, ['/usr/bin/node', '/opt/origin/index.js'], 'linux', '/l.log');
    expect(linux).toBe(`'/usr/bin/node' '/opt/origin/index.js' review run 'a1' 'b'\\''2'`);
    // The ids reach the CLI as separate words, quotes intact.
    const words = execFileSync('sh', ['-c', linux.replace(`'/usr/bin/node' '/opt/origin/index.js'`, `printf '%s\\n'`)], { encoding: 'utf-8' });
    expect(words.trim().split('\n')).toEqual(['review', 'run', 'a1', "b'2"]);
    const mac = reviewBackgroundCommandLine(req, ['/usr/bin/node', '/opt/origin/index.js'], 'darwin', '/l.log');
    execFileSync('sh', ['-n', '-c', mac]);
    // Success and failure each say so: run the line with the CLI swapped for true / false and osascript for echo.
    const ending = (cli: string) => execFileSync('sh', ['-c', mac.replace(`'/usr/bin/node' '/opt/origin/index.js' review run 'a1' 'b'\\''2'`, cli).replace(/osascript -e /g, 'echo ').replace(/ >\/dev\/null 2>&1/g, '')], { encoding: 'utf-8' });
    expect(ending('true')).toContain('Reviewers finished on PR #9');
    expect(ending('false')).toContain('A reviewer failed on PR #9. Log: /l.log');
  });
  it('each background review writes its own log under ~/.origin/review-runs', () => {
    expect(reviewLogFile(42, 1700000000000)).toMatch(/\.origin[\\/]review-runs[\\/]1700000000000-pr42\.log$/);
  });
});

describe('origin review run', () => {
  let tmp: string;
  let upstream: string;
  let checkout: string;
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-review-'));
    // An "upstream" with a PR branch, and a clone of it: the review fetches
    // the PR's head from the remote, never from a local branch.
    upstream = path.join(tmp, 'upstream');
    fs.mkdirSync(upstream);
    g(upstream, 'init', '-q', '-b', 'main');
    g(upstream, 'config', 'user.email', 't@t');
    g(upstream, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(upstream, 'a.txt'), 'one\n');
    g(upstream, 'add', '.');
    g(upstream, 'commit', '-q', '-m', 'init');
    checkout = path.join(tmp, 'app');
    g(tmp, 'clone', '-q', upstream, 'app');
    g(checkout, 'config', 'user.email', 't@t');
    g(checkout, 'config', 'user.name', 'T');
    // The PR branch lands upstream AFTER the clone.
    g(upstream, 'checkout', '-q', '-b', 'feat/x');
    fs.writeFileSync(path.join(upstream, 'a.txt'), 'one\ntwo\n');
    g(upstream, 'commit', '-q', '-am', 'pr change');
    g(upstream, 'checkout', '-q', 'main');
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function deps(over: Partial<ReviewRunDeps> = {}, calls: { start: any[]; result: any[] } = { start: [], result: [] }): ReviewRunDeps & { calls: typeof calls } {
    const packet: ReviewPacket = {
      run: { id: RUN, status: 'queued' },
      pr: { id: 'pr-1', number: 42, title: 'Add two', url: 'https://github.com/acme/app/pull/42', headBranch: 'feat/x', baseBranch: 'main', headSha: null, repoId: 'repo-1', repoFullName: 'acme/app' },
      reviewer: { id: 'rv-1', name: 'Security', agent: 'claude', model: null, instructions: 'look for bugs', pathFilter: null },
      prompt: 'Review this.',
      resultSchema: REVIEW_RESULT_SCHEMA,
      resultFile: REVIEW_RESULT_FILE,
    };
    return {
      calls,
      cwd: checkout,
      env: process.env,
      platform: process.platform,
      hostname: 'box',
      log: () => {},
      error: () => {},
      api: {
        getReviewRunPacket: async () => packet,
        startReviewRun: async (id, data) => { calls.start.push({ id, ...data }); return {}; },
        reportReviewRun: async (id, data: ReviewReport) => { calls.result.push({ id, ...data }); return {}; },
      },
      run: (exe, args, cwd, env, capture) => new Promise((resolve) => {
        const r = execFileSync(exe, args, { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        resolve({ code: 0, stdout: capture ? r : '' });
      }),
      // The "agent" is node: it records where it ran and writes the answer file.
      agentArgvFor: (_agent, prompt, files) => ['node', '-e', `
        const fs = require('fs');
        fs.writeFileSync('ran-here.txt', process.cwd() + '\\n' + ${JSON.stringify(prompt)});
        fs.writeFileSync(${JSON.stringify(files.outFile)}, JSON.stringify({ verdict: 'request_changes', summary: 'a.txt grew', findings: [{ path: 'a.txt', line: 2, severity: 'medium', title: 'two', detail: 'd', failureScenario: null, confidence: 'confirmed' }] }));
      `],
      ...over,
    };
  }

  it('fetches the head, reviews it in a worktree on review/<pr>/<run>, posts start and findings, removes the worktree', async () => {
    const d = deps();
    const [out] = await reviewRunCommand([RUN], {}, d);
    const headSha = g(upstream, 'rev-parse', 'feat/x');
    expect(out.ok).toBe(true);
    expect(out.branch).toBe('review/42/3f2a9c1e');
    expect(out.headSha).toBe(headSha);
    expect(out.worktree).toBe(path.join(fs.realpathSync(tmp), 'app-worktrees', 'review-42-3f2a9c1e'));
    // The start named the branch and the head.
    expect(d.calls.start).toEqual([{ id: RUN, hostname: 'box', branch: 'review/42/3f2a9c1e', headSha }]);
    // The result carried the parsed findings.
    expect(d.calls.result).toEqual([{ id: RUN, status: 'done', headSha, verdict: 'request_changes', summary: 'a.txt grew', findings: [{ path: 'a.txt', line: 2, severity: 'medium', title: 'two', detail: 'd', failureScenario: null, confidence: 'confirmed' }] }]);
    // The worktree and its branch are gone; the checkout itself is untouched.
    expect(fs.existsSync(out.worktree!)).toBe(false);
    expect(g(checkout, 'branch', '--list', 'review/42/*')).toBe('');
    expect(g(checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fs.readFileSync(path.join(checkout, 'a.txt'), 'utf-8')).toBe('one\n');
  });

  it("the team's API key reaches the agent's environment for the run — and only the key names, never PATH", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const base = deps();
    const d = deps({
      api: {
        ...base.api,
        getReviewRunCredentials: async () => ({ source: 'team', env: { ANTHROPIC_API_KEY: 'sk-ant-team', PATH: '/evil', NODE_OPTIONS: '--require /evil.js' } }),
      },
      run: (exe, args, cwd, env, capture) => { seen.push(env); return base.run(exe, args, cwd, env, capture); },
    });
    const [out] = await reviewRunCommand([RUN], {}, d);
    expect(out.ok).toBe(true);
    expect(seen[0].ANTHROPIC_API_KEY).toBe('sk-ant-team');
    expect(seen[0].PATH).toBe(process.env.PATH);
    expect(seen[0].NODE_OPTIONS).toBe(process.env.NODE_OPTIONS);
    // The machine's environment itself is untouched: the key is for that run only.
    expect(process.env.ANTHROPIC_API_KEY).not.toBe('sk-ant-team');
  });

  it('no team key, an older server, or a failed ask: the agent runs on the machine\'s own sign-in', async () => {
    for (const getReviewRunCredentials of [async () => ({ source: 'machine', env: {} }), async () => { throw new Error('404 Not Found'); }, undefined]) {
      const seen: NodeJS.ProcessEnv[] = [];
      const base = deps();
      const d = deps({
        api: { ...base.api, ...(getReviewRunCredentials ? { getReviewRunCredentials } : {}) },
        run: (exe, args, cwd, env, capture) => { seen.push(env); return base.run(exe, args, cwd, env, capture); },
      });
      const [out] = await reviewRunCommand([RUN], {}, d);
      expect(out.ok).toBe(true);
      expect(seen[0].ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
    }
  });

  it("reviewerKey 'machine': the team's key is never asked for, and the agent runs on the machine's own sign-in", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    let asked = 0;
    const base = deps();
    const d = deps({
      reviewerKey: 'machine',
      api: { ...base.api, getReviewRunCredentials: async () => { asked++; return { source: 'team', env: { ANTHROPIC_API_KEY: 'sk-ant-team' } }; } },
      run: (exe, args, cwd, env, capture) => { seen.push(env); return base.run(exe, args, cwd, env, capture); },
    });
    const [out] = await reviewRunCommand([RUN], {}, d);
    expect(out.ok).toBe(true);
    expect(asked).toBe(0);
    expect(seen[0].ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
  });

  it('an agent that is not signed in fails the run with how to sign it in', async () => {
    const base = deps();
    const d = deps({
      reviewerKey: 'machine',
      run: async () => ({ code: 1, stdout: '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}' }),
      agentArgvFor: () => ['node'],
    });
    const [out] = await reviewRunCommand([RUN], {}, d);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('node auth login');
    expect(base.calls.result).toEqual([]);
    expect(d.calls.result[0]).toMatchObject({ status: 'error' });
  });

  it('--keep-worktree leaves the worktree at the PR head, where the agent ran', async () => {
    const d = deps();
    const [out] = await reviewRunCommand([RUN], { keepWorktree: true }, d);
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(path.join(out.worktree!, 'a.txt'), 'utf-8')).toBe('one\ntwo\n');
    const ran = fs.readFileSync(path.join(out.worktree!, 'ran-here.txt'), 'utf-8');
    expect(fs.realpathSync(ran.split('\n')[0])).toBe(fs.realpathSync(out.worktree!));
    expect(ran).toContain('Review this.');
    expect(g(checkout, 'rev-parse', 'review/42/3f2a9c1e')).toBe(g(upstream, 'rev-parse', 'feat/x'));
    // A second run reuses it (reset to the head), rather than failing on the folder.
    const d2 = deps();
    const [again] = await reviewRunCommand([RUN], { keepWorktree: true }, d2);
    expect(again.ok).toBe(true);
    expect(again.worktree).toBe(out.worktree);
  });

  it('a missing agent binary is the run\'s error, posted, and the next run still goes', async () => {
    const d = deps({ agentArgvFor: () => ['definitely-not-a-real-binary-xyz', 'x'] });
    const outs = await reviewRunCommand([RUN, 'second-run'], {}, d);
    expect(outs.map((o) => o.ok)).toEqual([false, false]);
    expect(outs[0].error).toMatch(/not installed/);
    expect(d.calls.result).toHaveLength(2);
    expect(d.calls.result[0]).toMatchObject({ id: RUN, status: 'error' });
    expect(d.calls.result[0].error).toMatch(/not installed/);
    expect(fs.existsSync(outs[0].worktree!)).toBe(false);
  });

  it('an agent that exits without an answer is the run\'s error', async () => {
    const d = deps({ agentArgvFor: () => ['node', '-e', 'process.exit(3)'], run: (exe, args, cwd, env) => new Promise((resolve) => {
      try { execFileSync(exe, args, { cwd, env, stdio: 'ignore' }); resolve({ code: 0, stdout: '' }); } catch (e: any) { resolve({ code: e.status ?? 1, stdout: '' }); }
    }) });
    const [out] = await reviewRunCommand([RUN], {}, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/exited with code 3/);
    expect(d.calls.result[0]).toMatchObject({ status: 'error' });
  });

  it('remoteFor picks the remote naming the repo, else origin; reviewWorktree drops a stale branch', () => {
    g(checkout, 'remote', 'add', 'fork', 'git@github.com:someone/app.git');
    g(checkout, 'remote', 'add', 'up', 'https://github.com/acme/app.git');
    expect(remoteFor(checkout, 'acme/app')).toBe('up');
    expect(remoteFor(checkout, 'nobody/else')).toBe('origin');
    expect(remoteFor(checkout, null)).toBe('origin');
    // A branch left behind without a worktree does not block a fresh worktree.
    g(checkout, 'branch', 'review/1/stale');
    const w = reviewWorktree(checkout, 'review/1/stale', path.join(tmp, 'app-worktrees', 'review-1-stale'), g(checkout, 'rev-parse', 'HEAD'));
    expect(w.reused).toBe(false);
    expect(g(checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fs.existsSync(w.path)).toBe(true);
  });
});
