import { execFileSync, execSync } from 'child_process';
import { CAPTURE_REWRITES, backgroundedWithRewrites, repairLocalPostRewriteScript } from './post-rewrite-hook-stdin.js';
import { REWRITE_NOTE_KEY, rebuildRewrittenNote, type RewriteWarning } from './history-rewrite.js';
import { projectRewriteLineClaims, type ProjectedRewriteLine } from './rewrite-line-projection.js';
import { noteLockWaitOverride, withNoteWriteLock, type NoteLease, type NoteLockOptions } from './note-write-lock.js';
import { cliVersion } from './cli-version.js';
import { gitIdentityEnv, runDetailed } from './utils/exec.js';
import { insertHookBlockAfterShebang } from './utils/hook-insert.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Prepend common npm/node/brew bin dirs so a hook invoked by a GUI git client
// (which doesn't source the login shell profile) can still resolve `origin`.
// Mirrors the PATH export the global core.hooksPath hooks use.
const HOOK_PATH_SHIM =
  'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RewriteMapping {
  oldSha: string;
  newSha: string;
}

export type RewriteTargetOutcome = 'written' | 'unchanged' | 'skipped' | 'failed';

export interface RewriteBatchResult {
  /** Distinct new commits in the batch. */
  targets: number;
  /** Targets whose note was written and read back. */
  written: number;
  /** Targets that already had exactly this note, or a note nothing could be added to. */
  unchanged: number;
  /** Targets with nothing to carry, or a pair that does not name two commits. */
  skipped: number;
  /** Targets whose notes could not be read or written; the others still ran. */
  failed: number;
  warnings: Array<RewriteWarning & { target?: string }>;
}

// ─── Public API ────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 10_000;
/**
 * A rewrite has no later event that would write its target again, so it waits
 * longer than a session writer — per attempt, and over a few attempts: long
 * enough in total to outlast any stale lock's lease (note-write-lock.ts).
 */
const REWRITE_LOCK_WAIT_MS = 60_000;
const REWRITE_LOCK_ATTEMPTS = 3;
const HEX = /^[0-9a-fA-F]{4,64}$/;

/** A commit's full lowercase sha, or null — never a string that reached a shell. */
function resolveCommit(repoPath: string, sha: string): string | null {
  if (!HEX.test(sha || '')) return null;
  const r = runDetailed('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
  const full = r.status === 0 ? r.stdout.trim().toLowerCase() : '';
  return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(full) ? full : null;
}

/** The commit's note, null when it has none, or an error — a failed read is never "no note". */
function readNote(repoPath: string, sha: string): { note: string | null } | { error: string } {
  const r = runDetailed('git', ['notes', '--ref=origin', 'show', sha], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
  if (r.status === 0) return { note: r.stdout.replace(/\n$/, '') };
  if (/no note found/i.test(r.stderr)) return { note: null };
  return { error: (r.stderr || `git notes show exited ${r.status}`).trim().split('\n').pop() || 'read failed' };
}

export interface RewriteOptions {
  now?: Date;
  producerVersion?: string;
  /** The note-write lock: wait per attempt (default 60 s), and test seams. */
  lock?: NoteLockOptions & { attempts?: number };
}

/**
 * Rebuild and write the note of ONE rewritten commit from its old commits'
 * notes (see history-rewrite.ts). Written at most once, without a shell, with
 * the same identity fallback as every other note writer, under the lock every
 * writer of a note shares (note-write-lock.ts).
 *
 * The line projection is git work on immutable commits and can take its whole
 * budget, so it runs outside the lock (OR-46 CR4): the relevant notes are read
 * under a short lock, the note is built from that snapshot, and a second short
 * lock writes it only if every note it was built from is still byte for byte
 * the same. A changed note means the attempt is stale: nothing is written and
 * the target is tried again. A note no rebuild reads never forces a retry.
 *
 * `sourceShas` is every old commit of the mapping or range, noted or not: the
 * mapping, not the number of notes, says whether this was a squash.
 */
export function rewriteAttributionForTarget(
  repoPath: string,
  targetSha: string,
  sourceShas: ReadonlyArray<string>,
  opts: RewriteOptions = {},
): { outcome: RewriteTargetOutcome; warnings: RewriteWarning[] } {
  const target = resolveCommit(repoPath, targetSha);
  if (!target) return { outcome: 'skipped', warnings: [{ code: 'record-not-built', sha: targetSha, detail: 'target is not a commit' }] };
  const { attempts = REWRITE_LOCK_ATTEMPTS, ...lock } = opts.lock ?? {};
  const lockOpts: NoteLockOptions = { waitMs: noteLockWaitOverride() ?? REWRITE_LOCK_WAIT_MS, ...lock };
  // A full sha names the same commit forever: resolved once, outside the lock.
  const resolved = new Map<string, string | null>();
  const resolve = (raw: string): string | null => {
    if (!resolved.has(raw)) resolved.set(raw, resolveCommit(repoPath, raw));
    return resolved.get(raw)!;
  };
  const initial: string[] = [];
  for (const raw of sourceShas) {
    const sha = resolve(raw);
    if (!sha || sha === target || initial.includes(sha)) continue;
    initial.push(sha);
  }
  // A held or lost lock, or a note that changed under the build, is retried —
  // the rebuild is a function of the notes it read, so a repeat writes the
  // same note, once. Never unlocked, never from a stale snapshot.
  let detail = LOCK_BUSY;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    const done = rewriteAttempt(repoPath, target, initial, resolve, opts, lockOpts);
    if (!('retry' in done)) return done;
    detail = done.retry;
  }
  return { outcome: 'failed', warnings: [{ code: 'note-lock-unavailable', sha: target, detail: `${detail}; ${Math.max(1, attempts)} attempt(s), nothing written` }] };
}

/** Why an attempt wrote nothing and the target is tried again. */
const LOCK_BUSY = 'another writer held the note lock too long';
const LEASE_RAN_OUT = 'the note lock\'s lease ran out before the write';
const NOTES_CHANGED = 'the old commits\' or the target\'s notes kept changing';

type RewriteAttempt = { outcome: RewriteTargetOutcome; warnings: RewriteWarning[] } | { retry: string };

/** A note read failed: never "no note". */
const READ_FAILED = Symbol('read-failed');

/** Each commit's note exactly as stored (null: none), or READ_FAILED. */
function readNotes(repoPath: string, shas: ReadonlyArray<string>): Map<string, string | null> | typeof READ_FAILED {
  const out = new Map<string, string | null>();
  for (const sha of shas) {
    const read = readNote(repoPath, sha);
    if ('error' in read) return READ_FAILED;
    out.set(sha, read.note);
  }
  return out;
}

function rewriteAttempt(
  repoPath: string,
  target: string,
  initial: ReadonlyArray<string>,
  resolve: (sha: string) => string | null,
  opts: RewriteOptions,
  lock: NoteLockOptions,
): RewriteAttempt {
  const commits = new Set<string>(initial);
  // Every note this attempt builds from, exactly as read; a commit without one is null.
  const snapshot = new Map<string, string | null>();
  const take = (shas: ReadonlyArray<string>): RewriteAttempt | null => {
    const read = withNoteWriteLock(repoPath, () => readNotes(repoPath, shas), lock);
    if (read === null) return { retry: LOCK_BUSY };
    if (read === READ_FAILED) return { outcome: 'failed', warnings: [] };
    for (const [sha, note] of read) snapshot.set(sha, note);
    return null;
  };
  const stop = take([target, ...initial]);
  if (stop) return stop;
  const existing = snapshot.get(target) ?? null;
  const sources = () => [...commits].flatMap((sha) => {
    const note = snapshot.get(sha);
    return typeof note === 'string' ? [{ sha, note }] : [];
  });
  // Nothing to carry and no rewrite bookkeeping to extend: the target is not written.
  if (sources().length === 0 && !(existing && existing.includes(REWRITE_NOTE_KEY))) {
    return { outcome: 'skipped', warnings: [] };
  }
  const build = (lineProjection?: ReadonlyArray<ProjectedRewriteLine>) => rebuildRewrittenNote({
    targetSha: target,
    sourceCommits: [...commits],
    sources: sources(),
    existingTarget: existing,
    lineProjection,
    recordedAt: opts.now ?? new Date(),
    producerVersion: opts.producerVersion ?? cliVersion(),
  });

  // The target note is an earlier rewrite's: rebuild from the union of the old
  // commits it recorded and these, so the order the hooks ran in and a repeat
  // of the same pairs change nothing. A build without a projection only finds
  // them; a recorded commit git no longer has still counts, it just has no
  // note to read. The target note is fixed for the attempt, so one round adds
  // them all.
  for (let round = 0; ; round++) {
    const missing = (build().recordedSources ?? []).filter((sha) => !commits.has(sha));
    if (missing.length === 0) break;
    if (round > 0) return { retry: NOTES_CHANGED };
    const readable: string[] = [];
    for (const sha of missing) {
      commits.add(sha);
      if (resolve(sha) && !snapshot.has(sha)) readable.push(sha);
    }
    const more = readable.length ? take(readable) : null;
    if (more) return more;
  }

  // Line claims proven on the new commit from these very notes (OR-46), once
  // per attempt; none proven, and the note is OR-11's commit-level one.
  const projection = projectRewriteLineClaims({ repoPath, targetSha: target, sources: sources() });
  const result = build(projection.lines);
  if (result.recordedSources) return { retry: NOTES_CHANGED };
  const warnings: RewriteWarning[] = [...result.warnings];
  // A projection that gave up (a limit, the budget, git) leaves the rewrite
  // commit-level, as OR-11 wrote it; say why, once. No line claims to carry
  // is not a reason.
  if (projection.reason) {
    const detail = `line projection: ${projection.reason}; the rewrite stays commit-level`;
    if (!warnings.some((w) => w.code === 'rewrite-lines-not-carried' && w.detail === detail)) {
      warnings.push({ code: 'rewrite-lines-not-carried', sha: target, detail });
    }
  }
  if (result.payload === null) return { outcome: sources().length === 0 ? 'skipped' : 'unchanged', warnings };
  const payload = result.payload;

  const done = withNoteWriteLock(repoPath, (lease: NoteLease): RewriteAttempt => {
    // Exactly the notes the build read, and only those.
    const now = readNotes(repoPath, [...snapshot.keys()]);
    if (now === READ_FAILED) return { outcome: 'failed', warnings };
    for (const [sha, note] of snapshot) {
      if (now.get(sha) !== note) return { retry: NOTES_CHANGED };
    }
    // A newer holder may be merging once our lease is over: then write nothing.
    if (!lease.holds(GIT_TIMEOUT_MS)) return { retry: LEASE_RAN_OUT };
    try {
      execFileSync('git', ['notes', '--ref=origin', 'add', '-f', '-m', payload, target], {
        cwd: repoPath, stdio: 'pipe', timeout: GIT_TIMEOUT_MS, encoding: 'utf-8', windowsHide: true,
        env: { ...process.env, ...gitIdentityEnv(repoPath) },
      });
    } catch {
      return { outcome: 'failed', warnings };
    }
    const back = readNote(repoPath, target);
    if ('error' in back || back.note === null || back.note.trim() !== payload.trim()) {
      return { outcome: 'failed', warnings };
    }
    return { outcome: 'written', warnings };
  }, lock);
  return done ?? { retry: LOCK_BUSY };
}

/**
 * Carry attribution across a batch of git's rewrite pairs (post-rewrite stdin,
 * a cherry-pick's source). Pairs are grouped by the NEW commit, so a squash of
 * N commits into one is one rebuild and one write, not N overwrites where the
 * last source wins. The old commits' notes are never touched, and nothing is
 * pushed. A failing target does not stop the others.
 */
export function preserveAttributionBatch(
  repoPath: string,
  mappings: ReadonlyArray<RewriteMapping>,
  opts: RewriteOptions = {},
): RewriteBatchResult {
  const result: RewriteBatchResult = { targets: 0, written: 0, unchanged: 0, skipped: 0, failed: 0, warnings: [] };
  const byTarget = new Map<string, Set<string>>();
  for (const m of mappings) {
    const oldSha = (m?.oldSha || '').trim().toLowerCase();
    const newSha = (m?.newSha || '').trim().toLowerCase();
    if (!HEX.test(oldSha) || !HEX.test(newSha) || oldSha === newSha) continue;
    if (!byTarget.has(newSha)) byTarget.set(newSha, new Set());
    byTarget.get(newSha)!.add(oldSha);
  }
  for (const [target, olds] of byTarget) {
    result.targets += 1;
    try {
      const { outcome, warnings } = rewriteAttributionForTarget(repoPath, target, [...olds], opts);
      result[outcome] += 1;
      result.warnings.push(...warnings.map((w) => ({ ...w, target: target.slice(0, 12) })));
    } catch {
      result.failed += 1;
    }
  }
  if (result.targets > 0) {
    debugLog(`rewrite batch: ${result.targets} target(s), ${result.written} written, ${result.unchanged} unchanged, `
      + `${result.skipped} skipped, ${result.failed} failed`
      + (result.warnings.length ? ` — warnings ${JSON.stringify(result.warnings)}` : ''));
  }
  return result;
}

/** One old→new pair. See preserveAttributionBatch. */
export function preserveAttributionOnRewrite(repoPath: string, oldSha: string, newSha: string): RewriteBatchResult {
  return preserveAttributionBatch(repoPath, [{ oldSha, newSha }]);
}

/**
 * Parse stdin input from git post-rewrite hook.
 * Format: "old-sha new-sha extra-info\n" per line.
 */
export function parseRewriteInput(input: string): RewriteMapping[] {
  const mappings: RewriteMapping[] = [];

  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      mappings.push({
        oldSha: parts[0],
        newSha: parts[1],
      });
    }
  }

  return mappings;
}

// ─── Hook Installation ─────────────────────────────────────────────────────

/**
 * Install git hooks that preserve Origin attribution through history rewrites.
 * Creates post-rewrite and post-checkout hooks in .git/hooks/.
 *
 * @param repoPath - Git repository root path
 */
export function installRewriteHooks(repoPath: string): void {
  const gitDir = getGitDir(repoPath);
  if (!gitDir) return;

  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  installPostRewriteHook(hooksDir);
  installPostCheckoutHook(hooksDir);
}

/**
 * Install post-rewrite hook that runs after rebase/amend operations.
 * The hook receives old-sha new-sha pairs on stdin.
 */
function installPostRewriteHook(hooksDir: string): void {
  const hookPath = path.join(hooksDir, 'post-rewrite');
  const ORIGIN_MARKER = '# origin-post-rewrite';

  const hookScript = [
    '#!/bin/sh',
    ORIGIN_MARKER,
    '# Preserve Origin attribution notes when commits are rewritten',
    '# Receives old-sha new-sha pairs on stdin (from git rebase/amend)',
    // PATH shim so GUI git clients (Tower/Sourcetree/VS Code) that don't source
    // the login profile can still find `origin` — otherwise the hook silently
    // no-ops and rebase/amend loses attribution. Redirect so the backgrounded
    // child doesn't stall a `git commit --amend | tee` pipe.
    HOOK_PATH_SHIM,
    // The pairs arrive on stdin and `&` detaches stdin: read them in the
    // foreground, pipe them in. See post-rewrite-hook-stdin.ts.
    CAPTURE_REWRITES,
    backgroundedWithRewrites('origin hooks git-post-rewrite "$@"'),
  ].join('\n') + '\n';

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes(ORIGIN_MARKER)) {
      // Already installed — but a block written before the stdin fix never
      // receives git's pairs. Repair it in place.
      const repaired = repairLocalPostRewriteScript(existing);
      if (repaired) fs.writeFileSync(hookPath, repaired);
      return;
    }
    // Appended, unlike the other hooks (which go after the shebang): this
    // block reads git's stdin pairs, and run first it would starve the
    // user's own lines of them.
    fs.appendFileSync(hookPath, '\n' + ORIGIN_MARKER + '\n' + HOOK_PATH_SHIM + '\n' + CAPTURE_REWRITES + '\n'
      + backgroundedWithRewrites('origin hooks git-post-rewrite "$@"') + '\n');
  } else {
    fs.writeFileSync(hookPath, hookScript);
  }

  fs.chmodSync(hookPath, '755');
}

/**
 * Install the post-checkout hook: notes fetch on a fresh clone, and fencing
 * the write journals of sessions whose tree a checkout just rewrote.
 */
function installPostCheckoutHook(hooksDir: string): void {
  const hookPath = path.join(hooksDir, 'post-checkout');
  const ORIGIN_MARKER = '# origin-post-checkout';

  const hookScript = [
    '#!/bin/sh',
    ORIGIN_MARKER,
    '# Fresh-clone notes fetch; fences write journals across a checkout',
    '# $1=prev-HEAD, $2=new-HEAD, $3=flag (1=branch checkout, 0=file checkout)',
    HOOK_PATH_SHIM,
    'if [ "$3" = "1" ]; then',
    '  origin hooks git-post-checkout "$@" >/dev/null 2>&1 &',
    'fi',
  ].join('\n') + '\n';

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes(ORIGIN_MARKER)) {
      // Already installed
      return;
    }
    // Insert after the shebang: a user hook ending in `exit 0` never reaches
    // an appended line. The subshell keeps the PATH shim out of the user's
    // own lines that now run after it.
    const block = [
      ORIGIN_MARKER,
      'if [ "$3" = "1" ]; then',
      `  ( ${HOOK_PATH_SHIM}; origin hooks git-post-checkout "$@" >/dev/null 2>&1 & )`,
      'fi',
    ].join('\n') + '\n';
    fs.writeFileSync(hookPath, insertHookBlockAfterShebang(existing, block));
  } else {
    fs.writeFileSync(hookPath, hookScript);
  }

  fs.chmodSync(hookPath, '755');
}

// ─── Stash Handling ────────────────────────────────────────────────────────

// ─── Utilities ─────────────────────────────────────────────────────────────

/**
 * Get the .git directory path for a repository.
 */
function getGitDir(repoPath: string): string | null {
  try {
    const gitDir = execSync('git rev-parse --git-dir', { windowsHide: true,
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);
  } catch {
    return null;
  }
}

/**
 * Write a debug log entry to ~/.origin/hooks.log.
 * Rotates the log file when it exceeds 5 MB.
 */
function debugLog(message: string): void {
  try {
    const logPath = path.join(os.homedir(), '.origin', 'hooks.log');
    try {
      const stats = fs.statSync(logPath);
      if (stats.size >= 5 * 1024 * 1024) {
        fs.renameSync(logPath, logPath + '.old');
      }
    } catch { /* file may not exist yet */ }
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] [history-preservation] ${message}\n`);
  } catch {
    // Never fail on logging
  }
}
