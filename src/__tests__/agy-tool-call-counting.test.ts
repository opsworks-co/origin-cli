// agy sessions rendered "0 tools" on the session detail even when the turn
// plainly ran several — live session 45d71da1 showed "0 files · 0 tools" for a
// turn that listed a directory, viewed two files, wrote a script and ran it.
//
// Cause: parseAntigravityTranscript never counted tool_calls, and the agy
// updateSession payload never carried toolCalls/toolBreakdown. Codex and Devin
// both set parsed.toolCalls explicitly; agy was simply never wired up. The
// calls were in the transcript the whole time.
import { describe, it, expect } from 'vitest';
import { parseAntigravityTranscript } from '../antigravity-transcript.js';

// Shape taken verbatim from a real transcript_full.jsonl (args trimmed).
function line(o: Record<string, unknown>): string { return JSON.stringify(o); }
const TRANSCRIPT = [
  line({ type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 0, created_at: '2026-08-26T15:23:14Z', content: "Check what's un here" }),
  line({ type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 2, created_at: '2026-08-26T15:23:19Z', content: '', tool_calls: [
    { name: 'list_dir', args: { DirectoryPath: '/repo' } },
  ] }),
  line({ type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 4, created_at: '2026-08-26T15:23:26Z', content: '', tool_calls: [
    { name: 'view_file', args: { AbsolutePath: '/repo/README.md' } },
    { name: 'view_file', args: { AbsolutePath: '/repo/four-rows.txt' } },
  ] }),
  line({ type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 8, created_at: '2026-08-26T15:24:23Z', content: 'generate some code in here - what ever you want' }),
  line({ type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 9, created_at: '2026-08-26T15:24:23Z', content: '', tool_calls: [
    { name: 'write_to_file', args: { TargetFile: '/repo/random_password.py', CodeContent: 'import random\n' } },
  ] }),
  line({ type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 11, created_at: '2026-08-26T15:24:31Z', content: '', tool_calls: [
    { name: 'run_command', args: { CommandLine: 'python3 random_password.py', Cwd: '/repo' } },
  ] }),
].join('\n');

describe('antigravity tool-call counting', () => {
  it('counts every tool call, including repeats within one step', () => {
    const parsed = parseAntigravityTranscript(TRANSCRIPT);
    // list_dir + view_file×2 + write_to_file + run_command
    expect(parsed.toolCalls).toBe(5);
  });

  it('breaks tools down by the normalized UI label', () => {
    const parsed = parseAntigravityTranscript(TRANSCRIPT);
    const byName = Object.fromEntries(parsed.toolBreakdown.map((t) => [t.name, t.count]));
    expect(byName).toEqual({ Read: 3, Write: 1, Bash: 1 });
    // Sorted by count desc so the UI's leading chips are the dominant tools.
    expect(parsed.toolBreakdown[0]).toEqual({ name: 'Read', count: 3 });
  });

  it('reports 0 for a chat-only transcript rather than inventing a count', () => {
    const chatOnly = [
      line({ type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 0, created_at: '2026-08-26T15:23:14Z', content: 'hi' }),
      line({ type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 1, created_at: '2026-08-26T15:23:15Z', content: 'hello' }),
    ].join('\n');
    const parsed = parseAntigravityTranscript(chatOnly);
    expect(parsed.toolCalls).toBe(0);
    expect(parsed.toolBreakdown).toEqual([]);
  });
});
