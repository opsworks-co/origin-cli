// The shared proof-grade line alignment (OR-46 checkpoint 1). The OR-45
// producer's own behaviour on top of it stays pinned by
// attribution-line-ranges.test.ts; these tests pin the primitive alone.
import { describe, it, expect } from 'vitest';
import { mandatoryAlignment } from '../line-alignment.js';

const align = (a: string[], b: string[], maxLines = 4001) => mandatoryAlignment(a, b, { maxLines });

describe('mandatoryAlignment', () => {
  it('pairs every line of identical texts with itself, repeated lines included', () => {
    expect(align(['x', 'x', 'y'], ['x', 'x', 'y'])).toEqual([0, 1, 2]);
  });

  it('follows an insertion above: lines shift, nothing is lost', () => {
    expect(align(['a', 'b', 'c'], ['new', 'a', 'b', 'c'])).toEqual([1, 2, 3]);
  });

  it('drops a changed line and keeps its unchanged neighbours', () => {
    expect(align(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([0, -1, 2]);
  });

  it('refuses both copies of a duplicated line when one was deleted', () => {
    // [s, d, d, e] → [s, d, e]: either d may be the survivor.
    expect(align(['s', 'd', 'd', 'e'], ['s', 'd', 'e'])).toEqual([0, -1, -1, 2]);
  });

  it('refuses identical blocks that swapped places', () => {
    // Either half could be the one that stayed put.
    expect(align(['a', 'b', 'c', 'd'], ['c', 'd', 'a', 'b'])).toEqual([-1, -1, -1, -1]);
  });

  it('pins a duplicate whose position is forced by its neighbours', () => {
    expect(align(['d', 'x', 'd'], ['d', 'x', 'd', 'tail'])).toEqual([0, 1, 2]);
  });

  it('aligns nothing past the bound on either side', () => {
    expect(align(['a', 'b'], ['a', 'b', 'c'], 2)).toEqual([-1, -1]);
    expect(align(['a', 'b', 'c'], ['a', 'b'], 2)).toEqual([-1, -1, -1]);
  });

  it('never exceeds the Uint16 tables, whatever bound the caller passes', () => {
    const big = Array.from({ length: 70_000 }, (_, i) => `l${i}`);
    expect(mandatoryAlignment(big, ['l0'], { maxLines: 1_000_000 }).every((j) => j === -1)).toBe(true);
  });

  it('lets the caller abort through tick, mid-table', () => {
    let calls = 0;
    const tick = () => { if (++calls > 3) throw new Error('deadline'); };
    expect(() => mandatoryAlignment(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e'], { maxLines: 10, tick })).toThrow('deadline');
  });
});
