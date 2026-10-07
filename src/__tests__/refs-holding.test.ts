// One rev-list must answer "does some ref still hold this commit?" exactly as
// `for-each-ref --contains` does per commit — that query was 15.6 s of a 46 s
// commit-patch pass on a 20-turn session (TODO 1cd8f80e).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitsHeldByRefs } from '../refs-holding.js';

let repo = '';
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
const commit = (file: string, text: string) => { fs.writeFileSync(path.join(repo, file), text); git('add', '-A'); git('commit', '-qm', file); return git('rev-parse', 'HEAD'); };
const SHADOW = /(^|\/)shadow(\/|$)/;
const perCommit = (sha: string, ns: string[], exclude: RegExp) =>
  git('for-each-ref', '--contains', sha, '--format=%(refname)', ...ns).split('\n').some((r) => !!r.trim() && !exclude.test(r));

let onMain = '', onKept = '', onDeleted = '', onShadowOnly = '', onTagOnly = '';
beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-refs-held-')));
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@x');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  onMain = commit('a.txt', 'a\n');
  git('checkout', '-qb', 'kept'); onKept = commit('b.txt', 'b\n');
  git('checkout', '-q', 'main'); git('checkout', '-qb', 'gone'); onDeleted = commit('c.txt', 'c\n');
  git('checkout', '-q', 'main'); git('branch', '-qD', 'gone');
  git('checkout', '-qb', 'tmp'); onShadowOnly = commit('d.txt', 'd\n');
  git('update-ref', 'refs/heads/origin/shadow/s1', onShadowOnly);
  git('checkout', '-q', 'main'); git('branch', '-qD', 'tmp');
  git('checkout', '-qb', 'tmp2'); onTagOnly = commit('e.txt', 'e\n'); git('tag', 'v1');
  git('checkout', '-q', 'main'); git('branch', '-qD', 'tmp2');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('commitsHeldByRefs', () => {
  it('agrees with for-each-ref --contains, commit by commit, and ignores excluded refs', () => {
    const all = [onMain, onKept, onDeleted, onShadowOnly, onTagOnly];
    const held = commitsHeldByRefs(repo, all, { namespaces: ['refs/heads', 'refs/remotes'], excludeRef: (r) => SHADOW.test(r) })!;
    for (const sha of all) expect(held.get(sha), sha).toBe(perCommit(sha, ['refs/heads', 'refs/remotes'], SHADOW));
    expect([...held.entries()].filter(([, h]) => h).map(([s]) => s).sort()).toEqual([onMain, onKept].sort());
  });

  it('counts the namespaces it is given — a tag holds its commit when tags count', () => {
    const held = commitsHeldByRefs(repo, [onTagOnly, onDeleted], { namespaces: ['refs/heads', 'refs/tags'] })!;
    expect(held.get(onTagOnly)).toBe(true);
    expect(held.get(onDeleted)).toBe(false);
  });

  it('answers a short id under the id it was asked by', () => {
    const held = commitsHeldByRefs(repo, [onKept.slice(0, 10)], { namespaces: ['refs/heads'] })!;
    expect(held.get(onKept.slice(0, 10))).toBe(true);
  });

  it('leaves out a commit git does not have instead of failing the batch', () => {
    const missing = 'f'.repeat(40);
    const held = commitsHeldByRefs(repo, [missing, onMain], { namespaces: ['refs/heads'] })!;
    expect(held.has(missing)).toBe(false);
    expect(held.get(onMain)).toBe(true);
  });

  it('is null — unknown — outside a repository', () => {
    expect(commitsHeldByRefs(os.tmpdir(), [onMain], { namespaces: ['refs/heads'] })).toBeNull();
  });
});
