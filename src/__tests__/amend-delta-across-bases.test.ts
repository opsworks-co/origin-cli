// A turn's "delta on the commit it amended" is only that, when the replaced
// commit and its replacement sit on different parents.
//
// Session 817f02b4 (2026-10-26): turn 10 made a deploy commit pinning
// packages/cli to the release on top of #2650 (f66e4c1f); turn 12 made the same
// deploy commit again on top of #2654 (696602e3). The patches were identical,
// the rescue paired them as a rewrite, and the amend delta was measured tree to
// tree — so turn 12, which wrote nothing, was billed everything main gained in
// between: 18 files, +154/-48, eight of them turn 11's own and ten another PR's.
//
// Driven against real git.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';

let repo = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
const commit = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-amend-across-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('pinned.txt', 'released\n'); write('app.ts', 'v1\n'); commit('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Turn 10's commit on main M1, then turn 12's replacement on a main that moved (M2). */
function replacedOnMovedBase(changeInReplacement?: () => void, baseAlsoChanges?: () => void) {
  write('pinned.txt', 'unreleased\n'); const m1 = commit('main: unreleased change');
  write('pinned.txt', 'released\n'); const original = commit('deploy: pin');
  git('checkout', '-q', '--detach', m1);
  write('app.ts', 'v2 — another PR\n'); write('feature.ts', 'turn 11\n');
  baseAlsoChanges?.();
  commit('main moves: turn 11 and another PR land');
  write('pinned.txt', 'released\n');
  changeInReplacement?.();
  const replacement = commit('deploy: pin');
  const state: any = {
    promptTurnIds: ['t_10', 't_11', 't_12'],
    commitTurns: [{ sha: replacement, turnId: 't_10' }],
    rewrittenCommits: [{ from: original, to: replacement }],
    preSquashCommitTurns: [{ sha: original, turnId: 't_10', squash: replacement, amendedBy: 't_12' }],
  };
  const row: any = { promptIndex: 2, diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0, commitSha: replacement };
  return { state, row, original, replacement };
}

describe('amend delta when the replaced commit sits on another base', () => {
  it('the same change re-made on a moved main is no delta — not everything main gained', () => {
    const { state, row } = replacedOnMovedBase();
    const reasons: string[] = [];
    preferCommitPatchForCommittedTurns(state, [row], repo, { observe: (_i: number, o: any) => { if (o?.reason) reasons.push(o.reason); } } as any);
    expect(row.filesChanged).toEqual([]);
    expect([row.linesAdded, row.linesRemoved]).toEqual([0, 0]);
    expect(row.diff || '').not.toContain('feature.ts');
    expect(row.diff || '').not.toContain('app.ts');
  });

  it('a real change the replacement adds still counts, and only that', () => {
    const { state, row } = replacedOnMovedBase(() => write('pinned.txt', 'released\nwith a note\n'));
    preferCommitPatchForCommittedTurns(state, [row], repo);
    expect(row.filesChanged).toEqual(['pinned.txt']);
    expect([row.linesAdded, row.linesRemoved]).toEqual([1, 0]);
  });

  it('declines when the base itself changed a file the two commits change differently', () => {
    const { state, row } = replacedOnMovedBase(
      () => write('pinned.txt', 'released\nwith a note\n'),
      () => write('pinned.txt', 'unreleased, moved again\n'),
    );
    const before = JSON.stringify(row);
    preferCommitPatchForCommittedTurns(state, [row], repo);
    // The row keeps what the turn's own capture held — nothing measured across the base.
    expect(row.filesChanged).toEqual(JSON.parse(before).filesChanged);
    expect(row.diff || '').not.toContain('feature.ts');
  });
});
