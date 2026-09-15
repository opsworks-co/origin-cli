import { describe, expect, it } from 'vitest';
import { promptHistoryPayload } from '../prompt-history-payload.js';

describe('write-ahead prompt timeline', () => {
  it('keeps every index including repeated chat-only text without inventing capture evidence', () => {
    const payload = promptHistoryPayload(['work on it', "what's next?", "what's next?"], { promptTurnIds: ['t_a', 't_b', 't_c'] });
    expect(payload.promptChanges).toEqual([
      { promptIndex: 0, promptText: 'work on it', turnId: 't_a' },
      { promptIndex: 1, promptText: "what's next?", turnId: 't_b' },
      { promptIndex: 2, promptText: "what's next?", turnId: 't_c' },
    ]);
  });

  it('uses native server indexes after a resumed session', () => {
    expect(promptHistoryPayload(['resumed', 'next'], { promptIndexBase: 21, promptTurnIds: ['t_21'] }).promptChanges).toEqual([
      { promptIndex: 21, promptText: 'resumed', turnId: 't_21' },
      { promptIndex: 22, promptText: 'next' },
    ]);
  });

  it('carries each turn\'s submit time, so a replay that creates a row does not stamp it late', () => {
    const at = '2026-09-15T20:24:03.557Z';
    expect(promptHistoryPayload(['resumed', 'next'], {
      promptIndexBase: 21, promptTurnIds: ['t_21', 't_22'], promptSubmittedAt: [at],
    }).promptChanges).toEqual([
      { promptIndex: 21, promptText: 'resumed', turnId: 't_21', createdAt: at },
      { promptIndex: 22, promptText: 'next', turnId: 't_22' },
    ]);
  });

  it('caps individual row text while preserving the already-redacted prompt list', () => {
    const text = 'x'.repeat(1200);
    const payload = promptHistoryPayload([text], {});
    expect(payload.prompt).toBe(text);
    expect(payload.promptChanges[0].promptText).toHaveLength(1000);
  });
});
