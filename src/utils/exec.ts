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
import { whichCommand } from './platform.js';

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
    // Windows: git.exe is a console-subsystem program. When the parent has no
    // console to inherit — exactly the case under a GUI agent like Codex
    // Desktop, and inside our own detached daemons — each child ALLOCATES one,
    // i.e. a visible terminal window, per call. Hooks shell out to git
    // constantly, so that reads as endless popups. CREATE_NO_WINDOW suppresses
    // it. No-op on macOS/Linux.
    windowsHide: true,
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
    windowsHide: true, // see buildOptions — no console window per child on Windows
  };
  const r = spawnSync(file, args, spawnOpts);
  return {
    stdout: typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString?.() ?? ''),
    stderr: typeof r.stderr === 'string' ? r.stderr : (r.stderr?.toString?.() ?? ''),
    status: r.status ?? -1,
  };
}

// ─── Executable lookup (cross-platform) ─────────────────────────────────────

/**
 * Locate an executable on PATH, cross-platform. Uses `where` on native
 * Windows and `which` on macOS/Linux/WSL, returning the first resolved path
 * (`where` can print several lines when a name resolves multiple ways).
 * Returns null if the tool is not found.
 *
 * Replaces the old `runDetailed('which', [name])` pattern — `which` does not
 * exist on native Windows, so those calls silently failed there.
 */
export function findExecutable(name: string, opts: RunOptions = {}): string | null {
  return findExecutables(name, opts)[0] ?? null;
}

/**
 * Every path `where`/`which` reports for a name, in the order the OS resolves
 * them. On Windows a single npm-installed name routinely resolves twice — an
 * extensionless `#!/bin/sh` shim AND a `.cmd` — and only the `.cmd` is
 * spawnable by CreateProcess. Callers that hand the path to another program
 * need the whole list so they can pick a runnable one; `findExecutable` alone
 * hands back the sh shim.
 */
export function findExecutables(name: string, opts: RunOptions = {}): string[] {
  const r = runDetailed(whichCommand(), [name], { timeoutMs: 2_000, ...opts });
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Git identity ──────────────────────────────────────────────────────────

/**
 * A committer identity for Origin's own git objects, used ONLY when the box
 * has none of its own.
 *
 * `git notes add` writes an object and therefore needs an identity, exactly
 * like `git commit-tree`. A machine with no user.name/user.email fails every
 * note write with "unable to auto-detect email address" — and because every
 * notes caller swallows its error (a note must never fail a commit or a
 * session end), the failure is completely silent. Symptom: the memory payload
 * fetches into staging, the fold reads it, merges it, and then cannot write
 * it, so `origin context memory` reports "No session memory yet" while the
 * data sits in .git the whole time (observed on a repo with no identity,
 * while the neighbouring repo had a LOCAL one and worked fine).
 *
 * git-capture.ts already learned this for shadow commits — see `shadowIdentity`
 * and the "+91 should be +2" bug it cites. This is the same fix for the notes
 * half, which was never covered.
 */
export const ORIGIN_FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: 'Origin',
  GIT_AUTHOR_EMAIL: 'notes@origin.local',
  GIT_COMMITTER_NAME: 'Origin',
  GIT_COMMITTER_EMAIL: 'notes@origin.local',
} as const;

// One probe per repo per process. Note writes come in bursts at session end,
// and this would otherwise add a spawn to each one — the cost that made the
// fold too expensive to run unconditionally in the first place.
const identityProbe = new Map<string, boolean>();

/** Test seam — the probe cache outlives a repo across tests otherwise. */
export function __resetGitIdentityProbe(): void {
  identityProbe.clear();
}

/**
 * Env for a git command that writes an object.
 *
 * Returns `{}` when the machine already has an identity, so a real user's name
 * stays on their notes — GIT_AUTHOR_* would OVERRIDE their config, not defer to
 * it, so this must not be set unconditionally. `git var GIT_COMMITTER_IDENT` is
 * the canonical probe: it exits non-zero exactly when git would refuse to build
 * the object.
 */
export function gitIdentityEnv(repoPath?: string): Record<string, string> {
  const key = repoPath || '';
  let has = identityProbe.get(key);
  if (has === undefined) {
    try {
      execFileSync('git', ['var', 'GIT_COMMITTER_IDENT'], {
        cwd: repoPath, stdio: 'pipe', timeout: 5_000, windowsHide: true,
      });
      has = true;
    } catch {
      has = false;
    }
    identityProbe.set(key, has);
  }
  return has ? {} : { ...ORIGIN_FALLBACK_IDENTITY };
}

// ─── Git ───────────────────────────────────────────────────────────────────

/**
 * Run `git <args>` with no shell. All arguments are passed verbatim — safe
 * to pass user-provided refs, paths, or commit messages.
 *
 * Always pass `cwd` for repo-scoped commands. If omitted, runs in
 * `process.cwd()`, which is rarely what you want.
 */
// Diff-producing subcommands. For these we force submodule pointer changes to
// always render, so a repo/user `diff.ignoreSubmodules=all` (or a per-submodule
// `ignore`) can't silently drop the `Subproject commit <sha>` section from
// capture — which would make a submodule bump invisible in the session/commit.
// `-c diff.ignoreSubmodules=none` is a no-op for the non-diff cases (log
// without -p, show of a non-commit), so prepending it broadly is safe.
const DIFF_SUBCOMMANDS = new Set(['diff', 'show', 'diff-tree', 'diff-index', 'log']);

function withSubmoduleVisibility(args: string[]): string[] {
  return args.length && DIFF_SUBCOMMANDS.has(args[0])
    ? ['-c', 'diff.ignoreSubmodules=none', ...args]
    : args;
}

export function git(args: string[], opts: RunOptions = {}): string {
  return run('git', withSubmoduleVisibility(args), opts);
}

export function gitDetailed(
  args: string[],
  opts: RunOptions = {},
): { stdout: string; stderr: string; status: number } {
  return runDetailed('git', withSubmoduleVisibility(args), opts);
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

// ─── SQLite ─────────────────────────────────────────────────────────────────
//
// SQLite reads live in utils/sqlite.ts (querySqlite / ensureSqlite): the
// `sqlite3` CLI on macOS/Linux, an in-process sql.js WASM reader on native
// Windows (no bundled sqlite3 binary there). The old CLI-only sqliteQuery/
// sqliteScalar helpers that lived here were unused and had no Windows fallback,
// so they were removed — use utils/sqlite.ts instead.

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
