// Copilot CLI 1.0.96 records each model call's usage as `session.usage_record`
// and no longer puts outputTokens on assistant.message. Origin read output as
// 0, and input only from the shutdown summary (4 non-cached tokens), so a
// background `copilot -p` run ended with tokensUsed 4 (2026-10-12) for a call
// Copilot reported as 33,403 in (23,086 cache read, 10,313 cache write) / 91 out.
// Event shapes are from that run's events.jsonl, trimmed.
import { describe, expect, it } from 'vitest';
import { convertCopilotEventsToClaude } from '../transcript.js';

const ev = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data, timestamp: '2026-10-12T22:03:30.000Z' });
const START = ev('session.start', { sessionId: '1d5099d6' });
const USER = ev('user.message', { content: 'Work on issue verify-copilot-bg' });
const RECORD = ev('session.usage_record', { usage: { model: 'claude-sonnet-5.5', inputTokens: 33403, outputTokens: 91, cacheReadTokens: 23086, cacheWriteTokens: 10313 } });
const REPLY = ev('assistant.message', { messageId: 'm1', model: 'claude-sonnet-5.5', content: 'Ready.', toolRequests: [] });
const SHUTDOWN = ev('session.shutdown', { tokenDetails: { input: { tokenCount: 4 }, cache_read: { tokenCount: 23086 }, cache_write: { tokenCount: 10313 }, output: { tokenCount: 91 } } });

function usageOf(lines: string[]) {
  const out = convertCopilotEventsToClaude(lines.join('\n'))!;
  const rows = out.split('\n').map((l) => JSON.parse(l));
  return rows.filter((r) => r.type === 'assistant').map((r) => r.message.usage);
}

describe('Copilot usage records', () => {
  it('give the output, and the same input split as the shutdown summary', () => {
    expect(usageOf([START, USER, RECORD, REPLY, SHUTDOWN])).toEqual([
      { output_tokens: 91, input_tokens: 4, cache_read_input_tokens: 23086, cache_creation_input_tokens: 10313 },
    ]);
  });

  it('count before the session shuts down — what every Stop sees', () => {
    expect(usageOf([START, USER, RECORD, REPLY])).toEqual([
      { output_tokens: 91, input_tokens: 4, cache_read_input_tokens: 23086, cache_creation_input_tokens: 10313 },
    ]);
  });

  it('are summed across calls', () => {
    const second = ev('session.usage_record', { usage: { inputTokens: 1000, outputTokens: 9, cacheReadTokens: 900, cacheWriteTokens: 0 } });
    expect(usageOf([START, USER, RECORD, second, REPLY])[0]).toMatchObject({ output_tokens: 100, input_tokens: 104, cache_read_input_tokens: 23986 });
  });

  it('do not double the output of an older CLI that put it on the message', () => {
    const older = ev('assistant.message', { messageId: 'm1', model: 'm', content: 'Ready.', toolRequests: [], outputTokens: 91 });
    expect(usageOf([START, USER, RECORD, older, SHUTDOWN])[0].output_tokens).toBe(91);
  });

  it('price each call at its own model: input and cache go to that model\'s reply', () => {
    const opusRecord = ev('session.usage_record', { usage: { model: 'claude-opus-4.5', inputTokens: 5_000_100, outputTokens: 10, cacheReadTokens: 5_000_000, cacheWriteTokens: 0 } });
    const opusReply = ev('assistant.message', { messageId: 'm0', model: 'claude-opus-4.5', content: 'Planning.', toolRequests: [] });
    const [opus, sonnet] = usageOf([START, USER, opusRecord, opusReply, RECORD, REPLY]);
    expect(opus).toMatchObject({ input_tokens: 100, cache_read_input_tokens: 5_000_000 });
    expect(sonnet).toMatchObject({ input_tokens: 4, cache_read_input_tokens: 23086 });
  });

  it('after a resume, the new calls count — the old lifecycle\'s shutdown does not override them', () => {
    const later = ev('session.usage_record', { usage: { model: 'claude-sonnet-5.5', inputTokens: 3_000_000, outputTokens: 5, cacheReadTokens: 3_000_000, cacheWriteTokens: 0 } });
    const reply2 = ev('assistant.message', { messageId: 'm2', model: 'claude-sonnet-5.5', content: 'Done.', toolRequests: [] });
    const rows = usageOf([START, USER, RECORD, REPLY, SHUTDOWN, USER, later, reply2]);
    expect(rows[rows.length - 1]).toMatchObject({ cache_read_input_tokens: 3_023_086 });
  });
});

