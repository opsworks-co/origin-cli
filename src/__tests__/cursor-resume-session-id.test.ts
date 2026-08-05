// Resuming an ENDED Cursor chat used to fork a twin session that re-copied all
// prior prompts: the hook's auto-create path advertised a null agentSessionId
// (Cursor isn't a STABLE_SESSION_ID_AGENT), so the server's "resume a COMPLETED
// session via agentSessionId" rung couldn't fire and it minted a new session
// (prod 3a5328e9 duplicated e6f72dcc's 4 prompts). resolveAutoAgentSessionId now
// supplies Cursor's STABLE conversation_id (falling back to session_id), matching
// what session-start already anchors on so the resume reuses the existing session.

import { describe, it, expect } from 'vitest';
import { resolveAutoAgentSessionId } from '../commands/hooks.js';

describe('resolveAutoAgentSessionId', () => {
  it('cursor: prefers the stable conversation_id over the rotating session_id', () => {
    expect(resolveAutoAgentSessionId('cursor', 'conv-abc', 'turn-999')).toBe('conv-abc');
  });

  it('cursor: falls back to session_id when conversation_id is absent', () => {
    expect(resolveAutoAgentSessionId('cursor', undefined, 'turn-999')).toBe('turn-999');
    expect(resolveAutoAgentSessionId('cursor', '', 'turn-999')).toBe('turn-999');
  });

  it('cursor: never returns a non-string / empty anchor (was the null-forking bug)', () => {
    expect(resolveAutoAgentSessionId('cursor', undefined, undefined)).toBeUndefined();
    expect(resolveAutoAgentSessionId('cursor', null, '')).toBeUndefined();
    expect(resolveAutoAgentSessionId('cursor', 123 as any, {} as any)).toBeUndefined();
  });

  it('stable-id agents advertise their session_id', () => {
    expect(resolveAutoAgentSessionId('claude-code', undefined, 'sess-1')).toBe('sess-1');
    expect(resolveAutoAgentSessionId('devin', undefined, 'sess-2')).toBe('sess-2');
    expect(resolveAutoAgentSessionId('copilot', undefined, 'sess-3')).toBe('sess-3');
  });

  it('codex + unknown agents advertise no anchor here (codex resolves its thread id separately)', () => {
    expect(resolveAutoAgentSessionId('codex', 'x', 'y')).toBeUndefined();
    expect(resolveAutoAgentSessionId('gemini', 'x', 'y')).toBeUndefined();
    expect(resolveAutoAgentSessionId(undefined, 'x', 'y')).toBeUndefined();
  });
});
