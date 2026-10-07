// OR-11/A5, external review smaller 3: the cherry-pick marker directory goes
// away once it is empty again.
//
// prepare-commit-msg is synchronous; its fast path for an ordinary commit is
// "no .git/origin-cherry-picks → no further git call". A directory left behind
// by the first cherry-pick made every later commit pay for the replay check and
// a HEAD lookup. Only an empty directory is removed, never another pick's marker.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const calls: string[][] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((file: string, args: string[], opts: any) => {
      if (file === 'git') calls.push(args);
      return (actual.execFileSync as any)(file, args, opts);
    }),
  };
});

const { execFileSync } = await import('child_process');
const { rememberCherryPickSource, takeCherryPickSource } = await import('../cherry-pick-source.js');

let repo: string;
const git = (...args: string[]): string => (execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }) as string).trim();
const markers = () => path.join(repo, '.git', 'origin-cherry-picks');
function commit(file: string, body: string, msg: string): string {
  fs.writeFileSync(path.join(repo, file), body);
  git('add', file);
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
}
/** A conflicted pick of `src` onto main, with prepare-commit-msg's marker written; returns the finished commit. */
function conflictedPick(src: string): string {
  try { git('cherry-pick', src); } catch { /* conflict */ }
  expect(fs.existsSync(path.join(repo, '.git', 'CHERRY_PICK_HEAD'))).toBe(true);
  expect(rememberCherryPickSource(repo)).toBe(src);
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'resolved\n');
  git('add', 'shared.txt');
  execFileSync('git', ['commit', '-q', '--no-edit'], { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' } });
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cp-markers-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  commit('base.txt', 'base\n', 'base');
  git('checkout', '-q', '-b', 'feat');
  commit('shared.txt', 'theirs\n', 'change shared');
  git('checkout', '-q', 'main');
  commit('shared.txt', 'ours\n', 'main changes shared');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('cherry-pick marker directory', () => {
  it('disappears when the last marker is consumed', () => {
    const src = git('rev-parse', 'feat');
    const picked = conflictedPick(src);
    expect(fs.readdirSync(markers())).toHaveLength(1);
    expect(takeCherryPickSource(repo, picked)).toBe(src);
    expect(fs.existsSync(markers())).toBe(false);
  });

  it('stays, with the other pick\'s marker, when two markers exist and one is consumed', () => {
    const src = git('rev-parse', 'feat');
    fs.mkdirSync(markers(), { recursive: true });
    const other = path.join(markers(), 'f'.repeat(40));
    fs.writeFileSync(other, JSON.stringify({ source: 'a'.repeat(40), at: new Date().toISOString() }));
    const picked = conflictedPick(src);
    expect(fs.readdirSync(markers())).toHaveLength(2);
    expect(takeCherryPickSource(repo, picked)).toBe(src);
    expect(fs.readdirSync(markers())).toEqual(['f'.repeat(40)]);
    expect(fs.readFileSync(other, 'utf-8')).toContain('a'.repeat(40));
  });

  it('an ordinary commit clears a leftover empty directory, and the next one takes the fast path', () => {
    fs.mkdirSync(markers(), { recursive: true });
    // Directory present: the slow path runs once and removes it.
    rememberCherryPickSource(repo);
    expect(fs.existsSync(markers())).toBe(false);
    // Fast path: the git dir and the replay check only — no HEAD lookup.
    calls.length = 0;
    expect(rememberCherryPickSource(repo)).toBeNull();
    expect(calls.some((a) => a.includes('--verify'))).toBe(false);
    expect(calls).toEqual([['rev-parse', '--git-dir'], ['rev-parse', '--git-dir']]);
  });

  it('an ordinary commit on the parent of a stale marker removes it and then the directory', () => {
    fs.mkdirSync(markers(), { recursive: true });
    fs.writeFileSync(path.join(markers(), git('rev-parse', 'HEAD')), JSON.stringify({ source: 'a'.repeat(40), at: new Date().toISOString() }));
    rememberCherryPickSource(repo);
    expect(fs.existsSync(markers())).toBe(false);
  });
});
