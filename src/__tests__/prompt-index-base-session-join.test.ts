// `promptIndexBase` is the rebase that keeps an ADOPTED session's turns on
// their native transcript rows. It counted any user entry older than
// `state.startedAt` as pre-session — which is every Copilot session's own first
// prompt, because Copilot's session row is auto-created BY that prompt and so
// carries a `startedAt` a second or two after it.
//
// Prod session fb2d9b62 (sardina, 2 prompts) is the shape it produced: base 1,
// every turn written one row past itself, and the gap-filler manufacturing a
// placeholder for the vacated index — THREE promptChange rows for two prompts,
// the last two showing the same prompt text.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTranscript, extractPromptFileMappings } from '../transcript.js';

const j = (o: any) => JSON.stringify(o);

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-'));
  const f = path.join(dir, 'events.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

describe('promptIndexBase vs. the session-join gap', () => {
  it('does not count a Copilot session\'s own first prompt as pre-session', () => {
    // Exactly prod fb2d9b62's timing: prompt at :16.241, Origin's row at :17.881.
    const f = writeTranscript([
      j({ type: 'session.start', data: { sessionId: 's1' }, timestamp: '2026-08-25T01:42:15.144Z' }),
      j({ type: 'user.message', data: { content: 'Check what’s in repo' }, timestamp: '2026-08-25T01:42:16.241Z' }),
      j({ type: 'assistant.message', data: { messageId: 'm1', model: 'gpt-5.6-terra', content: 'Empty repo.', outputTokens: 5 }, timestamp: '2026-08-25T01:42:20.000Z' }),
      j({ type: 'user.message', data: { content: 'create some files with scripts' }, timestamp: '2026-08-25T01:43:08.800Z' }),
      j({ type: 'assistant.message', data: { messageId: 'm2', model: 'gpt-5.6-terra', content: 'Added scripts/.', outputTokens: 9 }, timestamp: '2026-08-25T01:43:30.000Z' }),
    ]);

    const parsed = parseTranscript(f, { since: '2026-08-25T01:42:17.881Z' });
    // Both prompts belong to this session, and turn one is row 0 — not row 1.
    expect(parsed.prompts).toHaveLength(2);
    expect(parsed.promptIndexBase).toBe(0);

    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });

  it('still rebases a genuinely adopted transcript', () => {
    // Origin joined an hour into the conversation: turn one really did run
    // before it, and must keep its native row so the new turns don't overwrite.
    const f = writeTranscript([
      j({ type: 'user', message: { role: 'user', content: 'first turn' }, timestamp: '2026-08-25T00:00:00.000Z' }),
      j({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }], usage: { output_tokens: 3 } }, timestamp: '2026-08-25T00:00:05.000Z' }),
      j({ type: 'user', message: { role: 'user', content: 'second turn' }, timestamp: '2026-08-25T01:00:00.000Z' }),
      j({ type: 'assistant', message: { id: 'm2', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }], usage: { output_tokens: 3 } }, timestamp: '2026-08-25T01:00:05.000Z' }),
    ]);

    const parsed = parseTranscript(f, { since: '2026-08-25T00:59:00.000Z' });
    expect(parsed.prompts).toEqual(['second turn']);
    expect(parsed.promptIndexBase).toBe(1);

    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });

  it('keeps the first turn\'s file mappings on row 0 across the join gap', () => {
    const f = writeTranscript([
      j({ type: 'session.start', data: { sessionId: 's1' }, timestamp: '2026-08-25T01:42:15.144Z' }),
      j({ type: 'user.message', data: { content: 'create some files with scripts' }, timestamp: '2026-08-25T01:42:16.241Z' }),
      j({
        type: 'assistant.message',
        data: {
          messageId: 'm1',
          model: 'gpt-5.6-terra',
          content: 'Added it.',
          outputTokens: 4,
          toolRequests: [{ toolCallId: 't1', name: 'create', arguments: { path: 'scripts/run.sh', file_text: '#!/usr/bin/env bash\n' } }],
        },
        timestamp: '2026-08-25T01:42:30.000Z',
      }),
    ]);

    const mappings = extractPromptFileMappings(f, { since: '2026-08-25T01:42:17.881Z' });
    expect(mappings).toHaveLength(1);
    expect(mappings[0].promptIndex).toBe(0);
    expect(mappings[0].filesChanged).toContain('scripts/run.sh');

    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });
});
