import { afterEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCodexPromptsTimeline } from '../agents/codex.js';

vi.mock('../utils/sqlite.js', () => ({ querySqlite: () => '' }));
let home = '';
afterEach(() => {
  vi.restoreAllMocks();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

it('recovers modern prompt messages in order, without context or event echoes', () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-timeline-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '14');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'state_5.sqlite'), '');
  const user = (text: string, timestamp?: string) => ({
    type: 'response_item', timestamp,
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  const events = [
    user('# AGENTS.md instructions for /repo\n<INSTRUCTIONS>rules</INSTRUCTIONS>'),
    user('<environment_context>context</environment_context>'),
    user('original prompt', '2026-09-14T01:00:00.000Z'),
    { type: 'event_msg', payload: { type: 'user_message', message: 'original prompt' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'answer' } },
    user('do it', '2026-09-14T02:00:00.000Z'),
    user('do it', '2026-09-14T03:00:00.000Z'),
    { type: 'item.created', item: { role: 'user', content: 'legacy prompt' } },
    { type: 'message', role: 'human', text: 'legacy message' },
  ];
  fs.writeFileSync(path.join(dir, 'rollout-2026-09-14T01-00-00-native-chat.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
  expect(getCodexPromptsTimeline('/repo', 'native-chat')).toEqual([
    { text: 'original prompt', timestamp: Date.parse('2026-09-14T01:00:00.000Z') },
    { text: 'do it', timestamp: Date.parse('2026-09-14T02:00:00.000Z') },
    { text: 'do it', timestamp: Date.parse('2026-09-14T03:00:00.000Z') },
    { text: 'legacy prompt', timestamp: 0 },
    { text: 'legacy message', timestamp: 0 },
  ]);
  expect(getCodexPromptsTimeline('/repo', 'other-chat')).toEqual([]);
});
