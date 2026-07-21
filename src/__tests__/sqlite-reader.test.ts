/**
 * Tests for the cross-platform SQLite reader (utils/sqlite.ts).
 *
 * The WASM backend (sql.js) is what makes Cursor/Codex model detection work on
 * native Windows, where there's no `sqlite3` CLI. We can't run on Windows here,
 * but sql.js is the SAME code path on every OS — so we force the WASM backend
 * explicitly and prove it reads a real DB file with byte-identical, CLI-shaped
 * output (rows by '\n', columns by separator, NULL → ''). That's the exact
 * behavior the Windows readers rely on.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { querySqlite, ensureSqlite, __resetSqliteBackend } from '../utils/sqlite.js';

const require = createRequire(import.meta.url);
let dbPath: string;
let tmpDir: string;

// Build a fixture DB with sql.js itself (no sqlite3 CLI needed), mirroring the
// shape of Cursor's ai-code-tracking.db that getCursorModelFromDb reads.
beforeAll(async () => {
  const initSqlJs = require('sql.js') as (cfg?: any) => Promise<any>;
  const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE conversation_summaries(conversationId TEXT, model TEXT, title TEXT);
    INSERT INTO conversation_summaries VALUES('conv-1','claude-opus-4-8','Hello');
    INSERT INTO conversation_summaries VALUES('conv-2', NULL, 'World');
  `);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sqlite-'));
  dbPath = path.join(tmpDir, 'ai-code-tracking.db');
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
});

afterAll(() => {
  __resetSqliteBackend();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('querySqlite via the WASM backend (the Windows path)', () => {
  beforeAll(async () => {
    // Force the sql.js backend regardless of host — this is what Windows uses.
    // Blank PATH so ensureSqlite's `sqlite3 -version` probe fails and it falls
    // through to the in-process WASM reader, exactly as on a box without the CLI.
    __resetSqliteBackend();
    const realPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await ensureSqlite();
    } finally {
      process.env.PATH = realPath;
    }
  });

  it('reads a scalar value from a real DB file', () => {
    const out = querySqlite(dbPath, "SELECT model FROM conversation_summaries WHERE conversationId='conv-1' LIMIT 1").trim();
    expect(out).toBe('claude-opus-4-8');
  });

  it('renders NULL as empty string (CLI list-mode parity)', () => {
    const out = querySqlite(dbPath, "SELECT model FROM conversation_summaries WHERE conversationId='conv-2' LIMIT 1").trim();
    expect(out).toBe('');
  });

  it('joins columns with a custom separator and rows with newline', () => {
    const out = querySqlite(dbPath, 'SELECT conversationId, title FROM conversation_summaries ORDER BY conversationId', { separator: '|||' }).trim();
    expect(out).toBe('conv-1|||Hello\nconv-2|||World');
  });

  it('returns empty string for a missing DB file (graceful degrade)', () => {
    const out = querySqlite(path.join(tmpDir, 'nope.db'), 'SELECT 1').trim();
    expect(out).toBe('');
  });
});
