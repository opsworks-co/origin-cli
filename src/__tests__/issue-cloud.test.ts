import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { githubRepoOf, issueCloudCommand, pickCodexEnv, taskIdFromExecOutput, taskStateFromList, type IssueCloudDeps } from '../commands/issue-cloud.js';
import { issueCloudUrl, parseIssueCloudUrl } from '../issue-prompt.js';

const listJson = (status: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  tasks: [{ id: 'task_e_abc123', status, summary: { files_changed: 2, lines_added: 30, lines_removed: 4 }, ...extra }], cursor: null,
});

describe('cloud link', () => {
  it('round-trips, with the env the web adds', () => {
    const url = `${issueCloudUrl('r1', 'ISS-12', 'codex', 'acme/web')}&env=${encodeURIComponent('env_abc')}`;
    expect(url).toBe('getorigin://issue/cloud?repo=r1&issue=ISS-12&runner=codex&name=acme%2Fweb&env=env_abc');
    expect(parseIssueCloudUrl(url)).toEqual({ repoId: 'r1', shortId: 'ISS-12', runner: 'codex', env: 'env_abc', repoName: 'acme/web' });
  });
  it('takes a link with no env: the CLI finds the repo\'s', () => {
    expect(parseIssueCloudUrl(issueCloudUrl('r1', 'ISS-12', 'codex', 'acme/web'))).toEqual({ repoId: 'r1', shortId: 'ISS-12', runner: 'codex', env: null, repoName: 'acme/web' });
  });
  it('refuses an unknown runner, or an env that is not a plain name', () => {
    expect(parseIssueCloudUrl('getorigin://issue/cloud?repo=r1&issue=ISS-12&runner=devin&env=e')).toBeNull();
    expect(parseIssueCloudUrl('getorigin://issue/cloud?repo=r1&issue=ISS-12&runner=codex&env=%24(rm%20-rf)')).toBeNull();
    expect(parseIssueCloudUrl('getorigin://issue/start?repo=r1&issue=ISS-12&agent=codex')).toBeNull();
  });
});

describe('reading codex output', () => {
  it('takes the task id from the URL exec prints', () => {
    expect(taskIdFromExecOutput('https://chatgpt.com/codex/tasks/task_e_abc123\n')).toEqual({ id: 'task_e_abc123', url: 'https://chatgpt.com/codex/tasks/task_e_abc123' });
    expect(taskIdFromExecOutput('error: no environment')).toBeNull();
  });
  it('maps list statuses; a task not on the page is unknown', () => {
    expect(taskStateFromList(listJson('pending'), 'task_e_abc123')).toEqual({ state: 'pending', detail: '' });
    expect(taskStateFromList(listJson('ready'), 'task_e_abc123')).toEqual({ state: 'done', detail: 'Codex finished: 2 files, +30 -4' });
    expect(taskStateFromList(listJson('applied'), 'task_e_abc123')?.state).toBe('done');
    expect(taskStateFromList(listJson('error'), 'task_e_abc123')?.state).toBe('failed');
    expect(taskStateFromList(listJson('ready'), 'task_other')).toBeNull();
    expect(taskStateFromList('not json', 'x')).toBeNull();
  });
});

describe('finding the environment', () => {
  it('reads owner/repo from a GitHub remote only', () => {
    expect(githubRepoOf('https://github.com/opsworks-co/origin.git')).toBe('opsworks-co/origin');
    expect(githubRepoOf('git@github.com:acme/web')).toBe('acme/web');
    expect(githubRepoOf('https://gitlab.com/acme/web.git')).toBeNull();
  });
  it('picks the pinned environment, else the most used; none for an empty list', () => {
    expect(pickCodexEnv([{ id: 'e1', label: 'a', task_count: 9 }, { id: 'e2', label: 'b', is_pinned: true }])).toEqual({ env: 'e2', label: 'b' });
    expect(pickCodexEnv({ items: [{ id: 'e1', task_count: 1 }, { id: 'e2', label: 'b', task_count: 5 }] })).toEqual({ env: 'e2', label: 'b' });
    expect(pickCodexEnv([])).toBeNull();
    expect(pickCodexEnv({ detail: 'bad request' })).toBeNull();
  });
});

describe('issueCloudCommand', () => {
  let bin: string;
  let calls: string[][];
  let runs: any[];
  let notes: string[];
  let ends: any[];
  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cloud-bin-'));
    const codex = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    calls = []; runs = []; notes = []; ends = [];
    process.exitCode = undefined;
  });
  afterEach(() => { process.exitCode = undefined; });

  const deps = (answers: Array<{ code: number; stdout: string; stderr?: string }>, over: Partial<IssueCloudDeps> = {}): IssueCloudDeps => {
    let t = 0;
    return {
      cwd: os.tmpdir(), env: { PATH: bin }, platform: process.platform,
      log: () => {}, error: () => {}, connected: () => true,
      api: {
        previewRoute: async () => ({ repo: { id: 'r1' } }),
        getIssue: async () => ({ shortId: 'ISS-12', title: 'Retry webhooks', description: 'Retry failed deliveries', type: 'task', status: 'open' }),
        updateIssue: async () => ({}),
        startIssueRun: async (_r, _s, data) => { runs.push(data); return { id: 'run-1' }; },
        endIssueRun: async (_r, _s, _id, data) => { ends.push(data); },
        noteIssueRun: async (_r, _s, _id, detail) => { notes.push(detail); },
      },
      memoryLines: () => [], openTodos: () => [],
      exec: async (_bin, args) => { calls.push(args); return { stderr: '', ...(answers.shift() ?? { code: 1, stdout: '' }) }; },
      sleep: async () => { t += 60_000; },
      now: () => Date.parse('2026-10-20T12:00:00Z') + t,
      defaultBranch: () => 'main',
      findEnv: async () => ({ env: 'env_found', label: 'acme web' }),
      ...over,
    };
  };

  it('submits the task from the default branch with a prompt naming no branch, reports it, and follows it to done', async () => {
    const r = await issueCloudCommand('ISS-12', { env: 'env_abc' }, deps([
      { code: 0, stdout: 'https://chatgpt.com/codex/tasks/task_e_abc123\n' },
      { code: 0, stdout: listJson('pending') },
      { code: 0, stdout: listJson('ready') },
    ]));
    expect(r).toEqual({ taskId: 'task_e_abc123', url: 'https://chatgpt.com/codex/tasks/task_e_abc123', state: 'done' });
    expect(calls[0].slice(0, 5)).toEqual(['cloud', 'exec', '--env', 'env_abc', '--branch']);
    expect(calls[0][5]).toBe('main');
    expect(calls[0][6]).toContain('Retry webhooks');
    expect(calls[0][6]).not.toContain('on the branch');
    expect(calls[1]).toEqual(['cloud', 'list', '--json', '--env', 'env_abc', '--limit', '20']);
    expect(runs).toEqual([expect.objectContaining({ agent: 'codex-cloud', branch: null, background: true })]);
    expect(notes).toEqual(['task task_e_abc123 https://chatgpt.com/codex/tasks/task_e_abc123']);
    expect(ends).toEqual([{ status: 'done', exitCode: 0, detail: 'Codex finished: 2 files, +30 -4 — https://chatgpt.com/codex/tasks/task_e_abc123' }]);
  });

  it('a task off the list page is asked about by id; an error there fails the run', async () => {
    const r = await issueCloudCommand('ISS-12', { env: 'env_abc' }, deps([
      { code: 0, stdout: 'https://chatgpt.com/codex/tasks/task_e_abc123' },
      { code: 0, stdout: JSON.stringify({ tasks: [], cursor: 'x' }) },
      { code: 1, stdout: '[ERROR] Retry webhooks' },
    ]));
    expect(calls[2]).toEqual(['cloud', 'status', 'task_e_abc123']);
    expect(r.state).toBe('failed');
    expect(ends[0]).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('a refused submission fails the run with codex\'s reason', async () => {
    const r = await issueCloudCommand('ISS-12', { env: 'env_abc' }, deps([{ code: 1, stdout: '', stderr: 'Error: environment env_abc not found' }]));
    expect(r.state).toBe('not_started');
    expect(ends).toEqual([{ status: 'failed', exitCode: 1, detail: 'codex cloud exec: Error: environment env_abc not found' }]);
    expect(process.exitCode).toBe(1);
  });

  it('stops following after the timeout and says the task may still finish', async () => {
    const pending = Array.from({ length: 200 }, () => ({ code: 0, stdout: listJson('pending') }));
    const r = await issueCloudCommand('ISS-12', { env: 'env_abc', timeout: 1 }, deps([{ code: 0, stdout: 'https://chatgpt.com/codex/tasks/task_e_abc123' }, ...pending]));
    expect(r.state).toBe('timed_out');
    expect(ends[0]).toMatchObject({ status: 'timed_out', exitCode: 124 });
  });

  it('with no env, runs in the one Codex has for the repo', async () => {
    await issueCloudCommand('ISS-12', {}, deps([{ code: 0, stdout: 'https://chatgpt.com/codex/tasks/task_e_abc123' }, { code: 0, stdout: listJson('ready') }]));
    expect(calls[0].slice(0, 4)).toEqual(['cloud', 'exec', '--env', 'env_found']);
  });

  it('with no env and none for the repo, fails the run on the issue with why', async () => {
    const r = await issueCloudCommand('ISS-12', {}, deps([], { findEnv: async () => ({ env: null, why: 'Codex cloud has no environment for acme/web.' }) }));
    expect(r.state).toBe('not_started');
    expect(calls).toEqual([]);
    expect(ends).toEqual([{ status: 'failed', exitCode: 1, detail: 'Codex cloud has no environment for acme/web.' }]);
  });

  it('refuses a malformed env, and a machine without codex', async () => {
    await issueCloudCommand('ISS-12', { env: '$(rm -rf)' }, deps([]));
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    const r = await issueCloudCommand('ISS-12', { env: 'env_abc' }, deps([], { env: { PATH: '' } }));
    expect(r.state).toBe('not_started');
    expect(calls).toEqual([]);
  });
});
