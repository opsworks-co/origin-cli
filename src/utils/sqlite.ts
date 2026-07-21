/**
 * Cross-platform SQLite reader for agent state DBs (Cursor / Codex).
 *
 * The proven path is the `sqlite3` CLI, present on macOS/Linux — we keep using
 * it there so output is byte-identical. Native Windows ships no `sqlite3`
 * binary, so when the CLI is absent we fall back to an in-process reader built
 * on sql.js (pure WebAssembly — no native build to fail on a user's machine).
 *
 * ── The sync/async seam ──
 * Every reader in the capture path is synchronous (git hooks run sync), but
 * sql.js initializes ASYNCHRONOUSLY (it instantiates WASM). So:
 *   • `ensureSqlite()` (async) is awaited once at the top of the async hook
 *     handlers — it picks the backend and, on Windows, loads the WASM module.
 *   • `querySqlite()` (sync) then runs against the already-selected backend.
 * If `ensureSqlite()` is never awaited, `querySqlite` still uses the CLI when
 * available (mac/linux) and otherwise returns '' — exactly today's graceful
 * degradation on Windows. So a missed await never crashes; it only loses the
 * model-detection nicety on that one path.
 *
 * Output format matches the `sqlite3` CLI's `.mode list`: one row per line,
 * columns joined by the separator (default `|`), NULL rendered as empty.
 *
 * Known limitation (WASM path only): sql.js reads the main `.db` file, so rows
 * still sitting in a `-wal` sidecar (WAL journaling) aren't visible until
 * checkpointed. The CLI handles WAL transparently. Model detection is
 * best-effort, so a just-written row occasionally read as absent is acceptable.
 */
import fs from 'fs';
import { createRequire } from 'module';
import { runDetailed } from './exec.js';
import { debugLog } from '../debug-log.js';

const require = createRequire(import.meta.url);

type Backend = 'cli' | 'wasm' | 'none';
let backend: Backend | null = null;
// sql.js SQL module (has .Database); typed loosely to avoid a hard type dep.
let SQL: { Database: new (data?: Uint8Array) => any } | null = null;

/** True if the `sqlite3` CLI is on PATH. */
function hasSqlite3Cli(): boolean {
  return runDetailed('sqlite3', ['-version'], { timeoutMs: 2_000 }).status === 0;
}

/**
 * Select and prepare the SQLite backend. Idempotent — safe to await on every
 * hook. Prefers the `sqlite3` CLI; loads the sql.js WASM reader only when the
 * CLI is missing (native Windows). Must be awaited before a synchronous
 * `querySqlite()` can use the WASM backend.
 */
export async function ensureSqlite(): Promise<void> {
  if (backend) return;
  if (hasSqlite3Cli()) {
    backend = 'cli';
    return;
  }
  try {
    // sql.js is CommonJS (module.exports = initSqlJs). Pass the wasm bytes
    // directly so it never tries to fetch/locate the file at runtime.
    const initSqlJs = require('sql.js') as (cfg?: any) => Promise<typeof SQL>;
    const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    SQL = await initSqlJs({ wasmBinary });
    backend = SQL ? 'wasm' : 'none';
  } catch (e) {
    debugLog('sqlite', 'sql.js init failed — model detection degraded', { error: String(e) });
    backend = 'none';
  }
}

// One opened sql.js Database, cached by path+mtime for the process lifetime.
// getCursorModelFromDb fires 3 queries at the same DB back-to-back; without
// this each re-reads the whole file and re-instantiates WASM. Invalidated when
// the path or mtime changes, so a just-written row is never served stale.
let dbCache: { path: string; mtimeMs: number; db: any } | null = null;

function closeDbCache(): void {
  if (dbCache) {
    try { dbCache.db.close(); } catch { /* already closed */ }
    dbCache = null;
  }
}

/** Test-only: reset the memoized backend selection. */
export function __resetSqliteBackend(): void {
  closeDbCache();
  backend = null;
  SQL = null;
}

function cliQuery(dbPath: string, sql: string, separator: string, timeoutMs?: number): string {
  // -separator makes the default '|' explicit and carries custom separators
  // (e.g. '|||'). runDetailed never throws on non-zero/locked/missing-binary,
  // so a failure returns '' — the same signal the old try/catch produced.
  const r = runDetailed('sqlite3', ['-separator', separator, dbPath, sql], {
    timeoutMs: timeoutMs ?? 3_000,
  });
  return r.status === 0 ? r.stdout : '';
}

function wasmQuery(dbPath: string, sql: string, separator: string): string {
  if (!SQL) return '';
  try {
    if (!fs.existsSync(dbPath)) return '';
    const mtimeMs = fs.statSync(dbPath).mtimeMs;
    if (!dbCache || dbCache.path !== dbPath || dbCache.mtimeMs !== mtimeMs) {
      closeDbCache();
      dbCache = { path: dbPath, mtimeMs, db: new SQL.Database(fs.readFileSync(dbPath)) };
    }
    const res = dbCache.db.exec(sql);
    if (!res.length) return '';
    // Our queries are single SELECTs; take the first result set and render
    // it exactly like the CLI's list mode (NULL → '').
    return res[0].values
      .map((row: unknown[]) => row.map((v) => (v == null ? '' : String(v))).join(separator))
      .join('\n');
  } catch (e) {
    debugLog('sqlite', 'wasm query failed', { error: String(e) });
    // A corrupt/locked cached handle shouldn't poison later queries.
    closeDbCache();
    return '';
  }
}

/**
 * Run a read-only SQL query against a SQLite DB, cross-platform. Returns the
 * raw list-mode output (rows by '\n', columns by `separator`); callers `.trim()`
 * as they did with the old `execFileSync('sqlite3', …)` result. Never throws —
 * returns '' when the DB is missing, locked, or no backend is available.
 *
 * The `sql` string is executed verbatim; callers remain responsible for
 * escaping any embedded literals (unchanged from the CLI shell-out).
 */
export function querySqlite(
  dbPath: string,
  sql: string,
  opts: { separator?: string; timeoutMs?: number } = {},
): string {
  const separator = opts.separator ?? '|';
  // backend===null means ensureSqlite wasn't awaited: the CLI still works
  // synchronously on mac/linux; wasm can't init sync, so Windows degrades to ''.
  if (backend === 'wasm') return wasmQuery(dbPath, sql, separator);
  if (backend === 'none') return '';
  return cliQuery(dbPath, sql, separator, opts.timeoutMs);
}
