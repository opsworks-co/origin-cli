// Memory listings read oldest → newest, and are ordered by DATE rather than by
// position in the stored array.
//
// The commit history used to render .slice(-limit).reverse() — newest first,
// directly under a session list that ran oldest first, so one half of the
// output read forwards and the other backwards.
//
// Position is not a safe proxy for time in either list:
//   - writeSessionMemory UPSERTS by sessionId, so a long session that ends last
//     keeps the slot it took when it first wrote. The array tail is the newest
//     session to have STARTED, not the one that ended most recently — which is
//     what buildMemoryContext calls "Most recent".
//   - writeCommitMemory appends, so a catch-up write (a commit an older build
//     never recorded, picked up on a later poll — exactly what the
//     recordedCommitShas work introduced) lands after commits newer than it.

import { describe, it, expect } from 'vitest';
import { sortByDateAsc } from '../memory.js';

const at = (id: string, date: string) => ({ id, date });

describe('sortByDateAsc', () => {
  it('puts entries in chronological order regardless of stored position', () => {
    const stored = [
      at('newest', '2026-08-09T18:00:00.000Z'),
      at('oldest', '2026-08-07T09:00:00.000Z'),
      at('middle', '2026-08-08T12:00:00.000Z'),
    ];
    expect(sortByDateAsc(stored, (e) => e.date).map((e) => e.id))
      .toEqual(['oldest', 'middle', 'newest']);
  });

  it('surfaces the genuinely newest entry as the last element', () => {
    // The upsert case: the long-running session sits FIRST because it wrote
    // first, but it ended last. Taking the array tail would name the wrong one.
    const stored = [
      at('long-session-ended-last', '2026-08-09T20:00:00.000Z'),
      at('short-session-ended-earlier', '2026-08-09T11:00:00.000Z'),
    ];
    const ordered = sortByDateAsc(stored, (e) => e.date);
    expect(ordered[ordered.length - 1].id).toBe('long-session-ended-last');
  });

  it('places a late catch-up write at its real position in history', () => {
    // A commit recorded long after it landed is appended last, but belongs in
    // the middle of the history.
    const stored = [
      at('commit-a', '2026-08-09T10:00:00.000Z'),
      at('commit-c', '2026-08-09T14:00:00.000Z'),
      at('commit-b-recorded-late', '2026-08-09T12:00:00.000Z'),
    ];
    expect(sortByDateAsc(stored, (e) => e.date).map((e) => e.id))
      .toEqual(['commit-a', 'commit-b-recorded-late', 'commit-c']);
  });

  it('is stable for equal timestamps', () => {
    // Two commits in the same second must not shuffle between runs.
    const same = '2026-08-09T10:00:00.000Z';
    const stored = [at('first', same), at('second', same), at('third', same)];
    expect(sortByDateAsc(stored, (e) => e.date).map((e) => e.id))
      .toEqual(['first', 'second', 'third']);
  });

  it('keeps unparseable dates in place rather than flinging them to one end', () => {
    const stored = [
      at('bad', 'not-a-date'),
      at('older', '2026-08-07T09:00:00.000Z'),
      at('newer', '2026-08-09T09:00:00.000Z'),
    ];
    const ids = sortByDateAsc(stored, (e) => e.date).map((e) => e.id);
    expect(ids).toContain('bad');
    expect(ids).toHaveLength(3);
    // The entries that CAN be compared are still ordered correctly.
    expect(ids.indexOf('older')).toBeLessThan(ids.indexOf('newer'));
  });

  it('handles a missing date without throwing', () => {
    const stored = [{ id: 'a' } as { id: string; date?: string }, at('b', '2026-08-09T09:00:00.000Z')];
    expect(() => sortByDateAsc(stored, (e) => e.date)).not.toThrow();
    expect(sortByDateAsc(stored, (e) => e.date)).toHaveLength(2);
  });

  it('does not mutate the caller’s array', () => {
    const stored = [at('b', '2026-08-09T00:00:00.000Z'), at('a', '2026-08-07T00:00:00.000Z')];
    sortByDateAsc(stored, (e) => e.date);
    expect(stored.map((e) => e.id)).toEqual(['b', 'a']);
  });
});
