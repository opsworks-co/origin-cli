// A rival session's writes reached a turn through the WATCHER'S ledger pass.
//
// #2950 closed this for Stop: a turn a rival covered stays off the ledger after
// the rival goes quiet (prod 208f153c turn 27). The transcript watcher and the
// Codex daemon reach the same applier through applyLedgerToProducerRows, which
// handed it none of the marks that rule reads, and which asked about rivals only
// when the session already had a state file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyLedgerToProducerRows, producerLedgerIsContended } from '../ledger-producer.js';
import { journalPathsForTag } from '../write-journal-watch.js';
import { sessionTagFor } from '../session-state.js';
import { __resetStartSessionBackoff, __stopAllJournalWatchers, reconcileSession, type WatchDeps } from '../transcript-watch.js';
import type { ParsedSession, ScannedTranscript, TranscriptAdapter } from '../transcript-adapters.js';
import { serializeRecord, serializeTurnMark } from '../write-journal.js';
import { putSnapshot } from '../write-journal-store.js';

const TAG = 'selftag00000';
const T1 = Date.now() - 60_000;
const GONE = T1 + 20_000;
const T2 = T1 + 40_000;

let tmp = '';
let repo = '';
let realHome: string | undefined;
let head = '';

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

function writeState(tag: string, fields: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify({
    claudeSessionId: tag, sessionTag: tag, repoPath: repo, lastCwd: repo, status: 'RUNNING', prompts: ['p'], ...fields,
  }));
}

function writeJournal(tag = TAG): void {
  const { journalPath, snapshotDir } = journalPathsForTag(tag, repo);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const put = (content: string) => putSnapshot(snapshotDir, content).hash;
  fs.writeFileSync(journalPath, [
    serializeTurnMark({ at: T1, turnId: 'turn-1' }),
    serializeRecord({ at: T1 + 5_000, file: 'rival.ts', hash: put('the rival wrote this\n'), retained: true }),
    serializeTurnMark({ at: T2, turnId: 'turn-2' }),
    serializeRecord({ at: T2 + 5_000, file: 'mine.ts', hash: put('turn 2 wrote this\n'), retained: true }),
  ].join(''));
}

function capture(startedAt: Array<number | undefined> = [T1, T2]) {
  const rows: Array<Record<string, unknown>> = [
    { promptIndex: 0, filesChanged: [], diff: '' },
    { promptIndex: 1, filesChanged: [], diff: '' },
  ];
  applyLedgerToProducerRows({
    tag: TAG,
    workRoot: repo,
    promptTurnIds: ['turn-1', 'turn-2'],
    promptShadows: startedAt.map((promptStartedAt, promptIndex) => ({ promptIndex, shadowSha: head, promptStartedAt })),
    prePromptSha: head,
    headShaAtStart: head,
  }, rows as never, 'test');
  return rows;
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'producer-contention-')));
  process.env.HOME = tmp;
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git('add', '.');
  git('-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'base');
  head = git('rev-parse', 'HEAD');
  writeJournal();
});

afterEach(() => {
  __stopAllJournalWatchers();
  process.env.HOME = realHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the watcher ledger pass and a rival', () => {
  it('with no rival, both turns come from the ledger', () => {
    writeState(TAG, { sessionId: 'self' });
    const rows = capture();
    expect(rows[0].diffSource).toBe('ledger');
    expect(rows[1].diffSource).toBe('ledger');
  });

  it('a turn the rival covered stays off the ledger after the rival is gone', () => {
    writeState(TAG, {
      sessionId: 'self',
      contendingSessionIds: ['rival'],
      contenderGoneAt: { rival: GONE },
      currentTurnStartedAt: T2,
    });
    const rows = capture();
    expect(rows[0].diffSource).toBeUndefined();
    expect(rows[0].filesChanged).toEqual([]);
    expect(rows[1].diffSource).toBe('ledger');
    expect(rows[1].filesChanged).toEqual(['mine.ts']);
  });

  it('a turn with no known start is declined while the session has rivals', () => {
    writeState(TAG, {
      sessionId: 'self',
      contendingSessionIds: ['rival'],
      contenderGoneAt: { rival: GONE },
      currentTurnStartedAt: T2,
    });
    const rows = capture([undefined, T2]);
    expect(rows[0].diffSource).toBeUndefined();
    expect(rows[1].diffSource).toBe('ledger');
  });

  it('a session with no state file still sees a live rival in its tree', () => {
    writeState('rival0000000', { sessionId: 'rival', currentTurnStartedAt: Date.now() - 1_000 });
    expect(producerLedgerIsContended(TAG, repo)).toBe(true);
    const rows = capture();
    expect(rows[0].diffSource).toBeUndefined();
    expect(rows[1].diffSource).toBeUndefined();
  });

  it('a session with no state file ignores a rival in another tree', () => {
    writeState('rival0000000', { sessionId: 'rival', lastCwd: path.join(tmp, 'elsewhere'), currentTurnStartedAt: Date.now() - 1_000 });
    expect(producerLedgerIsContended(TAG, repo)).toBe(false);
  });
});

// The assembly: the watcher's real poll has to hand over each turn's start, or
// every turn of a session with rivals reads as unprovable and is declined.
describe('the transcript watcher poll', () => {
  it('declines the covered turn and captures the later one', async () => {
    __resetStartSessionBackoff();
    const conversation = 'conv-rival-covered';
    const tag = sessionTagFor(undefined, conversation);
    writeJournal(tag);
    writeState(tag, {
      sessionId: 'sess-1',
      claudeSessionId: conversation,
      prompts: ['first', 'second'],
      promptTurnIds: ['turn-1', 'turn-2'],
      contendingSessionIds: ['rival'],
      contenderGoneAt: { rival: GONE },
      currentTurnStartedAt: T2,
    });
    const parsed: ParsedSession = {
      userPrompts: ['first', 'second'],
      promptTimestamps: [T1, T2],
      transcript: 'the transcript',
      model: 'some-model',
      tokensUsed: 1, inputTokens: 1, outputTokens: 0, toolCalls: 1,
    };
    const adapter: TranscriptAdapter = { slug: 'ledgeragent', agentSlugForServer: 'ledger-agent', listActive: () => [], parse: () => parsed };
    const file = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(file, '{}\n');
    const scanned: ScannedTranscript = { sessionId: conversation, transcriptPath: file, cwd: repo, mtimeMs: Date.now() };
    const updates: any[] = [];
    const deps: WatchDeps = {
      now: () => Date.now(),
      idleMs: 20 * 60 * 1000,
      machineId: 'machine-1',
      stateDir: path.join(tmp, 'watch-state'),
      api: {
        startSession: async () => ({ sessionId: 'sess-1' }),
        updateSession: async (_id: string, data: any) => { updates.push(data); return {}; },
      },
      resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, branch: 'main' }),
      createShadow: () => null,
      getHead: () => head,
      captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
      captureGit: () => ({
        headBefore: '', headAfter: '', commitShas: [], commitDetails: [],
        diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
      }),
      loadGitState: (root: string, t: string) => JSON.parse(fs.readFileSync(path.join(root, '.git', `origin-session-${t}.json`), 'utf-8')),
      loadState: () => null,
      saveState: () => {},
    } as never;
    await reconcileSession(scanned, adapter, deps);
    const rows = updates[updates.length - 1].promptChanges;
    expect(rows[0].diffSource).toBeUndefined();
    expect(rows[0].filesChanged).not.toContain('rival.ts');
    expect(rows[1].diffSource).toBe('ledger');
    expect(rows[1].filesChanged).toEqual(['mine.ts']);
  });
});
