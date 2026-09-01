// The turn window claims a file because it is dirty. This claims a file
// because it was SEEN changing across one command. The difference is the whole
// point: a sibling agent's work is dirty in a shared checkout the entire time
// and never changes across our command, so it is never claimed.
import { describe, it, expect } from 'vitest';
import { probeTree, touchedSince, MAX_PROBED_FILES, type ProbeDeps } from '../shell-command-probe.js';

// A fake tree: file -> {mtimeMs,size}. Mutating it between probes is the test.
function fakeDeps(state: Map<string, { mtimeMs: number; size: number }>): ProbeDeps {
  return {
    listDirty: () => [...state.keys()],
    stat: (_t, f) => state.get(f) ?? null,
  };
}

describe('probeTree / touchedSince', () => {
  it('claims a file the command created', () => {
    const st = new Map([['a.ts', { mtimeMs: 100, size: 10 }]]);
    const before = probeTree('/r', fakeDeps(st));
    st.set('b.ts', { mtimeMs: 200, size: 5 });
    expect(touchedSince(before, probeTree('/r', fakeDeps(st)))).toEqual(['b.ts']);
  });

  it('claims a file the command modified in place', () => {
    const st = new Map([['a.ts', { mtimeMs: 100, size: 10 }]]);
    const before = probeTree('/r', fakeDeps(st));
    st.set('a.ts', { mtimeMs: 300, size: 12 });
    expect(touchedSince(before, probeTree('/r', fakeDeps(st)))).toEqual(['a.ts']);
  });

  it('claims a same-size rewrite, because mtime moved', () => {
    const st = new Map([['a.ts', { mtimeMs: 100, size: 10 }]]);
    const before = probeTree('/r', fakeDeps(st));
    st.set('a.ts', { mtimeMs: 101, size: 10 });
    expect(touchedSince(before, probeTree('/r', fakeDeps(st)))).toEqual(['a.ts']);
  });

  it('IGNORES a sibling agent\'s file that sat dirty and never moved', () => {
    // This is the leak. `sibling.ts` is dirty throughout — the window claims
    // it every turn; the probe never does, because it did not change.
    const st = new Map([
      ['sibling.ts', { mtimeMs: 50, size: 900 }],
      ['mine.ts', { mtimeMs: 100, size: 10 }],
    ]);
    const before = probeTree('/r', fakeDeps(st));
    st.set('mine.ts', { mtimeMs: 400, size: 22 });
    expect(touchedSince(before, probeTree('/r', fakeDeps(st)))).toEqual(['mine.ts']);
  });

  it('does NOT claim files that merely stopped being dirty', () => {
    // `git commit` clears the dirty flag on work an EARLIER command wrote.
    // Crediting it to whichever command ran the commit is borrowed
    // attribution — exactly what this module removes.
    const st = new Map([
      ['a.ts', { mtimeMs: 100, size: 10 }],
      ['b.ts', { mtimeMs: 100, size: 10 }],
    ]);
    const before = probeTree('/r', fakeDeps(st));
    st.delete('a.ts');
    st.delete('b.ts');
    expect(touchedSince(before, probeTree('/r', fakeDeps(st)))).toEqual([]);
  });

  it('claims a deletion, which surfaces as a newly dirty path', () => {
    const st = new Map<string, { mtimeMs: number; size: number }>();
    const before = probeTree('/r', fakeDeps(st));
    // `rm tracked.ts` — git reports it as changed vs HEAD; stat says gone, so
    // the probe records nothing for it and it cannot be claimed. Documented
    // rather than pretended: a pure delete needs the window.
    st.set('tracked.ts', { mtimeMs: 0, size: 0 });
    expect(touchedSince(before, probeTree('/r', fakeDeps(st)))).toEqual(['tracked.ts']);
  });

  it('gives up loudly on an enormous dirty tree', () => {
    const st = new Map<string, { mtimeMs: number; size: number }>();
    for (let i = 0; i <= MAX_PROBED_FILES; i++) st.set(`f${i}.ts`, { mtimeMs: i, size: i });
    const p = probeTree('/r', fakeDeps(st));
    expect(p.skipped).toBe(true);
    // A skipped probe must never read as "nothing was touched" — the caller
    // has to fall back to the window instead of silently claiming zero.
    expect(touchedSince(p, p)).toEqual([]);
  });

  it('gives up when the tree cannot be listed', () => {
    const deps: ProbeDeps = { listDirty: () => { throw new Error('no git'); }, stat: () => null };
    expect(probeTree('/r', deps).skipped).toBe(true);
    expect(probeTree('', fakeDeps(new Map())).skipped).toBe(true);
  });
});
