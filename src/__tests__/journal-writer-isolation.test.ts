import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { once } from 'events';
import { getSnapshot } from '../write-journal-store.js';
import { writesForTurn } from '../write-journal.js';
import { acquireJournalLock } from '../journal-lock.js';
import { markTurn, readJournalEntries, startWriteJournal, type JournalWatcher } from '../write-journal-watch.js';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(dist, name + '.js')).href);
const children: ChildProcess[] = [];
const watchers: JournalWatcher[] = [];
const dirs: string[] = [];
function fixture() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-owner-')));
  dirs.push(dir);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  return { dir, repo, journal: path.join(dir, 'journal.jsonl') };
}
function worker(code: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  children.push(child);
  return child;
}
afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('journal writer isolation', () => {
  it('only one process watches a journal, while another session remains independent', async () => {
    const { repo, journal } = fixture();
    const code = `import { startWriteJournal } from ${moduleUrl('write-journal-watch')};
      const watcher = startWriteJournal(${JSON.stringify(repo)}, ${JSON.stringify(journal)});
      process.send(!!watcher); setInterval(() => {}, 1000);`;
    const first = worker(code);
    expect((await once(first, 'message'))[0]).toBe(true);
    const second = worker(code);
    expect((await once(second, 'message'))[0]).toBe(false);
    expect(startWriteJournal(repo, journal)).toBeNull();
    const other = startWriteJournal(repo, journal + '.other');
    expect(other).not.toBeNull();
    if (other) watchers.push(other);
    const pid = fs.readFileSync(journal.replace('.jsonl', '.lock'), 'utf8');
    expect(pid).toBe(String(first.pid));
  });

  it('a turn append waits for compaction rather than being erased by its replacement', async () => {
    const { journal } = fixture();
    markTurn(journal, 'before');
    const child = worker(`import fs from 'fs';
      import { mutateJournal } from ${moduleUrl('journal-lock')};
      const journal = ${JSON.stringify(journal)};
      mutateJournal(journal, () => {
        const text = fs.readFileSync(journal, 'utf8');
        process.send('read');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        fs.writeFileSync(journal, text);
      }); process.disconnect();`);
    await once(child, 'message');
    markTurn(journal, 'after');
    expect(readJournalEntries(journal).filter(e => e.kind === 'turn').map(e => e.turnId)).toEqual(['before', 'after']);
  });

  it('concurrent compaction preserves every appended boundary and fence', async () => {
    const { journal, dir } = fixture();
    const snapshots = path.join(dir, 'snapshots');
    markTurn(journal, 'initial');
    const writer = worker(`import fs from 'fs';
      import { markTurn, fenceJournal } from ${moduleUrl('write-journal-watch')};
      import { mutateJournal } from ${moduleUrl('journal-lock')};
      import { putSnapshot } from ${moduleUrl('write-journal-store')};
      import { serializeRecord } from ${moduleUrl('write-journal')};
      process.on('message', () => {
        for (let i = 0; i < 100; i++) {
          markTurn(${JSON.stringify(journal)}, 't' + i);
          mutateJournal(${JSON.stringify(journal)}, () => {
            const put = putSnapshot(${JSON.stringify(snapshots)}, 'content-' + i);
            fs.appendFileSync(${JSON.stringify(journal)}, serializeRecord({ file: 'file-' + i, at: Date.now(), hash: put.hash, retained: true }));
          });
          fenceJournal(${JSON.stringify(journal)});
        }
        process.disconnect();
      }); process.send('ready');`);
    await once(writer, 'message');
    const compactor = worker(`import { compactJournal } from ${moduleUrl('write-journal-watch')};
      process.on('message', () => { for (let i = 0; i < 100; i++) compactJournal(${JSON.stringify(journal)}, Date.now(), ${JSON.stringify(snapshots)}); process.disconnect(); });
      process.send('ready');`);
    await once(compactor, 'message');
    const exits = Promise.all([once(writer, 'exit'), once(compactor, 'exit')]);
    writer.send('go'); compactor.send('go');
    expect(await exits).toEqual([[0, null], [0, null]]);
    const entries = readJournalEntries(journal);
    expect(entries.filter(e => e.kind === 'turn')).toHaveLength(101);
    expect(entries.filter(e => e.kind === 'fence')).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      const writes = writesForTurn(entries, 't' + i);
      expect(writes.map(write => write.file)).toEqual(['file-' + i]);
      expect(getSnapshot(snapshots, writes[0].hash)).toBe('content-' + i);
    }
    expect(fs.existsSync(journal + '.contended')).toBe(false);
  });

  it('recovers a dead process lease without waiting for a heartbeat timeout', async () => {
    const { dir } = fixture();
    const lockPath = path.join(dir, 'lease');
    const child = worker(`import { acquireJournalLock } from ${moduleUrl('journal-lock')};
      acquireJournalLock(${JSON.stringify(lockPath)});
      process.send('owned'); setInterval(() => {}, 1000);`);
    await once(child, 'message');
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    const next = acquireJournalLock(lockPath);
    expect(next).not.toBeNull();
    next?.release();
  });

  it('an old heartbeat cannot evict a live writer and release does not touch a successor', () => {
    const { dir } = fixture();
    const lockPath = path.join(dir, 'lease');
    const owner = acquireJournalLock(lockPath)!;
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    expect(acquireJournalLock(lockPath)).toBeNull();
    owner.release();
    const next = acquireJournalLock(lockPath)!;
    owner.release();
    expect(next.owned()).toBe(true);
    next.release();
  });
});
