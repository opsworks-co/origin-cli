// Real fs.watch against a real directory. The journal is the only evidence
// path available to agents with no hooks (Codex, Devin, Copilot), so it has to
// work on every platform CI runs — and to stay quiet in a repo where git is
// busy, which is what the .git exclusion is for.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  startWriteJournal, readJournal, isJournalIgnored, compactJournal, DEBOUNCE_MS,
} from '../write-journal-watch.js';
import { filesWrittenDuring } from '../write-journal.js';

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

describe('isJournalIgnored', () => {
  it('excludes .git, which every git command rewrites', () => {
    // Without this a single commit floods the journal and buries real writes.
    for (const p of ['.git', '.git/index', '.git/refs/heads/main', 'sub/.git/HEAD']) {
      expect(isJournalIgnored(p), p).toBe(true);
    }
  });

  it('excludes build churn and Origin\'s own managed files', () => {
    expect(isJournalIgnored('node_modules/x/index.js')).toBe(true);
    expect(isJournalIgnored('CLAUDE.md')).toBe(true);
    expect(isJournalIgnored('AGENTS.md')).toBe(true);
  });

  it('keeps ordinary source files', () => {
    for (const p of ['src/a.ts', 'README.md', 'apps/web/src/App.tsx']) {
      expect(isJournalIgnored(p), p).toBe(false);
    }
  });

  it('treats an empty path as ignorable rather than crashing', () => {
    expect(isJournalIgnored('')).toBe(true);
  });
});

describe('startWriteJournal', () => {
  let dir: string; let journal: string;
  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wj-')));
    journal = path.join(dir, '.origin-journal');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('records a write, with a timestamp inside the turn', async () => {
    const w = startWriteJournal(dir, journal);
    if (!w) return; // platform without recursive watch — window remains the path
    const startedAt = Date.now();
    await settle(150);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x\n');
    await settle();
    w.stop();

    const recs = readJournal(journal);
    expect(recs.map((r) => r.file)).toContain('a.ts');
    expect(filesWrittenDuring(recs, { startedAt })).toContain('a.ts');
  });

  it('records a write in a SUBDIRECTORY (recursive watching is the point)', async () => {
    const w = startWriteJournal(dir, journal);
    if (!w) return;
    await settle(150);
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'deep', 'b.ts'), 'y\n');
    await settle();
    w.stop();
    expect(readJournal(journal).map((r) => r.file)).toContain('src/deep/b.ts');
  });

  it('does NOT record ignored paths', async () => {
    const w = startWriteJournal(dir, journal);
    if (!w) return;
    await settle(150);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'index'), 'gitstuff\n');
    fs.writeFileSync(path.join(dir, 'real.ts'), 'z\n');
    await settle();
    w.stop();
    const files = readJournal(journal).map((r) => r.file);
    expect(files).toContain('real.ts');
    expect(files.some((f) => f.startsWith('.git'))).toBe(false);
  });

  it('debounces a burst on one file', async () => {
    const w = startWriteJournal(dir, journal);
    if (!w) return;
    await settle(150);
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, 'burst.ts'), `v${i}\n`);
    await settle();
    w.stop();
    const hits = readJournal(journal).filter((r) => r.file === 'burst.ts');
    // A burst inside the debounce window collapses; the file is recorded, not
    // recorded eight times.
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.length).toBeLessThan(8);
    expect(DEBOUNCE_MS).toBeGreaterThan(0);
  });

  it('stops cleanly and records nothing afterwards', async () => {
    const w = startWriteJournal(dir, journal);
    if (!w) return;
    await settle(150);
    w.stop();
    fs.writeFileSync(path.join(dir, 'after-stop.ts'), 'q\n');
    await settle();
    expect(readJournal(journal).map((r) => r.file)).not.toContain('after-stop.ts');
  });

  it('survives a missing journal and a bad repo path', () => {
    expect(readJournal(path.join(dir, 'nope.jsonl'))).toEqual([]);
    expect(startWriteJournal('', journal)).toBeNull();
    expect(startWriteJournal(dir, '')).toBeNull();
  });

  it('compacts away records older than the retention window', async () => {
    fs.writeFileSync(journal, [
      JSON.stringify({ f: 'ancient.ts', t: 1 }),
      JSON.stringify({ f: 'fresh.ts', t: Date.now() }),
    ].join('\n') + '\n');
    compactJournal(journal);
    const files = readJournal(journal).map((r) => r.file);
    expect(files).toEqual(['fresh.ts']);
  });
});

// Prod vodka 944f7048, commit 0fcb7076: two appends to README.md inside one
// command, milliseconds apart. The first event was snapshotted mid-way and the
// second fell inside the debounce window and was DROPPED, so the journal held
// 62 lines for a turn that committed 68 — and the six surfaced on the next
// turn. The debounce must be trailing: the burst's LAST state is recorded.
describe('a burst ends with its last state recorded', () => {
  let dir: string; let journal: string; let snapshots: string;
  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-wj-burst-')));
    journal = path.join(dir, '.origin-journal');
    snapshots = path.join(dir, '.origin-snapshots');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('records the final content of a file written twice within the debounce window', async () => {
    const w = startWriteJournal(dir, journal, { snapshotDir: snapshots });
    if (!w) return;
    await settle(150);
    fs.writeFileSync(path.join(dir, 'README.md'), 'a\nb\nc\n');
    await settle(20); // inside DEBOUNCE_MS
    fs.writeFileSync(path.join(dir, 'README.md'), 'a\nb\nc\nd\ne\nf\n');
    await settle(DEBOUNCE_MS + 400);
    w.stop();
    const hits = readJournal(journal).filter((r) => r.file === 'README.md');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const last = hits[hits.length - 1];
    expect(last.size, 'the burst\'s last write was dropped by the debounce').toBe(Buffer.byteLength('a\nb\nc\nd\ne\nf\n'));
  });
});
