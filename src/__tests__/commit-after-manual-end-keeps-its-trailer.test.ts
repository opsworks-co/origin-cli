import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manuallyEndedSessionForTree, recordManualSessionEnd, skipManuallyEndedHook, MANUAL_END_STAMP_WINDOW_MS } from '../manual-session-end.js';
import { pickActiveSessionForCommit, buildOriginTrailers } from '../commands/hooks/git-hooks.js';
import { livePrompts } from '../transcript.js';

/**
 * A commit made AFTER `origin sessions end <own id>` in the same turn still
 * carries that session's trailer. Prod PR #1911, 2026-09-26 15:18Z: the release
 * recipe ended c085f0af, the same turn committed 12b4e4eaa ten minutes later,
 * prepare-commit-msg found no live session, and the PR board showed 0 sessions
 * for an AI-authored PR (TODO 25b883e8). The manual-end marker — removed by the
 * conversation's next prompt — is what says the turn is still running.
 */
const SESSION = 'ab123456-0000-4000-8000-00000000002a';
const CONVERSATION = 'conversation-after-end';
let repo: string;
let other: string;

const state = (over: Record<string, unknown> = {}) => ({
  sessionId: SESSION, sessionTag: 'after-end', claudeSessionId: CONVERSATION, agentSessionId: CONVERSATION,
  agentSlug: 'claude-code', model: 'claude-opus-5', repoPath: repo, lastCwd: repo,
  startedAt: new Date(Date.now() - 600_000).toISOString(), status: 'ENDED', endedAt: new Date().toISOString(),
  prompts: ['fix it', 'merge and release it yourself'], promptTurnIds: ['t_1', 't_2'],
  ...over,
});
const mirrorPath = () => path.join(os.homedir(), '.origin', 'sessions', `${SESSION.slice(0, 12)}.json`);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.origin', 'manual-session-ends'), { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.origin', 'sessions'), { recursive: true, force: true });
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'after-end-repo-')));
  other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'after-end-other-')));
  for (const d of [repo, other]) {
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'config', 'user.email', 't@t.t'); git(d, 'config', 'user.name', 'T'); git(d, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(d, 'f.txt'), 'base\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  }
  fs.mkdirSync(path.dirname(mirrorPath()), { recursive: true });
  fs.writeFileSync(mirrorPath(), JSON.stringify(state()));
});
afterEach(() => {
  for (const d of [repo, other]) fs.rmSync(d, { recursive: true, force: true });
});

describe('a commit after a manual end, before the next prompt', () => {
  it('is stamped with the ended session, from its mirrored state', () => {
    recordManualSessionEnd(state());
    const picked = pickActiveSessionForCommit(repo, { afterManualEnd: true });
    expect(picked?.sessionId).toBe(SESSION);
    const trailers = buildOriginTrailers(picked!.sessionId, picked!.model, livePrompts(picked!).length, null, picked!.agentSlug, 0, livePrompts(picked!).length);
    expect(trailers[0]).toBe(`Origin-Session: ${SESSION.slice(0, 12)} | Claude Code | 2 prompts | turn 2`);
  });

  it('is not offered to a caller that did not ask — post-commit must not record on an ended session', () => {
    recordManualSessionEnd(state());
    expect(pickActiveSessionForCommit(repo)).toBeNull();
  });

  it('stays in its own tree', () => {
    recordManualSessionEnd(state());
    expect(manuallyEndedSessionForTree(other)).toBeNull();
    expect(manuallyEndedSessionForTree(repo)?.sessionId).toBe(SESSION);
  });

  it('ends with the conversation\'s next prompt, which removes the marker', () => {
    recordManualSessionEnd(state());
    expect(skipManuallyEndedHook('user-prompt-submit', { session_id: CONVERSATION }, 'claude-code')).toBe(false);
    expect(manuallyEndedSessionForTree(repo)).toBeNull();
  });

  it('ages out when the conversation never comes back', () => {
    recordManualSessionEnd(state());
    expect(manuallyEndedSessionForTree(repo, { now: Date.now() + MANUAL_END_STAMP_WINDOW_MS + 1 })).toBeNull();
    expect(manuallyEndedSessionForTree(repo, { now: Date.now() + MANUAL_END_STAMP_WINDOW_MS - 60_000 })?.sessionId).toBe(SESSION);
  });

  it('still knows enough for a trailer when the mirror is gone', () => {
    recordManualSessionEnd(state());
    fs.rmSync(mirrorPath());
    const picked = manuallyEndedSessionForTree(repo);
    expect(picked?.sessionId).toBe(SESSION);
    expect(picked?.agentSlug).toBe('claude-code');
    expect(picked?.model).toBe('claude-opus-5');
    expect(picked?.prompts).toHaveLength(2);
  });

  it('a marker from before this field existed (no endedAt) is never used', () => {
    const dir = path.join(os.homedir(), '.origin', 'manual-session-ends');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session-old.json'), JSON.stringify({ sessionId: SESSION, conversationIds: [CONVERSATION], repoPath: repo }));
    expect(manuallyEndedSessionForTree(repo)).toBeNull();
  });
});
