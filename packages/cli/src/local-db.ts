import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ─── Local Prompt Database ───────────────────────────────────────────────
//
// Uses a simple JSON-file-based storage instead of SQLite to avoid
// native dependencies. Falls back gracefully if storage fails.

const DB_DIR = path.join(os.homedir(), '.origin', 'db');
const PROMPTS_FILE = path.join(DB_DIR, 'prompts.json');
const BLOBS_DIR = path.join(os.homedir(), '.origin', 'blobs');

// ─── Types ────────────────────────────────────────────────────────────────

export interface PromptRecord {
  id: string;
  sessionId: string;
  promptIndex: number;
  promptText: string;
  timestamp: string;
  model: string;
  repoPath: string;
  filesChanged: string[];
}

export interface BlobRecord {
  hash: string;
  size: number;
  createdAt: string;
}

interface PromptsDB {
  version: 1;
  prompts: PromptRecord[];
}

// ─── Initialization ──────────────────────────────────────────────────────

function ensureDbDir(): void {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function ensureBlobsDir(): void {
  fs.mkdirSync(BLOBS_DIR, { recursive: true });
}

function loadPromptsDB(): PromptsDB {
  try {
    return JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf-8'));
  } catch {
    return { version: 1, prompts: [] };
  }
}

function savePromptsDB(db: PromptsDB): void {
  ensureDbDir();
  // Atomic write: serialize to a temp file in the same directory, then
  // rename over the target. A plain writeFileSync on the target is not
  // atomic — a concurrent CLI invocation (two Claude sessions, pre-commit
  // hook vs. MCP server, etc.) can interleave read-modify-write cycles and
  // silently drop one side's prompts. Rename is atomic on POSIX and on
  // Windows when source+dest are on the same volume, which is guaranteed
  // here since tmp lives next to PROMPTS_FILE.
  const tmp = `${PROMPTS_FILE}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, PROMPTS_FILE);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename failed.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ─── Prompt Operations ───────────────────────────────────────────────────

/**
 * Insert a prompt record into the local database.
 * Deduplicates by id (sessionId + promptIndex).
 */
export function insertPrompt(record: PromptRecord): void {
  try {
    const db = loadPromptsDB();
    const existing = db.prompts.findIndex(p => p.id === record.id);
    if (existing >= 0) {
      db.prompts[existing] = record;
    } else {
      db.prompts.push(record);
    }
    savePromptsDB(db);
  } catch { /* best effort */ }
}

/**
 * Insert multiple prompts at once.
 */
export function insertPrompts(records: PromptRecord[]): void {
  try {
    const db = loadPromptsDB();
    for (const record of records) {
      const existing = db.prompts.findIndex(p => p.id === record.id);
      if (existing >= 0) {
        db.prompts[existing] = record;
      } else {
        db.prompts.push(record);
      }
    }
    savePromptsDB(db);
  } catch { /* best effort */ }
}

/**
 * Search prompts by text query (case-insensitive substring match).
 */
export function searchPrompts(
  query: string,
  opts?: { model?: string; repoPath?: string; limit?: number },
): PromptRecord[] {
  try {
    const db = loadPromptsDB();
    const lowerQuery = query.toLowerCase();
    let results = db.prompts.filter(p => {
      if (!p.promptText.toLowerCase().includes(lowerQuery)) return false;
      if (opts?.model && p.model !== opts.model) return false;
      if (opts?.repoPath && p.repoPath !== opts.repoPath) return false;
      return true;
    });
    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (opts?.limit) results = results.slice(0, opts.limit);
    return results;
  } catch {
    return [];
  }
}

/**
 * Get all prompts for a session.
 */
export function getPromptsBySession(sessionId: string): PromptRecord[] {
  try {
    const db = loadPromptsDB();
    return db.prompts
      .filter(p => p.sessionId === sessionId)
      .sort((a, b) => a.promptIndex - b.promptIndex);
  } catch {
    return [];
  }
}

/**
 * Get all prompts, optionally filtered.
 */
export function getAllPrompts(opts?: { since?: string; limit?: number }): PromptRecord[] {
  try {
    const db = loadPromptsDB();
    let results = db.prompts;
    if (opts?.since) {
      results = results.filter(p => p.timestamp >= opts.since!);
    }
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (opts?.limit) results = results.slice(0, opts.limit);
    return results;
  } catch {
    return [];
  }
}

/**
 * Get prompt count.
 */
export function getPromptCount(): number {
  try {
    const db = loadPromptsDB();
    return db.prompts.length;
  } catch {
    return 0;
  }
}

// ─── Content-Addressable Blob Storage ────────────────────────────────────

/**
 * Store content by its SHA-256 hash. Returns the hash.
 */
export function storeBlob(content: string): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const dir = path.join(BLOBS_DIR, hash.slice(0, 2));
  const filePath = path.join(dir, hash.slice(2));

  try {
    if (fs.existsSync(filePath)) return hash; // Already stored
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
  } catch { /* best effort */ }

  return hash;
}

/**
 * Retrieve content by hash.
 */
export function getBlob(hash: string): string | null {
  const filePath = path.join(BLOBS_DIR, hash.slice(0, 2), hash.slice(2));
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check if a blob exists.
 */
export function hasBlob(hash: string): boolean {
  const filePath = path.join(BLOBS_DIR, hash.slice(0, 2), hash.slice(2));
  return fs.existsSync(filePath);
}

/**
 * Deduplicate the blob store. Returns stats.
 */
export function deduplicateStore(): { totalBlobs: number; totalSize: number } {
  let totalBlobs = 0;
  let totalSize = 0;
  try {
    ensureBlobsDir();
    const dirs = fs.readdirSync(BLOBS_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const files = fs.readdirSync(path.join(BLOBS_DIR, dir.name));
      for (const file of files) {
        totalBlobs++;
        const stat = fs.statSync(path.join(BLOBS_DIR, dir.name, file));
        totalSize += stat.size;
      }
    }
  } catch { /* ignore */ }
  return { totalBlobs, totalSize };
}
