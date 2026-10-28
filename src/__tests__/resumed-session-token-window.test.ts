// A resumed row's token totals cover the whole row, while its prompt window
// stays this launch's.
//
// Prod 4f161e29 (Claude Code): the heartbeat ended the session while idle on
// 10-18, and the conversation resumed on 10-19. The new local state started at
// the resume, Stop parsed the transcript `since` it, and the server overwrote
// the session's token columns with only the two turns after the resume: 4,350
// output tokens stored against a true 93,221.
//
// The prompt window must NOT widen with it. `prompts` holds only this launch's
// turns and Stop numbers the turn as `parsed.promptIndexBase + prompts.length
// - 1`, so a base of 0 would aim the resumed turn at row 1 instead of row 10.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSessionTranscript, parseTranscript } from '../transcript.js';

const ROW_START = '2026-10-17T20:50:53.570Z';
const RESUME = '2026-10-19T14:19:05.674Z';

const user = (ts: string, text: string) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const reply = (ts: string, out: number, cacheWrite: number) => JSON.stringify({
  type: 'assistant',
  timestamp: ts,
  message: {
    role: 'assistant', id: `msg_${ts}`, model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'ok' }],
    usage: {
      input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: cacheWrite,
      cache_creation: { ephemeral_1h_input_tokens: cacheWrite, ephemeral_5m_input_tokens: 0 },
    },
  },
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function transcript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-token-window-'));
  dirs.push(dir);
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, [
    // Before the heartbeat ended the row.
    user('2026-10-17T20:51:00.000Z', 'solo accounts need no access tab'),
    reply('2026-10-17T20:52:00.000Z', 7000, 500),
    user('2026-10-18T19:36:00.000Z', 'sort issues by priority'),
    reply('2026-10-18T19:37:00.000Z', 1400, 300),
    // After the resume.
    user('2026-10-19T14:50:00.000Z', 'let the other session merge it'),
    reply('2026-10-19T14:51:00.000Z', 3700, 200),
  ].join('\n') + '\n');
  return file;
}

describe('parseSessionTranscript — a resumed row', () => {
  it('totals the whole row while keeping the prompt window at the resume', () => {
    const file = transcript();
    const parsed = parseSessionTranscript(file, { startedAt: RESUME, sessionStartedAt: ROW_START });

    // Prompt window: unchanged from today's parse since the resume.
    const narrow = parseTranscript(file, { since: RESUME });
    expect(parsed.prompts).toEqual(narrow.prompts);
    expect(parsed.promptIndexBase).toBe(2);
    expect(parsed.turnUsage).toEqual(narrow.turnUsage);

    // Session totals: every turn of the row.
    expect(parsed.outputTokens).toBe(7000 + 1400 + 3700);
    expect(parsed.inputTokens).toBe(30);
    expect(parsed.cacheReadTokens).toBe(3000);
    expect(parsed.cacheCreationTokens).toBe(1000);
    expect(parsed.cacheCreation1hTokens).toBe(1000);
    expect(parsed.tokensUsed).toBe(30 + 12100);
    const split = parsed.modelUsage || [];
    expect(split.reduce((a, m) => a + m.outputTokens, 0)).toBe(parsed.outputTokens);
  });

  it('is today\'s parse when the row started with this launch', () => {
    const file = transcript();
    const parsed = parseSessionTranscript(file, { startedAt: RESUME });
    expect(parsed.outputTokens).toBe(3700);
    expect(parseSessionTranscript(file, { startedAt: RESUME, sessionStartedAt: RESUME }).outputTokens).toBe(3700);
  });
});
