// Copilot CLI ≥1.0.81 runs a `task` sub-agent inside the parent's session: its
// events land in the parent's events.jsonl stamped with a top-level `agentId`,
// and its hooks are re-emitted through the parent's with the sub-agent's id as
// `sessionId`. Shapes below are from a real Copilot 1.0.96 run (2026-10-15,
// one prompt that launched a background sub-agent), trimmed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseTranscript } from '../transcript.js';
import { isCopilotSubagentHook } from '../copilot-subagent-hook.js';

const PARENT = '07116877-4cc6-4775-a15f-f960df05116c';
const SUB = '07b1f61a-5d45-495e-bcb6-8ced1074f184';
const CALL = 'toolu_01GAJSBHto3kus1qhvWR9BSd';

let stateDir = '';
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-copilot-subagent-')); });
afterEach(() => { fs.rmSync(stateDir, { recursive: true, force: true }); });

function writeParentLog(): string {
  const ev = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ type, data, id: `${type}-${Math.random()}`, timestamp: '2026-10-15T14:10:00.000Z', ...extra });
  const events = [
    ev('session.start', { sessionId: PARENT }),
    ev('user.message', { content: 'Launch a background sub-agent that creates probe/sub.txt, and create probe/main.txt yourself', parentAgentTaskId: 'dfe71e2d', turnId: '0' }),
    ev('assistant.message', { messageId: 'm1', model: 'claude-haiku-4.5', content: '', toolRequests: [
      { toolCallId: CALL, name: 'task', arguments: { mode: 'background', prompt: 'Create the file probe/sub.txt' } },
      { toolCallId: 'b1', name: 'bash', arguments: { command: 'echo "from main" > probe/main.txt' } },
    ] }),
    ev('subagent.started', { toolCallId: CALL, agentName: 'task', executionMode: 'background' }, { agentId: SUB }),
    ev('user.message', { content: "Create the file probe/sub.txt containing exactly one line: 'from subagent'.", source: `agent-${PARENT}`, parentAgentTaskId: 'a1725120' }, { agentId: SUB }),
    ev('assistant.message', { messageId: 'm2', model: 'gpt-5.6-luna', content: '', parentToolCallId: CALL, toolRequests: [
      { toolCallId: 'b2', name: 'bash', arguments: { command: 'echo "from subagent" > probe/sub.txt' } },
    ] }, { agentId: SUB }),
    ev('assistant.message', { messageId: 'm3', model: 'gpt-5.6-luna', content: 'Created probe/sub.txt.', parentToolCallId: CALL }, { agentId: SUB }),
    ev('subagent.completed', { toolCallId: CALL, agentName: 'task' }, { agentId: SUB }),
    ev('assistant.message', { messageId: 'm4', model: 'claude-haiku-4.5', content: 'DONE' }),
  ];
  const dir = path.join(stateDir, PARENT);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

describe('Copilot sub-agent in the parent transcript', () => {
  it("the sub-agent's dispatch prompt is not one of the user's prompts", () => {
    const p = parseTranscript(writeParentLog());
    expect(p.prompts).toEqual([
      'Launch a background sub-agent that creates probe/sub.txt, and create probe/main.txt yourself',
    ]);
  });

  it("the sub-agent's tool calls still count as the session's work", () => {
    // task + bash from the parent, bash from the sub-agent.
    expect(parseTranscript(writeParentLog()).toolCalls).toBe(3);
  });
});

describe('Copilot /fork', () => {
  // The fork's events.jsonl: its own session.start, a copy of the parent's
  // history (parent timestamps), the fork marker, then its own work.
  const forkLog = () => {
    const lines = [
      { type: 'session.start', timestamp: '2026-10-15T14:29:23.357Z', data: { sessionId: 'fork', startTime: '2026-10-15T14:29:23.357Z' } },
      { type: 'user.message', timestamp: '2026-10-15T14:29:15.000Z', data: { content: 'Run sleep 25, then create probe/fork1.txt' } },
      { type: 'session.usage_record', timestamp: '2026-10-15T14:29:16.000Z', data: { usage: { inputTokens: 9_000, outputTokens: 20 } } },
      { type: 'session.info', timestamp: '2026-10-15T14:29:23.362Z', data: { infoType: 'fork', message: 'Forked from "Run" (parent) as "Run (fork)" (fork).' } },
      { type: 'session.resume', timestamp: '2026-10-15T14:29:23.573Z', data: { eventCount: 11 } },
      { type: 'user.message', timestamp: '2026-10-15T14:30:23.000Z', data: { content: 'Create probe/fork2.txt' } },
      { type: 'assistant.message', timestamp: '2026-10-15T14:31:06.000Z', data: { messageId: 'f1', model: 'claude-haiku-4.5', content: 'OK' } },
      { type: 'session.usage_record', timestamp: '2026-10-15T14:31:06.000Z', data: { usage: { inputTokens: 1_000, outputTokens: 30 } } },
    ];
    const file = path.join(stateDir, 'fork-events.jsonl');
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  };

  it("the parent's copied history is not the fork's: one prompt, its own tokens", () => {
    const p = parseTranscript(forkLog());
    expect(p.prompts).toEqual(['Create probe/fork2.txt']);
    expect({ i: p.inputTokens, o: p.outputTokens }).toEqual({ i: 1_000, o: 30 });
  });

  it('a session with no copied history keeps everything', () => {
    const p = parseTranscript(writeParentLog());
    expect(p.prompts).toHaveLength(1);
  });
});

describe('isCopilotSubagentHook', () => {
  it("drops the sub-agent's agentStop: its transcript is the parent's", () => {
    const transcriptPath = writeParentLog();
    expect(isCopilotSubagentHook({ sessionId: SUB, transcriptPath, stopReason: 'end_turn' }, stateDir)).toBe(true);
    expect(isCopilotSubagentHook({ session_id: PARENT, transcript_path: transcriptPath }, stateDir)).toBe(false);
  });

  it("drops the sub-agent's userPromptSubmitted: no state dir of its own, started in the parent's log", () => {
    writeParentLog();
    expect(isCopilotSubagentHook({ sessionId: SUB, prompt: 'Create the file probe/sub.txt' }, stateDir)).toBe(true);
  });

  it("keeps the user's own prompt", () => {
    writeParentLog();
    expect(isCopilotSubagentHook({ sessionId: PARENT, prompt: 'Launch a background sub-agent' }, stateDir)).toBe(false);
  });

  it('keeps a hook it cannot place: no state dir and no parent log naming it', () => {
    expect(isCopilotSubagentHook({ sessionId: 'fresh-session', prompt: 'hello' }, stateDir)).toBe(false);
    expect(isCopilotSubagentHook({ sessionId: 'fresh-session', prompt: 'hello' }, path.join(stateDir, 'missing'))).toBe(false);
    expect(isCopilotSubagentHook({ prompt: 'no id' }, stateDir)).toBe(false);
  });

  it('ignores a transcript that is not a Copilot events log', () => {
    expect(isCopilotSubagentHook({ sessionId: SUB, transcriptPath: '/tmp/other/transcript.jsonl' }, stateDir)).toBe(false);
  });
});
