/**
 * One PR, five rewrites, one survivor — the chain session 8a06aaf6 took on
 * 2026-09-09, replayed through a REAL post-rewrite hook.
 *
 *   A  wip commit on the branch
 *   B  rebase onto a moved main, conflict resolved, subject changed
 *   C  amend that adds a file
 *   D  amend that removes it again
 *   E  rebase onto a moved main, conflict resolved (content differs, subject same)
 *   F  GitHub's squash merge on main
 *
 * The rescue's content rungs cannot see A → B (nothing matches) or D → E
 * (the rewrite is no longer reachable by the time a Stop runs), so the
 * session kept d5b79583 and 951b0349 beside the squash: six commit rows on
 * one turn, a header of +1005 across 19 files for +257 across 7.
 *
 * git states every one of the local hops in the post-rewrite hook. Feed the
 * session what git says, let the rescue find the squash, and every reading
 * lands on F.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testRescueCommitShas } from '../commands/hooks.js';
import { recordGitRewrites } from '../commands/hooks/post-rewrite.js';
import { parseRewriteInput } from '../history-preservation.js';
import { finalRewriteOf, loadSessionState, saveSessionState } from '../session-state.js';

const TAG = 'chain-test';
const TURN = 't_3629';

describe('a rebase → amend → amend → rebase → squash chain folds to the squash', () => {
  let root = '';
  let repo = '';
  let hookLog = '';
  let env: NodeJS.ProcessEnv;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const head = () => git('rev-parse', 'HEAD');
  const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
  /** What git told the post-rewrite hook since the last call. */
  const drainHook = () => {
    const raw = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf-8') : '';
    fs.writeFileSync(hookLog, '');
    return parseRewriteInput(raw);
  };
  const state = () => loadSessionState(repo, TAG)!;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rewrite-chain-')));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks);
    hookLog = path.join(root, 'post-rewrite.log');
    // A real post-rewrite hook, capturing exactly what git hands Origin's.
    fs.writeFileSync(path.join(hooks, 'post-rewrite'), `#!/bin/sh\ncat >> "${hookLog}"\n`);
    fs.chmodSync(path.join(hooks, 'post-rewrite'), 0o755);
    // Never the user's global hooks (~/.origin/git-hooks would fire the real CLI).
    env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_EDITOR: 'true' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
    git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', hooks);
    write('f1.txt', 'base 1\n'); write('f2.txt', 'base 2\n');
    git('add', '-A'); git('commit', '-qm', 'base');
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('every hop is recorded and every reading lands on F', () => {
    const P0 = head();
    // A — the session's commit, recorded by post-commit.
    git('checkout', '-q', '-b', 'feature');
    write('f1.txt', 'base 1\nmine\n'); write('f2.txt', 'base 2\nmine\n');
    git('add', '-A'); git('commit', '-qm', 'wip: re-attach by conversation');
    const A = head();
    saveSessionState({
      sessionId: 'sess-chain', sessionTag: TAG, claudeSessionId: 'conv-chain', agentSlug: 'claude-code',
      status: 'RUNNING', startedAt: new Date(Date.now() - 60_000).toISOString(),
      repoPath: repo, lastCwd: repo, headShaAtStart: P0, prompts: ['work'],
      sessionCommitShas: [A],
      commitTurns: [{ sha: A, turnId: TURN, at: '2026-09-09T16:00:00.000Z', via: 'post-commit' }],
    } as any, repo, TAG);

    // main moves, touching f1 → the rebase conflicts.
    git('checkout', '-q', 'main');
    write('f1.txt', 'base 1\ntheirs\n'); git('add', '-A'); git('commit', '-qm', 'someone: f1');
    const M1 = head();
    // B — rebase, resolve, and change the subject while at it.
    git('checkout', '-q', 'feature');
    try { git('rebase', 'main'); } catch { /* conflict expected */ }
    write('f1.txt', 'base 1\ntheirs\nmine\n'); git('add', 'f1.txt');
    execFileSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    git('commit', '--amend', '-qm', 'fix(capture): a re-attach finds its prior state');
    const B = head();
    expect(git('rev-parse', 'HEAD^')).toBe(M1);
    let r = recordGitRewrites(repo, drainHook());
    expect(r.sessions).toBe(1);
    expect(state().sessionCommitShas).toEqual([B]);

    // C — amend adds a file; D — amend removes it. Distinct committer dates,
    // or D reproduces B byte-for-byte (same second, same content) and the
    // chain has a cycle instead of a hop — a case the pair rule handles, but
    // not the shape this test is about.
    write('node_modules', 'oops symlink\n'); git('add', '-A');
    execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], { cwd: repo, env: { ...env, GIT_COMMITTER_DATE: '2026-09-09T16:10:00Z' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const C = head();
    r = recordGitRewrites(repo, drainHook());
    expect(r.pairs).toBeGreaterThanOrEqual(1);
    git('rm', '-q', '--cached', 'node_modules'); fs.unlinkSync(path.join(repo, 'node_modules'));
    execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], { cwd: repo, env: { ...env, GIT_COMMITTER_DATE: '2026-09-09T16:11:00Z' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const D = head();
    expect(D).not.toBe(B);
    r = recordGitRewrites(repo, drainHook());
    expect(state().sessionCommitShas).toEqual([D]);

    // main moves again, touching f2 → the second rebase conflicts; E keeps the subject.
    git('checkout', '-q', 'main');
    write('f2.txt', 'base 2\ntheirs\n'); git('add', '-A'); git('commit', '-qm', 'someone: f2');
    const M2 = head();
    git('checkout', '-q', 'feature');
    try { git('rebase', 'main'); } catch { /* conflict expected */ }
    write('f2.txt', 'base 2\ntheirs\nmine\n'); git('add', 'f2.txt');
    execFileSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const E = head();
    expect(git('rev-parse', 'HEAD^')).toBe(M2);
    r = recordGitRewrites(repo, drainHook());
    expect(state().sessionCommitShas).toEqual([E]);

    // F — the squash merge, as GitHub would make it: one commit on main, E's tree.
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'feature');
    git('commit', '-qm', 'fix(capture): a re-attach finds its prior state (#1512)');
    const F = head();
    git('branch', '-q', '-D', 'feature');
    expect(git('rev-parse', `${F}^{tree}`)).toBe(git('rev-parse', `${E}^{tree}`));

    // The Stop's rescue sees E orphaned and F reachable with E's tree.
    const s = state();
    expect(__testRescueCommitShas(repo, s)).toEqual([F]);

    // Every hop git reported plus the squash the rescue found. A → B is two
    // pairs (the rebase, then the subject amend), so count hops by resolving.
    const pairs = s.rewrittenCommits || [];
    expect(pairs.length).toBeGreaterThanOrEqual(5);
    expect(pairs).toContainEqual({ from: E, to: F });
    for (const hop of [A, B, C, D, E]) {
      expect(finalRewriteOf(hop, pairs), `${hop.slice(0, 8)} resolves to F`).toBe(F);
    }
    expect(s.sessionCommitShas).toEqual([F]);
    expect(s.commitTurns).toEqual([{ sha: F, turnId: TURN, at: '2026-09-09T16:00:00.000Z', via: 'post-commit' }]);
  });

  it('a pair for a sha the session never owned is not recorded', () => {
    git('checkout', '-q', '-b', 'feature');
    write('f1.txt', 'x\n'); git('add', '-A'); git('commit', '-qm', 'not ours');
    saveSessionState({
      sessionId: 'sess-other', sessionTag: TAG, claudeSessionId: 'conv-other', agentSlug: 'claude-code',
      status: 'RUNNING', startedAt: new Date().toISOString(), repoPath: repo, lastCwd: repo, prompts: ['x'],
      sessionCommitShas: ['f'.repeat(40)],
    } as any, repo, TAG);
    git('commit', '-q', '--amend', '-m', 'still not ours');
    const r = recordGitRewrites(repo, drainHook());
    expect(r).toEqual({ sessions: 0, pairs: 0 });
    expect(state().rewrittenCommits ?? []).toEqual([]);
  });
});
