// A renumbering must not leave every prompt on the page twice.
//
// Prod 8a626742 stored SEVEN prompts as FOURTEEN rows: 0..6 carrying every
// diff, commit and turnId, and 8..14 empty and turnId-less. The offset is 8 —
// `buildSessionWriteData`'s `m.promptIndex + 1` on top of a base of 7, after
// all seven turns were miscounted as pre-session.
//
// `dropRenumberedDuplicateMappings` is the guard for exactly that shape and it
// could not help: it returns early on `base <= 0`, and it keeps whichever copy
// sits at or above the base — which here is the EMPTY set, so firing would have
// destroyed the session's real capture instead of the phantom.
import { describe, it, expect } from 'vitest';
import { dropRenumberedDuplicateMappings } from '../session-state.js';

/** A turn that captured something. */
const work = (promptIndex: number, promptText: string) => ({
  promptIndex, promptText,
  filesChanged: ['src/a.ts'],
  diff: 'diff --git a/src/a.ts b/src/a.ts\n+one\n',
  commitSha: 'abc1234',
});

/** Its phantom twin: same words, nothing behind them. */
const empty = (promptIndex: number, promptText: string) => ({
  promptIndex, promptText, filesChanged: [], diff: '',
});

const PROMPTS = [
  'Check if the code in here and github and deployed to prod is the same',
  'export those 3 articles and commit them to the repo',
  'deploy it',
  'fix the read time bug',
  'fix the section padding on the other pages too',
  'all done here?',
  'push to github and that\'s it',
];

/** The prod shape: 0..6 real, 8..14 phantom. */
const session8a626742 = () => ({
  promptIndexBase: 0,   // LOST — which is what disabled the old guard
  completedPromptMappings: [
    ...PROMPTS.map((t, i) => work(i, t)),
    ...PROMPTS.map((t, i) => empty(i + 8, t)),
  ],
});

describe('dropRenumberedDuplicateMappings — workless twins', () => {
  it('drops the phantom set and keeps every real capture (prod 8a626742)', () => {
    const state = session8a626742();
    const dropped = dropRenumberedDuplicateMappings(state);

    expect(dropped).toBe(7);
    const left = state.completedPromptMappings;
    expect(left).toHaveLength(7);
    // The survivors are the ones holding the work, NOT the higher indices.
    expect(left.map((m) => m.promptIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(left.every((m) => (m.diff || '').length > 0)).toBe(true);
  });

  it('fires even though the base is lost — the case the old guard bailed on', () => {
    const state = session8a626742();
    expect(state.promptIndexBase).toBe(0);
    expect(dropRenumberedDuplicateMappings(state)).toBe(7);
  });

  it('keeps a genuinely repeated prompt whose second turn did nothing', () => {
    // A user can say "deploy it" twice and mean it. One isolated pair is not
    // an arithmetic renumbering, so nothing may be dropped.
    const state = {
      promptIndexBase: 0,
      completedPromptMappings: [
        work(0, 'deploy it'),
        work(1, 'fix the tests'),
        empty(2, 'deploy it'),
      ],
    };
    expect(dropRenumberedDuplicateMappings(state)).toBe(0);
    expect(state.completedPromptMappings).toHaveLength(3);
  });

  it('keeps both copies when each carries work', () => {
    // Two real turns on the same words are two real turns, at any offset.
    const state = {
      promptIndexBase: 0,
      completedPromptMappings: [
        work(0, 'deploy it'), work(1, 'again'),
        work(8, 'deploy it'), work(9, 'again'),
      ],
    };
    expect(dropRenumberedDuplicateMappings(state)).toBe(0);
    expect(state.completedPromptMappings).toHaveLength(4);
  });

  it('requires a CONSISTENT offset, not just two empty duplicates', () => {
    // Two repeats at unrelated distances are coincidence, not a shift.
    const state = {
      promptIndexBase: 0,
      completedPromptMappings: [
        work(0, 'deploy it'), work(1, 'run tests'),
        empty(3, 'deploy it'), empty(9, 'run tests'),
      ],
    };
    expect(dropRenumberedDuplicateMappings(state)).toBe(0);
  });

  it('still applies the original base rule when both copies carry work', () => {
    // prod f7881a6e: the low copies were live resets of this session's turns,
    // not empty shells, and the base is known. That path must not regress.
    const state = {
      promptIndexBase: 6,
      completedPromptMappings: [
        work(0, 'first'), work(1, 'second'),
        work(6, 'first'), work(7, 'second'),
      ],
    };
    expect(dropRenumberedDuplicateMappings(state)).toBe(2);
    expect(state.completedPromptMappings.map((m) => m.promptIndex)).toEqual([6, 7]);
  });

  it('leaves a clean session untouched', () => {
    const state = {
      promptIndexBase: 0,
      completedPromptMappings: PROMPTS.map((t, i) => work(i, t)),
    };
    expect(dropRenumberedDuplicateMappings(state)).toBe(0);
    expect(state.completedPromptMappings).toHaveLength(7);
  });
});
