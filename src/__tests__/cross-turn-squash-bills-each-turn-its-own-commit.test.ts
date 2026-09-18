/**
 * A squash that folds SEVERAL turns' commits is no one turn's commit.
 *
 * Session c98599c8 (2026-09-18): turn 12 committed a11fa47b on a PR branch
 * (+290/-6). Turn 14 added two review fixes and a version bump to the same
 * branch. GitHub squash-merged all four as d1454ba0 (+416/-12) and the branch
 * was deleted. The rescue recorded four pairs onto the one survivor, and
 * `commitTurns` folded every attestation onto it "keeping the earliest" — so
 * turn 12 owned the squash, turn 14 owned nothing of that branch, and every
 * Stop afterwards re-sent turn 12 as `9 files +414/-10`: the squash, fixups it
 * never wrote included. The dashboard showed +414 beside a +292 commit.
 *
 * The fold stays as it was — the server and every owner lookup read survivors.
 * What each turn made is recorded beside it, and the turn is measured from
 * that commit's own objects — which `git` still has whether or not a branch holds them.
 *
 * Driven against real git: the rule turns on ancestry, parents and trees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns, pathsInDiff } from '../commit-patch-for-committed-turn.js';
import { applyRewritePairsToState, type SessionState } from '../session-state.js';
import { createShadowCommit } from '../git-capture.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};
const commitAll = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
const row = (promptIndex: number) => ({
  promptIndex, filesChanged: [] as string[], diff: '', uncommittedDiff: '', linesAdded: 0, linesRemoved: 0, commitSha: null as string | null,
});

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cross-turn-squash-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('hook.ts', 'one\ntwo\nthree\n'); write('handler.ts', 'h1\n'); write('other.ts', 'o1\n');
  commitAll('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/**
 * Turn 0 commits the fix on a PR branch; turn 1 adds a review fix that REWRITES
 * a line turn 0 added and touches a second file; the PR is squash-merged onto
 * main and the branch deleted. Leaves HEAD on main, at the squash.
 */
function twoTurnsOneSquash() {
  git('checkout', '-qb', 'fix/pr');
  const shadow0 = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
  write('hook.ts', 'one\ntwo\nthree\nturn zero A\nturn zero B\n');
  const fix = commitAll('fix: the hook reads stdin');
  const shadow1 = createShadowCommit(repo, 'turn1') || fix;
  write('hook.ts', 'one\ntwo\nthree\nturn zero A\nreview rewrote B\n');
  write('handler.ts', 'h1\nreview added\n');
  const review = commitAll('fix: review fixes');

  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'fix/pr');
  const squash = commitAll('fix: the hook delivers the pairs (#7)');
  git('branch', '-qD', 'fix/pr');

  const state = {
    promptTurnIds: ['t_0', 't_1'],
    sessionCommitShas: [fix, review],
    commitTurns: [
      { sha: fix, turnId: 't_0', at: '2026-09-18T12:56:23.000Z', via: 'post-commit' as const },
      { sha: review, turnId: 't_1', at: '2026-09-18T13:36:24.000Z', via: 'post-commit' as const },
    ],
    promptShadows: [{ promptIndex: 0, shadowSha: shadow0 }, { promptIndex: 1, shadowSha: shadow1 }],
    prePromptSha: null as string | null,
    rewrittenCommits: [] as Array<{ from: string; to: string }>,
    preSquashCommitTurns: undefined as SessionState['preSquashCommitTurns'],
  };
  // What the rescue's squash rung records: every member of the run → the squash.
  applyRewritePairsToState(state, [{ from: fix, to: squash }, { from: review, to: squash }]);
  return { fix, review, squash, state };
}

describe('a squash across turns', () => {
  it('keeps what each turn made beside the fold; the fold itself is unchanged', () => {
    const { fix, review, squash, state } = twoTurnsOneSquash();
    // Every other reader — the server's badge, the owner lookups — still sees
    // survivors, the earliest turn per survivor, exactly as before.
    expect(state.commitTurns.map((c) => [c.sha, c.turnId])).toEqual([[squash, 't_0']]);
    expect(state.sessionCommitShas).toEqual([squash]);
    expect(state.preSquashCommitTurns?.map((c) => [c.sha, c.turnId, c.squash])).toEqual([
      [fix, 't_0', squash], [review, 't_1', squash],
    ]);
  });

  it('survives a later fold — the state no longer holds the originals by then', () => {
    const { fix, review, squash, state } = twoTurnsOneSquash();
    applyRewritePairsToState(state, [{ from: 'a'.repeat(40), to: 'b'.repeat(40) }]);
    expect(state.preSquashCommitTurns?.map((c) => c.sha)).toEqual([fix, review]);
    expect(state.commitTurns.map((c) => c.sha)).toEqual([squash]);
  });

  it('THE BUG: the first turn is sent its own commit, not the squash', () => {
    const { state } = twoTurnsOneSquash();
    const rows = [row(0), row(1)];
    preferCommitPatchForCommittedTurns(state, rows, repo);

    expect(rows[0].linesAdded).toBe(2);
    expect(rows[0].linesRemoved).toBe(0);
    expect(pathsInDiff(rows[0].diff)).toEqual(['hook.ts']);
    expect(rows[0].diff).toContain('+turn zero B');
    expect(rows[0].diff).not.toContain('review');
  });

  it('stamps both rows with the squash — a pre-squash sha is superseded on the server', () => {
    const { squash, state } = twoTurnsOneSquash();
    const rows = [row(0), row(1)];
    preferCommitPatchForCommittedTurns(state, rows, repo);
    expect(rows.map((r) => r.commitSha)).toEqual([squash, squash]);
  });

  it('…and the later turn is sent its fixups, measured from the commit it built on', () => {
    const { state } = twoTurnsOneSquash();
    const rows = [row(0), row(1)];
    preferCommitPatchForCommittedTurns(state, rows, repo);

    expect(pathsInDiff(rows[1].diff).sort()).toEqual(['handler.ts', 'hook.ts']);
    expect(rows[1].linesAdded).toBe(2);
    expect(rows[1].linesRemoved).toBe(1);
    expect(rows[1].diff).toContain('+review rewrote B');
  });

  it('the two turns together are the branch, counted once — not the squash twice', () => {
    const { state } = twoTurnsOneSquash();
    const rows = [row(0), row(1)];
    preferCommitPatchForCommittedTurns(state, rows, repo);
    // Squash: hook.ts +2, handler.ts +1. The turns: +2, then +2/-1 (one line rewritten).
    expect(rows[0].linesAdded + rows[1].linesAdded - rows[1].linesRemoved).toBe(3);
  });
});

// ── What an independent review of the first version broke ───────────────────
describe('the shapes review found', () => {
  it('a shared squash REBASED afterwards (S → S\') is still the shared squash', () => {
    // Local squash of two turns' commits, then `git rebase main` onto a moved
    // main. `commitTurns` ends on S'. Left out of the shared set, turn 0 owned
    // S' AND its own commit and was sent +5 for +2 of work.
    git('checkout', '-qb', 'fix/pr');
    const shadow0 = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
    write('hook.ts', 'one\ntwo\nthree\nturn zero A\nturn zero B\n');
    const a = commitAll('fix: a');
    const shadow1 = createShadowCommit(repo, 'turn1') || a;
    write('handler.ts', 'h1\nturn one\n');
    const b = commitAll('fix: b');
    git('reset', '-q', '--soft', 'main');
    const squash = commitAll('fix: a and b');
    git('checkout', '-q', 'main');
    write('other.ts', 'o1\nmain moved\n');
    commitAll('main moved');
    git('checkout', '-q', 'fix/pr');
    git('rebase', '-q', 'main');
    const rebased = git('rev-parse', 'HEAD');

    const state = {
      promptTurnIds: ['t_0', 't_1'],
      sessionCommitShas: [a, b],
      commitTurns: [
        { sha: a, turnId: 't_0', at: '2026-09-18T12:00:00.000Z', via: 'post-commit' as const },
        { sha: b, turnId: 't_1', at: '2026-09-18T13:00:00.000Z', via: 'post-commit' as const },
      ],
      promptShadows: [{ promptIndex: 0, shadowSha: shadow0 }, { promptIndex: 1, shadowSha: shadow1 }],
      prePromptSha: null as string | null,
      rewrittenCommits: [] as Array<{ from: string; to: string }>,
      preSquashCommitTurns: undefined as SessionState['preSquashCommitTurns'],
    };
    applyRewritePairsToState(state, [{ from: a, to: squash }, { from: b, to: squash }]);
    applyRewritePairsToState(state, [{ from: squash, to: rebased }]);
    expect(state.commitTurns.map((c) => c.sha)).toEqual([rebased]);

    const rows = [row(0), row(1)];
    preferCommitPatchForCommittedTurns(state, rows, repo);
    expect([rows[0].linesAdded, rows[0].linesRemoved]).toEqual([2, 0]);
    expect(pathsInDiff(rows[0].diff)).toEqual(['hook.ts']);
    expect([rows[1].linesAdded, rows[1].linesRemoved]).toEqual([1, 0]);
    expect(rows.map((r) => r.commitSha)).toEqual([rebased, rebased]);
  });

  it('a shared squash squashed AGAIN does not become a commit its first turn "made"', () => {
    // a (turn 0) + b (turn 1) squashed locally to S; turn 2 commits c on S;
    // GitHub squashes S + c as G. The attestation standing on S is the fold's.
    const { fix, review, squash, state } = twoTurnsOneSquash();
    git('checkout', '-qb', 'fix/again', squash);
    const shadow2 = createShadowCommit(repo, 'turn2') || squash;
    write('other.ts', 'o1\nturn two\n');
    const c = commitAll('fix: c');
    git('checkout', '-q', 'main');
    git('reset', '-q', '--hard', `${squash}^`);
    git('merge', '-q', '--squash', 'fix/again');
    const again = commitAll('fix: everything (#9)');
    git('branch', '-qD', 'fix/again');

    state.promptTurnIds.push('t_2');
    state.promptShadows.push({ promptIndex: 2, shadowSha: shadow2 });
    state.commitTurns.push({ sha: c, turnId: 't_2', at: '2026-09-18T15:00:00.000Z', via: 'post-commit' as const });
    applyRewritePairsToState(state, [{ from: squash, to: again }, { from: c, to: again }]);

    expect(state.preSquashCommitTurns?.map((x) => [x.sha, x.turnId])).toEqual([[fix, 't_0'], [review, 't_1'], [c, 't_2']]);
    const rows = [row(0), row(1), row(2)];
    preferCommitPatchForCommittedTurns(state, rows, repo);
    expect(rows.map((r) => [r.linesAdded, r.linesRemoved])).toEqual([[2, 0], [2, 1], [1, 0]]);
    expect(rows.map((r) => r.commitSha)).toEqual([again, again, again]);
  });

  it('a pre-squash commit that descends from a REACHABLE commit of the same turn is not dropped', () => {
    // Turn 0 commits r0 on main, cuts a PR branch from it and commits a; turn 1
    // adds b; the branch is squashed. r0 and a are one ancestry chain — it
    // stood as `reachable`, the single range ended at r0, and a's work vanished.
    const shadow0 = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
    write('other.ts', 'o1\nr0\n');
    const r0 = commitAll('chore: r0');
    git('checkout', '-qb', 'fix/pr');
    write('hook.ts', 'one\ntwo\nthree\nturn zero A\n');
    const a = commitAll('fix: a');
    const shadow1 = createShadowCommit(repo, 'turn1') || a;
    write('handler.ts', 'h1\nturn one\n');
    const b = commitAll('fix: b');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'fix/pr');
    const squash = commitAll('fix: the pr (#10)');
    git('branch', '-qD', 'fix/pr');

    const state = {
      promptTurnIds: ['t_0', 't_1'],
      sessionCommitShas: [r0, a, b],
      commitTurns: [
        { sha: r0, turnId: 't_0', at: '2026-09-18T11:59:00.000Z', via: 'post-commit' as const },
        { sha: a, turnId: 't_0', at: '2026-09-18T12:00:00.000Z', via: 'post-commit' as const },
        { sha: b, turnId: 't_1', at: '2026-09-18T13:00:00.000Z', via: 'post-commit' as const },
      ],
      promptShadows: [{ promptIndex: 0, shadowSha: shadow0 }, { promptIndex: 1, shadowSha: shadow1 }],
      prePromptSha: null as string | null,
      rewrittenCommits: [] as Array<{ from: string; to: string }>,
      preSquashCommitTurns: undefined as SessionState['preSquashCommitTurns'],
    };
    applyRewritePairsToState(state, [{ from: a, to: squash }, { from: b, to: squash }]);

    const rows = [row(0), row(1)];
    preferCommitPatchForCommittedTurns(state, rows, repo);
    expect(pathsInDiff(rows[0].diff).sort()).toEqual(['hook.ts', 'other.ts']);
    expect([rows[0].linesAdded, rows[0].linesRemoved]).toEqual([2, 0]);
    expect([rows[1].linesAdded, rows[1].linesRemoved]).toEqual([1, 0]);
  });

  it('matches a short attested sha against the full shas in the pairs', () => {
    const { fix, squash, state } = twoTurnsOneSquash();
    state.preSquashCommitTurns = state.preSquashCommitTurns!.map((c) => (c.sha === fix ? { ...c, sha: fix.slice(0, 10) } : c));
    const rows = [row(0), row(1)];
    preferCommitPatchForCommittedTurns(state, rows, repo);
    expect([rows[0].linesAdded, rows[0].linesRemoved]).toEqual([2, 0]);
    expect(rows[0].commitSha).toBe(squash);
  });
});

describe('a squash of ONE turn\'s commits is unchanged', () => {
  it('still folds onto the survivor and is measured against it', () => {
    git('checkout', '-qb', 'fix/solo');
    const shadow = createShadowCommit(repo, 'solo') || git('rev-parse', 'HEAD');
    write('hook.ts', 'one\ntwo\nthree\nsolo A\n');
    const a = commitAll('fix: solo');
    write('other.ts', 'o1\nbump\n');
    const b = commitAll('chore: bump');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'fix/solo');
    const squash = commitAll('fix: solo (#8)');
    git('branch', '-qD', 'fix/solo');

    const state = {
      promptTurnIds: ['t_0'],
      sessionCommitShas: [a, b],
      commitTurns: [
        { sha: a, turnId: 't_0', at: '2026-09-18T12:00:00.000Z', via: 'post-commit' as const },
        { sha: b, turnId: 't_0', at: '2026-09-18T12:01:00.000Z', via: 'post-commit' as const },
      ],
      promptShadows: [{ promptIndex: 0, shadowSha: shadow }],
      prePromptSha: null as string | null,
      rewrittenCommits: [] as Array<{ from: string; to: string }>,
      preSquashCommitTurns: undefined as SessionState['preSquashCommitTurns'],
    };
    applyRewritePairsToState(state, [{ from: a, to: squash }, { from: b, to: squash }]);

    expect(state.preSquashCommitTurns).toBeUndefined();
    expect(state.commitTurns.map((c) => c.sha)).toEqual([squash]);
    const rows = [row(0)];
    preferCommitPatchForCommittedTurns(state, rows, repo);
    expect(rows[0].linesAdded).toBe(2);
    expect(pathsInDiff(rows[0].diff).sort()).toEqual(['hook.ts', 'other.ts']);
  });
});
