// LIVE Devin capture from its own sessions.db.
//
// Devin writes its ATIF transcript only when a CONVERSATION ends, so a turn's
// own Stop had nothing to read → "32 tokens" / "No response captured". But
// Devin writes ~/.local/share/devin/cli/sessions.db continuously, keyed by the
// SAME id the hook gets on stdin (`session_id` = `sessions.id`). Verified live
// on a still-open conversation: model, every message and per-message token
// metrics were already present.
//
// The one trap these pin: message_nodes stores a row per BRANCH, so the same
// message_id appears more than once — naive summing double-counts every token.

import { describe, it, expect } from 'vitest';
import { parseDevinLiveMessages } from '../devin-sessions-db.js';

const msg = (o: Record<string, unknown>) => JSON.stringify(o);

const assistant = (id: string, content: string, input: number, output: number, cache = 0) =>
  msg({
    message_id: id, role: 'assistant', content,
    metadata: { metrics: { input_tokens: input, output_tokens: output, cache_read_tokens: cache } },
  });

describe('parseDevinLiveMessages', () => {
  it('extracts model, real tokens, tool calls, prompts and the response', () => {
    const d = parseDevinLiveMessages([
      msg({ message_id: 's1', role: 'system', content: 'You are Devin…' }),
      msg({ message_id: 'u1', role: 'user', content: 'checkw what the hell this repo is' }),
      msg({ message_id: 't1', role: 'tool', content: 'Read ./popcorn' }),
      assistant('a1', 'This is a repository called "suchara".', 13140, 139),
    ], 'swe-1-6-slow');

    expect(d.model).toBe('swe-1-6-slow');
    expect(d.inputTokens).toBe(13140);
    expect(d.outputTokens).toBe(139);
    expect(d.tokensUsed).toBe(13140 + 139);
    expect(d.toolCalls).toBe(1);
    expect(d.prompts).toEqual(['checkw what the hell this repo is']);
    const turns = JSON.parse(d.transcript!);
    expect(turns.some((t: any) => t.role === 'user' && t.content.includes('checkw'))).toBe(true);
    expect(turns.some((t: any) => t.role === 'assistant' && t.content.includes('suchara'))).toBe(true);
  });

  it('DEDUPES branch-duplicated rows so tokens are not double-counted', () => {
    // The same assistant message stored twice (one node per branch).
    const dup = assistant('a1', 'answer', 13140, 139);
    const d = parseDevinLiveMessages([dup, dup, dup], 'swe-1-6-slow');
    expect(d.inputTokens).toBe(13140);   // NOT 39420
    expect(d.outputTokens).toBe(139);
    expect(JSON.parse(d.transcript!)).toHaveLength(1);
  });

  it('sums across distinct assistant messages', () => {
    const d = parseDevinLiveMessages([
      assistant('a1', 'one', 100, 10),
      assistant('a2', 'two', 200, 20, 5),
    ]);
    expect(d.inputTokens).toBe(300);
    expect(d.outputTokens).toBe(30);
    expect(d.cacheReadTokens).toBe(5);
    expect(d.tokensUsed).toBe(330);
  });

  it('captures each prompt\'s REAL submission time from metadata.created_at', () => {
    // Regression: Devin records the prompt at Stop (after the turn's work), so
    // the server's timestamp-based commit attribution saw a commit as BEFORE its
    // own prompt and credited the wrong turn. The DB's created_at is the truth.
    const d = parseDevinLiveMessages([
      msg({ message_id: 'u1', role: 'user', content: 'first', metadata: { created_at: '2026-07-24T12:00:02Z' } }),
      assistant('a1', 'ok', 10, 5),
      msg({ message_id: 'u2', role: 'user', content: 'add 3 more and create a PR', metadata: { created_at: '2026-07-24T12:03:41Z' } }),
    ]);
    expect(d.prompts).toEqual(['first', 'add 3 more and create a PR']);
    expect(d.promptTimes).toEqual(['2026-07-24T12:00:02Z', '2026-07-24T12:03:41Z']);
  });

  it('leaves promptTimes entries undefined when created_at is missing (aligned to prompts)', () => {
    const d = parseDevinLiveMessages([
      msg({ message_id: 'u1', role: 'user', content: 'no time' }),
      msg({ message_id: 'u2', role: 'user', content: 'has time', metadata: { created_at: '2026-07-24T12:03:41Z' } }),
    ]);
    expect(d.promptTimes).toEqual([undefined, '2026-07-24T12:03:41Z']);
  });

  it('drops system scaffolding from the transcript', () => {
    const d = parseDevinLiveMessages([
      msg({ message_id: 's1', role: 'system', content: 'Origin: Session tracking active…' }),
      msg({ message_id: 'u1', role: 'user', content: 'hi' }),
    ]);
    const turns = JSON.parse(d.transcript!);
    expect(turns.every((t: any) => t.role !== 'system')).toBe(true);
    expect(turns).toHaveLength(1);
  });

  it('survives malformed rows and yields nothing for an empty conversation', () => {
    expect(() => parseDevinLiveMessages(['not json', '{}'])).not.toThrow();
    const empty = parseDevinLiveMessages([]);
    expect(empty.transcript).toBeUndefined();
    expect(empty.tokensUsed).toBe(0);
  });
});
