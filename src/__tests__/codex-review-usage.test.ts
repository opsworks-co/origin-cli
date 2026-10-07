// Codex's auto-review ("guardian") usage belongs to the chat it reviewed.
//
// Codex assesses a chat's risky actions in a thread of its own — its own
// rollout, `source.subagent.other = 'guardian'`, `parent_thread_id` = the
// chat. That thread is filtered out as a session (#944), and its tokens were
// then counted nowhere: not in the chat, not in any turn (TODO 995c166e). On
// this Mac, 43 review rollouts held 413 model calls.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseCodexRollout, parseCodexRolloutLive, parseCodexReviewRollout } from '../agents/codex.js';
import { modelUsageCovers } from '../transcript.js';

let codexDir = '';
let chat = '';

const at = (min: number) => new Date(Date.UTC(2026, 8, 30, 10, min)).toISOString();
const line = (min: number, o: object) => JSON.stringify({ timestamp: at(min), ...o });
const meta = (min: number, payload: object) => line(min, { type: 'session_meta', payload });
const context = (min: number, model: string) => line(min, { type: 'turn_context', payload: { model } });
const user = (min: number, text: string) => line(min, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const u = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output });
const total = (min: number, running: object, last?: object) =>
  line(min, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: running, ...(last && { last_token_usage: last }) } } });

function write(day: string, name: string, lines: string[]): string {
  const dir = path.join(codexDir, 'sessions', day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
const review = (id: string, parent: string) => ({ id, parent_thread_id: parent, session_id: parent, source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' });

beforeEach(() => {
  codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-codex-review-'));
  chat = write('2026/09/30', 'rollout-chat.jsonl', [
    meta(0, { id: 'chat-1', cwd: '/repo', source: 'vscode' }),
    context(0, 'gpt-6-astra'),
    user(1, 'first prompt'),
    total(2, u(10_000, 4_000, 300)),
    user(10, 'second prompt'),
    total(12, u(30_000, 20_000, 800)),
  ]);
  // A fresh review during the first prompt: running total starts at zero.
  write('2026/09/30', 'rollout-review-a.jsonl', [
    meta(3, review('rev-a', 'chat-1')),
    context(3, 'codex-auto-review'),
    total(4, u(2_000, 500, 50), u(2_000, 500, 50)),
    total(5, u(5_000, 2_500, 90), u(3_000, 2_000, 40)),
  ]);
  // The next day, a review that CONTINUES a compacted one: its running total
  // opens at 2.6M with an empty last_token_usage — none of that is this
  // file's. Placed on the second prompt, the newest one begun before it.
  write('2026/10/01', 'rollout-review-b.jsonl', [
    meta(20, review('rev-b', 'chat-1')),
    total(20, u(2_600_000, 2_100_000, 2_000), { ...u(0, 0, 0), total_tokens: 76_269 }),
    context(21, 'codex-auto-review'),
    total(22, u(2_604_000, 2_103_000, 2_100)),
  ]);
  // Someone else's review, and a chat's rollout older than ours: ignored.
  write('2026/09/30', 'rollout-review-other.jsonl', [
    meta(3, review('rev-x', 'chat-2')),
    total(4, u(9_999, 0, 9), u(9_999, 0, 9)),
  ]);
  write('2026/09/29', 'rollout-review-before.jsonl', [
    meta(3, review('rev-y', 'chat-1')),
    total(4, u(7_777, 0, 7), u(7_777, 0, 7)),
  ]);
});
afterEach(() => { fs.rmSync(codexDir, { recursive: true, force: true }); });

describe("a Codex chat's auto-review usage", () => {
  it('reads each review call by its own usage, not the carried-over running total', () => {
    const calls = parseCodexReviewRollout(path.join(codexDir, 'sessions/2026/10/01/rollout-review-b.jsonl'));
    expect(calls.map((c) => c.usage)).toEqual([
      { model: 'codex-auto-review', inputTokens: 1_000, cacheReadTokens: 3_000, outputTokens: 100, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    ]);
  });

  it('is added to the chat, on the prompt each review ran under', () => {
    const r = parseCodexRollout(codexDir, chat, 'chat-1')!;
    expect(r.turnUsage).toEqual([
      { promptIndex: 0, modelUsage: [
        { model: 'gpt-6-astra', inputTokens: 6_000, cacheReadTokens: 4_000, outputTokens: 300, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
        { model: 'codex-auto-review', inputTokens: 2_500, cacheReadTokens: 2_500, outputTokens: 90, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
      ] },
      { promptIndex: 1, modelUsage: [
        { model: 'gpt-6-astra', inputTokens: 4_000, cacheReadTokens: 16_000, outputTokens: 500, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
        { model: 'codex-auto-review', inputTokens: 1_000, cacheReadTokens: 3_000, outputTokens: 100, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
      ] },
    ]);
    const totals = { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens ?? 0, cacheCreationTokens: 0 };
    expect(totals).toEqual({ inputTokens: 13_500, outputTokens: 990, cacheReadTokens: 25_500, cacheCreationTokens: 0 });
    expect(r.tokensUsed).toBe(13_500 + 990);
    expect(modelUsageCovers(r.modelUsage!, totals)).toBe(true);
    expect(modelUsageCovers(r.turnUsage!.flatMap((t) => t.modelUsage), totals)).toBe(true);
  });

  it('the heartbeat reads the same session figure as Stop', () => {
    const stop = parseCodexRollout(codexDir, chat, 'chat-1')!;
    const live = parseCodexRolloutLive(chat)!;
    expect({ i: live.inputTokens, o: live.outputTokens, c: live.cacheReadTokens, t: live.tokensUsed })
      .toEqual({ i: stop.inputTokens, o: stop.outputTokens, c: stop.cacheReadTokens, t: stop.tokensUsed });
  });

  it('still finds the reviews once Codex moves the chat to archived_sessions', () => {
    const live = parseCodexRollout(codexDir, chat, 'chat-1')!;
    const archived = path.join(codexDir, 'archived_sessions', 'rollout-2026-09-30T10-00-00-chat-1.jsonl');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(chat, archived);
    const r = parseCodexRollout(codexDir, archived, 'chat-1')!;
    expect({ i: r.inputTokens, o: r.outputTokens, c: r.cacheReadTokens }).toEqual({ i: live.inputTokens, o: live.outputTokens, c: live.cacheReadTokens });
  });

  it('a review rollout that grows is read again', () => {
    const before = parseCodexRollout(codexDir, chat, 'chat-1')!;
    fs.appendFileSync(path.join(codexDir, 'sessions/2026/09/30/rollout-review-a.jsonl'),
      total(6, u(6_000, 2_500, 100)) + '\n');
    const after = parseCodexRollout(codexDir, chat, 'chat-1')!;
    expect(after.inputTokens - before.inputTokens).toBe(1_000);
    expect(after.outputTokens - before.outputTokens).toBe(10);
  });

  it('a chat with no reviews is unchanged', () => {
    const lone = write('2026/09/30', 'rollout-lone.jsonl', [
      meta(0, { id: 'chat-3', cwd: '/repo', source: 'vscode' }),
      context(0, 'gpt-6-astra'),
      user(1, 'only prompt'),
      total(2, u(10_000, 4_000, 300)),
    ]);
    const r = parseCodexRollout(codexDir, lone, 'chat-3')!;
    expect({ i: r.inputTokens, o: r.outputTokens, c: r.cacheReadTokens }).toEqual({ i: 6_000, o: 300, c: 4_000 });
    expect(r.modelUsage!.map((m) => m.model)).toEqual(['gpt-6-astra']);
  });
});
