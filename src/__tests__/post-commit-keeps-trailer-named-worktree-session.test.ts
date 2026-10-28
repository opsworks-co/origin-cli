/**
 * post-commit keeps the live session its commit's own `Origin-Session:` trailer
 * names, when the only thing against it is a home in another linked worktree of
 * the same repository.
 *
 * Commit 6f67706e (2026-10-02, found 2026-10-13) was made in worktree
 * `capturing-corruption-33d0db` and trailered `Origin-Session: df8cc9aa` by
 * prepare-commit-msg. df8cc9aa was live, homed in
 * `repository-tab-cleanup-07ab83`. post-commit's candidate list dropped it as
 * "working in another tree", so no session update listed the sha and no note
 * was written.
 *
 * The neighbour protections stay: no trailer (prepare-commit-msg's own call),
 * an amend carrying an old trailer, and a trailer naming a session homed in a
 * DIFFERENT repository all leave the list as it was.
 *
 * When the reflog cannot be read (a starved host times the `git reflog`
 * subprocess out), prepare-commit-msg's fresh-stamp marker answers instead —
 * follow-up to #2392. The read is stubbed here, not timed out.
 *
 * Real git, real linked worktrees, state in the common git dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const reflog = vi.hoisted(() => ({ unreadable: false }));
vi.mock('../commit-replay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commit-replay.js')>();
  return {
    ...actual,
    readSubjectThatCreated: (repoPath: string, sha: string) =>
      reflog.unreadable ? undefined : actual.readSubjectThatCreated(repoPath, sha),
  };
});

import { listSessionsForGitHook, pickSessionForCommit } from '../commands/hooks.js';
import { handlePrepareCommitMsg } from '../commands/hooks/git-hooks.js';
import { noteTrailerStamp, takeFreshStamp } from '../fresh-stamp-marker.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

let root: string;
let repo: string;
let committing: string; // capturing-corruption-33d0db
let home: string; // repository-tab-cleanup-07ab83

const OWNER = 'df8cc9aa-1b2c-4d3e-8f40-5a6b7c8d9e0f';
const RESIDENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function writeSession(opts: { sessionId: string; repoPath: string; lastCwd: string; stateRepo?: string }): void {
  const tag = opts.sessionId.slice(0, 12);
  const state = {
    sessionId: opts.sessionId,
    claudeSessionId: `conv-${tag}`,
    transcriptPath: '',
    model: 'claude-opus-5-5',
    startedAt: new Date().toISOString(),
    prompts: ['tidy the repository tab'],
    activeTurn: { index: 0, turnId: 't_6f67706e00000000', startedAt: new Date().toISOString() },
    repoPath: opts.repoPath,
    canonicalRepoPath: repo,
    lastCwd: opts.lastCwd,
    headShaAtStart: null,
    headShaAtLastStop: null,
    prePromptSha: null,
    branch: null,
    sessionTag: tag,
  };
  fs.writeFileSync(path.join(opts.stateRepo || repo, '.git', `origin-session-${tag}.json`), JSON.stringify(state), { mode: 0o600 });
}

/** Commit `file` in `tree` with a message trailered for `sessionId`; returns [sha, full message]. */
function commitWithTrailer(tree: string, file: string, sessionId: string, amend = false): [string, string] {
  fs.writeFileSync(path.join(tree, file), `change ${Date.now()}\n`);
  git(tree, 'add', file);
  const msg = `fix(web): repository tab drops stale rows\n\nOrigin-Session: ${sessionId.slice(0, 12)} | Claude Code | 1 prompts | turn 1\n`;
  git(tree, 'commit', '-q', ...(amend ? ['--amend'] : []), '-m', msg);
  return [git(tree, 'rev-parse', 'HEAD'), git(tree, 'log', '-1', '--format=%B')];
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-trailer-wt-')));
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
  const a = path.join(repo, '.claude', 'worktrees', 'capturing-corruption-33d0db');
  const b = path.join(repo, '.claude', 'worktrees', 'repository-tab-cleanup-07ab83');
  git(repo, 'worktree', 'add', '-q', '-b', 'claude/capturing-corruption', a);
  git(repo, 'worktree', 'add', '-q', '-b', 'claude/repository-tab-cleanup-07ab83', b);
  committing = fs.realpathSync(a);
  home = fs.realpathSync(b);
});

afterEach(() => {
  reflog.unreadable = false;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('post-commit keeps the session the commit trailer names (6f67706e / df8cc9aa)', () => {
  it('keeps the live session homed in a sibling worktree of the same repo, and the trailer picks it', () => {
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    const [sha, message] = commitWithTrailer(committing, 'repo-tab.ts', OWNER);

    const pool = listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha });
    expect(pool.map((s) => s.sessionId)).toEqual([OWNER]);
    expect(pickSessionForCommit(pool, { commitMessage: message })).toMatchObject({ reason: 'trailer', session: { sessionId: OWNER } });
  });

  it('keeps it beside a session that lives in the committing tree; the trailer still decides', () => {
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    writeSession({ sessionId: RESIDENT, repoPath: committing, lastCwd: committing });
    const [sha, message] = commitWithTrailer(committing, 'repo-tab.ts', OWNER);

    const pool = listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha });
    expect(pool.map((s) => s.sessionId).sort()).toEqual([OWNER, RESIDENT].sort());
    expect(pickSessionForCommit(pool, { commitMessage: message }).session?.sessionId).toBe(OWNER);
  });

  it('without a trailer (prepare-commit-msg\'s call) the sibling is still dropped', () => {
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    expect(listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'] })).toEqual([]);
  });

  it('an amend carrying an old trailer does not bring the sibling back', () => {
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    commitWithTrailer(committing, 'repo-tab.ts', OWNER);
    const [sha, message] = commitWithTrailer(committing, 'repo-tab.ts', OWNER, true);
    expect(listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha })).toEqual([]);
  });

  it('a copied commit whose inherited trailer names the sibling, and whose own names the resident, does not keep the sibling', () => {
    // `cherry-pick -n` + commit reads as a plain `commit:`; prepare-commit-msg
    // appends the resident's trailer after the sibling's.
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    writeSession({ sessionId: RESIDENT, repoPath: committing, lastCwd: committing });
    fs.writeFileSync(path.join(committing, 'repo-tab.ts'), 'copied\n');
    git(committing, 'add', 'repo-tab.ts');
    const msg = `fix(web): repository tab drops stale rows\n\nOrigin-Session: ${OWNER.slice(0, 12)} | Claude Code | 1 prompts | turn 1\nOrigin-Session: ${RESIDENT.slice(0, 12)} | Claude Code | 2 prompts | turn 2\n`;
    git(committing, 'commit', '-q', '-m', msg);
    const sha = git(committing, 'rev-parse', 'HEAD');
    const message = git(committing, 'log', '-1', '--format=%B');
    const pool = listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha });
    expect(pool.map((s) => s.sessionId)).toEqual([RESIDENT]);
  });

  it('a trailer naming a session homed in ANOTHER repository does not keep it', () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    // State sits in THIS repo's common dir, but its home is a different repository.
    writeSession({ sessionId: OWNER, repoPath: other, lastCwd: other });
    const [sha, message] = commitWithTrailer(committing, 'repo-tab.ts', OWNER);
    expect(listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha })).toEqual([]);
  });
});

describe('reflog unreadable: the fresh-stamp marker from prepare-commit-msg decides (follow-up to #2392)', () => {
  const stamps = () => path.join(git(committing, 'rev-parse', '--absolute-git-dir'), 'origin-stamps');
  const token = OWNER.slice(0, 12);

  it('keeps the sibling session when prepare-commit-msg left a fresh stamp, and consumes the marker', () => {
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    const [sha, message] = commitWithTrailer(committing, 'repo-tab.ts', OWNER);
    noteTrailerStamp(committing, 'message', token, null);
    expect(fs.existsSync(path.join(stamps(), token))).toBe(true);

    reflog.unreadable = true;
    const pool = listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha });
    expect(pool.map((s) => s.sessionId)).toEqual([OWNER]);
    // Spent: the directory is gone, and a second look does not vouch again.
    expect(fs.existsSync(stamps())).toBe(false);
    expect(listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha })).toEqual([]);
  });

  it('drops it when there is no marker', () => {
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    const [sha, message] = commitWithTrailer(committing, 'repo-tab.ts', OWNER);
    reflog.unreadable = true;
    expect(listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha })).toEqual([]);
  });

  it('drops it for an amend: prepare-commit-msg with source=commit cleared the earlier stamp', async () => {
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    commitWithTrailer(committing, 'repo-tab.ts', OWNER);
    noteTrailerStamp(committing, 'message', token, null); // the original commit's stamp, not yet consumed
    const [sha, message] = commitWithTrailer(committing, 'repo-tab.ts', OWNER, true);
    // The amend's prepare-commit-msg, run for real from the committing tree.
    const msgFile = path.join(git(committing, 'rev-parse', '--absolute-git-dir'), 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, message);
    const cwd = process.cwd();
    process.chdir(committing);
    try { await handlePrepareCommitMsg(msgFile, 'commit'); } finally { process.chdir(cwd); }
    expect(fs.existsSync(path.join(stamps(), token))).toBe(false);

    reflog.unreadable = true;
    expect(listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha })).toEqual([]);
  });

  it('a readable reflog still decides alone — an amend is dropped even with a stamp, and the stamp is spent', () => {
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    commitWithTrailer(committing, 'repo-tab.ts', OWNER);
    const [sha, message] = commitWithTrailer(committing, 'repo-tab.ts', OWNER, true);
    noteTrailerStamp(committing, 'message', token, null);
    expect(listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha })).toEqual([]);
    expect(fs.existsSync(stamps())).toBe(false);
  });

  it('a marker older than ten minutes does not vouch', () => {
    writeSession({ sessionId: OWNER, repoPath: home, lastCwd: home });
    const [sha, message] = commitWithTrailer(committing, 'repo-tab.ts', OWNER);
    fs.mkdirSync(stamps(), { recursive: true });
    fs.writeFileSync(path.join(stamps(), token), JSON.stringify({ at: new Date(Date.now() - 11 * 60_000).toISOString() }));
    reflog.unreadable = true;
    expect(listSessionsForGitHook(committing, { commitFiles: ['repo-tab.ts'], commitMessage: message, commitSha: sha })).toEqual([]);
    expect(fs.existsSync(stamps())).toBe(false);
  });

  it('noteTrailerStamp: no marker for a merge/squash/amend source or an unstamped commit; takeFreshStamp needs the trailer token', () => {
    const msg = `x\n\nOrigin-Session: ${token} | Claude Code\n`;
    for (const source of ['merge', 'squash', 'commit']) {
      noteTrailerStamp(committing, source, token, msg);
      expect(fs.existsSync(stamps())).toBe(false);
    }
    noteTrailerStamp(committing, undefined, token, null);
    expect(takeFreshStamp(committing, 'no trailer here')).toBe(false);
    expect(fs.existsSync(path.join(stamps(), token))).toBe(true);
    noteTrailerStamp(committing, 'message', null, msg); // not stamped this time: clears
    expect(fs.existsSync(stamps())).toBe(false);
    noteTrailerStamp(committing, 'template', token, null);
    expect(takeFreshStamp(committing, msg)).toBe(true);
    expect(takeFreshStamp(committing, msg)).toBe(false);
  });
});
