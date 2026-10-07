// What each Codex prompt cost, by model.
//
// #1973 gave every Claude Code turn its share of the session's usage; Codex
// turns stayed blank (prod 2026-09-29: 0 of 2 rows on a Codex session). A
// Codex rollout writes a RUNNING token total after every model call, so a
// prompt's share is how much that total grew while it was being answered, on
// the model its turn_context names. The shares add up to the session's counts
// by construction (327 of 327 local rollouts, 2026-09-29).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseCodexRollout, parseCodexRolloutLive, type CodexSessionData } from '../agents/codex.js';
import { backfillCodexRollout } from '../commands/hooks/stop.js';
import { turnModelUsage, modelUsageCovers, type ParsedTranscript } from '../transcript.js';

let dir = '';
let rollout = '';

const meta = () => JSON.stringify({ type: 'session_meta', payload: { id: 't1', cwd: '/repo', source: 'vscode' } });
const context = (model: string) => JSON.stringify({ type: 'turn_context', payload: { turn_id: `turn-${model}`, model } });
const user = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const reply = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
// Running totals: `input` includes the cached part, as OpenAI reports it.
const total = (input: number, cached: number, output: number) => JSON.stringify({
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } },
});
// Codex ≥0.154: ONE call's usage, written just before the running total.
const oneCall = (input: number, cached: number, output: number) => JSON.stringify({
  type: 'token_usage_record',
  payload: { turn_id: 'x', usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-codex-turn-usage-'));
  rollout = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(rollout, [
    meta(),
    context('gpt-6-astra'),
    user('first prompt'),
    total(10_000, 4_000, 300),
    reply('done one'),
    total(25_000, 16_000, 700),
    user('second prompt'),
    context('gpt-6-mini'),
    // One call bigger than the running total so far: read as a total, it
    // made the running figure step backwards.
    oneCall(30_000, 20_000, 100),
    total(55_000, 36_000, 800),
    reply('done two'),
  ].join('\n') + '\n');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('parseCodexRollout divides the session among its prompts', () => {
  it('gives each prompt the growth of the running total, on its turn\'s model', () => {
    const r = parseCodexRollout(dir, rollout, '')!;
    expect(r.userPrompts).toEqual(['first prompt', 'second prompt']);
    expect(r.turnUsage).toEqual([
      { promptIndex: 0, modelUsage: [{ model: 'gpt-6-astra', inputTokens: 9_000, cacheReadTokens: 16_000, outputTokens: 700, cacheCreationTokens: 0, cacheCreation1hTokens: 0 }] },
      { promptIndex: 1, modelUsage: [{ model: 'gpt-6-mini', inputTokens: 10_000, cacheReadTokens: 20_000, outputTokens: 100, cacheCreationTokens: 0, cacheCreation1hTokens: 0 }] },
    ]);
  });

  it('adds up to the session counts, by model and by prompt', () => {
    const r = parseCodexRollout(dir, rollout, '')!;
    const totals = { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens ?? 0, cacheCreationTokens: 0 };
    expect(totals).toEqual({ inputTokens: 19_000, outputTokens: 800, cacheReadTokens: 36_000, cacheCreationTokens: 0 });
    expect(modelUsageCovers(r.modelUsage!, totals)).toBe(true);
    expect(modelUsageCovers(r.turnUsage!.flatMap((t) => t.modelUsage), totals)).toBe(true);
  });

  it('does not read one call\'s usage as the running total', () => {
    // The session figure is unchanged by the record, in both parsers.
    const stop = parseCodexRollout(dir, rollout, '')!;
    const live = parseCodexRolloutLive(rollout)!;
    for (const r of [stop, live]) {
      expect({ i: r.inputTokens, o: r.outputTokens, c: r.cacheReadTokens }).toEqual({ i: 19_000, o: 800, c: 36_000 });
    }
  });

  it('leaves no split when a running total shrinks', () => {
    fs.appendFileSync(rollout, [user('third'), total(56_000, 30_000, 900)].join('\n') + '\n');
    const r = parseCodexRollout(dir, rollout, '')!;
    expect(r.modelUsage).toBeUndefined();
    expect(r.turnUsage).toBeUndefined();
  });
});

function emptyParsed(): ParsedTranscript {
  return {
    prompts: [], filesChanged: [], tokensUsed: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0,
    promptIndexBase: 0, toolCalls: 0, subagentTokens: 0, subagentEdits: [],
    toolBreakdown: [], filesRead: [], summary: '', model: '', transcript: '',
  } as unknown as ParsedTranscript;
}

function fromRollout(): CodexSessionData {
  const r = parseCodexRollout(dir, rollout, '')!;
  return {
    model: r.model!, tokensUsed: r.tokensUsed, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens, toolCalls: r.toolCalls, prompt: '', prompts: r.userPrompts,
    modelUsage: r.modelUsage, turnUsage: r.turnUsage,
  };
}

describe('Stop sends each Codex row its share', () => {
  it('adopts the split with the rollout\'s counts, numbered like the rows', () => {
    const parsed = emptyParsed();
    const state = { prompts: [] as string[] } as any;
    backfillCodexRollout({ codexData: fromRollout(), parsed, state, displayTranscript: [] as any });
    expect(state.prompts).toEqual(['first prompt', 'second prompt']);
    expect(turnModelUsage(parsed, 0)).toEqual([expect.objectContaining({ model: 'gpt-6-astra', inputTokens: 9_000 })]);
    expect(turnModelUsage(parsed, 1)).toEqual([expect.objectContaining({ model: 'gpt-6-mini', inputTokens: 10_000 })]);
  });

  it('sends nothing per row when the session\'s prompt list is not the rollout\'s', () => {
    // Three prompts known from hooks, two in the rollout: positions would not
    // name the same rows.
    const parsed = emptyParsed();
    const state = { prompts: ['a', 'b', 'c'] } as any;
    backfillCodexRollout({ codexData: fromRollout(), parsed, state, displayTranscript: [] as any });
    expect(parsed.inputTokens).toBe(19_000);
    expect(turnModelUsage(parsed, 0)).toBeUndefined();
  });

  it('sends nothing per row when the transcript had its own counts', () => {
    const parsed = { ...emptyParsed(), tokensUsed: 500, inputTokens: 200, outputTokens: 300 } as ParsedTranscript;
    const state = { prompts: [] as string[] } as any;
    backfillCodexRollout({ codexData: fromRollout(), parsed, state, displayTranscript: [] as any });
    expect(parsed.turnUsage).toBeUndefined();
  });
});
