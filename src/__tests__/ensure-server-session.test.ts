// ensureServerSession self-heals a session that started in local-only mode
// (the start API call couldn't reach the server → `local-` id, invisible in
// Origin). It re-registers on the server and persists the real id. These
// tests pin the guards (so it stays a cheap no-op) and the success path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep the real modules but override the few seams ensureServerSession touches.
vi.mock('../config.js', async (orig) => ({
  ...(await orig() as object),
  isConnectedMode: vi.fn(() => true),
  loadAgentConfig: vi.fn(() => ({ machineId: 'machine-1' })),
}));
vi.mock('../session-state.js', async (orig) => ({
  ...(await orig() as object),
  saveSessionState: vi.fn(),
}));
vi.mock('../api.js', async (orig) => ({
  ...(await orig() as object),
  api: { startSession: vi.fn() },
}));

import { ensureServerSession, isSessionGoneError } from '../commands/hooks.js';
import * as config from '../config.js';
import { api } from '../api.js';
import type { SessionState } from '../session-state.js';

const startSession = api.startSession as ReturnType<typeof vi.fn>;
const isConnectedMode = config.isConnectedMode as ReturnType<typeof vi.fn>;
const loadAgentConfig = config.loadAgentConfig as ReturnType<typeof vi.fn>;

function localState(over: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'local-abc',
    claudeSessionId: 'claude-1',
    transcriptPath: '', model: 'claude-fable-5', startedAt: '', prompts: ['hi'],
    repoPath: '/repo', headShaAtStart: null, headShaAtLastStop: null,
    prePromptSha: null, branch: 'main',
    ...over,
  } as SessionState;
}

beforeEach(() => {
  startSession.mockReset();
  isConnectedMode.mockReturnValue(true);
  loadAgentConfig.mockReturnValue({ machineId: 'machine-1' });
});

describe('ensureServerSession', () => {
  it('migrates a local session and persists the real server id', async () => {
    startSession.mockResolvedValue({ sessionId: 'srv-real-123' });
    const state = localState();
    const ok = await ensureServerSession(state, '/repo', 'claude-code', 'test');
    expect(ok).toBe(true);
    expect(state.sessionId).toBe('srv-real-123');
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('no-ops (no API call) for a session that already has a server id', async () => {
    const state = localState({ sessionId: 'srv-existing' });
    const ok = await ensureServerSession(state, '/repo', 'claude-code', 'test');
    expect(ok).toBe(false);
    expect(startSession).not.toHaveBeenCalled();
    expect(state.sessionId).toBe('srv-existing');
  });

  it('no-ops when disconnected', async () => {
    isConnectedMode.mockReturnValue(false);
    const ok = await ensureServerSession(localState(), '/repo', 'claude-code', 'test');
    expect(ok).toBe(false);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('no-ops when no machineId is configured', async () => {
    loadAgentConfig.mockReturnValue({} as any);
    const ok = await ensureServerSession(localState(), '/repo', 'claude-code', 'test');
    expect(ok).toBe(false);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('stays local (returns false) when the server still returns a local id', async () => {
    startSession.mockResolvedValue({ sessionId: 'local-still' });
    const state = localState();
    const ok = await ensureServerSession(state, '/repo', 'claude-code', 'test');
    expect(ok).toBe(false);
    expect(state.sessionId).toBe('local-abc'); // unchanged — retried next hook
  });

  it('swallows API errors and stays local (best-effort)', async () => {
    startSession.mockRejectedValue(new Error('network down'));
    const state = localState();
    const ok = await ensureServerSession(state, '/repo', 'claude-code', 'test');
    expect(ok).toBe(false);
    expect(state.sessionId).toBe('local-abc');
  });

  // ── remintGone ────────────────────────────────────────────────────────────
  // A session can be HARD-DELETED server-side while the agent is still running:
  // /session/end's empty-session cleanup drops any row with no prompts/tokens,
  // which is exactly a session whose turn is captured locally but whose first
  // PATCH hasn't landed. Every later write then 404s "Session not found" and a
  // fully-captured turn used to be thrown away (prod: a Cursor turn on `vodka`
  // whose row died 420ms after session/start). remintGone lifts the `local-`
  // gate so the caller can re-register and resend to a fresh row.
  it('re-mints a REAL server id the server no longer has', async () => {
    startSession.mockResolvedValue({ sessionId: 'srv-fresh-456' });
    const state = localState({ sessionId: 'srv-deleted-123' });

    const ok = await ensureServerSession(state, '/repo', 'cursor', 'stop', { remintGone: true });

    expect(ok).toBe(true);
    expect(state.sessionId).toBe('srv-fresh-456');
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('still no-ops on a real server id WITHOUT remintGone (the default stays cheap)', async () => {
    const state = localState({ sessionId: 'srv-existing' });
    const ok = await ensureServerSession(state, '/repo', 'cursor', 'stop', {});
    expect(ok).toBe(false);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('remintGone still respects the disconnected guard', async () => {
    isConnectedMode.mockReturnValue(false);
    const state = localState({ sessionId: 'srv-deleted-123' });
    const ok = await ensureServerSession(state, '/repo', 'cursor', 'stop', { remintGone: true });
    expect(ok).toBe(false);
    expect(startSession).not.toHaveBeenCalled();
    expect(state.sessionId).toBe('srv-deleted-123');
  });

  it('remintGone leaves the id untouched when the re-mint itself fails', async () => {
    startSession.mockRejectedValue(new Error('still down'));
    const state = localState({ sessionId: 'srv-deleted-123' });
    const ok = await ensureServerSession(state, '/repo', 'cursor', 'stop', { remintGone: true });
    expect(ok).toBe(false);
    expect(state.sessionId).toBe('srv-deleted-123');
  });
});

describe('isSessionGoneError', () => {
  // The API answers a missing row on PATCH /session/:id with this exact string
  // (routes/mcp.ts scopeCheck). It is deliberately NOT the router's generic
  // "Not found" — matching that would treat any unrouted 404 as a dead session.
  it('recognises the API\'s missing-session error', () => {
    expect(isSessionGoneError(new Error('Session not found'))).toBe(true);
    expect(isSessionGoneError('Session not found')).toBe(true);
  });

  it('does NOT match the router\'s generic 404 or unrelated failures', () => {
    expect(isSessionGoneError(new Error('Not found'))).toBe(false);
    expect(isSessionGoneError(new Error('network down'))).toBe(false);
    expect(isSessionGoneError(new Error('Unauthorized'))).toBe(false);
    expect(isSessionGoneError(new Error('PromptChange row not found; upload after the prompt PATCH lands'))).toBe(false);
    expect(isSessionGoneError(undefined)).toBe(false);
    expect(isSessionGoneError(null)).toBe(false);
  });
});
