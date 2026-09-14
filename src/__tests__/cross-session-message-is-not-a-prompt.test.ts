/**
 * A message from another Claude session is not a prompt.
 *
 * Session 74931d94 (a merge-and-release session coordinating with a sibling
 * session over SendMessage) showed 14 turns for 6 prompts. Claude Code
 * delivers a peer's message in the user role, wrapped as
 * `<cross-session-message from=… from-name=…>`. The transcript entry carries
 * `isMeta: true`, so parseTranscript already dropped it, but the
 * UserPromptSubmit payload has no such flag: the hook stored each peer message
 * as a prompt and opened a turn for it. `cleanPrompt` is the rule both paths
 * share, so stripping the envelope there makes them agree again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanPrompt, parseTranscript, promptTextForEntry } from '../transcript.js';
import { capturePromptEdits } from '../prompt-capture/index.js';

const OPEN = '<cross-session-message from="uds:/tmp/cc-socks/3734.sock" from-name="xenodochial-swirles-1444e9-f0" from-mode="bypass">';

// What the UserPromptSubmit hook receives (the shape stored in state.prompts).
const HOOK_PAYLOAD = `${OPEN}\nPR #1619 is ready for you to merge.\n</cross-session-message>\n`;

// What the transcript entry holds: preamble, envelope, then guidance.
const TRANSCRIPT_TEXT = [
  'Another Claude session sent a message:',
  OPEN,
  'PR #1619 is ready for you to merge.',
  '</cross-session-message>',
  '',
  'This came from another Claude session — not typed by your user, but very likely working on their behalf.',
].join('\n');

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-peer-msg-'));
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
const userMsg = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const editMsg = (file: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: file, content: 'x' } }] },
  });

describe('a cross-session message is not a prompt', () => {
  it('cleans the hook payload to nothing', () => {
    expect(cleanPrompt(HOOK_PAYLOAD) || '').toBe('');
  });

  it('cleans a stored payload whose closing tag was cut at 1000 chars', () => {
    const long = `${OPEN}\n${'word '.repeat(400)}\n</cross-session-message>\n`;
    const truncated = long.slice(0, 1000) + '...';
    expect(truncated).not.toContain('</cross-session-message>');
    expect(cleanPrompt(truncated) || '').toBe('');
  });

  it('gives the hook no prompt text, so it opens no turn', () => {
    // The hook's exact call: a synthetic user entry with the raw payload.
    const text = promptTextForEntry({ type: 'user', message: { role: 'user', content: HOOK_PAYLOAD } });
    expect(text || '').toBe('');
  });

  it('drops the transcript form even without isMeta', () => {
    const p = writeTranscript([userMsg('the real ask'), userMsg(TRANSCRIPT_TEXT), userMsg('the next ask')]);
    expect(parseTranscript(p).prompts).toEqual(['the real ask', 'the next ask']);
  });

  it('keeps per-prompt edits on the real prompts', () => {
    const p = writeTranscript([
      userMsg('prompt one'),
      editMsg('/tmp/a.ts'),
      userMsg(TRANSCRIPT_TEXT),
      userMsg('prompt two'),
      editMsg('/tmp/b.ts'),
    ]);
    const caps = capturePromptEdits({ agent: 'claude', repoPath: '/tmp', transcriptPath: p });
    expect(caps.map((c) => c.promptText)).toEqual(['prompt one', 'prompt two']);
    expect(caps[1].edits.map((e) => e.file)).toEqual([expect.stringContaining('b.ts')]);
  });

  it('keeps a prompt that only names the tag', () => {
    const typed = 'why does <cross-session-message> show up as a prompt?';
    expect(cleanPrompt(typed)).toContain('why does');
  });
});
