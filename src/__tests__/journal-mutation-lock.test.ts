// The mutation lock every journal write goes through. Three ways it failed on
// native Windows CI after the lock shipped, each a silently lost turn mark or a
// ledger that declined the rest of the session:
//
//   1. A holder that mutates again right after releasing re-took the lock
//      before a waiter's next poll. A busy writer starved every other one past
//      the deadline, and a timeout taints the journal for good.
//   2. `release()` unlinks its identity and then removes the directory. On
//      Windows a scanner holding the just-deleted file makes that rmdir fail,
//      and the empty directory it leaves looked like a claimant mid-startup for
//      a full minute.
//   3. mkdir on a directory that is still being deleted fails with EPERM, not
//      EEXIST. That threw straight out of `mutateJournal`, and `markTurn`
//      swallowed it: no mark, no taint, nothing in any log.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { once } from 'events';
import { mutateJournal } from '../journal-lock.js';
import { markTurn, readJournalEntries } from '../write-journal-watch.js';

// A module namespace cannot be spied on, so pass `mkdirSync` through a mock the
// EPERM case can script. Every other call reaches the real filesystem.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mkdirSync = vi.fn(actual.mkdirSync);
  return { ...actual, mkdirSync, default: { ...actual, mkdirSync } };
});

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(dist, name + '.js')).href);
const children: ChildProcess[] = [];
const dirs: string[] = [];
function journalFixture(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-mutation-')));
  dirs.push(dir);
  return path.join(dir, 'journal.jsonl');
}
function worker(code: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  children.push(child);
  return child;
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const turnIds = (journal: string) => readJournalEntries(journal).filter((e) => e.kind === 'turn').map((e) => e.turnId);

describe('journal mutation lock', () => {
  it('a writer that was already waiting goes before a holder that mutates again', async () => {
    const journal = journalFixture();
    const holding = `${journal}.holding`;
    const order = `${journal}.order`;
    const sleep = 'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);';
    // Files, not IPC: a process blocked in Atomics.wait never flushes a send.
    const waiter = worker(`import fs from 'fs';
      import { mutateJournal } from ${moduleUrl('journal-lock')};
      ${sleep}
      while (!fs.existsSync(${JSON.stringify(holding)})) sleep(2);
      mutateJournal(${JSON.stringify(journal)}, () => fs.appendFileSync(${JSON.stringify(order)}, 'waiter\\n'));`);
    const holder = worker(`import fs from 'fs';
      import { mutateJournal } from ${moduleUrl('journal-lock')};
      ${sleep}
      const journal = ${JSON.stringify(journal)};
      // Hold long enough for the waiter to be queued even on a slow runner.
      mutateJournal(journal, () => { fs.writeFileSync(${JSON.stringify(holding)}, ''); sleep(1500); });
      for (let i = 0; i < 50; i++) mutateJournal(journal, () => fs.appendFileSync(${JSON.stringify(order)}, 'holder\\n'));`);
    const exits = await Promise.all([once(waiter, 'exit'), once(holder, 'exit')]);
    expect(exits).toEqual([[0, null], [0, null]]);
    const lines = fs.readFileSync(order, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(51);
    expect(lines[0]).toBe('waiter');
    expect(fs.existsSync(`${journal}.contended`)).toBe(false);
  }, 30_000);

  it('an empty mutation directory left by a failed release does not block the next writer', () => {
    const journal = journalFixture();
    markTurn(journal, 'before');
    fs.mkdirSync(`${journal}.mutation`);
    const started = Date.now();
    markTurn(journal, 'after');
    expect(turnIds(journal)).toEqual(['before', 'after']);
    expect(fs.existsSync(`${journal}.contended`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('a directory still being deleted is contention to wait out, not a failure', () => {
    const journal = journalFixture();
    const mkdir = vi.mocked(fs.mkdirSync);
    const real = mkdir.getMockImplementation()!;
    let refusals = 0;
    mkdir.mockImplementation(((p: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
      if (String(p) === `${journal}.mutation` && refusals < 3) {
        refusals += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${String(p)}'`), { code: 'EPERM' });
      }
      return real(p, opts);
    }) as typeof fs.mkdirSync);
    try {
      expect(mutateJournal(journal, () => 'ran')).toBe('ran');
    } finally {
      mkdir.mockImplementation(real);
    }
    expect(refusals).toBe(3);
    expect(fs.existsSync(`${journal}.contended`)).toBe(false);
  });

  it('still records a timeout when the lock is genuinely held past the deadline', () => {
    const journal = journalFixture();
    fs.mkdirSync(`${journal}.mutation`);
    // A live owner: this process's own pid, so no reaper may remove it.
    fs.writeFileSync(path.join(`${journal}.mutation`, `${process.pid}-live-owner`), '');
    expect(() => mutateJournal(journal, () => 'never', { timeoutMs: 200 })).toThrow(/timed out/);
    expect(fs.existsSync(`${journal}.contended`)).toBe(true);
  });
});
