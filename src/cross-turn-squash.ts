/**
 * The rewrite targets that commits of MORE THAN ONE turn were folded into —
 * a squash across turns. Lower-cased full shas as recorded in the pairs.
 *
 * Asked of each hop, not only of the final survivor: a squash that was itself
 * rebased afterwards is still where the turns' work merged.
 */
export function crossTurnSquashTargets(
  commitTurns: ReadonlyArray<{ sha?: string; turnId?: string }> | null | undefined,
  pairs: ReadonlyArray<{ from: string; to: string }> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(commitTurns) || !Array.isArray(pairs) || pairs.length === 0) return out;
  const same = (a: string, b: string) => {
    const x = a.toLowerCase(); const y = b.toLowerCase();
    return x === y || x.startsWith(y) || y.startsWith(x);
  };
  const turnsThrough = new Map<string, Set<string>>();
  for (const ct of commitTurns) {
    if (!ct?.sha || !ct.turnId) continue;
    let cur = ct.sha;
    const seen = new Set<string>([cur.toLowerCase()]);
    for (let hops = 0; hops < 32; hops++) {
      const next = pairs.find((p) => p?.from && p?.to && same(p.from, cur) && !same(p.to, cur))?.to;
      if (!next || seen.has(next.toLowerCase())) break;
      seen.add(next.toLowerCase());
      const key = next.toLowerCase();
      turnsThrough.set(key, (turnsThrough.get(key) || new Set<string>()).add(ct.turnId));
      cur = next;
    }
  }
  for (const [to, turnIds] of turnsThrough) if (turnIds.size > 1) out.add(to);
  return out;
}
