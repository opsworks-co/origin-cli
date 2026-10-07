import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDetailed } from '../utils/exec.js';
import { saveSessionState, type SessionState } from '../session-state.js';
import { isManuallyEnded } from '../manual-session-end.js';

/**
 * `origin sessions end <own id>` from INSIDE a turn — the release recipe ends
 * the releasing session mid-turn. The Stop that follows is a continuation and
 * is skipped, so the open turn's row never left the machine until the next
 * prompt's Stop: session c085f0af turn 5 ("merge and release it yourself",
 * ended 2026-09-25 23:20 UTC) reached the server at 05:07 the next day, and
 * the page numbered its turns 1, 2, 3, 4, 6 meanwhile. The end command now
 * closes the open turn the way its Stop would have, before the barrier goes up.
 */
const bin = path.resolve(__dirname, '../../dist/index.js');
const sessionId = 'ab123456-0000-4000-8000-00000000000e';
const conversationId = 'conversation-end-mid-turn';
let repo: string;
let mirror: string;
let transcript: string;

function cli(args: string[]) {
  return runDetailed(process.execPath, [bin, ...args], { cwd: repo, timeoutMs: 30_000 });
}

beforeEach(() => {
  expect(fs.existsSync(bin), 'Build the CLI before exercising the end command').toBe(true);
  const origin = path.join(os.homedir(), '.origin');
  fs.rmSync(origin, { recursive: true, force: true });
  fs.mkdirSync(origin, { recursive: true });
  fs.writeFileSync(path.join(origin, 'config.json'), JSON.stringify({ mode: 'standalone' }));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'manual-end-open-turn-')));
  expect(runDetailed('git', ['init', '-q', '-b', 'main'], { cwd: repo }).status).toBe(0);
  runDetailed('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
  runDetailed('git', ['config', 'user.name', 'T'], { cwd: repo });
  runDetailed('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'f.txt'), 'base\n');
  runDetailed('git', ['add', '-A'], { cwd: repo });
  expect(runDetailed('git', ['commit', '-qm', 'base'], { cwd: repo }).status).toBe(0);
  const head = runDetailed('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
  mirror = path.join(origin, 'sessions', `${sessionId.slice(0, 12)}.json`);
  transcript = path.join(repo, 'transcript.jsonl');
  const now = new Date().toISOString();
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'merge and release it yourself' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'Merged and released.' }] } }),
  ].join('\n') + '\n');
  const state: SessionState = {
    sessionId, sessionTag: 'end-mid-turn', claudeSessionId: conversationId,
    agentSessionId: conversationId, agentSlug: 'claude-code', model: 'claude-opus-5',
    repoPath: repo, lastCwd: repo, startedAt: new Date(Date.now() - 120_000).toISOString(), status: 'RUNNING',
    transcriptPath: transcript, headShaAtStart: head, headShaAtLastStop: head, prePromptSha: head, branch: 'main',
    prompts: ['merge and release it yourself'],
    promptTurnIds: ['t_open_turn'],
    promptSubmittedAt: [new Date(Date.now() - 60_000).toISOString()],
    activeTurn: { index: 0, turnId: 't_open_turn', promptText: 'merge and release it yourself', openedAt: new Date(Date.now() - 50_000).toISOString() },
    completedPromptMappings: [],
  } as SessionState;
  saveSessionState(state, repo, state.sessionTag);
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('ending a session from inside its turn', () => {
  it('closes the open turn and keeps its row before the end barrier goes up', () => {
    const ended = cli(['sessions', 'end', sessionId]);
    expect(ended.status, ended.stderr).toBe(0);
    expect(ended.stdout).toContain('Closed turn 1');
    expect(isManuallyEnded(sessionId)).toBe(true);
    const finalState = JSON.parse(fs.readFileSync(mirror, 'utf8'));
    expect(finalState.status).toBe('ENDED');
    expect(finalState.activeTurn ?? null).toBeNull();
    const rows = (finalState.completedPromptMappings || []) as Array<{ promptIndex: number }>;
    expect(rows.map((r) => r.promptIndex)).toEqual([0]);
  });
});
