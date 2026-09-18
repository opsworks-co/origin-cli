// When a Codex rollout cannot be parsed, the only token figure left is SQLite's
// single `tokens_used` total. discoverCodexSessionData splits it 70/30 into
// input/output — an assumption, not a reading: output bills at 4-6x input on
// the gpt-5.x family, and the cached share (most of a Codex session's input,
// billed at a tenth) is unknowable. That number used to reach the server as
// MEASURED: Stop's prompt-length fallback only flags `tokensUsed === 0`, and
// this path returns a non-zero total. The dashboard printed it without "est."
// and the benchmark's measured-only metrics counted it.

import { describe, it, expect } from 'vitest';
import { codexSqliteTokenFallback, type CodexSessionData } from '../agents/codex.js';
import { backfillCodexRollout } from '../commands/hooks/stop.js';
import type { ParsedTranscript } from '../transcript.js';

function emptyParsed(over: Partial<ParsedTranscript> = {}): ParsedTranscript {
  return {
    prompts: [], filesChanged: [], tokensUsed: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0,
    promptIndexBase: 0, toolCalls: 0, subagentTokens: 0, subagentEdits: [],
    toolBreakdown: [], filesRead: [], summary: '', model: '', transcript: '',
    ...over,
  } as ParsedTranscript;
}

function codexData(over: Partial<CodexSessionData>): CodexSessionData {
  return { model: 'gpt-5.6', tokensUsed: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, prompt: '', ...over };
}

const state = { prompts: ['do the thing'] } as any;

describe('codexSqliteTokenFallback', () => {
  it('keeps the 70/30 split and flags it as an estimate', () => {
    expect(codexSqliteTokenFallback(100_000)).toEqual({
      tokensUsed: 100_000, inputTokens: 70_000, outputTokens: 30_000, tokensEstimated: true,
    });
  });

  it('does not flag a zero total — Stop owns the no-tokens case', () => {
    const r = codexSqliteTokenFallback(0);
    expect(r.tokensUsed).toBe(0);
    expect('tokensEstimated' in r).toBe(false);
  });

  it('treats a garbage column as zero', () => {
    expect(codexSqliteTokenFallback(Number.NaN).tokensUsed).toBe(0);
    expect(codexSqliteTokenFallback(-5).tokensUsed).toBe(0);
  });
});

describe('backfillCodexRollout carries the estimate flag with the numbers', () => {
  it('flags the parsed totals when it adopts the SQLite fallback', () => {
    const parsed = emptyParsed();
    backfillCodexRollout({
      codexData: codexData(codexSqliteTokenFallback(100_000)),
      parsed, state, displayTranscript: [] as any,
    });
    expect(parsed.tokensUsed).toBe(100_000);
    expect(parsed.tokensEstimated).toBe(true);
  });

  it('leaves a measured rollout unflagged', () => {
    const parsed = emptyParsed();
    backfillCodexRollout({
      codexData: codexData({ tokensUsed: 34_365, inputTokens: 33_247, outputTokens: 1_118, cacheReadTokens: 97_792 }),
      parsed, state, displayTranscript: [] as any,
    });
    expect(parsed.tokensUsed).toBe(34_365);
    expect(parsed.cacheReadTokens).toBe(97_792);
    expect(parsed.tokensEstimated).toBeUndefined();
  });

  it('does not flag usage the transcript reported itself', () => {
    // The fallback's numbers are NOT adopted when the transcript has its own,
    // so its flag must not ride along onto measured counts.
    const parsed = emptyParsed({ tokensUsed: 500, inputTokens: 200, outputTokens: 300 });
    backfillCodexRollout({
      codexData: codexData(codexSqliteTokenFallback(100_000)),
      parsed, state, displayTranscript: [] as any,
    });
    expect(parsed.tokensUsed).toBe(500);
    expect(parsed.tokensEstimated).toBeUndefined();
  });
});
