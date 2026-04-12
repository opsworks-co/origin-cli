import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Types ─────────────────────────────────────────────────────────────────

interface RewriteMapping {
  oldSha: string;
  newSha: string;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Preserve Origin attribution notes when commits are rewritten.
 * Copies git notes from old SHAs to new SHAs so that rebasing, amending,
 * and cherry-picking don't lose attribution data.
 *
 * @param repoPath - Git repository root path
 * @param oldSha - The original commit SHA
 * @param newSha - The new commit SHA after rewrite
 */
export function preserveAttributionOnRewrite(repoPath: string, oldSha: string, newSha: string): void {
  if (!oldSha || !newSha || oldSha === newSha) return;

  const execOpts = {
    cwd: repoPath,
    encoding: 'utf-8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  };

  try {
    // Read the existing note from the old SHA
    const note = execSync(
      `git notes --ref=origin show ${oldSha}`,
      execOpts,
    ).trim();

    if (!note) return;

    // Write the note to the new SHA (overwrite if exists)
    execSync(
      `git notes --ref=origin add -f -m ${escapeShellArg(note)} ${newSha}`,
      execOpts,
    );

    debugLog(`Preserved attribution: ${oldSha.slice(0, 8)} -> ${newSha.slice(0, 8)}`);
  } catch {
    // Old commit may not have an origin note — that's fine
  }
}

/**
 * Process multiple rewrite mappings (e.g., from a rebase that rewrites many commits).
 * Reads old-sha new-sha pairs and copies notes for each.
 */
export function preserveAttributionBatch(repoPath: string, mappings: RewriteMapping[]): void {
  let preserved = 0;
  let skipped = 0;

  for (const { oldSha, newSha } of mappings) {
    try {
      preserveAttributionOnRewrite(repoPath, oldSha, newSha);
      preserved++;
    } catch {
      skipped++;
    }
  }

  if (preserved > 0) {
    debugLog(`Batch preservation complete: ${preserved} preserved, ${skipped} skipped`);
  }
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

/**
 * Detect if we're in a cherry-pick context and preserve attribution.
 * Checks for .git/CHERRY_PICK_HEAD which indicates an active cherry-pick.
 */
export function handleCherryPick(repoPath: string): void {
  const gitDir = getGitDir(repoPath);
  if (!gitDir) return;

  const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD');
  if (!fs.existsSync(cherryPickHead)) return;

  try {
    const originalSha = fs.readFileSync(cherryPickHead, 'utf-8').trim();
    if (!originalSha) return;

    // Get the newly created commit SHA
    const newSha = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (newSha && newSha !== originalSha) {
      preserveAttributionOnRewrite(repoPath, originalSha, newSha);
      debugLog(`Cherry-pick attribution preserved: ${originalSha.slice(0, 8)} -> ${newSha.slice(0, 8)}`);
    }
  } catch {
    // Non-fatal — attribution preservation is best-effort
  }
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
    'origin hooks git-post-rewrite "$@" &',
  ].join('\n') + '\n';

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes(ORIGIN_MARKER)) {
      // Already installed
      return;
    }
    // Append to existing hook
    fs.appendFileSync(hookPath, '\n' + ORIGIN_MARKER + '\n' + 'origin hooks git-post-rewrite "$@" &\n');
  } else {
    fs.writeFileSync(hookPath, hookScript);
  }

  fs.chmodSync(hookPath, '755');
}

/**
 * Install post-checkout hook for stash pop/apply operations.
 * Stash operations can create new commits that need attribution transfer.
 */
function installPostCheckoutHook(hooksDir: string): void {
  const hookPath = path.join(hooksDir, 'post-checkout');
  const ORIGIN_MARKER = '# origin-post-checkout';

  const hookScript = [
    '#!/bin/sh',
    ORIGIN_MARKER,
    '# Handle stash operations that may affect attribution',
    '# $1=prev-HEAD, $2=new-HEAD, $3=flag (1=branch checkout, 0=file checkout)',
    'if [ "$3" = "1" ]; then',
    '  origin hooks git-post-checkout "$@" &',
    'fi',
  ].join('\n') + '\n';

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (existing.includes(ORIGIN_MARKER)) {
      // Already installed
      return;
    }
    // Append to existing hook
    const append = [
      '',
      ORIGIN_MARKER,
      'if [ "$3" = "1" ]; then',
      '  origin hooks git-post-checkout "$@" &',
      'fi',
    ].join('\n') + '\n';
    fs.appendFileSync(hookPath, append);
  } else {
    fs.writeFileSync(hookPath, hookScript);
  }

  fs.chmodSync(hookPath, '755');
}

// ─── Stash Handling ────────────────────────────────────────────────────────

/**
 * Handle post-checkout events that may be triggered by stash operations.
 * Checks if the checkout was caused by a stash pop/apply and preserves attribution.
 */
export function handlePostCheckout(repoPath: string, prevHead: string, newHead: string): void {
  if (!prevHead || !newHead || prevHead === newHead) return;

  const gitDir = getGitDir(repoPath);
  if (!gitDir) return;

  // Check for stash-related refs
  try {
    // If there are stash entries, check if any of them match the transition
    const stashList = execSync('git stash list --format=%H', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!stashList) return;

    // The checkout after a stash pop changes HEAD — try to copy notes
    preserveAttributionOnRewrite(repoPath, prevHead, newHead);
  } catch {
    // Non-fatal
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

/**
 * Get the .git directory path for a repository.
 */
function getGitDir(repoPath: string): string | null {
  try {
    const gitDir = execSync('git rev-parse --git-dir', {
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
 * Escape a string for safe use as a shell argument.
 */
function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
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
