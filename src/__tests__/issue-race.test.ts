import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { issueRaceCommand } from '../commands/issue-race.js';
import { agentBackgroundArgv, issueRaceUrl, parseIssueRaceUrl, raceAgents, raceArmBranch, parseIssueLaunchUrl } from '../issue-prompt.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); process.exitCode = undefined; });

/** A PATH holding fake CLIs for these agents. */
function binsFor(agents: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-race-bin-'));
  dirs.push(dir);
  for (const a of agents) {
    const bin = agentBackgroundArgv(a as any, '', '')![0];
    fs.writeFileSync(path.join(dir, bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return dir;
}

const fakeStart = (calls: any[], fail: (agent: string) => boolean = () => false) => async (id: string, opts: any) => {
  calls.push({ id, ...opts });
  if (fail(opts.agent)) { process.exitCode = 1; return null; }
  return { branch: `issue/${id}-x-${opts.branchSuffix}`, worktree: `/w/${opts.agent}`, background: { pid: 1, log: 'l', record: 'r' } } as any;
};

describe('raceAgents / race links', () => {
  it('takes 2–4 different real agents, never print', () => {
    expect(raceAgents('claude,codex')).toEqual(['claude', 'codex']);
    expect(raceAgents(' Claude , codex ')).toEqual(['claude', 'codex']);
    expect(raceAgents('claude')).toBeNull();
    expect(raceAgents('claude,claude')).toBeNull();
    expect(raceAgents('claude,print')).toBeNull();
    expect(raceAgents('claude,codex,gemini,cursor,copilot')).toBeNull();
    expect(raceAgents('claude,rm -rf')).toBeNull();
  });

  it('a race link round-trips, and is not a start link (an older CLI refuses it instead of running one agent)', () => {
    const url = issueRaceUrl('repo_1', 'ISS-7', ['claude', 'codex'], 'acme/app', { force: true });
    expect(url).toBe('getorigin://issue/race?repo=repo_1&issue=ISS-7&agents=claude,codex&name=acme%2Fapp&force=1');
    expect(parseIssueRaceUrl(url)).toEqual({ repoId: 'repo_1', shortId: 'ISS-7', agents: ['claude', 'codex'], repoName: 'acme/app', force: true });
    expect(parseIssueLaunchUrl(url)).toBeNull();
    expect(parseIssueRaceUrl('getorigin://issue/race?repo=r&issue=ISS-7&agents=claude')).toBeNull();
    expect(parseIssueRaceUrl('getorigin://issue/race?repo=r;x&issue=ISS-7&agents=claude,codex')).toBeNull();
    expect(raceArmBranch('issue/ISS-7-retry', 'codex')).toBe('issue/ISS-7-retry-codex');
  });
});

describe('origin issue race', () => {
  it('starts each agent in the background on its own branch; the first checks who is on the issue, the rest force', async () => {
    const calls: any[] = [];
    const logs: string[] = [];
    const arms = await issueRaceCommand('ISS-7', { agents: 'claude,codex', timeout: '30' },
      { env: { PATH: binsFor(['claude', 'codex']) }, platform: 'darwin', log: (l) => logs.push(l), error: (l) => logs.push(l) }, fakeStart(calls));
    expect(calls.map((c) => [c.agent, c.branchSuffix, c.background, c.force, c.timeout])).toEqual([
      ['claude', 'claude', true, false, '30'],
      ['codex', 'codex', true, true, '30'],
    ]);
    expect(arms!.map((a) => [a.agent, a.started, a.branch])).toEqual([['claude', true, 'issue/ISS-7-x-claude'], ['codex', true, 'issue/ISS-7-x-codex']]);
    expect(logs.join('\n')).toContain('Racing claude, codex on ISS-7');
    expect(process.exitCode).toBe(0);
  });

  it('skips an agent whose CLI is not installed, and the next one does the busy check', async () => {
    const calls: any[] = [];
    const logs: string[] = [];
    const arms = await issueRaceCommand('ISS-7', { agents: 'gemini,claude,codex' },
      { env: { PATH: binsFor(['claude', 'codex']) }, platform: 'darwin', log: (l) => logs.push(l), error: (l) => logs.push(l) }, fakeStart(calls));
    expect(calls.map((c) => [c.agent, c.force])).toEqual([['claude', false], ['codex', true]]);
    expect(arms!.find((a) => a.agent === 'gemini')).toMatchObject({ started: false });
    expect(logs.join('\n')).toContain('Not started: gemini');
  });

  it('stops when the first arm is refused (someone is on it, or no such issue); --force races anyway', async () => {
    const calls: any[] = [];
    const env = { PATH: binsFor(['claude', 'codex']) };
    const quiet = { env, platform: 'darwin' as const, log: () => {}, error: () => {} };
    await issueRaceCommand('ISS-7', { agents: 'claude,codex' }, quiet, fakeStart(calls, (a) => a === 'claude'));
    expect(calls.map((c) => c.agent)).toEqual(['claude']);
    expect(process.exitCode).toBe(1);
    calls.length = 0;
    await issueRaceCommand('ISS-7', { agents: 'claude,codex', force: true }, quiet, fakeStart(calls));
    expect(calls.map((c) => c.force)).toEqual([true, true]);
  });

  it('refuses a bad --agents list', async () => {
    const errs: string[] = [];
    expect(await issueRaceCommand('ISS-7', { agents: 'claude' }, { log: () => {}, error: (l) => errs.push(l) }, fakeStart([]))).toBeNull();
    expect(process.exitCode).toBe(2);
    expect(errs.join()).toContain('2–4 different agents');
  });
});
