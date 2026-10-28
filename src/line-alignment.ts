// ---------------------------------------------------------------------------
// Origin CLI — proof-grade line alignment
// ---------------------------------------------------------------------------
// One primitive shared by every reader and writer that has to say "this line
// of text A IS that line of text B": the OR-45 producer (replayed state →
// commit blob) and the OR-46 re-anchor (source blob → later blob).
//
// It knows nothing about agents, notes, records or git. It takes two arrays of
// lines, a size bound and an optional tick the caller uses to enforce its own
// deadline (the tick throws; this module does not catch).
// ---------------------------------------------------------------------------

export interface MandatoryAlignmentOptions {
  /**
   * Past this many lines on either side nothing is aligned (every entry -1).
   * The tables are Uint16, so a bound above 65535 is clamped to it.
   */
  maxLines: number;
  /** Called once per row of each table and of the pair scan; throw to abort. */
  tick?: () => void;
}

const UINT16_MAX = 0xffff;

/**
 * The pairs every optimal line alignment of `a` onto `b` agrees on. Returns,
 * per line of `a`, its index in `b`, or -1 when some longest-common-subsequence
 * alignment leaves the line unpaired or pairs it with a different line of `b`.
 *
 * With `pre[i][j]` = LCS(a[..i), b[..j)), `suf[i][j]` = LCS(a[i..), b[j..)) and
 * L the LCS length, line i is paired with j in EVERY optimal alignment iff
 *   (a) no optimal alignment skips it: max_j pre[i][j] + suf[i+1][j] < L, and
 *   (b) exactly one j has a[i] = b[j] and pre[i][j] + 1 + suf[i+1][j+1] = L
 *       (a pair lies on some optimal alignment iff that sum reaches L).
 * This is a proof over all optimal alignments, not a comparison of two
 * tie-breaks: repeated content that could pair either way maps to -1.
 *
 * Cost is two (|a|+1)×(|b|+1) Uint16 tables: at the OR-45 bound of 4001 lines
 * a side, about 64 MB.
 */
export function mandatoryAlignment(a: readonly string[], b: readonly string[], opts: MandatoryAlignmentOptions): number[] {
  const map = new Array<number>(a.length).fill(-1);
  const n = a.length;
  const m = b.length;
  const bound = Math.min(opts.maxLines, UINT16_MAX);
  if (n > bound || m > bound) return map;
  const tick = opts.tick ?? (() => {});

  // Compare small integers, not strings, in the O(n·m) loops.
  const ids = new Map<string, number>();
  const idOf = (line: string) => { let id = ids.get(line); if (id === undefined) ids.set(line, id = ids.size); return id; };
  const ai = Int32Array.from(a, idOf);
  const bi = Int32Array.from(b, idOf);

  const w = m + 1;
  const pre = new Uint16Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    tick();
    for (let j = 1; j <= m; j++) {
      pre[i * w + j] = ai[i - 1] === bi[j - 1]
        ? pre[(i - 1) * w + j - 1] + 1
        : Math.max(pre[(i - 1) * w + j], pre[i * w + j - 1]);
    }
  }
  const suf = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    tick();
    for (let j = m - 1; j >= 0; j--) {
      suf[i * w + j] = ai[i] === bi[j]
        ? suf[(i + 1) * w + j + 1] + 1
        : Math.max(suf[(i + 1) * w + j], suf[i * w + j + 1]);
    }
  }
  const total = pre[n * w + m];

  for (let i = 0; i < n; i++) {
    tick();
    let skippable = false;
    for (let j = 0; j <= m && !skippable; j++) {
      if (pre[i * w + j] + suf[(i + 1) * w + j] === total) skippable = true;
    }
    if (skippable) continue;
    let only = -1;
    let count = 0;
    for (let j = 0; j < m && count < 2; j++) {
      if (ai[i] === bi[j] && pre[i * w + j] + 1 + suf[(i + 1) * w + j + 1] === total) { only = j; count++; }
    }
    if (count === 1) map[i] = only;
  }
  return map;
}
