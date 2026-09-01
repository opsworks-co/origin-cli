// Cursor session e2c3508a ("Casual chat", repo baton) — three prompts, TWO
// prompt-submit hooks and TWO stop hooks.
//
// The third prompt ("do some more and commit") was typed while turn 2 was
// still generating. Cursor folds such a message into the running generation:
// same requestId in its tracking DB, no `turn_ended` line in the transcript,
// no `beforeSubmitPrompt`, and no `stop` for the turn it interrupted. Between
// turn 2's last edit and turn 3's first, Origin saw no hook at all.
//
// So `state.prompts` still ended in "generate some code" while Cursor wrote
// turn 3's files, and `afterFileEdit` — which named the turn as
// `prompts.length - 1` — filed all of them under turn 2. Turn 2's mapping was
// rebuilt into a window spanning both turns (7 files → 12 → 11), turn 3's
// edits went into the ledger under turn 2, and at Stop the transcript's
// correct 7-file split for turn 2 was overridden by the polluted 12 under
// "a re-capture may only ADD". The dashboard showed "generate some code" with
// 9 files and "do some more and commit" — the turn that made the 11-file
// commit — as a chat-only turn.

import { describe, it, expect } from 'vitest';
import { keepRicherTurnCapture, adoptUnannouncedPrompts } from '../commands/hooks.js';
import type { SessionState } from '../session-state.js';

// What turn 2 ("generate some code") actually wrote: the --vapor transform
// plus the wiring every transform touches.
const TURN2 = [
  'src/vapor.js', 'src/vapor.test.js',
  'src/parseArgs.js', 'src/parseArgs.test.js', 'src/index.js', 'src/index.test.js', 'README.md',
];
// What turn 3 ("do some more and commit") wrote: --upside and --bubble, over
// the same wiring files.
const TURN3 = [
  'src/upside.js', 'src/upside.test.js', 'src/bubble.js', 'src/bubble.test.js',
  'src/parseArgs.js', 'src/parseArgs.test.js', 'src/index.js', 'src/index.test.js', 'README.md',
];

describe('keepRicherTurnCapture — a prior capture that ran past a turn boundary', () => {
  it("does not hand a later turn's files back to the turn that swallowed them", () => {
    // The live path widened turn 2's window across the unannounced boundary.
    const previous = [{ promptIndex: 1, filesChanged: [...TURN2, ...TURN3], diff: 'both turns, 53KB' }];
    const current = [
      { promptIndex: 1, filesChanged: [...TURN2], diff: 'turn 2 only' },
      { promptIndex: 2, filesChanged: [...TURN3], diff: 'turn 3 only' },
    ];
    const [turn2, turn3] = keepRicherTurnCapture(current, previous);
    // upside/bubble belong to turn 3 and stay there.
    expect(turn2.filesChanged?.sort()).toEqual([...TURN2].sort());
    // Files BOTH turns touched are still turn 2's too — they are in its own
    // capture, so the boundary rule never had to decide.
    expect(turn2.filesChanged).toContain('src/index.js');
    // The prior diff describes the files we withheld, so it is not adopted.
    expect(turn2.diff).toBe('turn 2 only');
    expect(turn3.filesChanged?.sort()).toEqual([...TURN3].sort());
  });

  it('still rescues a turn whose own re-capture shrank, when no later turn claims the files', () => {
    const previous = [{ promptIndex: 1, filesChanged: [...TURN2], diff: 'the real turn 2 diff' }];
    const current = [
      { promptIndex: 1, filesChanged: [] as string[], diff: '', chatOnly: true as const },
      { promptIndex: 2, filesChanged: ['src/unrelated.js'], diff: 'turn 3' },
    ];
    const [turn2] = keepRicherTurnCapture(current, previous);
    expect(turn2.filesChanged?.sort()).toEqual([...TURN2].sort());
    expect(turn2.diff).toBe('the real turn 2 diff');
    expect(turn2.chatOnly).toBeUndefined();
  });
});

function cursorState(prompts: string[]): SessionState {
  return {
    sessionId: 'e2c3508a-53a8-448f-a8d2-33177f03e051',
    sessionTag: 'smt9helyw',
    agentSlug: 'cursor',
    prompts: [...prompts],
    promptShadows: [{ promptIndex: 1, shadowSha: 'b8b92ff8', capturedAt: '2026-08-26T02:35:45.361Z' }],
    promptTurnIds: [undefined, 't_83633dafaf1744fe'],
    activeTurn: { index: 1, turnId: 't_83633dafaf1744fe', promptText: 'generate some code', openedAt: '' },
    prePromptSha: 'b8b92ff8',
    prePromptDirtyFiles: ['CLAUDE.md'],
  } as unknown as SessionState;
}

describe('adoptUnannouncedPrompts', () => {
  const ANNOUNCED = ['whatsupp', 'generate some code'];
  const TRANSCRIPT = [...ANNOUNCED, 'do some more and commit'];

  it('binds the edit to the prompt the hooks never announced', () => {
    const state = cursorState(ANNOUNCED);
    const idx = adoptUnannouncedPrompts(state, TRANSCRIPT, () => 'newshadow', {
      now: () => 1787711900000, newId: () => 't_new',
    });
    expect(idx).toBe(2);
    expect(state.prompts).toEqual(TRANSCRIPT);
    // The turn that was open belonged to prompt 1 — close it so nothing else
    // binds it, and give the discovered turn its own stable id.
    expect(state.activeTurn).toBeNull();
    expect(state.lastClosedTurnIndex).toBe(1);
    expect(state.promptTurnIds?.[2]).toBe('t_new');
    expect(state.promptTurnIds?.[1]).toBe('t_83633dafaf1744fe');
    expect(state.currentTurnStartedAt).toBe(1787711900000);
  });

  it("anchors the discovered turn's baseline so it cannot re-claim the previous turn's work", () => {
    const state = cursorState(ANNOUNCED);
    adoptUnannouncedPrompts(state, TRANSCRIPT, () => 'newshadow');
    expect(state.prePromptSha).toBe('newshadow');
    expect(state.prePromptDirtyFiles).toEqual([]);
    expect(state.promptShadows?.find((s) => s.promptIndex === 2)?.shadowSha).toBe('newshadow');
    // Turn 1's baseline is untouched — it already has one.
    expect(state.promptShadows?.find((s) => s.promptIndex === 1)?.shadowSha).toBe('b8b92ff8');
  });

  it('is a no-op when the transcript has not caught up yet', () => {
    const state = cursorState(ANNOUNCED);
    let anchored = 0;
    const idx = adoptUnannouncedPrompts(state, ANNOUNCED, () => { anchored++; return 'newshadow'; });
    expect(idx).toBe(1);
    expect(anchored).toBe(0);
    expect(state.prompts).toEqual(ANNOUNCED);
    expect(state.activeTurn?.index).toBe(1);
    expect(state.prePromptSha).toBe('b8b92ff8');
  });

  it('never renumbers under a turn that is already recorded', () => {
    // The transcript rolled and lost its head: reconcilePromptHistory keeps our
    // numbering and appends only what is genuinely new.
    const state = cursorState(ANNOUNCED);
    const idx = adoptUnannouncedPrompts(state, ['generate some code', 'do some more and commit'], () => null);
    expect(idx).toBe(2);
    expect(state.prompts).toEqual(TRANSCRIPT);
  });

  it('carries on without a baseline when the shadow cannot be cut', () => {
    const state = cursorState(ANNOUNCED);
    const idx = adoptUnannouncedPrompts(state, TRANSCRIPT, () => null);
    expect(idx).toBe(2);
    // No shadow recorded rather than a wrong one — turnBaseline falls back to
    // the session start, which is the honest answer.
    expect(state.promptShadows?.some((s) => s.promptIndex === 2)).toBe(false);
    expect(state.prePromptSha).toBe('b8b92ff8');
  });
});

// The SECOND way a Cursor edit hook arrives with a counter that can't name a
// turn: not "a turn behind", but a state file that never received a prompt at
// all. Session eebcce84 — session-start and the user-prompt-submit auto-create
// raced, the server handed both the same sessionId, and they wrote two tagged
// state files. `findStateForHook` resolved the empty one, so 23 of 23
// after-file-edit fires aborted "no current prompt" and the session's entire
// live capture was lost. It went unnoticed because Stop rebuilt the session
// from the transcript and the finished result looked correct.
describe('adoptUnannouncedPrompts — a state file with no prompts at all', () => {
  it('recovers the turn from the transcript instead of aborting', () => {
    const state = { prompts: [], prePromptSha: 'sessionstart' } as unknown as SessionState;
    const idx = adoptUnannouncedPrompts(state, ['add a --strike transform'], () => 'cutnow', {
      now: () => 1, newId: () => 't_first',
    });
    expect(idx).toBe(0);
    expect(state.promptTurnIds?.[0]).toBe('t_first');
  });

  it('keeps the session-start baseline for a first turn rather than cutting a new one', () => {
    // Cutting a shadow here would swallow everything the turn wrote before we
    // noticed it existed. Nothing has claimed this baseline yet, so it stands.
    const state = { prompts: [], prePromptSha: 'sessionstart' } as unknown as SessionState;
    let anchored = 0;
    adoptUnannouncedPrompts(state, ['add a --strike transform'], () => { anchored++; return 'cutnow'; });
    expect(anchored).toBe(0);
    expect(state.prePromptSha).toBe('sessionstart');
    expect(state.promptShadows ?? []).toEqual([]);
  });
});
