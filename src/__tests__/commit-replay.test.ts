/**
 * Which commits are replays, measured on real git — see commit-replay.ts.
 * Every operation that writes a commit, and the two in-progress states
 * prepare-commit-msg sees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitReplayKind, replayInProgress } from '../commit-replay.js';

let repo: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true' };
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe', env }).trim();
const tryGit = (...args: string[]) => { try { git(...args); } catch { /* a conflict stops it — expected */ } };
const head = () => git('rev-parse', 'HEAD');
const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);
const commit = (message: string) => { git('add', '-A'); git('commit', '-q', '-m', message); return head(); };

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-replay-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@test.dev');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  write('a.ts', 'a\n');
  commit('base');
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('commitReplayKind', () => {
  it('an ordinary commit, an amend and a revert are authored, not replays', () => {
    write('a.ts', 'a\nb\n');
    expect(commitReplayKind(repo, commit('plain'))).toBeNull();
    git('commit', '-q', '--amend', '-m', 'plain, amended');
    expect(commitReplayKind(repo, head())).toBeNull();
    git('revert', '--no-edit', 'HEAD');
    expect(commitReplayKind(repo, head())).toBeNull();
  });

  it('every commit a rebase picks is a rebase replay, read after the rebase has finished', () => {
    git('checkout', '-q', '-b', 'side');
    write('s.ts', '1\n'); commit('side 1');
    write('s.ts', '1\n2\n'); commit('side 2');
    git('checkout', '-q', 'main');
    write('a.ts', 'a\nmain\n'); commit('main moves');
    git('checkout', '-q', 'side');
    git('rebase', '-q', 'main');
    const tip = head();
    const first = git('rev-parse', 'HEAD~1');
    // Later visits to the same sha do not change what created it.
    git('checkout', '-q', 'main');
    git('checkout', '-q', tip);
    expect(commitReplayKind(repo, tip)).toBe('rebase');
    expect(commitReplayKind(repo, first)).toBe('rebase');
  });

  it('a rebase the agent resolved and continued is still a replay', () => {
    git('checkout', '-q', '-b', 'conflict');
    write('a.ts', 'theirs\n'); commit('conflicting');
    git('checkout', '-q', 'main');
    write('a.ts', 'ours\n'); commit('main');
    git('checkout', '-q', 'conflict');
    tryGit('rebase', 'main');
    expect(replayInProgress(repo), 'the stopped rebase is visible to prepare-commit-msg').toBe('rebase');
    write('a.ts', 'resolved\n');
    git('add', 'a.ts');
    git('rebase', '--continue');
    expect(replayInProgress(repo)).toBeNull();
    expect(commitReplayKind(repo, head())).toBe('rebase');
  });

  it('a cherry-pick is a cherry-pick replay', () => {
    git('checkout', '-q', '-b', 'donor');
    write('d.ts', 'd\n');
    const donor = commit('donor');
    git('checkout', '-q', 'main');
    // Move main first. Picked onto its own parent in the same second, a
    // cherry-pick writes a byte-identical commit — the donor's own sha.
    write('a.ts', 'a\nmain\n'); commit('main moves');
    git('cherry-pick', donor);
    expect(head()).not.toBe(donor);
    expect(commitReplayKind(repo, head())).toBe('cherry-pick');
  });

  it('answers null for a sha it cannot place, rather than guessing', () => {
    expect(commitReplayKind(repo, 'f'.repeat(40))).toBeNull();
    expect(commitReplayKind(repo, 'not-a-sha')).toBeNull();
  });
});

describe('replayInProgress', () => {
  it('sees a cherry-pick stopped on a conflict, and nothing once it is done', () => {
    git('checkout', '-q', '-b', 'donor');
    write('a.ts', 'donor\n');
    const donor = commit('donor');
    git('checkout', '-q', 'main');
    write('a.ts', 'main\n'); commit('main');
    expect(replayInProgress(repo)).toBeNull();
    tryGit('cherry-pick', donor);
    expect(replayInProgress(repo)).toBe('cherry-pick');
    git('cherry-pick', '--abort');
    expect(replayInProgress(repo)).toBeNull();
  });
});
