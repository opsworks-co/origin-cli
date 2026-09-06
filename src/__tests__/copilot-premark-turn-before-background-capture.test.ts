// Copilot's prompt-submit runs DETACHED (it blocks the prompt otherwise), and
// the turn mark was written at the end of that background capture — 6-14s
// after the agent had started writing. Every write in that gap fell into the
// previous turn's span. The cheap half now runs inline before the spawn: mint
// the next turn's id, start the journal, mark it. The background handler then
// finds the id and must NOT re-mark it (the last mark for an id wins, which
// would move the span past the very writes the pre-mark exists to keep).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { preMarkTurnForBackgroundSubmit } from '../commands/hooks.js';
import { saveSessionState, loadSessionState, type SessionState } from '../session-state.js';
import { journalPathsForTag, readJournalEntries, markTurn } from '../write-journal-watch.js';
import { turnIdsInJournal } from '../write-journal.js';

let tmp = '';
let repo = '';
const TAG = 'cop-sess-abc';

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-premark-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'base'], { cwd: repo });
  // A fresh lock says a watcher is live, so nothing is spawned here.
  const jp = journalPathsForTag(TAG);
  fs.mkdirSync(path.dirname(jp.lockPath), { recursive: true });
  fs.writeFileSync(jp.lockPath, String(process.pid));
  // One journal per tag under the worker's home: start each test on an empty one.
  try { fs.unlinkSync(jp.journalPath); } catch { /* none yet */ }
  const state = {
    sessionId: 'sess-copilot-1',
    claudeSessionId: 'cop-sess-abc-full',
    agentSessionId: 'cop-sess-abc-full',
    agentSlug: 'copilot',
    repoPath: repo,
    lastCwd: repo,
    sessionTag: TAG,
    startedAt: new Date().toISOString(),
    status: 'RUNNING',
    prompts: ['first prompt'],
    promptTurnIds: ['t_first0000000001'],
    headShaAtStart: null,
    prePromptSha: null,
  } as unknown as SessionState;
  saveSessionState(state, repo, TAG);
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('preMarkTurnForBackgroundSubmit', () => {
  it('mints the NEXT turn id and marks it in the journal before the background capture runs', () => {
    const ok = preMarkTurnForBackgroundSubmit('copilot', { cwd: repo, session_id: 'cop-sess-abc-full', prompt: 'second' });
    expect(ok).toBe(true);
    const state = loadSessionState(repo, TAG)!;
    expect(state.promptTurnIds).toHaveLength(2);
    expect(state.promptTurnIds![1]).toMatch(/^t_/);
    expect(state.prompts).toEqual(['first prompt']); // the prompt itself is the background handler's to record
    const { journalPath } = journalPathsForTag(TAG);
    expect(state.writeJournalPath).toBe(journalPath);
    expect(turnIdsInJournal(readJournalEntries(journalPath))).toEqual([state.promptTurnIds![1]]);
  });

  it('is idempotent: a second fire keeps the id and adds no second mark', () => {
    preMarkTurnForBackgroundSubmit('copilot', { cwd: repo, session_id: 'cop-sess-abc-full' });
    const first = loadSessionState(repo, TAG)!.promptTurnIds![1];
    preMarkTurnForBackgroundSubmit('copilot', { cwd: repo, session_id: 'cop-sess-abc-full' });
    const state = loadSessionState(repo, TAG)!;
    expect(state.promptTurnIds![1]).toBe(first);
    const marks = readJournalEntries(state.writeJournalPath!).filter((e) => e.kind === 'turn');
    expect(marks).toHaveLength(1);
  });

  it('never marks an id the journal already holds', () => {
    const { journalPath } = journalPathsForTag(TAG);
    markTurn(journalPath, 't_already', 1000);
    const state = loadSessionState(repo, TAG)!;
    state.promptTurnIds = ['t_first0000000001', 't_already'];
    saveSessionState(state, repo, TAG);
    preMarkTurnForBackgroundSubmit('copilot', { cwd: repo, session_id: 'cop-sess-abc-full' });
    const marks = readJournalEntries(journalPath).filter((e) => e.kind === 'turn');
    expect(marks).toHaveLength(1);
  });
});
