import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractTodosFromPrompts } from './handoff.js';
import {
  readAllSessionMemory, readTodoClosures, recordTodoClosures, sortByDateAsc,
  todoClosureKey, todoDisplayId, type TodoClosure,
} from './memory.js';
import { samePath } from './paths.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TodoItem {
  id: string;               // Short unique ID (first 8 chars of hash)
  text: string;             // The TODO text
  sessionId: string;        // Originating session
  repoPath: string;         // Repo where it was created
  branch: string | null;
  createdAt: string;        // ISO timestamp
  status: 'open' | 'done';
  doneAt?: string;
  // `memory`: read from the repo's memory notes rather than the local store.
  source: 'prompt' | 'transcript' | 'manual' | 'memory';
  /**
   * A session has said this is done, but its work has not reached the default
   * branch yet. Still OPEN — an unmerged fix is a claim, not an outcome — and
   * shown as such so the list says why it is about to disappear.
   */
  pending?: { reason: string; sessionId?: string; at: string };
}

export interface TodoStore {
  version: 1;
  items: TodoItem[];
}

const TODO_FILE = 'origin-todos.json';

// ─── Paths ─────────────────────────────────────────────────────────────────

function getTodoPath(): string {
  return path.join(os.homedir(), '.origin', TODO_FILE);
}

// ─── Load / Save ───────────────────────────────────────────────────────────

export function loadTodos(): TodoStore {
  const p = getTodoPath();
  try {
    if (!fs.existsSync(p)) return { version: 1, items: [] };
    const raw = fs.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version === 1 && Array.isArray(data.items)) return data;
    return { version: 1, items: [] };
  } catch {
    return { version: 1, items: [] };
  }
}

function saveTodos(store: TodoStore): void {
  const dir = path.dirname(getTodoPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getTodoPath(), JSON.stringify(store, null, 2), 'utf-8');
}

// ─── Operations ────────────────────────────────────────────────────────────

// Keyed on text + session so the SAME leftover reaches the same id whichever
// way it arrives — mined into the local store at session end, or read back out
// of the repo's memory notes — and a `done` recorded against one hides the other.
//
// The implementation lives in memory.ts (todoDisplayId) because the injected
// context prints these ids and cannot import todo.ts without a cycle. It kept
// its hashing exactly, so ids recorded by older builds still resolve.
//
// Was `require('crypto')`. This package is ESM (`"type": "module"`), where
// `require` is not defined, so every call threw and the store was never
// written: `origin todo list` said "No open TODOs" on a machine whose repos had
// recorded dozens, and the failure hid inside session end's best-effort catch.
const generateId = todoDisplayId;

/**
 * The open TODOs recorded in this repo's memory notes (`refs/notes/origin-memory`).
 *
 * Session end writes each session's leftovers — mined from its prompts plus
 * its `[Origin: Open]` markers — into the repo's memory rollup, and that rollup
 * is what the injected context, `origin context memory`, the get_repo_memory
 * tool and the Memory tab all read. `origin todo list` read only the local
 * store, which the same extractor fed through a call that never succeeded (see
 * generateId), so the command reported nothing against a record everything
 * else could see. The notes are the durable copy — they travel with the repo
 * and survive a reinstall — so they are the source here; the local store adds
 * what a person typed and remembers which of these were closed.
 *
 * Newest session first: the most recent leftover is the one to pick up. The
 * same sentence carried by several sessions (a long-running item every session
 * re-records) appears once, under the session that recorded it last.
 */
export function readMemoryTodos(repoPath: string): TodoItem[] {
  let entries: ReturnType<typeof readAllSessionMemory>;
  try {
    entries = readAllSessionMemory(repoPath);
  } catch {
    return [];
  }
  const items: TodoItem[] = [];
  const closures = new Map<string, TodoClosure>();
  for (const c of readTodoClosures(repoPath)) if (c?.key) closures.set(c.key, c);
  const seen = new Set<string>();
  const newestFirst = sortByDateAsc(entries, (e) => e.endedAt || e.startedAt).reverse();
  for (const entry of newestFirst) {
    for (const raw of entry.openTodos || []) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const closure = closures.get(todoClosureKey(text));
      // A CONFIRMED closure removes it. A pending one only annotates: the
      // closing session's work is still on a branch, and a branch is not an
      // outcome — see the `state` note on TodoClosure.
      if (closure?.state === 'closed') continue;
      items.push({
        id: generateId(text, entry.sessionId),
        text,
        sessionId: entry.sessionId,
        repoPath,
        branch: entry.branch ?? null,
        createdAt: entry.endedAt || entry.startedAt || new Date().toISOString(),
        status: 'open',
        source: 'memory',
        ...(closure ? { pending: { reason: closure.reason, sessionId: closure.sessionId, at: closure.at } } : {}),
      });
    }
  }
  return items;
}

export function addTodosFromSession(
  sessionId: string,
  prompts: string[],
  repoPath: string,
  branch: string | null,
): number {
  const todos = extractTodosFromPrompts(prompts);
  if (todos.length === 0) return 0;

  const store = loadTodos();
  const existingTexts = new Set(store.items.map(i => i.text.toLowerCase()));
  let added = 0;

  for (const text of todos) {
    if (existingTexts.has(text.toLowerCase())) continue;
    store.items.push({
      id: generateId(text, sessionId),
      text,
      sessionId,
      repoPath,
      branch,
      createdAt: new Date().toISOString(),
      status: 'open',
      source: 'prompt',
    });
    added++;
  }

  if (added > 0) saveTodos(store);
  return added;
}

export function addManualTodo(text: string, repoPath?: string): TodoItem {
  const store = loadTodos();
  const sessionId = 'manual';
  const item: TodoItem = {
    id: generateId(text, Date.now().toString()),
    text,
    sessionId,
    repoPath: repoPath || process.cwd(),
    branch: null,
    createdAt: new Date().toISOString(),
    status: 'open',
    source: 'manual',
  };
  store.items.push(item);
  saveTodos(store);
  return item;
}

/**
 * Record a memory-sourced TODO's closure in the repo's memory note.
 *
 * `closed`, not `pending`: a person typing `origin todo done` IS the evidence.
 * There is no branch to wait for, which is the only thing `pending` exists to
 * wait for.
 */
function closeInMemoryNotes(repoPath: string, item: TodoItem, at: string, reason: string): void {
  recordTodoClosures(repoPath, [{
    key: todoClosureKey(item.text),
    id: item.id,
    text: item.text,
    reason,
    at,
    state: 'closed',
    confirmedAt: at,
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
  }]);
}

/**
 * Lift closures recorded before they travelled into the repo's memory note.
 *
 * Until this existed, closing a memory TODO wrote a tombstone to
 * `~/.origin/origin-todos.json` — outside any repo, so the TODO travelled with
 * the notes and its closure did not: every other clone, every other machine and
 * CI read all of them as still open. Idempotent, and `recordTodoClosures`
 * writes nothing when there is nothing new, so the common path costs one note
 * read.
 */
function liftLocalClosuresIntoNotes(repoPath: string): void {
  try {
    const store = loadTodos();
    const local = store.items.filter(
      (i) => i.status === 'done' && i.source === 'memory' && samePath(i.repoPath, repoPath),
    );
    if (local.length === 0) return;
    recordTodoClosures(repoPath, local.map((i) => ({
      key: todoClosureKey(i.text),
      id: i.id,
      text: i.text,
      reason: 'closed by hand',
      at: i.doneAt || i.createdAt,
      state: 'closed' as const,
      confirmedAt: i.doneAt || i.createdAt,
      ...(i.sessionId ? { sessionId: i.sessionId } : {}),
    })));
  } catch { /* best-effort — never block a read on a note write */ }
}

/**
 * Close a TODO.
 *
 * One recorded in the repo's memory notes cannot be edited there — the notes
 * are a history, not a checklist — so its closure is written as a separate
 * fact IN THAT SAME NOTE, which is what makes it travel with the repo. The
 * local store keeps its own copy so a closure still works where the note
 * cannot be written (a read-only checkout, a repo with no root commit).
 */
export function markTodoDone(idPrefix: string, repoPath?: string): TodoItem | null {
  const store = loadTodos();
  const now = new Date().toISOString();
  const item = store.items.find(i => i.id.startsWith(idPrefix) && i.status === 'open');
  if (item) {
    item.status = 'done';
    item.doneAt = now;
    saveTodos(store);
    // A manual or prompt-mined TODO lives only in the local store; there is
    // nothing in the note for a closure to refer to.
    if (repoPath && item.source === 'memory') closeInMemoryNotes(repoPath, item, now, 'closed by hand');
    return item;
  }
  const fromMemory = repoPath
    ? getOpenTodos(repoPath).find(i => i.source === 'memory' && i.id.startsWith(idPrefix))
    : undefined;
  if (!fromMemory) return null;
  const closed: TodoItem = { ...fromMemory, status: 'done', doneAt: now };
  store.items.push(closed);
  saveTodos(store);
  if (repoPath) closeInMemoryNotes(repoPath, closed, now, 'closed by hand');
  return closed;
}

export function getTodoById(idPrefix: string, repoPath?: string): TodoItem | null {
  const store = loadTodos();
  const local = store.items.find(i => i.id.startsWith(idPrefix));
  if (local) return local;
  if (!repoPath) return null;
  return readMemoryTodos(repoPath).find(i => i.id.startsWith(idPrefix)) || null;
}

export function getOpenTodos(repoPath?: string): TodoItem[] {
  if (repoPath) liftLocalClosuresIntoNotes(repoPath);
  const store = loadTodos();
  const local = repoPath ? store.items.filter(i => samePath(i.repoPath, repoPath)) : store.items;
  const open = local.filter(i => i.status === 'open');
  if (!repoPath) return open;

  // Any record in the store — open, done, from whichever checkout of this repo
  // it was written in — supersedes the memory copy of the same TODO. The id is
  // text + session, so a memory TODO closed from a worktree stays closed when
  // the list is read from the main checkout.
  const recorded = new Set(store.items.map(i => i.id));
  const recordedTexts = new Set(local.map(i => i.text.toLowerCase()));
  const fromMemory = readMemoryTodos(repoPath).filter(
    i => !recorded.has(i.id) && !recordedTexts.has(i.text.toLowerCase()),
  );
  return [...open, ...fromMemory];
}

export function getAllTodos(repoPath?: string): TodoItem[] {
  const store = loadTodos();
  let items = store.items;
  if (repoPath) {
    items = items.filter(i => samePath(i.repoPath, repoPath));
  }
  return items;
}

/**
 * Drop a TODO from the local store. A memory-sourced one has nothing to drop
 * there — the notes keep it — so it is closed instead, which is the only way
 * to make it stop appearing.
 */
export function removeTodo(idPrefix: string, repoPath?: string): { item: TodoItem; mode: 'removed' | 'closed' } | null {
  const store = loadTodos();
  const idx = store.items.findIndex(i => i.id.startsWith(idPrefix));
  if (idx >= 0) {
    const [item] = store.items.splice(idx, 1);
    saveTodos(store);
    return { item, mode: 'removed' };
  }
  const closed = markTodoDone(idPrefix, repoPath);
  return closed ? { item: closed, mode: 'closed' } : null;
}
