import { describe, it, expect } from 'vitest';
import { keepRicherTurnCapture } from '../commands/hooks.js';

// Prod session 97c78829: ONE user prompt, four Stop fires. Claude Code ends a
// response — and fires Stop — every time a background task reports back, so the
// same promptIndex was re-captured against a baseline that had already moved
// on. The window shrank 5 files → 3 files → "chat-only", and the last capture
// is what shipped. A turn that wrote 5 files and made 2 commits was recorded as
// having done nothing.
describe('keepRicherTurnCapture', () => {
  const FIVE = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

  it('does not let a re-Stop shrink a turn to chat-only', () => {
    const previous = [{ promptIndex: 0, filesChanged: FIVE, diff: 'diff --git a/a.ts b/a.ts\n+x' }];
    const current = [{ promptIndex: 0, filesChanged: [] as string[], diff: '', chatOnly: true as const }];
    const [turn] = keepRicherTurnCapture(current, previous);
    expect(turn.filesChanged).toEqual(FIVE);
    expect(turn.diff).toBe(previous[0].diff);
    expect(turn.chatOnly).toBeUndefined();
  });

  it('unions a partial re-capture with what was already recorded', () => {
    const previous = [{ promptIndex: 0, filesChanged: ['a.ts', 'b.ts'], diff: 'old' }];
    const current = [{ promptIndex: 0, filesChanged: ['b.ts', 'c.ts'], diff: 'newer diff' }];
    const [turn] = keepRicherTurnCapture(current, previous);
    expect(turn.filesChanged?.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    // The later capture describes more of the turn — keep it.
    expect(turn.diff).toBe('newer diff');
  });

  it('lets a genuinely richer re-capture through unchanged', () => {
    const previous = [{ promptIndex: 0, filesChanged: ['a.ts'], diff: 'x' }];
    const current = [{ promptIndex: 0, filesChanged: ['a.ts', 'b.ts'], diff: 'xx longer' }];
    const [turn] = keepRicherTurnCapture(current, previous);
    expect(turn.filesChanged).toEqual(['a.ts', 'b.ts']);
    expect(turn.diff).toBe('xx longer');
  });

  it('leaves turns with no prior record alone', () => {
    const current = [{ promptIndex: 1, filesChanged: [] as string[], diff: '', chatOnly: true as const }];
    const [turn] = keepRicherTurnCapture(current, [{ promptIndex: 0, filesChanged: ['a.ts'], diff: 'x' }]);
    expect(turn.chatOnly).toBe(true);
    expect(turn.filesChanged).toEqual([]);
  });

  it('does not resurrect anything when the prior record was itself empty', () => {
    const current = [{ promptIndex: 0, filesChanged: [] as string[], diff: '', chatOnly: true as const }];
    const [turn] = keepRicherTurnCapture(current, [{ promptIndex: 0, filesChanged: [], diff: '' }]);
    expect(turn.chatOnly).toBe(true);
  });

  it('is a no-op with no previous mappings', () => {
    const current = [{ promptIndex: 0, filesChanged: ['a.ts'], diff: 'x' }];
    expect(keepRicherTurnCapture(current, [])).toBe(current);
  });
});

// A shared checkout means a later capture can legitimately DROP a file for
// being another agent's — that is what the exclusion pass is for. The rescue
// must not hand it back.
describe('keepRicherTurnCapture — excluded files', () => {
  it('does not resurrect a file this Stop excluded as foreign', () => {
    const previous = [{ promptIndex: 0, filesChanged: ['mine.ts', 'theirs.ts'], diff: 'long prior diff' }];
    const current = [{ promptIndex: 0, filesChanged: ['mine.ts'], diff: 'x' }];
    const [turn] = keepRicherTurnCapture(current, previous, ['theirs.ts']);
    expect(turn.filesChanged).toEqual(['mine.ts']);
  });

  it('matches an exclusion by path suffix, not just exact string', () => {
    const previous = [{ promptIndex: 0, filesChanged: ['src/theirs.ts'], diff: 'long prior diff' }];
    const current = [{ promptIndex: 0, filesChanged: [] as string[], diff: '', chatOnly: true as const }];
    const [turn] = keepRicherTurnCapture(current, previous, ['theirs.ts']);
    // Nothing left to rescue, so the current (chat-only) record stands.
    expect(turn.filesChanged).toEqual([]);
    expect(turn.chatOnly).toBe(true);
  });

  it("still rescues the turn's own files when others are excluded", () => {
    const previous = [{ promptIndex: 0, filesChanged: ['mine.ts', 'theirs.ts'], diff: 'long prior diff' }];
    const current = [{ promptIndex: 0, filesChanged: [] as string[], diff: '', chatOnly: true as const }];
    const [turn] = keepRicherTurnCapture(current, previous, ['theirs.ts']);
    expect(turn.filesChanged).toEqual(['mine.ts']);
    expect(turn.chatOnly).toBeUndefined();
  });
});
