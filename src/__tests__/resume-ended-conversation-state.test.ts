// The heartbeat retires a hook-driven session after 90 silent minutes, and a
// conversation can be that quiet while still open — this session (1b7b5ffe,
// 2026-09-09) waited ten hours for the user to answer a question. Claude Code
// fires no UserPromptSubmit for an answer, only tool hooks; every one found
// the state ENDED and aborted ("no exact match for stable claudeSessionId —
// new session needed"). The commit made next had no live session, so the
// server injected it by time window with no turn; the prompt hook that
// followed auto-created a SECOND state file and left the turn history behind.
//
// A stable per-conversation id names the ended row positively. Bring it back.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-resume-ended-${process.pid}` };
});
vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});
vi.mock('../config.js', async (orig) => ({
  ...(await orig() as object),
  isConnectedMode: vi.fn(() => false),
}));

import { findStateForHook, resumeEndedConversationState } from '../commands/hooks.js';
import { hooksSource } from './helpers/hooks-source.js';

const CONV = '3939c84e-80da-409e-b4bb-8fc3a4d1481c';
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
let repo = '';
const stateFile = (tag: string) => path.join(repo, '.git', `origin-session-${tag}.json`);

function endedState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: '1b7b5ffe-b8bf-428d-98ca-b3571f6c3558', sessionTag: '434b2883-f38', claudeSessionId: CONV,
    agentSlug: 'claude-code', model: 'claude-fable-5-1', repoPath: repo, canonicalRepoPath: repo, lastCwd: repo, branch: 'main',
    startedAt: new Date(Date.now() - 12 * 60 * 60_000).toISOString(), prompts: ['again cursor started 2 sessions'],
    activeTurn: { index: 0, turnId: 't_cdd1fb6ac05d420a' }, promptTurnIds: ['t_cdd1fb6ac05d420a'],
    status: 'ENDED', endedAt: new Date(Date.now() - 9 * 60 * 60_000).toISOString(), ...over,
  };
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_HOME, '.origin'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_HOME, '.origin', 'sessions'), { recursive: true });
  repo = fs.mkdtempSync(path.join(TEST_HOME, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env: ENV });
  repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, env: ENV, encoding: 'utf-8' }).trim();
});
afterAll(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); });

describe('resumeEndedConversationState', () => {
  it('reopens the ended row that carries this conversation id, with its turn history intact', () => {
    fs.writeFileSync(stateFile('434b2883-f38'), JSON.stringify(endedState()));
    expect(findStateForHook(repo, CONV, 'claude-code'), 'the lookup itself still sees nothing live').toBeNull();

    const r = resumeEndedConversationState(repo, CONV, 'claude-code', 'pre-tool-use');
    expect(r?.state.sessionId).toBe('1b7b5ffe-b8bf-428d-98ca-b3571f6c3558');
    expect(r?.state.status).toBe('RUNNING');
    expect((r?.state as { endedAt?: string }).endedAt).toBeUndefined();
    expect((r?.state as { activeTurn?: { turnId?: string } }).activeTurn?.turnId).toBe('t_cdd1fb6ac05d420a');
    // Persisted in place — the SAME tag file, not a second one.
    const onDisk = JSON.parse(fs.readFileSync(stateFile('434b2883-f38'), 'utf-8'));
    expect(onDisk.status).toBe('RUNNING');
    expect(onDisk.endedAt).toBeUndefined();
    expect(onDisk.prompts).toEqual(['again cursor started 2 sessions']);
    // And the next lookup finds it live again.
    expect(findStateForHook(repo, CONV, 'claude-code')?.state.sessionId).toBe('1b7b5ffe-b8bf-428d-98ca-b3571f6c3558');
  });

  it('never resumes another conversation, another agent, or a row the web archived', () => {
    fs.writeFileSync(stateFile('other'), JSON.stringify(endedState({ claudeSessionId: 'some-other-conversation' })));
    expect(resumeEndedConversationState(repo, CONV, 'claude-code', 'test')).toBeNull();
    fs.writeFileSync(stateFile('434b2883-f38'), JSON.stringify(endedState({ agentSlug: 'gemini' })));
    expect(resumeEndedConversationState(repo, CONV, 'claude-code', 'test')).toBeNull();
    fs.writeFileSync(stateFile('434b2883-f38'), JSON.stringify(endedState({ serverTerminal: true })));
    expect(resumeEndedConversationState(repo, CONV, 'claude-code', 'test')).toBeNull();
    expect(JSON.parse(fs.readFileSync(stateFile('434b2883-f38'), 'utf-8')).status, 'untouched').toBe('ENDED');
  });

  it('a live row is not its business, and a Cursor row (empty claudeSessionId) never matches', () => {
    fs.writeFileSync(stateFile('434b2883-f38'), JSON.stringify(endedState({ status: 'RUNNING', endedAt: undefined })));
    expect(resumeEndedConversationState(repo, CONV, 'claude-code', 'test')).toBeNull();
    fs.writeFileSync(stateFile('f9213cfd-349'), JSON.stringify(endedState({ claudeSessionId: '', agentSessionId: CONV, agentSlug: 'cursor' })));
    expect(resumeEndedConversationState(repo, CONV, 'cursor', 'test')).toBeNull();
    expect(resumeEndedConversationState(repo, '', 'claude-code', 'test')).toBeNull();
  });

  it('falls back to the durable mirror when the repo file is gone', () => {
    fs.writeFileSync(path.join(TEST_HOME, '.origin', 'sessions', '1b7b5ffe-b8b.json'), JSON.stringify(endedState()));
    const r = resumeEndedConversationState(repo, CONV, 'claude-code', 'test');
    expect(r?.state.sessionId).toBe('1b7b5ffe-b8bf-428d-98ca-b3571f6c3558');
    expect(fs.existsSync(stateFile('434b2883-f38')), 'restored into the repo under its own tag').toBe(true);
  });
});

describe('the resume is wired where the abort was', () => {
  const src = hooksSource();
  it('both tool hooks and the prompt hook try it before giving up, for stable-id agents only', () => {
    for (const scope of ['pre-tool-use', 'post-tool-use']) {
      const abort = src.indexOf(`debugLog('${scope}', 'ABORT: no session state')`);
      const resume = src.lastIndexOf(`resumeEndedConversationState(hookCwd, typeof input.session_id === 'string' ? input.session_id : undefined, agentSlug, '${scope}')`, abort);
      expect(resume, scope).toBeGreaterThan(-1);
      expect(src.slice(resume - 200, resume)).toContain('STABLE_SESSION_ID_AGENTS.includes(agentSlug');
    }
    const ups = src.indexOf("resumeEndedConversationState(hookCwd, input.session_id, agentSlug, 'user-prompt-submit')");
    const autoCreate = src.indexOf("'no session state — attempting auto-create'");
    expect(ups).toBeGreaterThan(-1);
    expect(ups).toBeLessThan(autoCreate);
  });
});
