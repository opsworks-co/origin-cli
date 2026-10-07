// What each Gemini prompt cost, by model — and Copilot's, estimated.
//
// Gemini records usage and model on every reply, so its turns are split the
// way Claude Code's are (#1973): 117 of 117 local Gemini logs with usage split
// exactly, 2026-09-29. Copilot records only OUTPUT per reply; input and cache
// exist only as a session total at shutdown (18 of 18 local logs): output
// stays per reply, and the input/cache total is divided by what each prompt's
// calls sent, marked as an estimate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTranscript, turnModelUsage, modelUsageCovers } from '../transcript.js';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gemini-copilot-usage-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, body: string) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
const tokens = (input: number, cached: number, output: number, thoughts = 0) =>
  ({ input, output, cached, thoughts, tool: 0, total: input + output + thoughts });

describe('Gemini: each prompt\'s usage, by model', () => {
  // Gemini CLI's single-object chat file.
  const chat = () => write('session.json', JSON.stringify({
    sessionId: 's1',
    messages: [
      { id: 'u1', type: 'user', content: [{ text: 'first' }] },
      { id: 'g1', type: 'gemini', content: 'a', tokens: tokens(1_000, 0, 50, 10), model: 'gemini-2.5-pro' },
      { id: 'g1', type: 'gemini', content: 'a', tokens: tokens(1_000, 0, 50, 10), model: 'gemini-2.5-pro' },
      { id: 'u2', type: 'user', content: [{ text: 'second' }] },
      { id: 'g2', type: 'gemini', content: 'b', tokens: tokens(8_000, 6_000, 40), model: 'gemini-2.5-flash' },
    ],
  }));

  it('splits the single-object chat file by prompt and model, a repeated reply once', () => {
    const p = parseTranscript(chat());
    expect(turnModelUsage(p, 0)).toEqual([
      { model: 'gemini-2.5-pro', inputTokens: 1_000, outputTokens: 60, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    ]);
    expect(turnModelUsage(p, 1)).toEqual([
      { model: 'gemini-2.5-flash', inputTokens: 2_000, outputTokens: 40, cacheReadTokens: 6_000, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    ]);
  });

  it('counts cached tokens once: `input` already includes them', () => {
    const p = parseTranscript(chat());
    expect({ i: p.inputTokens, c: p.cacheReadTokens, o: p.outputTokens }).toEqual({ i: 3_000, c: 6_000, o: 100 });
    expect(modelUsageCovers(p.modelUsage!, p)).toBe(true);
  });

  it('splits the JSONL chat file the same way', () => {
    const f = write('session.jsonl', [
      { sessionId: 's1', kind: 'main' },
      { id: 'u1', type: 'user', content: [{ text: 'first' }] },
      { id: 'g1', type: 'gemini', content: 'a', tokens: tokens(1_000, 0, 50, 10), model: 'gemini-2.5-pro' },
      { id: 'g1', type: 'gemini', content: 'a', tokens: tokens(1_000, 0, 50, 10), model: 'gemini-2.5-pro' },
      { id: 'u2', type: 'user', content: [{ text: 'second' }] },
      { id: 'g2', type: 'gemini', content: 'b', tokens: tokens(8_000, 6_000, 40), model: 'gemini-2.5-flash' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const p = parseTranscript(f);
    expect({ i: p.inputTokens, c: p.cacheReadTokens, o: p.outputTokens }).toEqual({ i: 3_000, c: 6_000, o: 100 });
    expect(turnModelUsage(p, 0)?.map((m) => [m.model, m.inputTokens])).toEqual([['gemini-2.5-pro', 1_000]]);
    expect(turnModelUsage(p, 1)?.map((m) => [m.model, m.inputTokens, m.cacheReadTokens])).toEqual([['gemini-2.5-flash', 2_000, 6_000]]);
  });

  it('reads the SDK usageMetadata shape the same way', () => {
    const f = write('sdk.json', JSON.stringify({
      messages: [
        { id: 'u1', type: 'user', content: [{ text: 'only' }] },
        { id: 'g1', type: 'model', content: 'x', model: 'gemini-2.5-pro',
          usageMetadata: { promptTokenCount: 900, cachedContentTokenCount: 600, candidatesTokenCount: 30, thoughtsTokenCount: 5 } },
      ],
    }));
    expect(turnModelUsage(parseTranscript(f), 0)).toEqual([
      { model: 'gemini-2.5-pro', inputTokens: 300, outputTokens: 35, cacheReadTokens: 600, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    ]);
  });
});

describe('Copilot: an estimated per-prompt share', () => {
  it('keeps each reply\'s output where it was produced and divides the session\'s input and cache', () => {
    const ev = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    const f = write('events.jsonl', [
      ev('session.start', { selectedModel: 'auto' }),
      ev('user.message', { content: 'first' }),
      ev('assistant.message', { messageId: 'm1', model: 'claude-sonnet-4.6', content: 'a', outputTokens: 100 }),
      ev('user.message', { content: 'second, a longer question sent over a longer conversation' }),
      ev('assistant.message', { messageId: 'm2', model: 'claude-sonnet-4.6', content: 'b', outputTokens: 20 }),
      ev('session.shutdown', { tokenDetails: { input: { tokenCount: 50_000 }, cache_read: { tokenCount: 400_000 }, cache_write: { tokenCount: 0 } } }),
    ].join('\n') + '\n');
    const p = parseTranscript(f);
    expect(p.prompts).toHaveLength(2);
    expect(p.turnUsageEstimated).toBe(true);
    const [one, two] = [turnModelUsage(p, 0)!, turnModelUsage(p, 1)!];
    expect(one.map((m) => m.outputTokens)).toEqual([100]);
    expect(two.map((m) => m.outputTokens)).toEqual([20]);
    // Input and cache were a session total hung on the last reply; divided,
    // the later turn (which re-sent more conversation) carries more, but not all.
    expect(two[0].inputTokens).toBeGreaterThan(one[0].inputTokens);
    expect(one[0].inputTokens).toBeGreaterThan(0);
    expect(one[0].inputTokens + two[0].inputTokens).toBe(50_000);
    expect(one[0].cacheReadTokens + two[0].cacheReadTokens).toBe(400_000);
    expect(modelUsageCovers(p.turnUsage!.flatMap((t) => t.modelUsage), p)).toBe(true);
  });
});
