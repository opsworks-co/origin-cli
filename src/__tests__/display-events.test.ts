// A turn's structured steps (display-events.ts) ride on the display
// transcript's prompt message: Claude Code's JSONL formatter and both Codex
// rollout parsers fill them from what the log records, and leave out what it
// does not.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatTranscriptForDisplay } from '../transcript.js';
import { parseCodexRollout, parseCodexRolloutLive } from '../agents/codex.js';
import { MAX_EVENTS_PER_TURN, appendTurnEvents, inputPreview, type DisplayEvent } from '../display-events.js';

const dirs: string[] = [];
function writeJsonl(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'display-events-'));
  dirs.push(dir);
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const T = (s: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, s)).toISOString();
const ms = (s: number) => Date.parse(T(s));
const usage = { input_tokens: 3, output_tokens: 120, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500 };
const prompts = (t: string) => JSON.parse(t).filter((m: any) => m.role === 'user');

describe('Claude Code transcript events', () => {
  const rows = [
    { type: 'user', timestamp: T(0), message: { role: 'user', content: 'fix the bug' } },
    // One API response written as three lines, each repeating its usage.
    { type: 'assistant', timestamp: T(4), message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', timestamp: T(5), message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm test\necho done' } }] } },
    { type: 'assistant', timestamp: T(6), message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', id: 'tu_2', name: 'TodoWrite', input: { todos: [{ content: 'a' }] } }] } },
    { type: 'user', timestamp: T(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'FAIL' }] } },
    { type: 'user', timestamp: T(10), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'ok' }] } },
    // A sub-agent's line is not this conversation's step.
    { type: 'assistant', isSidechain: true, timestamp: T(11), message: { id: 'msg_side', model: 'claude-haiku-5-5', usage, content: [{ type: 'tool_use', id: 'tu_s', name: 'Read', input: { file_path: 'x' } }] } },
    { type: 'assistant', timestamp: T(13), message: { id: 'msg_2', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 9 }, content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'user', timestamp: T(20), message: { role: 'user', content: 'thanks' } },
    { type: 'assistant', timestamp: T(21), message: { id: 'synthetic', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } },
  ];

  it('puts each turn\'s model calls, thinking and tools on its prompt, timed and costed once', () => {
    const [first, second] = prompts(formatTranscriptForDisplay(writeJsonl(rows)));
    expect(first.ts).toBe(ms(0));
    expect(first.events).toEqual<DisplayEvent[]>([
      { kind: 'model', ts: ms(0), model: 'claude-opus-5-5', durationMs: 6000, tokens: { input: 3, output: 120, cacheRead: 4000, cacheWrite: 500 } },
      { kind: 'thinking', ts: ms(0), durationMs: 4000 },
      { kind: 'tool', tool: 'Bash', ts: ms(5), input: 'npm test', durationMs: 4000, error: true },
      { kind: 'tool', tool: 'TodoWrite', ts: ms(6), input: '{"todos":[{"content":"a"}]}', durationMs: 4000 },
      { kind: 'model', ts: ms(10), model: 'claude-opus-5-5', durationMs: 3000, tokens: { input: 1, output: 9, cacheRead: 0, cacheWrite: 0 } },
    ]);
    // The second turn's only reply is synthetic: no model call happened.
    expect(second.ts).toBe(ms(20));
    expect(second.events).toBeUndefined();
  });

  it('keeps the steps a log without times records, and leaves the times out', () => {
    // Cursor's JSONL: top-level role, no timestamps, no ids, no usage.
    const t = formatTranscriptForDisplay(writeJsonl([
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nrename it\n</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }] } },
    ]));
    const [p] = prompts(t);
    expect(p.ts).toBeUndefined();
    expect(p.events).toEqual([{ kind: 'model' }, { kind: 'tool', tool: 'Edit', input: 'file: a.ts' }]);
  });
});

describe('Codex rollout events', () => {
  const ev = (s: number, type: string, payload: object) => ({ timestamp: T(s), type, payload });
  const tokenCount = (s: number, total: number, last: object) =>
    ev(s, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last } });
  const rollout = [
    ev(0, 'turn_context', { turn_id: 't1', model: 'gpt-5.6-sol' }),
    ev(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'bump the dep' }] }),
    ev(2, 'response_item', { type: 'reasoning', summary: [] }),
    ev(3, 'response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({"cmd":"pnpm test","workdir":"/r"}); text(r.output);' }),
    ev(8, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed\n{"exit_code":1,"output":"1 failed"}' }] }),
    tokenCount(8, 1100, { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100 }),
    // Codex repeats a token_count with an unchanged total: no new call.
    tokenCount(8, 1100, { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100 }),
    ev(9, 'response_item', { type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'const r = await tools.apply_patch("*** Begin Patch\\n*** Update File: package.json\\n@@\\n-a\\n+b\\n*** End Patch\\n");' }),
    ev(10, 'response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'Script completed\nSuccess.' }] }),
    ev(11, 'response_item', { type: 'function_call', call_id: 'c3', name: 'shell', arguments: '{"command":["bash","-lc","ls"]}' }),
    ev(12, 'event_msg', { type: 'exec_command_end', call_id: 'c3', exit_code: 2, duration: { secs: 0, nanos: 250_000_000 } }),
    ev(20, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and commit' }] }),
    ev(21, 'event_msg', { type: 'web_search_end', call_id: 'w1', query: 'browserslist 4.28.7' }),
    ev(22, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Committed.' }] }),
    tokenCount(23, 1300, { input_tokens: 150, cached_input_tokens: 0, output_tokens: 50 }),
    // A call whose output the rollout never shows: no start, no duration.
    ev(30, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] }),
    tokenCount(31, 1400, { input_tokens: 90, cached_input_tokens: 0, output_tokens: 10 }),
  ];

  it('gives each prompt its own calls, tool times, failures and per-call tokens', () => {
    const file = writeJsonl(rollout);
    const stop = parseCodexRollout('', file, '')!;
    const [first, second, third] = prompts(stop.transcript!);
    expect(first.ts).toBe(ms(1));
    // A call runs from the prompt (or the last tool output) to its last output
    // item, and sits before the steps it produced — not at its token_count,
    // which lands after the tool output.
    expect(first.events).toEqual<DisplayEvent[]>([
      { kind: 'model', ts: ms(1), durationMs: 2000, model: 'gpt-5.6-sol', tokens: { input: 400, output: 100, cacheRead: 600, cacheWrite: 0 } },
      { kind: 'thinking', ts: ms(2) },
      { kind: 'tool', tool: 'shell', ts: ms(3), input: 'pnpm test', durationMs: 5000, error: true },
      { kind: 'tool', tool: 'apply_patch', ts: ms(9), input: 'package.json', durationMs: 1000 },
      { kind: 'tool', tool: 'shell', ts: ms(11), input: '{"command":["bash","-lc","ls"]}', error: true, durationMs: 250 },
    ]);
    expect(second.events).toEqual<DisplayEvent[]>([
      { kind: 'tool', tool: 'web_search', ts: ms(21), input: 'browserslist 4.28.7' },
      { kind: 'model', ts: ms(20), durationMs: 2000, model: 'gpt-5.6-sol', tokens: { input: 150, output: 50, cacheRead: 0, cacheWrite: 0 } },
    ]);
    expect(third.events).toEqual<DisplayEvent[]>([
      { kind: 'model', ts: ms(31), model: 'gpt-5.6-sol', tokens: { input: 90, output: 10, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });

  it('the heartbeat parser carries the same events as the Stop parser', () => {
    // The heartbeat's transcript overwrites Stop's on the server: if it lacked
    // the events, every tick would wipe them.
    for (const file of [writeJsonl(rollout), path.join(__dirname, 'fixtures', 'codex-uncommitted-2-prompts.jsonl')]) {
      const stop = prompts(parseCodexRollout('', file, '')!.transcript!).map((p: any) => p.events);
      const live = prompts((parseCodexRolloutLive(file) as any).transcript).map((p: any) => p.events);
      expect(live).toEqual(stop);
      expect(stop.some((e: unknown) => Array.isArray(e) && e.length > 0)).toBe(true);
    }
  });

  it('per-call tokens add up to the session totals', () => {
    const fixture = path.join(__dirname, 'fixtures', 'codex-uncommitted-2-prompts.jsonl');
    const stop = parseCodexRollout('', fixture, '')!;
    const calls = prompts(stop.transcript!).flatMap((p: any) => p.events || []).filter((e: DisplayEvent) => e.kind === 'model');
    const sum = (k: 'input' | 'output' | 'cacheRead') => calls.reduce((n: number, e: DisplayEvent) => n + (e.tokens?.[k] || 0), 0);
    expect({ input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead') })
      .toEqual({ input: stop.inputTokens, output: stop.outputTokens, cacheRead: stop.cacheReadTokens });
  });
});

describe('event helpers', () => {
  it('an input preview is one line, secret-redacted, and short', () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const p = inputPreview(`\n  curl -H "Authorization: token ${secret}" https://api.github.com\nsecond line`)!;
    expect(p).not.toContain(secret);
    expect(p).not.toContain('second line');
    expect(inputPreview('x'.repeat(500))!.length).toBe(160);
    expect(inputPreview('   \n  ')).toBeUndefined();
  });

  it('a turn keeps at most MAX_EVENTS_PER_TURN steps and counts the rest', () => {
    const target: { events?: DisplayEvent[]; eventsDropped?: number } = {};
    const tool: DisplayEvent = { kind: 'tool', tool: 'Read' };
    appendTurnEvents(target, Array(MAX_EVENTS_PER_TURN - 1).fill(tool));
    appendTurnEvents(target, [tool, tool, tool]);
    expect(target.events).toHaveLength(MAX_EVENTS_PER_TURN);
    expect(target.eventsDropped).toBe(2);
  });
});
