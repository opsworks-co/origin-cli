/**
 * Injected messages must not count as prompts in the EDIT pipeline.
 *
 * Prod session 0c65017f: the user reported "prompt 5 apparently made some
 * changes, but we didn't capture it". The Stop hook had in fact captured that
 * turn — the log shows `currentPromptIdx:4, filesChanged:11` and a successful
 * send — yet the row rendered empty.
 *
 * Two prompt counts had drifted apart. `parseTranscript` (the prompt LIST)
 * read 6 prompts from that transcript. `capturePromptEdits` (the per-prompt
 * EDITS) read 18, because agents inject their own messages in the USER role —
 * `<task-notification>` when a background task reports, `<system-reminder>`,
 * hook feedback — and each one opened a fresh turn. Five consecutive
 * task-notifications sat between prompt 1 and prompt 2 alone.
 *
 * The caller looks edits up by the SESSION's promptIndex, so prompt 5 asked
 * for capture index 4 and got a task-notification's empty capture; its real
 * edit was at index 9. Sessions that use background tasks drift hardest.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { capturePromptEdits } from '../prompt-capture/index.js';

function userMsg(text: string) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
}
function editMsg(file: string, content: string) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: file, content } }] },
  });
}

const TASK_NOTIFICATION = [
  '<task-notification>',
  '<task-id>bszvrvss9</task-id>',
  '<summary>Background command completed</summary>',
  '</task-notification>',
].join('\n');

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-capture-'));
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('capturePromptEdits — only real prompts open a turn', () => {
  it('keeps capture indices aligned with the real prompt list', () => {
    // The prod shape: notifications land between real prompts, and the turn
    // that does the work is the last one.
    const transcript = writeTranscript([
      userMsg('prompt one'),
      editMsg('/tmp/a.ts', 'a'),
      userMsg(TASK_NOTIFICATION),
      userMsg(TASK_NOTIFICATION),
      userMsg('prompt two'),
      userMsg(TASK_NOTIFICATION),
      userMsg('yes, fix it'),
      editMsg('/tmp/b.ts', 'b'),
    ]);

    const caps = capturePromptEdits({ agent: 'claude', repoPath: '/tmp', transcriptPath: transcript });

    expect(caps.map((c) => c.promptText)).toEqual(['prompt one', 'prompt two', 'yes, fix it']);
    // The work of the third prompt is reachable at index 2 — the index the
    // session's own prompt list will use. Unfiltered, this sat at index 5.
    expect(caps[2].edits).toHaveLength(1);
    expect(caps[2].edits[0].file).toContain('b.ts');
    // And nothing empty is wedged in between.
    expect(caps).toHaveLength(3);
  });

  it('does not count a system-reminder as a prompt', () => {
    const transcript = writeTranscript([
      userMsg('real prompt'),
      userMsg('<system-reminder>some injected note</system-reminder>'),
      editMsg('/tmp/c.ts', 'c'),
    ]);

    const caps = capturePromptEdits({ agent: 'claude', repoPath: '/tmp', transcriptPath: transcript });

    expect(caps).toHaveLength(1);
    expect(caps[0].promptText).toBe('real prompt');
    // The edit belongs to the real prompt's turn, not to a phantom one.
    expect(caps[0].edits).toHaveLength(1);
  });

  it('keeps a prompt whose text merely CONTAINS an injected block', () => {
    // The user's own words must survive alongside a trailing reminder.
    const transcript = writeTranscript([
      userMsg('fix the parser\n<system-reminder>context</system-reminder>'),
      editMsg('/tmp/d.ts', 'd'),
    ]);

    const caps = capturePromptEdits({ agent: 'claude', repoPath: '/tmp', transcriptPath: transcript });

    expect(caps).toHaveLength(1);
    expect(caps[0].promptText).toContain('fix the parser');
    expect(caps[0].edits).toHaveLength(1);
  });
});
