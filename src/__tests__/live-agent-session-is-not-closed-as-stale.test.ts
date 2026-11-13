// OR-23 v1 (3265d18a3, 2026-10-26, on the RhodeCode developer's machine) went
// out stamped with the Origin session of RCCE-434, an older task in another
// repository. Two rules together:
//
//   1. prepare-commit-msg's session lookup marked every session whose files had
//      not been touched for 3 hours ENDED, for good — sessions whose agent was
//      still open, only idle. That turned them into "ended" sessions.
//   2. The ended-session fallback (ended-session-commit-owner.ts) then gave the
//      commit to whichever ended session's recorded lines the patch held, on
//      8 matching lines of a 116-line commit, from any file.
//
// This file covers (1): a session whose recorded agent process is still running
// is idle, not dead, and a commit hook must not close it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listSessionsForGitHook } from '../commands/hooks.js';
import { bootId, ownerProcessRunning, platformStat } from '../process-owner.js';

const HOURS = 60 * 60 * 1000;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const stat = platformStat();

describe.skipIf(!stat)('a commit hook and an idle session whose agent is still running', () => {
  let dir: string;

  function writeIdleSession(tag: string, ownerProcess: Record<string, unknown> | undefined) {
    const f = path.join(dir, '.git', `origin-session-${tag}.json`);
    fs.writeFileSync(f, JSON.stringify({
      sessionId: `${tag}-0000-4000-8000-000000000000`, sessionTag: tag, status: 'RUNNING',
      agentSlug: 'codex', model: 'gpt-5', repoPath: dir, lastCwd: dir,
      startedAt: new Date(Date.now() - 6 * HOURS).toISOString(), prompts: ['p'],
      ownerProcess,
    }));
    const t = (Date.now() - 4 * HOURS) / 1000;
    fs.utimesSync(f, t, t);
    return f;
  }
  const statusOf = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8')).status;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-live-agent-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@o.dev');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'seed');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('keeps the session open, and out of this commit\'s candidates', () => {
    const me = stat!(process.pid)!;
    const f = writeIdleSession('aaaaaaaa', { pid: process.pid, start: me.start, boot: bootId(), host: os.hostname() });
    const sessions = listSessionsForGitHook(dir, { commitFiles: [] });
    expect(sessions.map((s) => s.sessionTag)).not.toContain('aaaaaaaa');
    expect(statusOf(f)).toBe('RUNNING');
  });

  it('still closes a stale session whose agent process is gone', () => {
    const me = stat!(process.pid)!;
    // Same pid, another start time: a recycled pid, not this agent.
    const f = writeIdleSession('bbbbbbbb', { pid: process.pid, start: `${me.start} x`, host: os.hostname() });
    listSessionsForGitHook(dir, { commitFiles: [] });
    expect(statusOf(f)).toBe('ENDED');
  });

  it('still closes a stale session that recorded no agent process', () => {
    const f = writeIdleSession('cccccccc', undefined);
    listSessionsForGitHook(dir, { commitFiles: [] });
    expect(statusOf(f)).toBe('ENDED');
  });
});

describe.skipIf(!stat)('ownerProcessRunning', () => {
  it('is true only for the same pid AND start time', () => {
    const me = stat!(process.pid)!;
    expect(ownerProcessRunning({ pid: process.pid, start: me.start, boot: bootId() })).toBe(true);
    expect(ownerProcessRunning({ pid: process.pid, start: 'Thu Jan 1 00:00:00 1970', boot: bootId() })).toBe(false);
    expect(ownerProcessRunning({ pid: process.pid, start: me.start, boot: bootId(), host: 'another-host' })).toBe(false);
    expect(ownerProcessRunning(null)).toBe(false);
  });
});
