// Stage 1 of the capture rewrite: the write journal as a content ledger.
//
// The three properties worth proving, in order of how much they matter:
//
//   1. A turn's before-state is its predecessor's after-state, so a turn CANNOT
//      inherit its predecessor's work. That is the cumulative-diff defect stage
//      0 measured (124 hits), made structurally impossible rather than patched.
//   2. A generated diff round-trips: `git apply` it to the before-content and
//      you get the after-content, byte for byte. This is the property the
//      existing pipeline cannot state about its own output.
//   3. A generated diff passes `capture-verify`, the stage 0 gate. The two
//      halves of the rewrite check each other.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  serializeRecord, serializeTurnMark, parseJournalEntries, parseJournal,
  turnSpan, writesForTurn, turnFileChanges, turnIdsInJournal,
  type WriteRecord, type JournalEntry,
} from '../write-journal.js';
import {
  putSnapshot, getSnapshot, hasSnapshot, snapshotFile, hashContent, looksBinary,
  storeBytes, dropStore, snapshotPath,
} from '../write-journal-store.js';
import {
  splitLines, diffLines, renderFileDiff, renderTurnDiff, groupHunks,
} from '../write-journal-diff.js';
import { parseUnifiedDiff, verifyTurn } from '../capture-verify.js';
import {
  startWriteJournal, markTurn, readJournalEntries, compactJournal, DEBOUNCE_MS,
  isAtomicWriteTemp, isJournalIgnored,
} from '../write-journal-watch.js';

let tmp = '';
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-ledger-')); });
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const scratch = (name: string): string => {
  const d = path.join(tmp, name + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const w = (file: string, at: number, hash?: string, extra: Partial<WriteRecord> = {}): string =>
  serializeRecord({ file, at, ...(hash ? { hash, retained: true } : {}), ...extra });
const t = (id: string, at: number): string => serializeTurnMark({ at, turnId: id });

// ─── the log format ─────────────────────────────────────────────────────────

describe('journal format', () => {
  it('round-trips writes and turn marks in order', () => {
    const log = t('T1', 100) + w('a.ts', 101, 'h1') + t('T2', 200) + w('b.ts', 201, 'h2');
    const e = parseJournalEntries(log);
    expect(e.map((x) => x.kind)).toEqual(['turn', 'write', 'turn', 'write']);
    expect(turnIdsInJournal(e)).toEqual(['T1', 'T2']);
  });

  it('keeps parsing journals written before content recording existed', () => {
    // Old records are exactly {"f":..,"t":..} and must not become unreadable.
    const old = '{"f":"a.ts","t":5}\n{"f":"b.ts","t":6}\n';
    expect(parseJournal(old)).toEqual([{ file: 'a.ts', at: 5 }, { file: 'b.ts', at: 6 }]);
  });

  it('omits optional fields so an extra-less record stays byte-identical', () => {
    expect(serializeRecord({ file: 'a.ts', at: 5 })).toBe('{"f":"a.ts","t":5}\n');
  });

  it('skips a torn final line rather than failing the whole read', () => {
    const log = w('a.ts', 1, 'h1') + '{"f":"b.ts","t":';
    expect(parseJournalEntries(log)).toHaveLength(1);
  });

  it('parseJournal ignores turn marks, so existing callers are unaffected', () => {
    expect(parseJournal(t('T1', 1) + w('a.ts', 2)).map((r) => r.file)).toEqual(['a.ts']);
  });
});

// ─── attribution by position, not time ──────────────────────────────────────

describe('turn spans', () => {
  const log = t('T1', 100) + w('a.ts', 101, 'h1') + w('b.ts', 102, 'h2')
            + t('T2', 200) + w('a.ts', 201, 'h3');

  it('assigns a write to the turn whose mark precedes it', () => {
    expect(writesForTurn(parseJournalEntries(log), 'T1').map((r) => r.file)).toEqual(['a.ts', 'b.ts']);
    expect(writesForTurn(parseJournalEntries(log), 'T2').map((r) => r.file)).toEqual(['a.ts']);
  });

  it('does not use timestamps — a clock that goes backwards changes nothing', () => {
    // The write is stamped BEFORE its own turn mark. Position still decides.
    const skewed = t('T1', 100) + t('T2', 200) + w('a.ts', 1, 'h1');
    expect(writesForTurn(parseJournalEntries(skewed), 'T2').map((r) => r.file)).toEqual(['a.ts']);
    expect(writesForTurn(parseJournalEntries(skewed), 'T1')).toEqual([]);
  });

  it('returns null for a turn that was never marked, so the caller can fall back', () => {
    expect(turnSpan(parseJournalEntries(log), 'nope')).toBeNull();
    expect(writesForTurn(parseJournalEntries(log), 'nope')).toEqual([]);
  });

  it('honours the LAST mark when a turn is marked twice', () => {
    // A re-fired hook re-declares where the turn starts; the earlier writes
    // were disowned on purpose.
    const remarked = t('T1', 100) + w('a.ts', 101, 'h1') + t('T1', 150) + w('b.ts', 151, 'h2');
    expect(writesForTurn(parseJournalEntries(remarked), 'T1').map((r) => r.file)).toEqual(['b.ts']);
  });

  it('gives the running turn everything after its mark', () => {
    const live = t('T1', 100) + w('a.ts', 101, 'h1') + w('b.ts', 999, 'h2');
    expect(writesForTurn(parseJournalEntries(live), 'T1')).toHaveLength(2);
  });
});

describe('turnFileChanges', () => {
  it('takes its before-state from the previous turn\'s after-state', () => {
    const log = t('T1', 100) + w('a.ts', 101, 'h1') + t('T2', 200) + w('a.ts', 201, 'h2');
    const e = parseJournalEntries(log);
    expect(turnFileChanges(e, 'T1')[0]).toMatchObject({ file: 'a.ts', beforeHash: null, afterHash: 'h1' });
    expect(turnFileChanges(e, 'T2')[0]).toMatchObject({ file: 'a.ts', beforeHash: 'h1', afterHash: 'h2' });
  });

  it('makes the cumulative-diff defect structurally impossible', () => {
    // Stage 0's worked example: turn 4 re-contained turn 1's change byte for
    // byte because its baseline never advanced. Here turn 3's before-state IS
    // turn 2's after-state, so no turn can re-report a predecessor's work.
    const log = t('T1', 10) + w('a.ts', 11, 'v1')
              + t('T2', 20) + w('a.ts', 21, 'v2')
              + t('T3', 30) + w('a.ts', 31, 'v3');
    const e = parseJournalEntries(log);
    const spans = ['T1', 'T2', 'T3'].map((id) => turnFileChanges(e, id)[0]);
    expect(spans.map((s) => [s.beforeHash, s.afterHash]))
      .toEqual([[null, 'v1'], ['v1', 'v2'], ['v2', 'v3']]);
    // Every turn's after-state is the next turn's before-state — no overlap.
    for (let i = 1; i < spans.length; i++) expect(spans[i].beforeHash).toBe(spans[i - 1].afterHash);
  });

  it('collapses churn to one entry but records how often the file was written', () => {
    const log = t('T1', 10) + w('a.ts', 11, 'v1') + w('a.ts', 12, 'v2') + w('a.ts', 13, 'v3');
    const c = turnFileChanges(parseJournalEntries(log), 'T1');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ afterHash: 'v3', writes: 3 });
  });

  it('reports a net-zero turn as before === after rather than hiding it', () => {
    const log = t('T1', 10) + w('a.ts', 11, 'v1')
              + t('T2', 20) + w('a.ts', 21, 'v2') + w('a.ts', 22, 'v1');
    const c = turnFileChanges(parseJournalEntries(log), 'T2')[0];
    expect(c.beforeHash).toBe('v1');
    expect(c.afterHash).toBe('v1');
  });

  it('records a delete as a delete, not as a write of empty content', () => {
    const log = t('T1', 10) + w('a.ts', 11, 'v1') + t('T2', 20) + w('a.ts', 21, undefined, { gone: true });
    const c = turnFileChanges(parseJournalEntries(log), 'T2')[0];
    expect(c).toMatchObject({ deleted: true, afterHash: null, beforeHash: 'v1' });
  });

  it('leaves beforeHash null for a file first written this turn', () => {
    // "Unknown here", to be resolved from git — not "the file was empty".
    const log = t('T1', 10) + w('new.ts', 11, 'v1');
    expect(turnFileChanges(parseJournalEntries(log), 'T1')[0].beforeHash).toBeNull();
  });
});

// ─── the snapshot store ─────────────────────────────────────────────────────

describe('snapshot store', () => {
  it('stores and returns content by hash', () => {
    const d = scratch('store');
    const r = putSnapshot(d, 'hello\n');
    expect(r.outcome).toBe('stored');
    expect(r.retained).toBe(true);
    expect(getSnapshot(d, r.hash)).toBe('hello\n');
    expect(hasSnapshot(d, r.hash)).toBe(true);
  });

  it('dedupes identical content', () => {
    const d = scratch('dedupe');
    const a = putSnapshot(d, 'same');
    const b = putSnapshot(d, 'same');
    expect(a.hash).toBe(b.hash);
    expect(b.outcome).toBe('deduped');
    expect(storeBytes(d)).toBe(Buffer.from('same').length);
  });

  it('keeps the hash when content is too large to retain — never a silent drop', () => {
    const d = scratch('big');
    const r = putSnapshot(d, 'x'.repeat(1000), { maxBytes: 100 });
    expect(r.outcome).toBe('oversize');
    expect(r.retained).toBe(false);
    expect(r.hash).toBe(hashContent('x'.repeat(1000)));  // still know WHICH state
    expect(r.size).toBe(1000);                            // still know how big
    expect(getSnapshot(d, r.hash)).toBeNull();
  });

  it('refuses new content once the store is full, rather than evicting', () => {
    const d = scratch('full');
    const r = putSnapshot(d, 'abcdef', { maxStoreBytes: 3, currentStoreBytes: 0 });
    expect(r.outcome).toBe('store_full');
    expect(r.retained).toBe(false);
    expect(r.hash).toBeTruthy();
  });

  it('hashes binary content but does not retain it', () => {
    const d = scratch('bin');
    const r = putSnapshot(d, Buffer.from([0x00, 0x01, 0x02]));
    expect(r.binary).toBe(true);
    expect(r.outcome).toBe('binary');
    expect(r.retained).toBe(false);
  });

  it('detects binary by NUL byte, like git', () => {
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
  });

  it('snapshots a real file and returns null for one that is gone', () => {
    const d = scratch('file');
    const f = path.join(d, 'x.txt');
    fs.writeFileSync(f, 'content\n');
    expect(getSnapshot(d, snapshotFile(d, f)?.hash)).toBe('content\n');
    expect(snapshotFile(d, path.join(d, 'missing.txt'))).toBeNull();
  });

  it('checks size before reading, so a huge file is never loaded to be rejected', () => {
    const d = scratch('huge');
    const f = path.join(d, 'big.bin');
    fs.writeFileSync(f, 'y'.repeat(5000));
    const r = snapshotFile(d, f, { maxBytes: 100 });
    expect(r?.outcome).toBe('oversize');
    expect(r?.size).toBe(5000);
  });

  it('shards by hash prefix', () => {
    const d = scratch('shard');
    const r = putSnapshot(d, 'abc');
    expect(snapshotPath(d, r.hash)).toBe(path.join(d, r.hash.slice(0, 2), r.hash.slice(2)));
  });

  it('drops the whole store', () => {
    const d = scratch('drop');
    putSnapshot(d, 'x');
    dropStore(d);
    expect(fs.existsSync(d)).toBe(false);
  });

  it('never throws on an unwritable directory', () => {
    // The unwritable path is a directory whose PARENT is a regular file, so
    // every write beneath it fails with ENOTDIR — instantly, identically, on
    // every platform, and without touching anything outside this test's tmp
    // dir.
    //
    // This used to be `/proc/nonexistent/nope`, and that one line hung CI for a
    // day. `putSnapshot` reaches `fs.mkdirSync(dir, { recursive: true })`, and
    // on Linux **recursive mkdirSync under /proc never returns** — measured on
    // the runner: `existsSync` 0ms, `readdirSync` 0ms/ENOENT, `mkdirSync` still
    // going when the 120s probe was killed.
    //
    // It blocks SYNCHRONOUSLY, which is what made it so hard to see. Vitest's
    // 30s testTimeout is a timer, and a frozen event loop never fires it — so
    // the test did not fail, the file never completed, the whole workspace run
    // hung, and with no `timeout-minutes` the job ran to GitHub's 360-minute
    // default. macOS has no /proc, so it was green there throughout.
    //
    // Keep this off /proc, and off any other kernel-backed filesystem: the
    // point is an ordinary path that cannot be written, not an exotic one.
    const blocker = path.join(scratch('unwritable'), 'i-am-a-file');
    fs.writeFileSync(blocker, 'not a directory\n');
    expect(() => putSnapshot(path.join(blocker, 'nope'), 'x')).not.toThrow();
    expect(getSnapshot(path.join(blocker, 'nope'), 'deadbeef')).toBeNull();
  });
});

// ─── diff generation ────────────────────────────────────────────────────────

describe('splitLines', () => {
  it('treats a trailing newline as a terminator, not an empty last line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
  });
});

describe('diffLines', () => {
  it('finds a minimal script', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(ops?.filter((o) => o.kind === 'del').map((o) => o.line)).toEqual(['b']);
    expect(ops?.filter((o) => o.kind === 'ins').map((o) => o.line)).toEqual(['x']);
  });

  it('returns null past the budget instead of an approximate answer', () => {
    const a = Array.from({ length: 200 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 200 }, (_, i) => `b${i}`);
    expect(diffLines(a, b, 4)).toBeNull();
  });

  it('handles empty sides', () => {
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines([], ['x'])?.map((o) => o.kind)).toEqual(['ins']);
    expect(diffLines(['x'], [])?.map((o) => o.kind)).toEqual(['del']);
  });
});

describe('renderFileDiff', () => {
  it('emits nothing when content is unchanged', () => {
    expect(renderFileDiff({ file: 'a.ts', before: 'x\n', after: 'x\n' })).toBe('');
  });

  it('marks a creation with /dev/null and no removals', () => {
    const d = renderFileDiff({ file: 'n.ts', before: null, after: 'a\nb\n' });
    expect(d).toContain('new file mode');
    expect(d).toContain('--- /dev/null');
    const p = parseUnifiedDiff(d);
    expect(p.malformed).toEqual([]);
    expect(p.files[0]).toMatchObject({ isNew: true, added: 2, removed: 0 });
  });

  it('marks a deletion', () => {
    const d = renderFileDiff({ file: 'g.ts', before: 'a\n', after: null });
    expect(d).toContain('+++ /dev/null');
    expect(parseUnifiedDiff(d).files[0]).toMatchObject({ added: 0, removed: 1 });
  });

  it('emits one section per file even if asked twice', () => {
    const out = renderTurnDiff([
      { file: 'a.ts', before: 'x\n', after: 'y\n' },
      { file: 'a.ts', before: 'y\n', after: 'z\n' },
    ]);
    expect(parseUnifiedDiff(out).duplicateFiles).toEqual([]);
  });

  it('produces hunk headers whose counts match their bodies', () => {
    // The single most common corruption in stored captures.
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const after = before.replace('line 20', 'CHANGED').replace('line 5', 'ALSO');
    const p = parseUnifiedDiff(renderFileDiff({ file: 'f.txt', before, after }));
    expect(p.malformed).toEqual([]);
  });
});

// ─── the properties that matter ─────────────────────────────────────────────

describe('generated diffs are real diffs', () => {
  let dir = '';
  let haveGit = true;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-apply-'));
    try { execFileSync('git', ['--version'], { cwd: dir, stdio: 'pipe' }); } catch { haveGit = false; }
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  /**
   * Apply a generated diff to `before` with git and return the result.
   *
   * Run in a throwaway repo-less directory: `git apply` invoked from inside a
   * repository silently ignores paths outside the cwd (see capture-verify's
   * test for the full story), which would make a broken patch look applied.
   */
  const applied = (file: string, before: string | null, diff: string): string | null => {
    const work = fs.mkdtempSync(path.join(dir, 'w-'));
    if (before !== null) {
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.writeFileSync(path.join(work, file), before);
    }
    try {
      execFileSync('git', ['apply', '--unsafe-paths', '-'], {
        cwd: work, input: diff, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      throw new Error(`git refused the generated patch: ${String((e as { stderr?: Buffer }).stderr ?? e)}`);
    }
    const out = path.join(work, file);
    return fs.existsSync(out) ? fs.readFileSync(out, 'utf-8') : null;
  };

  const CASES: Array<[string, string | null, string | null]> = [
    ['single line change', 'a\nb\nc\n', 'a\nX\nc\n'],
    ['append', 'a\n', 'a\nb\n'],
    ['prepend', 'b\n', 'a\nb\n'],
    ['delete lines', 'a\nb\nc\n', 'a\n'],
    ['create', null, 'new\ncontent\n'],
    ['delete file', 'gone\n', null],
    ['two distant edits', Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n') + '\n',
      Array.from({ length: 60 }, (_, i) => (i === 3 ? 'A' : i === 50 ? 'B' : `l${i}`)).join('\n') + '\n'],
    ['adjacent edits merge into one hunk', 'a\nb\nc\nd\n', 'a\nX\nY\nd\n'],
    ['empty file to content', '', 'x\n'],
    ['no trailing newline', 'a\nb', 'a\nc'],
    ['drop the trailing newline only', 'a\nb\n', 'a\nb'],
    ['add a trailing newline only', 'a\nb', 'a\nb\n'],
    ['gain content and lose the newline', 'a\n', 'a\nb'],
    ['whitespace-only change', 'a\n  b\n', 'a\n\tb\n'],
    ['unicode', 'héllo\n🎉\n', 'héllo\n🎊\n'],
  ];

  for (const [name, before, after] of CASES) {
    it(`round-trips through git apply: ${name}`, () => {
      if (!haveGit) return;
      const diff = renderFileDiff({ file: 'src/f.txt', before, after });
      if (before === after) { expect(diff).toBe(''); return; }
      expect(diff, 'a real change must produce a diff').not.toBe('');
      expect(applied('src/f.txt', before, diff)).toBe(after);
    });

    it(`passes capture-verify: ${name}`, () => {
      const diff = renderFileDiff({ file: 'src/f.txt', before, after });
      if (!diff) return;
      expect(parseUnifiedDiff(diff).malformed).toEqual([]);
      // A row built from this diff must not contradict itself.
      expect(verifyTurn({ promptIndex: 0, filesChanged: ['src/f.txt'], diff })).toEqual([]);
    });
  }

  it('round-trips a whole turn of several files', () => {
    if (!haveGit) return;
    const files = [
      { file: 'a.txt', before: '1\n2\n', after: '1\nX\n' },
      { file: 'b.txt', before: null, after: 'new\n' },
      { file: 'c.txt', before: 'bye\n', after: null },
    ];
    const diff = renderTurnDiff(files);
    expect(parseUnifiedDiff(diff).malformed).toEqual([]);
    expect(verifyTurn({
      promptIndex: 0,
      filesChanged: files.map((f) => f.file),
      diff,
    })).toEqual([]);
    for (const f of files) {
      expect(applied(f.file, f.before, renderFileDiff(f))).toBe(f.after);
    }
  });

  it('degrades a diff past the budget to a whole-file replacement that still applies', () => {
    if (!haveGit) return;
    const before = Array.from({ length: 400 }, (_, i) => `old${i}`).join('\n') + '\n';
    const after = Array.from({ length: 400 }, (_, i) => `new${i}`).join('\n') + '\n';
    // Force the fallback by shrinking the budget through a tiny direct call.
    expect(diffLines(splitLines(before), splitLines(after), 4)).toBeNull();
    const diff = renderFileDiff({ file: 'src/f.txt', before, after });
    expect(parseUnifiedDiff(diff).malformed).toEqual([]);
    expect(applied('src/f.txt', before, diff)).toBe(after);
  });
});

// ─── end to end ─────────────────────────────────────────────────────────────

describe('journal to diff, end to end', () => {
  it('renders each turn only its own work', () => {
    const store = scratch('e2e');
    const v1 = putSnapshot(store, 'line one\n');
    const v2 = putSnapshot(store, 'line one\nline two\n');
    const v3 = putSnapshot(store, 'line one\nline two\nline three\n');

    const log = serializeTurnMark({ at: 10, turnId: 'T1' })
      + serializeRecord({ file: 'f.txt', at: 11, hash: v1.hash, retained: true })
      + serializeTurnMark({ at: 20, turnId: 'T2' })
      + serializeRecord({ file: 'f.txt', at: 21, hash: v2.hash, retained: true })
      + serializeTurnMark({ at: 30, turnId: 'T3' })
      + serializeRecord({ file: 'f.txt', at: 31, hash: v3.hash, retained: true });

    const entries: JournalEntry[] = parseJournalEntries(log);
    const diffFor = (turnId: string): string => renderTurnDiff(
      turnFileChanges(entries, turnId).map((c) => ({
        file: c.file,
        before: c.beforeHash ? getSnapshot(store, c.beforeHash) : null,
        after: c.afterHash ? getSnapshot(store, c.afterHash) : null,
      })),
    );

    // Each turn added exactly one line, and says so.
    for (const [turnId, added] of [['T1', 1], ['T2', 1], ['T3', 1]] as const) {
      const p = parseUnifiedDiff(diffFor(turnId));
      expect(p.malformed, turnId).toEqual([]);
      expect(p.files[0].added, turnId).toBe(added);
    }
    // And crucially: turn 3 does NOT re-contain turn 1's line.
    expect(diffFor('T3')).not.toContain('+line one');
    expect(diffFor('T2')).not.toContain('+line one');
  });
});

// ─── the live watcher ───────────────────────────────────────────────────────
//
// Everything above tests the pure halves. This drives the REAL watcher against
// a REAL directory with REAL fs events, because a helper that passes in
// isolation proves nothing about whether the feature fires.

describe('live watcher records content and turn marks', () => {
  /**
   * Wait for the watcher to have recorded something, rather than sleeping a
   * fixed interval.
   *
   * fs.watch latency is not bounded, and under a full-suite run (330+ files on
   * a loaded machine) a fixed `sleep(500)` is a coin flip — this test passed
   * alone and failed in the suite exactly once before this was changed. Polling
   * a CONDITION keeps it fast when the machine is idle and correct when it is
   * not.
   */
  const waitFor = async (cond: () => boolean, timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    // Fall through: let the assertion that follows report what was missing.
  };
  /** Writes to one file are debounced, so space successive turns apart. */
  const pastDebounce = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));
  const writesIn = (journal: string): number =>
    readJournalEntries(journal).filter((e) => e.kind === 'write').length;

  /**
   * Wait until the watcher is demonstrably armed, then clear what it recorded.
   *
   * `fs.watch(recursive: true)` is FSEvents on macOS and it does not deliver
   * events for writes that land before it finishes arming — those events are
   * MISSED, not merely late, so no amount of waiting afterwards recovers them.
   * That is a real race in the test, not in the watcher: a session's first
   * write realistically follows watcher start by whole seconds.
   *
   * So: write a throwaway file until one is journalled, then truncate the
   * journal and begin. Costs a few milliseconds when the machine is idle and
   * removes the failure entirely when it is not.
   */
  const armed = async (repo: string, journal: string): Promise<void> => {
    const probe = path.join(repo, '.origin-watch-probe');
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(probe, String(i));
      await new Promise((r) => setTimeout(r, 25));
      if (writesIn(journal) > 0) break;
    }
    try { fs.unlinkSync(probe); } catch { /* already gone */ }
    await pastDebounce();
    fs.writeFileSync(journal, '');
  };

  it('captures a whole session and renders each turn its own diff', async () => {
    const repo = scratch('live-repo');
    const store = scratch('live-store');
    const journal = path.join(scratch('live-journal'), 'j.jsonl');

    const watcher = startWriteJournal(repo, journal, { snapshotDir: store });
    if (!watcher) return; // no recursive watch on this platform
    try {
      const file = path.join(repo, 'app.ts');
      await armed(repo, journal);

      markTurn(journal, 'T1');
      fs.writeFileSync(file, 'const a = 1;\n');
      await waitFor(() => writesIn(journal) >= 1);
      await pastDebounce();

      markTurn(journal, 'T2');
      fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
      await waitFor(() => writesIn(journal) >= 2);
      await pastDebounce();

      markTurn(journal, 'T3');
      fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
      await waitFor(() => writesIn(journal) >= 3);

      const entries = readJournalEntries(journal);
      expect(turnIdsInJournal(entries)).toEqual(['T1', 'T2', 'T3']);

      const diffFor = (turnId: string): string => renderTurnDiff(
        turnFileChanges(entries, turnId).map((c) => ({
          file: c.file,
          before: c.beforeHash ? getSnapshot(store, c.beforeHash) : null,
          after: c.afterHash ? getSnapshot(store, c.afterHash) : null,
        })),
      );

      // Content really was retained by the watcher, not just hashed.
      const t2 = turnFileChanges(entries, 'T2')[0];
      expect(t2, 'turn 2 should have a recorded write').toBeTruthy();
      expect(getSnapshot(store, t2.afterHash)).toBe('const a = 1;\nconst b = 2;\n');

      // Each turn added exactly one line and does not re-report the others.
      const d2 = diffFor('T2');
      const d3 = diffFor('T3');
      expect(parseUnifiedDiff(d2).malformed).toEqual([]);
      expect(parseUnifiedDiff(d3).malformed).toEqual([]);
      expect(d2).toContain('+const b = 2;');
      expect(d2).not.toContain('+const a = 1;');
      expect(d3).toContain('+const c = 3;');
      expect(d3).not.toContain('+const b = 2;');
      expect(parseUnifiedDiff(d3).files[0]).toMatchObject({ added: 1, removed: 0 });
    } finally {
      watcher.stop();
    }
  });

  it('records a delete as a delete', async () => {
    const repo = scratch('live-del');
    const store = scratch('live-del-store');
    const journal = path.join(scratch('live-del-j'), 'j.jsonl');
    const watcher = startWriteJournal(repo, journal, { snapshotDir: store });
    if (!watcher) return;
    try {
      const file = path.join(repo, 'gone.ts');
      await armed(repo, journal);
      markTurn(journal, 'T1');
      fs.writeFileSync(file, 'bye\n');
      await waitFor(() => writesIn(journal) >= 1);
      await pastDebounce();
      markTurn(journal, 'T2');
      fs.unlinkSync(file);
      await waitFor(() => writesIn(journal) >= 2);

      const c = turnFileChanges(readJournalEntries(journal), 'T2')[0];
      expect(c, 'the delete should be journalled').toBeTruthy();
      expect(c.deleted).toBe(true);
      expect(c.afterHash).toBeNull();
    } finally {
      watcher.stop();
    }
  });

  it('compaction keeps turn marks and prunes only unreferenced blobs', async () => {
    const store = scratch('compact-store');
    const journal = path.join(scratch('compact-j'), 'j.jsonl');
    const kept = putSnapshot(store, 'kept\n');
    const orphan = putSnapshot(store, 'orphan\n');
    fs.writeFileSync(journal,
      serializeTurnMark({ at: Date.now(), turnId: 'T1' })
      + serializeRecord({ file: 'a.ts', at: Date.now(), hash: kept.hash, retained: true }));

    compactJournal(journal, Date.now(), store);

    const entries = readJournalEntries(journal);
    expect(turnIdsInJournal(entries), 'turn marks must survive compaction').toEqual(['T1']);
    expect(hasSnapshot(store, kept.hash)).toBe(true);
    expect(hasSnapshot(store, orphan.hash), 'unreferenced blob should be pruned').toBe(false);
  });
});

// ─── regressions found on a real session ────────────────────────────────────
//
// Session ca45d020 was the first captured on this build. Its stored row said
// 5 files where the ledger said 4, and `diffSource` was null on every turn —
// which is how both of these were found.

describe('atomic-write temp files never reach a turn', () => {
  it('ignores the shapes an atomic rename leaves behind', () => {
    // Observed verbatim in that session's journal.
    for (const p of [
      'packages/cli/src/commands/hooks.ts.tmp.4017.a5d6febb3c37',
      '_tmp_14780_986518add3a23ecd52a4d7f54550993f',
      'src/a.ts.abc123def.tmp',
      '.hooks.ts.swp',
    ]) {
      expect(isAtomicWriteTemp(p), `${p} should be ignored`).toBe(true);
      expect(isJournalIgnored(p), `${p} should not reach the journal`).toBe(true);
    }
  });

  it('leaves real files alone, including ones that merely look temporary', () => {
    // A missed temp file is noise in one turn; a wrongly-ignored real file is
    // work that vanishes. This side matters more.
    for (const p of [
      'src/tmp.ts', 'temp/config.json', 'src/template.tsx', 'tmp/handler.py',
      'src/commands/hooks.ts', 'a/b/tmpfile.md', 'src/swap.ts',
    ]) {
      expect(isAtomicWriteTemp(p), `${p} must NOT be treated as temp`).toBe(false);
    }
  });
});
