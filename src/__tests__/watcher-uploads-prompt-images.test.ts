// The Stop hook was the only thing that ever uploaded a prompt's images — so
// for every agent that fires no hooks (which is the entire reason the watcher
// exists), a session driven by screenshots recorded no screenshots.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __resetStartSessionBackoff,
  reconcileSession,
  loadSessionState,
  saveSessionState,
  type WatchDeps,
  type SessionWatchState,
} from '../transcript-watch.js';
import type { TranscriptAdapter, ScannedTranscript, ParsedSession } from '../transcript-adapters.js';
import { uploadPromptImages } from '../prompt-images.js';

let tmp = '';
let stateDir = '';
let transcriptPath = '';

const PNG = Buffer.from('fake-png-bytes').toString('base64');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-img-'));
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  transcriptPath = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, [
    // Prompt 0 is a screenshot with no caption at all.
    { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { media_type: 'image/png', data: PNG } }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } },
  ].map((l) => JSON.stringify(l)).join('\n'));
  __resetStartSessionBackoff();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mockApi(uploadAttachment?: WatchDeps['api']['uploadAttachment']) {
  let n = 0;
  return {
    startSession: vi.fn(async () => ({ sessionId: `sess-${++n}` })),
    updateSession: vi.fn(async () => ({})),
    ...(uploadAttachment ? { uploadAttachment } : {}),
  };
}

function baseDeps(api: any, over: Partial<WatchDeps> = {}): WatchDeps {
  return {
    now: () => Date.now(),
    idleMs: 20 * 60 * 1000,
    machineId: 'machine-1',
    hostname: 'host-1',
    stateDir,
    api,
    resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, repoUrl: 'git@github.com:org/repo.git', branch: 'main' }),
    createShadow: () => 'a'.repeat(40),
    getHead: () => 'b'.repeat(40),
    captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    captureGit: () => ({
      headBefore: 'b'.repeat(40), headAfter: 'b'.repeat(40), commitShas: [], commitDetails: [],
      diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
    }),
    loadState: (agentSlug: string, sessionId: string) => loadSessionState(agentSlug, sessionId, stateDir),
    saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
    ...over,
  };
}

function fakeAdapter(): TranscriptAdapter {
  const parsed: ParsedSession = {
    userPrompts: ['[image]'],
    promptTimestamps: [1_000],
    transcript: 'the transcript',
    model: 'claude-opus-5',
    tokensUsed: 10, inputTokens: 5, outputTokens: 5, toolCalls: 0,
    filePaths: [], filesChanged: [], promptDiffs: [],
  };
  return { slug: 'fake', agentSlugForServer: 'fake-agent', listActive: () => [], parse: () => parsed };
}

function scanned(): ScannedTranscript {
  return { sessionId: 'conv-1', transcriptPath, cwd: tmp, mtimeMs: Date.now() };
}

describe('the watcher uploads the images a prompt carried', () => {
  it('sends them, and does not send the same one twice', async () => {
    const sent: any[] = [];
    const api = mockApi(async (_id, payload) => { sent.push(payload); return { id: `att-${sent.length}` }; });
    const deps = baseDeps(api);

    const first = await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ promptIndex: 0, imageIndex: 0, mediaType: 'image/png', base64: PNG });
    expect(first?.uploadedImages).toEqual(['0:0']);

    // The daemon re-polls every 8s and the transcript still holds the image.
    await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(sent).toHaveLength(1);
  });

  it('retries an image the prompt row was not ready for', async () => {
    let attempts = 0;
    const api = mockApi(async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('PromptChange row not found'), { status: 404 });
      return { id: 'att-1' };
    });
    const deps = baseDeps(api);

    const first = await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(first?.uploadedImages).toEqual([]);

    const second = await reconcileSession(scanned(), fakeAdapter(), deps);
    expect(attempts).toBe(2);
    expect(second?.uploadedImages).toEqual(['0:0']);
  });
});

describe('uploadPromptImages', () => {
  it('stops at the first 403 and latches nothing, so flipping the toggle back on works', async () => {
    const upload = vi.fn(async () => { throw Object.assign(new Error('Image capture is disabled'), { status: 403 }); });
    const result = await uploadPromptImages({ sessionId: 's', transcriptPath, upload });
    expect(result).toEqual({ uploaded: [], optedOut: true, descriptions: {} });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('latches an over-cap image instead of re-encoding it every poll', async () => {
    const huge = path.join(tmp, 'huge.jsonl');
    fs.writeFileSync(huge, [
      { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { media_type: 'image/png', data: 'A'.repeat(8 * 1024 * 1024) } }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ].map((l) => JSON.stringify(l)).join('\n'));

    const upload = vi.fn(async () => ({ id: 'x' }));
    const result = await uploadPromptImages({ sessionId: 's', transcriptPath: huge, upload });
    expect(upload).not.toHaveBeenCalled();
    expect(result.uploaded).toEqual(['0:0']);
  });
});
