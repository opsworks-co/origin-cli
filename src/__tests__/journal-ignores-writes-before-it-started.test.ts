// A write made before the watcher started is not the turn's write.
//
// macOS's recursive fs.watch (FSEvents) delivers events late, and delivers ones
// from just before the stream opened. A file written a few ms before a turn's
// watcher started reached it ~60 ms later and was journalled as the turn's
// write: journal-tag-collision-across-trees failed on every macOS run because
// tree A's journal held the setup write of `packages/cli/package.json`
// (mtime …921.86, turn mark …924, record …986).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWatchedRootEvent, startWriteJournal, untouchedSinceStart, type JournalWatcher } from '../write-journal-watch.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the journal ignores writes made before it started', () => {
  let root: string;
  let journalDir: string;
  let journalPath: string;
  let watcher: JournalWatcher | null = null;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jpre-tree-')));
    journalDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jpre-journal-')));
    journalPath = path.join(journalDir, 'j.jsonl');
  });

  afterEach(() => {
    watcher?.stop();
    watcher = null;
    for (const d of [root, journalDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  const recorded = (): string[] => {
    if (!fs.existsSync(journalPath)) return [];
    return fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { f?: string }).filter((r) => r.f).map((r) => r.f as string);
  };

  it('a file written just before the watcher starts gets no record', async () => {
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg', 'package.json'), '{"version":"1"}\n');
    watcher = startWriteJournal(root, journalPath, { snapshotDir: path.join(journalDir, 'snaps') });
    expect(watcher).not.toBeNull();
    await sleep(1200);
    expect(recorded()).toEqual([]);
  }, 20_000);

  it('a write after the start is still recorded, and so is a file moved in', async () => {
    fs.writeFileSync(path.join(root, 'old.txt'), 'before\n');
    const outside = path.join(journalDir, 'made-elsewhere.txt');
    fs.writeFileSync(outside, 'moved\n');
    watcher = startWriteJournal(root, journalPath, { snapshotDir: path.join(journalDir, 'snaps') });
    await sleep(300);
    fs.writeFileSync(path.join(root, 'old.txt'), 'after\n');
    // Its bytes predate the watcher; its arrival in the tree is the turn's work.
    fs.renameSync(outside, path.join(root, 'moved.txt'));
    await sleep(1200);
    expect(new Set(recorded())).toEqual(new Set(['old.txt', 'moved.txt']));
  }, 20_000);

  it('without the FSEvents filter, a top-level file named like the root is still a write', async () => {
    // Windows and any other non-FSEvents watch keep their semantics: the root
    // classifier runs only with dropPreStartEvents.
    const name = path.basename(root);
    watcher = startWriteJournal(root, journalPath, {
      snapshotDir: path.join(journalDir, 'snaps'), dropPreStartEvents: false, perDirectory: false,
    });
    expect(watcher).not.toBeNull();
    await sleep(300);
    fs.writeFileSync(path.join(root, name), 'same name as the root\n');
    await sleep(1200);
    const records = fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { f?: string; g?: number }).filter((r) => r.f === name);
    expect(records.length).toBeGreaterThan(0);
    // A write, not a delete (`g` marks a delete on disk).
    expect(records.some((r) => !r.g)).toBe(true);
  }, 20_000);

  it('untouchedSinceStart reads ctime, so a back-dated mtime does not hide a write', () => {
    const f = path.join(root, 'backdated.txt');
    fs.writeFileSync(f, 'x');
    // `cp -p`, `tar x`, `touch -d`: an old mtime on a file written just now.
    fs.utimesSync(f, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const st = fs.statSync(f);
    // A start a millisecond before the write: the mtime is older, the ctime is not.
    const startedAt = Math.floor(st.ctimeMs) - 1;
    expect(st.mtimeMs).toBeLessThan(startedAt);
    expect(untouchedSinceStart(st, startedAt)).toBe(false);
    expect(untouchedSinceStart(st, st.ctimeMs + 1)).toBe(true);
  });
});

describe('untouchedSinceStart — the start boundary', () => {
  const at = 1_760_000_000_123;
  it('a ctime before the start, or in the same millisecond, is not the turn\'s write', () => {
    expect(untouchedSinceStart({ ctimeMs: at - 1 }, at)).toBe(true);
    expect(untouchedSinceStart({ ctimeMs: at - 0.25 }, at)).toBe(true);
    // Equal: the order of the write and the start cannot be told — drop it.
    expect(untouchedSinceStart({ ctimeMs: at }, at)).toBe(true);
    // startedAt is Date.now(), cut down to the millisecond; ctime is not. The
    // macOS flake: a setup write at …029.022 against a start stamped …029.
    expect(untouchedSinceStart({ ctimeMs: at + 0.022 }, at)).toBe(true);
    expect(untouchedSinceStart({ ctimeMs: at + 0.999 }, at)).toBe(true);
  });

  it('a ctime from a later millisecond is a write after the start', () => {
    expect(untouchedSinceStart({ ctimeMs: at + 1 }, at)).toBe(false);
    expect(untouchedSinceStart({ ctimeMs: at + 1.001 }, at)).toBe(false);
  });

  it('an unreadable ctime proves nothing either way', () => {
    expect(untouchedSinceStart({ ctimeMs: Number.NaN }, at)).toBe(false);
  });
});

describe('isWatchedRootEvent — the root directory\'s own notification', () => {
  for (const root of ['/tmp/jpre-tree-abc123', '/Users/dev/projects/origin', '/var/folders/x/T/some repo']) {
    const parent = path.dirname(root);
    const name = path.basename(root);

    it(`names the root ${root}`, () => {
      expect(isWatchedRootEvent('.', root)).toBe(true);
      expect(isWatchedRootEvent('', root)).toBe(true);
      expect(isWatchedRootEvent(root, root)).toBe(true);
      expect(isWatchedRootEvent(`${root}/`, root)).toBe(true);
      expect(isWatchedRootEvent(name, root)).toBe(true);
    });

    it(`does not name anything else under or beside ${root}`, () => {
      expect(isWatchedRootEvent('package.json', root)).toBe(false);
      expect(isWatchedRootEvent('pkg/package.json', root)).toBe(false);
      expect(isWatchedRootEvent(`${name}/file.txt`, root)).toBe(false);
      expect(isWatchedRootEvent(path.join(root, 'file.txt'), root)).toBe(false);
      // A neighbouring repository, and names that only share a prefix.
      expect(isWatchedRootEvent(path.join(parent, `${name}-2`), root)).toBe(false);
      expect(isWatchedRootEvent(`${name}-2`, root)).toBe(false);
      expect(isWatchedRootEvent(name.slice(0, -1), root)).toBe(false);
      expect(isWatchedRootEvent(parent, root)).toBe(false);
    });
  }
});
