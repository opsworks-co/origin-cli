/**
 * A turn must be diffed against ITS OWN start-state, not the session's.
 *
 * `promptShadows[i]` ("the working tree at the START of prompt i") is the only
 * per-turn baseline we keep — `prePromptSha` is a single rolling value that
 * describes the most recent turn only. That distinction is invisible until
 * something processes SEVERAL turns in one pass, which Stop does: it had no
 * per-turn baseline to look up and fell back to session-start, so a file two
 * turns both touched counted the earlier turn's lines a second time against
 * the later one.
 *
 * Measured on prod session fc4eb13c, re-captured from its real transcript with
 * the whole-file-write fix (#1132) but a session-start baseline: src/index.js
 * came out +75/-60 against git's +74/-59 — the extra line being the one turn 2
 * changed before turn 3 rewrote the file. Every other file matched git exactly.
 *
 * Until this change only the heartbeat daemon (Codex/Gemini) ever populated
 * promptShadows, so it was empty on every hook-driven session on disk.
 */
import { describe, it, expect } from 'vitest';
import { recordPromptShadow, turnBaseline } from '../session-state.js';

const at = (n: number) => () => `2026-08-22T00:00:0${n}.000Z`;

describe('recordPromptShadow', () => {
  it('records a turn start-state under that turn index', () => {
    const state = {};
    recordPromptShadow(state, 0, 'sha-turn-0', { now: at(0) });
    recordPromptShadow(state, 1, 'sha-turn-1', { now: at(1) });
    expect((state as any).promptShadows).toEqual([
      { promptIndex: 0, shadowSha: 'sha-turn-0', capturedAt: '2026-08-22T00:00:00.000Z' },
      { promptIndex: 1, shadowSha: 'sha-turn-1', capturedAt: '2026-08-22T00:00:01.000Z' },
    ]);
  });

  it('first write wins — a re-fired hook cannot move a turn start-state', () => {
    // The tree has moved on by the time a duplicate submit lands (dual-hook
    // agents fire twice); overwriting would silently re-baseline the turn.
    const state = {};
    recordPromptShadow(state, 0, 'the-real-start');
    recordPromptShadow(state, 0, 'much-later-tree');
    expect((state as any).promptShadows).toHaveLength(1);
    expect((state as any).promptShadows[0].shadowSha).toBe('the-real-start');
  });

  it('ignores a missing sha and a nonsense index rather than storing junk', () => {
    const state = {};
    recordPromptShadow(state, 0, null);
    recordPromptShadow(state, 0, undefined);
    recordPromptShadow(state, 0, '');
    recordPromptShadow(state, -1, 'sha');
    recordPromptShadow(state, 1.5, 'sha');
    expect((state as any).promptShadows ?? []).toHaveLength(0);
  });
});

describe('turnBaseline', () => {
  const session = {
    promptShadows: [
      { promptIndex: 0, shadowSha: 'sha-turn-0', capturedAt: 'x' },
      { promptIndex: 2, shadowSha: 'sha-turn-2', capturedAt: 'x' },
    ],
    sessionStartShadowSha: 'sha-session-start',
    headShaAtStart: 'sha-head',
  };

  it('gives each turn its own start-state', () => {
    expect(turnBaseline(session, 0)).toBe('sha-turn-0');
    expect(turnBaseline(session, 2)).toBe('sha-turn-2');
  });

  it('falls back to session-start for a turn with no shadow', () => {
    // Every session captured before this change, and any turn whose shadow
    // creation failed. Wrong-but-close beats no baseline at all: without one
    // a whole-file write reverts to reading as a whole-file insertion.
    expect(turnBaseline(session, 1)).toBe('sha-session-start');
  });

  it('falls back to HEAD when the tree was clean at session start', () => {
    // sessionStartShadowSha is null when nothing was dirty — HEAD is then the
    // session's real start-state.
    expect(turnBaseline({ sessionStartShadowSha: null, headShaAtStart: 'sha-head' }, 0)).toBe('sha-head');
  });

  it('returns null when the session has no git baseline at all', () => {
    expect(turnBaseline({}, 0)).toBeNull();
  });

  it('never returns a later turn\'s baseline for an earlier turn', () => {
    // The bug this exists to prevent is cross-turn bleed, so assert the
    // negative directly: turn 1 must not borrow turn 2's start-state.
    expect(turnBaseline(session, 1)).not.toBe('sha-turn-2');
  });
});
