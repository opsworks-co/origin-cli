/**
 * The user-prompt-submit race re-lookup must not adopt a SIBLING chat's session.
 *
 * #1358 gave Cursor a new-chat-id guard: when workspace-scoped findStateForHook
 * hands back a state whose `agentSessionId` is a different chat, detach and let
 * the auto-create branch mint a fresh session. That guard runs on the FIRST
 * lookup only. After it fires, the handler syncs notes and looks again — and
 * that second lookup had no guard at all, so it re-adopted the very state the
 * first one had just rejected.
 *
 * Prod, Cursor on `baton`, 2026-08-30 (hooks.log, chat b1bcba95 opened while
 * chat ceb22e9b's state was still on disk):
 *
 *   16:13:12.007  cursor: new chat id — detaching from prior state
 *                   {"locked":"ceb22e9b-…","incoming":"b1bcba95-…"}
 *   16:13:12.078  no session state — attempting auto-create
 *   16:13:12.945  session-start won the race — adopting its session
 *                   {"sessionId":"local-9adc70…","tag":"smtfv1cat"}
 *   16:13:13.253  [session-start] reserved state … tag b1bcba95-2fe
 *
 * session-start did not publish its reservation until `.253`, so at `.945` the
 * only state in the workspace was still the previous chat's. The prompt, and
 * the turn's whole 236-line diff, were filed onto session 8394d72b — the OLD
 * chat — which ended up with `"generate some code ieen here\n---\ngenerate some
 * code in ehre please"` as its prompt and two chats claiming one turn.
 *
 * The rule is shared with the first guard rather than duplicated, so the two
 * cannot drift apart again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stateMatchesIncomingChat } from '../commands/hooks';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_SRC = path.join(here, '..', 'commands', 'hooks.ts');

// Minimal shape — the predicate reads two fields and must not touch others.
const stateFor = (over: Record<string, any> = {}): any => ({
  sessionId: 'local-9adc70bd-a384-48ce-9517-e8734c9030f9',
  sessionTag: 'smtfv1cat',
  agentSessionId: 'ceb22e9b-2218-474c-be65-ecf73edda086',
  transcriptPath: '',
  ...over,
});

describe('stateMatchesIncomingChat', () => {
  it('rejects a prior Cursor chat when conversation_id disagrees', () => {
    const matches = stateMatchesIncomingChat(stateFor(), 'cursor', {
      conversation_id: 'b1bcba95-2fe1-4594-b514-3a666ac13e87',
    });
    expect(matches).toBe(false);
  });

  it('accepts the chat that owns the state', () => {
    const matches = stateMatchesIncomingChat(stateFor(), 'cursor', {
      conversation_id: 'ceb22e9b-2218-474c-be65-ecf73edda086',
    });
    expect(matches).toBe(true);
  });

  it('falls back to session_id when Cursor sends no conversation_id', () => {
    expect(
      stateMatchesIncomingChat(stateFor(), 'cursor', { session_id: 'b1bcba95-2fe1' }),
    ).toBe(false);
    expect(
      stateMatchesIncomingChat(stateFor(), 'cursor', {
        session_id: 'ceb22e9b-2218-474c-be65-ecf73edda086',
      }),
    ).toBe(true);
  });

  it('adopts when there is nothing to compare', () => {
    // Mirrors the first guard, which adopts (and locks) rather than detaching
    // when either side is blank. Detaching here would strand every prompt whose
    // stdin omitted the id.
    expect(stateMatchesIncomingChat(stateFor(), 'cursor', {})).toBe(true);
    expect(
      stateMatchesIncomingChat(stateFor({ agentSessionId: '' }), 'cursor', {
        conversation_id: 'b1bcba95-2fe1',
      }),
    ).toBe(true);
  });

  it('detaches Gemini on a different transcript_path', () => {
    const state = stateFor({ transcriptPath: '/g/chats/session-aaa.json' });
    expect(
      stateMatchesIncomingChat(state, 'gemini', { transcript_path: '/g/chats/session-bbb.json' }),
    ).toBe(false);
    expect(
      stateMatchesIncomingChat(state, 'gemini', { transcript_path: '/g/chats/session-aaa.json' }),
    ).toBe(true);
  });

  it('never detaches Codex — its stdin id rotates every turn', () => {
    // A Codex turn legitimately arrives with an id that differs from the one
    // locked in state. Applying the Cursor rule here would detach every prompt
    // from its own session and mint a new row per turn.
    const state = stateFor({ agentSessionId: 'turn-1' });
    expect(stateMatchesIncomingChat(state, 'codex', { session_id: 'turn-2' })).toBe(true);
    expect(stateMatchesIncomingChat(state, 'claude-code', { session_id: 'turn-2' })).toBe(true);
    expect(stateMatchesIncomingChat(state, undefined, { session_id: 'turn-2' })).toBe(true);
  });
});

describe('the race re-lookup is guarded', () => {
  const src = fs.readFileSync(HOOKS_SRC, 'utf8');

  it('checks chat identity before adopting the raced state', () => {
    // Wiring guard: the predicate above can be perfect and still never run.
    // #1358 was itself a correct fix on a path this one bypassed.
    const adopt = src.indexOf(
      "'session-start won the race — adopting its session instead of auto-creating'",
    );
    const check = src.lastIndexOf('stateMatchesIncomingChat(racedCandidate.state', adopt);
    expect(adopt).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(adopt);
  });
});
