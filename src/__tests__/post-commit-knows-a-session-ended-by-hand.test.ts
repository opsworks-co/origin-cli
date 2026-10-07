/**
 * A trailer naming a session ended by hand is the owner speaking, not a stale
 * id.
 *
 * #1918/#1919: prepare-commit-msg stamps a commit made after
 * `origin sessions end <own id>` (inside the same turn) with the ended
 * session's trailer. But `sessions end` deletes the `.git` state file and
 * archives it, and `trailerNamesAKnownSession` read only `.git` — so to
 * post-commit the trailer named nobody, it fell to the lone live session's
 * evidence, and 46bb8093 (`Origin-Session: c085f0af-6f5`, 2026-09-26 19:45Z)
 * was recorded on the quiet sibling b300fdf0 and sent as its prompt 13's work.
 *
 * The manual-end marker is the trace that survives: a session ended by hand
 * within the window is a session that exists.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANUAL_END_STAMP_WINDOW_MS, manuallyEndedSessionIds, recordManualSessionEnd } from '../manual-session-end.js';
import { trailerNamesAKnownSession } from '../commands/hooks.js';
import type { SessionState } from '../session-state.js';

const ENDED = 'c085f0af-6f58-4c35-a640-a59e25863e56';
const LIVE = 'b300fdf0-65c8-4ce7-b443-4d04edb2669d';
const body = (id: string) => `fix: the thing\n\nOrigin-Session: ${id.slice(0, 12)} | Claude Code | 17 prompts | turn 17\n`;
let repo: string;
const live = () => ({ sessionId: LIVE, sessionTag: 'live', repoPath: repo, startedAt: new Date().toISOString() }) as unknown as SessionState;
const markerDir = () => path.join(os.homedir(), '.origin', 'manual-session-ends');
const endedByHand = (over: Record<string, unknown> = {}) => recordManualSessionEnd({
  sessionId: ENDED, agentSlug: 'claude-code', claudeSessionId: 'conversation-ended', agentSessionId: 'conversation-ended',
  repoPath: repo, lastCwd: repo, ...over,
} as any);

beforeEach(() => {
  fs.rmSync(markerDir(), { recursive: true, force: true });
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ended-trailer-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  // The live sibling's state file, as post-commit would find it.
  fs.writeFileSync(path.join(repo, '.git', 'origin-session-live.json'), JSON.stringify(live()));
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('a trailer naming a session ended by hand', () => {
  it('is a known session, though its .git state file is gone', () => {
    endedByHand();
    expect(fs.existsSync(path.join(repo, '.git', `origin-session-${ENDED.slice(0, 12)}.json`))).toBe(false);
    expect(trailerNamesAKnownSession(repo, body(ENDED), live())).toBe(true);
  });

  it('is nobody once the end is older than the window', () => {
    endedByHand();
    const file = fs.readdirSync(markerDir()).find((f) => f.startsWith('session-'))!;
    const p = path.join(markerDir(), file);
    const marker = JSON.parse(fs.readFileSync(p, 'utf8'));
    marker.endedAt = new Date(Date.now() - MANUAL_END_STAMP_WINDOW_MS - 60_000).toISOString();
    fs.writeFileSync(p, JSON.stringify(marker));
    expect(manuallyEndedSessionIds()).toEqual([]);
    expect(trailerNamesAKnownSession(repo, body(ENDED), live())).toBe(false);
  });

  it('a trailer naming an id nothing answers to is still stale', () => {
    expect(trailerNamesAKnownSession(repo, body('deadbeef-0000-4000-8000-000000000000'), live())).toBe(false);
  });

  it('our own end is not "another session"', () => {
    endedByHand({ sessionId: LIVE });
    expect(trailerNamesAKnownSession(repo, body(LIVE), live())).toBe(false);
  });

  it('a .git state file still counts, as before', () => {
    fs.writeFileSync(path.join(repo, '.git', 'origin-session-other.json'), JSON.stringify({ sessionId: ENDED, sessionTag: 'other', status: 'ENDED' }));
    expect(trailerNamesAKnownSession(repo, body(ENDED), live())).toBe(true);
  });
});
