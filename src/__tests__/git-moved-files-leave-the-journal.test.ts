/**
 * TODO e87a35d5, design v3: a turn that runs `git pull` is not billed the files
 * that came down.
 *
 * Live repro (6b770703 turn 29, cli .1550): two files arriving through the
 * turn's own pull were recorded in the `origin:write-journal` slot, because the
 * journal sees bytes land and cannot say who landed them. The earlier plan
 * (5ef1cb12) diffed only DIRTY files around the command — and a pulled file
 * ends CLEAN, so it could not have fixed this. These tests run a real pull
 * between the real probe hooks and check the journal channel afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { journalFilesForTurn } from '../commands/hooks/stop.js';
import { beginShellProbe, endShellProbe } from '../commands/hooks/tool-use.js';
import { commandMovesTree, filesChangedBetween, filesMovedByCommand, gitMovedFilesForTurn, markReflog } from '../git-moved-files.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

let root = '';
let remote = '';
let mine = '';
let theirs = '';
let journal = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gmf-')));
  remote = path.join(root, 'remote.git');
  mine = path.join(root, 'mine');
  theirs = path.join(root, 'theirs');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(root, 'clone', '-q', remote, theirs);
  fs.writeFileSync(path.join(theirs, 'shared.txt'), 'one\n');
  fs.writeFileSync(path.join(theirs, 'old-name.txt'), 'rename me\n');
  git(theirs, 'add', '-A');
  git(theirs, 'commit', '-q', '-m', 'base');
  git(theirs, 'push', '-q', 'origin', 'HEAD:main');
  git(root, 'clone', '-q', remote, mine);
  journal = path.join(root, 'journal.jsonl');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** A teammate's change: an edit, a new file in a new directory, a rename, a non-ASCII name. */
function teammatePushes() {
  fs.writeFileSync(path.join(theirs, 'shared.txt'), 'one\ntwo\n');
  fs.mkdirSync(path.join(theirs, 'new-dir', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(theirs, 'new-dir', 'deep', 'added.ts'), 'export {}\n');
  git(theirs, 'mv', 'old-name.txt', 'new-name.txt');
  fs.writeFileSync(path.join(theirs, 'ünïcode file.md'), 'hi\n');
  git(theirs, 'add', '-A');
  git(theirs, 'commit', '-q', '-m', 'teammate');
  git(theirs, 'push', '-q', 'origin', 'HEAD:main');
}

const rec = (f: string, t: number) => JSON.stringify({ f, t, h: 'x'.repeat(64), n: 1, m: t });

function stateFor(t0: number): any {
  return {
    sessionId: 's', repoPath: mine, writeJournalPath: journal, currentTurnStartedAt: t0,
    prompts: ['pull and keep going'],
  };
}

function runThroughProbe(state: any, command: string, run: () => void) {
  const input = { tool_name: 'Bash', tool_input: { command }, tool_use_id: 'call-1' };
  beginShellProbe(state, input);
  run();
  endShellProbe(state, input);
}

describe('a turn that pulls is not billed what came down', () => {
  it('drops every pulled file from the journal channel and keeps the turn\'s own write', () => {
    teammatePushes();
    const t0 = Date.now() - 10_000;
    const state = stateFor(t0);
    fs.writeFileSync(path.join(mine, 'mine.py'), 'print(1)\n'); // the turn's own work

    runThroughProbe(state, 'git pull --ff-only', () => git(mine, 'pull', '-q', '--ff-only'));

    // What the watcher would have journalled during the turn: our write plus
    // every byte the pull landed.
    fs.writeFileSync(journal, [
      rec('mine.py', t0 + 100),
      rec('shared.txt', t0 + 200),
      rec('new-dir/deep/added.ts', t0 + 200),
      rec('new-name.txt', t0 + 200),
      rec('old-name.txt', t0 + 200),
      rec('ünïcode file.md', t0 + 200),
    ].join('\n') + '\n');

    expect(journalFilesForTurn(state, undefined, 0)).toEqual(['mine.py']);
  });

  it('pulled files are CLEAN afterwards — the dirty-file probe alone could not see them', () => {
    teammatePushes();
    git(mine, 'pull', '-q', '--ff-only');
    expect(git(mine, 'status', '--porcelain').trim()).toBe('');
  });

  it('a merge commit (not a fast-forward) is covered too', () => {
    teammatePushes();
    fs.writeFileSync(path.join(mine, 'local.txt'), 'local\n');
    git(mine, 'add', '-A');
    git(mine, 'commit', '-q', '-m', 'local work');
    const state = stateFor(Date.now() - 10_000);

    runThroughProbe(state, 'git pull --no-rebase', () => git(mine, 'pull', '-q', '--no-rebase', '--no-edit'));

    const moved = gitMovedFilesForTurn(state, 0, mine);
    expect([...moved].sort()).toEqual(['new-dir/deep/added.ts', 'new-name.txt', 'old-name.txt', 'shared.txt', 'ünïcode file.md']);
    expect(moved.has('local.txt'), 'our own committed file is not git\'s').toBe(false);
  });

  it('a path the command NAMED stays the turn\'s (git checkout <rev> -- f)', () => {
    teammatePushes();
    git(mine, 'fetch', '-q');
    const t0 = Date.now() - 10_000;
    const state = stateFor(t0);

    runThroughProbe(state, 'git checkout origin/main -- shared.txt', () => git(mine, 'checkout', 'origin/main', '--', 'shared.txt'));
    fs.writeFileSync(journal, rec('shared.txt', t0 + 100) + '\n');

    expect(journalFilesForTurn(state, undefined, 0)).toEqual(['shared.txt']);
  });

  it('a command that does not move the tree records nothing as git\'s', () => {
    const t0 = Date.now() - 10_000;
    const state = stateFor(t0);
    runThroughProbe(state, 'echo hi > note.txt', () => fs.writeFileSync(path.join(mine, 'note.txt'), 'hi\n'));
    expect(state.gitMovedFilesByTurn).toBeUndefined();
  });

  it('a later turn\'s journal is not filtered by an earlier turn\'s pull', () => {
    teammatePushes();
    const state = stateFor(Date.now() - 10_000);
    runThroughProbe(state, 'git pull --ff-only', () => git(mine, 'pull', '-q', '--ff-only'));
    const t1 = Date.now() - 5_000;
    state.prompts.push('now edit shared.txt');
    state.currentTurnStartedAt = t1;
    fs.writeFileSync(journal, rec('shared.txt', t1 + 100) + '\n');
    expect(journalFilesForTurn(state, undefined, 1)).toEqual(['shared.txt']);
  });
});

describe('the START side of a move — what #1811 left out of scope', () => {
  // #1811 drops what a pull BRINGS IN. Its own note leaves the other side:
  // "checking out main reverted the abandoned branch's own commits: two
  // deletes and package.json" — 3 journal entries still on turn 29's card.
  // `git diff <before> <after>` is symmetric, so v3 names those too.
  it('checking out main from a PR branch does not bill the turn for undoing that branch', () => {
    fs.writeFileSync(path.join(mine, 'package.json'), '{"v":1}\n');
    fs.writeFileSync(path.join(mine, 'gone-a.txt'), 'a\n');
    fs.writeFileSync(path.join(mine, 'gone-b.txt'), 'b\n');
    git(mine, 'add', '-A');
    git(mine, 'commit', '-q', '-m', 'main has these');
    git(mine, 'push', '-q', 'origin', 'HEAD:main');
    git(mine, 'checkout', '-q', '-b', 'pr');
    fs.writeFileSync(path.join(mine, 'package.json'), '{"v":2}\n');
    fs.rmSync(path.join(mine, 'gone-a.txt'));
    fs.rmSync(path.join(mine, 'gone-b.txt'));
    git(mine, 'add', '-A');
    git(mine, 'commit', '-q', '-m', 'the abandoned PR');

    const t0 = Date.now() - 10_000;
    const state = stateFor(t0);
    runThroughProbe(state, 'git checkout main', () => git(mine, 'checkout', '-q', 'main'));
    fs.writeFileSync(journal, [
      rec('package.json', t0 + 100),
      rec('gone-a.txt', t0 + 100),
      rec('gone-b.txt', t0 + 100),
    ].join('\n') + '\n');

    expect(journalFilesForTurn(state, undefined, 0)).toEqual([]);
  });
});

describe('a command that passes through a STALE checkout on its way (gh pr merge --delete-branch)', () => {
  // Session 24e45142 turn 11 ("release the cli"): +482 lines of two other
  // sessions' commits. The turn sat on a PR branch that already HAD them. `gh
  // pr merge --squash --delete-branch` checked out the local main — stale,
  // from an earlier merge — which reverted those files, then pulled them back.
  // End to end nothing about them changed; the journal saw each written twice
  // and billed the turn from the reverted copy.
  function prBranchOverStaleMain() {
    git(mine, 'checkout', '-q', 'main');           // local main, about to go stale
    teammatePushes();                               // lands on origin/main only
    git(mine, 'fetch', '-q');
    git(mine, 'checkout', '-q', '-b', 'pr', 'origin/main'); // the PR branch HAS their work
    fs.writeFileSync(path.join(mine, 'pr.txt'), 'the pr\n');
    git(mine, 'add', '-A');
    git(mine, 'commit', '-q', '-m', 'the PR');
    git(mine, 'push', '-q', 'origin', 'HEAD:main'); // "merged" on the host
  }
  // What gh does locally after the host merge.
  const ghDeleteBranch = () => {
    git(mine, 'checkout', '-q', 'main');
    git(mine, 'pull', '-q', '--ff-only');
    git(mine, 'branch', '-q', '-D', 'pr');
  };

  it('its files are identical end to end — before→after alone names none of them', () => {
    prBranchOverStaleMain();
    const before = git(mine, 'rev-parse', 'HEAD').trim();
    ghDeleteBranch();
    const after = git(mine, 'rev-parse', 'HEAD').trim();
    expect(filesChangedBetween(mine, before, after)).not.toContain('shared.txt');
  });

  it('every file rewritten on the way is git\'s, and the journal channel drops it', () => {
    prBranchOverStaleMain();
    const t0 = Date.now() - 10_000;
    const state = stateFor(t0);

    runThroughProbe(state, 'gh pr merge --squash --delete-branch pr >/dev/null 2>&1', ghDeleteBranch);
    fs.writeFileSync(journal, [
      rec('shared.txt', t0 + 100),               // reverted by the checkout…
      rec('new-dir/deep/added.ts', t0 + 100),
      rec('shared.txt', t0 + 200),               // …and pulled back
      rec('new-dir/deep/added.ts', t0 + 200),
    ].join('\n') + '\n');

    const moved = gitMovedFilesForTurn(state, 0, mine);
    expect(moved.has('shared.txt')).toBe(true);
    expect(moved.has('new-dir/deep/added.ts')).toBe(true);
    expect(journalFilesForTurn(state, undefined, 0)).toEqual([]);
  });

  it('filesMovedByCommand reads only the reflog lines the command appended', () => {
    prBranchOverStaleMain();
    const before = git(mine, 'rev-parse', 'HEAD').trim();
    const mark = markReflog(mine);
    ghDeleteBranch();
    const after = git(mine, 'rev-parse', 'HEAD').trim();
    expect(before).toBe(after); // ends where it began — only the steps name anything
    expect(filesMovedByCommand(mine, before, after, mark)).toContain('shared.txt');
    // The PR's own file too: the stale checkout removed it and the pull put
    // it back, so for this command it is git's.
    expect(filesMovedByCommand(mine, before, after, mark)).toContain('pr.txt');
    // Without a mark it is the plain two-end diff.
    expect(filesMovedByCommand(mine, before, after, null)).toEqual(filesChangedBetween(mine, before, after));
  });

  it('a mark taken AFTER earlier moves sees none of them', () => {
    prBranchOverStaleMain(); // several reflog entries, all within this second
    const mark = markReflog(mine);
    const head = git(mine, 'rev-parse', 'HEAD').trim();
    expect(filesMovedByCommand(mine, head, head, mark)).toEqual([]);
  });
});

describe('commandMovesTree', () => {
  it.each([
    'git pull', 'git pull --rebase origin main', 'cd repo && git checkout main', 'git -C ../x switch -c b',
    'git merge origin/main', 'git rebase main', 'git reset --hard HEAD~1', 'git stash pop', 'foo; git checkout .',
    'gh pr merge 1811 --squash --delete-branch', 'cd x; gh pr merge --squash --delete-branch fix/b >/dev/null 2>&1',
    'gh pr checkout 42', 'gh -R acme/app pr merge 7 -d', 'gh repo sync',
  ])('moves: %s', (c) => expect(commandMovesTree(c)).toBe(true));
  it.each([
    'git status', 'git log --oneline', 'git diff', 'git commit -m "git pull later"', 'echo "git pull"',
    'gh pr view 1811', 'gh pr create --title x', 'gh pr list --state merged', 'echo "gh pr merge 1"',
    "cat > notes.md <<'EOF'\ngit pull\nEOF",
  ])('does not move: %s', (c) => expect(commandMovesTree(c)).toBe(false));
});

describe('filesChangedBetween', () => {
  it('is [] for an unknown or unchanged HEAD', () => {
    expect(filesChangedBetween(mine, null, 'abc')).toEqual([]);
    const head = git(mine, 'rev-parse', 'HEAD').trim();
    expect(filesChangedBetween(mine, head, head)).toEqual([]);
  });
});
