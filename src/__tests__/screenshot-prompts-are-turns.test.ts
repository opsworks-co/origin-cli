// A screenshot IS a prompt — often the whole prompt, dragged in with no
// caption. Three readers have to agree about that, or they number turns
// differently and images land on the wrong one:
//
//   parseTranscript            → the prompt rows the server stores
//   extractPromptFileMappings  → the per-turn file/diff attribution
//   extractPromptImages        → the promptIndex each image is uploaded under
//
// Before this, only the third counted a captionless image as a turn. So the
// image-only prompt got no row at all, and from that point on every later image
// was uploaded one row too high.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseTranscript,
  extractPromptFileMappings,
  extractPromptImages,
  codexUserPromptText,
} from '../transcript.js';

let tmp = '';

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-prompts-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const PNG = Buffer.from('fake-png-bytes').toString('base64');

function writeJsonl(name: string, lines: unknown[]): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

function userImage(extra: unknown[] = []) {
  return {
    type: 'user',
    message: { role: 'user', content: [...extra, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
  };
}

function assistantWrite(file: string) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: file, content: 'x' } }] },
  };
}

describe('a captionless screenshot is a turn', () => {
  it('gives an image-only prompt a row, and numbers every reader the same way', () => {
    const p = writeJsonl('claude.jsonl', [
      userImage(),                                   // prompt 0: screenshot, no text
      assistantWrite('src/a.ts'),
      userImage([{ type: 'text', text: 'and this one too' }]),  // prompt 1: text + screenshot
      assistantWrite('src/b.ts'),
    ]);

    const parsed = parseTranscript(p);
    expect(parsed.prompts).toEqual(['[image]', 'and this one too\n[image]']);

    const mappings = extractPromptFileMappings(p);
    expect(mappings.map((m) => [m.promptIndex, m.filesChanged])).toEqual([
      [0, ['src/a.ts']],
      [1, ['src/b.ts']],
    ]);

    // The whole point: the image extractor's indices address rows that exist.
    const images = extractPromptImages(p);
    expect(images.map((i) => [i.promptIndex, i.imageIndex])).toEqual([[0, 0], [1, 0]]);
    for (const img of images) {
      expect(parsed.prompts[img.promptIndex]).toBeDefined();
    }
  });

  it('does not let a sub-agent turn consume an image index', () => {
    const p = writeJsonl('sidechain.jsonl', [
      { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: 'dispatch' }] } },
      userImage([{ type: 'text', text: 'look at this' }]),
    ]);

    expect(parseTranscript(p).prompts).toEqual(['look at this\n[image]']);
    expect(extractPromptImages(p).map((i) => i.promptIndex)).toEqual([0]);
  });

  it('carries one placeholder per image, in order', () => {
    const p = writeJsonl('two-images.jsonl', [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'before and after' },
            { type: 'image', source: { media_type: 'image/png', data: PNG } },
            { type: 'image', source: { media_type: 'image/png', data: PNG } },
          ],
        },
      },
      // Keeps the fixture JSONL: a lone JSON object is sniffed as a
      // single-document (Gemini) transcript, not as one-line JSONL.
      assistantWrite('src/a.ts'),
    ]);

    expect(parseTranscript(p).prompts).toEqual(['before and after\n[image] [image]']);
    expect(extractPromptImages(p).map((i) => i.imageIndex)).toEqual([0, 1]);
  });

  it('keeps the slot of an image it cannot read, so the rest stay aligned', () => {
    // Cursor writes the image to disk and references it by path. The first path
    // no longer exists; the second does. The surviving image is still image #1,
    // because the prompt text carries a placeholder for both.
    const real = path.join(tmp, 'shot.png');
    fs.writeFileSync(real, 'png');
    const missing = path.join(tmp, 'gone.png');
    const p = writeJsonl('cursor.jsonl', [
      {
        role: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `see these\n<image_files>1. ${missing.replace(/\\/g, '/')} 2. ${real.replace(/\\/g, '/')}</image_files>` }],
        },
      },
      assistantWrite('src/a.ts'),
    ]);

    // The raw marker doesn't survive into the prompt — the placeholders replace it.
    expect(parseTranscript(p).prompts).toEqual(['see these\n[image] [image]']);
    expect(extractPromptImages(p).map((i) => i.imageIndex)).toEqual([1]);
  });
});

describe('a Cursor image marker is read on every platform', () => {
  it('counts a Windows drive path, not just a POSIX one', () => {
    // The path matcher required a leading `/`, so nothing under `C:\Users\…`
    // ever matched — on Windows, Cursor's on-disk screenshots were invisible.
    // Asserted on the placeholder count so this pins the rule on any host: the
    // file itself doesn't exist, so no bytes come back either way.
    const p = writeJsonl('cursor-win.jsonl', [
      {
        role: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'fix this\n<image_files>1. C:\\Users\\dev\\AppData\\Local\\Temp\\shot.png</image_files>' }] },
      },
      assistantWrite('src/a.ts'),
    ]);
    expect(parseTranscript(p).prompts).toEqual(['fix this\n[image]']);
  });
});

describe('codex numbers images against the turns its parsers keep', () => {
  it('drops the replayed AGENTS.md echo from both sides', () => {
    // Codex replays AGENTS.md as the FIRST user event of every rollout in a repo
    // that has one. The parsers have always dropped it; the image extractor
    // counted it, which put every Codex screenshot one turn late.
    const echo = '# AGENTS.md instructions for /repo\n\ndo the thing';
    expect(codexUserPromptText(echo)).toBeNull();

    const p = writeJsonl('rollout.jsonl', [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: echo }] } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` }],
        },
      },
    ]);

    expect(extractPromptImages(p).map((i) => i.promptIndex)).toEqual([0]);
  });
});
