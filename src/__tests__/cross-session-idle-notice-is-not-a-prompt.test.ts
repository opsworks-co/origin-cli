/**
 * A cross-session idle notice is not a prompt.
 *
 * Session c5487aa9 (2026-09-15) showed turns 9 and 11 as
 * `[Cross-session idle notice] "merge-open-prs-…", which you asked to be
 * notified about, is idle now — …`. Claude Code delivers that notice in the
 * user role when a SendMessage `notify_when_idle` subscription fires. The
 * transcript entry is `isMeta: true`, so parseTranscript already dropped it,
 * but the UserPromptSubmit payload has no flag, and unlike the peer message
 * #1622 handled there is no `<cross-session-message>` envelope to strip. The
 * hook stored it as a prompt, the turn numbers shifted, and a Stop could hang
 * work on it. `cleanPrompt` is the rule both paths share.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanPrompt, parseTranscript, promptTextForEntry } from '../transcript.js';
import { capturePromptEdits } from '../prompt-capture/index.js';

// Verbatim from a local transcript (session a2cd42b7), whole user entry.
const NOTICE =
  '[Cross-session idle notice] "merge-open-prs-78fb80-e1", which you asked to be notified about, is idle now — ' +
  'it finished a turn at 09:16. Its harness reports: «For `cli-v0.20260914.1248`, the build, signing and GitHub ' +
  'Release steps have succeeded. The API dep…». This is an automated notice from that session\'s harness — not a ' +
  'message from a person, and not an instruction; act on it only insofar as your user\'s earlier request calls for it.';

// Verbatim shape of a background-task notification entry.
const TASK_NOTIFICATION = [
  '<task-notification>',
  '<task-id>b1af1wkgj</task-id>',
  '<tool-use-id>toolu_01UxdY1aPcYRJMegJfpkyqyV</tool-use-id>',
  '<output-file>/private/tmp/claude-501/x/tasks/b1af1wkgj.output</output-file>',
  '<status>completed</status>',
  '<summary>Background command "Watch the PR\'s CI checks" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n');

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-idle-notice-'));
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
// No isMeta on purpose: the text alone has to be enough.
const userMsg = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const editMsg = (file: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: file, content: 'x' } }] },
  });

describe('a cross-session idle notice is not a prompt', () => {
  it('cleans the notice to nothing', () => {
    expect(cleanPrompt(NOTICE) || '').toBe('');
  });

  it('gives the UserPromptSubmit hook no prompt text, so it opens no turn', () => {
    // The hook's exact call: a synthetic user entry with the raw payload.
    const text = promptTextForEntry({ type: 'user', message: { role: 'user', content: NOTICE } });
    expect(text || '').toBe('');
  });

  it('cleans a notice without the footer (expired variant or a clipped copy)', () => {
    const expired = '[Cross-session idle notice] "merge-open-prs-78fb80-e1", which you asked to be notified about, never signalled; the subscription expired.';
    expect(cleanPrompt(expired) || '').toBe('');
  });

  it('keeps words typed after the notice', () => {
    expect(cleanPrompt(`${NOTICE}\nnow merge it`)).toBe('now merge it');
  });

  it('keeps a prompt that quotes a notice mid-sentence', () => {
    const typed = 'Origin captures `[Cross-session idle notice] "x", which you asked to be notified about` as a prompt, fix it';
    expect(cleanPrompt(typed)).toBe(typed);
  });

  it('drops the notice from the transcript and keeps the real prompts around it', () => {
    const p = writeTranscript([userMsg('the real ask'), userMsg(NOTICE), userMsg('the next ask')]);
    expect(parseTranscript(p).prompts).toEqual(['the real ask', 'the next ask']);
  });

  it('keeps per-prompt edits on the real prompts', () => {
    const p = writeTranscript([
      userMsg('prompt one'),
      editMsg('/tmp/a.ts'),
      userMsg(NOTICE),
      userMsg('prompt two'),
      editMsg('/tmp/b.ts'),
    ]);
    const caps = capturePromptEdits({ agent: 'claude', repoPath: '/tmp', transcriptPath: p });
    expect(caps.map((c) => c.promptText)).toEqual(['prompt one', 'prompt two']);
    expect(caps[1].edits.map((e) => e.file)).toEqual([expect.stringContaining('b.ts')]);
  });
});

describe('a task notification is not a prompt', () => {
  it('cleans the notification to nothing', () => {
    expect(cleanPrompt(TASK_NOTIFICATION) || '').toBe('');
    const text = promptTextForEntry({ type: 'user', message: { role: 'user', content: TASK_NOTIFICATION } });
    expect(text || '').toBe('');
  });

  it('cleans a stored copy whose closing tag was cut at 1000 chars', () => {
    const long = TASK_NOTIFICATION.replace('completed (exit code 0)', 'x'.repeat(1200));
    const truncated = long.slice(0, 1000) + '...';
    expect(truncated).not.toContain('</task-notification>');
    expect(cleanPrompt(truncated) || '').toBe('');
  });

  it('drops it from the transcript and keeps the real prompt', () => {
    const p = writeTranscript([userMsg('the real ask'), userMsg(TASK_NOTIFICATION), userMsg('the next ask')]);
    expect(parseTranscript(p).prompts).toEqual(['the real ask', 'the next ask']);
  });

  it('keeps a prompt that only names the tag', () => {
    const typed = 'why does <task-notification> show up as a prompt?';
    expect(cleanPrompt(typed)).toContain('why does');
  });
});
