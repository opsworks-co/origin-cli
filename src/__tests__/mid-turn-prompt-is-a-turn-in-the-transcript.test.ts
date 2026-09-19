/**
 * A message the user sends while a turn is running is a turn in the transcript.
 *
 * Claude Code does not write it as a `user` entry. It queues it, and when the
 * running turn absorbs it the transcript gets an ATTACHMENT:
 *
 *   {"type":"attachment","attachment":{"type":"queued_command","prompt":"look into the 274a6cd2 session…",
 *                                      "commandMode":"prompt","origin":{"kind":"human"}}}
 *
 * UserPromptSubmit fires for it, so the hook's list gained prompt 10; the
 * transcript readers looked only at `user` entries and did not. Session
 * ad95e766 (2026-09-18): 24 hook prompts, 23 transcript prompts, every row from
 * 10 on carrying the NEXT prompt's text, one edit sent under rows 19 and 20,
 * and the dashboard showing work one turn early.
 *
 * The same attachment type also delivers task notifications and other
 * sessions' messages mid-turn (16 of that transcript's 17). Those are not
 * prompts on either side and must stay that way.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractPromptFileMappings, midTurnPromptAsUserEntry, parseTranscript } from '../transcript.js';
import { capturePromptEdits } from '../prompt-capture/index.js';
import { turnThisStopCloses } from '../session-state.js';

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mid-turn-'));
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
const queued = (prompt: unknown, commandMode: string, origin?: { kind: string }) => ({
  type: 'attachment',
  isSidechain: false,
  timestamp: '2026-09-18T17:10:22.039Z',
  attachment: { type: 'queued_command', prompt, commandMode, ...(origin ? { origin } : {}), timestamp: '2026-09-18T17:10:22.039Z' },
});
const line = (o: unknown) => JSON.stringify(o);

const MID_TURN = 'look into the 274a6cd2 session that disables the ledger';
const TASK_NOTE = '<task-notification>\n<task-id>bil7m9lru</task-id>\n<status>completed</status>\n</task-notification>';
const PEER = '<cross-session-message from="uds:/tmp/cc-socks/52782.sock" from-name="Cost review" from-mode="bypass">\nPR is ready.\n</cross-session-message>';

/** The shape of ad95e766 around its tenth prompt, in miniature. */
const conversation = () => writeTranscript([
  userMsg('finish the live check'),
  editMsg('/repo/a.ts'),
  line({ type: 'queue-operation', operation: 'enqueue', content: MID_TURN }),
  line(queued(TASK_NOTE, 'task-notification')),
  line(queued(PEER, 'prompt', { kind: 'peer' })),
  line(queued(MID_TURN, 'prompt', { kind: 'human' })),
  line({ type: 'queue-operation', operation: 'remove', content: MID_TURN, reason: 'absorbed_mid_turn' }),
  editMsg('/repo/b.ts'),
  userMsg('all done here?'),
  editMsg('/repo/c.ts'),
]);

describe('midTurnPromptAsUserEntry', () => {
  it('turns a human mid-turn prompt into a user entry, and keeps what it carried', () => {
    const got = midTurnPromptAsUserEntry(queued(MID_TURN, 'prompt', { kind: 'human' })) as any;
    expect(got.type).toBe('user');
    expect(got.message).toEqual({ role: 'user', content: MID_TURN });
    expect(got.timestamp).toBe('2026-09-18T17:10:22.039Z');
  });

  it('accepts content blocks, and an older record with no origin', () => {
    const blocks = [{ type: 'text', text: 'and this screenshot' }, { type: 'image', source: { type: 'base64', data: 'AA==' } }];
    expect((midTurnPromptAsUserEntry(queued(blocks, 'prompt', { kind: 'human' })) as any).message.content).toBe(blocks);
    expect((midTurnPromptAsUserEntry(queued(MID_TURN, 'prompt')) as any).type).toBe('user');
  });

  it.each([
    ['a task notification', queued(TASK_NOTE, 'task-notification')],
    ['another session\'s message', queued(PEER, 'prompt', { kind: 'peer' })],
    ['an empty prompt', queued('   ', 'prompt', { kind: 'human' })],
    ['some other attachment', { type: 'attachment', attachment: { type: 'hook_success' } }],
    ['an ordinary user entry', JSON.parse(userMsg('hello'))],
  ])('leaves %s exactly as it was', (_name, entry) => {
    expect(midTurnPromptAsUserEntry(entry)).toBe(entry);
  });
});

describe('a mid-turn prompt in a Claude Code transcript', () => {
  it('is a prompt, in its place — so the rows are numbered as the hook numbers them', () => {
    const parsed = parseTranscript(conversation());
    expect(parsed.prompts).toEqual(['finish the live check', MID_TURN, 'all done here?']);
    // And it is remembered as absorbed, which is what Stop needs to know.
    expect(parsed.midTurnPrompts).toEqual([1]);
  });

  it('an older record without an origin still drops a peer message and a notification by their text', () => {
    const p = writeTranscript([
      userMsg('one'),
      line(queued(PEER, 'prompt')),
      line(queued(TASK_NOTE, 'prompt')),
      line(queued(MID_TURN, 'prompt')),
      userMsg('three'),
    ]);
    expect(parseTranscript(p).prompts).toEqual(['one', MID_TURN, 'three']);
  });

  it('takes the work that follows it, in the per-turn file mappings', () => {
    const rows = extractPromptFileMappings(conversation(), { repoRoots: ['/repo'] });
    expect(rows.map((r) => [r.promptIndex, r.promptText, r.filesChanged])).toEqual([
      [0, 'finish the live check', ['a.ts']],
      [1, MID_TURN, ['b.ts']],
      [2, 'all done here?', ['c.ts']],
    ]);
  });

  it('and in the per-prompt edits, which count prompts on their own', () => {
    const caps = capturePromptEdits({ agent: 'claude', repoPath: '/repo', transcriptPath: conversation() });
    expect(caps.map((c) => c.promptText)).toEqual(['finish the live check', MID_TURN, 'all done here?']);
    expect(caps.map((c) => c.edits.map((e) => path.basename(e.file)))).toEqual([['a.ts'], ['b.ts'], ['c.ts']]);
  });
});

describe('turnThisStopCloses', () => {
  const prompts = ['finish the live check', MID_TURN, 'all done here?'];
  const parsed = { prompts, midTurnPrompts: [1] };

  it('is the absorbed prompt\'s turn, not the older one the hook still holds open', () => {
    // Submit appended the prompt and cut its shadow, but must not steal a
    // running turn (#1133) — so `activeTurn` still names turn 0 at this Stop.
    expect(turnThisStopCloses({ prompts: prompts.slice(0, 2), activeTurn: { index: 0 } }, { prompts: prompts.slice(0, 2), midTurnPrompts: [1] })).toBe(1);
  });

  it('takes the LAST of several absorbed prompts', () => {
    const many = ['one', 'two, mid-turn', 'three, mid-turn too'];
    expect(turnThisStopCloses({ prompts: many, activeTurn: { index: 0 } }, { prompts: many, midTurnPrompts: [1, 2] })).toBe(2);
  });

  it('matches by text: the hook may hold more turns than the transcript numbers', () => {
    const hook = ['from an earlier launch', ...prompts.slice(0, 2)];
    expect(turnThisStopCloses({ prompts: hook, activeTurn: { index: 1 } }, { prompts: prompts.slice(0, 2), midTurnPrompts: [1] })).toBe(2);
  });

  it.each([
    ['nothing was absorbed', { prompts: prompts.slice(0, 2), activeTurn: { index: 0 } }, { prompts: prompts.slice(0, 2) }, 0],
    ['the absorbed prompt is the open turn already', { prompts: prompts.slice(0, 2), activeTurn: { index: 1 } }, { prompts: prompts.slice(0, 2), midTurnPrompts: [1] }, 1],
    ['the absorbed prompt is BEHIND the open turn', { prompts, activeTurn: { index: 2 } }, parsed, 2],
    ['a prompt is only waiting in the queue (in the hook list, not absorbed)', { prompts: ['one', 'queued'], activeTurn: { index: 0 } }, { prompts: ['one'], midTurnPrompts: [] }, 0],
    ['no turn was ever opened (a chat-only turn): the list tail, as before', { prompts, activeTurn: null }, parsed, 2],
    ['there is no transcript to ask', { prompts, activeTurn: { index: 1 } }, null, 1],
  ])('changes nothing when %s', (_why, state, p, want) => {
    expect(turnThisStopCloses(state as any, p as any)).toBe(want);
  });
});
