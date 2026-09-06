/**
 * A prompt typed mid-turn must not take the running turn's edits.
 *
 * User-reported: "I put prompt 5 in the middle of work of prompt 4, and all
 * output went to prompt 4 — prompt 5 is empty."
 *
 * Ownership used to be `prompts.length - 1`, resolved when an edit landed.
 * user-prompt-submit fires the instant the user hits enter — including for a
 * message QUEUED behind the running turn — so from that moment the tail named
 * the queued prompt and the running turn's remaining edits were filed under a
 * prompt that had not started. Ownership is now bound when a turn OPENS.
 */

import { describe, it, expect } from 'vitest';
import { currentTurnIndex, closeTurn } from '../session-state.js';

type S = Parameters<typeof currentTurnIndex>[0];

const ids = () => {
  let n = 0;
  return () => `t_fixed_${n++}`;
};

describe('currentTurnIndex — the turn that is running', () => {
  it('binds the first turn and keeps it while the turn works', () => {
    const state: S = { prompts: ['do the thing'] };
    expect(currentTurnIndex(state, { newId: ids() })).toBe(0);
    // Same turn, more tool calls — still turn 0.
    expect(currentTurnIndex(state)).toBe(0);
    expect(state.activeTurn?.index).toBe(0);
    expect(state.promptTurnIds?.[0]).toBeTruthy();
  });

  it('does NOT move to a prompt queued while the turn is running', () => {
    const state: S = { prompts: ['prompt four'] };
    expect(currentTurnIndex(state, { newId: ids() })).toBe(0);

    // User types prompt 5 mid-turn: submit appends it, nothing else.
    state.prompts!.push('prompt five');

    // Turn 4 is still working — every remaining edit is still turn 4's.
    expect(currentTurnIndex(state)).toBe(0);
    expect(currentTurnIndex(state)).toBe(0);
  });

  it('binds the queued prompt once the running turn closes', () => {
    const state: S = { prompts: ['prompt four'] };
    currentTurnIndex(state, { newId: ids() });
    state.prompts!.push('prompt five');

    closeTurn(state);
    expect(state.activeTurn).toBeNull();
    expect(currentTurnIndex(state, { newId: ids() })).toBe(1);
  });

  it('runs two queued prompts in order instead of skipping to the tail', () => {
    const state: S = { prompts: ['one'] };
    currentTurnIndex(state, { newId: ids() });
    // Two interjections stack up behind the running turn.
    state.prompts!.push('two', 'three');

    closeTurn(state);
    expect(currentTurnIndex(state, { newId: ids() })).toBe(1); // not 2
    closeTurn(state);
    expect(currentTurnIndex(state, { newId: ids() })).toBe(2);
  });

  it('re-homes when the list renumbers under an open turn', () => {
    // A rolled transcript drops the oldest prompts; the running turn's text
    // is still present but at a different index.
    const state: S = { prompts: ['old one', 'old two', 'the running turn'] };
    expect(currentTurnIndex(state, { newId: ids() })).toBe(2);

    state.prompts = ['the running turn'];
    expect(currentTurnIndex(state)).toBe(0);
    expect(state.activeTurn?.index).toBe(0);
  });

  it('REFUSES rather than guessing when the open turn is gone entirely', () => {
    const state: S = { prompts: ['the running turn'] };
    currentTurnIndex(state, { newId: ids() });

    state.prompts = ['something else entirely'];
    // No text match anywhere → null, so the caller drops the capture instead
    // of writing it onto an unrelated turn.
    expect(currentTurnIndex(state)).toBeNull();
  });

  it('returns null when there are no prompts at all', () => {
    expect(currentTurnIndex({ prompts: [] })).toBeNull();
  });

  it('keeps a turn id stable across the turn', () => {
    const state: S = { prompts: ['a'] };
    currentTurnIndex(state, { newId: ids() });
    const first = state.activeTurn?.turnId;
    currentTurnIndex(state);
    expect(state.activeTurn?.turnId).toBe(first);
    // And the id survives the turn closing — it belongs to the prompt.
    closeTurn(state);
    expect(state.promptTurnIds?.[0]).toBe(first);
  });
});

// A turn that used no tool never opened, so there is nothing for Stop to close
// by `activeTurn.index`. Stop now closes the turn it CAPTURED (the list tail),
// and a prompt arriving with nothing open closes everything before it. Either
// alone is enough; both together survive a missed Stop.
describe('a chat-only turn still advances the sequence', () => {
  const stopCloses = (state: S) =>
    closeTurn(state, state.activeTurn?.index ?? Math.max((state.prompts?.length ?? 0) - 1, 0));
  const submitCloses = (state: S, newTurnIdx: number) => {
    if (!state.activeTurn && newTurnIdx > 0) {
      state.lastClosedTurnIndex = Math.max(state.lastClosedTurnIndex ?? -1, newTurnIdx - 1);
    }
  };

  it('the turn after a chat-only turn binds to ITSELF, not to the chat-only one', () => {
    const state: S = { prompts: ['write the module'] };
    expect(currentTurnIndex(state, { newId: ids() })).toBe(0); // a tool ran
    stopCloses(state);
    expect(state.lastClosedTurnIndex).toBe(0);

    state.prompts!.push('how many lines did you write?'); // chat-only: no tool, no open
    stopCloses(state);
    expect(state.lastClosedTurnIndex, 'Stop must close the turn it captured').toBe(1);

    state.prompts!.push('now change the files and commit');
    // The first tool call of turn 3 — the shell probe, the commit trailer —
    // must name turn 3. Before the fix this was 1: the pointer sat on the
    // chat-only turn and every later write in the session filed one back.
    expect(currentTurnIndex(state)).toBe(2);
  });

  it('closing by `activeTurn.index` alone is exactly the bug', () => {
    const state: S = { prompts: ['write the module'] };
    currentTurnIndex(state, { newId: ids() });
    closeTurn(state, state.activeTurn?.index);
    state.prompts!.push('question');
    closeTurn(state, state.activeTurn?.index); // nothing open → closes nothing
    state.prompts!.push('change and commit');
    expect(currentTurnIndex(state)).toBe(1); // the old behaviour, pinned so the fix is legible
  });

  it('a prompt arriving with nothing open closes the turns before it', () => {
    const state: S = { prompts: ['write the module'] };
    currentTurnIndex(state, { newId: ids() });
    stopCloses(state);
    state.prompts!.push('question'); // its Stop never fires (interrupted)
    state.prompts!.push('change and commit');
    submitCloses(state, 2);
    expect(state.lastClosedTurnIndex).toBe(1);
    expect(currentTurnIndex(state)).toBe(2);
  });

  it('a prompt queued behind an OPEN turn still waits its turn', () => {
    const state: S = { prompts: ['long task'] };
    expect(currentTurnIndex(state, { newId: ids() })).toBe(0);
    state.prompts!.push('queued while the task runs');
    submitCloses(state, 1); // a turn is open → must not close it
    expect(state.lastClosedTurnIndex).toBeUndefined();
    expect(currentTurnIndex(state)).toBe(0);
    stopCloses(state);
    expect(currentTurnIndex(state)).toBe(1);
  });

  it('a re-fired Stop on the same turn does not skip the next one', () => {
    const state: S = { prompts: ['task'] };
    currentTurnIndex(state, { newId: ids() });
    stopCloses(state);
    stopCloses(state); // a task notification re-invoked the model; Stop fired again
    expect(state.lastClosedTurnIndex).toBe(0);
    state.prompts!.push('next');
    expect(currentTurnIndex(state)).toBe(1);
  });
});
