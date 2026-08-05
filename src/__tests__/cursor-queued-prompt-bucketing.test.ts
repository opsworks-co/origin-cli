// Regression: Cursor writes a user prompt the MOMENT the user hits enter, even
// while the agent is still working on the previous one. Two user entries then
// sit back-to-back BEFORE either turn's tool calls, and the old "attribute work
// to the most recent user entry" walker gave the first of the pair an EMPTY turn
// and dumped its edits — and its `git commit` — into the next bucket.
//
// Real case (session 7ff68eb7, transcript c757be35): turns 1 and 3 committed,
// but committingPromptsFromTranscript reported [2,3], and turn 1 stored a
// completely empty PromptChange (grey badge, missing from "N with changes").
//
// Cursor closes each agent turn with `{"type":"turn_ended"}`; that marker gates
// the queued-prompt handling so Claude/Gemini/Copilot transcripts (which never
// emit it) keep their existing bucketing exactly.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractPromptFileMappings } from '../transcript.js';
import { capturePromptEdits } from '../prompt-capture/index.js';

// The REAL transcript from session 7ff68eb7 (Cursor conversation c757be35),
// copied verbatim. Ground truth, 4 turns:
//   0 "Create a file called shisha with 11 rows"  (+11)
//   1 "add 5 more rows and commit"                (+5,  commit e815b214)  ← queued pair
//   2 "add 7 more rows"                           (+7)
//   3 "add 8 more and commit"                     (+8,  commit aaf24b52)
const REAL_TRANSCRIPT = path.join(__dirname, 'fixtures', 'cursor-queued-prompts.jsonl');

function write(lines: string[]): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-bucket-'));
  const f = path.join(tmp, 't.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

const cursorUser = (t: string) =>
  JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: `<timestamp>Wednesday, Aug 5, 2026, 1:53 PM (UTC+1)</timestamp>\n<user_query>\n${t}\n</user_query>` }] },
  });
const assistant = (blocks: any[]) => JSON.stringify({ role: 'assistant', message: { content: blocks } });
const turnEnded = () => JSON.stringify({ type: 'turn_ended', status: 'success' });
const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Row ${from + i}`).join('\n') + '\n';
const strReplace = (file: string, oldS: string, newS: string) => ({
  type: 'tool_use', name: 'StrReplace', input: { path: file, old_string: oldS, new_string: newS },
});
const shell = (command: string) => ({ type: 'tool_use', name: 'Shell', input: { command, description: 'd' } });

function countAdd(diff: string): number {
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
}

describe('Cursor queued-prompt bucketing', () => {
  // Mirrors the real transcript: prompt 1 and prompt 2 are written back-to-back
  // (prompt 2 was queued while turn 1 ran), and turn 2 gets no turn_ended before
  // prompt 3 arrives.
  it('attributes each turn\'s edits and commit to the prompt that issued them', () => {
    const f = write([
      cursorUser('Create a file called shisha with 11 rows'),
      assistant([{ type: 'tool_use', name: 'Write', input: { path: '/repo/shisha', contents: rows(1, 11) } }]),
      turnEnded(),
      cursorUser('add 5 more rows and commit'),
      cursorUser('add 7 more rows'), // queued while turn 1 is still running
      assistant([strReplace('/repo/shisha', 'Row 11\n', rows(11, 16))]),
      assistant([shell('git add shisha; git commit -m "Add five more rows"; git status')]),
      turnEnded(),
      assistant([strReplace('/repo/shisha', 'Row 16\n', rows(16, 23))]),
      cursorUser('add 8 more and commit'), // no turn_ended closed the previous turn
      assistant([strReplace('/repo/shisha', 'Row 23\n', rows(23, 31))]),
      assistant([shell('git add shisha; git commit -m "Add eight more rows"; git status')]),
      turnEnded(),
    ]);

    const maps = extractPromptFileMappings(f);
    expect(maps.map((m) => m.promptIndex)).toEqual([0, 1, 2, 3]);
    expect(maps.map((m) => m.promptText.trim())).toEqual([
      'Create a file called shisha with 11 rows',
      'add 5 more rows and commit',
      'add 7 more rows',
      'add 8 more and commit',
    ]);

    // The bug: turn 1 was empty and turn 2 held turn 1's work + commit.
    expect(countAdd(maps[0].diff)).toBe(11);
    expect(maps[1].filesChanged).toEqual(['/repo/shisha']);
    expect(countAdd(maps[1].diff)).toBe(5);
    expect(countAdd(maps[2].diff)).toBe(7);
    expect(countAdd(maps[3].diff)).toBe(8);

    // Drives commit→turn pairing (promptsThatCommitted). Was [2,3].
    expect(maps.filter((m) => m.ranCommit).map((m) => m.promptIndex)).toEqual([1, 3]);
  });

  it('keeps a turn that ended without doing anything from swallowing the next turn\'s work', () => {
    const f = write([
      cursorUser('do the thing'),
      turnEnded(), // aborted before the agent emitted anything
      cursorUser('ok now really do it'),
      assistant([{ type: 'tool_use', name: 'Write', input: { path: '/repo/a.txt', contents: 'x\n' } }]),
      turnEnded(),
    ]);

    const maps = extractPromptFileMappings(f);
    expect(maps.map((m) => m.promptIndex)).toEqual([0, 1]);
    expect(maps[0].filesChanged).toEqual([]);
    expect(maps[1].filesChanged).toEqual(['/repo/a.txt']);
  });

  it('still emits a mapping for a queued prompt the agent never reached', () => {
    const f = write([
      cursorUser('first'),
      assistant([{ type: 'tool_use', name: 'Write', input: { path: '/repo/a.txt', contents: 'x\n' } }]),
      cursorUser('second'), // agent still thinking when the transcript was read
    ]);

    const maps = extractPromptFileMappings(f);
    // One mapping per prompt keeps promptIndex aligned with the session's
    // prompt list, which is what the dashboard indexes turns by.
    expect(maps.map((m) => m.promptIndex)).toEqual([0, 1]);
    expect(maps[0].filesChanged).toEqual(['/repo/a.txt']);
    expect(maps[1].promptText.trim()).toBe('second');
    expect(maps[1].filesChanged).toEqual([]);
  });
});

describe('the real transcript that reported the bug (session 7ff68eb7)', () => {
  it('extractPromptFileMappings: turn 1 owns its +5 and its commit', () => {
    const maps = extractPromptFileMappings(REAL_TRANSCRIPT);
    expect(maps.map((m) => m.promptText.trim())).toEqual([
      'Create a file called shisha with 11 rows',
      'add 5 more rows and commit',
      'add 7 more rows',
      'add 8 more and commit',
    ]);
    // Turn 1 stored a completely empty PromptChange before the fix.
    expect(maps[1].filesChanged.map((f) => f.toLowerCase())).toEqual(['c:\\soft\\origin-demo-1\\shisha']);
    expect(countAdd(maps[1].diff)).toBe(5);
    // Was [2,3] — which would have paired both commits with the wrong turns.
    expect(maps.filter((m) => m.ranCommit).map((m) => m.promptIndex)).toEqual([1, 3]);
  });

  it('capturePromptEdits: every turn gets exactly its own edit, none duplicated', () => {
    const turns = capturePromptEdits({
      agent: 'cursor',
      repoPath: 'c:/soft/origin-demo-1',
      transcriptPath: REAL_TRANSCRIPT,
      sessionCommitShas: [],
    });
    expect(turns.length).toBe(4);
    // Before the fix: turn 1 had zero edits and turn 2 carried two — so turn 1's
    // editsJson said "this turn touched nothing" and the dashboard greyed it out.
    // Compared by basename: the transcript spells the repo root both `c:\` and
    // `C:\`, and only the case that matches repoPath gets relativized.
    for (const t of turns) {
      expect(t.edits.map((e) => path.basename(e.file.replace(/\\/g, '/')))).toEqual(['shisha']);
    }
  });
});

describe('non-Cursor transcripts keep their existing bucketing', () => {
  it('Claude Code: tool_result user entries do not split a turn, and edits stay with their prompt', () => {
    const claudeUser = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } });
    const toolResult = () =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
    const claudeAssistant = (blocks: any[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });

    const f = write([
      claudeUser('write a.txt'),
      claudeAssistant([{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/a.txt', content: 'a1\na2\n' } }]),
      toolResult(),
      claudeAssistant([{ type: 'text', text: 'done' }]),
      claudeUser('now append to a.txt and commit'),
      claudeAssistant([{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.txt', old_string: 'a2\n', new_string: 'a2\na3\n' } }]),
      toolResult(),
      claudeAssistant([{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -am wip' } }]),
    ]);

    const maps = extractPromptFileMappings(f);
    expect(maps.map((m) => m.promptIndex)).toEqual([0, 1]);
    expect(countAdd(maps[0].diff)).toBe(2);
    expect(maps[1].filesChanged).toEqual(['/repo/a.txt']);
    expect(countAdd(maps[1].diff)).toBe(1);
    expect(maps.filter((m) => m.ranCommit).map((m) => m.promptIndex)).toEqual([1]);
  });

  it('Claude Code: back-to-back user prompts keep the legacy last-prompt-wins bucketing', () => {
    // Without turn markers there is no way to tell a queued prompt from two
    // messages the agent answered in one go, so this path is left untouched.
    const claudeUser = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } });
    const claudeAssistant = (blocks: any[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });

    const f = write([
      claudeUser('one'),
      claudeUser('two'),
      claudeAssistant([{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/a.txt', content: 'x\n' } }]),
    ]);

    const maps = extractPromptFileMappings(f);
    expect(maps.map((m) => m.promptIndex)).toEqual([0, 1]);
    expect(maps[0].filesChanged).toEqual([]);
    expect(maps[1].filesChanged).toEqual(['/repo/a.txt']);
  });

  it('Gemini: single-object transcripts are unaffected', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-bucket-gemini-'));
    const f = path.join(tmp, 'chat.json');
    fs.writeFileSync(
      f,
      JSON.stringify({
        messages: [
          { role: 'user', parts: [{ text: 'make a.txt' }] },
          { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { file_path: '/repo/a.txt', content: 'x\n' } } }] },
          { role: 'user', parts: [{ text: 'make b.txt' }] },
          { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { file_path: '/repo/b.txt', content: 'y\n' } } }] },
        ],
      }),
    );

    const maps = extractPromptFileMappings(f);
    expect(maps.map((m) => m.promptIndex)).toEqual([0, 1]);
    expect(maps[0].filesChanged).toEqual(['/repo/a.txt']);
    expect(maps[1].filesChanged).toEqual(['/repo/b.txt']);
  });
});
