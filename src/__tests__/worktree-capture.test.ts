// Worktree-session capture: a Claude Code session whose cwd is a managed
// linked worktree (<repo>/.claude/worktrees/<name>) must capture against the
// WORKTREE (its HEAD, its index, worktree-relative paths) while attributing
// to the CANONICAL repo for identity/naming.
//
// Root cause this pins (production session 5606d120): getGitRoot collapses a
// linked worktree to the main repo, and that collapsed path was used as the
// session's repoPath for EVERY git operation — so per-prompt diffs recorded
// the worktree's files as untracked `.claude/worktrees/<id>/…` dirt, the
// session-level capture saw a HEAD that never moved (no SessionDiff row),
// staged-file commit attribution compared worktree-relative staged paths
// against prefixed session paths (no commit ever FK-linked, no
// Origin-Session trailer), and `.git`-file joins broke (a linked worktree's
// `.git` is a file).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getGitRoot,
  getWorkingGitRoot,
  getCanonicalRepoPath,
  gitDirFilePath,
  gitCommonDirFilePath,
  saveSessionState,
  listActiveSessions,
  isSessionAlive,
  type SessionState,
} from '../session-state.js';
import { listSessionsForGitHook } from '../commands/hooks.js';
import { writeSessionFiles } from '../local-entrypoint.js';
import { readSessionFile } from '../session-store.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('worktree-aware git roots', () => {
  let repo: string;
  let wt: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wt-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'seed');
    wt = path.join(repo, '.claude', 'worktrees', 'test-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature-x', wt);
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('getWorkingGitRoot returns the worktree top; getGitRoot collapses to the main repo', () => {
    expect(getWorkingGitRoot(wt)).toBe(wt);
    expect(getGitRoot(wt)).toBe(repo);
    // Non-worktree: both agree.
    expect(getWorkingGitRoot(repo)).toBe(repo);
    expect(getGitRoot(repo)).toBe(repo);
  });

  it('getCanonicalRepoPath collapses a worktree top and is identity elsewhere', () => {
    expect(getCanonicalRepoPath(wt)).toBe(repo);
    expect(getCanonicalRepoPath(repo)).toBe(repo);
  });

  it('gitDirFilePath resolves the per-worktree git dir (a worktree .git is a FILE)', () => {
    const inWt = gitDirFilePath(wt, 'COMMIT_EDITMSG');
    expect(inWt).toBe(path.join(repo, '.git', 'worktrees', 'test-wt', 'COMMIT_EDITMSG'));
    // Writing through it must not throw ENOTDIR (the naive join would).
    fs.writeFileSync(inWt, 'msg');
    expect(fs.existsSync(inWt)).toBe(true);
    const inMain = gitDirFilePath(repo, 'COMMIT_EDITMSG');
    expect(inMain).toBe(path.join(repo, '.git', 'COMMIT_EDITMSG'));
  });

  it('gitCommonDirFilePath resolves the shared (main) git dir from either checkout', () => {
    expect(gitCommonDirFilePath(wt, 'origin-session-x.json')).toBe(path.join(repo, '.git', 'origin-session-x.json'));
    expect(gitCommonDirFilePath(repo, 'origin-session-x.json')).toBe(path.join(repo, '.git', 'origin-session-x.json'));
  });

  it('session state saved with a worktree repoPath lands in the COMMON git dir and is found from BOTH checkouts', () => {
    const state: SessionState = {
      sessionId: 'sess-wt-1',
      claudeSessionId: 'claude-wt-1',
      transcriptPath: '',
      model: 'claude-fable-5',
      startedAt: new Date().toISOString(),
      prompts: [],
      repoPath: wt,
      canonicalRepoPath: repo,
      headShaAtStart: git(wt, 'rev-parse', 'HEAD'),
      headShaAtLastStop: null,
      prePromptSha: null,
      branch: 'feature-x',
      sessionTag: 'wt1tag',
    } as any;
    saveSessionState(state, wt, 'wt1tag');
    // COMMON dir, not the per-worktree dir: repo-scoped lookups (zombie
    // sweeps, `origin sessions`, pre-commit policy/violation session
    // resolution) resolve from the main checkout and must see worktree
    // sessions. Cross-worktree ATTRIBUTION safety comes from lastCwd
    // narrowing, not from hiding the files.
    expect(fs.existsSync(path.join(repo, '.git', 'origin-session-wt1tag.json'))).toBe(true);
    // A git hook running in the worktree finds it…
    const foundFromWt = listActiveSessions(wt);
    expect(foundFromWt.map((s) => s.sessionId)).toContain('sess-wt-1');
    // …and so does a repo-scoped lookup from the main checkout.
    expect(listActiveSessions(repo).map((s) => s.sessionId)).toContain('sess-wt-1');
    // isSessionAlive's git-state freshness check resolves the same file
    // even though state.repoPath is the worktree (whose .git is a FILE).
    expect(isSessionAlive(foundFromWt.find((s) => s.sessionId === 'sess-wt-1')!)).toBe(true);
  });

  it('writeSessionFiles works with a worktree repoPath (temp index must not live under the .git FILE)', () => {
    writeSessionFiles(wt, {
      sessionId: 'sess-wt-1',
      model: 'claude-fable-5',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1000,
      status: 'running',
      costUsd: 0,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      linesAdded: 1,
      linesRemoved: 0,
      prompts: [{ index: 1, text: 'make a change', filesChanged: [] }],
      filesChanged: [],
      git: { branch: 'feature-x', headBefore: '', headAfter: '', commitShas: [] },
      summary: '',
      originUrl: '',
      changes: [],
    });
    // The session's metadata must be readable back — before the fix the
    // temp-index path hit ENOTDIR ("Not a directory") and the whole write was
    // silently swallowed by the outer catch. Read through the store rather than
    // a raw branch path: what matters here is that the write landed at all,
    // whichever backend is active.
    const meta = readSessionFile(wt, 'sess-wt-1', 'metadata.json');
    expect(meta, 'session write was swallowed').toBeTruthy();
    expect(JSON.parse(meta!).sessionId).toBe('sess-wt-1');
  });

  it('a session registered under the MAIN repo is still reachable from a worktree hook (mid-session EnterWorktree)', () => {
    const state: SessionState = {
      sessionId: 'sess-main-1',
      claudeSessionId: 'claude-main-1',
      transcriptPath: '',
      model: 'claude-fable-5',
      startedAt: new Date().toISOString(),
      prompts: [],
      repoPath: repo,
      headShaAtStart: git(repo, 'rev-parse', 'HEAD'),
      headShaAtLastStop: null,
      prePromptSha: null,
      branch: 'main',
      sessionTag: 'main1tag',
    } as any;
    saveSessionState(state, repo, 'main1tag');
    // With common-dir state placement the worktree hook finds it directly
    // (and the legacy main-repo fallback in listSessionsForGitHook still
    // covers state files written by older CLIs).
    const found = listSessionsForGitHook(wt);
    expect(found.map((s) => s.sessionId)).toContain('sess-main-1');
  });
});
