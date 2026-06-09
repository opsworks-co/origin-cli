// Unit tests for extractPromptImages across all four supported agent
// formats. Each test writes a minimal synthetic transcript to a temp
// file (not a real captured session — the synthetic shape lets us
// assert exact counts and prompt-index alignment).
//
// Drift sentinel: if an agent renames `inlineData` to `inline_data`,
// switches from `input_image` to `image`, or drops the
// `<image_files>` marker, these tests fail rather than silently
// shipping a "0 images" capture.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractPromptImages } from '../transcript.js';

function tmpFile(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-img-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

// Tiny 1×1 transparent PNG, base64 — enough payload to exercise the
// sizeBytes math without inflating the test file.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen8z4cAAAAASUVORK5CYII=';

describe('extractPromptImages — Claude content blocks', () => {
  it('pulls base64 image blocks from user-role JSONL entries', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'check this screenshot' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
      }),
    ];
    const p = tmpFile('claude.jsonl', lines.join('\n'));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      promptIndex: 0,
      imageIndex: 0,
      mediaType: 'image/png',
      base64: PNG_B64,
    });
    expect(out[0].sizeBytes).toBeGreaterThan(0);
  });

  it('captures image-only user turns (no caption — drag-and-drop)', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
          ],
        },
      }),
    ];
    const p = tmpFile('claude-image-only.jsonl', lines.join('\n'));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0].promptIndex).toBe(0);
  });

  it('skips tool_result user entries (no text → no prompt index bump)', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'real prompt' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
          ],
        },
      }),
    ];
    const p = tmpFile('claude-tool.jsonl', lines.join('\n'));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0].promptIndex).toBe(0);
  });
});

describe('extractPromptImages — Cursor <image_files> markers', () => {
  it('reads disk paths embedded in user text, base64-encodes them', () => {
    // Create a temp PNG on disk and reference it from the marker.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-asset-'));
    const imgPath = path.join(dir, 'image-test.png');
    fs.writeFileSync(imgPath, Buffer.from(PNG_B64, 'base64'));

    const lines = [
      JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: `<image_files>The following images were provided: 1. ${imgPath}\nEnd.</image_files>\nfix this`,
            },
          ],
        },
      }),
    ];
    const p = tmpFile('cursor.jsonl', lines.join('\n'));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      promptIndex: 0,
      mediaType: 'image/png',
      base64: PNG_B64,
    });
  });

  it('silently drops missing files (Cursor sometimes cleans assets)', () => {
    const lines = [
      JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<image_files>1. /tmp/origin-test-missing-image-zzz.png</image_files>do it',
            },
          ],
        },
      }),
    ];
    const p = tmpFile('cursor-missing.jsonl', lines.join('\n'));
    const out = extractPromptImages(p);
    expect(out).toEqual([]);
  });
});

describe('extractPromptImages — Codex input_image', () => {
  it('extracts data URLs from response_item message payloads', () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'analyse' },
            { type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}` },
          ],
        },
      }),
    ];
    const p = tmpFile('codex.jsonl', lines.join('\n'));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      promptIndex: 0,
      mediaType: 'image/png',
      base64: PNG_B64,
    });
  });

  it('captures image-only Codex turns (no input_text)', () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}` },
          ],
        },
      }),
    ];
    const p = tmpFile('codex-image-only.jsonl', lines.join('\n'));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0].promptIndex).toBe(0);
  });

  it('handles object form image_url: {url}', () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'see' },
            { type: 'input_image', image_url: { url: `data:image/jpeg;base64,${PNG_B64}` } },
          ],
        },
      }),
    ];
    const p = tmpFile('codex-obj.jsonl', lines.join('\n'));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0].mediaType).toBe('image/jpeg');
  });
});

describe('extractPromptImages — Gemini inlineData', () => {
  it('walks user messages and extracts inlineData parts', () => {
    const doc = {
      messages: [
        {
          type: 'user',
          parts: [
            { text: 'help' },
            { inlineData: { mimeType: 'image/png', data: PNG_B64 } },
          ],
        },
        {
          type: 'gemini',
          content: 'ok',
        },
      ],
    };
    const p = tmpFile('gemini.json', JSON.stringify(doc));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      promptIndex: 0,
      mediaType: 'image/png',
      base64: PNG_B64,
    });
  });

  it('captures image-only Gemini turns (parts with only inlineData)', () => {
    const doc = {
      messages: [
        {
          type: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }],
        },
      ],
    };
    const p = tmpFile('gemini-image-only.json', JSON.stringify(doc));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0].promptIndex).toBe(0);
  });

  it('accepts the snake_case inline_data variant', () => {
    const doc = {
      history: [
        {
          role: 'user',
          parts: [
            { text: 'hi' },
            { inline_data: { mime_type: 'image/webp', data: PNG_B64 } },
          ],
        },
      ],
    };
    const p = tmpFile('gemini-snake.json', JSON.stringify(doc));
    const out = extractPromptImages(p);
    expect(out.length).toBe(1);
    expect(out[0].mediaType).toBe('image/webp');
  });
});
