/**
 * `commitBelongsToSession` reads the sibling session states for every
 * untrailered commit (and every commit whose foreign trailer we recorded), and
 * each read spawned `git rev-parse --git-common-dir`: 300 spawns for a
 * 300-commit window, all with the same answer. Window callers now hand it one
 * `gitCommonDirOnce` getter. This pins that the getter looks up once, and that
 * ownership answers do not change with it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitBelongsToSession, dropForeignCommitsFromCapture, filesLeftByForeignCommits, gitCommonDirOnce, ownedRangeCommitShas } from '../commands/hooks.js';

let repo: string;
const git = (a: string[]): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

function commit(file: string, message: string, env: Record<string, string> = {}): string {
  fs.writeFileSync(path.join(repo, file), `${file} ${Math.random()}\n`);
  git(['add', '.']);
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, stdio: 'pipe', env: { ...process.env, ...env } });
  return git(['rev-parse', 'HEAD']);
}

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'common-dir-once-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('gitCommonDirOnce', () => {
  it('looks the common dir up on first use and remembers it', () => {
    const once = gitCommonDirOnce(repo);
    const first = once();
    expect(first).toBe(path.join(repo, '.git'));
    // A fresh lookup would now find no repo at all.
    fs.renameSync(path.join(repo, '.git'), path.join(repo, '.git-moved'));
    expect(gitCommonDirOnce(repo)()).toBeNull();
    expect(once()).toBe(first);
    fs.renameSync(path.join(repo, '.git-moved'), path.join(repo, '.git'));
  });

  it('gives commitBelongsToSession the same answers as looking it up per commit', () => {
    const local = commit('a.txt', 'local, no trailer');
    const siblings = commit('b.txt', 'sibling recorded this, no trailer');
    const liveTrailer = commit('c.txt', 'x\n\nOrigin-Session: 5151aaaa-bbb | Claude Code | 1 prompts');
    const staleTrailer = commit('d.txt', 'y\n\nOrigin-Session: 0dead000-000 | Claude Code | 1 prompts');
    fs.writeFileSync(path.join(repo, '.git', 'origin-session-sib.json'), JSON.stringify({
      sessionId: '5151aaaa-bbbb-cccc', status: 'RUNNING', sessionCommitShas: [siblings],
    }));
    const state: any = {
      sessionId: '9e9e9e9e-1111-2222',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      sessionCommitShas: [liveTrailer, staleTrailer],
    };
    const shas = [local, siblings, liveTrailer, staleTrailer];
    const once = gitCommonDirOnce(repo);
    const withOnce = shas.map((sha) => commitBelongsToSession(repo, sha, state, 'dev@test.dev', undefined, once));
    const perCommit = shas.map((sha) => commitBelongsToSession(repo, sha, state, 'dev@test.dev'));
    expect(withOnce).toEqual(perCommit);
    expect(perCommit).toEqual([true, false, false, true]);
  });
});

describe('ownedRangeCommitShas', () => {
  it('batch-reads the range and keeps what the per-commit predicate keeps', () => {
    const start = commit('base.txt', 'base');
    const local = commit('a.txt', 'local, no trailer');
    const siblings = commit('b.txt', 'sibling recorded this, no trailer');
    const liveTrailer = commit('c.txt', 'x\n\nOrigin-Session: 5151aaaa-bbb | Claude Code | 1 prompts');
    const ours = commit('d.txt', 'ours\n\nOrigin-Session: 9e9e9e9e-111 | Claude Code | 1 prompts');
    const pulled = commit('e.txt', 'squash (#12)', { GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub' });
    fs.writeFileSync(path.join(repo, '.git', 'origin-session-sib.json'), JSON.stringify({
      sessionId: '5151aaaa-bbbb-cccc', status: 'RUNNING', sessionCommitShas: [siblings],
    }));
    const state: any = {
      sessionId: '9e9e9e9e-1111-2222',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      headShaAtStart: start,
      sessionCommitShas: [liveTrailer],
    };
    const range = [pulled, ours, liveTrailer, siblings, local];
    const perCommit = range.filter((sha) => commitBelongsToSession(repo, sha, state, 'dev@test.dev'));
    expect(ownedRangeCommitShas(repo, state)).toEqual(perCommit);
    expect(perCommit).toEqual([ours, local]);
  });
});

describe('filesLeftByForeignCommits', () => {
  it('batch-reads the window and still names only files foreign commits left as-is', () => {
    const start = commit('base.txt', 'base');
    commit('mine.txt', 'local, no trailer');
    const siblings = commit('sib.txt', 'sibling recorded this, no trailer');
    commit('pulled.txt', 'squash (#12)', { GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub' });
    commit('ours.txt', 'ours\n\nOrigin-Session: 9e9e9e9e-111 | Claude Code | 1 prompts');
    fs.writeFileSync(path.join(repo, '.git', 'origin-session-sib.json'), JSON.stringify({
      sessionId: '5151aaaa-bbbb-cccc', status: 'RUNNING', sessionCommitShas: [siblings],
    }));
    const state: any = {
      sessionId: '9e9e9e9e-1111-2222',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      headShaAtStart: start,
    };
    expect([...filesLeftByForeignCommits(repo, state, start)].sort()).toEqual(['pulled.txt', 'sib.txt']);
  });
});

describe('dropForeignCommitsFromCapture', () => {
  it('batch-reads the details, abbreviated shas included, and drops what the per-commit predicate drops', () => {
    const mine = commit('mine.txt', 'local, no trailer');
    const siblings = commit('sib.txt', 'sibling recorded this, no trailer');
    const pulled = commit('pulled.txt', 'squash (#12)', { GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub' });
    const ours = commit('ours.txt', 'ours\n\nOrigin-Session: 9e9e9e9e-111 | Claude Code | 1 prompts');
    fs.writeFileSync(path.join(repo, '.git', 'origin-session-sib.json'), JSON.stringify({
      sessionId: '5151aaaa-bbbb-cccc', status: 'RUNNING', sessionCommitShas: [siblings],
    }));
    const state: any = { sessionId: '9e9e9e9e-1111-2222', startedAt: new Date(Date.now() - 3_600_000).toISOString() };
    // The pulled commit and our own arrive abbreviated, as a capture can carry them.
    const shas = [mine, siblings, pulled.slice(0, 10), ours.slice(0, 10)];
    const cap = {
      commitShas: [...shas],
      commitDetails: shas.map((sha, i) => ({ sha, filesChanged: [['mine.txt', 'sib.txt', 'pulled.txt', 'ours.txt'][i]] })),
    };
    const kept = shas.filter((sha) => commitBelongsToSession(repo, sha, state, 'dev@test.dev'));
    expect(dropForeignCommitsFromCapture(repo, state, cap).sort()).toEqual(['pulled.txt', 'sib.txt']);
    expect(cap.commitShas).toEqual(kept);
    expect(kept).toEqual([mine, ours.slice(0, 10)]);
  });
});
