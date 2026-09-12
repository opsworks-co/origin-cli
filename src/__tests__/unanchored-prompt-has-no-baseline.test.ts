// A prompt that arrived without a hook run has NO start-state, and the
// session's is not a substitute.
//
// `recordPromptShadow` is only ever called from user-prompt-submit, for the
// prompt that fired it. Session d5cc625b's prompt count jumped twice — 8→10 and
// 10→14 — so prompts arrived between hook runs and were never anchored.
// Nothing recorded that they were missed, so they looked identical to a turn we
// simply have no shadow for and took the session-start fallback.
//
// Diffing a turn from the session's start spans every turn since. On d5cc625b
// turns 2 and 8 that produced diffs whose blob hops duplicated turn 1's byte
// for byte; the read path's echo detector correctly refused them, and both
// turns rendered empty on the dashboard. The capture was wrong, not the render.
//
// The gap cannot be filled later: a shadow made now is the tree as it is NOW,
// not as that prompt found it, and a wrong baseline mis-scopes a turn silently
// where a missing one merely empties it. So the absence is recorded instead.
import { describe, it, expect } from 'vitest';
import { firstUnanchoredPrompt, markSkippedPromptBaselines, recordPromptShadow, turnBaseline } from '../session-state.js';

type S = Parameters<typeof markSkippedPromptBaselines>[0];

const state = (over: Partial<S> = {}): S => ({
  promptShadows: [],
  sessionStartShadowSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  headShaAtStart: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ...over,
});

describe('markSkippedPromptBaselines', () => {
  it('marks the prompts that arrived between hook runs', () => {
    const s = state();
    recordPromptShadow(s, 7, 'cccccccccccccccccccccccccccccccccccccccc');
    // The next hook run sees prompt 9: prompt 8 was never anchored.
    expect(markSkippedPromptBaselines(s, 9)).toEqual([8]);
    expect(s.promptsWithoutBaseline).toEqual([8]);
  });

  it('marks a whole batch — the 10→14 jump', () => {
    const s = state();
    recordPromptShadow(s, 9, 'cccccccccccccccccccccccccccccccccccccccc');
    expect(markSkippedPromptBaselines(s, 13)).toEqual([10, 11, 12]);
  });

  it('marks nothing when every prompt was anchored', () => {
    const s = state();
    recordPromptShadow(s, 0, 'cccccccccccccccccccccccccccccccccccccccc');
    recordPromptShadow(s, 1, 'dddddddddddddddddddddddddddddddddddddddd');
    expect(markSkippedPromptBaselines(s, 2)).toEqual([]);
    expect(s.promptsWithoutBaseline).toBeUndefined();
  });

  it('leaves a conversation adopted mid-flight alone', () => {
    // Nothing anchored yet means this launch has watched nothing arrive. The
    // earlier turns ran before it existed, and they keep the session-start
    // fallback they have always had — inferring a gap there would be a guess
    // about turns we never saw.
    const s = state();
    expect(markSkippedPromptBaselines(s, 12)).toEqual([]);
    expect(turnBaseline(s, 5)).toBe(s.sessionStartShadowSha);
  });

  it('is idempotent — a re-fired hook does not re-mark', () => {
    const s = state();
    recordPromptShadow(s, 7, 'cccccccccccccccccccccccccccccccccccccccc');
    expect(markSkippedPromptBaselines(s, 9)).toEqual([8]);
    expect(markSkippedPromptBaselines(s, 9)).toEqual([]);
    expect(s.promptsWithoutBaseline).toEqual([8]);
  });
});

describe('turnBaseline for an unanchored prompt', () => {
  it('answers null rather than the session start', () => {
    const s = state();
    recordPromptShadow(s, 7, 'cccccccccccccccccccccccccccccccccccccccc');
    markSkippedPromptBaselines(s, 9);
    // The defect, in one line: prompt 8 used to diff from the session's start.
    expect(turnBaseline(s, 8)).toBeNull();
  });

  it('still answers its own shadow for an anchored prompt', () => {
    const s = state();
    recordPromptShadow(s, 7, 'cccccccccccccccccccccccccccccccccccccccc');
    markSkippedPromptBaselines(s, 9);
    expect(turnBaseline(s, 7)).toBe('cccccccccccccccccccccccccccccccccccccccc');
  });

  it('keeps the session-start fallback for a merely ABSENT index', () => {
    // Absence never confers the new behaviour: only an index this launch
    // marked is treated as having no start-state.
    const s = state();
    recordPromptShadow(s, 7, 'cccccccccccccccccccccccccccccccccccccccc');
    markSkippedPromptBaselines(s, 9);
    expect(turnBaseline(s, 42)).toBe(s.sessionStartShadowSha);
  });

  it('falls back to headShaAtStart when there is no start shadow', () => {
    const s = state({ sessionStartShadowSha: null });
    expect(turnBaseline(s, 3)).toBe(s.headShaAtStart);
  });
});

// STOP RECOVERS THE ONE BASELINE THAT SURVIVES.
//
// A prompt whose own hook never finished reaches state only through Stop's
// transcript reconcile. Until `advanceTurnBaselines` fires — which is after
// that reconcile — `prePromptSha` still holds the shadow cut at the end of the
// previous turn, and that IS this turn's start-state. Recovering it is the
// difference between a turn that shows its work and one that shows nothing.
describe('firstUnanchoredPrompt', () => {
  it('names the prompt that owns the rolling baseline', () => {
    const s = state();
    recordPromptShadow(s, 7, 'cccccccccccccccccccccccccccccccccccccccc');
    // Prompt 8's hook died; Stop reconciled it in. It owns prePromptSha.
    expect(firstUnanchoredPrompt(s, 9)).toBe(8);
  });

  it('names the EARLIEST of a batch, not the newest', () => {
    // Several arrived with no Stop between them: the baseline was cut before
    // the first of them, so it is that one's start-state, not the last one's.
    const s = state();
    recordPromptShadow(s, 9, 'cccccccccccccccccccccccccccccccccccccccc');
    expect(firstUnanchoredPrompt(s, 13)).toBe(10);
  });

  it('is null when every prompt is anchored', () => {
    const s = state();
    recordPromptShadow(s, 0, 'cccccccccccccccccccccccccccccccccccccccc');
    recordPromptShadow(s, 1, 'dddddddddddddddddddddddddddddddddddddddd');
    expect(firstUnanchoredPrompt(s, 2)).toBeNull();
  });

  it('is null before the first anchor — the baseline says nothing about those', () => {
    expect(firstUnanchoredPrompt(state(), 12)).toBeNull();
  });
});

describe('Stop recovering then marking, as a sequence', () => {
  it('anchors the earliest hole and marks the rest', () => {
    // The 10→14 jump: prompts 10, 11, 12 arrived unanchored.
    const s = state();
    recordPromptShadow(s, 9, 'cccccccccccccccccccccccccccccccccccccccc');
    const rolling = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

    const owner = firstUnanchoredPrompt(s, 13);
    expect(owner).toBe(10);
    recordPromptShadow(s, owner!, rolling);
    expect(markSkippedPromptBaselines(s, 13)).toEqual([11, 12]);

    // 10 shows its work against a real baseline; 11 and 12 are honestly lost.
    expect(turnBaseline(s, 10)).toBe(rolling);
    expect(turnBaseline(s, 11)).toBeNull();
    expect(turnBaseline(s, 12)).toBeNull();
    // And the anchored one is untouched.
    expect(turnBaseline(s, 9)).toBe('cccccccccccccccccccccccccccccccccccccccc');
  });

  it('marks a hole BELOW the highest anchor — the max()-based scan walked past it', () => {
    const s = state();
    recordPromptShadow(s, 5, 'cccccccccccccccccccccccccccccccccccccccc');
    recordPromptShadow(s, 9, 'dddddddddddddddddddddddddddddddddddddddd');
    // 6,7,8 sit between two anchors; a scan starting after the HIGHEST would
    // never reach them.
    expect(markSkippedPromptBaselines(s, 10)).toEqual([6, 7, 8]);
  });

  it('never marks below the first anchor', () => {
    const s = state();
    recordPromptShadow(s, 5, 'cccccccccccccccccccccccccccccccccccccccc');
    markSkippedPromptBaselines(s, 10);
    // Rows 0-4 predate this launch's first anchor and keep their fallback.
    expect(turnBaseline(s, 3)).toBe(s.sessionStartShadowSha);
  });
});
