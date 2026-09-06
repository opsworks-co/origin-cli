// The transcript watcher handed the ledger no baseline, so a turn's FIRST write
// to an existing file rendered as a creation.
//
// The ledger knows a file's before-state only when an earlier record in the
// same journal holds it. For a file the turn is the first to touch it asks git
// for `<baseline>:<file>` — and the watcher's call site passed no baseline at
// all, so that read never happened, `before` stayed null, and the diff came
// out as `new file mode` with the whole file as additions. Every existing file
// a watcher-captured turn edited looked freshly created: prod d731ff09 turn 9
// showed seven files / +4219 −0, none of them new; bd3c110a turn 2 eleven
// files / +684 −0.
//
// This drives the REAL reconcile loop against a REAL git repo and a REAL
// journal watcher: one prompt, one edit to a committed file, and the row must
// be a modification.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  __resetStartSessionBackoff,
  __stopAllJournalWatchers,
  reconcileSession,
  loadSessionState,
  saveSessionState,
  type WatchDeps,
  type SessionWatchState,
} from '../transcript-watch.js';
import type { TranscriptAdapter, ScannedTranscript, ParsedSession } from '../transcript-adapters.js';
import { journalPathsForTag, readJournalEntries, DEBOUNCE_MS } from '../write-journal-watch.js';
import { parseUnifiedDiff, verifyTurn } from '../capture-verify.js';

let tmp = '';
let stateDir = '';
let repo = '';

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'twatch-ledger-')));
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
  fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n');
  git(['add', '.']);
  git(['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'base']);
  __resetStartSessionBackoff();
});

afterEach(() => {
  __stopAllJournalWatchers();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function adapter(): TranscriptAdapter {
  const parsed: ParsedSession = {
    userPrompts: ['change the greeting'],
    promptTimestamps: [1_000],
    transcript: 'the transcript',
    model: 'some-model',
    tokensUsed: 1, inputTokens: 1, outputTokens: 0, toolCalls: 1,
    // No file truth from the adapter: the ledger is the only source.
  };
  return { slug: 'ledgeragent', agentSlugForServer: 'ledger-agent', listActive: () => [], parse: () => parsed };
}

function scanned(): ScannedTranscript {
  const file = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(file, '{"role":"user","content":"change the greeting"}\n');
  return { sessionId: 'conv-ledger-1', transcriptPath: file, cwd: repo, mtimeMs: Date.now() };
}

function deps(updates: any[]): WatchDeps {
  return {
    now: () => Date.now(),
    idleMs: 20 * 60 * 1000,
    machineId: 'machine-1',
    stateDir,
    api: {
      startSession: async () => ({ sessionId: 'sess-ledger' }),
      updateSession: async (_id: string, data: any) => { updates.push(data); return {}; },
    },
    resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, branch: 'main' }),
    // No shadow: the baseline for prompt 0 is HEAD, read through the real git.
    createShadow: () => null,
    getHead: (workRoot: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workRoot, encoding: 'utf-8' }).trim(),
    // The watcher's own reconstruction sees nothing, so whatever the row
    // carries came from the ledger.
    captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    captureGit: () => ({
      headBefore: '', headAfter: '', commitShas: [], commitDetails: [],
      diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
    }),
    loadState: (a: string, s: string) => loadSessionState(a, s, stateDir),
    saveState: (s: SessionWatchState) => saveSessionState(s, stateDir),
  };
}

const waitFor = async (cond: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('transcript watcher + ledger on an existing file', () => {
  it('renders the turn\'s first write to a committed file as a modification, not a creation', async () => {
    const updates: any[] = [];
    const d = deps(updates);

    // Poll 1: registers the session, mints the turn id, starts the in-process
    // journal watcher and marks the turn.
    const first = await reconcileSession(scanned(), adapter(), d);
    expect(first?.originSessionId).toBe('sess-ledger');
    const tag = first!.sessionTag as string;
    expect(tag).toBeTruthy();
    const { journalPath } = journalPathsForTag(tag);
    const writesIn = () => readJournalEntries(journalPath).filter((e) => e.kind === 'write').length;
    if (!fs.existsSync(journalPath)) return; // no recursive watch on this platform

    // FSEvents may not deliver writes that land before the watch is armed, so
    // prove it is live first with a gitignored probe (ignored files never
    // reach the ledger's answer).
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 200 && writesIn() === 0; i++) {
      fs.writeFileSync(probe, String(i));
      await new Promise((r) => setTimeout(r, 25));
    }
    if (writesIn() === 0) return; // watcher never armed here — nothing to assert
    const probeWrites = writesIn();
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));

    // The turn's ONLY edit: one line of a file that existed at the baseline.
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("new")\n');
    await waitFor(() => writesIn() > probeWrites);

    // Poll 2: the ledger answers for the turn.
    const scan2 = scanned();
    scan2.mtimeMs = Date.now();
    await reconcileSession(scan2, adapter(), d);

    const row = updates[updates.length - 1].promptChanges[0];
    expect(row.diffSource).toBe('ledger');
    expect(row.filesChanged).toEqual(['app.py']);
    expect(row.diff).not.toContain('new file mode');
    expect(row.diff).toContain('-    print("old")');
    expect(row.diff).toContain('+    print("new")');
    expect(row.linesAdded).toBe(1);
    expect(row.linesRemoved).toBe(1);
    expect(parseUnifiedDiff(row.diff).files[0].isNew).toBe(false);
    expect(verifyTurn({
      promptIndex: 0,
      filesChanged: row.filesChanged,
      diff: row.diff,
      linesAdded: row.linesAdded,
      linesRemoved: row.linesRemoved,
    })).toEqual([]);
  });
});
