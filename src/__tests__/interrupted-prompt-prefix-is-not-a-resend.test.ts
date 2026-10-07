/**
 * A short prompt that is the START of a longer one is a different prompt.
 *
 * Prod d027b430 (2026-09-27): the user sent "next task from the list",
 * interrupted it two seconds later — the submit hook never saved it — and sent
 * "next task from the list, 74c99e04 is done already", which it did. The
 * transcript held both. `samePromptText` took any prefix as "same prompt", so
 * `reconcilePromptHistory` matched the interrupted one against the stored
 * long one and then appended the long one AGAIN: `state.prompts` grew a
 * turnId-less index 12 with turn 11's text. The next commit's post-commit
 * attributed itself to that index, and the server grew row 12 holding turn
 * 11's work (+186/-1, the same three files) — flagged by the release gate as
 * identical_change_in_two_turns.
 *
 * The prefix leniency exists for two real producer differences: an image
 * placeholder the hook appends and the transcript does not, and a clipped
 * copy. Both stay one prompt.
 */
import { describe, it, expect } from 'vitest';
import { reconcilePromptHistory, samePromptText, homePromptIndexByText } from '../session-state.js';

const HISTORY = [
  'what are these uncomited changes n prompt 10?',
  'next task from the list',
  'merge and release it yourself',
];
const SHORT = 'next task from the list';
const LONG = 'next task from the list, 74c99e04 is done already';

describe('an interrupted prompt that prefixes the retry', () => {
  it('is not the same prompt as the retry', () => {
    expect(samePromptText(SHORT, LONG)).toBe(false);
    expect(samePromptText(LONG, SHORT)).toBe(false);
  });

  it('reconcile yields the retry once — the interrupted prompt takes its own slot', () => {
    const stored = [...HISTORY, LONG];               // hook never saw SHORT
    const parsed = [...HISTORY, SHORT, LONG];        // transcript has both
    const out = reconcilePromptHistory(stored, parsed);
    expect(out.filter((p) => p === LONG)).toHaveLength(1);
    expect(out).toEqual(parsed);
  });

  it('a later reconcile against the same transcript does not grow the list', () => {
    const stored = [...HISTORY, LONG];
    const parsed = [...HISTORY, SHORT, LONG];
    const once = reconcilePromptHistory(stored, parsed);
    expect(reconcilePromptHistory(once, parsed)).toEqual(once);
  });

  it('the write-site guard does not home the retry onto the interrupted prompt', () => {
    const mappings = [
      { promptIndex: 3, promptText: SHORT },
      { promptIndex: 4, promptText: LONG },
    ];
    expect(homePromptIndexByText(3, LONG, mappings)).toBe(4);
  });
});

describe('the producer differences the prefix rule exists for', () => {
  it('a trailing image placeholder is the same prompt', () => {
    expect(samePromptText('did you understand?', 'did you understand?\n[image]')).toBe(true);
    expect(samePromptText('look at this', 'look at this [Image #1] [Image #2]')).toBe(true);
    expect(samePromptText('look at this', 'look at this [image: "shot.png"]')).toBe(true);
  });

  it('a clipped copy is the same prompt', () => {
    const long = 'x'.repeat(50) + ' ' + 'describe the capture pipeline in detail '.repeat(40);
    expect(samePromptText(long.slice(0, 1000) + '...', long)).toBe(true);
    expect(samePromptText(long.slice(0, 200), long)).toBe(true);
    expect(samePromptText('fix the capture side so shell...', 'fix the capture side so shell writes land')).toBe(true);
  });
});
