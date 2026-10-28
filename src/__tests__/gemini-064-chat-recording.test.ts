// Gemini CLI 0.64 rewrote chat recording as append-only deltas: every message
// is its own line (re-appended under the same id as it fills in), metadata
// moves through `$set`, content changes through `$patch`, and the setup turn
// `<session_context>` is an ordinary user record. The fixture below is the
// shape of a real 0.64.0 run (2026-10-15, `--fake-responses`, two prompts, a
// write_file and a replace, the second prompt via `--resume latest`),
// trimmed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTranscript, turnModelUsage, extractPromptFileMappings, cleanPrompt } from '../transcript.js';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gemini-064-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const tokens = (input: number, cached: number, output: number, thoughts = 0) =>
  ({ input, output, cached, thoughts, tool: 0, total: input + output + thoughts });

const sessionContext = [
  '<session_context>',
  'This is the Gemini CLI. We are setting up the context for our chat.',
  "Today's date is Thursday, October 15, 2026 (formatted according to the user's locale).",
  '<loaded_context>',
  '<project_context>',
  "The following are instructions provided by the tool server 'origin':",
  '</project_context>',
  '</loaded_context>',
  '</session_context>',
].join('\n');

function chatFile(): string {
  const model = 'gemini-2.5-pro';
  const fnResponse = (id: string, name: string) => [{ functionResponse: { id, name, response: { output: 'ok' } } }];
  const lines = [
    { sessionId: 'a6e11c95', projectHash: 'h', startTime: '2026-10-15T14:05:06.515Z', lastUpdated: '2026-10-15T14:05:06.515Z', kind: 'main' },
    { id: 'ctx', timestamp: '2026-10-15T14:05:06.515Z', type: 'user', content: [{ text: sessionContext }] },
    { $set: { lastUpdated: '2026-10-15T14:05:06.515Z' } },
    { id: 'u1', timestamp: '2026-10-15T14:05:09.267Z', type: 'user', content: [{ text: 'create add.py with an add function' }] },
    { id: 'g1', timestamp: '2026-10-15T14:05:09.300Z', type: 'gemini', content: '', tokens: tokens(1_200, 200, 40, 10), model },
    { id: 'g1', timestamp: '2026-10-15T14:05:09.300Z', type: 'gemini', content: '', tokens: tokens(1_200, 200, 40, 10), model,
      toolCalls: [{ id: 'write_file__call-1', name: 'write_file', args: { file_path: 'add.py', content: 'def add(a, b):\n    return a + b\n' } }] },
    { id: 'r1', timestamp: '2026-10-15T14:05:10.300Z', type: 'user', content: fnResponse('write_file__call-1', 'write_file') },
    { id: 'g2', timestamp: '2026-10-15T14:05:10.321Z', type: 'gemini', content: 'Created add.py.', tokens: tokens(1_400, 0, 12), model },
    { $set: { sessionId: 'a6e11c95' } },
    // `--resume` rebuilds the history: a function-response turn is re-recorded
    // under the id of the reply it answers, and the setup turn is patched.
    { id: 'g1', timestamp: '2026-10-15T14:05:32.000Z', type: 'user', content: fnResponse('write_file__call-1', 'write_file') },
    { $patch: { updates: [{ id: 'ctx', content: [{ text: sessionContext }] }] } },
    { id: 'u2', timestamp: '2026-10-15T14:05:32.264Z', type: 'user', content: [{ text: 'append hello from gemini 64 to notes.txt' }] },
    { id: 'g3', timestamp: '2026-10-15T14:05:34.300Z', type: 'gemini', content: '', tokens: tokens(2_000, 0, 30), model,
      toolCalls: [{ id: 'replace__call-2', name: 'replace', args: { file_path: 'notes.txt', old_string: 'a', new_string: 'b' } }] },
    { id: 'r2', timestamp: '2026-10-15T14:05:35.000Z', type: 'user', content: fnResponse('replace__call-2', 'replace') },
    { id: 'g4', timestamp: '2026-10-15T14:05:35.033Z', type: 'gemini', content: 'Appended the line.', tokens: tokens(2_100, 1_500, 8), model },
  ];
  const p = path.join(dir, 'session-2026-10-15T14-05-a6e11c95.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

describe('Gemini CLI 0.64 chat recording', () => {
  it('the <session_context> setup turn is not a prompt', () => {
    expect(parseTranscript(chatFile()).prompts).toEqual([
      'create add.py with an add function',
      'append hello from gemini 64 to notes.txt',
    ]);
  });

  it('per-prompt mappings count the same two prompts', () => {
    const rows = extractPromptFileMappings(chatFile(), { repoRoots: [dir] });
    expect(rows.map((r) => r.promptText)).toEqual([
      'create add.py with an add function',
      'append hello from gemini 64 to notes.txt',
    ]);
  });

  it('tokens land on the prompt that spent them, a re-appended reply once', () => {
    const p = parseTranscript(chatFile());
    const u = (input: number, output: number, cacheRead: number) => [
      { model: 'gemini-2.5-pro', inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: 0, cacheCreation1hTokens: 0 },
    ];
    expect(turnModelUsage(p, 0)).toEqual(u(1_000 + 1_400, 50 + 12, 200));
    expect(turnModelUsage(p, 1)).toEqual(u(2_000 + 600, 30 + 8, 1_500));
  });

  it('a clipped setup turn is still dropped; a prompt that mentions the tag is kept', () => {
    expect(cleanPrompt(sessionContext.slice(0, 120))).toBeNull();
    expect(cleanPrompt('why does <session_context> show up?')).toBe('why does <session_context> show up?');
    expect(cleanPrompt('fix it<hook_context>Origin: Session tracking active</hook_context>')).toBe('fix it');
  });
});
