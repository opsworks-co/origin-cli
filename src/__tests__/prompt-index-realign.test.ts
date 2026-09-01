/**
 * A turn's diff must land on that turn's row.
 *
 * `promptIndex` is a turn's POSITION in `state.prompts`, and the server keys
 * PromptChange rows on it — so an index that is off by one doesn't lose a
 * diff, it hands that diff to a DIFFERENT turn. Two prod sessions:
 *
 *   • 3bfa24e6 — stored 4 prompts against a 6-prompt transcript (the state
 *     file was created after turn 1). `reconcilePromptHistory` fell through to
 *     its concatenation fallback, producing a 10-entry list with every prompt
 *     twice and reporting the current turn as index 9 when it was index 5. The
 *     dashboard showed a read-only investigation turn owning +665 lines and a
 *     commit from a different session's branch.
 *
 *   • c5c94af7 (upplabs.com) — turn 1 ran eight read-only commands (`which`,
 *     `ls`, `cat`, `flyctl`) and held turn 5's 81KB article-editor diff plus a
 *     commit made 88 minutes later.
 *
 * The shared shape: the stored list starts LATE, so it is neither a prefix of
 * the transcript nor an overlap of its tail — the two cases the old rules
 * handled.
 */
import { describe, it, expect } from 'vitest';
import { reconcilePromptHistory, homePromptIndexByText } from '../session-state.js';

describe('reconcilePromptHistory — a late-starting stored list', () => {
  // Verbatim from prod session 3bfa24e6: the state file missed turn 1, and the
  // transcript also carries an interrupt marker the hook never recorded.
  const TRANSCRIPT = [
    'Why AI blame in this session wasnt captured for all prompts with changes',
    'now fix the capture side so shell writes get recorded',
    'merge it and cut the CLI release',
    'now fix the turn-1 mis-stamp',
    '[Request interrupted by user]',
    'Watcher-only agents remain uncovered — Gemini, Antigravity, hookless Cursor.',
  ];
  const STORED = [
    'now fix the capture side so shell writes get recorded',
    'merge it and cut the CLI release',
    'now fix the turn-1 mis-stamp',
    'Watcher-only agents remain uncovered — Gemini, Antigravity, hookless Cursor.',
  ];

  it('adopts the transcript numbering instead of concatenating', () => {
    const out = reconcilePromptHistory(STORED, TRANSCRIPT);
    expect(out).toEqual(TRANSCRIPT);
    // The number that actually mattered: this reported 9 before the fix.
    expect(out.length - 1).toBe(5);
    // …and index 0 stops meaning "turn 2".
    expect(out[0]).toBe(TRANSCRIPT[0]);
  });

  it('keeps a newest prompt the transcript has not flushed yet at the END', () => {
    const pending = 'a brand new prompt';
    const out = reconcilePromptHistory([...STORED, pending], TRANSCRIPT);
    expect(out).toEqual([...TRANSCRIPT, pending]);
    // It must take the NEXT index, never overwrite the last known turn.
    expect(out.length - 1).toBe(6);
  });

  it('still takes the transcript when stored is a plain prefix (ordinary growth)', () => {
    const stored = TRANSCRIPT.slice(0, 3);
    expect(reconcilePromptHistory(stored, TRANSCRIPT)).toEqual(TRANSCRIPT);
  });

  it('still refuses to renumber when the transcript ROLLED and lost its head', () => {
    // The 0a8e2164 case the original rules were written for: the transcript can
    // only see the tail, and adopting it would renumber rows already written.
    const stored = ['p0', 'p1', 'p2', 'p3', 'p4'];
    const rolled = ['p3', 'p4', 'p5'];
    expect(reconcilePromptHistory(stored, rolled)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('never shrinks the index space, whatever the inputs', () => {
    const cases: Array<[string[], string[]]> = [
      [STORED, TRANSCRIPT],
      [['p0', 'p1'], ['p0', 'p1', 'p2']],
      [['p2', 'p3'], ['p0', 'p1', 'p2', 'p3']],
      [['p0', 'p1', 'p2'], ['x', 'y']],
      [['only'], []],
      [[], ['a', 'b']],
    ];
    for (const [stored, parsed] of cases) {
      const out = reconcilePromptHistory(stored, parsed);
      expect(out.length).toBeGreaterThanOrEqual(stored.length);
    }
  });

  it('handles repeated prompt text without duplicating history', () => {
    const transcript = ['start', 'Try again', 'Try again', 'done'];
    const stored = ['Try again', 'Try again', 'done'];
    expect(reconcilePromptHistory(stored, transcript)).toEqual(transcript);
  });
});

describe('homePromptIndexByText — the write-site guard', () => {
  const mappings = [
    { promptIndex: 0, promptText: 'Why AI blame in this session wasnt captured' },
    { promptIndex: 1, promptText: 'now fix the capture side so shell writes get recorded' },
    { promptIndex: 2, promptText: 'merge it and cut the CLI release' },
  ];

  it('keeps the index when the transcript agrees', () => {
    expect(homePromptIndexByText(1, 'now fix the capture side so shell writes get recorded', mappings)).toBe(1);
  });

  it('re-homes to the row whose text matches when the counter is off by one', () => {
    // The exact prod shape: counter says 0, but that row is another turn.
    expect(homePromptIndexByText(0, 'merge it and cut the CLI release', mappings)).toBe(2);
  });

  it('refuses to write when the index belongs to a different turn and nothing matches', () => {
    expect(homePromptIndexByText(0, 'a prompt the transcript never saw', mappings)).toBeNull();
  });

  it('allows the safety net: no mapping at this index means a genuinely new turn', () => {
    expect(homePromptIndexByText(3, 'a brand new prompt', mappings)).toBe(3);
    expect(homePromptIndexByText(0, 'anything', [])).toBe(0);
  });

  it('tolerates truncation and whitespace differences between the two records', () => {
    const truncated = [{ promptIndex: 0, promptText: 'now fix the capture side so shell' }];
    expect(homePromptIndexByText(0, 'now fix the capture side so shell writes get recorded', truncated)).toBe(0);
    const spaced = [{ promptIndex: 0, promptText: 'now fix   the capture\nside' }];
    expect(homePromptIndexByText(0, 'now fix the capture side', spaced)).toBe(0);
  });

  it('prefers the LAST match when the same prompt text repeats', () => {
    const repeated = [
      { promptIndex: 0, promptText: 'Try again' },
      { promptIndex: 1, promptText: 'something else' },
      { promptIndex: 2, promptText: 'Try again' },
    ];
    expect(homePromptIndexByText(1, 'Try again', repeated)).toBe(2);
  });
});
