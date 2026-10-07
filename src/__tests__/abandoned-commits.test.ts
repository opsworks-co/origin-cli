/**
 * Only a commit git proves was reset away is abandoned — never merely an
 * unreachable one. See abandoned-commits.ts.
 *
 * Driven against REAL git: reflogs, refs and worktrees are what is tested.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { provenAbandonedCommits } from '../abandoned-commits.js';
import { readReflogRewrites } from '../rewrite-proof.js';
import { isWindows } from './helpers/windows-e2e.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const head = () => git('rev-parse', 'HEAD');
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
const commit = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); return head(); };
const abandoned = (recorded: string[], rewrites: Array<{ from: string; to: string }> = []) =>
  provenAbandonedCommits(repo, recorded, rewrites, () => readReflogRewrites(repo));

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-abandoned-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n'); commit('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

// A `git` earlier on PATH that fails for ONE call and hands every other one to
// the real binary. Deterministic, and it never touches the repository: the
// question is what the detector does when a step of its proof cannot be run.
const REAL_GIT = (() => {
  try { return execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim(); } catch { return ''; }
})();

function withGitFailing<T>(pattern: string, fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-git-shim-'));
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    'case "$*" in',
    `  ${pattern}) echo "forced failure: $*" >&2; exit 128;;`,
    'esac',
    `exec ${REAL_GIT} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  try { return fn(); } finally {
    process.env.PATH = before;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

describe('provenAbandonedCommits', () => {
  it('a commit reset away and recommitted differently under the same subject is abandoned; the recommit is not', () => {
    write('src.ts', 'v1\n');
    const wip = commit('wip');
    git('reset', '-q', '--soft', 'HEAD~1');
    git('reset', '-q');
    write('src.ts', 'v1\nv2\n');
    const real = commit('wip');
    expect(abandoned([wip, real])).toEqual([wip]);
  });

  it('several commits reset away at once are all abandoned', () => {
    write('a.ts', 'a\n'); const one = commit('one');
    write('b.ts', 'b\n'); const two = commit('two');
    git('reset', '-q', '--hard', 'HEAD~2');
    expect(new Set(abandoned([one, two]))).toEqual(new Set([one, two]));
  });

  it('a commit on a branch deleted after it was switched away from is NOT abandoned — no reset moved it', () => {
    git('checkout', '-q', '-b', 'feature');
    write('f.ts', 'f\n'); const onBranch = commit('feature work');
    git('checkout', '-q', 'main');
    git('branch', '-q', '-D', 'feature');
    expect(abandoned([onBranch])).toEqual([]);
  });

  it('a reset commit another branch still holds is NOT abandoned', () => {
    write('k.ts', 'k\n'); const kept = commit('kept');
    git('branch', 'keep');
    git('reset', '-q', '--hard', 'HEAD~1');
    expect(abandoned([kept])).toEqual([]);
  });

  it('a reset commit another worktree stands on is NOT abandoned', () => {
    write('w.ts', 'w\n'); const live = commit('live');
    git('worktree', 'add', '-q', '--detach', path.join(repo, '..', `${path.basename(repo)}-wt`), live);
    try {
      git('reset', '-q', '--hard', 'HEAD~1');
      expect(abandoned([live])).toEqual([]);
    } finally {
      git('worktree', 'remove', '--force', path.join(repo, '..', `${path.basename(repo)}-wt`));
    }
  });

  it('a reset commit only Origin\'s own shadow refs still reach IS abandoned', () => {
    write('s.ts', 's\n'); const wip = commit('wip');
    git('update-ref', 'refs/origin/shadow/tag', wip);
    git('branch', 'origin/shadow/tag', wip);
    git('reset', '-q', '--hard', 'HEAD~1');
    expect(abandoned([wip])).toEqual([wip]);
  });

  it('one side of a rewrite pair is left to supersession, even when a reset moved it', () => {
    write('r.ts', 'r\n'); const orphan = commit('r');
    git('reset', '-q', '--soft', 'HEAD~1');
    const again = commit('r again');
    expect(abandoned([orphan, again], [{ from: orphan, to: again }])).toEqual([]);
  });

  // Session 507dca76, turn 8: "wip" rebased onto a main that moved on, then
  // reset to main and committed again with a version bump — the commit that was
  // squash-merged. The rebase result was kept as live work beside the squash.
  it('a rebased commit later reset away and redone is abandoned; the commit it was rebased from stays with supersession', () => {
    git('checkout', '-q', '-b', 'fix');
    write('hooks.ts', 'agents md\n'); const wip = commit('wip');
    git('checkout', '-q', 'main');
    write('other.ts', 'main moved on\n'); commit('main moved on');
    git('checkout', '-q', 'fix');
    git('rebase', '-q', 'main');
    const rebased = head();
    git('reset', '-q', 'main');
    write('package.json', '{"version":"2"}\n');
    const redo = commit('fix(cli): Claude sees the repo\'s AGENTS.md');
    expect(abandoned([wip, rebased, redo], [{ from: wip, to: rebased }])).toEqual([rebased]);
  });

  describe('a sub-agent\'s own worktree', () => {
    // Session df8cc9aa turn 30: a sub-agent in an isolated worktree committed
    // "WIP", reset it away and committed the work again. The reset is in ITS
    // branch's reflog, never in the reflog of the branch the session is on.
    const agentTree = () => path.join(repo, '..', `${path.basename(repo)}-agent`);
    const inAgent = (...args: string[]) =>
      execFileSync('git', args, { cwd: agentTree(), encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    afterEach(() => { try { git('worktree', 'remove', '--force', agentTree()); } catch { /* gone */ } });

    it('a WIP reset away and redone there is abandoned; the redo is not', () => {
      git('worktree', 'add', '-q', '-b', 'fix/agent', agentTree());
      fs.writeFileSync(path.join(agentTree(), 'watcher.ts'), 'first try\n');
      inAgent('add', '-A'); inAgent('commit', '-qm', 'WIP');
      const wip = inAgent('rev-parse', 'HEAD');
      inAgent('reset', '-q', 'HEAD~1');
      fs.writeFileSync(path.join(agentTree(), 'watcher.ts'), 'the real fix\n');
      inAgent('add', '-A'); inAgent('commit', '-qm', 'fix(capture): the watcher records it');
      const redo = inAgent('rev-parse', 'HEAD');
      expect(abandoned([wip, redo])).toEqual([wip]);
    });

    it('a branch another worktree stands on, reset to its base after a squash-merge and left there: kept', () => {
      git('worktree', 'add', '-q', '-b', 'feature', agentTree());
      fs.writeFileSync(path.join(agentTree(), 'f1.ts'), 'f1\n'); inAgent('add', '-A'); inAgent('commit', '-qm', 'one');
      const f1 = inAgent('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(agentTree(), 'f2.ts'), 'f2\n'); inAgent('add', '-A'); inAgent('commit', '-qm', 'two');
      const f2 = inAgent('rev-parse', 'HEAD');
      write('other.ts', 'moved on\n'); commit('main moved on');
      git('merge', '-q', '--squash', 'feature'); git('commit', '-q', '-m', 'feature (#1)');
      inAgent('reset', '-q', '--hard', 'HEAD~2');
      expect(abandoned([f1, f2])).toEqual([]);
    });
  });

  it('an amended commit is not abandoned — the amend is not a reset', () => {
    write('m.ts', 'm\n'); const before = commit('m');
    write('m.ts', 'm2\n'); git('add', '-A'); git('commit', '-q', '--amend', '-m', 'm');
    expect(abandoned([before, head()])).toEqual([]);
  });

  describe('cleanup after a squash-merge fails closed', () => {
    // The feature commit's work reached main as ONE squash commit made on a
    // main that had moved on, so no amend, patch or tree pairs them and the
    // rescue proves no rewrite.
    const squashFeature = () => {
      git('checkout', '-q', '-b', 'feature');
      write('f1.ts', 'f1\n'); const f1 = commit('feature one');
      write('f2.ts', 'f2\n'); const f2 = commit('feature two');
      git('checkout', '-q', 'main');
      write('other.ts', 'moved on\n'); commit('main moved on');
      git('merge', '-q', '--squash', 'feature'); git('commit', '-q', '-m', 'feature (#1)');
      return { f1, f2 };
    };

    it('the feature branch reset to its base and deleted: the reset left with the branch', () => {
      const { f1, f2 } = squashFeature();
      git('checkout', '-q', 'feature');
      git('reset', '-q', '--hard', 'HEAD~2');
      git('checkout', '-q', 'main');
      git('branch', '-q', '-D', 'feature');
      expect(abandoned([f1, f2])).toEqual([]);
    });

    it('the feature branch reset and kept, while the session works on main: not this line of work', () => {
      const { f1, f2 } = squashFeature();
      git('checkout', '-q', 'feature');
      git('reset', '-q', '--hard', 'HEAD~2');
      git('checkout', '-q', 'main');
      expect(abandoned([f1, f2])).toEqual([]);
    });

    it('reset on the branch the session is on, but its patch reached HEAD in a squash: kept', () => {
      write('s.ts', 's\n'); const one = commit('one');
      git('reset', '-q', '--hard', 'HEAD~1');
      write('other.ts', 'moved on\n'); commit('moved on');
      write('s.ts', 's\n'); commit('one, squashed');
      expect(abandoned([one])).toEqual([]);
    });
  });

  // A step of the proof that cannot be RUN is not a step that answered "no".
  describe.skipIf(isWindows || !REAL_GIT)('a git call that fails proves nothing', () => {
    /** WIP reset away on this branch, its patch later squashed into HEAD under a different tree. */
    const resetThenSquashed = () => {
      write('s.ts', 's\n');
      const one = commit('one');
      git('reset', '-q', '--hard', 'HEAD~1');
      write('other.ts', 'moved on\n'); commit('moved on');
      write('s.ts', 's\n'); commit('one, squashed');
      return one;
    };

    it('control: with every git call working, the squashed patch is found and the commit is kept', () => {
      expect(abandoned([resetThenSquashed()])).toEqual([]);
    });

    it('keeps it when `git show` of the commit cannot be read', () => {
      const one = resetThenSquashed();
      expect(withGitFailing('"show "*', () => abandoned([one])), 'an unreadable commit was called abandoned').toEqual([]);
    });

    it('keeps it when `git patch-id` cannot be run', () => {
      const one = resetThenSquashed();
      expect(withGitFailing('*"patch-id"*', () => abandoned([one])), 'an uncomparable patch was called abandoned').toEqual([]);
    });

    it('keeps it when `git log -p` of the window cannot be read', () => {
      const one = resetThenSquashed();
      expect(withGitFailing('"log -p"*', () => abandoned([one])), 'an unreadable window was called abandoned').toEqual([]);
    });

    it('keeps a commit another detached worktree holds when `git worktree list` fails', () => {
      write('w.ts', 'w\n');
      const live = commit('live');
      const tree = path.join(repo, '..', `${path.basename(repo)}-wt`);
      git('worktree', 'add', '-q', '--detach', tree, live);
      try {
        git('reset', '-q', '--hard', 'HEAD~1');
        expect(abandoned([live]), 'control: the other worktree holds it').toEqual([]);
        expect(withGitFailing('"worktree list"*', () => abandoned([live])),
          'an unreadable worktree list called it abandoned').toEqual([]);
      } finally {
        git('worktree', 'remove', '--force', tree);
      }
    });

    it('keeps everything when ancestry itself cannot be decided', () => {
      // `merge-base --is-ancestor` answers "no" with exit 1 and nothing else;
      // a failure is not an answer. Green on the old code too — no call path
      // reached abandonment through a broken ancestry check — so this guards
      // the distinction rather than proving a fix.
      write('src.ts', 'v1\n');
      const wip = commit('wip');
      git('reset', '-q', '--soft', 'HEAD~1');
      git('reset', '-q');
      write('src.ts', 'v1\nv2\n');
      commit('wip');
      expect(abandoned([wip]), 'control: this one is provably abandoned').toEqual([wip]);
      expect(withGitFailing('"merge-base"*', () => abandoned([wip])),
        'an undecidable ancestry called it abandoned').toEqual([]);
    });

    it('still abandons the plain reset-away commit when every call works', () => {
      write('src.ts', 'v1\n');
      const wip = commit('wip');
      git('reset', '-q', '--soft', 'HEAD~1');
      git('reset', '-q');
      write('src.ts', 'v1\nv2\n');
      commit('wip');
      expect(abandoned([wip])).toEqual([wip]);
    });
  });

  it('a commit HEAD still reaches is never abandoned, whatever the reflog says', () => {
    write('x.ts', 'x\n'); const x = commit('x');
    git('reset', '-q', '--hard', 'HEAD~1');
    git('reset', '-q', '--hard', x);
    expect(abandoned([x])).toEqual([]);
  });
});
