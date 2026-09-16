// A TODO someone typed travels with the repo.
//
// `origin todo add` wrote only `~/.origin/origin-todos.json` — one laptop's
// file, outside any repo — while session-mined leftovers reached every clone
// through the memory note. On 2026-09-15 three follow-ups recorded that way
// were invisible to every other machine, to CI, and to the next agent; the
// session rollup beside them carried its own leftovers fine.
//
// Manual TODOs are now their own records in the note, closed by the same
// closure fact that discharges a session-mined one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  mergeMemoryPayloads, readManualTodos, readTodoClosures, recordManualTodos, todoClosureKey,
} from '../memory.js';
import { addManualTodo, getOpenTodos, markTodoDone, loadTodos } from '../todo.js';

const TEXT = 'sweep the capture-e2e files for the [length - 1] read';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function makeRepo(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-manual-todo-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

/** A second working copy of `origin`, with the memory note fetched — a colleague's clone. */
function cloneWithNotes(origin: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-manual-todo-clone-')));
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'ignore' });
  git(dir, 'fetch', '-q', 'origin', 'refs/notes/origin-memory:refs/notes/origin-memory');
  return dir;
}

let repo: string;
let clone: string;
let home: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  repo = makeRepo();
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-manual-todo-home-')));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = savedHome;
  for (const d of [repo, clone, home]) {
    try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  clone = '';
});

describe('a typed TODO travels with the repo', () => {
  it('reaches a clone that never saw the machine it was typed on', () => {
    const item = addManualTodo(TEXT, repo);
    expect(readManualTodos(repo).map((m) => m.text)).toEqual([TEXT]);

    clone = cloneWithNotes(repo);
    // A different machine: empty local store, same repo.
    const otherHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-manual-todo-home2-')));
    process.env.HOME = otherHome;
    expect(loadTodos().items).toEqual([]);

    const open = getOpenTodos(clone);
    const found = open.find((t) => t.text === TEXT);
    expect(found, 'the typed TODO did not reach the clone').toBeTruthy();
    expect(found!.source).toBe('manual');
    // Same id on both sides, so `origin todo done <id>` resolves what was printed.
    expect(found!.id).toBe(item.id);
    fs.rmSync(otherHome, { recursive: true, force: true });
  });

  it('closing it in the clone travels back as a closure', () => {
    addManualTodo(TEXT, repo);
    clone = cloneWithNotes(repo);
    const otherHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-manual-todo-home3-')));
    process.env.HOME = otherHome;

    const id = getOpenTodos(clone).find((t) => t.text === TEXT)!.id;
    expect(markTodoDone(id, clone)).toBeTruthy();

    expect(readTodoClosures(clone).some((c) => c.key === todoClosureKey(TEXT) && c.state === 'closed')).toBe(true);
    expect(getOpenTodos(clone).some((t) => t.text === TEXT)).toBe(false);
    // The item itself is gone from the note once discharged.
    expect(readManualTodos(clone).some((m) => m.text === TEXT)).toBe(false);
    fs.rmSync(otherHome, { recursive: true, force: true });
  });

  it('records the same sentence once, keeping the first timestamp', () => {
    addManualTodo(TEXT, repo);
    const first = readManualTodos(repo)[0];
    addManualTodo(TEXT, repo);
    addManualTodo(`  ${TEXT.toUpperCase()}  `, repo);
    const recorded = readManualTodos(repo);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].at).toBe(first.at);
  });

  it('is a no-op outside a git repo — the local store still takes it', () => {
    const plain = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-manual-todo-plain-')));
    const item = addManualTodo('not in a repo', plain);
    expect(item.text).toBe('not in a repo');
    expect(loadTodos().items.some((i) => i.text === 'not in a repo')).toBe(true);
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

describe('mergeMemoryPayloads — manual TODOs', () => {
  const manual = (text: string, at: string) => ({ key: todoClosureKey(text), id: 'aaaa1111', text, at });
  const base = { version: 2, sessions: [], commits: [] };

  it('unions both sides, first seen wins', () => {
    const merged = mergeMemoryPayloads(
      { ...base, manualTodos: [manual('mine', '2026-09-15T10:00:00.000Z')] } as any,
      { ...base, manualTodos: [manual('mine', '2026-09-15T12:00:00.000Z'), manual('theirs', '2026-09-15T11:00:00.000Z')] } as any,
    );
    expect((merged.manualTodos || []).map((m) => m.text).sort()).toEqual(['mine', 'theirs']);
    expect((merged.manualTodos || []).find((m) => m.text === 'mine')!.at).toBe('2026-09-15T10:00:00.000Z');
  });

  it('drops one a closure from either side discharged', () => {
    const closure = {
      key: todoClosureKey('mine'), id: 'aaaa1111', text: 'mine',
      reason: 'closed by hand', at: '2026-09-15T13:00:00.000Z', state: 'closed' as const,
    };
    const merged = mergeMemoryPayloads(
      { ...base, manualTodos: [manual('mine', '2026-09-15T10:00:00.000Z')] } as any,
      { ...base, closedTodos: [closure] } as any,
    );
    expect(merged.manualTodos || []).toEqual([]);
    // The closure survives the merge that used it, so a third machine folding
    // the old item back in still sees it discharged.
    expect((merged.closedTodos || []).map((c) => c.key)).toEqual([todoClosureKey('mine')]);
  });

  it('reads a payload written before manual TODOs existed', () => {
    const merged = mergeMemoryPayloads({ ...base } as any, { ...base } as any);
    expect(merged.manualTodos).toEqual([]);
    expect(recordManualTodos(repo, [])).toBe(0);
  });
});
