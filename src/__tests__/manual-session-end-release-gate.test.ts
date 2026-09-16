import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDetailed } from '../utils/exec.js';
import { saveSessionState, type SessionState } from '../session-state.js';
import { isManuallyEnded, skipManuallyEndedHook } from '../manual-session-end.js';

const bin = path.resolve(__dirname, '../../dist/index.js');
const sessionId = 'ab123456-0000-4000-8000-000000000001';
const conversationId = 'conversation-release-gate';
let repo: string;
let mirror: string;
let state: SessionState;

function cli(args: string[], input?: object) {
  return runDetailed(process.execPath, [bin, ...args], {
    cwd: repo, input: input && JSON.stringify(input), timeoutMs: 20_000,
  });
}
function gate() {
  return cli(['verify-capture', '--session', sessionId, '--json', '--all',
    '--fail-on-contradiction', '--fail-on-incomplete-evidence']);
}

beforeEach(() => {
  expect(fs.existsSync(bin), 'Build the CLI before exercising the release gate').toBe(true);
  const origin = path.join(os.homedir(), '.origin');
  fs.rmSync(origin, { recursive: true, force: true });
  fs.mkdirSync(origin, { recursive: true });
  fs.writeFileSync(path.join(origin, 'config.json'), JSON.stringify({ mode: 'standalone' }));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'manual-end-gate-')));
  expect(runDetailed('git', ['init', '-q', '-b', 'main'], { cwd: repo }).status).toBe(0);
  mirror = path.join(origin, 'sessions', `${sessionId.slice(0, 12)}.json`);
  state = {
    sessionId, sessionTag: 'release-test', claudeSessionId: conversationId,
    agentSessionId: conversationId, agentSlug: 'claude-code', model: 'claude-opus-5',
    repoPath: repo, startedAt: new Date().toISOString(), status: 'RUNNING',
    transcriptPath: '', headShaAtStart: '', headShaAtLastStop: '', prePromptSha: '', branch: 'main',
    prompts: ['release this'],
    completedPromptMappings: [{ promptIndex: 0, promptText: 'release this', filesChanged: [], diff: '',
      capturedAt: new Date().toISOString(), linesAdded: 0, linesRemoved: 0 }],
  };
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('an explicit end survives the hooks of the releasing turn', () => {
  it.each(['claude-code', 'codex', 'cursor'])('%s stays final until the next prompt', agent => {
    state.agentSlug = agent;
    if (agent !== 'claude-code') state.claudeSessionId = '';
    if (agent === 'codex') state.model = 'gpt-6-astra';
    saveSessionState(state, repo, state.sessionTag);
    expect(gate().status, 'the only evidence is still mutable').toBe(2);
    const ended = cli(['sessions', 'end', agent === 'claude-code' ? sessionId.slice(0, 8) : sessionId]);
    expect(ended.status, ended.stderr).toBe(0);
    expect(isManuallyEnded(sessionId)).toBe(true);
    const finalState = fs.readFileSync(mirror, 'utf8');
    expect(JSON.parse(finalState).status).toBe('ENDED');

    const payload = {
      cwd: repo, session_id: conversationId, conversation_id: conversationId,
      turn_id: 'current-turn', tool_name: 'Bash', tool_input: { command: 'echo release' },
    };
    for (const event of ['post-tool-use', 'pre-tool-use', 'stop', 'session-start']) {
      const hook = cli(['hooks', agent, event], payload);
      expect(hook.status, `${event}: ${hook.stderr}`).toBe(0);
      expect(fs.readFileSync(mirror, 'utf8'), event).toBe(finalState);
    }
    // A concurrent hook can have loaded state before `sessions end` ran.
    saveSessionState({ ...state, prompts: ['stale hook write'] }, repo, state.sessionTag);
    expect(fs.readFileSync(mirror, 'utf8')).toBe(finalState);
    const verified = gate();
    expect(verified.status, verified.stdout + verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).totals.evidenceComplete).toBe(true);

    // A sibling prompt cannot undo the explicit end.
    expect(skipManuallyEndedHook('user-prompt-submit', { session_id: 'sibling' }, agent)).toBe(false);
    expect(isManuallyEnded(sessionId)).toBe(true);
    const resumed = cli(['hooks', agent, 'user-prompt-submit'], { ...payload, turn_id: 'next-turn', prompt: 'continue working' });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(isManuallyEnded(sessionId)).toBe(false);
    expect(JSON.parse(fs.readFileSync(mirror, 'utf8')).status).toBe('RUNNING');
    expect(gate().status, 'new prompts are mutable again').toBe(2);
  });

  it('does not hide contradictions in the explicitly ended session', () => {
    state.completedPromptMappings![0].filesChanged = ['missing.ts'];
    saveSessionState(state, repo, state.sessionTag);
    expect(cli(['sessions', 'end', sessionId]).status).toBe(0);
    expect(gate().status).toBe(1);
  });

  it('does not turn an ended session without turn evidence into a passing sample', () => {
    state.completedPromptMappings = [];
    saveSessionState(state, repo, state.sessionTag);
    expect(cli(['sessions', 'end', sessionId]).status).toBe(0);
    expect(gate().status).toBe(2);
  });

  it('does not end a different full ID that merely shares the first eight characters', () => {
    saveSessionState(state, repo, state.sessionTag);
    expect(cli(['sessions', 'end', `${sessionId.slice(0, 8)}-different`]).status).toBe(0);
    expect(isManuallyEnded(sessionId)).toBe(false);
    expect(JSON.parse(fs.readFileSync(mirror, 'utf8')).status).toBe('RUNNING');
  });

  it('rejects an ambiguous prefix before ending either session', () => {
    saveSessionState(state, repo, state.sessionTag);
    const siblingId = `${sessionId.slice(0, 8)}-1111-4000-8000-000000000002`;
    saveSessionState({ ...state, sessionId: siblingId, sessionTag: 'sibling' }, repo, 'sibling');
    const result = cli(['sessions', 'end', sessionId.slice(0, 8)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ambiguous');
    expect(isManuallyEnded(sessionId)).toBe(false);
    expect(isManuallyEnded(siblingId)).toBe(false);
  });
});
