/**
 * A renumbered prompt list moves each prompt's records with it (TODO b4c19d8f).
 *
 * `reconcilePromptHistory` adopts the transcript's numbering when the
 * transcript holds a prompt no hook recorded AHEAD of prompts we store — the
 * "we started late" shapes (#1102). That is the right numbering: per-prompt
 * edits are extracted by transcript position. But the callers replaced
 * `state.prompts` and left every index-keyed record where it was, so
 * `promptTurnIds[1]` still named the prompt that USED to sit at 1. The server
 * finds a row by turn id first, so the next Stop wrote the newly adopted
 * prompt's content onto the old prompt's row, and each later turn onto its
 * neighbour's. #1938's submit-time recovery keeps Claude Code on plain growth;
 * Cursor and the other agents still reach the adopt path.
 */
import { describe, it, expect } from 'vitest';
import {
  movePromptIdentities, reconcilePromptHistory, reconcilePromptHistoryPlaced, type SessionState,
} from '../session-state.js';
import { adoptUnannouncedPrompts } from '../commands/hooks/after-file-edit.js';

describe('reconcilePromptHistoryPlaced — where each stored prompt lands', () => {
  const cases: Array<[string, string[], string[], number[]]> = [
    ['ordinary growth', ['A', 'B'], ['A', 'B', 'C'], [0, 1]],
    ['a prompt no hook saw, in the middle', ['A', 'Y'], ['A', 'X', 'Y'], [0, 2]],
    ['started late: the head was never recorded', ['B', 'C'], ['A', 'B', 'C'], [1, 2]],
    ['the newest stored prompt not flushed yet', ['A', 'Y'], ['X', 'A'], [1, 2]],
    ['the transcript rolled and lost its head', ['p0', 'p1', 'p2'], ['p1', 'p2', 'p3'], [0, 1, 2]],
    ['the transcript lost a middle prompt (last resort)', ['A', 'B', 'X', 'Y'], ['A', 'B', 'Y', 'Z'], [0, 1, 2, 3]],
    ['nothing stored yet', [], ['A'], []],
    ['nothing parsed', ['A', 'B'], [], [0, 1]],
  ];
  it.each(cases)('%s', (_name, stored, parsed, placed) => {
    const out = reconcilePromptHistoryPlaced(stored, parsed);
    expect(out.placed).toEqual(placed);
    // The list itself is what reconcilePromptHistory always returned.
    expect(out.prompts).toEqual(reconcilePromptHistory(stored, parsed));
    // And each stored prompt really sits where `placed` says.
    stored.forEach((p, i) => expect(out.prompts[placed[i]]).toBe(p));
  });
});

/** A Cursor session: A and Y recorded by hooks, X only in the transcript. */
function storedState(extra: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 's-renumber', agentSlug: 'cursor',
    prompts: ['A', 'Y'],
    promptTurnIds: ['t_A', 't_Y'],
    promptSubmittedAt: ['2026-09-27T10:00:00Z', '2026-09-27T10:05:00Z'],
    promptResponses: ['did A', 'did Y'],
    promptShadows: [{ promptIndex: 0, shadowSha: 'sA' }, { promptIndex: 1, shadowSha: 'sY' }],
    promptWorkTreeShadows: [{ promptIndex: 1, path: '/wt', shadowSha: 'wY' }],
    turnEndShadows: [{ promptIndex: 0, shadowSha: 'eA', capturedAt: 'x' }],
    liveEdits: [{ promptIndex: 1, toolName: 'Write', capturedAt: 'x', edits: [{ file: 'y.ts' }] }],
    shellProbes: [{ promptIndex: 1, tree: '/r', stamps: [] }],
    gitPathspecsByTurn: [{ promptIndex: 1, paths: ['y.ts'] }],
    editHookPathsByTurn: [{ promptIndex: 1, paths: ['y.ts'] }],
    gitMovedFilesByTurn: [{ promptIndex: 0, tree: '/r', files: ['a.ts'] }],
    shellWriteTurns: [1],
    promptsWithoutBaseline: [1],
    activeTurn: { index: 1, turnId: 't_Y', promptText: 'Y', openedAt: 'x' },
    lastClosedTurnIndex: 0,
    completedPromptMappings: [
      { promptIndex: 0, promptText: 'A', filesChanged: ['a.ts'], diff: 'dA', linesAdded: 1, linesRemoved: 0, capturedAt: 'x' },
      { promptIndex: 1, promptText: 'Y', filesChanged: ['y.ts'], diff: 'dY', linesAdded: 2, linesRemoved: 0, capturedAt: 'x' },
    ],
    ...extra,
  } as unknown as SessionState;
}

describe('movePromptIdentities', () => {
  it('moves every record of a prompt the transcript pushed along, and gives the inserted one its own id', () => {
    const state = storedState();
    const { prompts, placed } = reconcilePromptHistoryPlaced(state.prompts, ['A', 'X', 'Y']);
    expect(placed).toEqual([0, 2]);
    expect(movePromptIdentities(state, placed, prompts.length, () => 't_X')).toBe(true);
    state.prompts = prompts;

    // Identity: Y keeps its id at its new index; X is a turn of its own.
    expect(state.promptTurnIds).toEqual(['t_A', 't_X', 't_Y']);
    expect(state.promptSubmittedAt?.[2]).toBe('2026-09-27T10:05:00Z');
    expect(state.promptSubmittedAt?.[1]).toBeUndefined();
    expect(state.promptResponses?.[2]).toBe('did Y');
    // Start/end states and live evidence follow the prompt.
    expect(state.promptShadows?.find((s) => s.shadowSha === 'sY')?.promptIndex).toBe(2);
    expect(state.promptShadows?.find((s) => s.shadowSha === 'sA')?.promptIndex).toBe(0);
    expect(state.promptWorkTreeShadows?.[0].promptIndex).toBe(2);
    expect(state.turnEndShadows?.[0].promptIndex).toBe(0);
    expect(state.liveEdits?.[0].promptIndex).toBe(2);
    expect(state.shellProbes?.[0].promptIndex).toBe(2);
    expect(state.gitPathspecsByTurn?.[0].promptIndex).toBe(2);
    expect(state.editHookPathsByTurn?.[0].promptIndex).toBe(2);
    expect(state.gitMovedFilesByTurn?.[0].promptIndex).toBe(0);
    expect(state.shellWriteTurns).toEqual([2]);
    expect(state.promptsWithoutBaseline).toEqual([2]);
    // The open turn is still Y's.
    expect(state.activeTurn?.index).toBe(2);
    expect(state.lastClosedTurnIndex).toBe(0);
    // Saved rows move too — Y's work is never re-sent at X's index.
    expect(state.completedPromptMappings?.map((m) => [m.promptIndex, m.promptText])).toEqual([[0, 'A'], [2, 'Y']]);
  });

  it('moves saved rows in SERVER numbering on a re-launched session', () => {
    // Base 21: local turn L is server row 21 + L (turn-index.ts).
    const state = storedState({
      promptIndexBase: 21,
      completedPromptMappings: [
        { promptIndex: 21, promptText: 'A', filesChanged: [], diff: '', capturedAt: 'x' },
        { promptIndex: 22, promptText: 'Y', filesChanged: ['y.ts'], diff: 'dY', capturedAt: 'x' },
        // A row from before this launch is not ours to move.
        { promptIndex: 5, promptText: 'older', filesChanged: [], diff: '', capturedAt: 'x' },
      ] as any,
    });
    const { prompts, placed } = reconcilePromptHistoryPlaced(state.prompts, ['A', 'X', 'Y']);
    movePromptIdentities(state, placed, prompts.length, () => 't_X');
    expect(state.completedPromptMappings?.map((m) => m.promptIndex)).toEqual([21, 23, 5]);
    expect(state.promptTurnIds).toEqual(['t_A', 't_X', 't_Y']);
  });

  it('touches nothing when every prompt stayed put', () => {
    const state = storedState();
    const snapshot = JSON.stringify(state);
    const { prompts, placed } = reconcilePromptHistoryPlaced(state.prompts, ['A', 'Y', 'Z']);
    expect(movePromptIdentities(state, placed, prompts.length, () => 'never')).toBe(false);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('started late: the unrecorded head gets its own id and every stored turn shifts one', () => {
    const state = storedState({ prompts: ['B', 'C'], promptTurnIds: ['t_B', 't_C'] } as any);
    const { prompts, placed } = reconcilePromptHistoryPlaced(state.prompts, ['A', 'B', 'C']);
    movePromptIdentities(state, placed, prompts.length, () => 't_A');
    expect(state.promptTurnIds).toEqual(['t_A', 't_B', 't_C']);
  });
});

describe('adoptUnannouncedPrompts after a renumber', () => {
  const cursor = () => storedState({ prePromptSha: 'pre' } as any);

  it('a prompt filled in BEHIND the open turn does not end that turn', () => {
    const state = cursor();
    let anchored = 0;
    const idx = adoptUnannouncedPrompts(state, ['A', 'X', 'Y'], () => { anchored++; return 'cut'; }, { newId: () => 't_X' });
    // The edit belongs to Y, which is still open — at its new index.
    expect(idx).toBe(2);
    expect(state.activeTurn?.index).toBe(2);
    expect(state.promptTurnIds).toEqual(['t_A', 't_X', 't_Y']);
    // Nothing was "discovered": no shadow cut, the open turn keeps its baseline.
    expect(anchored).toBe(0);
    expect(state.promptShadows?.find((s) => s.promptIndex === 2)?.shadowSha).toBe('sY');
  });

  it('a prompt behind AND a new one at the tail: the open turn closes at its new index', () => {
    const state = cursor();
    let n = 0;
    const idx = adoptUnannouncedPrompts(state, ['A', 'X', 'Y', 'Z'], () => 'cut', { newId: () => `t_new${n++}` });
    expect(idx).toBe(3);
    expect(state.lastClosedTurnIndex).toBe(2);
    expect(state.activeTurn).toBeNull();
    expect(state.promptTurnIds?.slice(0, 3)).toEqual(['t_A', 't_new0', 't_Y']);
    expect(state.promptTurnIds?.[3]).toBe('t_new1');
    expect(state.promptShadows?.find((s) => s.promptIndex === 3)?.shadowSha).toBe('cut');
    expect(state.promptShadows?.find((s) => s.promptIndex === 2)?.shadowSha).toBe('sY');
  });

  it('the open prompt the transcript has not flushed yet stays the open turn', () => {
    // Before: `merged` grew, so the stored open prompt was treated as a newly
    // discovered one — its turn closed and a shadow was cut for itself.
    const state = cursor();
    let anchored = 0;
    const idx = adoptUnannouncedPrompts(state, ['X', 'A'], () => { anchored++; return 'cut'; }, { newId: () => 't_X' });
    expect(idx).toBe(2);
    expect(state.prompts).toEqual(['X', 'A', 'Y']);
    expect(state.activeTurn?.index).toBe(2);
    expect(state.promptTurnIds).toEqual(['t_X', 't_A', 't_Y']);
    expect(anchored).toBe(0);
  });
});
