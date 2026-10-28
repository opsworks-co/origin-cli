import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { once } from 'events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDetailed } from '../utils/exec.js';
import { acquireJournalLock } from '../journal-lock.js';
import { saveSessionState, type SessionState } from '../session-state.js';

/**
 * `origin sessions end` closes the open turn by running a Stop itself. It ran
 * that Stop outside the conversation's hook lock, so in session a325d2ee
 * (2026-10-15 20:18Z) it ran beside the NEXT prompt's submit: submit saved 13
 * prompts at 20:18:25, the end command's Stop saved the 12 it had loaded at
 * 20:18:28, and prompt 12 lost its record. Its submit had already marked the
 * journal (t_4f780e…) and post-commit attested four commits to that id; the
 * Stop at 20:21:57 found the prompt with no turn id and minted it another
 * (t_b31ef…), so the served row ended with none of its commits.
 *
 * Real binary: the test holds the lock as the submit would, and the end
 * command must not touch the state until it is released.
 */
const bin = path.resolve(__dirname, '../../dist/index.js');
const sessionId = 'ab123456-0000-4000-8000-00000000001f';
const conversationId = 'conversation-end-beside-submit';
let repo: string;
let mirror: string;
let transcript: string;

const line = (role: 'user' | 'assistant', text: string, at: string) =>
  JSON.stringify({ type: role, timestamp: at, message: { role, content: [{ type: 'text', text }] } });
const readMirror = () => JSON.parse(fs.readFileSync(mirror, 'utf8')) as SessionState;

beforeEach(() => {
  expect(fs.existsSync(bin), 'Build the CLI before exercising the end command').toBe(true);
  const origin = path.join(os.homedir(), '.origin');
  fs.rmSync(origin, { recursive: true, force: true });
  fs.mkdirSync(origin, { recursive: true });
  fs.writeFileSync(path.join(origin, 'config.json'), JSON.stringify({ mode: 'standalone' }));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'manual-end-beside-submit-')));
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
  const at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(transcript, [line('user', 'release it yourself', at), line('assistant', 'Releasing.', at)].join('\n') + '\n');
  const state: SessionState = {
    sessionId, sessionTag: 'end-beside-submit', claudeSessionId: conversationId,
    agentSessionId: conversationId, agentSlug: 'claude-code', model: 'claude-opus-5',
    repoPath: repo, lastCwd: repo, startedAt: new Date(Date.now() - 120_000).toISOString(), status: 'RUNNING',
    transcriptPath: transcript, headShaAtStart: head, headShaAtLastStop: head, prePromptSha: head, branch: 'main',
    prompts: ['release it yourself'],
    promptTurnIds: ['t_release'],
    promptSubmittedAt: [at],
    activeTurn: { index: 0, turnId: 't_release', promptText: 'release it yourself', openedAt: at },
    completedPromptMappings: [],
  } as SessionState;
  saveSessionState(state, repo, state.sessionTag);
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('ending a session while the next prompt is being submitted', () => {
  it('waits for the submit\'s lock, and the prompt keeps its one turn id', async () => {
    expect(readMirror().prompts).toEqual(['release it yourself']);
    const lockPath = path.join(os.homedir(), '.origin', 'hook-locks', createHash('sha256').update(conversationId).digest('hex'));
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const lock = acquireJournalLock(lockPath, { emptyGraceMs: 250 });
    expect(lock, 'the test holds the lock the way a running submit does').toBeTruthy();

    const end = spawn(process.execPath, [bin, 'sessions', 'end', sessionId], { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    end.stdout.on('data', (d) => { stdout += d; });
    end.stderr.on('data', (d) => { stderr += d; });
    const exited = once(end, 'exit');
    try {
      await new Promise((r) => setTimeout(r, 4_000));
      // Unlocked, the Stop has run by now and closed the turn on stale state.
      const during = readMirror();
      expect(during.activeTurn?.turnId, 'the end command closed the turn while the submit held the lock').toBe('t_release');
      expect(during.status).toBe('RUNNING');

      // The submit's save: the next prompt, its turn id and its open turn.
      const now = new Date().toISOString();
      fs.appendFileSync(transcript, line('user', 'all done here?', now) + '\n');
      const s = readMirror();
      s.prompts = [...(s.prompts || []), 'all done here?'];
      s.promptTurnIds = [...(s.promptTurnIds || []), 't_submit'];
      s.promptSubmittedAt = [...(s.promptSubmittedAt || []), now];
      s.lastClosedTurnIndex = 0;
      s.activeTurn = { index: 1, turnId: 't_submit', promptText: 'all done here?', openedAt: now } as SessionState['activeTurn'];
      saveSessionState(s, repo, s.sessionTag);
    } finally {
      lock!.release();
    }
    const [code] = await exited;
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('Closed turn');

    const final = readMirror();
    expect(final.status).toBe('ENDED');
    expect(final.prompts).toEqual(['release it yourself', 'all done here?']);
    expect(final.promptTurnIds).toEqual(['t_release', 't_submit']);
  }, 60_000);
});
