/**
 * after-file-edit stamps HEAD on a turn only when the turn moved HEAD.
 *
 * The hook ran `git rev-parse HEAD` on every edit and sent it as the turn's
 * `commitSha`. For a turn that had committed nothing, that is the commit the
 * turn STARTED from. capture-e2e-cursor-binary's stored golden showed turn 1
 * with `commit: base` — the repo's pre-session commit — because the server's
 * sha is fill-only: the first stamp stays, and the edit hook stamps first.
 *
 * Driven against REAL git, with shadows cut the way the hooks cut them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit } from '../git-capture.js';
import { headCommitMadeSince } from '../commands/hooks/after-file-edit.js';

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'afe-head-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'afe-head-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
  write('app.py', 'print("old")\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  process.env.HOME = prevHome; process.env.USERPROFILE = prevUserProfile;
  for (const d of [repo, home]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('after-file-edit stamps HEAD only when the turn moved it', () => {
  it('a turn that only edited (clean start, baseline is HEAD) gets no stamp', () => {
    const base = git('rev-parse', 'HEAD');
    write('app.py', 'print("new")\n');
    expect(headCommitMadeSince(repo, base)).toBeNull();
  });

  it('a turn whose baseline is a shadow over a dirty tree gets no stamp', () => {
    write('notes.md', 'dirty before the turn\n');
    const shadow = createShadowCommit(repo, 'prompt-test');
    expect(shadow).toBeTruthy();
    write('app.py', 'print("new")\n');
    expect(headCommitMadeSince(repo, shadow!)).toBeNull();
  });

  it('a turn that committed gets its commit', () => {
    const base = git('rev-parse', 'HEAD');
    write('app.py', 'print("new")\n');
    git('add', '.'); git('commit', '-q', '-m', 'mine');
    const mine = git('rev-parse', 'HEAD');
    expect(headCommitMadeSince(repo, base)).toBe(mine);
  });

  it('a committing turn whose baseline is a shadow gets its commit', () => {
    write('notes.md', 'dirty\n');
    const shadow = createShadowCommit(repo, 'prompt-test');
    git('add', '.'); git('commit', '-q', '-m', 'mine');
    expect(headCommitMadeSince(repo, shadow!)).toBe(git('rev-parse', 'HEAD'));
  });

  it('a HEAD that left the baseline\'s line is not the turn\'s commit', () => {
    git('checkout', '-q', '-b', 'other');
    write('other.py', 'x\n');
    git('add', '.'); git('commit', '-q', '-m', 'elsewhere');
    const elsewhere = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    write('app.py', 'print("ahead")\n');
    git('add', '.'); git('commit', '-q', '-m', 'ahead on main');
    const start = git('rev-parse', 'HEAD');
    git('checkout', '-q', elsewhere);
    expect(headCommitMadeSince(repo, start)).toBeNull();
  });

  it('an unresolvable baseline gets no stamp', () => {
    expect(headCommitMadeSince(repo, 'f'.repeat(40))).toBeNull();
    expect(headCommitMadeSince(repo, null)).toBeNull();
  });
});
