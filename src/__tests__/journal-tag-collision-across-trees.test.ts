// One conversation tag, two working trees — two journals.
//
// The journal used to be keyed on the session TAG alone, and a tag is derived
// from the conversation, not the tree. So when one producer claimed a tag for
// tree A and another wanted the same tag for tree B — a session registered
// under the main checkout before its worktree existed, a producer that derives
// the repo differently from the hook path — both resolved to one
// `<tag>.jsonl`. The second claimant found the first's lock fresh and deferred
// to it, exactly as it would for a legitimate sibling watcher on its own tree.
//
// The deferral was silent and total: the live watcher was recording a tree the
// session never wrote in, so every write was invisible, and the lock never went
// stale because that wrong-tree watcher kept refreshing it — which meant the
// hook path never spawned a watcher of its own and never logged that it hadn't.
//
// That is the shape of session 97846e3a's journal: ONE turn mark, ZERO write
// records, no `.lock` left behind, and no `write-journal watcher spawned` line
// anywhere in `hooks.log` (checked in the rotated `.old` file too — 394 lines
// name the tag, none of them a spawn). With no journal evidence, that session's
// script-driven `packages/cli/package.json` bump had only the turn window left,
// and the window dropped it as another session's file (#1521).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureInProcessJournal, stopJournalWatcher, openJournalWatcherCount,
  __stopAllJournalWatchers,
} from '../ledger-producer.js';
import { journalPathsForTag } from '../write-journal-watch.js';

const FILE = 'packages/cli/package.json';
const TAG = 'conv-tag-0001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a journal is keyed by tag AND tree', () => {
  let home: string;
  let treeA: string;
  let treeB: string;
  let prevHome: string | undefined;

  const mkTree = (name: string): string => {
    const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), name)));
    fs.mkdirSync(path.join(d, 'packages', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(d, FILE), '{"version":"1"}\n');
    return d;
  };

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jhome-')));
    process.env.HOME = home;
    treeA = mkTree('treeA-');
    treeB = mkTree('treeB-');
  });

  afterEach(() => {
    __stopAllJournalWatchers();
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    for (const d of [home, treeA, treeB]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  const writesIn = (tree: string): number => {
    const p = journalPathsForTag(TAG, tree).journalPath;
    if (!fs.existsSync(p)) return 0;
    return (fs.readFileSync(p, 'utf-8').match(/"f":/g) || []).length;
  };

  it('the second tree records its own writes instead of deferring', async () => {
    // Producer 1 claims the tag for tree A and holds the lock.
    ensureInProcessJournal(TAG, treeA, ['t_turn0']);
    await sleep(300);
    // Producer 2 wants the same tag for the tree the session actually writes in.
    ensureInProcessJournal(TAG, treeB, ['t_turn0']);
    await sleep(300);

    // The session's write — a spawned script, no tool call behind it.
    fs.writeFileSync(path.join(treeB, FILE), '{"version":"2"}\n');
    await sleep(1200);

    expect(writesIn(treeB), 'tree B\'s write was invisible — it deferred to tree A\'s watcher').toBe(1);
    // Tree A genuinely changed nothing, so its own journal stays empty.
    expect(writesIn(treeA)).toBe(0);
  }, 20_000);

  it('the two trees resolve to different journal files', () => {
    const a = journalPathsForTag(TAG, treeA);
    const b = journalPathsForTag(TAG, treeB);
    expect(a.journalPath).not.toBe(b.journalPath);
    expect(a.lockPath).not.toBe(b.lockPath);
    expect(a.snapshotDir).not.toBe(b.snapshotDir);
    // Same tree, asked twice, is the same journal — producers must agree.
    expect(journalPathsForTag(TAG, treeA).journalPath).toBe(a.journalPath);
  });

  it('a symlinked or unnormalised spelling of one tree is still one journal', () => {
    const viaDots = path.join(treeA, 'packages', '..', 'packages', '..');
    expect(journalPathsForTag(TAG, viaDots).journalPath)
      .toBe(journalPathsForTag(TAG, treeA).journalPath);
  });

  it('refuses a tag-only stop so one session cannot tear down another worktree', async () => {
    ensureInProcessJournal(TAG, treeA, ['t_turn0']);
    ensureInProcessJournal(TAG, treeB, ['t_turn0']);
    await sleep(200);
    expect(openJournalWatcherCount()).toBe(2);

    // Types prevent this at call sites; this models an old plugin compiled
    // against the former optional-root signature.
    (stopJournalWatcher as unknown as (tag: string) => void)(TAG);
    expect(openJournalWatcherCount()).toBe(2);
    expect(fs.existsSync(journalPathsForTag(TAG, treeA).lockPath)).toBe(true);
    expect(fs.existsSync(journalPathsForTag(TAG, treeB).lockPath)).toBe(true);
  }, 20_000);

  it('stopping one tree leaves the other running', async () => {
    ensureInProcessJournal(TAG, treeA, ['t_turn0']);
    ensureInProcessJournal(TAG, treeB, ['t_turn0']);
    await sleep(200);

    stopJournalWatcher(TAG, treeA);
    expect(openJournalWatcherCount()).toBe(1);
    expect(fs.existsSync(journalPathsForTag(TAG, treeA).lockPath)).toBe(false);
    expect(fs.existsSync(journalPathsForTag(TAG, treeB).lockPath)).toBe(true);
  }, 20_000);
});
