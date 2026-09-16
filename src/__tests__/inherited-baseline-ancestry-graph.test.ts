import { describe, it, expect } from 'vitest';
import { inheritedBaseline, type InheritedWindowDeps } from '../inherited-window-baseline.js';

// inheritedBaseline asked `isAncestor` of every (window commit, own commit)
// pair, and the checkout-boundary fallback of every (own, own) pair — one
// `git merge-base --is-ancestor` spawn each in hooks.ts. A 300-commit window
// the local identity committed ran for minutes. `windowParents` answers the
// same questions from one parent-graph read; these check the answers are the
// same ones, over random windows, and that the per-pair spawns are gone.

type Graph = Map<string, string[]>;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const sha = (i: number) => i.toString(16).padStart(40, 'a');

/** A random DAG, newest first; commit 0 is the baseline, outside the window. */
function randomRepo(seed: number, size: number) {
  const r = rng(seed);
  const parents: Graph = new Map([[sha(0), []]]);
  for (let i = 1; i <= size; i++) {
    const p = [sha(Math.floor(r() * i))];
    if (r() < 0.2 && i > 2) p.push(sha(Math.floor(r() * i)));
    parents.set(sha(i), [...new Set(p)]);
  }
  const ancestors = (x: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [x];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(parents.get(cur) || []));
    }
    return seen;
  };
  const head = sha(size);
  const behindBase = ancestors(sha(0));
  const window = [...ancestors(head)].filter((s) => !behindBase.has(s))
    .sort((a, b) => parseInt(b, 16) - parseInt(a, 16));
  const own = new Set(window.filter(() => r() < 0.5));
  // Half the seeds are a checkout: the turn started on a commit off this line,
  // which sends a window with no inherited commit to the boundary fallback.
  const start = seed % 2 ? sha(0) : 'f'.repeat(40);
  return { parents, ancestors, window, own, head, start };
}

function depsFor(repo: ReturnType<typeof randomRepo>, withGraph: boolean) {
  const calls = { isAncestor: 0 };
  const deps: InheritedWindowDeps = {
    listWindow: () => repo.window,
    isOwnWork: (s) => repo.own.has(s),
    changedFiles: () => [],
    readAtRev: () => null,
    isAncestor: (a, b) => { calls.isAncestor++; return repo.ancestors(b).has(a); },
    baselineCommit: () => repo.start,
    head: () => repo.head,
    firstParent: (s) => repo.parents.get(s)![0],
    ...(withGraph ? { windowParents: () => repo.parents } : {}),
  };
  return { deps, calls };
}

describe('inheritedBaseline ancestry from the window graph', () => {
  it('returns what the per-pair isAncestor walk returns, over random windows', () => {
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const repo = randomRepo(seed, 2 + (seed % 25));
      const pairwise = depsFor(repo, false);
      const graph = depsFor(repo, true);
      const expected = inheritedBaseline(sha(0), pairwise.deps);
      outcomes.add(expected === null ? 'none' : repo.own.size === 0 || !repo.window.includes(expected) ? 'boundary' : 'inherited');
      expect(inheritedBaseline(sha(0), graph.deps), `seed ${seed}`).toBe(expected);
      // At most the fallback's single (start, destination) question remains.
      expect(graph.calls.isAncestor, `seed ${seed}`).toBeLessThanOrEqual(1);
    }
    // Every branch of the walk was compared, not only the empty answer.
    expect([...outcomes].sort()).toEqual(['boundary', 'inherited', 'none']);
  });

  it('a long line of own commits costs no per-pair ancestry spawns', () => {
    const parents: Graph = new Map([[sha(0), []]]);
    for (let i = 1; i <= 300; i++) parents.set(sha(i), [sha(i - 1)]);
    const window = [...parents.keys()].filter((s) => s !== sha(0)).reverse();
    let isAncestorCalls = 0;
    const deps: InheritedWindowDeps = {
      listWindow: () => window,
      isOwnWork: () => true,
      changedFiles: () => [],
      readAtRev: () => null,
      isAncestor: () => { isAncestorCalls++; return true; },
      baselineCommit: () => sha(0),
      head: () => sha(300),
      firstParent: (s) => parents.get(s)![0],
      windowParents: () => parents,
    };
    // First own commit's parent IS the baseline: no checkout boundary.
    expect(inheritedBaseline(sha(0), deps)).toBeNull();
    expect(isAncestorCalls).toBeLessThanOrEqual(1);
  });

  it('falls back to per-pair isAncestor when the graph misses a window commit', () => {
    const repo = randomRepo(7, 20);
    const partial = new Map(repo.parents);
    partial.delete(repo.window[0]);
    const pairwise = depsFor(repo, false);
    const broken = depsFor(repo, true);
    broken.deps.windowParents = () => partial;
    expect(inheritedBaseline(sha(0), broken.deps)).toBe(inheritedBaseline(sha(0), pairwise.deps));
    const throwing = depsFor(repo, true);
    throwing.deps.windowParents = () => { throw new Error('git failed'); };
    expect(inheritedBaseline(sha(0), throwing.deps)).toBe(inheritedBaseline(sha(0), pairwise.deps));
  });
});
