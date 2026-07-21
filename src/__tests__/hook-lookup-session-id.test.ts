// Regression for the resumed-Gemini capture bug.
//
// Symptom: after resuming a Gemini session a day later, per-prompt diffs
// stopped being captured (completedPromptMappings froze, prePromptSha stuck
// at the pre-resume sha) while the prompt list kept growing.
//
// Cause: Gemini's stdin session_id changes when a conversation is resumed in
// a new launch. UserPromptSubmit gated that id behind STABLE_SESSION_ID_AGENTS
// (so it fell back to agent-filtered matching and found the live session), but
// Stop/SessionEnd/PreToolUse/PostToolUse/AfterFileEdit passed the raw id — so
// findStateForHook required an exact match, failed ("new session needed"), and
// the Stop hook ABORTed without writing the per-prompt mapping.
//
// hookLookupSessionId centralizes the gate: stable-id agents pass the id
// through (exact match), unstable/resumable agents pass undefined (fallback).

import { describe, expect, it } from 'vitest';
import { hookLookupSessionId } from '../commands/hooks.js';

describe('hookLookupSessionId', () => {
  it('passes the id through for stable-id agents (Claude Code, Devin)', () => {
    expect(hookLookupSessionId('sess-123', 'claude-code')).toBe('sess-123');
    expect(hookLookupSessionId('sess-123', 'devin')).toBe('sess-123');
  });

  it('returns undefined for Gemini so a resumed session resolves via agent-filtered fallback', () => {
    // The crux: Gemini's id changes on resume; passing it would force a
    // failing exact match. undefined → findStateForHook uses the fallback.
    expect(hookLookupSessionId('cc03c3a0-new-after-resume', 'gemini')).toBeUndefined();
  });

  it('returns undefined for other unstable-id agents (codex, cursor)', () => {
    expect(hookLookupSessionId('thread-per-turn', 'codex')).toBeUndefined();
    expect(hookLookupSessionId('whatever', 'cursor')).toBeUndefined();
  });

  it('returns undefined when the agent slug is missing', () => {
    expect(hookLookupSessionId('sess-123', undefined)).toBeUndefined();
    expect(hookLookupSessionId('sess-123', '')).toBeUndefined();
  });
});
