/**
 * The per-directory recursive watch the write journal uses on Linux.
 *
 * Node 20's `fs.watch(recursive)` on Linux watches each FILE by inode, so a
 * file git replaced (checkout, rebase, reset) went silent for good, and its
 * unref() released nothing, so `transcript-watch --once` never exited. These
 * pin the two properties the journal needs from its replacement, on every
 * POSIX platform — nothing here is Linux-specific except the reason it exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { watchDirTree } from '../dir-tree-watch.js';
import { startWriteJournal } from '../write-journal-watch.js';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_MODULE = path.join(cliRoot, 'dist', 'dir-tree-watch.js');

let root: string;
const seen: string[] = [];

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-dirtree-')));
  seen.length = 0;
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

/** macOS's watch (FSEvents) can drop a change made the instant it starts; on
 *  Linux inotify is armed synchronously. Let it settle before the first write. */
const settle = () => new Promise((r) => setTimeout(r, 300));

/** Re-write `file` every 200 ms until the watcher reports it (an event at the
 *  instant a watch starts can be dropped on macOS), or give up after 10 s. */
async function writeUntilSeen(file: string, write: () => void): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  let next = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= next) { write(); next = Date.now() + 200; }
    if (seen.includes(file)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe.skipIf(process.platform === 'win32')('watchDirTree', () => {
  it('keeps reporting a file after it is replaced by a rename, the way git writes', async () => {
    fs.writeFileSync(path.join(root, 'viewer.py'), 'old\n');
    const w = watchDirTree(root, {}, (_e, rel) => seen.push(rel));
    try {
      // git checkout: write a new file, rename it over the old one (new inode).
      await settle();
      fs.writeFileSync(path.join(root, 'viewer.py.tmp'), 'from main\n');
      fs.renameSync(path.join(root, 'viewer.py.tmp'), path.join(root, 'viewer.py'));
      await settle();
      seen.length = 0;
      // The edit after it, in place — what the inode watch never saw.
      expect(await writeUntilSeen('viewer.py', () => fs.writeFileSync(path.join(root, 'viewer.py'), `edited ${Date.now()}\n`))).toBe(true);
    } finally { w.close(); }
  });

  it('reports files in a directory created after the watch began', async () => {
    const w = watchDirTree(root, {}, (_e, rel) => seen.push(rel));
    try {
      await settle();
      const rel = path.join('src', 'deep', 'mod.ts');
      expect(await writeUntilSeen(rel, () => {
        fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
        fs.writeFileSync(path.join(root, rel), `export const x = ${Date.now()};\n`);
      })).toBe(true);
    } finally { w.close(); }
  });

  it('does not watch a directory skipDir rules out', async () => {
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    const w = watchDirTree(root, { skipDir: (rel) => rel.split(path.sep)[0] === 'node_modules' }, (_e, rel) => seen.push(rel));
    try {
      await settle();
      fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x\n');
      // A write outside it, to know events are flowing at all.
      expect(await writeUntilSeen('app.ts', () => fs.writeFileSync(path.join(root, 'app.ts'), `${Date.now()}\n`))).toBe(true);
      // The root may report the directory's own name; nothing inside it.
      expect(seen.filter((f) => f.startsWith(`node_modules${path.sep}`))).toEqual([]);
    } finally { w.close(); }
  });

  it.skipIf(!fs.existsSync(DIST_MODULE))('lets its process exit once unref\'d — no close() needed', () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const script = `import { watchDirTree } from ${JSON.stringify(DIST_MODULE)};
      const w = watchDirTree(${JSON.stringify(root)}, { persistent: true }, () => {});
      w.unref();`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8', timeout: 15_000 });
    expect(r.error, 'the process did not exit by itself').toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
  });

  it('a journal watching per directory records an edit to a file git replaced', async () => {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-dirtree-journal-'));
    const journal = path.join(journalDir, 'j.jsonl');
    fs.writeFileSync(path.join(root, 'viewer.py'), 'old\n');
    const j = startWriteJournal(root, journal, { perDirectory: true });
    expect(j).not.toBeNull();
    try {
      fs.writeFileSync(path.join(root, 'viewer.py.tmp'), 'from main\n');
      fs.renameSync(path.join(root, 'viewer.py.tmp'), path.join(root, 'viewer.py'));
      await new Promise((r) => setTimeout(r, 400));
      const before = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf-8').split('\n').length : 0;
      const deadline = Date.now() + 10_000;
      let after = '';
      while (Date.now() < deadline) {
        fs.writeFileSync(path.join(root, 'viewer.py'), `FRAME = "full" ${Date.now()}\n`);
        await new Promise((r) => setTimeout(r, 400));
        after = fs.readFileSync(journal, 'utf-8').split('\n').slice(Math.max(0, before - 1)).join('\n');
        if (after.includes('"viewer.py"')) break;
      }
      expect(after).toContain('"viewer.py"');
    } finally {
      j?.stop();
      fs.rmSync(journalDir, { recursive: true, force: true });
    }
  });
});
