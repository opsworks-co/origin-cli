// Estimated per-turn cost for the agents that record no usage per reply.
//
// Cursor and Antigravity have only a session estimate from text length;
// Copilot has output per reply but input and cache only as a session total.
// Each is divided among the prompts by what that prompt's model calls sent and
// produced, in whole tokens that add up to the session exactly (214 of 214
// local Cursor sessions, 144 of 144 Antigravity, 18 of 18 Copilot, 2026-09-29),
// and marked as an estimate all the way to the turn card.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { splitByWeights, estimateTurnUsage, parseTranscript, applyEstimatedSplit, turnModelUsage, modelUsageCovers } from '../transcript.js';
import { parseAntigravityTranscript, estimateAntigravityUsage } from '../antigravity-transcript.js';

describe('splitByWeights', () => {
  it('divides in whole tokens that add up exactly', () => {
    expect(splitByWeights(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(splitByWeights(7, [0, 5, 2])).toEqual([0, 5, 2]);
    expect(splitByWeights(1_000_003, [3, 1]).reduce((a, b) => a + b, 0)).toBe(1_000_003);
  });

  it('shares equally when nothing is weighed', () => {
    expect(splitByWeights(9, [0, 0, 0])).toEqual([3, 3, 3]);
    expect(splitByWeights(5, [])).toEqual([]);
  });
});

describe('estimateTurnUsage', () => {
  it('splits each component by its own weights, falling back to all three', () => {
    const turns = estimateTurnUsage(
      { inputTokens: 100, outputTokens: 30, cacheReadTokens: 900, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
      '', { input: [1, 3], output: [2, 1], cache: [0, 0] }, 5,
    )!;
    expect(turns.map((t) => t.promptIndex)).toEqual([5, 6]);
    expect(turns.map((t) => t.modelUsage[0].inputTokens)).toEqual([25, 75]);
    expect(turns.map((t) => t.modelUsage[0].outputTokens)).toEqual([20, 10]);
    // No cache weights: the three together (3 and 4).
    expect(turns.map((t) => t.modelUsage[0].cacheReadTokens)).toEqual([386, 514]);
  });
});

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-estimated-usage-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('Cursor: the session estimate divided by what each turn sent and produced', () => {
  it('gives the longer turn more, flags it, and adds up to the session', () => {
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nshort\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nnow a much longer request with a lot more to it\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(400) }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(400) }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const p = parseTranscript(f);
    expect(p.prompts).toHaveLength(2);
    // What the Cursor estimator gave the session (agents/cursor.ts).
    Object.assign(p, { inputTokens: 1_000, outputTokens: 300, cacheReadTokens: 20_000, tokensUsed: 1_300 });
    applyEstimatedSplit(p);
    expect(p.turnUsageEstimated).toBe(true);
    const [one, two] = [turnModelUsage(p, 0)!, turnModelUsage(p, 1)!];
    expect(one[0].model).toBe('');
    expect(two[0].outputTokens).toBeGreaterThan(one[0].outputTokens);
    expect(two[0].cacheReadTokens).toBeGreaterThan(one[0].cacheReadTokens);
    expect(modelUsageCovers(p.turnUsage!.flatMap((t) => t.modelUsage), p)).toBe(true);
  });

  it('gives nothing to split when the session has no estimate', () => {
    const f = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(f, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nhi\n</user_query>' }] } }) + '\n');
    const p = parseTranscript(f);
    applyEstimatedSplit(p);
    expect(p.turnUsage).toBeUndefined();
  });
});

describe('Antigravity: characters per turn', () => {
  const step = (o: Record<string, unknown>) => JSON.stringify(o);
  it('counts each turn\'s text, text before the first prompt going to it, and adds up to the session', () => {
    const t = parseAntigravityTranscript([
      step({ source: 'SYSTEM', type: 'EPHEMERAL_MESSAGE', content: 's'.repeat(100) }),
      step({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nfirst\n</USER_REQUEST>', created_at: '2026-09-29T10:00:00Z' }),
      step({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'a'.repeat(40) }),
      step({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nsecond\n</USER_REQUEST>', created_at: '2026-09-29T10:05:00Z' }),
      step({ source: 'MODEL', type: 'VIEW_FILE', content: 'f'.repeat(500) }),
      step({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'b'.repeat(80) }),
    ].join('\n'));
    expect(t.prompts).toEqual(['first', 'second']);
    expect(t.promptInputChars).toEqual([100 + 'first'.length, 'second'.length + 500]);
    expect(t.promptOutputChars).toEqual([40, 80]);
    expect(t.promptInputChars.reduce((a, b) => a + b, 0)).toBe(t.inputChars);
    expect(t.promptOutputChars.reduce((a, b) => a + b, 0)).toBe(t.outputChars);
    const u = estimateAntigravityUsage(t);
    const turns = estimateTurnUsage({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0 }, '', { input: t.promptInputChars, output: t.promptOutputChars, cache: [] })!;
    expect(turns.reduce((a, x) => a + x.modelUsage[0].inputTokens, 0)).toBe(u.inputTokens);
  });

  it('keeps each turn\'s counts with it when turns are re-sorted by time', () => {
    const t = parseAntigravityTranscript([
      step({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nlater\n</USER_REQUEST>', created_at: '2026-09-29T11:00:00Z' }),
      step({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'L'.repeat(10) }),
      step({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nearlier\n</USER_REQUEST>', created_at: '2026-09-29T10:00:00Z' }),
      step({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'E'.repeat(70) }),
    ].join('\n'));
    expect(t.prompts).toEqual(['earlier', 'later']);
    expect(t.promptOutputChars).toEqual([70, 10]);
  });
});
