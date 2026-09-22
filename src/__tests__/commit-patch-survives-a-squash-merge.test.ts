/**
 * A turn's commit stays on its row after the host SQUASH-MERGED it and the
 * branch went away.
 *
 * Live session 92f14dfb (2026-09-21), found by the release gate as
 * `header_file_unclaimed_by_turns`. Turn 10 committed a90663128 — seven files,
 * +345/-16, two of them created there. PR #1754 was then squash-merged on
 * GitHub into 941fdfbf2 and the branch deleted, so by session-end the original
 * sat on no ref and HEAD did not reach it. The session HEADER was written by
 * post-commit while the commit was still live and counts its files; the ROW
 * was rebuilt afterwards and could not, so it kept the watcher's +105/-6 over
 * three unrelated files and no sha. Two files of the session's own work then
 * appeared in no turn at all, and the header and the turns disagreed forever.
 *
 * The standing is `carried`: HEAD does not reach the commit, but its files
 * read the same in HEAD as at its tip, because the squash put them there. The
 * pass had no branch for it (`stranded` = 0) and nothing reachable to build a
 * range from (`shas` = 0), so it declined — even though `carried` is itself
 * the proof that the work survived, and `git show` reads the object whatever
 * the refs say.
 *
 * What must stay told apart is the shape that also sits on no branch and must
 * NOT be sent: an amended-away original (`superseded`), whose replacement is
 * another commit of the same turn with the same parents. A squash the session
 * never recorded as a rewrite looks nothing like it — the content is in HEAD.
 *
 * Driven against real git: the rule turns on refs, ancestry and content.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns, pathsInDiff } from '../commit-patch-for-committed-turn.js';
import { createShadowCommit } from '../git-capture.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};
const commitAll = (msg: string) => {
  git('add', '-A');
  execFileSync('git', ['commit', '-qm', msg], { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return git('rev-parse', 'HEAD');
};
const emptyRow = () => ({
  promptIndex: 0, filesChanged: [] as string[], diff: '', uncommittedDiff: '',
  linesAdded: 0, linesRemoved: 0, commitSha: null as string | null,
});

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-squash-merge-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('a.ts', 'a1\n'); write('b.ts', 'b1\n');
  commitAll('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch {} });

/**
 * The 92f14dfb shape. One turn commits on a feature branch — editing a.ts and
 * CREATING seal.ts, the file that went missing — the host squashes the branch
 * into main with identical content, the branch is deleted and the tree moves
 * to main. No rewrite pair is recorded: the squash happened on GitHub, not in
 * this checkout.
 */
function commitThenSquashMergeIt() {
  const baseMain = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature');
  const baseline = createShadowCommit(repo, 'turn0') || baseMain;
  write('a.ts', 'a1\nseal every site\n');
  write('seal.ts', 'sealed\n');
  const fix = commitAll('fix(integrations): pin every seal site');

  // The host's squash: same content, new commit, straight onto main.
  git('checkout', '-q', 'main');
  write('a.ts', 'a1\nseal every site\n');
  write('seal.ts', 'sealed\n');
  const squash = commitAll('fix(integrations): encrypt the credentials (#1754)');
  git('branch', '-qD', 'feature');

  const state = {
    promptTurnIds: ['t_0'],
    commitTurns: [{ sha: fix, turnId: 't_0' }],
    promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
    prePromptSha: null,
  };
  return { baseline, fix, squash, state };
}

describe('a turn whose commit was squash-merged away', () => {
  it('sits on no ref, is unreachable, and its content IS in HEAD', () => {
    const { fix } = commitThenSquashMergeIt();
    expect(() => git('merge-base', '--is-ancestor', fix, 'HEAD')).toThrow();
    expect(git('for-each-ref', '--contains', fix, '--format=%(refname)')).toBe('');
    expect(git('cat-file', '-t', fix)).toBe('commit');
    // `carried`: the squash put the same bytes in HEAD.
    expect(git('diff', '--quiet', fix, 'HEAD', '--', 'a.ts', 'seal.ts')).toBe('');
  });

  it('keeps its work on the row instead of declining', () => {
    const { fix, state } = commitThenSquashMergeIt();
    const row = emptyRow();
    const log: Array<[string, Record<string, unknown>]> = [];
    expect(preferCommitPatchForCommittedTurns(state, [row], repo, { log: (e, d) => log.push([e, d]) })).toBe(1);
    expect([row.linesAdded, row.linesRemoved]).toEqual([2, 0]);
    expect([...row.filesChanged].sort()).toEqual(['a.ts', 'seal.ts']);
    expect(pathsInDiff(row.diff).sort()).toEqual(['a.ts', 'seal.ts']);
    // The file that went missing from every turn in the live session.
    expect(row.diff).toContain('+sealed');
    expect((row as { commitPatch?: boolean }).commitPatch).toBe(true);
    expect(row.uncommittedDiff).toBe('');
    const numstat = execFileSync('git', ['apply', '--numstat'], { cwd: repo, encoding: 'utf8', input: row.diff });
    expect(numstat).toContain('1\t0\ta.ts');
    expect(numstat).toContain('1\t0\tseal.ts');
    expect(log.map(([e]) => e))
      .not.toContain('commit patch declined: no commit of the turn, nor a rewrite of one, is reachable from HEAD');
  });

  it('tells the resolver it applied, not that it declined', () => {
    const { state } = commitThenSquashMergeIt();
    const row = emptyRow();
    const seen: Array<{ outcome: string }> = [];
    preferCommitPatchForCommittedTurns(state, [row], repo, { observe: (_i, o) => seen.push(o as { outcome: string }) });
    expect(seen).toMatchObject([{ source: 'commit-patch', outcome: 'applied', added: 2, removed: 0 }]);
  });

  // The line this must not cross. An amend leaves the original on no ref with
  // its content in HEAD too — but its replacement is a commit of the SAME turn
  // with the SAME parents, and sending both counts the work twice.
  it('still leaves an amended-away original out', () => {
    const baseMain = git('rev-parse', 'HEAD');
    const baseline = createShadowCommit(repo, 'turn0') || baseMain;
    write('a.ts', 'a1\nfirst try\n');
    const original = commitAll('wip');
    write('a.ts', 'a1\nsecond try\n');
    git('add', '-A'); // else the change stays unstaged and the turn is DIRTY, which declines for its own good reason
    execFileSync('git', ['commit', '-q', '--amend', '-m', 'done'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    const amended = git('rev-parse', 'HEAD');
    expect(amended).not.toBe(original);
    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha: original, turnId: 't_0' }, { sha: amended, turnId: 't_0' }],
      promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
      prePromptSha: null,
    };
    const row = emptyRow();
    expect(preferCommitPatchForCommittedTurns(state, [row], repo)).toBe(1);
    // One line, once: the amend's, not the original's as well.
    expect([row.linesAdded, row.linesRemoved]).toEqual([1, 0]);
    expect(row.diff).toContain('+second try');
    expect(row.diff).not.toContain('+first try');
  });

  // `carried` is also what chainStanding answers when it could name no files —
  // a genuinely empty commit, and equally a `git show` that FAILED. Neither is
  // proof the work is in HEAD, so the send re-proves carriage from the files
  // and an empty one is left alone.
  it('does not send a chain whose commit names no files', () => {
    const baseMain = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature');
    const baseline = createShadowCommit(repo, 'turn0') || baseMain;
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'empty'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    const empty = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    git('branch', '-qD', 'feature');
    expect(git('show', '--name-only', '--format=', empty)).toBe('');
    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha: empty, turnId: 't_0' }],
      promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
      prePromptSha: null,
    };
    const row = emptyRow();
    const log: Array<[string, Record<string, unknown>]> = [];
    preferCommitPatchForCommittedTurns(state, [row], repo, { log: (e, d) => log.push([e, d]) });
    expect(log.map(([e]) => e)).not.toContain('turn commits squash-merged away — sending each chain\'s own patch');
    expect(row.filesChanged).toEqual([]);
    expect(row.diff).toBe('');
  });

  // A commit the session RESET away has its content in no tree, so it is not
  // `carried` and never reaches the path added here — it is `stranded`, which
  // this pass has always sent. Taking it off the turn is `liveCommitTurns`'
  // job (#1761), upstream of here, and this pins that this fix did not quietly
  // take it over.
  it('leaves a reset-away commit to the abandonment filter, as stranded', () => {
    const baseMain = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'scratch');
    const baseline = createShadowCommit(repo, 'turn0') || baseMain;
    write('gone.ts', 'thrown away\n');
    const wip = commitAll('wip');
    git('checkout', '-q', 'main');
    git('branch', '-qD', 'scratch');
    // Not carried: HEAD has no gone.ts at all.
    expect(() => git('diff', '--quiet', wip, 'HEAD', '--', 'gone.ts')).toThrow();
    const state = {
      promptTurnIds: ['t_0'],
      commitTurns: [{ sha: wip, turnId: 't_0' }],
      promptShadows: [{ promptIndex: 0, shadowSha: baseline }],
      prePromptSha: null,
    };
    const row = emptyRow();
    const log: Array<[string, Record<string, unknown>]> = [];
    preferCommitPatchForCommittedTurns(state, [row], repo, { log: (e, d) => log.push([e, d]) });
    expect(log.find(([e]) => e === 'ledger diff replaced by the commit patches of several branches')?.[1])
      .toMatchObject({ stranded: 1 });
  });
});
