/**
 * A turn that checks out a branch did not write that branch.
 *
 * Session a073a85b turn 1 is the case. The prompt was "Review and merge 1538
 * pr"; the turn ran `gh pr checkout 1538`, unblocked the branch's CI and
 * committed `7c96d0df` — 5 files, +20/-10. Its stored row said **10 files,
 * +574/-15**: PR #1538 in full, authored the previous day in another session,
 * plus the twenty lines that were genuinely its own.
 *
 * Two producers, one missing fact:
 *
 *   • The write-journal watcher saw the checkout rewrite ten files on disk and
 *     journalled every one as a write of the open turn. Their before-states
 *     came from the turn's shadow, which was cut before the checkout.
 *   • The commit-patch pass already scopes to the commit's own file list — it
 *     was written for exactly this shape (session 761adbe8) — but kept the
 *     stale shadow as its baseline, and so reported +286/-5 for a commit of
 *     +20/-10: the four files the turn really edited, carrying the branch's
 *     version of them underneath its own four lines.
 *
 * hooks.ts already dropped the six files the turn only received
 * (`filesLeftByForeignCommits`, by content equality). That is the file half.
 * A file the turn edited ON TOP survives it by design and was still measured
 * from before the checkout — `prefer-shadow-range.test.ts` reported +195 for a
 * +4/-3 edit. Naming the inherited commit once answers both halves.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  inheritedBaselineForTurn,
  inheritedBeforeStatesForTurn,
} from '../commands/hooks.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';
import { applyLedgerCaptures } from '../commands/hooks/session-end.js';
import { serializeRecord, serializeTurnMark } from '../write-journal.js';
import { putSnapshot } from '../write-journal-store.js';

const TURN = 't_review_and_merge_1538';

/** Whatever the ledger rendered for the turn; this pass only runs on a turn
 *  that already has a capture to replace. */
const LEDGER_DIFF = [
  'diff --git a/src/stop.ts b/src/stop.ts',
  '--- a/src/stop.ts',
  '+++ b/src/stop.ts',
  '@@ -20,0 +21,1 @@',
  '+export const unblocked = true;',
  '',
].join('\n');

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';

/** The shadow the turn's baseline is: the working tree at turn start. */
function shadowAt(ref: string): string {
  const tree = git('rev-parse', `${ref}^{tree}`);
  return git('commit-tree', tree, '-p', ref, '-m', 'origin shadow prompt-0');
}

/** Session start is AFTER the branch was authored — the committer-date rule
 *  in commitBelongsToSession is what makes those commits foreign. */
const SESSION_STARTED_AT = '2026-09-11T13:25:14.000Z';
const BRANCH_AUTHORED_AT = '2026-09-10T20:00:00 +0000';

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'dev@test.dev');
  git('config', 'user.name', 'Dev');
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));

  write('src/stop.ts', lines(20, 'stop'));
  write('src/untouched.ts', 'export const keep = 1;\n');
  git('add', '.'); git('commit', '-q', '-m', 'initial');

  // ── The pull request, authored YESTERDAY in another session ──────────────
  git('checkout', '-q', '-b', 'pr1538');
  write('src/prefer-shadow-range.ts', lines(129, 'psr'));      // created there
  write('src/prefer-shadow-range.test.ts', lines(195, 'psrt')); // created there
  write('src/heartbeat.ts', lines(4, 'hb'));                    // created there
  write('src/stop.ts', lines(20, 'stop') + lines(24, 'branchStop')); // grown there
  // Session 9a1ef9e3: a checkout rewrite of a `.github/` file was billed as a
  // whole-file add because readFileAtRev rejected any path starting with `.`.
  write('.github/workflows/ci.yml', lines(312, 'gha'));
  git('add', '.');
  execFileSync('git', ['commit', '-q', '-m', 'feat: the PR, by someone else'], {
    cwd: repo,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: BRANCH_AUTHORED_AT,
      GIT_AUTHOR_DATE: BRANCH_AUTHORED_AT,
      GIT_COMMITTER_EMAIL: 'someone@else.dev',
      GIT_AUTHOR_EMAIL: 'someone@else.dev',
    },
  });
  git('checkout', '-q', 'main');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** Run the turn: check the PR out, edit three lines, commit. */
function runTheTurn(): { shadow: string; branchTip: string; ourCommit: string } {
  const shadow = shadowAt('main');            // baseline cut BEFORE the checkout
  git('checkout', '-q', 'pr1538');
  const branchTip = git('rev-parse', 'HEAD');
  // +3/-1 of the turn's own, spread over two of the branch's files.
  write('src/stop.ts', lines(20, 'stop') + lines(23, 'branchStop') + 'export const unblocked = true;\nexport const two = 2;\nexport const three = 3;\n');
  git('add', '.'); git('commit', '-q', '-m', 'fix(capture): unblock the branch CI');
  return { shadow, branchTip, ourCommit: git('rev-parse', 'HEAD') };
}

function stateFor(shadow: string, ourCommit: string) {
  return {
    sessionId: 'a073a85b-1a97-4623-8198-d1fa5a375e50',
    sessionTag: 'a073a85b', repoPath: repo, lastCwd: repo,
    startedAt: SESSION_STARTED_AT,
    prompts: ['Review and merge 1538 pr'],
    promptTurnIds: [TURN],
    promptShadows: [{ promptIndex: 0, shadowSha: shadow }],
    sessionCommitShas: [ourCommit],
    commitTurns: [{ sha: ourCommit, turnId: TURN }],
  } as any;
}

/**
 * The journal as the watcher really recorded it: the checkout's own writes,
 * every one a first sighting for the turn, followed by the turn's edit.
 */
function journalForTheCheckout(branchTip: string): { journalPath: string; snapshotDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-journal-'));
  const snapshotDir = path.join(dir, 'snap');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const at = Date.parse(SESSION_STARTED_AT) + 60_000;
  const show = (f: string) => execFileSync('git', ['show', `${branchTip}:${f}`], { cwd: repo, encoding: 'utf-8' });
  const rec = (file: string, content: string, n: number) => serializeRecord({
    file, at: at + n, mtime: at + n, hash: putSnapshot(snapshotDir, content).hash, retained: true,
  });
  const log = serializeTurnMark({ at, turnId: TURN })
    // What `gh pr checkout` wrote, as the watcher saw it.
    + rec('src/prefer-shadow-range.ts', show('src/prefer-shadow-range.ts'), 1)
    + rec('src/prefer-shadow-range.test.ts', show('src/prefer-shadow-range.test.ts'), 2)
    + rec('src/heartbeat.ts', show('src/heartbeat.ts'), 3)
    + rec('.github/workflows/ci.yml', show('.github/workflows/ci.yml'), 4)
    + rec('src/stop.ts', show('src/stop.ts'), 5)
    // What the turn itself then wrote.
    + rec('src/stop.ts', fs.readFileSync(path.join(repo, 'src/stop.ts'), 'utf-8'), 6);
  const journalPath = path.join(dir, 'journal.log');
  fs.writeFileSync(journalPath, log);
  return { journalPath, snapshotDir };
}

describe('a turn does not author the branch it checked out', () => {
  it('names the branch tip as the tree the turn actually started from', () => {
    const { shadow, branchTip, ourCommit } = runTheTurn();
    const state = stateFor(shadow, ourCommit);

    expect(inheritedBaselineForTurn(repo, state, shadow, 0)).toBe(branchTip);
  });

  it('gives the turn its own commit, not the pull request', () => {
    const { shadow, ourCommit } = runTheTurn();
    const state = stateFor(shadow, ourCommit);

    // What the badge says: the commit against its parent.
    const badge = execFileSync('git', ['show', '--numstat', '--format=', ourCommit], {
      cwd: repo, encoding: 'utf-8',
    }).trim().split('\n').reduce((acc, l) => {
      const [a, r] = l.split('\t');
      return { added: acc.added + Number(a), removed: acc.removed + Number(r) };
    }, { added: 0, removed: 0 });
    expect(badge).toEqual({ added: 3, removed: 1 });

    const pm: any = { promptIndex: 0, filesChanged: ['src/stop.ts'], linesAdded: 0, linesRemoved: 0, diff: LEDGER_DIFF };
    const replaced = preferCommitPatchForCommittedTurns(state, [pm], repo, {
      inheritedBaseline: (shadowSha, localTurn) => inheritedBaselineForTurn(repo, state, shadowSha, localTurn),
    });

    expect(replaced).toBe(1);
    expect({ added: pm.linesAdded, removed: pm.linesRemoved }).toEqual(badge);
    expect(pm.filesChanged).toEqual(['src/stop.ts']);
    // The branch's own files are nowhere in the turn.
    expect(pm.diff).not.toContain('prefer-shadow-range');
    expect(pm.diff).not.toContain('heartbeat');
  });

  it('without the inherited baseline it reports the whole pull request', () => {
    const { shadow, ourCommit } = runTheTurn();
    const state = stateFor(shadow, ourCommit);
    const pm: any = { promptIndex: 0, filesChanged: ['src/stop.ts'], linesAdded: 0, linesRemoved: 0, diff: LEDGER_DIFF };

    // The behaviour before this fix: same pass, shadow baseline, one file — and
    // it carries the branch's 24 lines under the turn's three.
    preferCommitPatchForCommittedTurns(state, [pm], repo, {});
    expect(pm.linesAdded).toBeGreaterThan(20);
  });

  it('hands the ledger the branch content as the before-state it inherited', () => {
    const { shadow, branchTip, ourCommit } = runTheTurn();
    const state = stateFor(shadow, ourCommit);

    const before = inheritedBeforeStatesForTurn(repo, state, shadow, 0);

    // A file the checkout CREATED and the turn never touched: its before-state
    // is what the branch left, so the ledger renders no change for it at all.
    expect(before.get('src/prefer-shadow-range.ts'))
      .toBe(execFileSync('git', ['show', `${branchTip}:src/prefer-shadow-range.ts`], { cwd: repo, encoding: 'utf-8' }));
    // Hidden dirs are real tree paths. The old `startsWith('.')` guard made
    // this read null, so the ledger billed the checkout as a whole-file add.
    expect(before.get('.github/workflows/ci.yml'))
      .toBe(execFileSync('git', ['show', `${branchTip}:.github/workflows/ci.yml`], { cwd: repo, encoding: 'utf-8' }));
    // A file the turn edited on top: measured from the branch's version, the
    // diff is the turn's three lines rather than the branch's twenty-four.
    expect(before.get('src/stop.ts'))
      .toBe(execFileSync('git', ['show', `${branchTip}:src/stop.ts`], { cwd: repo, encoding: 'utf-8' }));
    // A file nothing in the window touched keeps the turn's own baseline.
    expect(before.has('src/untouched.ts')).toBe(false);
  });

  it('a turn that committed before the pull keeps its own baseline', () => {
    // The turn commits, THEN something lands in its window. Re-baselining onto
    // that would erase work the turn authored, so the walk stops at the turn's
    // first own commit and the inherited baseline is null.
    const shadow = shadowAt('main');
    write('src/mine.ts', 'export const mine = 1;\n');
    git('add', '.'); git('commit', '-q', '-m', 'the turn commits first');
    const ourCommit = git('rev-parse', 'HEAD');
    git('merge', '-q', '--no-ff', '-m', 'then the branch arrives', 'pr1538');

    const state = stateFor(shadow, ourCommit);
    expect(inheritedBaselineForTurn(repo, state, shadow, 0)).toBeNull();
  });

  it('the ledger bills the turn for its own edit, not the checkout', () => {
    const { shadow, branchTip, ourCommit } = runTheTurn();
    const paths = journalForTheCheckout(branchTip);
    const state = stateFor(shadow, ourCommit);
    state.writeJournalPath = paths.journalPath;
    state.writeSnapshotDir = paths.snapshotDir;

    const pm: any = { promptIndex: 0, filesChanged: [], linesAdded: 0, linesRemoved: 0, diff: '' };
    expect(applyLedgerCaptures(state, [pm])).toBe(1);

    // Before this fix: four files and the whole branch — the twenty-four lines
    // `src/stop.ts` grew on the branch plus three files created there.
    expect(pm.filesChanged).toEqual(['src/stop.ts']);
    expect(pm.linesAdded).toBe(3);
    expect(pm.linesRemoved).toBe(1);
    expect(pm.diff).not.toContain('prefer-shadow-range');
    // `.github/workflows/ci.yml` was rewritten by the checkout and journalled
    // as a first sighting. It must cancel, not show up as +312/-0.
    expect(pm.diff).not.toContain('.github/workflows/ci.yml');
    expect(pm.linesAdded).toBeLessThan(20);
  });
});

describe('leaving a branch does not become authored deletions', () => {
  it('does not replace a dirty shadow for ordinary work on the same branch', () => {
    write('src/stop.ts', lines(20, 'stop') + 'const preexisting = true;\n');
    git('add', '.');
    const tree = git('write-tree');
    const shadow = git('commit-tree', tree, '-p', 'HEAD', '-m', 'origin shadow prompt-0');
    write('src/stop.ts', lines(20, 'stop') + 'const preexisting = true;\nconst mine = true;\n');
    git('add', '.'); git('commit', '-q', '-m', 'my edit');
    const state = stateFor(shadow, git('rev-parse', 'HEAD'));
    expect(inheritedBaselineForTurn(repo, state, shadow, 0)).toBeNull();
  });

  it('declines a single replacement baseline when the turn already committed on the branch it left', () => {
    git('checkout', '-q', 'pr1538');
    const shadow = shadowAt('pr1538');
    write('src/mine.ts', 'const mine = true;\n');
    git('add', '.'); git('commit', '-q', '-m', 'own work before leaving');
    const own = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    expect(inheritedBaselineForTurn(repo, stateFor(shadow, own), shadow, 0)).toBeNull();
  });

  for (const committed of [false, true]) {
    it(`keeps only edits after switching back to main (${committed ? 'committed' : 'uncommitted'})`, () => {
      git('checkout', '-q', 'pr1538');
      const shadow = shadowAt('pr1538');
      git('checkout', '-q', 'main');
      const destination = git('rev-parse', 'HEAD');
      write('src/stop.ts', lines(20, 'stop') + 'export const actualWork = true;\n');
      if (committed) { git('add', '.'); git('commit', '-q', '-m', 'actual turn work'); }
      const state = stateFor(shadow, committed ? git('rev-parse', 'HEAD') : '');
      if (!committed) { state.commitTurns = []; state.sessionCommitShas = []; }
      expect(inheritedBaselineForTurn(repo, state, shadow, 0)).toBe(destination);
      const before = inheritedBeforeStatesForTurn(repo, state, shadow, 0);
      expect(before.has('src/prefer-shadow-range.ts')).toBe(true);
      expect(before.get('src/prefer-shadow-range.ts')).toBeNull();

      const snapshotDir = path.join(home, 'snapshots');
      fs.mkdirSync(snapshotDir);
      const at = Date.parse(SESSION_STARTED_AT) + 60_000;
      const journalPath = path.join(home, 'journal.jsonl');
      fs.writeFileSync(journalPath, serializeTurnMark({ turnId: TURN, at })
        + ['src/prefer-shadow-range.ts', 'src/prefer-shadow-range.test.ts', 'src/heartbeat.ts']
          .map((file) => serializeRecord({ file, at: at + 1, gone: true })).join('')
        + serializeRecord({ file: 'src/stop.ts', at: at + 2,
          hash: putSnapshot(snapshotDir, fs.readFileSync(path.join(repo, 'src/stop.ts'), 'utf-8')).hash,
          retained: true }));
      state.writeJournalPath = journalPath;
      state.writeSnapshotDir = snapshotDir;
      const pm: any = { promptIndex: 0, filesChanged: [], linesAdded: 0, linesRemoved: 0, diff: '' };
      expect(applyLedgerCaptures(state, [pm])).toBe(1);
      expect(pm.filesChanged).toEqual(['src/stop.ts']);
      expect([pm.linesAdded, pm.linesRemoved]).toEqual([1, 0]);
      expect(pm.diff).toContain('+export const actualWork = true;');
    });
  }
});
