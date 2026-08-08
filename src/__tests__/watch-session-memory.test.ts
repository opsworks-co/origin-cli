// Cross-session memory was only ever written by the hook path, and GUI agents
// fire no hooks on Windows — they are captured by the transcript watcher. So on
// a Windows box `origin context memory` reported "No session memory yet" no
// matter how many sessions had run (origin-demo-1 had dozens, and the repo had
// no refs/notes/origin-memory at all).
//
// A session going idle is exactly when the hook path records an entry, so the
// watcher records one at the same moment, in the same shape.

import { describe, it, expect, vi } from 'vitest';
import { reconcileSession } from '../transcript-watch.js';
import type { TranscriptAdapter, ParsedSession, ScannedTranscript } from '../transcript-adapters.js';

const parsed: ParsedSession = {
  userPrompts: ['add retry logic to the uploader. TODO: cover the 429 case'],
  promptTimestamps: [],
  transcript: '[]',
  model: 'gpt-5',
  tokensUsed: 10, inputTokens: 5, outputTokens: 5, toolCalls: 1,
  filePaths: ['C:/repo/src/upload.ts'],
  filesChanged: ['C:/repo/src/upload.ts'],
  promptDiffs: [{ promptIndex: 0, filesChanged: ['C:/repo/src/upload.ts'], diff: '', linesAdded: 12, linesRemoved: 3 }],
};

const adapter: TranscriptAdapter = {
  slug: 'cursor',
  agentSlugForServer: 'cursor',
  listActive: () => [],
  parse: () => parsed,
};

const scanned: ScannedTranscript = {
  sessionId: 'sess-abc',
  transcriptPath: 'C:/repo/.transcript.jsonl',
  cwd: 'C:/repo',
  mtimeMs: 0, // ancient → idle → END path
};

function depsWith(overrides: Record<string, unknown> = {}) {
  return {
    now: () => 1_000_000_000,
    idleMs: 1000,
    machineId: 'm',
    stateDir: 'C:/tmp',
    api: { startSession: vi.fn(), updateSession: vi.fn().mockResolvedValue({}) },
    resolveRepo: () => ({ repoPath: 'C:/repo', workRoot: 'C:/repo' }),
    createShadow: () => null,
    getHead: () => null,
    captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    captureGit: () => ({ headBefore: '', headAfter: '', commitShas: [], commitDetails: [], diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0 }),
    loadState: () => ({
      agentSlug: 'cursor', sessionId: 'sess-abc', originSessionId: 'origin-1',
      repoPath: 'C:/repo', workRoot: 'C:/repo', promptCount: 1,
      createdAt: '2026-08-08T10:00:00.000Z', status: 'RUNNING' as const,
      lastTranscriptMtime: 0, promptShadows: [],
    }),
    saveState: vi.fn(),
    ...overrides,
  } as any;
}

describe('transcript watcher records session memory at END', () => {
  it('writes an entry when a session goes idle', async () => {
    const writeMemory = vi.fn();
    await reconcileSession(scanned, adapter, depsWith({ writeMemory }));

    expect(writeMemory).toHaveBeenCalledTimes(1);
    const [repoPath, entry] = writeMemory.mock.calls[0];
    expect(repoPath).toBe('C:/repo');
    expect(entry.sessionId).toBe('sess-abc');
    expect(entry.agentSlug).toBe('cursor');
    expect(entry.model).toBe('gpt-5');
    expect(entry.promptCount).toBe(1);
    expect(entry.summary).toContain('retry logic');
    // Repo-relative, or isSubstantiveMemory drops the entry as foreign work.
    expect(entry.filesChanged).toEqual(['src/upload.ts']);
    // Totalled from the per-turn diffs the adapter computed.
    expect(entry.linesAdded).toBe(12);
    expect(entry.linesRemoved).toBe(3);
    expect(entry.startedAt).toBe('2026-08-08T10:00:00.000Z');
    // Open work carries forward — the whole point of memory for the next agent.
    expect(entry.openTodos.join(' ')).toContain('429');
  });

  it('summarises from what the session COMMITTED, not its opening prompt', async () => {
    // A six-turn session remembered as its first sentence is close to useless;
    // the hook path summarises from commit subjects, so this does too.
    const writeMemory = vi.fn();
    await reconcileSession(scanned, adapter, depsWith({
      writeMemory,
      loadState: () => ({
        agentSlug: 'cursor', sessionId: 'sess-abc', originSessionId: 'origin-1',
        repoPath: 'C:/repo', workRoot: 'C:/repo', promptCount: 1,
        createdAt: '2026-08-08T10:00:00.000Z', status: 'RUNNING' as const,
        lastTranscriptMtime: 0, promptShadows: [],
        sessionCommitShas: ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
      }),
    }));
    // The sha isn't in any real repo here, so the subject lookup finds nothing
    // and it falls back to the prompt — the fallback must still be a summary,
    // never blank.
    const [, entry] = writeMemory.mock.calls[0];
    expect(entry.summary).toBeTruthy();
    expect(entry.summary).toContain('retry logic');
  });

  it('does not write for a session that touched no repo file', async () => {
    // A chat-only turn is not worth remembering, and an entry with no
    // repo-relative files is what benchmark noise looks like.
    const writeMemory = vi.fn();
    const chatOnly: TranscriptAdapter = {
      ...adapter,
      parse: () => ({ ...parsed, filesChanged: [], promptDiffs: [] }),
    };
    await reconcileSession(scanned, chatOnly, depsWith({ writeMemory }));
    expect(writeMemory).not.toHaveBeenCalled();
  });

  it('still ends the session when no memory writer is wired', async () => {
    const saveState = vi.fn();
    const res = await reconcileSession(scanned, adapter, depsWith({ saveState, writeMemory: undefined }));
    expect(res?.status).toBe('ENDED');
    expect(saveState).toHaveBeenCalled();
  });
});
