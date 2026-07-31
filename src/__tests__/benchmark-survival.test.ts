// Correctness test for code-survival, driven against a real temp git repo so
// the blame math is validated end-to-end (not mocked). A session's authored
// lines that survive unmodified at HEAD count; lines reworked or deleted do
// not; and a session whose commits were squashed away is reported UNKNOWN
// (resolvable:false), never as 0% survival.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeSessionSurvival, anyShaReachable } from '../benchmark-survival.js';

describe('computeSessionSurvival', () => {
  let dir: string;
  const g = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  const commit = (msg: string) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', msg], { cwd: dir, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-surv-')));
    g('init', '-q', '-b', 'main');
    g('config', 'commit.gpgsign', 'false');
    g('config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('counts only the authored lines still blamed to the session at HEAD', () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'line1\nline2\nline3\nline4\nline5\n');
    g('add', '.'); commit('A: session adds 5 lines');
    const shaA = g('rev-parse', 'HEAD');

    // A later (non-session) commit edits line3, deletes line5, adds line6.
    fs.writeFileSync(path.join(dir, 'f.txt'), 'line1\nline2\nline3-edited\nline4\nline6\n');
    g('add', '.'); commit('B: rework line3, drop line5, add line6');

    const res = computeSessionSurvival(dir, [shaA], ['f.txt']);
    expect(res.resolvable).toBe(true);
    expect(res.linesSurviving).toBe(3); // line1, line2, line4 still blamed to A
    expect(res.filesBlamed).toBe(1);
  });

  it('reports 100% survival when nothing changed', () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\n');
    g('add', '.'); commit('A');
    const shaA = g('rev-parse', 'HEAD');
    const res = computeSessionSurvival(dir, [shaA], ['f.txt']);
    expect(res.linesSurviving).toBe(3);
    expect(res.resolvable).toBe(true);
  });

  it('marks UNKNOWN (resolvable:false) when the session shas are not in history', () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\n');
    g('add', '.'); commit('base');
    // A fabricated sha that is not an ancestor of HEAD (squash/rebase case).
    const fakeSha = 'a'.repeat(40);
    const res = computeSessionSurvival(dir, [fakeSha], ['f.txt']);
    expect(res.resolvable).toBe(false);
    expect(res.linesSurviving).toBe(0);
  });

  it('skips files that no longer exist at HEAD without crashing', () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\ny\n');
    g('add', '.'); commit('A');
    const shaA = g('rev-parse', 'HEAD');
    const res = computeSessionSurvival(dir, [shaA], ['f.txt', 'gone.txt']);
    expect(res.linesSurviving).toBe(2);
    expect(res.filesBlamed).toBe(1); // gone.txt skipped
  });

  it('anyShaReachable is false for an unrelated side-branch commit', () => {
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
    g('add', '.'); commit('main1');
    g('checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(dir, 's.txt'), 'side\n');
    g('add', '.'); commit('side1');
    const sideSha = g('rev-parse', 'HEAD');
    g('checkout', '-q', 'main');
    expect(anyShaReachable(dir, [sideSha])).toBe(false);
  });
});

import { deriveRepoFullName } from '../commands/benchmark.js';

describe('deriveRepoFullName', () => {
  it('parses https and ssh remotes to owner/name', () => {
    expect(deriveRepoFullName('https://github.com/opsworks-co/origin.git')).toBe('opsworks-co/origin');
    expect(deriveRepoFullName('git@github.com:opsworks-co/origin.git')).toBe('opsworks-co/origin');
    expect(deriveRepoFullName('https://gitlab.com/group/proj')).toBe('group/proj');
  });
  it('returns null for a non owner/name url', () => {
    expect(deriveRepoFullName('not-a-url')).toBeNull();
  });
});
