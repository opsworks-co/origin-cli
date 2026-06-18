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

import { ensureServerSession } from '../commands/hooks.js';
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
});
