// Dropping the orphan locally was half the job. The server merged sha lists
// by union and kept the orphan's Commit row on the session, so the same work
// counted twice however well the CLI deduped. The rescue now records the
// (orphan → rewrite) pairs and every gitCapture carries them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testRescueCommitShas, rewrittenCommitsPayload } from '../commands/hooks.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const head = () => git('rev-parse', 'HEAD');
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rebase-pairs-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('rebase rewrite pairs', () => {
  it('are recorded by the rescue and travel on the gitCapture payload', () => {
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'mine\n'); git('add', '-A'); git('commit', '-qm', 'feat: my work');
    const original = head();
    git('checkout', '-q', 'main');
    write('other.txt', 'theirs\n'); git('add', '-A'); git('commit', '-qm', 'someone else');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    const rewritten = head();

    const state: any = { sessionCommitShas: [original, rewritten], repoPath: repo, sessionTag: 'test' };
    expect(__testRescueCommitShas(repo, state)).toEqual([rewritten]);
    expect(state.rewrittenCommits).toEqual([{ from: original, to: rewritten }]);
    expect(rewrittenCommitsPayload(state)).toEqual({ rewrittenCommits: [{ from: original, to: rewritten }] });

    // A second rescue on the same state adds nothing and loses nothing.
    __testRescueCommitShas(repo, state);
    expect(state.rewrittenCommits).toEqual([{ from: original, to: rewritten }]);
  });

  it('carries nothing when no rebase happened', () => {
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'one\n'); git('add', '-A'); git('commit', '-qm', 'feat: first');
    const only = head();
    const state: any = { sessionCommitShas: [only], repoPath: repo, sessionTag: 'test' };
    __testRescueCommitShas(repo, state);
    expect(state.rewrittenCommits ?? []).toEqual([]);
    expect(rewrittenCommitsPayload(state)).toEqual({});
  });

  it('moves the turn attestation onto the rewrite, keeping the turn\'s earliest observation', () => {
    // Session 8a06aaf6 (2026-09-09): two commits on the branch, both attested
    // to turn 3 by post-commit, squash-merged on GitHub. The rescue replaced
    // the sha list and recorded the pairs — and left `commitTurns` naming
    // the originals, so every later Stop re-badged the turn with a19a627f
    // and the card read "3 commits total +517/-29" for one squash.
    git('checkout', '-q', '-b', 'feature');
    write('a.txt', 'one\n'); git('add', '-A'); git('commit', '-qm', 'feat: first');
    const first = head();
    write('b.txt', 'two\n'); git('add', '-A'); git('commit', '-qm', 'feat: second');
    const second = head();
    // The squash: main gets ONE commit with the branch's end tree.
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'feature');
    git('commit', '-qm', 'feat: first + second (#1)');
    const squash = head();
    git('branch', '-q', '-D', 'feature');

    const state: any = {
      sessionCommitShas: [first, second], repoPath: repo, sessionTag: 'test',
      commitTurns: [
        { sha: first, turnId: 't_3', at: '2026-09-09T02:35:20.514Z', via: 'post-commit' },
        { sha: second, turnId: 't_3', at: '2026-09-09T02:37:03.635Z', via: 'post-commit' },
      ],
    };
    __testRescueCommitShas(repo, state);
    expect(state.sessionCommitShas).toEqual([squash]);
    expect(state.rewrittenCommits).toEqual([{ from: first, to: squash }, { from: second, to: squash }]);
    expect(state.commitTurns).toEqual([
      { sha: squash, turnId: 't_3', at: '2026-09-09T02:35:20.514Z', via: 'post-commit' },
    ]);
  });
});
