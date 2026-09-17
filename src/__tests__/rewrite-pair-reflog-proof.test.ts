/**
 * Follow-ups from the final review of #1683 ("only git proves a commit
 * rewrite"). Three gaps in the rescue's rewrite pairs:
 *
 * 1. A wrong pair main also made: wip W1 on f is reset away, a later wip W2 on
 *    f (different content) is rebased onto a moved main. W2′ is a rebase
 *    product with W1's subject and files, W1 came first and claimed it, and the
 *    server moved W1's turn onto W2's commit.
 * 2. Real rewrites that lost their pair and stayed a duplicate commit: a
 *    `rebase -i` fixup/squash below the tip, and a conflicted cherry-pick whose
 *    source branch was then deleted.
 * 3. Reftable repos never paired: the reflog was read from `.git/logs/` files.
 *
 * Driven against REAL git. Every commit gets its own author second, as real
 * work does; commits sharing one are ambiguous and are left unpaired.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testRescueCommitShas } from '../commands/hooks.js';

let repo: string;
let clock: number;
let trace: string;
const env = () => {
  const at = `${clock} +0000`;
  return { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
};
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: env() }).toString().trim();
const gitMay = (...args: string[]) => {
  try { git(...args); return true; } catch { return false; }
};
const head = () => git('rev-parse', 'HEAD');
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
const commit = (msg: string) => { clock += 60; git('add', '-A'); git('commit', '-qm', msg); return head(); };
/** `git rebase -i`, with `sed` programs for the todo list. */
const rebaseI = (onto: string, todo: string) => {
  clock += 60;
  execFileSync('git', ['rebase', '-q', '-i', onto], {
    cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env(), GIT_SEQUENCE_EDITOR: `sed -i.bak -e '${todo}'`, GIT_EDITOR: 'true' },
  });
};

function init(extra: string[] = []) {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rewrite-reflog-'));
  trace = path.join(repo, '..', `${path.basename(repo)}-trace2.txt`);
  clock = 1_780_000_000;
  git('init', '-q', '-b', 'main', ...extra);
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n'); commit('base');
}
beforeEach(() => init());
afterEach(() => {
  delete process.env.GIT_TRACE2_PERF;
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(trace, { force: true }); } catch {}
});

function gitProcessesDuring(fn: () => void): number {
  try { fs.rmSync(trace, { force: true }); } catch {}
  process.env.GIT_TRACE2_PERF = trace;
  try { fn(); } finally { delete process.env.GIT_TRACE2_PERF; }
  if (!fs.existsSync(trace)) return 0;
  return fs.readFileSync(trace, 'utf-8').split('\n')
    .filter((l) => /\|\s*d0\s*\|/.test(l) && /\|\s*start\s*\|/.test(l)).length;
}

const pairsOf = (state: any) => (state.rewrittenCommits || []).map((p: any) => `${p.from}->${p.to}`).sort();

describe('1. a reset-away wip is not the rewrite of a later rebased wip', () => {
  const setup = (conflict: boolean) => {
    const start = head();
    git('checkout', '-q', '-b', 'feature');
    write('f.ts', 'export const f = 1;\n');
    const w1 = commit('wip');
    git('reset', '-q', '--hard', 'HEAD~1');
    write('f.ts', 'export const f = 2;\nexport const g = 3;\n');
    const w2 = commit('wip');
    git('checkout', '-q', 'main');
    if (conflict) write('f.ts', 'export const f = 0;\n'); else write('other.ts', 'theirs\n');
    commit('main moves');
    git('checkout', '-q', 'feature');
    clock += 60;
    if (!gitMay('rebase', '-q', 'main')) {
      write('f.ts', 'export const f = 2;\nexport const g = 3;\nexport const h = 0;\n');
      git('add', '-A');
      execFileSync('git', ['rebase', '--continue'], { cwd: repo, stdio: 'pipe', env: { ...env(), GIT_EDITOR: 'true' } });
    }
    return { start, w1, w2, w2b: head() };
  };

  it('clean rebase: W2 pairs with W2′, W1 is kept unpaired', () => {
    const { start, w1, w2, w2b } = setup(false);
    const state: any = { sessionCommitShas: [w1, w2], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    const kept = __testRescueCommitShas(repo, state);
    expect(pairsOf(state)).toEqual([`${w2}->${w2b}`]);
    expect(kept).toEqual([w1, w2b]);
  });

  it('conflicted rebase (patch moved): W2 still pairs with W2′, W1 does not', () => {
    const { start, w1, w2, w2b } = setup(true);
    const state: any = { sessionCommitShas: [w1, w2], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    const kept = __testRescueCommitShas(repo, state);
    expect(pairsOf(state)).toEqual([`${w2}->${w2b}`]);
    expect(kept).toEqual([w1, w2b]);
  });
});

describe('2. rewrites git records but no patch or shape shows', () => {
  const threeCommits = () => {
    const start = head();
    write('one.ts', 'export const one = 1;\n'); const c1 = commit('feat: one');
    write('two.ts', 'export const two = 2;\n'); const c2 = commit('feat: two');
    write('three.ts', 'export const three = 3;\n'); const c3 = commit('feat: three');
    return { start, c1, c2, c3 };
  };

  for (const op of ['fixup', 'squash'] as const) {
    it(`rebase -i ${op} of #2 into #1, below the tip`, () => {
      const { start, c1, c2, c3 } = threeCommits();
      rebaseI(start, `2s/^pick/${op}/`);
      const c3b = head();
      const c1b = git('rev-parse', 'HEAD~1');
      expect(git('rev-parse', 'HEAD~2')).toBe(start);
      const state: any = { sessionCommitShas: [c1, c2, c3], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
      const kept = __testRescueCommitShas(repo, state);
      expect(pairsOf(state)).toEqual([`${c1}->${c1b}`, `${c2}->${c1b}`, `${c3}->${c3b}`].sort());
      expect([...kept].sort()).toEqual([c1b, c3b].sort());
    });
  }

  it('rebase -i onto a moved main, with a fixup and a reword', () => {
    const { start, c1, c2, c3 } = threeCommits();
    git('branch', '-q', 'feature');
    git('reset', '-q', '--hard', start);
    write('theirs.ts', 'theirs\n'); commit('main moves');
    git('checkout', '-q', 'feature');
    clock += 60;
    execFileSync('git', ['rebase', '-q', '-i', 'main'], {
      cwd: repo, stdio: 'pipe',
      env: {
        ...env(),
        GIT_SEQUENCE_EDITOR: `sed -i.bak -e '2s/^pick/fixup/' -e '3s/^pick/reword/'`,
        GIT_EDITOR: `sed -i.bak -e '1s/.*/feat: three, reworded/'`,
      },
    });
    const c3b = head();
    const c1b = git('rev-parse', 'HEAD~1');
    const state: any = { sessionCommitShas: [c1, c2, c3], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    __testRescueCommitShas(repo, state);
    expect(pairsOf(state)).toEqual([`${c1}->${c1b}`, `${c2}->${c1b}`, `${c3}->${c3b}`].sort());
  });

  it('a commit the todo DROPPED next to a fixup is not paired with anything', () => {
    const { start, c1, c2, c3 } = threeCommits();
    write('four.ts', 'export const four = 4;\n'); const c4 = commit('feat: four');
    rebaseI(start, '2s/^pick/fixup/;4d');
    const c3b = head();
    const c1b = git('rev-parse', 'HEAD~1');
    const state: any = { sessionCommitShas: [c1, c2, c3, c4], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    __testRescueCommitShas(repo, state);
    const pairs = pairsOf(state);
    expect(pairs.some((p: string) => p.startsWith(c4)), `dropped commit paired: ${pairs}`).toBe(false);
    expect(pairs).toContain(`${c3}->${c3b}`);
    expect(pairs).toContain(`${c1}->${c1b}`);
  });

  it('rebase -i <upstream> <branch> run while on ANOTHER branch', () => {
    const start = head();
    git('checkout', '-q', '-b', 'feat');
    write('one.ts', '1\n'); const c1 = commit('feat: one');
    write('two.ts', '2\n'); const c2 = commit('feat: two');
    write('three.ts', '3\n'); const c3 = commit('feat: three');
    git('checkout', '-q', 'main');
    write('theirs.ts', 'theirs\n'); commit('main moves');
    git('checkout', '-q', '-b', 'other');
    write('other.ts', 'other\n'); commit('other work');
    clock += 60;
    execFileSync('git', ['rebase', '-q', '-i', 'main', 'feat'], {
      cwd: repo, stdio: 'pipe', env: { ...env(), GIT_SEQUENCE_EDITOR: `sed -i.bak -e '2s/^pick/fixup/'`, GIT_EDITOR: 'true' },
    });
    const c3b = head();
    const c1b = git('rev-parse', 'HEAD~1');
    const state: any = { sessionCommitShas: [c1, c2, c3], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    __testRescueCommitShas(repo, state);
    expect(pairsOf(state)).toEqual([`${c1}->${c1b}`, `${c2}->${c1b}`, `${c3}->${c3b}`].sort());
  });

  it('a fixup on a branch whose name is ambiguous with a remote-tracking ref', () => {
    const start = head();
    git('remote', 'add', 'origin', repo);
    git('update-ref', 'refs/remotes/origin/feat', start);
    git('checkout', '-q', '-b', 'origin/feat');
    write('one.ts', '1\n'); const c1 = commit('feat: one');
    write('two.ts', '2\n'); const c2 = commit('feat: two');
    write('three.ts', '3\n'); const c3 = commit('feat: three');
    // `(start)` fast-forwards onto c1, so only the branch's `(finish) … onto`
    // names the base — and that entry is in the ambiguous branch's reflog.
    rebaseI(start, '2s/^pick/fixup/');
    const c3b = head();
    const c1b = git('rev-parse', 'HEAD~1');
    const state: any = { sessionCommitShas: [c1, c2, c3], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    __testRescueCommitShas(repo, state);
    expect(pairsOf(state)).toEqual([`${c1}->${c1b}`, `${c2}->${c1b}`, `${c3}->${c3b}`].sort());
  });

  it('a cherry-pick with a conflict resolution, then the source branch deleted', () => {
    const start = head();
    write('f.ts', 'base f\n'); commit('f');
    const fork = head();
    git('checkout', '-q', '-b', 'side');
    write('f.ts', 'side f\n'); const side = commit('fix: side change');
    git('checkout', '-q', 'main');
    write('f.ts', 'main f\n'); commit('main changes f');
    clock += 60;
    expect(gitMay('cherry-pick', side)).toBe(false);
    write('f.ts', 'resolved f\n'); git('add', '-A');
    execFileSync('git', ['cherry-pick', '--continue'], { cwd: repo, stdio: 'pipe', env: { ...env(), GIT_EDITOR: 'true' } });
    const picked = head();
    git('branch', '-q', '-D', 'side');
    expect(fork).not.toBe(start);
    const state: any = { sessionCommitShas: [side, picked], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    expect(__testRescueCommitShas(repo, state)).toEqual([picked]);
    expect(pairsOf(state)).toEqual([`${side}->${picked}`]);
  });

  it('a reset-away commit is not the source of a cherry-pick of a different commit with its subject', () => {
    const start = head();
    git('checkout', '-q', '-b', 'side');
    write('f.ts', 'side f\n'); const side = commit('wip');
    git('checkout', '-q', 'main');
    write('f.ts', 'thrown away\n'); const wip = commit('wip');
    git('reset', '-q', '--hard', 'HEAD~1');
    write('f.ts', 'main f\n'); commit('main changes f');
    clock += 60;
    expect(gitMay('cherry-pick', side)).toBe(false);
    write('f.ts', 'resolved f\n'); git('add', '-A');
    execFileSync('git', ['cherry-pick', '--continue'], { cwd: repo, stdio: 'pipe', env: { ...env(), GIT_EDITOR: 'true' } });
    const picked = head();
    const state: any = { sessionCommitShas: [wip, picked], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    expect(__testRescueCommitShas(repo, state)).toEqual([wip, picked]);
    expect(pairsOf(state)).toEqual([]);
  });

  it('proves a fixup below the tip in a bounded number of git processes', () => {
    const { start, c1, c2, c3 } = threeCommits();
    git('branch', '-q', 'feature');
    git('reset', '-q', '--hard', start);
    for (let i = 0; i < 60; i++) { write(`theirs-${i}.ts`, `${i}\n`); commit(`chore: theirs ${i}`); }
    git('checkout', '-q', 'feature');
    rebaseI('main', '2s/^pick/fixup/');
    const state: any = { sessionCommitShas: [c1, c2, c3], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    let kept: string[] = [];
    const spawned = gitProcessesDuring(() => { kept = __testRescueCommitShas(repo, state); });
    expect(kept).toHaveLength(2);
    // Measured: main's rescue started 19 for this shape (and paired nothing);
    // this one 20 — the reflog read replaces main's two rev-parses, plus one
    // listing of what the rebase run replayed.
    expect(spawned, `rescue started ${spawned} git processes`).toBeLessThanOrEqual(22);
  }, 60_000);
});

describe('3. the reflog is read through git, not from .git/logs files', () => {
  const amendNewSubjectAndFile = () => {
    const start = head();
    write('a.ts', 'export const a = 1;\n');
    const original = commit('feat: a');
    clock += 60;
    write('b.ts', 'export const b = 1;\n'); git('add', '-A');
    git('commit', '-q', '--amend', '-m', 'feat: a and b');
    return { start, original, amended: head() };
  };

  it('a reftable repo pairs a real amend', () => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
    try { init(['--ref-format=reftable']); } catch { return; /* git without reftable */ }
    expect(fs.existsSync(path.join(repo, '.git', 'reftable'))).toBe(true);
    const { start, original, amended } = amendNewSubjectAndFile();
    const state: any = { sessionCommitShas: [original, amended], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    expect(__testRescueCommitShas(repo, state)).toEqual([amended]);
    expect(pairsOf(state)).toEqual([`${original}->${amended}`]);
  });

  it('a reftable repo proves a fixup below the tip', () => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
    try { init(['--ref-format=reftable']); } catch { return; }
    const start = head();
    write('one.ts', '1\n'); const c1 = commit('feat: one');
    write('two.ts', '2\n'); const c2 = commit('feat: two');
    write('three.ts', '3\n'); const c3 = commit('feat: three');
    rebaseI(start, '2s/^pick/fixup/');
    const c3b = head();
    const c1b = git('rev-parse', 'HEAD~1');
    // All three: [c1, c2] alone ends on c1b's tree, which the reset-squash rule already pairs.
    const state: any = { sessionCommitShas: [c1, c2, c3], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    __testRescueCommitShas(repo, state);
    expect(pairsOf(state)).toEqual([`${c1}->${c1b}`, `${c2}->${c1b}`, `${c3}->${c3b}`].sort());
  });

  it('with core.logAllRefUpdates=false there is no reflog, so no pair', () => {
    git('config', 'core.logAllRefUpdates', 'false');
    for (const f of ['HEAD', 'refs/heads/main']) { try { fs.rmSync(path.join(repo, '.git', 'logs', f)); } catch {} }
    const { start, original, amended } = amendNewSubjectAndFile();
    const state: any = { sessionCommitShas: [original, amended], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    expect(__testRescueCommitShas(repo, state)).toEqual([original, amended]);
    expect(pairsOf(state)).toEqual([]);
  });

  it('an expired reflog proves nothing', () => {
    const { start, original, amended } = amendNewSubjectAndFile();
    git('reflog', 'expire', '--expire=now', '--all');
    const state: any = { sessionCommitShas: [original, amended], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
    expect(__testRescueCommitShas(repo, state)).toEqual([original, amended]);
    expect(pairsOf(state)).toEqual([]);
  });

  it('an amend made in a linked worktree pairs from the main checkout', () => {
    const start = head();
    const wt = `${repo}-wt`;
    git('worktree', 'add', '-q', '-b', 'wt', wt);
    const inWt = (...args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'pipe', env: env() }).toString().trim();
    try {
      fs.writeFileSync(path.join(wt, 'a.ts'), '1\n'); clock += 60; inWt('add', '-A'); inWt('commit', '-qm', 'feat: a');
      const original = inWt('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(wt, 'b.ts'), '2\n'); clock += 60; inWt('add', '-A'); inWt('commit', '-q', '--amend', '-m', 'feat: a+b');
      const amended = inWt('rev-parse', 'HEAD');
      git('checkout', '-q', '--detach', amended);
      const state: any = { sessionCommitShas: [original, amended], repoPath: repo, sessionTag: 'test', headShaAtStart: start };
      expect(__testRescueCommitShas(repo, state)).toEqual([amended]);
    } finally { try { fs.rmSync(wt, { recursive: true, force: true }); } catch {} }
  });
});
