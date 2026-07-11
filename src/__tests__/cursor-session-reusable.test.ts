// Regression for the resumed-Cursor session bug.
//
// Symptom: opening a NEW Cursor chat in a repo where a prior chat's session
// was still RUNNING glued the new chat's prompt onto the OLD session — and the
// prompt then displayed under the old session's (yesterday's) start time.
//
// Cause: handleSessionStart's Cursor/Codex reuse matched only on agent, not on
// the conversation_id (agentSessionId). handleUserPromptSubmit already detaches
// on a changed conversation_id; session-start did not. cursorSessionReusable
// centralizes the gate: reuse is blocked only on a PROVEN chat-id mismatch.
//
// Codex extension: the same bug hit the Codex UI app — each conversation gets
// its own rollout thread_id, but a NEW conversation reused the PREVIOUS one's
// still-RUNNING session because Codex was exempt from this gate. Now Codex is
// gated on its thread_id too (resolved BEFORE the reuse check via
// resolveCodexThreadId), so a distinct thread starts a fresh session.

import { describe, it, expect } from 'vitest';
import { cursorSessionReusable } from '../commands/hooks';

describe('cursorSessionReusable — when a Cursor/Codex session-start may reuse a session', () => {
  it('blocks reuse when the incoming chat id differs from the candidate', () => {
    expect(cursorSessionReusable('cursor', 'chat-today', 'chat-yesterday')).toBe(false);
  });

  it('allows reuse when the chat id matches (same conversation continuing)', () => {
    expect(cursorSessionReusable('cursor', 'chat-abc', 'chat-abc')).toBe(true);
  });

  it('adopts a candidate with no recorded chat id (best-effort, like user-prompt-submit)', () => {
    expect(cursorSessionReusable('cursor', 'chat-today', undefined)).toBe(true);
    expect(cursorSessionReusable('cursor', 'chat-today', null)).toBe(true);
  });

  it('allows reuse when there is no incoming chat id to compare', () => {
    expect(cursorSessionReusable('cursor', '', 'chat-yesterday')).toBe(true);
    expect(cursorSessionReusable('cursor', undefined, 'chat-yesterday')).toBe(true);
  });

  // Codex is now gated on its thread_id exactly like Cursor's conversation_id:
  // a NEW Codex conversation (different thread) must NOT reuse the previous
  // conversation's still-open session.
  it('blocks reuse when a new Codex thread differs from the candidate thread', () => {
    expect(cursorSessionReusable('codex', 'thread-new', 'thread-old')).toBe(false);
  });

  it('allows Codex reuse when the thread id matches (same conversation, next turn)', () => {
    expect(cursorSessionReusable('codex', 'thread-abc', 'thread-abc')).toBe(true);
  });

  it('adopts a Codex candidate with no recorded thread id (best-effort)', () => {
    expect(cursorSessionReusable('codex', 'thread-new', undefined)).toBe(true);
    expect(cursorSessionReusable('codex', '', 'thread-old')).toBe(true);
  });

  it('never blocks other agents that lack a per-chat anchor', () => {
    expect(cursorSessionReusable('claude-code', 'a', 'b')).toBe(true);
    expect(cursorSessionReusable(undefined, 'a', 'b')).toBe(true);
  });

  // Prod incident efe174db/603dbf4a: the Cursor stop-hook auto-create built a
  // session state but forgot to record agentSessionId. That empty id made this
  // guard ADOPT it (case above), so a NEW chat's session-start reused the
  // auto-created session and re-sent the prior chat's 6 prompts. The auto-create
  // now sets agentSessionId; with the id recorded, a DIFFERENT chat is blocked —
  // exactly the mismatch case. This pins the invariant the fix restores.
  it('blocks a sibling chat from adopting an auto-created session that records its id', () => {
    const autoCreatedChatId = '5588fbe2-5f8a-4092-b114-549b59628e2c'; // now recorded
    const newChatId = 'e2aebd47-1315-4594-9eac-5757b4b994e1';
    expect(cursorSessionReusable('cursor', newChatId, autoCreatedChatId)).toBe(false);
  });
});
