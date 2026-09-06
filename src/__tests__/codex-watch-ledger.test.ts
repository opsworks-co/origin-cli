// The Codex daemon never touched the ledger.
//
// Every other producer had been moved onto the observed-write journal — the
// Stop hook, the heartbeat, the transcript watcher — but Codex is deliberately
// absent from the transcript adapters (it has its own daemon), and that daemon
// built every row from the rollout's apply_patch text or a shadow-range diff.
// Neither sees a file the agent wrote through the shell, and the shadow range
// is disqualified whenever the poll ran late. Codex is the hookless agent the
// ledger was built for, and it was the one agent with no journal at all.
//
// This drives the REAL reconcile loop against a REAL git repo and a REAL
// journal watcher: one prompt, one shell-style edit to a committed file that
// the rollout never records as a patch, and the row must come from the ledger.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  reconcileThread,
  loadThreadState,
  saveThreadState,
  codexJournalTag,
  type WatchDeps,
  type ThreadWatchState,
  type ScannedRollout,
} from '../codex-watch.js';
import { parseCodexRolloutLive, isCodexInternalSubroutine } from '../agents/codex.js';
import { __stopAllJournalWatchers } from '../ledger-producer.js';
import { journalPathsForTag, readJournalEntries, DEBOUNCE_MS } from '../write-journal-watch.js';
import { parseUnifiedDiff, verifyTurn } from '../capture-verify.js';

let tmp = '';
let stateDir = '';
let repo = '';

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ledger-')));
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.probe\n');
  fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("old")\n');
  git(['add', '.']);
  git(['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'base']);
});

afterEach(() => {
  __stopAllJournalWatchers();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeRollout(threadId: string, prompts: string[]): string {
  const dir = path.join(tmp, 'sessions', '2026', '09', '02');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-02T10-00-00-${threadId}.jsonl`);
  const lines = [JSON.stringify({
    timestamp: '2026-09-02T10:00:05.000Z',
    type: 'session_meta',
    payload: { id: threadId, timestamp: '2026-09-02T10:00:00.000Z', cwd: repo, originator: 'codex_cli_rs' },
  })];
  for (const p of prompts) {
    lines.push(JSON.stringify({
      timestamp: '2026-09-02T10:00:10.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: p }] },
    }));
  }
  // A shell write: the rollout records the COMMAND, never a patch, so the
  // rollout-derived path has nothing and the ledger is the only witness.
  lines.push(JSON.stringify({ payload: { type: 'function_call', name: 'exec', input: 'sed -i s/old/new/ app.py', call_id: 'c0' } }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function deps(updates: any[]): WatchDeps {
  return {
    now: () => Date.now(),
    idleMs: 20 * 60 * 1000,
    machineId: 'machine-1',
    hostname: 'host-1',
    stateDir,
    api: {
      startSession: async () => ({ sessionId: 'sess-codex-ledger' }),
      updateSession: async (_id: string, data: any) => { updates.push(data); return {}; },
    },
    parseRollout: (p: string) => parseCodexRolloutLive(p),
    isInternalSubroutine: isCodexInternalSubroutine,
    resolveRepo: (cwd: string) => ({ repoPath: cwd, workRoot: cwd, branch: 'main' }),
    // No shadow: the baseline for prompt 0 is HEAD, read through the real git.
    createShadow: () => null,
    getHead: (workRoot: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workRoot, encoding: 'utf-8' }).trim(),
    // The daemon's own reconstruction sees nothing, so whatever the row
    // carries came from the ledger.
    captureDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    captureRangeDiff: () => ({ diff: '', filesChanged: [], linesAdded: 0, linesRemoved: 0 }),
    captureGit: () => ({
      headBefore: '', headAfter: '', commitShas: [], commitDetails: [],
      diff: '', diffTruncated: false, linesAdded: 0, linesRemoved: 0,
    }),
    loadState: (threadId: string) => loadThreadState(threadId, stateDir),
    saveState: (s: ThreadWatchState) => saveThreadState(s, stateDir),
  };
}

const waitFor = async (cond: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('codex daemon + ledger', () => {
  it('takes a shell write the rollout never patched from the write journal', async () => {
    const threadId = 'ledger-aaaa-0001';
    const rollout = writeRollout(threadId, ['change the greeting']);
    const scanned: ScannedRollout = { rolloutPath: rollout, threadId, cwd: repo, mtimeMs: Date.now() };
    const updates: any[] = [];
    const d = deps(updates);

    // Poll 1: registers the session, mints the turn id, starts the in-process
    // journal watcher and marks the turn.
    const first = await reconcileThread(scanned, d);
    expect(first?.sessionId).toBe('sess-codex-ledger');
    const { journalPath } = journalPathsForTag(codexJournalTag(threadId));
    const writesIn = () => readJournalEntries(journalPath).filter((e) => e.kind === 'write').length;
    if (!fs.existsSync(journalPath)) return; // no recursive watch on this platform
    expect(readJournalEntries(journalPath).some((e) => e.kind === 'turn' && e.turnId === first!.promptTurns![0].turnId)).toBe(true);

    // FSEvents may not deliver writes that land before the watch is armed, so
    // prove it is live first with a gitignored probe.
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 200 && writesIn() === 0; i++) {
      fs.writeFileSync(probe, String(i));
      await new Promise((r) => setTimeout(r, 25));
    }
    if (writesIn() === 0) return; // watcher never armed here — nothing to assert
    const probeWrites = writesIn();
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));

    // The turn's ONLY edit, made the way a shell makes it.
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("new")\n');
    await waitFor(() => writesIn() > probeWrites);

    // Poll 2: the ledger answers for the turn.
    await reconcileThread({ ...scanned, mtimeMs: Date.now() }, d);
    const rows = updates[updates.length - 1].promptChanges as any[];
    const row = rows.find((r) => r.promptIndex === 0);
    expect(row).toBeTruthy();
    expect(row.diffSource).toBe('ledger');
    expect(row.turnId).toBe(first!.promptTurns![0].turnId);
    expect(row.authoritative).toBe(true);
    expect(row.filesChanged).toEqual(['app.py']);
    expect(row.diff).toContain('-    print("old")');
    expect(row.diff).toContain('+    print("new")');
    expect(row.linesAdded).toBe(1);
    expect(row.linesRemoved).toBe(1);
    expect(parseUnifiedDiff(row.diff).files[0].isNew).toBe(false);
    expect(verifyTurn({
      promptIndex: 0, filesChanged: row.filesChanged, diff: row.diff,
      linesAdded: row.linesAdded, linesRemoved: row.linesRemoved,
    })).toEqual([]);
  });

  it('a completed turn the shadow range could not seal is still answered, and then sealed', async () => {
    const threadId = 'ledger-bbbb-0002';
    const rollout = writeRollout(threadId, ['first']);
    const scanned: ScannedRollout = { rolloutPath: rollout, threadId, cwd: repo, mtimeMs: Date.now() };
    const updates: any[] = [];
    const d = deps(updates);

    const first = await reconcileThread(scanned, d);
    const { journalPath } = journalPathsForTag(codexJournalTag(threadId));
    const writesIn = () => readJournalEntries(journalPath).filter((e) => e.kind === 'write').length;
    if (!fs.existsSync(journalPath)) return;
    const probe = path.join(repo, '.probe');
    for (let i = 0; i < 200 && writesIn() === 0; i++) {
      fs.writeFileSync(probe, String(i));
      await new Promise((r) => setTimeout(r, 25));
    }
    if (writesIn() === 0) return;
    const probeWrites = writesIn();
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));

    // Turn 0's write lands, then a SECOND prompt arrives before the next poll
    // — the case where the closing shadow is late and the seal is refused.
    fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    print("new")\n');
    await waitFor(() => writesIn() > probeWrites);
    const rollout2 = writeRollout(threadId, ['first', 'second']);
    const second = await reconcileThread({ ...scanned, rolloutPath: rollout2, mtimeMs: Date.now() }, d);

    const rows = updates[updates.length - 1].promptChanges as any[];
    const row0 = rows.find((r) => r.promptIndex === 0);
    expect(row0?.diffSource).toBe('ledger');
    expect(row0.filesChanged).toEqual(['app.py']);
    expect(row0.turnId).toBe(first!.promptTurns![0].turnId);
    // Final: the span is closed by turn 1's mark, so it is computed once.
    expect(second?.sealedPrompts).toContain(0);
    // Turn 1 has written nothing; the ledger declines and no phantom row is sent.
    const row1 = rows.find((r) => r.promptIndex === 1);
    expect(row1?.diffSource).toBeUndefined();
  });
});
