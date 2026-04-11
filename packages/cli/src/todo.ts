import fs from 'fs';
import path from 'path';
import os from 'os';
import { getGitRoot } from './session-state.js';
import { extractTodosFromPrompts } from './handoff.js';

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
  source: 'prompt' | 'transcript' | 'manual';
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

function generateId(text: string, sessionId: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(text + sessionId).digest('hex').slice(0, 8);
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

export function markTodoDone(idPrefix: string): TodoItem | null {
  const store = loadTodos();
  const item = store.items.find(i => i.id.startsWith(idPrefix) && i.status === 'open');
  if (!item) return null;
  item.status = 'done';
  item.doneAt = new Date().toISOString();
  saveTodos(store);
  return item;
}

export function getTodoById(idPrefix: string): TodoItem | null {
  const store = loadTodos();
  return store.items.find(i => i.id.startsWith(idPrefix)) || null;
}

export function getOpenTodos(repoPath?: string): TodoItem[] {
  const store = loadTodos();
  let items = store.items.filter(i => i.status === 'open');
  if (repoPath) {
    items = items.filter(i => i.repoPath === repoPath);
  }
  return items;
}

export function getAllTodos(repoPath?: string): TodoItem[] {
  const store = loadTodos();
  let items = store.items;
  if (repoPath) {
    items = items.filter(i => i.repoPath === repoPath);
  }
  return items;
}

export function removeTodo(idPrefix: string): boolean {
  const store = loadTodos();
  const idx = store.items.findIndex(i => i.id.startsWith(idPrefix));
  if (idx < 0) return false;
  store.items.splice(idx, 1);
  saveTodos(store);
  return true;
}
