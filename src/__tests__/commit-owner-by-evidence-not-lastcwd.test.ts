// The session that ran `git commit` is the one whose open turn staged the
// files — not the one whose shell happened to sit at the worktree root.
//
// Session e1095412 (2026-09-08) committed twice from `packages/cli`. Both
// times the git hooks found two live Claude sessions on the worktree: it, and
// the earlier chat in the same worktree, idle and parked at the root. The
// candidate narrowing kept the exact-lastCwd match alone (`narrowed by
// lastCwd, matched: [29b32c38]`, `ofActive: 1`), prepare-commit-msg wrote the
// idle session's trailer, post-commit followed the trailer, and the committing
// session's two turns rendered "uncommitted" with no commit diff.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pickActiveSessionForCommit } from '../commands/hooks/git-hooks.js';
import { pickSessionForCommit } from '../commands/hooks/post-commit.js';

let repo = '';
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const writeState = (tag: string, state: Record<string, unknown>) =>
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify(state), { mode: 0o600 });

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-owner-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, 'packages', 'cli', 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'cli', 'src', 'a.ts'), 'a\n');
  git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

const idleAtRoot = () => writeState('idle', {
  sessionId: 'idle-at-root-0001', sessionTag: 'idle', agentSlug: 'claude-code',
  repoPath: repo, lastCwd: repo, status: 'RUNNING',
  startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  prompts: ['earlier task'], completedPromptMappings: [{ promptIndex: 0, filesChanged: ['README.md'] }],
});
const workingInSubdir = (withEvidence: boolean) => writeState('work', {
  sessionId: 'working-in-cli-0002', sessionTag: 'work', agentSlug: 'claude-code',
  repoPath: repo, lastCwd: path.join(repo, 'packages', 'cli'), status: 'RUNNING',
  startedAt: new Date(Date.now() - 600_000).toISOString(),
  prompts: ['fix it'],
  ...(withEvidence ? {
    activeTurn: { index: 0, turnId: 't0', promptText: 'fix it', openedAt: new Date().toISOString() },
    liveEdits: [{ promptIndex: 0, edits: [{ file: 'packages/cli/src/a.ts' }] }],
  } : {}),
});

describe('prepare-commit-msg picks the session whose open turn staged the commit', () => {
  it('a session that cd-ed into a subdirectory keeps its own commit', () => {
    idleAtRoot();
    workingInSubdir(true);
    fs.writeFileSync(path.join(repo, 'packages', 'cli', 'src', 'a.ts'), 'a\nb\n');
    git('add', '-A');
    expect(pickActiveSessionForCommit(repo)?.sessionId).toBe('working-in-cli-0002');
  });

  it('with no file evidence either way, the session at the hook cwd is the tie-break', () => {
    idleAtRoot();
    workingInSubdir(false);
    fs.writeFileSync(path.join(repo, 'unrelated.md'), 'x\n');
    git('add', '-A');
    expect(pickActiveSessionForCommit(repo)?.sessionId).toBe('idle-at-root-0001');
  });
});

describe('post-commit: lastCwd is a tie-break after the file evidence', () => {
  const mk = (id: string, lastCwd: string, files: string[]) => ({
    sessionId: id, agentSlug: 'claude-code', startedAt: new Date().toISOString(), lastCwd,
    completedPromptMappings: [{ promptIndex: 0, filesChanged: files }],
  });
  it('file overlap wins over the exact cwd', () => {
    const root = mk('root', '/repo', ['README.md']);
    const sub = mk('sub', '/repo/packages/cli', ['packages/cli/src/a.ts']);
    const r = pickSessionForCommit([root, sub] as any[], { commitFiles: ['packages/cli/src/a.ts'], hookCwd: '/repo' });
    expect([r.session?.sessionId, r.reason]).toEqual(['sub', 'file-overlap']);
  });
  it('with no overlap, the exact cwd decides', () => {
    const root = mk('root', '/repo', ['README.md']);
    const sub = mk('sub', '/repo/packages/cli', ['other.ts']);
    const r = pickSessionForCommit([root, sub] as any[], { commitFiles: ['new.md'], hookCwd: '/repo' });
    expect([r.session?.sessionId, r.reason]).toEqual(['root', 'cwd']);
  });
  it('two sessions at the cwd is still ambiguous', () => {
    const a = mk('a', '/repo', []); const b = mk('b', '/repo', []);
    expect(pickSessionForCommit([a, b] as any[], { commitFiles: ['new.md'], hookCwd: '/repo' }).reason).toBe('ambiguous');
  });
});
