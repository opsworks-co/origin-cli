/**
 * A turn that committed on several branches is sent as the union of each
 * branch's own patch, not one range off whichever branch HEAD is on.
 *
 * Session 049d69db row 15 opened four PR branches from the same main commit
 * and committed on each. Each Stop found one of them reachable and sent that
 * one; once the tree moved on, none was reachable and the row fell back to a
 * fence-cut ledger — "+9 -1, 2 files" beside "4 commits total +866/-179".
 *
 * Driven against real git: the rule turns on ancestry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns, pathsInDiff } from '../commit-patch-for-committed-turn.js';
import { createShadowCommit, commitDiffScopedToPrompt } from '../git-capture.js';
import type { TurnObservation } from '../resolve-turn.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};
const commitAll = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
const sectionsFor = (diff: string, file: string) =>
  (diff.match(new RegExp(`^diff --git a/${file.replace('.', '\\.')} b/`, 'gm')) || []).length;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-across-branches-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('a.ts', 'a1\n'); write('b.ts', 'b1\n'); write('package.json', '{"version":"1"}\n');
  commitAll('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/** One turn: two commits on fix-a, one on fix-b, both branches cut from main
 *  and both bumping package.json. Leaves HEAD on fix-b. */
function twoBranchTurn() {
  const main = git('rev-parse', 'HEAD');
  const baseline = createShadowCommit(repo, 'turn0') || main;
  git('checkout', '-qb', 'fix-a');
  write('a.ts', 'a1\na2\n'); write('package.json', '{"version":"2"}\n');
  const a1 = commitAll('fix: a');
  write('a.ts', 'a1\na2\na3\n');
  const a2 = commitAll('fix: a again');
  git('checkout', '-qb', 'fix-b', 'main');
  write('b.ts', 'b1\nb2\nb3\n'); write('package.json', '{"version":"3"}\n');
  const b1 = commitAll('fix: b');
  const state = {
    promptTurnIds: ['t_0'],
    commitTurns: [{ sha: a1, turnId: 't_0' }, { sha: a2, turnId: 't_0' }, { sha: b1, turnId: 't_0' }],
    promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
    prePromptSha: null,
  };
  // What the checkout fences left the ledger with.
  const mapping = {
    promptIndex: 0,
    filesChanged: ['b.ts'],
    diff: 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n b1\n+b3\n',
    uncommittedDiff: '',
    linesAdded: 1,
    linesRemoved: 0,
  };
  return { main, baseline, a1, a2, b1, state, mapping };
}

describe('a turn whose commits sit on several branches', () => {
  it('counts every branch, not only the one HEAD is on', () => {
    const { main, a2, b1, state, mapping } = twoBranchTurn();
    const log: Array<[string, Record<string, unknown>]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo, { log: (e, d) => log.push([e, d]) })).toBe(1);
    const branchA = commitDiffScopedToPrompt(repo, main, a2, ['a.ts', 'package.json'])!;
    const branchB = commitDiffScopedToPrompt(repo, main, b1, ['b.ts', 'package.json'])!;
    expect(mapping.diff).toContain(branchA.diff.trim());
    expect(mapping.diff).toContain(branchB.diff.trim());
    // a.ts +2, package.json +1/-1 on fix-a; b.ts +2, package.json +1/-1 on fix-b.
    // One range off fix-b read +3/-1 and had no a.ts line at all.
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([6, 2]);
    expect([...(mapping.filesChanged as string[])].sort()).toEqual(['a.ts', 'b.ts', 'package.json']);
    expect(pathsInDiff(mapping.diff).sort()).toEqual(['a.ts', 'b.ts', 'package.json']);
    // Two commits on one branch are one range: a.ts is one section.
    expect(sectionsFor(mapping.diff, 'a.ts')).toBe(1);
    // Both bumps are the turn's: one section per branch.
    expect(sectionsFor(mapping.diff, 'package.json')).toBe(2);
    expect(mapping.uncommittedDiff).toBe('');
    expect((mapping as { contentUnavailableFiles?: string[] }).contentUnavailableFiles).toEqual([]);
    expect(log.find(([e]) => e === 'ledger diff replaced by the commit patches of several branches')?.[1])
      .toMatchObject({ branches: 2, stranded: 1 });
  });

  it('still sends the turn once the tree has moved off every branch', () => {
    const { state, mapping } = twoBranchTurn();
    git('checkout', '-q', 'main');
    // A child listed before its parent must join the parent's branch.
    state.commitTurns = [state.commitTurns[1], state.commitTurns[2], state.commitTurns[0]];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([6, 2]);
    expect(sectionsFor(mapping.diff!, 'a.ts')).toBe(1);
  });

  it('fills the row Stop rebuilt as empty from a tree on neither branch', () => {
    // Through the built binary: HEAD on main, a clean tree, and every pass
    // before this one leaves the turn with no diff. Stop then sent f:0 over
    // post-commit's +4 and +5.
    const { state, mapping } = twoBranchTurn();
    git('checkout', '-q', 'main');
    Object.assign(mapping, { filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 });
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([6, 2]);
    expect([...(mapping.filesChanged as string[])].sort()).toEqual(['a.ts', 'b.ts', 'package.json']);
  });

  it('an empty row whose commits HEAD holds stays empty', () => {
    const { a1, a2, state, mapping } = twoBranchTurn();
    git('checkout', '-q', 'fix-a');
    state.commitTurns = [{ sha: a1, turnId: 't_0' }, { sha: a2, turnId: 't_0' }];
    Object.assign(mapping, { filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 });
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(0);
    expect(mapping.diff).toBe('');
  });

  it('reports the content it applied to the resolver', () => {
    const { state, mapping } = twoBranchTurn();
    const seen: Array<[number, TurnObservation]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo, { observe: (i, o) => seen.push([i, o]) })).toBe(1);
    expect(seen).toEqual([[0, {
      source: 'commit-patch', outcome: 'applied',
      files: [...(mapping.filesChanged as string[])], diff: mapping.diff, added: 6, removed: 2, contentUnavailable: [],
    }]]);
  });

  it('reports why it declined to the resolver', () => {
    const { state, mapping } = twoBranchTurn();
    write('b.ts', 'b1\nb2\nb3\nstill typing\n');
    const seen: TurnObservation[] = [];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo, { observe: (_i, o) => seen.push(o) })).toBe(0);
    expect(seen).toEqual([{ source: 'commit-patch', outcome: 'declined', reason: 'a file of the turn is dirty against its commit' }]);
  });

  it('an uncommitted edit to a file of the turn still keeps the ledger', () => {
    const { state, mapping } = twoBranchTurn();
    write('b.ts', 'b1\nb2\nb3\nstill typing\n');
    const before = { ...mapping };
    const log: string[] = [];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo, { log: (e) => log.push(e) })).toBe(0);
    expect(mapping).toEqual(before);
    expect(log).toContain('commit patch declined: a file of the turn is dirty against its commit');
  });

  it('a turn on one branch keeps the one range from its shadow', () => {
    const { baseline, a1, a2, state, mapping } = twoBranchTurn();
    git('checkout', '-q', 'fix-a');
    state.commitTurns = [{ sha: a1, turnId: 't_0' }, { sha: a2, turnId: 't_0' }];
    mapping.filesChanged = ['a.ts'];
    const log: string[] = [];
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo, { log: (e) => log.push(e) })).toBe(1);
    expect(mapping.diff).toBe(commitDiffScopedToPrompt(repo, baseline, a2, ['a.ts', 'package.json'])!.diff);
    expect(log).toContain('ledger diff replaced by the commit patch');
    expect(log).not.toContain('ledger diff replaced by the commit patches of several branches');
  });
});
