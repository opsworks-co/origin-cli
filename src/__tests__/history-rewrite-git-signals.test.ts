// What git actually tells hooks about each history rewrite (OR-11/A5).
//
// Origin's rewrite handling is built on these signals, so they are pinned
// against the installed git instead of assumed:
//
//   amend               post-rewrite "amend", one old→new pair
//   rebase              post-rewrite "rebase", one pair per rewritten commit
//   rebase -i squash    post-rewrite "rebase", several olds → ONE new
//   cherry-pick         NO post-rewrite. CHERRY_PICK_HEAD names the source in
//                       prepare-commit-msg; after a conflict it is already gone
//                       in post-commit. The HEAD reflog says a pick made it.
//   merge --squash      NO post-rewrite, no CHERRY_PICK_HEAD, no pairs at all
//
// Stub hooks record every call; nothing of Origin runs here.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('git rewrite signals seen by hooks', () => {
  let tmp: string;
  let repo: string;
  let log: string;
  let env: NodeJS.ProcessEnv;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const gitMay = (...args: string[]) => { try { git(...args); } catch { /* expected conflict */ } };
  const commit = (file: string, body: string, msg: string) => {
    fs.writeFileSync(path.join(repo, file), body);
    git('add', file);
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const events = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []);
  const reset = () => fs.writeFileSync(log, '');
  const firstReflogSubject = (sha: string) => git('reflog', 'show', '--format=%H %gs', 'HEAD', '--')
    .split('\n').filter((l) => l.startsWith(sha)).pop()?.slice(sha.length + 1);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-rewrite-signals-'));
    repo = path.join(tmp, 'repo');
    log = path.join(tmp, 'events.log');
    const hooks = path.join(tmp, 'hooks');
    fs.mkdirSync(repo);
    fs.mkdirSync(hooks);
    env = {
      ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    };
    for (const hook of ['prepare-commit-msg', 'post-commit', 'post-rewrite']) {
      const stdin = hook === 'post-rewrite' ? 'pairs=$(cat | tr "\\n" ";")' : 'pairs=';
      fs.writeFileSync(path.join(hooks, hook), [
        '#!/bin/sh',
        'gd=$(git rev-parse --git-dir)',
        'cph=; [ -f "$gd/CHERRY_PICK_HEAD" ] && cph=$(cat "$gd/CHERRY_PICK_HEAD")',
        stdin,
        `echo "${hook}|$1|$cph|$pairs" >> "${log}"`,
      ].join('\n') + '\n', { mode: 0o755 });
    }
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
    git('config', 'core.hooksPath', hooks);
    commit('base.txt', 'base\n', 'base');
  });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('amend: post-rewrite "amend" with exactly one old→new pair', () => {
    const before = commit('a.txt', 'a\n', 'a');
    reset();
    git('commit', '-q', '--amend', '-m', 'a, reworded');
    const after = git('rev-parse', 'HEAD');
    const rewrites = events().filter((e) => e.startsWith('post-rewrite|'));
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toBe(`post-rewrite|amend||${before} ${after};`);
  });

  it('rebase: post-rewrite "rebase" with one pair per commit, each to its own new sha', () => {
    git('checkout', '-q', '-b', 'feat');
    const c1 = commit('c1.txt', '1\n', 'c1');
    const c2 = commit('c2.txt', '2\n', 'c2');
    git('checkout', '-q', 'main');
    commit('m.txt', 'm\n', 'main moves');
    git('checkout', '-q', 'feat');
    reset();
    git('rebase', '-q', 'main');
    const rewrites = events().filter((e) => e.startsWith('post-rewrite|'));
    expect(rewrites).toHaveLength(1);
    const pairs = rewrites[0].split('|')[3].split(';').filter(Boolean).map((p) => p.split(' '));
    expect(rewrites[0].split('|')[1]).toBe('rebase');
    expect(pairs.map((p) => p[0])).toEqual([c1, c2]);
    expect(new Set(pairs.map((p) => p[1])).size).toBe(2);
    expect(pairs[1][1]).toBe(git('rev-parse', 'HEAD'));
  });

  it('rebase -i squash: the final "rebase" call maps several olds to ONE new sha', () => {
    const c1 = commit('c1.txt', '1\n', 'c1');
    const c2 = commit('c2.txt', '2\n', 'c2');
    reset();
    const editor = path.join(tmp, 'seq-editor.sh');
    fs.writeFileSync(editor, '#!/bin/sh\nsed -i.bak -e "2s/^pick/squash/" "$1"\n', { mode: 0o755 });
    execFileSync('git', ['rebase', '-q', '-i', 'HEAD~2'], {
      cwd: repo, env: { ...env, GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' }, stdio: 'ignore',
    });
    const squashed = git('rev-parse', 'HEAD');
    const rebaseCall = events().filter((e) => e.startsWith('post-rewrite|rebase|'));
    expect(rebaseCall).toHaveLength(1);
    const pairs = rebaseCall[0].split('|')[3].split(';').filter(Boolean).map((p) => p.split(' '));
    expect(pairs.map((p) => p[0]).sort()).toEqual([c1, c2].sort());
    expect(pairs.every((p) => p[1] === squashed)).toBe(true);
  });

  it('cherry-pick: no post-rewrite; CHERRY_PICK_HEAD names the source in prepare-commit-msg', () => {
    git('checkout', '-q', '-b', 'feat');
    const source = commit('c.txt', 'c\n', 'c');
    git('checkout', '-q', 'main');
    commit('m.txt', 'm\n', 'main moves');
    reset();
    git('cherry-pick', source);
    const picked = git('rev-parse', 'HEAD');
    expect(events().some((e) => e.startsWith('post-rewrite|'))).toBe(false);
    expect(events().find((e) => e.startsWith('prepare-commit-msg|'))?.split('|')[2]).toBe(source);
    expect(firstReflogSubject(picked)).toMatch(/^cherry-pick: /);
  });

  it('cherry-pick after a conflict: CHERRY_PICK_HEAD is gone by post-commit, prepare-commit-msg still saw it', () => {
    git('checkout', '-q', '-b', 'feat');
    const source = commit('shared.txt', 'theirs\n', 'change shared');
    git('checkout', '-q', 'main');
    commit('shared.txt', 'ours\n', 'main changes shared too');
    reset();
    gitMay('cherry-pick', source);
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'resolved\n');
    git('add', 'shared.txt');
    execFileSync('git', ['cherry-pick', '--continue'], { cwd: repo, env: { ...env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
    const picked = git('rev-parse', 'HEAD');
    const ev = events();
    expect(ev.some((e) => e.startsWith('post-rewrite|'))).toBe(false);
    expect(ev.find((e) => e.startsWith('prepare-commit-msg|'))?.split('|')[2]).toBe(source);
    expect(ev.find((e) => e.startsWith('post-commit|'))?.split('|')[2]).toBe('');
    expect(firstReflogSubject(picked)).toMatch(/^commit \(cherry-pick\): /);
  });

  it('multi-commit cherry-pick: each pick\'s prepare-commit-msg names its own source', () => {
    git('checkout', '-q', '-b', 'feat');
    const s1 = commit('p1.txt', '1\n', 'p1');
    const s2 = commit('p2.txt', '2\n', 'p2');
    git('checkout', '-q', 'main');
    reset();
    git('cherry-pick', s1, s2);
    const prepared = events().filter((e) => e.startsWith('prepare-commit-msg|')).map((e) => e.split('|')[2]);
    expect(prepared).toEqual([s1, s2]);
    expect(events().some((e) => e.startsWith('post-rewrite|'))).toBe(false);
  });

  it('merge --squash + commit: no post-rewrite, no CHERRY_PICK_HEAD, no pairs', () => {
    git('checkout', '-q', '-b', 'feat');
    commit('f1.txt', '1\n', 'f1');
    commit('f2.txt', '2\n', 'f2');
    git('checkout', '-q', 'main');
    reset();
    git('merge', '--squash', 'feat');
    git('commit', '-q', '-m', 'squash feat');
    const ev = events();
    expect(ev.some((e) => e.startsWith('post-rewrite|'))).toBe(false);
    expect(ev.every((e) => e.split('|')[2] === '')).toBe(true);
    expect(ev.filter((e) => e.startsWith('post-commit|'))).toHaveLength(1);
    // The squash commit has one parent; the feature commits are not its ancestors.
    expect(() => git('merge-base', '--is-ancestor', 'feat', 'HEAD')).toThrow();
  });
});
