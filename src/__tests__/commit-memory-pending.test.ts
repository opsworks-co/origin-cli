// Regression: a commit the session OWNED but had never recorded stayed
// unrecorded forever.
//
// Per-commit memory was triggered by the commit WALK reporting something new.
// For Cursor the walk is empty by construction — its transcript is written at
// turn end, so the commit is routinely the session's own headShaAtStart and no
// headShaAtStart..HEAD walk can contain it. Session 5c2973be owned 21727e6
// through its transcript and nothing was ever written.
//
// Re-triggering on "newly owned" was not enough either, and this is the subtle
// part: ownership is persisted the moment it is worked out, so once an older
// build had stored the sha, a later build could never see it as new. The
// trigger has to compare against what was RECORDED, which is what these tests
// pin — including that a commit whose facts cannot be read stays pending rather
// than being marked done.

import { describe, it, expect, vi } from 'vitest';
import type { TranscriptAdapter, ScannedTranscript, ParsedSession } from '../transcript-adapters.js';
import { reconcileSession } from '../transcript-watch.js';

vi.mock('../memory.js', async (orig) => {
  const actual = await orig<typeof import('../memory.js')>();
  return { ...actual, shouldWriteMemoryOnCommit: () => true };
});

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const parsed: ParsedSession = {
  userPrompts: ['add a file and commit it'],
  promptTimestamps: [],
  transcript: 't',
  model: 'cursor-model',
  tokensUsed: 10, inputTokens: 5, outputTokens: 5, toolCalls: 1,
  filePaths: [], filesChanged: [], promptDiffs: [],
  // The turn states its own commit — the only signal Cursor leaves.
  promptCommitShas: { 0: [SHA.slice(0, 7)] },
};

const adapter: TranscriptAdapter = {
  slug: 'cursor',
  agentSlugForServer: 'cursor',
  listActive: () => [],
  parse: () => parsed,
};

const scanned: ScannedTranscript = {
  sessionId: 'sess-pending',
  transcriptPath: 'C:/repo/.t.jsonl',
  cwd: 'C:/repo',
  mtimeMs: Date.now(),
};

function depsWith(priorExtra: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    now: () => Date.now(),
    idleMs: 60 * 60_000,        // RUNNING → exercise the live path
    machineId: 'm',
    stateDir: 'C:/tmp',
    api: { startSession: vi.fn(), updateSession: vi.fn().mockResolvedValue({}) },
    resolveRepo: () => ({ repoPath: 'C:/repo', workRoot: 'C:/repo' }),
    createShadow: () => null,
    getHead: () => SHA,
    captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    // The walk is EMPTY — the commit is the session's own baseline.
    captureGit: () => ({
      headBefore: SHA, headAfter: SHA, commitShas: [], commitDetails: [],
      diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
    }),
    // git resolves the short sha and can read the commit's facts.
    resolveFullShaImpl: undefined,
    loadState: () => ({
      agentSlug: 'cursor', sessionId: 'sess-pending', originSessionId: 'o1',
      repoPath: 'C:/repo', workRoot: 'C:/repo', promptCount: 1,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'RUNNING' as const, lastTranscriptMtime: 0, promptShadows: [],
      ...priorExtra,
    }),
    saveState: vi.fn(),
    ...overrides,
  } as any;
}

describe('per-commit memory is keyed on what was RECORDED', () => {
  it('records a commit the session already owned but never wrote', async () => {
    // The exact production state: the sha is in sessionCommitShas (an earlier
    // build put it there) and recordedCommitShas is absent.
    const writeCommitMemoryEntry = vi.fn();
    const deps = depsWith(
      { sessionCommitShas: [SHA] },
      { writeCommitMemoryEntry, writeMemory: vi.fn() },
    );
    await reconcileSession(scanned, adapter, deps);

    // Only asserts the trigger fired — commitFacts needs a real repo, so in
    // this harness the write itself may find nothing to say.
    const state = deps.saveState.mock.calls.at(-1)?.[0];
    expect(state).toBeDefined();
    expect(state.recordedCommitShas).toBeDefined();
  });

  it('does not re-record a commit already written', async () => {
    const writeCommitMemoryEntry = vi.fn();
    const deps = depsWith(
      { sessionCommitShas: [SHA], recordedCommitShas: [SHA] },
      { writeCommitMemoryEntry, writeMemory: vi.fn() },
    );
    await reconcileSession(scanned, adapter, deps);

    expect(writeCommitMemoryEntry).not.toHaveBeenCalled();
  });

  it('carries the recorded list forward across polls', async () => {
    const deps = depsWith(
      { sessionCommitShas: [SHA], recordedCommitShas: [SHA] },
      { writeCommitMemoryEntry: vi.fn(), writeMemory: vi.fn() },
    );
    await reconcileSession(scanned, adapter, deps);

    const state = deps.saveState.mock.calls.at(-1)?.[0];
    expect(state.recordedCommitShas).toContain(SHA);
  });

  it('leaves a commit pending when its facts cannot be read', async () => {
    // commitFacts fails against this fake repo, so nothing is recorded — and
    // the sha must NOT be marked done, or it would never be retried.
    const deps = depsWith(
      { sessionCommitShas: [SHA] },
      { writeCommitMemoryEntry: vi.fn(), writeMemory: vi.fn() },
    );
    await reconcileSession(scanned, adapter, deps);

    const state = deps.saveState.mock.calls.at(-1)?.[0];
    expect(state.recordedCommitShas).not.toContain(SHA);
  });
});
