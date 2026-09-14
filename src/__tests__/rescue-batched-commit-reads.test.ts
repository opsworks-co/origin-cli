/**
 * The amend/rebase rescue reads each commit ONCE, not once per orphan.
 *
 * `rescueAmendedCommitShas` runs inside `sessionScopedCommittedDiff`, which the
 * prompt-submit hook calls on every prompt. For each recorded commit HEAD cannot
 * reach, it compared the orphan against every commit in the session window, and
 * each comparison spawned `git show` twice plus a `git show | git patch-id` pair
 * per side, with no memory of the last orphan's answers. A squash-merged session
 * leaves EVERY commit unreachable, so the cost grew with each commit the session
 * made and was paid again on every submit.
 *
 * Measured on this repo (session d18ecaa2, 2026-09-14): 8 unreachable of 12
 * recorded commits, 1,448 git processes, 22 s of a user-prompt-submit hook, the
 * hook Codex kills at 10 s.
 *
 * Driven against REAL git, counting real processes through git's own trace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testRescueCommitShas, __testCommitReads } from '../commands/hooks.js';

let repo: string;
let trace: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-rescue-reads-'));
  trace = path.join(repo, '..', `${path.basename(repo)}-trace2.txt`);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => {
  delete process.env.GIT_TRACE2_PERF;
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(trace, { force: true }); } catch {}
});

/** Top-level git processes started while `fn` ran. */
function gitProcessesDuring(fn: () => void): number {
  try { fs.rmSync(trace, { force: true }); } catch {}
  process.env.GIT_TRACE2_PERF = trace;
  try { fn(); } finally { delete process.env.GIT_TRACE2_PERF; }
  if (!fs.existsSync(trace)) return 0;
  return fs.readFileSync(trace, 'utf-8').split('\n')
    .filter((l) => /\|\s*d0\s*\|/.test(l) && /\|\s*start\s*\|/.test(l)).length;
}

/** Session commits made on a branch that is then deleted: HEAD reaches none. */
function orphanedSessionCommits(start: string, count: number): string[] {
  git('checkout', '-q', '-b', 'squashed-away', start);
  const shas: string[] = [];
  for (let i = 0; i < count; i++) {
    write(`mine-${i}.ts`, `export const mine${i} = ${i};\n`);
    git('add', '-A'); git('commit', '-qm', `feat: my change ${i}`);
    shas.push(git('rev-parse', 'HEAD'));
  }
  git('checkout', '-q', 'main');
  git('branch', '-q', '-D', 'squashed-away');
  return shas;
}

function mainMovesOn(commits: number): void {
  for (let i = 0; i < commits; i++) {
    write(`theirs-${i}.ts`, `export const theirs${i} = ${i};\n`);
    git('add', '-A'); git('commit', '-qm', `chore: someone else's change ${i}`);
  }
}

describe('the rescue reads each commit once', () => {
  it('keeps orphans with no rewrite, without a git process per orphan per window commit', () => {
    const start = git('rev-parse', 'HEAD');
    const orphans = orphanedSessionCommits(start, 4);
    mainMovesOn(60);
    const state: any = { sessionCommitShas: [...orphans], repoPath: repo, sessionTag: 'test', headShaAtStart: start };

    let result: string[] = [];
    const spawned = gitProcessesDuring(() => { result = __testRescueCommitShas(repo, state); });

    // Behaviour: nothing on main is a rewrite of these, so they stay.
    expect(result).toEqual(orphans);
    // Cost: bounded by the batch reads plus a few per orphan, not by
    // orphans x window. Before: 4 orphans x 60 candidates, several spawns each.
    expect(spawned, `rescue started ${spawned} git processes`).toBeLessThan(40);
  }, 60_000);
});

describe('a batched read answers exactly what the per-commit read answers', () => {
  it('for a root commit, a rename, a merge, an empty commit and a dead sha', () => {
    const root = git('rev-parse', 'HEAD');
    write('a.ts', 'export const a = 1;\n'); git('add', '-A'); git('commit', '-qm', 'feat: add a');
    const plain = git('rev-parse', 'HEAD');
    git('mv', 'a.ts', 'b.ts'); git('commit', '-qm', 'refactor: rename a to b');
    const rename = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'side');
    write('side.ts', 'export const side = 1;\n'); git('add', '-A'); git('commit', '-qm', 'feat: side work');
    git('checkout', '-q', 'main');
    write('main.ts', 'export const main = 1;\n'); git('add', '-A'); git('commit', '-qm', 'feat: main work');
    git('merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side');
    const merge = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'chore: empty');
    const empty = git('rev-parse', 'HEAD');
    const dead = 'deadbeef'.repeat(5);

    const shas = [root, plain, rename, merge, empty, dead];
    const { batched, direct } = __testCommitReads(repo, shas);
    for (const sha of shas) {
      expect(batched.shape(sha), `shape ${sha.slice(0, 8)}`).toEqual(direct.shape(sha));
      expect(batched.patchId(sha), `patch-id ${sha.slice(0, 8)}`).toBe(direct.patchId(sha));
      for (const spec of [`${sha}^`, `${sha}^{tree}`, `${sha}^{commit}`]) {
        expect(batched.revParse(spec), spec).toBe(direct.revParse(spec));
      }
    }
    // The cases above are not vacuous.
    expect(direct.patchId(plain)).not.toBe('');
    expect(direct.revParse(`${root}^`)).toBe('');
    expect(direct.shape(rename)?.files).toBe('a.ts\nb.ts');
  });
});
