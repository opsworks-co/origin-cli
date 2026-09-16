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
import { codexNativeCommits, nativeCommitOwners } from '../codex-native-commits.js';
import { pathToFileURL } from 'url';

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
  it('attests ordinary command lists but rejects pipelines, quoted commands and substitutions', () => {
    const { a1 } = twoBranchTurn();
    const read = (command: string) => codexNativeCommits([
      { type: 'turn_context', payload: { turn_id: 'native' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'fix capture' } },
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'native', item: {
        type: 'CommandExecution', cwd: pathToFileURL(repo).href,
        command: ['/bin/zsh', '-lc', command], exit_code: 0,
        stdout: `[fix-a ${a1.slice(0, 9)}] fix\n`,
      } } },
    ].map(e => JSON.stringify(e)).join('\n'), repo);
    for (const command of [
      'git add a.ts; git commit -m fix',
      'git add a.ts && git commit -m fix',
      'git add a.ts\ngit commit -m fix',
      'git add a.ts; git commit -m "fix; capture && attribution"',
    ]) expect(read(command), command).toMatchObject([{ sha: a1, promptText: 'fix capture' }]);
    for (const command of [
      'echo "git add a.ts; git commit -m fix"',
      'git add a.ts | git commit -m fix',
      'git add a.ts & git commit -m fix',
      'git add a.ts || git commit -m fix',
      'git commit -m "$(cat message)"',
      'git add a.ts; cd elsewhere; git commit -m fix',
      'git commit -m "unterminated',
    ]) expect(read(command), command).toEqual([]);
  });

  it('keeps commits on the authoring row and refuses ambiguous prompt matches', () => {
    const c = { sha: 'abcdef123456', nativeTurnId: 'native', promptText: 'open PR' };
    const author = { promptIndex: 4, promptText: 'fix it', filesChanged: ['a.ts'], diff: 'authored patch' };
    const commit = { promptIndex: 5, promptText: 'open PR', filesChanged: [], diff: '' };
    const details = [{ sha: c.sha, filesChanged: ['a.ts'] }];
    expect(nativeCommitOwners([c], [author, commit], details)).toEqual([{ sha: c.sha, promptIndex: 4 }]);
    expect(nativeCommitOwners([c], [commit, { ...commit, promptIndex: 6 }], details)).toEqual([]);
    expect(nativeCommitOwners([c], [{ ...author, commitSha: c.sha }, commit], details)).toEqual([{ sha: c.sha, promptIndex: 4 }]);
    // Partial file overlap cannot transfer a commit to an unrelated prior row.
    expect(nativeCommitOwners([c], [author, commit], [{ sha: c.sha, filesChanged: ['a.ts', 'b.ts'] }]))
      .toEqual([{ sha: c.sha, promptIndex: 5 }]);
  });

  it('reduces unchanged context so every branch fits the per-turn upload limit', () => {
    const contents = Array.from({ length: 12000 }, (_, i) => `unchanged source line ${i}\n`).join('');
    write('large.ts', contents); commitAll('large baseline');
    git('checkout', '-qb', 'large-fix');
    write('large.ts', contents.replace('source line 6000', 'changed line 6000'));
    const first = commitAll('fix large file');
    git('checkout', '-qb', 'small-fix', 'main');
    write('b.ts', 'b1\nb2\n'); const second = commitAll('fix small file');
    const mapping = { promptIndex: 0, filesChanged: [] as string[], diff: '', linesAdded: 0, linesRemoved: 0 };
    const state = { promptTurnIds: ['t_0'], commitTurns: [first, second].map(sha => ({ sha, turnId: 't_0' })) };
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect(mapping.diff.length).toBeLessThanOrEqual(200000);
    expect(pathsInDiff(mapping.diff).sort()).toEqual(['b.ts', 'large.ts']);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([2, 1]);
    const numstat = execFileSync('git', ['apply', '--numstat'], { cwd: repo, encoding: 'utf8', input: mapping.diff });
    expect(numstat).toContain('1\t1\tlarge.ts');
    expect(numstat).toContain('1\t0\tb.ts');
  });

  it('recovers every native commit and its amend, ignoring failed, quoted and foreign commands', () => {
    const { a1, a2, b1, state, mapping } = twoBranchTurn();
    write('b.ts', 'b1\nb2\nb3\nb4\n');
    git('add', 'b.ts'); git('commit', '--amend', '--no-edit', '-q');
    const replacement = git('rev-parse', 'HEAD');
    const event = (sha: string, branch: string, command = 'git commit -m fix', overrides = {}) => ({
      type: 'event_msg', payload: { type: 'item_completed', turn_id: 'native', item: {
        type: 'CommandExecution', cwd: pathToFileURL(repo).href,
        command: ['/bin/zsh', '-lc', command], exit_code: 0,
        stdout: `[${branch} ${sha.slice(0, 9)}] fix\n`, ...overrides,
      } },
    });
    const records = [
      { type: 'turn_context', payload: { turn_id: 'native' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix and open PRs' }] } },
      event(a1, 'fix-a', 'git log -1'),
      event(a1, 'fix-a', 'git commit -m fix', { exit_code: 1 }),
      event(a1, 'fix-a', 'git commit -m fix', { cwd: pathToFileURL(os.tmpdir()).href }),
      event(a1, 'fix-a', 'printf "git commit"'),
      event(a1, 'fix-a', 'git add a.ts\ngit commit -m fix'),
      event(a2, 'fix-a'), event(b1, 'fix-b'),
      event(replacement, 'fix-b', 'git commit --amend --no-edit'),
      event(replacement, 'fix-b', 'git commit --amend --no-edit'),
    ];
    const native = codexNativeCommits(records.map(e => JSON.stringify(e)).join('\n'), repo);
    expect(native.map(c => c.sha)).toEqual([a1, a2, b1, replacement]);
    expect(native[3]).toMatchObject({ replaces: b1, nativeTurnId: 'native', promptText: 'fix and open PRs' });
    const recovered = { ...state, commitTurns: native.map(c => ({ sha: c.sha, turnId: 't_0' })),
      rewrittenCommits: native.flatMap(c => c.replaces ? [{ from: c.replaces, to: c.sha }] : []) };
    expect(preferCommitPatchForCommittedTurns(recovered, [mapping], repo)).toBe(1);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([7, 2]);
    expect(sectionsFor(mapping.diff, 'b.ts')).toBe(1);
  });

  it('counts only the replacement of an amended commit on a sibling branch', () => {
    const { b1, state, mapping } = twoBranchTurn();
    write('b.ts', 'b1\nb2\nb3\nb4\n');
    git('add', 'b.ts');
    git('commit', '--amend', '--no-edit', '-q');
    const replacement = git('rev-parse', 'HEAD');
    state.commitTurns.push({ sha: replacement, turnId: 't_0' });
    const repairedState = { ...state, rewrittenCommits: [{ from: b1, to: replacement }] };
    expect(preferCommitPatchForCommittedTurns(repairedState, [mapping], repo)).toBe(1);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([7, 2]);
    expect(sectionsFor(mapping.diff, 'b.ts')).toBe(1);
  });

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

  it('recovers an empty row whose commits HEAD holds, just like a stranded branch', () => {
    const { a1, a2, state, mapping } = twoBranchTurn();
    git('checkout', '-q', 'fix-a');
    state.commitTurns = [{ sha: a1, turnId: 't_0' }, { sha: a2, turnId: 't_0' }];
    Object.assign(mapping, { filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 });
    expect(preferCommitPatchForCommittedTurns(state, [mapping], repo)).toBe(1);
    expect(pathsInDiff(mapping.diff).sort()).toEqual(['a.ts', 'package.json']);
    expect([mapping.linesAdded, mapping.linesRemoved]).toEqual([3, 1]);
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
