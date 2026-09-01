// The session's committed diff is walked one `git show` PER COMMIT, on every
// commit.
//
// `sessionScopedCommittedDiff` renders each owned sha and joins the results.
// post-commit calls it with no window, so it walks the WHOLE session list —
// commit 30 renders 30 commits, commit 31 renders 31. Each of those shas also
// went through `mergeOwnDiff` -> `commitParents` first, purely to find out
// whether it was a merge, so it was two git spawns per commit, not one.
//
// Measured on this repo through the exported seam: 781ms -> 442ms at 30
// commits, 1572ms -> 955ms at 60. It sits behind `git commit`, so it is latency
// the user waits on, growing for the length of the session.
//
// The fix batches: one `git rev-list --no-walk=unsorted --parents` classifies
// every sha, and consecutive non-merges render in a single `git show`. The
// output feeds the byte budget, the section parsers and the session header, all
// of which read it IN ORDER, so this test pins the ordering — a merge sits
// mid-sequence, which is the case a naive partition would move.
//
// One difference from the old loop is real and deliberate. It `.trim()`ed each
// commit's output before joining, which deleted a trailing blank CONTEXT line
// (a bare " ") off any commit that ended on one. Batched, git keeps it. So the
// guarantee asserted here is the one that matters and not a byte count: same
// sections, same order, same +/- counts, and no difference except those blank
// context lines. A fixture commit below ends on one so this is exercised rather
// than merely claimed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __testSessionScopedCommittedDiff } from '../commands/hooks.js';
import { mergeOwnDiff } from '../history-backfill.js';

let repo: string;
const git = (...a: string[]) =>
  execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();

const shas: string[] = [];
let mergeSha = '';

const commit = (file: string, body: string, msg: string) => {
  fs.writeFileSync(path.join(repo, file), body);
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};

/** Lines a whitespace-only context line, so the one legitimate difference
 *  between the two renderings can be normalised away and everything else
 *  compared strictly. Applied to BOTH sides, so a line the old walk also had
 *  cancels out. */
const dropBlankContext = (t: string) =>
  t.split('\n').filter((l) => l !== ' ').join('\n');

const signLines = (t: string, c: '+' | '-') =>
  t.split('\n').filter((l) => l[0] === c && l.slice(0, 3) !== c + c + c).length;

const sections = (t: string) =>
  t.split('\n').filter((l) => l.startsWith('diff --git '));

/** The pre-batching walk, verbatim: mergeOwnDiff first, else `git show`. */
const perShaWalk = (list: string[]): string => {
  const parts: string[] = [];
  for (const sha of list) {
    const merge = mergeOwnDiff(repo, sha);
    let out: string;
    if (merge) out = merge.diff;
    else {
      try {
        out = execFileSync('git', ['show', sha, '--format=', '--no-color'], {
          cwd: repo, encoding: 'utf-8',
        }).toString().trim();
      } catch { out = ''; }
    }
    if (out) parts.push(out);
  }
  return parts.join('\n').trim();
};

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-batch-walk-')));
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'T');

  fs.writeFileSync(path.join(repo, 'base.ts'), 'export const BASE = 0;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');

  // Four ordinary commits.
  for (let i = 0; i < 4; i++) shas.push(commit(`f${i}.ts`, `export const F${i} = ${i};\n`, `c${i}`));

  // A CONFLICTING merge in the middle — a clean one resolves nothing and so
  // contributes an empty diff, which would hide a reordering bug.
  const mainTip = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'side', mainTip);
  fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const SHARED = "side";\n');
  git('add', '-A'); git('commit', '-q', '-m', 'side');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const SHARED = "main";\n');
  git('add', '-A'); git('commit', '-q', '-m', 'main-shared');
  shas.push(git('rev-parse', 'HEAD'));
  try { git('merge', '-q', '--no-ff', '--no-edit', 'side'); } catch { /* conflict expected */ }
  fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const SHARED = "resolved";\n');
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '--no-edit'], { cwd: repo });
  mergeSha = git('rev-parse', 'HEAD');
  shas.push(mergeSha);

  // …and three more AFTER it, so the merge is genuinely mid-sequence. `f5.ts`
  // is then edited so its last hunk's trailing context is a BLANK line — the
  // exact shape the old per-commit `.trim()` used to eat.
  for (let i = 4; i < 7; i++) shas.push(commit(`f${i}.ts`, `export const F${i} = ${i};\n`, `c${i}`));
  fs.writeFileSync(path.join(repo, 'f5.ts'), 'export const F5 = 5;\nconst TAIL = 1;\n\n');
  git('add', '-A'); git('commit', '-q', '-m', 'f5 gains a trailing blank line');
  shas.push(git('rev-parse', 'HEAD'));
  shas.push(commit('f5.ts', 'export const F5 = 55;\nconst TAIL = 1;\n\n', 'f5 edited above the blank tail'));
  // …and a plain commit after it. The blank-tail commit must not be LAST: the
  // walk trims its own joined result, so a trailing blank on the final commit
  // is stripped either way and the difference would go unexercised.
  shas.push(commit('tail.ts', 'export const TAIL_MARK = 1;\n', 'after the blank tail'));
});
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

const state = (list: string[]) => ({
  sessionId: 'sess-batch',
  sessionTag: 'batch',
  repoPath: repo,
  startedAt: new Date().toISOString(),
  sessionCommitShas: [...list],
}) as any;

describe('the owned-commit walk batches without changing a byte', () => {
  it('has a merge sitting in the middle of the sha list', () => {
    // Guards the fixture: if the merge drifted to an end, the ordering
    // assertion below stops testing anything.
    const at = shas.indexOf(mergeSha);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(shas.length - 1);
    expect(mergeOwnDiff(repo, mergeSha)?.filesChanged).toEqual(['shared.ts']);
  });

  it('has a commit whose diff ends on a blank context line', () => {
    // Guards the fixture: without one, the trim difference below is untested
    // and the normalisation would be vacuous.
    const batched = __testSessionScopedCommittedDiff(repo, state(shas));
    expect(batched).not.toBe(perShaWalk(shas));
    expect(batched.split('\n').filter((l) => l === ' ').length)
      .toBeGreaterThan(perShaWalk(shas).split('\n').filter((l) => l === ' ').length);
  });

  it('renders what the per-commit loop rendered, blank context lines aside', () => {
    const batched = __testSessionScopedCommittedDiff(repo, state(shas));
    const looped = perShaWalk(shas);
    expect(dropBlankContext(batched)).toBe(dropBlankContext(looped));
    // The two things anything downstream actually reads off this text.
    expect(signLines(batched, '+')).toBe(signLines(looped, '+'));
    expect(signLines(batched, '-')).toBe(signLines(looped, '-'));
    expect(sections(batched)).toEqual(sections(looped));
  });

  it('keeps the merge in sequence rather than partitioning it to one end', () => {
    const out = __testSessionScopedCommittedDiff(repo, state(shas));
    const order = [...out.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
    // f0…f3, then the merge's shared.ts, then f4…f6. A partition would push
    // shared.ts to the front or the back.
    expect(order).toEqual([
      'f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'shared.ts', 'shared.ts',
      'f4.ts', 'f5.ts', 'f6.ts', 'f5.ts', 'f5.ts', 'tail.ts',
    ]);
  });

  it('still drops only the missing sha when one is unreachable', () => {
    // A rebase can remove a commit the session recorded. Per-sha, the `git
    // show` for that one threw and the rest survived; batched, one bad sha
    // fails the WHOLE call — so the batch has to fall back to per-sha rather
    // than silently emptying the session's diff.
    const withGhost = [...shas.slice(0, 3), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', ...shas.slice(3)];
    const out = __testSessionScopedCommittedDiff(repo, state(withGhost));
    expect(dropBlankContext(out)).toBe(dropBlankContext(perShaWalk(shas)));
    expect(out).toContain('export const F0 = 0;');
    expect(out).toContain('export const F6 = 6;');
  });

  it('is unchanged for a single-commit session', () => {
    // One sha never enters the batch, so this one IS byte-identical.
    expect(__testSessionScopedCommittedDiff(repo, state([shas[0]])))
      .toBe(perShaWalk([shas[0]]));
  });
});
