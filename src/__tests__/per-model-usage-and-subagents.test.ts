// A session is not one model, and its sub-agents are not in its transcript.
//
// Two defects, measured on 163 real Claude Code transcripts (2026-09-18):
//
//   1. The whole session was priced at the FIRST model it used. A user who
//      switched between Fable and Opus mid-conversation was off by up to $16
//      on a single session, in either direction.
//   2. Claude Code writes each Task sub-agent to its own file,
//      `<session>/subagents/agent-*.jsonl`, and the parent transcript holds no
//      `isSidechain` entry at all. Nothing read those files, so sub-agent usage
//      was not mispriced but MISSING: 7.3% of real cost across the 29 sessions
//      that spawned any, and more than the parent conversation in several.
//
// Pricing per model is what makes adding the sub-agents correct — they
// routinely run on a different tier than the conversation that spawned them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseTranscript, estimateCost, estimateSessionCost, modelUsageCovers,
  __resetActivePricingForTests, type ModelUsage,
} from '../transcript.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
let dir = '';
let transcript = '';

interface U { in?: number; out?: number; read?: number; write?: number; write1h?: number }
const assistant = (id: string, model: string, u: U, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  uuid: `uuid-${id}`,
  sessionId: SESSION,
  timestamp: '2026-09-18T12:00:00.000Z',
  ...extra,
  message: {
    id, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    usage: {
      input_tokens: u.in ?? 0, output_tokens: u.out ?? 0,
      cache_read_input_tokens: u.read ?? 0, cache_creation_input_tokens: u.write ?? 0,
      cache_creation: { ephemeral_1h_input_tokens: u.write1h ?? 0, ephemeral_5m_input_tokens: (u.write ?? 0) - (u.write1h ?? 0) },
    },
  },
});
const user = (text: string) => JSON.stringify({
  type: 'user', uuid: `u-${text}`, sessionId: SESSION, timestamp: '2026-09-18T11:59:00.000Z',
  message: { role: 'user', content: text },
});

const writeParent = (lines: string[]) => fs.writeFileSync(transcript, lines.join('\n') + '\n');
const writeAgent = (name: string, lines: string[]) => {
  const sub = path.join(dir, SESSION, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, name), lines.join('\n') + '\n');
};
const bucket = (usage: ModelUsage[] | undefined, model: string) => (usage || []).find((m) => m.model === model);

beforeEach(() => {
  __resetActivePricingForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-model-usage-'));
  transcript = path.join(dir, `${SESSION}.jsonl`);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('per-model usage', () => {
  it('buckets a mid-conversation model switch, and the buckets add up to the totals', () => {
    writeParent([
      user('start'),
      assistant('m1', 'claude-opus-5', { in: 100, out: 1_000, read: 50_000, write: 2_000, write1h: 2_000 }),
      assistant('m2', 'claude-fable-5-1', { in: 200, out: 3_000, read: 80_000, write: 1_000, write1h: 1_000 }),
      assistant('m3', 'claude-opus-5', { in: 50, out: 500, read: 10_000 }),
    ]);
    const p = parseTranscript(transcript);

    expect(p.model).toBe('claude-opus-5'); // the session's model is still the first one
    expect(bucket(p.modelUsage, 'claude-opus-5')).toEqual({
      model: 'claude-opus-5', inputTokens: 150, outputTokens: 1_500, cacheReadTokens: 60_000, cacheCreationTokens: 2_000, cacheCreation1hTokens: 2_000,
    });
    expect(bucket(p.modelUsage, 'claude-fable-5-1')).toEqual({
      model: 'claude-fable-5-1', inputTokens: 200, outputTokens: 3_000, cacheReadTokens: 80_000, cacheCreationTokens: 1_000, cacheCreation1hTokens: 1_000,
    });
    expect(p.inputTokens).toBe(350);
    expect(p.outputTokens).toBe(4_500);
    expect(modelUsageCovers(p.modelUsage!, p)).toBe(true);
  });

  it('prices each bucket at its own rates — not the session at its first model', () => {
    writeParent([
      user('start'),
      assistant('m1', 'claude-opus-5', { out: 1_000_000 }),
      assistant('m2', 'claude-fable-5-1', { out: 1_000_000, read: 1_000_000 }),
    ]);
    const p = parseTranscript(transcript);
    // Opus $25/M out; Fable 5.1 $50/M out and $0.25/M cache reads.
    expect(estimateSessionCost(p, p.model)).toBeCloseTo(25 + 50 + 0.25, 4);
    // What it used to be: everything at Opus, cache reads at $0.50/M.
    expect(estimateCost(p.model, p.inputTokens, p.outputTokens, p.cacheReadTokens, p.cacheCreationTokens)).toBeCloseTo(50.5, 4);
  });

  it('a record naming no real model is the session\'s own', () => {
    writeParent([
      user('start'),
      assistant('m1', 'claude-opus-5', { out: 1_000_000 }),
      assistant('m2', '<synthetic>', { out: 1_000_000 }),
    ]);
    const p = parseTranscript(transcript);
    expect(bucket(p.modelUsage, '')?.outputTokens).toBe(1_000_000);
    expect(estimateSessionCost(p, 'claude-opus-5')).toBeCloseTo(50, 4);
  });

  it('ignores a split that does not add up to the counts being priced', () => {
    writeParent([user('start'), assistant('m1', 'claude-fable-5-1', { out: 1_000_000 })]);
    const p = parseTranscript(transcript);
    // Codex's rollout backfill, the prompt-length estimate and the heartbeat all
    // REPLACE a parsed transcript's counts; the split then describes other tokens.
    const replaced = { ...p, outputTokens: 2_000_000 };
    expect(modelUsageCovers(p.modelUsage!, replaced)).toBe(false);
    expect(estimateSessionCost(replaced, 'claude-opus-5')).toBeCloseTo(50, 4); // 2M × Opus $25, not Fable
  });

  it('a split must agree on the 1-hour cache tier too, not only on the cache-write total', () => {
    writeParent([user('start'), assistant('m1', 'claude-opus-5', { write: 1_000_000, write1h: 1_000_000 })]);
    const p = parseTranscript(transcript);
    expect(estimateSessionCost(p, p.model)).toBeCloseTo(10, 4); // 1M x $5 x 2.00
    // Same cache-write total, but the split claims none of it was 1-hour: it
    // would price at 1.25x. It does not describe these counts, so it is ignored.
    const lying = p.modelUsage!.map((m) => ({ ...m, cacheCreation1hTokens: 0 }));
    expect(modelUsageCovers(lying, p)).toBe(false);
    expect(estimateSessionCost({ ...p, modelUsage: lying }, p.model)).toBeCloseTo(10, 4);
  });

  it('leaves a transcript without per-message models on the single-model path', () => {
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', id: 'g0', content: 'hi' }),
      JSON.stringify({ type: 'gemini', id: 'g1', model: 'gemini-3-pro', tokens: { input: 1000, output: 500, cached: 0, thoughts: 0 } }),
    ].join('\n') + '\n');
    const p = parseTranscript(transcript);
    expect(p.inputTokens).toBe(1000);
    expect(p.modelUsage).toBeUndefined();
  });
});

describe('sub-agent transcripts', () => {
  const parent = () => writeParent([user('start'), assistant('m1', 'claude-opus-5', { in: 100, out: 1_000, read: 40_000 })]);

  it('adds a sub-agent\'s usage to the session, on its own model', () => {
    parent();
    writeAgent('agent-a1.jsonl', [
      assistant('s1', 'claude-haiku-4-5-20251001', { in: 300, out: 2_000, read: 9_000, write: 600, write1h: 600 }, { isSidechain: true }),
      assistant('s2', 'claude-haiku-4-5-20251001', { in: 10, out: 400 }, { isSidechain: true }),
      JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', content: 'a tool result mentioning "usage" in its text' }] } }),
    ]);
    const p = parseTranscript(transcript);

    expect(p.inputTokens).toBe(100 + 310);
    expect(p.outputTokens).toBe(1_000 + 2_400);
    expect(p.cacheReadTokens).toBe(40_000 + 9_000);
    expect(p.cacheCreation1hTokens).toBe(600);
    expect(p.tokensUsed).toBe(410 + 3_400);
    expect(p.subagentTokens).toBe(310 + 2_400); // the portion inside sub-agents
    expect(p.model).toBe('claude-opus-5');     // a sub-agent never names the session
    expect(bucket(p.modelUsage, 'claude-haiku-4-5-20251001')).toEqual({
      model: 'claude-haiku-4-5-20251001', inputTokens: 310, outputTokens: 2_400, cacheReadTokens: 9_000, cacheCreationTokens: 600, cacheCreation1hTokens: 600,
    });
    expect(modelUsageCovers(p.modelUsage!, p)).toBe(true);
  });

  it('keeps the largest of a streamed message\'s records, and reads every agent file', () => {
    parent();
    writeAgent('agent-a1.jsonl', [
      assistant('s1', 'claude-opus-5', { in: 5, out: 10 }, { isSidechain: true }),   // partial
      assistant('s1', 'claude-opus-5', { in: 5, out: 900 }, { isSidechain: true }),  // final
    ]);
    writeAgent('agent-b2.jsonl', [assistant('t1', 'claude-sonnet-5', { in: 7, out: 70 }, { isSidechain: true })]);
    writeAgent('notes.txt', ['not a transcript']);
    const p = parseTranscript(transcript);
    expect(p.outputTokens).toBe(1_000 + 900 + 70);
    expect(p.subagentTokens).toBe(5 + 900 + 7 + 70);
  });

  it('does not count a turn twice when the parent transcript inlines it too', () => {
    // Older Claude Code builds wrote sidechain turns into the parent file.
    writeParent([
      user('start'),
      assistant('m1', 'claude-opus-5', { in: 100, out: 1_000 }),
      assistant('s1', 'claude-haiku-4-5', { in: 300, out: 2_000 }, { isSidechain: true }),
    ]);
    writeAgent('agent-a1.jsonl', [assistant('s1', 'claude-haiku-4-5', { in: 300, out: 2_000 }, { isSidechain: true })]);
    const p = parseTranscript(transcript);
    expect(p.outputTokens).toBe(3_000);
    expect(p.subagentTokens).toBe(2_300);
  });

  it('a sub-agent file that replays the parent\'s own turns does not relabel them', () => {
    // A forked agent starts from the parent conversation. Its copy of the
    // parent's messages is the parent's usage: counted once, and not reported
    // as sub-agent tokens.
    writeParent([user('start'), assistant('m1', 'claude-opus-5', { in: 100, out: 1_000 })]);
    writeAgent('agent-fork.jsonl', [
      assistant('m1', 'claude-opus-5', { in: 100, out: 1_000 }, { isSidechain: true }),
      assistant('f1', 'claude-opus-5', { in: 10, out: 200 }, { isSidechain: true }),
    ]);
    const p = parseTranscript(transcript);
    expect(p.outputTokens).toBe(1_200);
    expect(p.subagentTokens).toBe(210);
  });

  it('applies the session\'s `since` cutoff to sub-agent records', () => {
    writeParent([
      JSON.stringify({ ...JSON.parse(user('old')), timestamp: '2026-09-17T08:00:00.000Z' }),
      JSON.stringify({ ...JSON.parse(assistant('m0', 'claude-opus-5', { out: 111 })), timestamp: '2026-09-17T08:00:05.000Z' }),
      user('start'),
      assistant('m1', 'claude-opus-5', { out: 1_000 }),
    ]);
    writeAgent('agent-a1.jsonl', [
      JSON.stringify({ ...JSON.parse(assistant('old', 'claude-haiku-4-5', { out: 5_000 }, { isSidechain: true })), timestamp: '2026-09-17T08:01:00.000Z' }),
      assistant('new', 'claude-haiku-4-5', { out: 40 }, { isSidechain: true }),
    ]);
    const p = parseTranscript(transcript, { since: '2026-09-18T11:00:00.000Z' });
    expect(p.outputTokens).toBe(1_000 + 40);
    expect(p.subagentTokens).toBe(40);
  });

  it('a session with no sub-agent directory parses exactly as before', () => {
    parent();
    const p = parseTranscript(transcript);
    expect(p.outputTokens).toBe(1_000);
    expect(p.subagentTokens).toBe(0);
    expect(p.modelUsage).toHaveLength(1);
  });
});
