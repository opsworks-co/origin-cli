/**
 * prepare-commit-msg finds the agent running `git commit` by its process tree
 * (process-owner.ts) even when that agent's session is homed in a SIBLING
 * worktree of the one being committed in.
 *
 * The tree narrowing in listSessionsForGitHook drops a session homed in another
 * worktree before the ancestry check runs, so `cd ../other-wt && git commit`
 * from an agent left the commit with no trailer. When the narrowed pool has no
 * owner, the check now runs over every live session of the git common dir —
 * and only a single owner may be picked from there.
 *
 * Real git, real linked worktrees, state in the common git dir. The ancestry
 * walk is stubbed: a session "is an ancestor" when its owner pid is listed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ancestors = vi.hoisted(() => ({ pids: new Set<number>() }));
vi.mock('../process-owner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../process-owner.js')>();
  return {
    ...actual,
    pickSessionsByCommitAncestry: (sessions: Array<{ ownerProcess?: { pid: number } | null }>) => {
      const at = sessions.filter((s) => s.ownerProcess && ancestors.pids.has(s.ownerProcess.pid));
      if (at.length === 0) return { outcome: 'none' };
      return at.length === 1 ? { outcome: 'owner', session: at[0], depth: 2 } : { outcome: 'shared', sessions: at, depth: 2 };
    },
  };
});

import { pickActiveSessionForCommit, siblingTreeOwner } from '../commands/hooks/git-hooks.js';
import { lookupSessionsForGitHook } from '../commands/hooks/post-commit.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

let root: string;
let repo: string;
let home: string; // worktree A: where the agent's session lives
let committing: string; // worktree B: where it commits

const AGENT = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb';
const RESIDENT = 'c3c3c3c3-3333-4333-8333-cccccccccccc';

function writeSession(opts: { sessionId: string; repoPath: string; pid: number }): void {
  const tag = opts.sessionId.slice(0, 12);
  const state = {
    sessionId: opts.sessionId,
    claudeSessionId: `conv-${tag}`,
    transcriptPath: '',
    model: 'claude-opus-5-5',
    startedAt: new Date().toISOString(),
    prompts: ['ship the release'],
    activeTurn: { index: 0, turnId: `t_${tag}0000`, startedAt: new Date().toISOString() },
    repoPath: opts.repoPath,
    canonicalRepoPath: repo,
    lastCwd: opts.repoPath,
    headShaAtStart: null,
    headShaAtLastStop: null,
    prePromptSha: null,
    branch: null,
    sessionTag: tag,
    ownerProcess: { pid: opts.pid, start: `start-${opts.pid}`, name: 'claude' },
  };
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify(state), { mode: 0o600 });
}

function stage(file: string): void {
  fs.writeFileSync(path.join(committing, file), `change ${Date.now()}\n`);
  git(committing, 'add', file);
}

beforeEach(() => {
  ancestors.pids = new Set();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sibling-owner-')));
  repo = path.join(root, 'origin');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@origin.dev');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  const a = path.join(repo, '.claude', 'worktrees', 'home-a');
  const b = path.join(repo, '.claude', 'worktrees', 'release-b');
  git(repo, 'worktree', 'add', '-q', '-b', 'claude/home-a', a);
  git(repo, 'worktree', 'add', '-q', '-b', 'claude/release-b', b);
  home = fs.realpathSync(a);
  committing = fs.realpathSync(b);
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the agent running the commit is found in a sibling worktree', () => {
  it('lookupSessionsForGitHook exposes the live pool the tree narrowing dropped from', () => {
    writeSession({ sessionId: AGENT, repoPath: home, pid: 4101 });
    const lookup = lookupSessionsForGitHook(committing, { commitFiles: ['x.ts'] });
    expect(lookup.sessions).toEqual([]);
    expect(lookup.live.map((s) => s.sessionId)).toEqual([AGENT]);
  });

  it('picks the session homed in worktree A when its agent commits in worktree B', () => {
    writeSession({ sessionId: AGENT, repoPath: home, pid: 4101 });
    stage('release.ts');
    ancestors.pids.add(4101);
    expect(pickActiveSessionForCommit(committing)?.sessionId).toBe(AGENT);
  });

  it('a commit no agent runs stays unattributed', () => {
    writeSession({ sessionId: AGENT, repoPath: home, pid: 4101 });
    stage('release.ts');
    expect(pickActiveSessionForCommit(committing)).toBeNull();
  });

  it('the sibling owner beats a resident of B whose agent is not running the commit', () => {
    writeSession({ sessionId: AGENT, repoPath: home, pid: 4101 });
    writeSession({ sessionId: RESIDENT, repoPath: committing, pid: 4103 });
    stage('release.ts');
    ancestors.pids.add(4101);
    expect(pickActiveSessionForCommit(committing)?.sessionId).toBe(AGENT);
  });

  it('a shared owner among sibling sessions picks nothing and narrows nothing', () => {
    writeSession({ sessionId: AGENT, repoPath: home, pid: 4101 });
    writeSession({ sessionId: OTHER, repoPath: home, pid: 4101 });
    stage('release.ts');
    ancestors.pids.add(4101);
    expect(pickActiveSessionForCommit(committing)).toBeNull();
  });

  it('a shared owner beside B\'s resident leaves the resident decided by the old rules', () => {
    writeSession({ sessionId: AGENT, repoPath: home, pid: 4101 });
    writeSession({ sessionId: OTHER, repoPath: home, pid: 4101 });
    writeSession({ sessionId: RESIDENT, repoPath: committing, pid: 4103 });
    stage('release.ts');
    ancestors.pids.add(4101);
    // The resident's turn is open, so the lone-candidate rule credits it —
    // exactly what happened before; the sibling tie did not remove it.
    expect(pickActiveSessionForCommit(committing)?.sessionId).toBe(RESIDENT);
  });

  it('an owner in this tree\'s own pool still wins first', () => {
    writeSession({ sessionId: AGENT, repoPath: home, pid: 4101 });
    writeSession({ sessionId: RESIDENT, repoPath: committing, pid: 4103 });
    stage('release.ts');
    ancestors.pids.add(4101);
    ancestors.pids.add(4103);
    expect(pickActiveSessionForCommit(committing)?.sessionId).toBe(RESIDENT);
  });

  it('siblingTreeOwner refuses a session homed in another repository', () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    writeSession({ sessionId: AGENT, repoPath: other, pid: 4101 });
    const live = lookupSessionsForGitHook(committing).live;
    expect(live.map((s) => s.sessionId)).toEqual([AGENT]);
    const owner = () => ({ outcome: 'owner' as const, session: live[0], depth: 1 });
    expect(siblingTreeOwner(live, committing, owner)).toBeNull();
    // The same session homed in a sibling worktree is accepted.
    live[0].repoPath = home;
    expect(siblingTreeOwner(live, committing, owner)?.sessionId).toBe(AGENT);
  });
});
