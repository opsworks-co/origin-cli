// A lost `promptIndexBase` captures this session's turns TWICE — once at 0..N
// and once at base..base+N — and `completedPromptMappings` keeps both. Every
// Stop re-sends the whole list, so the low copies overwrite rows belonging to
// earlier turns on EVERY write.
//
// Prod f7881a6e: rows 0, 1 and 2 were reset to this session's turns minutes
// after being repaired, three separate times. Restoring the base stopped new
// misnumbering; the copies already in the file kept replaying. A repair cannot
// hold while its own client is replaying the thing it repaired.
import { describe, it, expect } from 'vitest';
import { dropRenumberedDuplicateMappings } from '../session-state.js';

const m = (promptIndex: number, promptText: string) => ({ promptIndex, promptText });

describe('dropRenumberedDuplicateMappings', () => {
  it('drops the low copy of a turn that also exists at or above the base', () => {
    const state = {
      promptIndexBase: 6,
      completedPromptMappings: [
        m(0, 'we done here yet?'),
        m(1, 'fix the session header too'),
        m(6, 'we done here yet?'),
        m(7, 'fix the session header too'),
      ],
    };
    expect(dropRenumberedDuplicateMappings(state)).toBe(2);
    expect(state.completedPromptMappings.map((x) => x.promptIndex)).toEqual([6, 7]);
  });

  it('keeps genuine earlier turns carried across a re-attach', () => {
    // Rows 0-5 belong to this conversation's first run. They are NOT
    // duplicates of anything at or above the base, so they stay.
    const state = {
      promptIndexBase: 6,
      completedPromptMappings: [m(0, 'the very first prompt'), m(6, 'we done here yet?')],
    };
    expect(dropRenumberedDuplicateMappings(state)).toBe(0);
    expect(state.completedPromptMappings).toHaveLength(2);
  });

  it('is inert with no base — nothing has been renumbered', () => {
    const state = {
      promptIndexBase: 0,
      completedPromptMappings: [m(0, 'a'), m(1, 'a')],
    };
    expect(dropRenumberedDuplicateMappings(state)).toBe(0);
  });

  it('ignores empty prompt text rather than collapsing unrelated rows', () => {
    // Two rows with no text are not evidence of anything.
    const state = {
      promptIndexBase: 3,
      completedPromptMappings: [m(0, ''), m(3, '')],
    };
    expect(dropRenumberedDuplicateMappings(state)).toBe(0);
    expect(state.completedPromptMappings).toHaveLength(2);
  });

  it('is a no-op on a state with no mappings', () => {
    expect(dropRenumberedDuplicateMappings({ promptIndexBase: 6 })).toBe(0);
  });
});
