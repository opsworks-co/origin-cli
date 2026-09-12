import { describe, expect, it } from 'vitest';
import {
  CURSOR_CHARS_PER_TOKEN,
  CURSOR_PROMPT_CONTEXT_MULTIPLIER,
  estimateCursorTokens,
  measureCursorJsonlTokens,
} from '../agents/cursor.js';

describe('estimateCursorTokens', () => {
  it('applies the prompt multiplier only to user text, not tool results', () => {
    const userChars = CURSOR_CHARS_PER_TOKEN * 10; // 10 visible tokens
    const toolResultChars = CURSOR_CHARS_PER_TOKEN * 100; // 100 tokens of file read
    const r = estimateCursorTokens({
      userChars,
      toolResultChars,
      assistantChars: 0,
      thinkingChars: 0,
      toolUseChars: 0,
    });
    expect(r.inputTokens).toBe(10 * CURSOR_PROMPT_CONTEXT_MULTIPLIER + 100);
    expect(r.outputTokens).toBe(0);
  });

  it('counts thinking and tool-call args as output', () => {
    const r = estimateCursorTokens({
      userChars: 0,
      toolResultChars: 0,
      assistantChars: CURSOR_CHARS_PER_TOKEN * 4,
      thinkingChars: CURSOR_CHARS_PER_TOKEN * 6,
      toolUseChars: CURSOR_CHARS_PER_TOKEN * 10,
    });
    expect(r.outputTokens).toBe(20);
    expect(r.inputTokens).toBe(0);
  });
});

describe('measureCursorJsonlTokens', () => {
  it('counts tool results as input and thinking as output', () => {
    const lines = [
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'hello world' }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'reason about the file' },
            { type: 'text', text: 'ok' },
            { type: 'tool_use', name: 'Read', input: { path: '/tmp/a.ts' } },
            { type: 'tool_result', content: 'export const x = 1;\n'.repeat(20) },
          ],
        },
      }),
    ];
    const r = measureCursorJsonlTokens(lines);
    const userOnly = estimateCursorTokens({
      userChars: 'hello world'.length,
      toolResultChars: 0,
      assistantChars: 0,
      thinkingChars: 0,
      toolUseChars: 0,
    });
    expect(r.inputTokens).toBeGreaterThan(userOnly.inputTokens);
    expect(r.outputTokens).toBeGreaterThan(0);
  });

  it('does not skip tool I/O the way the old plain-text estimator did', () => {
    const toolBody = 'x'.repeat(3500); // ~1000 tokens at 3.5 chars
    const lines = [
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_result', content: toolBody }] },
      }),
    ];
    const r = measureCursorJsonlTokens(lines);
    expect(r.inputTokens).toBeGreaterThanOrEqual(900);
    expect(r.inputTokens).toBeLessThanOrEqual(1100);
  });
});
