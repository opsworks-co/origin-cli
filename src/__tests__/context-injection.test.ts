// Pins the per-agent session-context delivery channel. Getting this wrong
// means the model silently never sees Origin's policies / repo context /
// authoring framework — which is exactly what happened to Claude Code,
// whose top-level `systemMessage` is shown to the human but never reaches
// the model (the model needs hookSpecificOutput.additionalContext).

import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildContextInjectionPayload, emitVisiblePreamble } from '../commands/hooks.js';

const MSG = 'Origin: session tracking active\n[Origin: Intent] ...';

describe('buildContextInjectionPayload', () => {
  it('claude-code gets BOTH systemMessage (human) and additionalContext (model)', () => {
    const out = JSON.parse(buildContextInjectionPayload('claude-code', 'SessionStart', MSG)!);
    expect(out.systemMessage).toBe(MSG);
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'SessionStart',
      additionalContext: MSG,
    });
  });

  it('claude-code uses the right hookEventName for UserPromptSubmit', () => {
    const out = JSON.parse(buildContextInjectionPayload('claude-code', 'UserPromptSubmit', MSG)!);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toBe(MSG);
  });

  it('cursor uses additional_context', () => {
    const out = JSON.parse(buildContextInjectionPayload('cursor', 'SessionStart', MSG)!);
    expect(out).toEqual({ additional_context: MSG });
  });

  it('gemini and devin use systemMessage', () => {
    expect(JSON.parse(buildContextInjectionPayload('gemini', 'SessionStart', MSG)!))
      .toEqual({ systemMessage: MSG });
    expect(JSON.parse(buildContextInjectionPayload('devin', 'SessionStart', MSG)!))
      .toEqual({ systemMessage: MSG });
  });

  it('codex returns null (it reads context from AGENTS.md, stdout would spam warnings)', () => {
    expect(buildContextInjectionPayload('codex', 'SessionStart', MSG)).toBeNull();
  });

  it('returns null for empty context regardless of agent', () => {
    expect(buildContextInjectionPayload('claude-code', 'SessionStart', '')).toBeNull();
    expect(buildContextInjectionPayload('gemini', 'SessionStart', '')).toBeNull();
  });

  it('an unknown agent falls back to systemMessage', () => {
    expect(JSON.parse(buildContextInjectionPayload('aider', 'SessionStart', MSG)!))
      .toEqual({ systemMessage: MSG });
  });
});

// Visibility parity: Gemini renders the stdout systemMessage as a banner, but
// Claude Code / Codex / Cursor only surface hook STDERR on the initial screen.
// emitVisiblePreamble mirrors the preamble to stderr for those, so the human
// actually sees the policies/context (the reported gap), not just the model.
describe('emitVisiblePreamble', () => {
  const FULL = [
    'AGENT SYSTEM PROMPT — model config, should not be in the banner',
    '',
    'Origin: Session tracking active — prompts, files, and tokens will be captured.',
    '',
    'Active policies for this session:',
    '- Block .pzdc File Extension: Restricted files: **/*.pzdc (Blocks session)',
  ].join('\n');

  let stderr: ReturnType<typeof vi.spyOn>;
  afterEach(() => stderr?.mockRestore());
  const capture = (agent: string | undefined, msg: string): string => {
    let out = '';
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { out += String(c); return true; });
    emitVisiblePreamble(agent, msg);
    return out;
  };

  it('writes the preamble to stderr for codex, cursor, claude-code, and unknown agents', () => {
    for (const agent of ['codex', 'cursor', 'claude-code', 'devin', 'aider']) {
      const out = capture(agent, FULL);
      expect(out, agent).toContain('Origin: Session tracking active');
      expect(out, agent).toContain('Block .pzdc File Extension');
    }
  });

  it('skips gemini — it already renders the stdout systemMessage as a banner', () => {
    expect(capture('gemini', FULL)).toBe('');
  });

  it('shows only from the tracking-notice anchor — not the raw agent system prompt', () => {
    const out = capture('codex', FULL);
    expect(out).not.toContain('AGENT SYSTEM PROMPT');
    expect(out.indexOf('Origin: Session tracking active')).toBeGreaterThanOrEqual(0);
  });

  it('writes nothing for an empty message', () => {
    expect(capture('codex', '')).toBe('');
  });
});
