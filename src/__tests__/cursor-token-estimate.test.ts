import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CURSOR_CHARS_PER_TOKEN,
  CURSOR_PROMPT_CONTEXT_MULTIPLIER,
  cursorTranscriptLookupId,
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

  it('reconstructs a missing Read result from disk and bills the next request as cache', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tokens-'));
    const file = path.join(dir, 'note.ts');
    // ~1000 tokens of file body that Cursor never writes into the JSONL.
    fs.writeFileSync(file, 'x'.repeat(3500));
    const lines = [
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'read the note' }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'ReadFile', input: { path: file } }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
    ];
    const r = measureCursorJsonlTokens(lines);
    expect(r.inputTokens).toBeGreaterThanOrEqual(900);
    expect(r.cacheReadTokens).toBeGreaterThan(0);
    expect(r.tokensUsed).toBe(r.inputTokens + r.outputTokens);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not bill a Read of an image as its bytes decoded as text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tokens-'));
    const file = path.join(dir, 'shot.png');
    // PNG signature (NUL at byte 8) + 40 KB of body — ~11k tokens if counted as text.
    fs.writeFileSync(file, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
      Buffer.alloc(40_000, 0x41),
    ]));
    const r = measureCursorJsonlTokens([
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { path: file } }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
    ]);
    expect(r.inputTokens).toBeLessThan(100);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('respects Read offset/limit so a slice is not billed as the whole file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tokens-'));
    const file = path.join(dir, 'big.ts');
    fs.writeFileSync(file, `${'line\n'.repeat(400)}end\n`);
    const full = measureCursorJsonlTokens([
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { path: file } }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
    ]);
    const sliced = measureCursorJsonlTokens([
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { path: file, offset: 1, limit: 2 } }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
    ]);
    expect(full.inputTokens).toBeGreaterThan(sliced.inputTokens);
    expect(sliced.inputTokens).toBeLessThan(20);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('cursorTranscriptLookupId', () => {
  it('prefers the stable conversation_id over a rotating session_id', () => {
    expect(cursorTranscriptLookupId({
      session_id: 'turn-rotates-every-stop',
      conversation_id: '6afa9d45-76ed-484a-baf2-7ef937885831',
    })).toBe('6afa9d45-76ed-484a-baf2-7ef937885831');
  });

  it('falls back to session_id when conversation_id is absent', () => {
    expect(cursorTranscriptLookupId({ session_id: 'only-session' })).toBe('only-session');
  });
});
