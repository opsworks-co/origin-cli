// The origin-sessions push was rejected non-fast-forward on every push, forever.
//
// Every clone folds its own sessions onto its own copy of the branch and none
// ever fetched the others'. The first clone to push won; from then on every
// other clone's push was rejected — swallowed in a catch, logged as "skipped"
// — and its session records never left the machine. On this box the remote
// tip sat six months behind 1,700 local commits.
//
// The branch is a tree of per-session directories, so a divergence reconciles
// by union. This builds two clones with different sessions, pushes one, and
// proves the other's push lands with BOTH sets on the remote.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { reconcileSessionBranchWithRemote } from '../local-entrypoint.js';

let tmp = '';
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

/** Commit a sessions tree onto `origin-sessions` in `repo` with plumbing, like the CLI does. */
function foldSession(repo: string, sessionId: string, content: string): string {
  const idx = path.join(repo, '.git', `tmp-index-${sessionId}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const parent = (() => { try { return git(repo, ['rev-parse', 'refs/heads/origin-sessions']); } catch { return ''; } })();
  execFileSync('git', ['read-tree', '--empty'], { cwd: repo, env });
  if (parent) execFileSync('git', ['read-tree', `${parent}^{tree}`], { cwd: repo, env });
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content, encoding: 'utf-8' }).trim();
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},sessions/${sessionId}/metadata.json`], { cwd: repo, env });
  const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf-8' }).trim();
  const args = ['commit-tree', tree, '-m', `session ${sessionId}`];
  if (parent) args.push('-p', parent);
  const commit = execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  git(repo, ['update-ref', 'refs/heads/origin-sessions', commit]);
  fs.unlinkSync(idx);
  return commit;
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sessions-branch-')));
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('reconcileSessionBranchWithRemote', () => {
  it('folds the remote\'s sessions in so a diverged clone can push', () => {
    const remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    for (const r of [a, b]) {
      execFileSync('git', ['init', '-q', r]);
      git(r, ['remote', 'add', 'origin', remote]);
      git(r, ['config', 'user.name', 'T']);
      git(r, ['config', 'user.email', 't@x']);
    }
    // Clone A publishes its session and pushes.
    foldSession(a, 'session-a', '{"id":"a"}');
    git(a, ['push', '-q', 'origin', 'origin-sessions']);
    // Clone B, which never fetched, has its own unrelated history.
    foldSession(b, 'session-b', '{"id":"b"}');
    expect(() => git(b, ['push', '-q', 'origin', 'origin-sessions'])).toThrow();

    expect(reconcileSessionBranchWithRemote(b, 'origin')).toBe(true);
    git(b, ['push', '-q', 'origin', 'origin-sessions']);

    const tip = git(b, ['rev-parse', 'refs/heads/origin-sessions']);
    expect(git(remote, ['rev-parse', 'refs/heads/origin-sessions'])).toBe(tip);
    const files = git(b, ['ls-tree', '-r', '--name-only', tip]).split('\n').sort();
    expect(files).toEqual(['sessions/session-a/metadata.json', 'sessions/session-b/metadata.json']);
    // Both histories are parents, so neither side's record is orphaned.
    expect(git(b, ['rev-list', '--parents', '-n1', tip]).split(' ')).toHaveLength(3);
  });

  it('is a no-op when the local branch already contains the remote tip', () => {
    const remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    const a = path.join(tmp, 'a');
    execFileSync('git', ['init', '-q', a]);
    git(a, ['remote', 'add', 'origin', remote]);
    git(a, ['config', 'user.name', 'T']);
    git(a, ['config', 'user.email', 't@x']);
    foldSession(a, 'session-a', '{"id":"a"}');
    git(a, ['push', '-q', 'origin', 'origin-sessions']);
    const before = git(a, ['rev-parse', 'refs/heads/origin-sessions']);
    foldSession(a, 'session-a2', '{"id":"a2"}');
    const after = git(a, ['rev-parse', 'refs/heads/origin-sessions']);
    expect(reconcileSessionBranchWithRemote(a, 'origin')).toBe(true);
    expect(git(a, ['rev-parse', 'refs/heads/origin-sessions'])).toBe(after);
    expect(after).not.toBe(before);
  });

  it('a local copy of a session both sides hold wins', () => {
    const remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    for (const r of [a, b]) {
      execFileSync('git', ['init', '-q', r]);
      git(r, ['remote', 'add', 'origin', remote]);
      git(r, ['config', 'user.name', 'T']);
      git(r, ['config', 'user.email', 't@x']);
    }
    foldSession(a, 'shared', '{"turns":1}');
    git(a, ['push', '-q', 'origin', 'origin-sessions']);
    foldSession(b, 'shared', '{"turns":3}');
    expect(reconcileSessionBranchWithRemote(b, 'origin')).toBe(true);
    const tip = git(b, ['rev-parse', 'refs/heads/origin-sessions']);
    expect(git(b, ['show', `${tip}:sessions/shared/metadata.json`])).toBe('{"turns":3}');
  });
});
