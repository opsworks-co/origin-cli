/**
 * Safe execution wrappers — the ONLY place in the CLI that should call
 * Node's child_process. Every other module must import from here.
 *
 * Why: string-concatenation `execSync` calls are a shell-injection
 * footgun. A repo path with a `;` or a filename with a backtick is
 * enough to get arbitrary command execution. These wrappers use
 * `execFileSync` / `spawnSync` with array arguments — no shell, no
 * interpolation, no parsing of user input as commands.
 *
 * If you need to add a new external tool, add a wrapper here.
 *
 * ESLint rule `no-restricted-imports` blocks `child_process` everywhere
 * except this file (see packages/cli/.eslintrc.cjs).
 */

import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptions,
  type SpawnSyncOptions,
} from 'child_process';
import path from 'path';

export interface RunOptions {
  cwd?: string;
  /** Default: 30 seconds. Hard kill after this. */
  timeoutMs?: number;
  /** Default: 'pipe' for all streams (no shell output unless asked). */
  stdio?: ExecFileSyncOptions['stdio'];
  /** Max bytes captured. Default: 100MB. */
  maxBuffer?: number;
  /** Encoding for the returned string. Default: 'utf-8'. */
  encoding?: BufferEncoding;
  /** Allow non-zero exit codes without throwing. Default: false. */
  allowNonZeroExit?: boolean;
  /** Extra env vars to merge into process.env. */
  env?: Record<string, string | undefined>;
  /** Optional data to pipe on stdin (only supported by runDetailed / gitDetailed). */
  input?: string | Buffer;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 100 * 1024 * 1024;

function buildOptions(opts: RunOptions = {}): ExecFileSyncOptions {
  return {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    encoding: opts.encoding ?? 'utf-8',
    env: opts.env ? { ...process.env, ...opts.env } as NodeJS.ProcessEnv : process.env,
  };
}

/**
 * Run an arbitrary file with explicit args. NEVER pass user input as the
 * `file` argument. The `args` array is passed verbatim — no shell parsing.
 */
export function run(file: string, args: string[], opts: RunOptions = {}): string {
  if (typeof file !== 'string' || !file) {
    throw new Error('[exec] file must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    throw new Error('[exec] args must be an array of strings');
  }
  for (const a of args) {
    if (typeof a !== 'string') {
      throw new Error(`[exec] all args must be strings, got ${typeof a}`);
    }
  }
  try {
    const out = execFileSync(file, args, buildOptions(opts));
    return typeof out === 'string' ? out : out.toString(opts.encoding ?? 'utf-8');
  } catch (err: any) {
    if (opts.allowNonZeroExit && err && typeof err === 'object' && 'status' in err) {
      const out = err.stdout;
      return typeof out === 'string' ? out : (out?.toString?.(opts.encoding ?? 'utf-8') ?? '');
    }
    throw err;
  }
}

/**
 * Like `run`, but returns { stdout, stderr, status } and never throws on
 * non-zero exit. Use when you need the exit code or stderr.
 */
export function runDetailed(
  file: string,
  args: string[],
  opts: RunOptions = {},
): { stdout: string; stderr: string; status: number } {
  const spawnOpts: SpawnSyncOptions = {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    encoding: opts.encoding ?? 'utf-8',
    env: opts.env ? { ...process.env, ...opts.env } as NodeJS.ProcessEnv : process.env,
    input: opts.input,
  };
  const r = spawnSync(file, args, spawnOpts);
  return {
    stdout: typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString?.() ?? ''),
    stderr: typeof r.stderr === 'string' ? r.stderr : (r.stderr?.toString?.() ?? ''),
    status: r.status ?? -1,
  };
}

// ─── Git ───────────────────────────────────────────────────────────────────

/**
 * Run `git <args>` with no shell. All arguments are passed verbatim — safe
 * to pass user-provided refs, paths, or commit messages.
 *
 * Always pass `cwd` for repo-scoped commands. If omitted, runs in
 * `process.cwd()`, which is rarely what you want.
 */
export function git(args: string[], opts: RunOptions = {}): string {
  return run('git', args, opts);
}

export function gitDetailed(
  args: string[],
  opts: RunOptions = {},
): { stdout: string; stderr: string; status: number } {
  return runDetailed('git', args, opts);
}

/**
 * Run `git` and return trimmed stdout, or null if the command fails. Useful
 * for "is this a git repo?" / "what's the current branch?" style queries.
 */
export function gitOrNull(args: string[], opts: RunOptions = {}): string | null {
  try {
    return git(args, opts).trim();
  } catch {
    return null;
  }
}

// ─── SQLite (sqlite3 CLI) ──────────────────────────────────────────────────

/**
 * Run a SQL query against a SQLite database via the `sqlite3` CLI.
 *
 * The query MUST be a static string. Bind parameters via the `params`
 * array — they're passed as `.param set @name 'value'` so SQLite handles
 * escaping, not the shell.
 *
 * Returns rows as `string[][]` (one array per row, columns in select order).
 */
export function sqliteQuery(
  dbPath: string,
  query: string,
  params: Array<string | number> = [],
  opts: RunOptions = {},
): string[][] {
  if (typeof dbPath !== 'string' || !dbPath) {
    throw new Error('[exec/sqlite] dbPath required');
  }
  if (typeof query !== 'string' || !query) {
    throw new Error('[exec/sqlite] query required');
  }
  // Build a parameterized command using sqlite3's .param syntax. The CLI
  // executes commands prefixed with `.` and then runs the query, with named
  // parameters bound safely (no shell interpolation).
  const lines: string[] = ['.mode list', '.separator |||'];
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    if (typeof v === 'number') {
      lines.push(`.param set :p${i} ${v}`);
    } else {
      // Escape single quotes for SQL literal — but the value is bound,
      // not interpolated into the query, so this is just SQL string syntax.
      lines.push(`.param set :p${i} '${String(v).replace(/'/g, "''")}'`);
    }
  }
  lines.push(query);
  const script = lines.join('\n');

  // Pipe the script via stdin instead of -cmd args so quoting can't bite us.
  const r = spawnSync('sqlite3', [dbPath], {
    input: script,
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: opts.env ? { ...process.env, ...opts.env } as NodeJS.ProcessEnv : process.env,
  });
  if (r.status !== 0 && !opts.allowNonZeroExit) {
    throw new Error(`[exec/sqlite] sqlite3 exited ${r.status}: ${r.stderr || ''}`);
  }
  const out = r.stdout || '';
  if (!out.trim()) return [];
  return out
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('|||'));
}

/**
 * Convenience: run a query and return the first column of the first row,
 * or null if no row.
 */
export function sqliteScalar(
  dbPath: string,
  query: string,
  params: Array<string | number> = [],
  opts: RunOptions = {},
): string | null {
  try {
    const rows = sqliteQuery(dbPath, query, params, opts);
    if (rows.length === 0) return null;
    const first = rows[0][0];
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * True if the `sqlite3` CLI is available on PATH.
 */
export function hasSqlite(): boolean {
  try {
    runDetailed('sqlite3', ['-version']);
    return true;
  } catch {
    return false;
  }
}

// ─── Path safety ───────────────────────────────────────────────────────────

/**
 * Validate that an identifier is safe to use as part of a filesystem path
 * or a literal in a generated query. Allows alphanumerics, dash, underscore,
 * dot. Returns the input unchanged or throws.
 */
export function safeIdentifier(value: string, label = 'identifier'): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`[exec] ${label} must be a non-empty string`);
  }
  if (!/^[a-zA-Z0-9_.\-]+$/.test(value)) {
    throw new Error(`[exec] ${label} contains invalid characters: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Resolve a child path against an expected root. Throws if the resolved
 * path would escape the root (e.g. via `..`). Use before passing user
 * input to fs / git / sqlite operations.
 */
export function ensureUnderRoot(root: string, child: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(root, child);
  if (resolvedChild !== resolvedRoot && !resolvedChild.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`[exec] path escapes root: ${child} not under ${root}`);
  }
  return resolvedChild;
}
