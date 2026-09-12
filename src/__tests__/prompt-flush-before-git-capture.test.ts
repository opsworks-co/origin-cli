/**
 * Cursor kills a hook that is still inside captureGitState when the next
 * prompt arrives. Session e24477e2: Stop logged "prompt mappings" at 02:42
 * and 02:45 and never reached `calling api.updateSession`; submit matched
 * the session at 02:41 and never logged "prompt saved". The prompt list
 * (and the commit's patch) have to be in the retry queue before that git
 * starts.
 *
 * The write-ahead copy is a QUEUE entry only. The state file keeps its one
 * save after the turn boundary is complete (shadow, journal mark, turn id):
 * an earlier save that pushed the prompt before the previous turn's capture
 * left a half-opened turn on a kill and told the heartbeat a turn was in
 * flight with no shadow to anchor it. And the real send at the end of the
 * hook SUPERSEDES the entry — otherwise a hook that finished normally
 * replayed a stale copy of itself (or left it for a later drain to replay
 * over newer state).
 *
 * Source-order guards: driving the hooks for real needs git, fs, env and
 * api stood up. What matters here is where the persist / save / PATCH sit
 * relative to the walk that can hang.
 */
import { describe, it, expect } from 'vitest';
import { hookModuleSource } from './helpers/hooks-source.js';

describe('user-prompt-submit records the prompt before git capture', () => {
  const src = hookModuleSource('user-prompt-submit');

  it('pre-persists the prompt list to the retry queue before the previous-turn capture', () => {
    const persist = src.indexOf("'prompts persisted before git capture'");
    const git = src.indexOf('captureGitState(repoPath, captureBaseline');
    expect(persist).toBeGreaterThan(-1);
    expect(git).toBeGreaterThan(persist);
    expect(src).toContain('persistUpdateBeforeWork(');
  });

  it('keeps the state-file turn boundary atomic: the prompt is pushed and saved AFTER the previous turn is captured', () => {
    const persist = src.indexOf("'prompts persisted before git capture'");
    const prev = src.indexOf("captured per-prompt diff for previous prompt");
    const push = src.indexOf('state.prompts.push(prompt);');
    const saved = src.indexOf("debugLog('user-prompt-submit', 'prompt saved'");
    expect(prev).toBeGreaterThan(persist);
    expect(push).toBeGreaterThan(prev);
    expect(saved).toBeGreaterThan(push);
  });

  it('the real send supersedes the write-ahead entry', () => {
    const persist = src.indexOf('prePersisted = persistUpdateBeforeWork(');
    const send = src.indexOf('{ supersedes: prePersisted }', persist);
    expect(persist).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(persist);
  });
});

describe('stop flushes prompts before captureGitState', () => {
  const src = hookModuleSource('stop');

  it('pre-persists the prompt list above the fullContext walk that can hang', () => {
    const persist = src.indexOf("'prompts persisted before git capture'");
    const git = src.indexOf('captureGitState(state.repoPath, promptBaseline');
    expect(persist).toBeGreaterThan(-1);
    expect(git).toBeGreaterThan(persist);
    expect(src).toContain('persistUpdateBeforeWork(');
  });

  it('never persists status, and the Stop send supersedes the entry', () => {
    const persist = src.indexOf('prePersisted = persistUpdateBeforeWork(');
    expect(persist).toBeGreaterThan(-1);
    expect(src.slice(persist, persist + 300)).not.toContain("status: 'RUNNING'");
    // sendStopCapture is defined above handleStop, so order says nothing here;
    // the entry name travels in as a parameter and the send names it.
    expect(src).toContain('durableUpdate(id, stopUpdatePayload, { supersedes: prePersisted })');
    expect(src).toContain('devinPromptTimes, prePersisted }));');
  });

  it('rescues commitDetails patches as a commit carrier — no diff field, once per sha', () => {
    expect(src).toContain('fillMissingCommitPatches(');
    expect(src).toContain('commitDetails patches rescued without session snapshot');
    const rescue = src.indexOf("'commitDetails patches rescued without session snapshot'");
    const block = src.slice(rescue - 900, rescue);
    expect(block).not.toMatch(/\n\s*diff: ''/);
    expect(block).toContain('rescuableShas(state, [])');
    expect(block).toContain('rememberRescued(state, details, [])');
  });

  it('sends attested commit patches even after a session snapshot was built', () => {
    const thin = src.indexOf("commitDetails patches sent before session snapshot");
    const snap = src.indexOf('session-level gitCapture snapshot built');
    expect(thin).toBeGreaterThan(-1);
    expect(snap).toBeGreaterThan(-1);
    expect(thin).toBeGreaterThan(snap);
    expect(src).toContain('attestedCommitShas(');
    expect(src).toContain('headIsAttested(');
  });
});

describe('post-commit sends the commit before the session snapshot, and the send supersedes its write-ahead copy', () => {
  const src = hookModuleSource('post-commit');

  it('the fast PATCH is a commit carrier: no diff, no line totals', () => {
    const start = src.indexOf('const gitCapture: {');
    const end = src.indexOf('};', src.indexOf('commitDetails: [commitDetail],', start));
    const block = src.slice(start, end);
    expect(block).toContain('diff?: string;');
    expect(block).not.toMatch(/\n\s*diff: diff/);
    expect(block).not.toMatch(/\n\s*linesAdded,\n/);
  });

  it('supersedes the pre-persisted entry on the real send', () => {
    const persist = src.indexOf('const prePersisted = persistUpdateBeforeWork(');
    const send = src.indexOf('{ supersedes: prePersisted }', persist);
    expect(persist).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(persist);
  });
});
