// Each turn's share of the session's usage, split by model (TODO b2fa4ebf).
//
// PromptChange rows had token and cost columns from the start, and no producer
// ever filled them: prod held 0 of 5,292 rows with a cost (2026-09-26). The
// session's per-model split (#1727) is divided among its prompts here, so a
// turn row can say what it cost — sub-agents included, on the turn that
// spawned them — and the turns add up to the session.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTranscript, turnModelUsage, extractPromptFileMappings, type ModelUsage } from '../transcript.js';

const SESSION = '22222222-3333-4444-8555-666666666666';
let dir = '';
let transcript = '';

const at = (min: number) => new Date(Date.UTC(2026, 8, 28, 12, min)).toISOString();
const user = (text: string, min: number) => JSON.stringify({
  type: 'user', uuid: `u-${text}`, sessionId: SESSION, timestamp: at(min), message: { role: 'user', content: text },
});
const assistant = (id: string, model: string, min: number, u: { in?: number; out?: number; read?: number }, content: unknown[] = [{ type: 'text', text: 'ok' }]) => JSON.stringify({
  type: 'assistant', uuid: `a-${id}-${Math.random()}`, sessionId: SESSION, timestamp: at(min),
  message: {
    id, model, role: 'assistant', content,
    usage: { input_tokens: u.in ?? 0, output_tokens: u.out ?? 0, cache_read_input_tokens: u.read ?? 0, cache_creation_input_tokens: 0 },
  },
});
const writeParent = (lines: string[]) => fs.writeFileSync(transcript, lines.join('\n') + '\n');
const writeAgent = (name: string, lines: string[], toolUseId?: string) => {
  const sub = path.join(dir, SESSION, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `${name}.jsonl`), lines.join('\n') + '\n');
  if (toolUseId) fs.writeFileSync(path.join(sub, `${name}.meta.json`), JSON.stringify({ toolUseId }));
};
const total = (buckets: ModelUsage[]) => buckets.reduce((a, m) => a + m.inputTokens + m.outputTokens + m.cacheReadTokens, 0);
const turn = (p: ReturnType<typeof parseTranscript>, i: number) => p.turnUsage?.find((t) => t.promptIndex === i)?.modelUsage || [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-turn-usage-'));
  transcript = path.join(dir, `${SESSION}.jsonl`);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('per-turn usage', () => {
  it('each prompt keeps the usage of the replies to it, and the turns add up to the session', () => {
    writeParent([
      user('first', 0),
      assistant('m1', 'claude-opus-5', 1, { in: 10, out: 100, read: 1_000 }),
      assistant('m1', 'claude-opus-5', 1, { in: 10, out: 120, read: 1_000 }), // streamed copy, higher output
      user('second', 5),
      assistant('m2', 'claude-fable-5-1', 6, { in: 20, out: 200, read: 2_000 }),
      assistant('m3', 'claude-opus-5', 7, { in: 5, out: 50 }),
    ]);
    const p = parseTranscript(transcript);

    expect(turn(p, 0)).toEqual([{ model: 'claude-opus-5', inputTokens: 10, outputTokens: 120, cacheReadTokens: 1_000, cacheCreationTokens: 0, cacheCreation1hTokens: 0 }]);
    expect(turn(p, 1).map((m) => [m.model, m.outputTokens]).sort()).toEqual([['claude-fable-5-1', 200], ['claude-opus-5', 50]]);
    const all = (p.turnUsage || []).flatMap((t) => t.modelUsage);
    expect(total(all)).toBe(total(p.modelUsage || []));
  });

  it("a sub-agent's usage belongs to the prompt whose turn spawned it, even when it finishes during the next one", () => {
    writeParent([
      user('review this in the background', 0),
      assistant('p1', 'claude-opus-5', 1, { in: 10, out: 10 }, [{ type: 'tool_use', id: 'toolu_spawn', name: 'Agent', input: {} }]),
      user('meanwhile, something else', 5),
      assistant('p2', 'claude-opus-5', 6, { in: 10, out: 10 }),
    ]);
    // Runs from minute 2 to minute 9 — mostly inside the second prompt's window.
    writeAgent('agent-a1', [
      assistant('s1', 'claude-haiku-4-5', 2, { in: 100, out: 1_000 }),
      assistant('s2', 'claude-haiku-4-5', 9, { in: 100, out: 1_000 }),
    ], 'toolu_spawn');
    const p = parseTranscript(transcript);

    expect(turn(p, 0).find((m) => m.model === 'claude-haiku-4-5')?.outputTokens).toBe(2_000);
    expect(turn(p, 1).find((m) => m.model === 'claude-haiku-4-5')).toBeUndefined();
  });

  it('a sub-agent with no spawn record falls to the prompt its time says', () => {
    writeParent([
      user('one', 0),
      assistant('p1', 'claude-opus-5', 1, { in: 1, out: 1 }),
      user('two', 5),
      assistant('p2', 'claude-opus-5', 6, { in: 1, out: 1 }),
    ]);
    writeAgent('agent-old', [assistant('s1', 'claude-haiku-4-5', 7, { in: 5, out: 50 })]);
    const p = parseTranscript(transcript);
    expect(turn(p, 1).find((m) => m.model === 'claude-haiku-4-5')?.outputTokens).toBe(50);
  });

  it('numbers turns like the rows: a resumed session keeps its native prompt index', () => {
    writeParent([
      user('before the session', 0),
      assistant('old', 'claude-opus-5', 1, { in: 999, out: 999 }),
      user('after', 10),
      assistant('new', 'claude-opus-5', 11, { in: 1, out: 2 }),
    ]);
    const since = at(9);
    const p = parseTranscript(transcript, { since });
    expect(p.promptIndexBase).toBe(1);
    expect(p.turnUsage?.map((t) => t.promptIndex)).toEqual([1]);
    const rows = extractPromptFileMappings(transcript, { since }).map((m) => m.promptIndex);
    expect(rows).toContain(1);
    expect(turnModelUsage(p, 1)?.[0].outputTokens).toBe(2);
  });

  it('sends no share when the session totals no longer match the split', () => {
    writeParent([user('x', 0), assistant('m', 'claude-opus-5', 1, { in: 10, out: 10 })]);
    const p = parseTranscript(transcript);
    expect(turnModelUsage(p, 0)).toBeTruthy();
    // A caller that replaced the totals after parsing (Codex backfill, an estimate).
    expect(turnModelUsage({ ...p, outputTokens: 5_000 }, 0)).toBeUndefined();
  });
});
