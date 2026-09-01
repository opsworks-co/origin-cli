// A handler that reads `input.tool_name` works for the agents it was written
// against and silently does nothing for the rest — indistinguishable from
// "this agent has no tool hooks". Normalising at the edge is what lets a new
// agent need a wired hook and nothing else.
import { describe, it, expect } from 'vitest';
import { normalizeToolHookPayload } from '../hook-payload.js';

describe('normalizeToolHookPayload', () => {
  it('passes the canonical (Claude Code) shape through untouched', () => {
    const inp = { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1', cwd: '/r' };
    expect(normalizeToolHookPayload(inp)).toEqual(inp);
  });

  it('maps camelCase names', () => {
    const out = normalizeToolHookPayload({ toolName: 'Bash', toolInput: { command: 'ls' }, sessionId: 's1' });
    expect(out.tool_name).toBe('Bash');
    expect(out.tool_input).toEqual({ command: 'ls' });
    expect(out.session_id).toBe('s1');
  });

  it('unwraps Antigravity\'s nested toolCall', () => {
    const out = normalizeToolHookPayload({
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
      conversationId: 'c1', workspacePaths: ['/repo'],
    });
    expect(out.tool_name).toBe('run_command');
    expect(out.tool_input).toEqual({ CommandLine: 'npm test' });
    expect(out.session_id).toBe('c1');
    expect(out.cwd).toBe('/repo');
  });

  it('never OVERWRITES a field the agent already set', () => {
    const out = normalizeToolHookPayload({
      tool_name: 'Real', toolName: 'Other',
      session_id: 'real', sessionId: 'other',
    });
    expect(out.tool_name).toBe('Real');
    expect(out.session_id).toBe('real');
  });

  it('ignores empty and wrong-typed values rather than filling junk', () => {
    const out = normalizeToolHookPayload({ toolName: '', toolInput: 'not-an-object', sessionId: null });
    expect(out.tool_name).toBeUndefined();
    expect(out.tool_input).toBeUndefined();
    expect(out.session_id).toBeUndefined();
  });

  it('survives a malformed payload', () => {
    expect(normalizeToolHookPayload(null as any)).toBeNull();
    expect(normalizeToolHookPayload({})).toEqual({});
  });
});
