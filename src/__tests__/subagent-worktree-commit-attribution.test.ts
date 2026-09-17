/**
 * A commit belongs to the session that WROTE the committed files in that tree —
 * sub-agents included — whatever that session's single `lastCwd` says at the
 * instant git runs the hook.
 *
 * Session fd13f970 (2026-09-17), parent in `frosty-bassi-502ffb`, three
 * sub-agents in `agent-*` worktrees, every sub-agent hook carrying the parent's
 * session_id. From ~/.origin/hooks.log:
 *
 *   15:19:38.946 [git-hook-sessions] narrowed by lastCwd {hookCwd: …/agent-a47deb…, matched: [fd13f970]}
 *   15:19:39.063 [post-tool-use] lastCwd updated {from: …/agent-a47deb…, to: …/agent-abcef6…}
 *   15:19:40.156 [prepare-commit-msg] skip — no unambiguous active session
 *   15:19:42.052 [post-commit] multiple agent processes running — not guessing
 *
 * pre-commit saw the right lastCwd; a sibling sub-agent moved it 117ms later;
 * prepare-commit-msg re-listed and found no session in the tree. Ten minutes
 * later the same shape in `agent-abcef6…` got the trailer because lastCwd
 * happened to point there.
 *
 * The other half of these tests is the opposite failure: PRESENCE must not
 * attribute. A session that only read in a tree, or wrote something unrelated
 * there, must not be handed a commit it had nothing to do with.
 *
 * Real git, real linked worktrees nested under the main checkout, state files
 * in the common git dir — the layout that makes path containment useless.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handlePrepareCommitMsg, listSessionsForGitHook, pickActiveSessionForCommit } from '../commands/hooks.js';
import {
  MAX_WRITE_TREES, WRITE_TREE_MAX_AGE_MS, commitOverlapsWritesInTree, filesWrittenInTree,
  keepWriteTreesSavedMeanwhile, recordWriteTree, sessionWroteInTree, workTreeRootOf,
} from '../session-write-trees.js';
import type { WriteTree } from '../session-write-trees.js';
import { saveSessionState } from '../session-state.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

let root: string;
let repo: string;
const wt: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' };
const origCwd = process.cwd();

const PARENT = 'fd13f970-32ea-4462-b222-1807ef21d44a';
const OTHER = 'cccccccc-3333-4333-8333-cccccccccccc';
const wrote = (tree: string, files: string[], agoMs = 0): WriteTree => ({
  path: fs.realpathSync.native(tree), at: new Date(Date.now() - agoMs).toISOString(), files,
});

function writeSession(opts: {
  sessionId: string; repoPath: string; lastCwd: string;
  writeTrees?: WriteTree[]; mappingFiles?: string[]; openTurn?: boolean;
}): void {
  const tag = opts.sessionId.slice(0, 12);
  const state = {
    sessionId: opts.sessionId,
    claudeSessionId: `conv-${tag}`,
    transcriptPath: '',
    model: 'claude-opus-4-8',
    startedAt: new Date().toISOString(),
    prompts: ['fan out'],
    // A sub-agent run happens inside the parent's open turn.
    ...(opts.openTurn === false ? {} : { activeTurn: { index: 0, turnId: 't_open', startedAt: new Date().toISOString() } }),
    ...(opts.mappingFiles ? { completedPromptMappings: [{ promptIndex: 0, filesChanged: opts.mappingFiles }] } : {}),
    repoPath: opts.repoPath,
    lastCwd: opts.lastCwd,
    ...(opts.writeTrees ? { writeTrees: opts.writeTrees } : {}),
    headShaAtStart: null,
    headShaAtLastStop: null,
    prePromptSha: null,
    branch: null,
    sessionTag: tag,
  };
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify(state), { mode: 0o600 });
}

function stage(tree: string, file: string): string {
  fs.writeFileSync(path.join(tree, file), 'change\n');
  git(tree, 'add', file);
  const msg = path.join(tree, 'COMMIT_EDITMSG.test');
  fs.writeFileSync(msg, 'commit from a sub-agent\n');
  return msg;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-subagent-wt-')));
  repo = path.join(root, 'origin');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@origin.dev');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\nCOMMIT_EDITMSG.test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'seed');
  for (const [name, dir] of [['A', 'frosty-bassi-502ffb'], ['B', 'agent-a47deb96f25a1df68'], ['C', 'xenodochial-swirles-1444e9'], ['D', 'nobody-worked-here']] as const) {
    const p = path.join(repo, '.claude', 'worktrees', dir);
    git(repo, 'worktree', 'add', '-q', '-b', `b-${dir}`, p);
    wt[name] = fs.realpathSync(p);
  }
});

afterEach(() => {
  process.chdir(origCwd);
  vi.restoreAllMocks();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('commit in a sub-agent worktree (fd13f970)', () => {
  it('(a) parent in A, sub-agent wrote in B, lastCwd back in A: the B commit is the parent\'s', async () => {
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A, writeTrees: [wrote(wt.A, ['a.txt']), wrote(wt.B, ['b.txt'])] });
    writeSession({ sessionId: OTHER, repoPath: wt.C, lastCwd: wt.C, writeTrees: [wrote(wt.C, ['c.txt'])] });
    const msg = stage(wt.B, 'b.txt');

    expect(listSessionsForGitHook(wt.B, { commitFiles: ['b.txt'] }).map((s) => s.sessionId)).toEqual([PARENT]);
    process.chdir(wt.B);
    await handlePrepareCommitMsg(msg, 'message');
    const out = fs.readFileSync(msg, 'utf-8');
    expect(out).toContain(`Origin-Session: ${PARENT.slice(0, 12)}`);
    expect(out).not.toContain(OTHER.slice(0, 12));
  });

  it('(a\') the same when lastCwd points at ANOTHER sub-agent\'s worktree — the real log', () => {
    const sibling = path.join(repo, '.claude', 'worktrees', 'agent-abcef6fcf97c94ffe');
    git(repo, 'worktree', 'add', '-q', '-b', 'b-sibling', sibling);
    writeSession({
      sessionId: PARENT, repoPath: wt.A, lastCwd: fs.realpathSync(sibling),
      writeTrees: [wrote(wt.B, ['b.txt']), wrote(fs.realpathSync(sibling), ['s.txt'])],
    });
    writeSession({ sessionId: OTHER, repoPath: wt.C, lastCwd: wt.C, writeTrees: [wrote(wt.C, ['c.txt'])] });
    stage(wt.B, 'b.txt');
    expect(pickActiveSessionForCommit(wt.B)?.sessionId).toBe(PARENT);
  });

  it('(b) lastCwd still in the sub-agent\'s worktree keeps working', async () => {
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.B, writeTrees: [wrote(wt.B, ['b.txt'])] });
    writeSession({ sessionId: OTHER, repoPath: wt.C, lastCwd: wt.C, writeTrees: [wrote(wt.C, ['c.txt'])] });
    const msg = stage(wt.B, 'b.txt');
    process.chdir(wt.B);
    await handlePrepareCommitMsg(msg, 'message');
    expect(fs.readFileSync(msg, 'utf-8')).toContain(`Origin-Session: ${PARENT.slice(0, 12)}`);
  });

  it('(c) an unrelated session working only in C never gets a commit made in B', () => {
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A, writeTrees: [wrote(wt.B, ['b.txt'])] });
    writeSession({ sessionId: OTHER, repoPath: wt.C, lastCwd: wt.C, writeTrees: [wrote(wt.C, ['c.txt'])] });
    stage(wt.B, 'b.txt');
    expect(listSessionsForGitHook(wt.B, { commitFiles: ['b.txt'] }).map((s) => s.sessionId)).not.toContain(OTHER);
    // And with the parent gone from B, C still does not inherit it.
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A, writeTrees: [wrote(wt.A, ['a.txt'])] });
    expect(listSessionsForGitHook(wt.B, { commitFiles: ['b.txt'] })).toEqual([]);
  });

  it('(d) a tree no session worked in: no candidate, no trailer', async () => {
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A, writeTrees: [wrote(wt.B, ['b.txt'])] });
    writeSession({ sessionId: OTHER, repoPath: wt.C, lastCwd: wt.C, writeTrees: [wrote(wt.C, ['c.txt'])] });
    const msg = stage(wt.D, 'd.txt');
    expect(listSessionsForGitHook(wt.D, { commitFiles: ['d.txt'] })).toEqual([]);
    process.chdir(wt.D);
    await handlePrepareCommitMsg(msg, 'message');
    expect(fs.readFileSync(msg, 'utf-8')).toBe('commit from a sub-agent\n');
  });

  it('a visit to a worktree is not a visit to the main checkout that contains it', () => {
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A, writeTrees: [wrote(wt.B, ['b.txt'])] });
    writeSession({ sessionId: OTHER, repoPath: wt.C, lastCwd: wt.C, writeTrees: [wrote(wt.C, ['c.txt'])] });
    expect(listSessionsForGitHook(repo, { commitFiles: ['b.txt'] })).toEqual([]);
  });
});

describe('presence is not work', () => {
  it('a session that only READ in the tree never claims a commit there', async () => {
    // The probe: the sub-agent ran Read/Grep in B and wrote nothing. A human
    // commits in B while the parent has an open turn. Nothing may be stamped.
    // (Two live sessions, as on any machine running a fleet — a LONE session in
    // the repo still reaches loneSessionMayOwnCommit, the EnterWorktree
    // carve-out this change deliberately leaves alone.)
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A, writeTrees: [wrote(wt.A, ['a.txt'])] });
    writeSession({ sessionId: OTHER, repoPath: wt.C, lastCwd: wt.C, writeTrees: [wrote(wt.C, ['c.txt'])] });
    const msg = stage(wt.B, 'human.txt');
    expect(listSessionsForGitHook(wt.B, { commitFiles: ['human.txt'] })).toEqual([]);
    process.chdir(wt.B);
    await handlePrepareCommitMsg(msg, 'message');
    expect(fs.readFileSync(msg, 'utf-8')).toBe('commit from a sub-agent\n');
  });

  it('a write in the tree that the commit does not touch is not evidence either', async () => {
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A, writeTrees: [wrote(wt.B, ['scratch.md'])] });
    writeSession({ sessionId: OTHER, repoPath: wt.C, lastCwd: wt.C, writeTrees: [wrote(wt.C, ['c.txt'])] });
    const msg = stage(wt.B, 'human.txt');
    expect(listSessionsForGitHook(wt.B, { commitFiles: ['human.txt'] })).toEqual([]);
    process.chdir(wt.B);
    await handlePrepareCommitMsg(msg, 'message');
    expect(fs.readFileSync(msg, 'utf-8')).toBe('commit from a sub-agent\n');
  });

  it('a write older than the age limit stops counting', () => {
    writeSession({
      sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A,
      writeTrees: [wrote(wt.B, ['b.txt'], WRITE_TREE_MAX_AGE_MS + 60_000)],
    });
    writeSession({ sessionId: OTHER, repoPath: wt.C, lastCwd: wt.C, writeTrees: [wrote(wt.C, ['c.txt'])] });
    stage(wt.B, 'b.txt');
    expect(listSessionsForGitHook(wt.B, { commitFiles: ['b.txt'] })).toEqual([]);
  });

  it('the true owner of a shell-write turn beats a visitor with no overlap', () => {
    // The owner lives in B and wrote through a shell command, so it has no
    // ledger for these files; a visitor wrote something ELSE in B earlier.
    // The visitor must not reach breakTie, whose pgrep rung can pick a
    // bystander (commit-owner-tie-went-to-a-bystander).
    writeSession({ sessionId: OTHER, repoPath: wt.B, lastCwd: wt.B });
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A, writeTrees: [wrote(wt.B, ['scratch.md'])] });
    stage(wt.B, 'b.txt');
    expect(listSessionsForGitHook(wt.B, { commitFiles: ['b.txt'] }).map((s) => s.sessionId)).toEqual([OTHER]);
    expect(pickActiveSessionForCommit(wt.B)?.sessionId).toBe(OTHER);
  });
});

describe('session-write-trees', () => {
  it('workTreeRootOf resolves a nested linked worktree to itself, not the main checkout', () => {
    const sub = path.join(wt.B, 'packages', 'cli');
    fs.mkdirSync(sub, { recursive: true });
    expect(workTreeRootOf(sub)).toBe(fs.realpathSync.native(wt.B));
    expect(workTreeRootOf(repo)).toBe(fs.realpathSync.native(repo));
    expect(workTreeRootOf(root)).toBeNull();
  });

  it('a bare repo nested in a checkout does not resolve to the checkout around it', () => {
    const bare = path.join(repo, 'mirror.git');
    git(repo, 'clone', '-q', '--bare', repo, bare);
    expect(workTreeRootOf(bare)).toBeNull();
  });

  it('recordWriteTree records the tree with the files, and merges a second write', () => {
    const s: { writeTrees?: WriteTree[] } = {};
    expect(recordWriteTree(s, wt.B, [path.join(wt.B, 'src', 'a.ts')])).toBe(true);
    expect(recordWriteTree(s, path.join(wt.B, 'src'), ['b.ts'])).toBe(true);
    expect(s.writeTrees).toHaveLength(1);
    expect(filesWrittenInTree(s, wt.B).sort()).toEqual(['a.ts', 'b.ts']);
    expect(sessionWroteInTree(s, wt.B)).toBe(true);
    expect(sessionWroteInTree(s, wt.C)).toBe(false);
    expect(commitOverlapsWritesInTree(s, wt.B, ['packages/cli/src/a.ts'])).toBe(true);
    expect(commitOverlapsWritesInTree(s, wt.B, ['other.ts'])).toBe(false);
  });

  it('recordWriteTree records nothing when no file was written', () => {
    const s: { writeTrees?: WriteTree[] } = {};
    expect(recordWriteTree(s, wt.B, [])).toBe(false);
    expect(s.writeTrees).toBeUndefined();
  });

  it('the cap evicts STALE entries first, and says so', () => {
    const stale = Array.from({ length: MAX_WRITE_TREES }, (_, i) => ({
      path: `/nowhere/stale${i}`, at: new Date(Date.now() - WRITE_TREE_MAX_AGE_MS - 1000).toISOString(), files: ['x'],
    }));
    const fresh = { path: '/nowhere/fresh', at: new Date().toISOString(), files: ['keep.ts'] };
    const s = { writeTrees: [...stale.slice(1), fresh] };
    const evicted: WriteTree[] = [];
    expect(recordWriteTree(s, wt.B, ['b.txt'], (e) => evicted.push(...e))).toBe(true);
    expect(s.writeTrees).toHaveLength(MAX_WRITE_TREES);
    expect(evicted.map((w) => w.path)).toEqual(['/nowhere/stale1']);
    expect(s.writeTrees.some((w) => w.path === '/nowhere/fresh')).toBe(true);
  });

  it('a stale stored entry costs no filesystem call on lookup', () => {
    // 24 deleted sub-agent worktrees is the steady state. Resolving each of
    // them per candidate per git hook is what made the first version expensive.
    const spy = vi.spyOn(fs, 'realpathSync');
    const nativeSpy = vi.spyOn(fs.realpathSync, 'native');
    const s = {
      writeTrees: Array.from({ length: MAX_WRITE_TREES }, (_, i) => ({
        path: path.join(root, 'deleted', `agent-${i}`, 'deep', 'path'),
        at: new Date().toISOString(), files: ['x.ts'],
      })),
    };
    spy.mockClear(); nativeSpy.mockClear();
    expect(sessionWroteInTree(s, wt.B)).toBe(false);
    // One normalization of the hook tree, nothing per stored entry.
    expect(nativeSpy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spy.mock.calls.length).toBe(0);
  });

  it('keepWriteTreesSavedMeanwhile unions a concurrent writer\'s trees and files', () => {
    const mine = { sessionId: PARENT, writeTrees: [wrote(wt.A, ['a.ts']), wrote(wt.C, ['c.ts'])] };
    expect(keepWriteTreesSavedMeanwhile(mine, {
      sessionId: PARENT, writeTrees: [wrote(wt.A, ['a2.ts']), wrote(wt.B, ['b.ts'])],
    })).toBe(2);
    expect(mine.writeTrees.map((w) => w.path).sort()).toEqual([wt.A, wt.B, wt.C].sort());
    expect(filesWrittenInTree(mine, wt.A).sort()).toEqual(['a.ts', 'a2.ts']);
    expect(keepWriteTreesSavedMeanwhile(mine, { sessionId: OTHER, writeTrees: [wrote(wt.D, ['d.ts'])] })).toBe(0);
  });

  it('a peer\'s FRESH tree survives the cap over our own stale ones', () => {
    const stale = Array.from({ length: MAX_WRITE_TREES }, (_, i) => ({
      path: `/nowhere/mine${i}`, at: new Date(Date.now() - WRITE_TREE_MAX_AGE_MS).toISOString(), files: ['x'],
    }));
    const mine = { sessionId: PARENT, writeTrees: stale };
    keepWriteTreesSavedMeanwhile(mine, { sessionId: PARENT, writeTrees: [wrote(wt.B, ['b.ts'])] });
    expect(mine.writeTrees).toHaveLength(MAX_WRITE_TREES);
    expect(sessionWroteInTree(mine, wt.B)).toBe(true);
  });

  it('two parallel sub-agent hooks saving stale copies both keep their tree', () => {
    // Both processes read the state before either saved (the real concurrency).
    writeSession({ sessionId: PARENT, repoPath: wt.A, lastCwd: wt.A, writeTrees: [wrote(wt.A, ['a.ts'])] });
    const file = path.join(repo, '.git', `origin-session-${PARENT.slice(0, 12)}.json`);
    const first = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const second = JSON.parse(fs.readFileSync(file, 'utf-8'));
    recordWriteTree(first, wt.B, ['b.ts']);
    recordWriteTree(second, wt.C, ['c.ts']);
    saveSessionState(first, repo, first.sessionTag);
    saveSessionState(second, repo, second.sessionTag);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(sessionWroteInTree(onDisk, wt.B)).toBe(true);
    expect(sessionWroteInTree(onDisk, wt.C)).toBe(true);
  });
});
