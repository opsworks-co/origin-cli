// TODO 61813681: a row's createdAt is flagged as the turn's SUBMIT time only
// when it is one — never on a guess, so the server keeps the first-write window
// for everything else.
import { describe, it, expect } from 'vitest';
import { turnStartFields } from '../turn-index.js';
import { promptChangesForSessionEnd } from '../session-end-payload.js';

describe('turnStartFields', () => {
  it('sends the submit time WITH the flag', () => {
    expect(turnStartFields({ promptSubmittedAt: ['2026-09-20T19:03:56.140Z'], promptIndexBase: 0 }, 0))
      .toEqual({ createdAt: '2026-09-20T19:03:56.140Z', createdAtIsTurnStart: true });
  });

  it('sends nothing when there is no submit time', () => {
    expect(turnStartFields({ promptSubmittedAt: [], promptIndexBase: 0 }, 0)).toEqual({});
    expect(turnStartFields({ promptSubmittedAt: ['not a date'], promptIndexBase: 0 }, 0)).toEqual({});
  });

  it('follows the launch base (server row → local turn)', () => {
    expect(turnStartFields({ promptSubmittedAt: ['2026-09-20T19:03:56Z'], promptIndexBase: 10 }, 10).createdAtIsTurnStart).toBe(true);
    expect(turnStartFields({ promptSubmittedAt: ['2026-09-20T19:03:56Z'], promptIndexBase: 10 }, 0)).toEqual({});
  });
});

describe('the session-end replay', () => {
  it('flags a replayed row whose createdAt it fills from the submit time', () => {
    const rows = promptChangesForSessionEnd({
      prompts: ['a'], promptSubmittedAt: ['2026-09-20T19:03:56Z'], promptIndexBase: 0,
      completedPromptMappings: [{ promptIndex: 0, filesChanged: [] }],
    } as any)!;
    expect(rows[0]).toMatchObject({ createdAt: '2026-09-20T19:03:56Z', createdAtIsTurnStart: true });
  });

  it('leaves a row that already carried its own createdAt unflagged — its meaning is unknown', () => {
    const rows = promptChangesForSessionEnd({
      prompts: ['a'], promptSubmittedAt: ['2026-09-20T19:03:56Z'], promptIndexBase: 0,
      completedPromptMappings: [{ promptIndex: 0, createdAt: '2026-09-20T19:30:00Z' }],
    } as any)!;
    expect(rows[0].createdAtIsTurnStart).toBeUndefined();
  });

  it('keeps the flag on a saved createdAt that IS the submit time, so session end does not clear it', () => {
    const rows = promptChangesForSessionEnd({
      prompts: ['a'], promptSubmittedAt: ['2026-09-20T19:03:56.000Z'], promptIndexBase: 0,
      completedPromptMappings: [{ promptIndex: 0, createdAt: '2026-09-20T19:03:56Z' }],
    } as any)!;
    expect(rows[0].createdAtIsTurnStart).toBe(true);
  });

  it('flags the no-mapping fallback built straight from promptSubmittedAt', () => {
    const rows = promptChangesForSessionEnd({ prompts: ['a'], promptSubmittedAt: ['2026-09-20T19:03:56Z'], promptIndexBase: 0 } as any)!;
    expect(rows[0]).toMatchObject({ createdAt: '2026-09-20T19:03:56Z', createdAtIsTurnStart: true });
  });
});
