// Every agent's display transcript carries share-safe `parts` on its assistant
// messages: the agent's own words and the names of the tools it called. The
// public share page shows only these, so no tool input, tool output or
// reasoning may reach them. Claude Code's formatter (and secret redaction of
// the words) is covered in transcript-display-parts.test.ts.

import { describe, expect, it, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { formatTranscriptForDisplay } from '../transcript.js';
import { parseCodexRolloutLive } from '../agents/codex.js';
import { parseDevinCliTranscript } from '../devin-cli.js';
import { parseDevinLiveMessages } from '../devin-sessions-db.js';
import { parseAntigravityTranscript } from '../antigravity-transcript.js';

const HIDDEN = ['TOOL-INPUT-MARK', 'TOOL-OUTPUT-MARK', 'REASONING-MARK'];

let tmp: string | null = null;
afterEach(() => { if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } tmp = null; } });

type Msg = { role: string; content: string; parts?: unknown[] };
const assistantParts = (msgs: Msg[]) => msgs.filter((m) => m.role === 'assistant').flatMap((m) => m.parts || []);
const expectNothingHidden = (parts: unknown) => {
  const shown = JSON.stringify(parts);
  for (const h of HIDDEN) expect(shown).not.toContain(h);
};

describe('share-safe parts per agent', () => {
  it('Codex: assistant words and tool names; no command, output or reasoning', () => {
    const at = '2026-10-14T10:00:00.000Z';
    const line = (payload: object) => JSON.stringify({ timestamp: at, type: 'response_item', payload });
    tmp = path.join(os.tmpdir(), `origin-dpa-codex-${process.pid}.jsonl`);
    fs.writeFileSync(tmp, [
      line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'bump the dep' }] }),
      line({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'REASONING-MARK' }] }),
      line({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking at the manifest.' }] }),
      line({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['echo', 'TOOL-INPUT-MARK'] }) }),
      line({ type: 'function_call_output', call_id: 'c1', output: 'TOOL-OUTPUT-MARK' }),
      line({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }),
    ].join('\n'));
    const r = parseCodexRolloutLive(tmp)!;
    const msgs: Msg[] = JSON.parse(r.transcript);
    const parts = assistantParts(msgs);
    expect(parts).toContainEqual({ text: 'Looking at the manifest.' });
    expect(parts).toContainEqual({ text: 'Done.' });
    expect(parts.some((p: any) => typeof p.tool === 'string')).toBe(true);
    expectNothingHidden(parts);
    // A user prompt carries no parts.
    expect(msgs.find((m) => m.role === 'user')?.parts).toBeUndefined();
  });

  it('Devin CLI: agent message text and tool names only', () => {
    const raw = JSON.stringify({
      agent: { model_name: 'SWE' },
      steps: [
        { step_id: '1', source: 'user', message: 'make a file', timestamp: '2026-10-14T10:00:00Z' },
        { step_id: '2', source: 'agent', message: 'Creating it.', timestamp: '2026-10-14T10:00:01Z',
          tool_calls: [{ tool_call_id: 'a', function_name: 'exec', arguments: { command: 'echo TOOL-INPUT-MARK' } }] },
      ],
      final_metrics: {},
    });
    const msgs: Msg[] = JSON.parse(parseDevinCliTranscript(raw)!.transcript!);
    const parts = assistantParts(msgs);
    expect(parts).toEqual([{ text: 'Creating it.' }, { tool: 'exec' }]);
    expectNothingHidden(parts);
  });

  it('Devin live DB: a tool row yields only its leading tool name', () => {
    const msg = (o: Record<string, unknown>) => JSON.stringify(o);
    const d = parseDevinLiveMessages([
      msg({ message_id: 'u1', role: 'user', content: 'look around' }),
      msg({ message_id: 't1', role: 'tool', content: 'Read ./TOOL-INPUT-MARK' }),
      msg({ message_id: 'a1', role: 'assistant', content: 'It is a small repo.' }),
    ]);
    const parts = assistantParts(JSON.parse(d.transcript!));
    expect(parts).toEqual([{ tool: 'Read' }, { text: 'It is a small repo.' }]);
    expectNothingHidden(parts);
  });

  it('Antigravity: planner prose and tool labels; no args, results or thinking', () => {
    const line = (o: object) => JSON.stringify(o);
    const t = parseAntigravityTranscript([
      line({ type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 1, created_at: '2026-10-14T10:00:00Z', content: 'run it' }),
      line({ type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 2, created_at: '2026-10-14T10:00:01Z',
        thinking: 'REASONING-MARK', content: 'Running the script.',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo TOOL-INPUT-MARK', Cwd: '/repo' } }] }),
      line({ type: 'RUN_COMMAND', source: 'MODEL', step_index: 3, created_at: '2026-10-14T10:00:02Z', content: 'TOOL-OUTPUT-MARK' }),
    ].join('\n'));
    expect(t.responseParts[0]).toEqual([{ tool: 'Bash' }, { text: 'Running the script.' }]);
    expectNothingHidden(t.responseParts);
  });

  it('Gemini (single JSON history): model text and function-call names; no args, responses or thoughts', () => {
    tmp = path.join(os.tmpdir(), `origin-dpa-gemini-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ history: [
      { role: 'user', parts: [{ text: 'list files' }] },
      { role: 'model', parts: [
        { thought: true, text: 'REASONING-MARK' },
        { text: 'Listing them.' },
        { functionCall: { name: 'run_shell_command', args: { command: 'echo TOOL-INPUT-MARK' } } },
      ] },
      { role: 'tool', parts: [{ functionResponse: { response: 'TOOL-OUTPUT-MARK' } }] },
    ] }, null, 2));
    const msgs: Msg[] = JSON.parse(formatTranscriptForDisplay(tmp));
    const parts = assistantParts(msgs);
    expect(parts).toEqual([{ text: 'Listing them.' }, { tool: 'run_shell_command' }]);
    expectNothingHidden(parts);
  });

  it('Gemini (chats JSONL): reply text and tool-call names; no args, responses or thoughts', () => {
    tmp = path.join(os.tmpdir(), `origin-dpa-gemchats-${process.pid}.jsonl`);
    fs.writeFileSync(tmp, [
      { type: 'user', content: [{ text: 'list files' }] },
      { type: 'gemini', content: 'Listing them.', thoughts: [{ subject: 'Plan', description: 'REASONING-MARK' }],
        toolCalls: [{ name: 'run_shell_command', args: { command: 'echo TOOL-INPUT-MARK' } }] },
      { type: 'tool', content: [{ functionResponse: { response: 'TOOL-OUTPUT-MARK' } }] },
    ].map((l) => JSON.stringify(l)).join('\n'));
    const msgs: Msg[] = JSON.parse(formatTranscriptForDisplay(tmp));
    const parts = assistantParts(msgs);
    expect(parts).toEqual([{ text: 'Listing them.' }, { tool: 'run_shell_command' }]);
    expectNothingHidden(parts);
  });
});
