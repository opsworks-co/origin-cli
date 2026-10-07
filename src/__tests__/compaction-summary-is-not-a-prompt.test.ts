/**
 * Claude Code's context compaction writes its summary into the USER role:
 *
 *   {"type":"user","isCompactSummary":true,"message":{"role":"user","content":
 *    "This session is being continued from a previous conversation that ran
 *     out of context. The summary below covers …"}}
 *
 * flagged `isCompactSummary`, not `isMeta`, and with no UserPromptSubmit
 * fired for it. Session c085f0af, 2026-09-26 18:12Z: the summary became turn
 * 15 (`promptSubmittedAt` null, turn id null), its row was built from the
 * transcript's tool inputs alone — +225 lines over two files, one of them a
 * draft the turn had already deleted, the other already on turn 14's row —
 * and the next real prompt sat one index late. The turn that was running
 * continues under its own prompt after a compaction; the summary is nobody's
 * turn.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanPrompt, extractPromptFileMappings, isAgentInjectedEntry, parseTranscript } from '../transcript.js';

const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent: …\n\nContinue the conversation from where it left off without asking the user any further questions.';

function writeTranscript(rows: any[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-compact-'));
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
let t = 0;
const at = () => new Date(Date.UTC(2026, 8, 26, 18, 0, t++)).toISOString();
const user = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', timestamp: at(), message: { role: 'user', content: text }, ...extra,
});
const reply = (id: string) => ({
  type: 'assistant', timestamp: at(),
  message: { id, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});
const writes = (id: string, file: string) => ({
  type: 'assistant', timestamp: at(),
  message: { id, role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Write', input: { file_path: file, content: 'x = 1\n' } }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});
// As Claude Code writes it: string content, isCompactSummary, no isMeta.
const compaction = () => user(SUMMARY, { isCompactSummary: true, isVisibleInTranscriptOnly: true });

describe('a compaction summary in the user role', () => {
  it('is an injection by its flag, like isMeta', () => {
    expect(isAgentInjectedEntry({ isCompactSummary: true })).toBe(true);
    expect(isAgentInjectedEntry({ isMeta: true })).toBe(true);
    expect(isAgentInjectedEntry({})).toBe(false);
  });

  it('is not a prompt: the real prompts keep their count and their order', () => {
    const p = writeTranscript([
      user('merge it yourself, then do 25b883e8'), writes('m1', '/repo/a.ts'),
      compaction(), writes('m2', '/repo/b.ts'), reply('m3'),
      user('merge and release it yourself'), reply('m4'),
    ]);
    expect(parseTranscript(p).prompts).toEqual(['merge it yourself, then do 25b883e8', 'merge and release it yourself']);
  });

  it('leaves the work done after the compaction on the turn that was running', () => {
    const p = writeTranscript([
      user('merge it yourself, then do 25b883e8'), writes('m1', '/repo/a.ts'),
      compaction(), writes('m2', '/repo/b.ts'), reply('m3'),
      user('merge and release it yourself'), reply('m4'),
    ]);
    const maps = extractPromptFileMappings(p);
    expect(maps.map((m) => m.promptIndex)).toEqual([0, 1]);
    expect(maps[0].filesChanged.sort()).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(maps[1].promptText).toBe('merge and release it yourself');
    expect(maps[1].filesChanged).toEqual([]);
  });

  it('is dropped by its opening sentence too, for a producer that carries no flag', () => {
    expect(cleanPrompt(SUMMARY)).toBeNull();
    // A user who quotes the sentence mid-prompt keeps their prompt.
    expect(cleanPrompt('why does the card say "This session is being continued from a previous conversation that ran out of context."?'))
      .toContain('why does the card say');
  });
});
