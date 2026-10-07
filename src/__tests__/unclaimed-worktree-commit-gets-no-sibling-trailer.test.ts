/**
 * A commit made in a worktree NO live session claims must not be stamped with
 * the session of a SIBLING worktree.
 *
 * 2026-09-27, this machine (~/.origin/hooks.log):
 *
 *   14:01:58 [pre-tool-use] capture explicitly ended; waiting for a new user prompt
 *            (conversation 2e7774de, cwd …/worktrees/vigorous-rubin-91647c)
 *   14:02:01 [prepare-commit-msg] === GIT HOOK INVOKED ===
 *            {"msgFile":"…/.git/worktrees/vigorous-rubin-91647c/COMMIT_EDITMSG"}
 *   14:02:40 [prepare-commit-msg] trailers written {"sessionId":"d027b430-cf4"}
 *   14:02:41 [post-commit] disambiguated by Origin-Session trailer {"ofActive":1}
 *   14:02:41 [post-commit] branch changed {"to":"fix/refilled-row-drops-its-chat-only-flag"}
 *
 * vigorous-rubin's own session had been ended by hand, so nothing live claimed
 * the tree and excludeSessionsFromOtherTrees passed the pool through as the
 * "unclaimed worktree" (EnterWorktree) case. The pool was d027b430 alone — a
 * session living in `capturing-corruption-33d0db`, mid-turn on a merge of its
 * own — and the lone-candidate rule took it on "turn open". Its state also
 * listed the MAIN checkout in discoveredWorkTrees, so a sessionTrees-based
 * check would not have caught it either.
 *
 * Real git, real linked worktrees under the main checkout, state in the common
 * git dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handlePrepareCommitMsg, listSessionsForGitHook, pickActiveSessionForCommit } from '../commands/hooks.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

let root: string;
let repo: string;
let committing: string; // vigorous-rubin-91647c
let sibling: string; // capturing-corruption-33d0db
const origCwd = process.cwd();

const SIBLING_SESSION = 'd027b430-cf40-4f8e-99a0-152a9cd1d9c3';
const MAIN_SESSION = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

function writeSession(opts: { sessionId: string; repoPath: string; lastCwd: string; discovered?: string[] }): void {
  const tag = opts.sessionId.slice(0, 12);
  const state = {
    sessionId: opts.sessionId,
    claudeSessionId: `conv-${tag}`,
    transcriptPath: '',
    model: 'claude-opus-4-8',
    startedAt: new Date().toISOString(),
    prompts: ['merge main in'],
    activeTurn: { index: 0, turnId: 't_4e1699d039c24cda', startedAt: new Date().toISOString() },
    repoPath: opts.repoPath,
    canonicalRepoPath: repo,
    lastCwd: opts.lastCwd,
    ...(opts.discovered ? { discoveredWorkTrees: opts.discovered.map((p) => ({ path: p, sha: 'x', promptIndex: 0 })) } : {}),
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
  fs.writeFileSync(msg, 'fix(capture): a row the ledger refills drops the chat-only verdict\n');
  return msg;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-unclaimed-wt-')));
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
  const a = path.join(repo, '.claude', 'worktrees', 'vigorous-rubin-91647c');
  const b = path.join(repo, '.claude', 'worktrees', 'capturing-corruption-33d0db');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix/refilled-row-drops-its-chat-only-flag', a);
  git(repo, 'worktree', 'add', '-q', '-b', 'fix/chat-only-mark-dies-with-the-fill', b);
  committing = fs.realpathSync(a);
  sibling = fs.realpathSync(b);
});

afterEach(() => {
  process.chdir(origCwd);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('commit in a worktree no live session claims (9d583342)', () => {
  it('the sibling worktree\'s mid-turn session is not a candidate, and no trailer is written', async () => {
    // discoveredWorkTrees naming the MAIN checkout, as d027b430's state did.
    writeSession({ sessionId: SIBLING_SESSION, repoPath: sibling, lastCwd: sibling, discovered: [repo] });
    const msg = stage(committing, 'packages-cli-fix.ts');

    expect(listSessionsForGitHook(committing, { commitFiles: ['packages-cli-fix.ts'] })).toEqual([]);
    expect(pickActiveSessionForCommit(committing, { afterManualEnd: true })).toBeNull();
    process.chdir(committing);
    await handlePrepareCommitMsg(msg, 'message');
    const out = fs.readFileSync(msg, 'utf-8');
    expect(out).not.toContain('Origin-Session');
    expect(out).not.toContain(SIBLING_SESSION.slice(0, 12));
  });

  it('a commit in the MAIN checkout is not the linked worktree\'s either', () => {
    writeSession({ sessionId: SIBLING_SESSION, repoPath: sibling, lastCwd: sibling });
    stage(repo, 'main-file.ts');
    expect(pickActiveSessionForCommit(repo, { afterManualEnd: true })).toBeNull();
  });

  it('the sibling session still owns commits in its OWN worktree', () => {
    writeSession({ sessionId: SIBLING_SESSION, repoPath: sibling, lastCwd: sibling });
    stage(sibling, 'own.ts');
    expect(pickActiveSessionForCommit(sibling)?.sessionId).toBe(SIBLING_SESSION);
  });

  it('a sibling session whose lastCwd moved INTO the committing tree is kept', () => {
    writeSession({ sessionId: SIBLING_SESSION, repoPath: sibling, lastCwd: path.join(committing, 'packages') });
    stage(committing, 'moved.ts');
    expect(pickActiveSessionForCommit(committing)?.sessionId).toBe(SIBLING_SESSION);
  });

  it('EnterWorktree is untouched: a session homed in the MAIN checkout still reaches the unclaimed worktree', () => {
    writeSession({ sessionId: MAIN_SESSION, repoPath: repo, lastCwd: repo });
    stage(committing, 'entered.ts');
    expect(listSessionsForGitHook(committing).map((s) => s.sessionId)).toEqual([MAIN_SESSION]);
    expect(pickActiveSessionForCommit(committing)?.sessionId).toBe(MAIN_SESSION);
  });
});
