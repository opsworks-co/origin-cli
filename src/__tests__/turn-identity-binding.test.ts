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
