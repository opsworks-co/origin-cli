// Which turn the heartbeat runs Stop for again: the last one, closed by a Stop
// that died before sending it. See closedTurnLeftUnsent.
import { describe, it, expect } from 'vitest';
import { STOP_ABANDONED_AFTER_MS, closedTurnLeftUnsent } from '../turn-commit-scope.js';

const AT = 1_792_427_876_253; // prod fb6968b3's mark, 2026-10-19T16:37:56Z
const LATER = AT + STOP_ABANDONED_AFTER_MS + 1_000;
// fb6968b3's state file as the dead Stop left it.
const fb6968b3 = {
  stopClosing: { turn: 6, at: AT }, stopSentTurnIndex: 5, lastClosedTurnIndex: 6, activeTurn: null,
  prompts: ['a', 'b', 'c', 'd', 'e', 'f', 'can i close this session?'],
};
const none = new Set<number>();

describe('closedTurnLeftUnsent', () => {
  it('picks prod fb6968b3\'s last turn once no Stop can still be running', () => {
    expect(closedTurnLeftUnsent(fb6968b3, none, LATER)).toBe(6);
  });

  it('waits while the Stop may still be running', () => {
    expect(closedTurnLeftUnsent(fb6968b3, none, AT + 5_000)).toBeNull();
  });

  it('leaves a turn whose row went out', () => {
    expect(closedTurnLeftUnsent({ ...fb6968b3, stopSentTurnIndex: 6 }, none, LATER)).toBeNull();
  });

  it('leaves it to a later prompt\'s Stop, which re-sends every turn', () => {
    expect(closedTurnLeftUnsent({ ...fb6968b3, prompts: [...fb6968b3.prompts, 'next'] }, none, LATER)).toBeNull();
    expect(closedTurnLeftUnsent({ ...fb6968b3, activeTurn: { index: 7 } }, none, LATER)).toBeNull();
  });

  it('still picks a tool turn that is the active one', () => {
    expect(closedTurnLeftUnsent({ ...fb6968b3, activeTurn: { index: 6 } }, none, LATER)).toBe(6);
  });

  it('tries each turn once', () => {
    expect(closedTurnLeftUnsent(fb6968b3, new Set([6]), LATER)).toBeNull();
  });

  it('needs a mark', () => {
    expect(closedTurnLeftUnsent({ ...fb6968b3, stopClosing: null }, none, LATER)).toBeNull();
    expect(closedTurnLeftUnsent({ ...fb6968b3, stopClosing: { turn: 6 } }, none, LATER)).toBeNull();
  });
});
