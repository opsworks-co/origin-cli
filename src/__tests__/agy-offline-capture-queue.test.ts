/**
 * Tests for mergePendingPromptChanges — the offline queue that keeps an
 * Antigravity turn's diff when the API is unreachable.
 *
 * The bug it exists for, observed live on 2026-08-10: the agy handler called
 * `api.startSession()` before doing any capture and `return`ed on failure. A
 * ~15-minute network outage spanned turn 1, so all 9 of its PostToolUse fires
 * bailed. Two things went wrong at once:
 *
 *   1. DATA LOSS — turn 1's diff was never captured, and once the baseline
 *      rolls forward no later capture can reproduce it.
 *   2. MIS-ATTRIBUTION — worse, because `lastSyncShadow` never advanced either,
 *      turn 2 diffed against turn 1's STARTING tree and was credited with all
 *      103 of turn 1's lines. It had actually changed one line.
 *
 * Capture is pure git plumbing and needs no network, so it now runs first and
 * only the SEND degrades. This queue holds what was captured until a later fire
 * reaches the server.
 */

import { describe, it, expect } from 'vitest';
import { mergePendingPromptChanges } from '../commands/hooks.js';

const pc = (promptIndex: number, files: string[] = [], extra: Record<string, any> = {}) => ({
  promptIndex,
  promptText: `prompt ${promptIndex}`,
  diff: files.length ? `diff for ${promptIndex}` : '',
  filesChanged: files,
  linesAdded: files.length * 10,
  linesRemoved: 0,
  authoritative: true,
  ...extra,
});

const indices = (out: Array<Record<string, any>>) => out.map((x) => x.promptIndex);

describe('mergePendingPromptChanges', () => {
  it('queues a capture when there is nothing queued yet', () => {
    const out = mergePendingPromptChanges(undefined, [pc(0, ['a.py'])]);
    expect(indices(out)).toEqual([0]);
    expect(out[0].filesChanged).toEqual(['a.py']);
  });

  it('accumulates distinct turns across a multi-turn outage', () => {
    let q = mergePendingPromptChanges(undefined, [pc(0, ['a.py'])]);
    q = mergePendingPromptChanges(q, [pc(1, ['b.py'])]);
    q = mergePendingPromptChanges(q, [pc(2, ['c.py'])]);
    expect(indices(q)).toEqual([0, 1, 2]);
  });

  it('keeps the LATEST capture for a turn — PostToolUse fires many times per turn', () => {
    let q = mergePendingPromptChanges(undefined, [pc(0, ['a.py'])]);
    q = mergePendingPromptChanges(q, [pc(0, ['a.py', 'b.py'])]);
    expect(q).toHaveLength(1);
    expect(q[0].filesChanged).toEqual(['a.py', 'b.py']);
    expect(q[0].linesAdded).toBe(20);
  });

  it('an EMPTY later capture never erases a real one', () => {
    // Mid-turn the tree can momentarily match the baseline (agent reverts a
    // file, then rewrites it). Letting that transient empty capture win would
    // recreate the blank turn this queue exists to prevent.
    let q = mergePendingPromptChanges(undefined, [pc(0, ['a.py'])]);
    q = mergePendingPromptChanges(q, [pc(0, [])]);
    expect(q).toHaveLength(1);
    expect(q[0].filesChanged).toEqual(['a.py']);
    expect(q[0].diff).toBe('diff for 0');
  });

  it('still records a genuinely read-only turn', () => {
    const q = mergePendingPromptChanges(undefined, [pc(3, [])]);
    expect(indices(q)).toEqual([3]);
    expect(q[0].filesChanged).toEqual([]);
  });

  it('preserves the commit link captured offline', () => {
    const q = mergePendingPromptChanges(undefined, [pc(1, ['a.py'], { commitSha: 'abc1234', uncommittedDiff: '' })]);
    expect(q[0].commitSha).toBe('abc1234');
    expect(q[0].uncommittedDiff).toBe('');
  });

  it('returns turns in prompt order regardless of arrival order', () => {
    let q = mergePendingPromptChanges(undefined, [pc(2, ['c.py'])]);
    q = mergePendingPromptChanges(q, [pc(0, ['a.py'])]);
    q = mergePendingPromptChanges(q, [pc(1, ['b.py'])]);
    expect(indices(q)).toEqual([0, 1, 2]);
  });

  it('bounds the queue at 50, dropping the OLDEST turns', () => {
    let q: Array<Record<string, any>> = [];
    for (let i = 0; i < 60; i++) q = mergePendingPromptChanges(q, [pc(i, [`f${i}.py`])]);
    expect(q).toHaveLength(50);
    expect(q[0].promptIndex).toBe(10);
    expect(q[q.length - 1].promptIndex).toBe(59);
  });

  it('ignores malformed entries instead of throwing', () => {
    const q = mergePendingPromptChanges(
      [{ noIndex: true } as any, null as any],
      [pc(0, ['a.py']), undefined as any, { promptIndex: 'x' } as any],
    );
    expect(indices(q)).toEqual([0]);
  });

  it('is idempotent — re-merging the same capture changes nothing', () => {
    const once = mergePendingPromptChanges(undefined, [pc(0, ['a.py']), pc(1, ['b.py'])]);
    const twice = mergePendingPromptChanges(once, [pc(0, ['a.py']), pc(1, ['b.py'])]);
    expect(twice).toEqual(once);
  });
});
