/**
 * Ending a session must RETIRE its state file, not delete it.
 *
 * The heartbeat ends a claude-code session after 20 minutes of transcript idle
 * — with parentPid 0 there is no process to watch — and then unlinked the
 * state file and every sibling carrying the same sessionId. But "ended" there
 * is a purely LOCAL verdict: the server keeps the same conversation resumable
 * and hands back the SAME session id on the next startSession.
 *
 * So a user who stepped away for two hours came back to a hook that found no
 * state, auto-created one with `prompts: []`, and restarted promptIndex at 0
 * against a server already holding 14 rows — every later turn writing its diff
 * onto an earlier turn's row (prod 0a8e2164, 16:35 → 18:48:
 * `[findStateForHook] scanning {"sessionsInHookCwd":0,"tags":[]}`).
 *
 * Retiring keeps the history readable by tag. listActiveSessions already skips
 * ENDED, so a retired file can never be mistaken for a live session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  pruneRetiredStateFiles,
  promptHistoryFromPriorState,
  RETIRED_STATE_TTL_MS,
} from '../session-state.js';

describe('promptHistoryFromPriorState', () => {
  it('prefers the stored prompt list', () => {
    expect(promptHistoryFromPriorState({ prompts: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('rebuilds from mappings when the prompts were already lost', () => {
    // The shape a prior reset leaves behind: mappings survive, prompts do not.
    expect(promptHistoryFromPriorState({
      prompts: [],
      completedPromptMappings: [
        { promptIndex: 0, promptText: 'first' },
        { promptIndex: 2, promptText: 'third' },
      ],
    })).toEqual(['first', '', 'third']);
  });

  it('keeps an index in place when earlier ones are missing', () => {
    // Index 4 must stay index 4 — the server's rows are keyed on it.
    const out = promptHistoryFromPriorState({
      completedPromptMappings: [{ promptIndex: 4, promptText: 'fifth' }],
    });
    expect(out).toHaveLength(5);
    expect(out[4]).toBe('fifth');
  });

  it('is empty when there is nothing to carry', () => {
    expect(promptHistoryFromPriorState(null)).toEqual([]);
    expect(promptHistoryFromPriorState({ completedPromptMappings: [] })).toEqual([]);
  });
});

describe('pruneRetiredStateFiles', () => {
  let dir: string;

  const write = (name: string, data: Record<string, unknown>, ageMs = 0) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(data));
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(p, when, when);
    }
    return p;
  };

  beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-retire-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('keeps a freshly retired file so a resume can still read it', () => {
    const p = write('origin-session-aaa.json', { sessionId: 'a', status: 'ENDED', prompts: ['one'] });
    expect(pruneRetiredStateFiles(dir)).toBe(0);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('prunes a retired file past the TTL', () => {
    const p = write('origin-session-bbb.json', { sessionId: 'b', status: 'ENDED' }, RETIRED_STATE_TTL_MS + 60_000);
    expect(pruneRetiredStateFiles(dir)).toBe(1);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('never prunes a live session, however old its file looks', () => {
    // Age alone must not decide — an idle-but-running session keeps its state.
    const p = write('origin-session-ccc.json', { sessionId: 'c', status: 'RUNNING' }, RETIRED_STATE_TTL_MS * 4);
    expect(pruneRetiredStateFiles(dir)).toBe(0);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('leaves unrelated and corrupt files alone', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, 'origin-session-ddd.json'), 'not json');
    expect(pruneRetiredStateFiles(dir)).toBe(0);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'origin-session-ddd.json'))).toBe(true);
  });
});
