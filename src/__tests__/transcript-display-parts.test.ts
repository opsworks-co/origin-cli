// The display transcript keeps an assistant message's own words and tool names
// apart from `content`, where tool inputs and outputs are inlined. The public
// share page shows only these parts, so they must never carry a tool's input,
// its output, or the agent's reasoning — and a secret the agent echoes is
// redacted.

import { describe, expect, it, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { formatTranscriptForDisplay } from '../transcript.js';

let tmp: string | null = null;
afterEach(() => { if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } tmp = null; } });

function writeJsonl(lines: object[]): string {
  tmp = path.join(os.tmpdir(), `origin-dp-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l)).join('\n'));
  return tmp;
}

const TOKEN = 'ghp_' + 'a'.repeat(36);

describe('display transcript parts', () => {
  it('keeps prose and tool names, drops tool input, output and reasoning', () => {
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'bump vitest' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'secret plan' },
        { type: 'text', text: 'Reading the manifest.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env\n\necho done' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'API_KEY=hunter2\n\nmore output' },
      ] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: `Bumped it.\n\nYour token ${TOKEN} was in the log.` },
      ] } },
    ]);

    const messages = JSON.parse(formatTranscriptForDisplay(file));
    const reply = messages.find((m: any) => m.role === 'assistant');

    // Two assistant entries merge into one message — and so do their parts.
    expect(messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
    expect(reply.parts).toEqual([
      { text: 'Reading the manifest.' },
      { tool: 'Bash' },
      { text: expect.stringContaining('Bumped it.\n\nYour token') },
    ]);
    const shown = JSON.stringify(reply.parts);
    for (const hidden of ['cat .env', 'echo done', 'hunter2', 'more output', 'secret plan', TOKEN]) {
      expect(shown).not.toContain(hidden);
    }
    // `content` is unchanged: the in-app view still gets the whole thing.
    expect(reply.content).toContain('[Output] API_KEY=hunter2');
  });

  it('a user message carries no parts', () => {
    const file = writeJsonl([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ]);
    const messages = JSON.parse(formatTranscriptForDisplay(file));
    expect(messages[0].parts).toBeUndefined();
    expect(messages[1].parts).toEqual([{ text: 'hello' }]);
  });
});
