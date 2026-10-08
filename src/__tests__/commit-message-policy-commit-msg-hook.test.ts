import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), isConnectedMode: () => true }));

import { api } from '../api.js';
import { commitMessageForPolicy, commitMessageViolations, handleCommitMsg, handlePreCommit } from '../commands/hooks.js';

/**
 * COMMIT_MESSAGE policies were checked in pre-commit, from COMMIT_EDITMSG. git
 * runs pre-commit BEFORE it writes the new message, so that file still held the
 * PREVIOUS commit's message: a good commit after a bad one was blocked, and a
 * bad one after a good one went through. The check now lives in commit-msg,
 * which git hands the new message as $1.
 *
 * The repo below is real: its hooks copy what git shows each hook, and the
 * handlers are then run on exactly those files.
 */
const POLICY = [{
  id: 'pol-1', name: 'Conventional commits', type: 'COMMIT_MESSAGE',
  rules: [{ id: 'r-1', condition: JSON.stringify({ pattern: '^(feat|fix): ' }), action: 'BLOCK', severity: 'HIGH', agentId: null, machineId: null, repoId: null }],
}];

let repo: string;
let seen: string;
const origCwd = process.cwd();
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-commit-msg-')));
  seen = path.join(repo, '..', path.basename(repo) + '-seen');
  fs.mkdirSync(seen);
  git('init', '--quiet');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'core.hooksPath', '.git/hooks');
  const hooks = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  // What each hook can see when git runs it.
  fs.writeFileSync(path.join(hooks, 'pre-commit'),
    `#!/bin/sh\ncp "$(git rev-parse --git-dir)/COMMIT_EDITMSG" "${seen}/pre-commit" 2>/dev/null || : > "${seen}/pre-commit"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(hooks, 'commit-msg'), `#!/bin/sh\ncp "$1" "${seen}/commit-msg"\n`, { mode: 0o755 });

  vi.spyOn(api, 'getPolicies').mockResolvedValue(POLICY as any);
  vi.spyOn(api, 'reportViolation').mockResolvedValue(undefined as any);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(origCwd);
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(seen, { recursive: true, force: true });
});

function commit(message: string) {
  fs.appendFileSync(path.join(repo, 'a.txt'), `${message}\n`);
  git('add', 'a.txt');
  git('commit', '--quiet', '-m', message);
}

/** Stage a change and run git's hooks for `message` without making the commit. */
function hookViewsOf(message: string): { preCommit: string; commitMsg: string } {
  fs.appendFileSync(path.join(repo, 'a.txt'), 'next\n');
  git('add', 'a.txt');
  // The recording commit-msg hook exits 0, so drop the commit afterwards.
  git('commit', '--quiet', '-m', message);
  git('reset', '--quiet', '--soft', 'HEAD~1');
  return {
    preCommit: fs.readFileSync(path.join(seen, 'pre-commit'), 'utf-8'),
    commitMsg: path.join(seen, 'commit-msg'),
  };
}

describe('COMMIT_MESSAGE policy runs on the message being committed', () => {
  it('pre-commit sees only the previous message, so it no longer judges it', async () => {
    commit('WIP junk');
    const views = hookViewsOf('feat: a good message');
    // The bug's premise, from git itself.
    expect(views.preCommit.trim()).toBe('WIP junk');
    expect(fs.readFileSync(views.commitMsg, 'utf-8').trim()).toBe('feat: a good message');

    // A good commit after a bad one is no longer blocked at pre-commit. Put the
    // git dir back the way pre-commit found it (the dropped commit rewrote it).
    fs.writeFileSync(path.join(repo, '.git', 'COMMIT_EDITMSG'), views.preCommit);
    await expect(handlePreCommit()).resolves.toBeUndefined();
    expect(process.exit).not.toHaveBeenCalled();
    // And commit-msg passes it.
    await expect(handleCommitMsg(views.commitMsg)).resolves.toBeUndefined();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('commit-msg blocks a bad message even when the previous one was good', async () => {
    commit('feat: first');
    const views = hookViewsOf('WIP junk');
    expect(views.preCommit.trim()).toBe('feat: first');

    await expect(handleCommitMsg(views.commitMsg)).rejects.toThrow('exit 1');
    expect(api.reportViolation).toHaveBeenCalledWith(expect.objectContaining({
      policyId: 'pol-1', policyType: 'COMMIT_MESSAGE', description: expect.stringContaining('[commit-msg]'),
    }));
  });

  it('skips policies scoped to an agent that is not running here', async () => {
    commit('feat: first');
    const views = hookViewsOf('WIP junk');
    vi.mocked(api.getPolicies).mockResolvedValue([{ ...POLICY[0], assignedAgents: [{ id: 'a', name: 'Codex', slug: 'codex' }] }] as any);
    await expect(handleCommitMsg(views.commitMsg)).resolves.toBeUndefined();
  });
});

describe('commitMessageForPolicy', () => {
  it('drops comment lines and everything below the scissors', () => {
    const raw = 'feat: x\n\nbody\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff --git a/a b/a\n';
    expect(commitMessageForPolicy(raw)).toBe('feat: x\n\nbody');
  });

  it('honours core.commentChar', () => {
    expect(commitMessageForPolicy('fix: y\n; a comment\n# not a comment\n', ';')).toBe('fix: y\n# not a comment');
  });
});

describe('commitMessageViolations', () => {
  it('flags a missing required pattern and a matched blocked pattern', () => {
    const policies = [{ id: 'p', name: 'n', type: 'COMMIT_MESSAGE', rules: [
      { id: 'r', condition: JSON.stringify({ pattern: '^feat', blocked_pattern: 'wip', caseSensitive: false }), action: 'WARN', severity: 'LOW' },
    ] }];
    expect(commitMessageViolations(policies, 'feat: ok')).toHaveLength(0);
    expect(commitMessageViolations(policies, 'WIP stuff').map((v) => v.message)).toEqual([
      'Commit message does not match required format "^feat"',
      'Commit message matches blocked pattern "wip"',
    ]);
  });

  it('ignores other policy types', () => {
    const policies = [{ id: 'p', name: 'n', type: 'CONTENT_FILTER', rules: [
      { id: 'r', condition: JSON.stringify({ pattern: '^feat' }), action: 'BLOCK', severity: 'LOW' },
    ] }];
    expect(commitMessageViolations(policies, 'anything')).toHaveLength(0);
  });
});
