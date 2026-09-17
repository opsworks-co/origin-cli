/**
 * The window resolvers asked `isAncestor`, `isMerge`, `firstParent` and
 * `changedFiles` one commit or pair at a time, and the `filesLeftBy…`
 * exclusions read one `diff-tree` per commit and one `git show` per file. They
 * are now answered from one parent graph of the window and batched reads.
 * These pin the answers on histories where each of those questions decides the
 * result: one inherited line, a turn's own merge, and earlier-turn commits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  filesLeftByForeignCommits,
  filesLeftByOwnEarlierCommits,
  inheritedFileSourcesForTurn,
  scopedCommitForTurn,
} from '../commands/hooks.js';

let repo: string;
const git = (a: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
const head = (): string => git(['rev-parse', 'HEAD']);
const pulled = { GIT_COMMITTER_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub' };
function commit(files: Record<string, string>, message: string, env: Record<string, string> = {}): string {
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), content);
  git(['add', '.']);
  git(['commit', '-q', '-m', message], env);
  return head();
}
const shadowOf = (parent: string): string =>
  git(['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', 'origin shadow 0']);
const baseState = (extra: Record<string, unknown> = {}): any => ({
  sessionId: '9e9e9e9e-1111-2222',
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  promptTurnIds: ['t0', 't1'],
  ...extra,
});

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'window-graph-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('inheritedFileSourcesForTurn', () => {
  it('a checked-out line gives each file the newest commit on it that touched the file', () => {
    const base = commit({ 'f.txt': 'base\n', 'g.txt': 'base\n' }, 'base');
    const from = shadowOf(base);
    git(['checkout', '-q', '-b', 'upstream']);
    commit({ 'f.txt': 'one\n' }, 'u1', pulled);
    const u2 = commit({ 'g.txt': 'two\n' }, 'u2', pulled);
    const u3 = commit({ 'f.txt': 'three\n' }, 'u3', pulled);
    commit({ 'h.txt': 'four\n' }, 'u4', pulled);
    const sources = inheritedFileSourcesForTurn(repo, baseState(), from, 0, ['f.txt', 'g.txt']);
    expect(sources && Object.fromEntries(sources)).toEqual({ 'f.txt': u3, 'g.txt': u2 });
  });

  it('a file the turn\'s own merge brought in cleanly keeps upstream as its source', () => {
    const base = commit({ 'f.txt': 'base\n', 'mine.txt': 'base\n' }, 'base');
    const from = shadowOf(base);
    git(['checkout', '-q', '-b', 'upstream']);
    commit({ 'f.txt': 'one\n' }, 'u1', pulled);
    const u2 = commit({ 'f.txt': 'two\n' }, 'u2', pulled);
    git(['checkout', '-q', 'main']);
    const own = commit({ 'mine.txt': 'mine\n' }, 'own');
    git(['merge', '-q', '--no-edit', 'upstream']);
    const merge = head();
    const state = baseState({ commitTurns: [{ sha: own, turnId: 't0' }, { sha: merge, turnId: 't0' }] });
    const sources = inheritedFileSourcesForTurn(repo, state, from, 0, ['f.txt', 'mine.txt']);
    expect(sources && Object.fromEntries(sources)).toEqual({ 'f.txt': u2 });
    expect(scopedCommitForTurn(repo, state, 0, from, merge, ['f.txt', 'mine.txt'])?.inheritedFiles).toEqual(['f.txt']);
  });
});

describe('filesLeftBy… exclusions', () => {
  it('name files still as the commit left them, not ones changed since', () => {
    const base = commit({ 'a.txt': 'base\n' }, 'base');
    const t0 = commit({ 'kept.txt': 'turn 0\n', 'edited.txt': 'turn 0\n' }, 'turn 0 commit');
    commit({ 'theirs.txt': 'theirs\n', 'retouched.txt': 'theirs\n' }, 'pulled', pulled);
    fs.writeFileSync(path.join(repo, 'edited.txt'), 'turn 1 edit\n');
    fs.writeFileSync(path.join(repo, 'retouched.txt'), 'turn 1 edit\n');
    const state = baseState({ commitTurns: [{ sha: t0, turnId: 't0' }], sessionCommitShas: [t0] });
    expect([...filesLeftByOwnEarlierCommits(repo, state, base, 1)].sort()).toEqual(['kept.txt']);
    expect([...filesLeftByForeignCommits(repo, state, base)].sort()).toEqual(['theirs.txt']);
  });
});
