import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { preserveAttributionOnRewrite, handleCherryPick } from './history-preservation.js';
import { getGitRoot, getHeadSha } from './session-state.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ORIGIN_BIN_DIR = path.join(os.homedir(), '.origin', 'bin');
const WRAPPER_PATH = path.join(ORIGIN_BIN_DIR, 'git');
const REAL_GIT_MARKER = '.origin-real-git-path';
const KILL_SWITCH_PATH = path.join(os.homedir(), '.origin', 'proxy-disabled');

/**
 * Git commands that the proxy intercepts for attribution preservation.
 * Other commands pass through without any overhead.
 */
const INTERCEPTED_COMMANDS = new Set([
  'commit',
  'push',
  'rebase',
  'cherry-pick',
  'stash',
  'merge',
  'amend', // not a real git command but used via commit --amend
]);

// ─── Installation ──────────────────────────────────────────────────────────

/**
 * Install the git proxy wrapper.
 * Creates ~/.origin/bin/git that wraps the real git binary.
 *
 * The wrapper:
 *   1. Calls `origin hooks git-pre-command "$@"` before the real git
 *   2. Runs the real git command
 *   3. Calls `origin hooks git-post-command "$@"` after the real git
 *
 * IMPORTANT: This is opt-in only. Users must explicitly run `origin proxy install`.
 */
export function installProxy(): { success: boolean; message: string } {
  // Find the real git binary
  const realGitPath = findRealGit();
  if (!realGitPath) {
    return { success: false, message: 'Could not find the real git binary.' };
  }

  // Ensure directory exists
  if (!fs.existsSync(ORIGIN_BIN_DIR)) {
    fs.mkdirSync(ORIGIN_BIN_DIR, { recursive: true });
  }

  // Write the wrapper script
  const wrapperScript = generateWrapperScript(realGitPath);
  fs.writeFileSync(WRAPPER_PATH, wrapperScript);
  fs.chmodSync(WRAPPER_PATH, '755');

  // Store the real git path for reference
  fs.writeFileSync(path.join(ORIGIN_BIN_DIR, REAL_GIT_MARKER), realGitPath);

  // Remove kill switch if it exists
  try { fs.unlinkSync(KILL_SWITCH_PATH); } catch { /* ignore */ }

  return {
    success: true,
    message: `Git proxy installed at ${WRAPPER_PATH}.\n` +
      `Real git: ${realGitPath}\n\n` +
      `Add to your shell profile:\n` +
      `  export PATH="${ORIGIN_BIN_DIR}:$PATH"\n\n` +
      `To disable at any time:\n` +
      `  origin proxy uninstall\n` +
      `  # or emergency kill switch:\n` +
      `  touch ~/.origin/proxy-disabled`,
  };
}

/**
 * Uninstall the git proxy wrapper.
 * Removes ~/.origin/bin/git and the real git path marker.
 */
export function uninstallProxy(): { success: boolean; message: string } {
  let removed = false;

  try {
    if (fs.existsSync(WRAPPER_PATH)) {
      fs.unlinkSync(WRAPPER_PATH);
      removed = true;
    }
  } catch (err: any) {
    return { success: false, message: `Failed to remove wrapper: ${err.message}` };
  }

  try {
    const markerPath = path.join(ORIGIN_BIN_DIR, REAL_GIT_MARKER);
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch { /* non-fatal */ }

  if (removed) {
    return {
      success: true,
      message: `Git proxy removed.\n` +
        `You can also remove the PATH entry from your shell profile:\n` +
        `  Remove: export PATH="${ORIGIN_BIN_DIR}:$PATH"`,
    };
  }

  return { success: true, message: 'Git proxy was not installed.' };
}

/**
 * Check if the proxy is currently installed and active.
 */
export function isProxyInstalled(): boolean {
  return fs.existsSync(WRAPPER_PATH) && !fs.existsSync(KILL_SWITCH_PATH);
}

/**
 * Check the proxy status for display.
 */
export function getProxyStatus(): {
  installed: boolean;
  disabled: boolean;
  wrapperPath: string;
  realGitPath: string | null;
} {
  const installed = fs.existsSync(WRAPPER_PATH);
  const disabled = fs.existsSync(KILL_SWITCH_PATH);
  let realGitPath: string | null = null;

  try {
    const markerPath = path.join(ORIGIN_BIN_DIR, REAL_GIT_MARKER);
    if (fs.existsSync(markerPath)) {
      realGitPath = fs.readFileSync(markerPath, 'utf-8').trim();
    }
  } catch { /* ignore */ }

  return { installed, disabled, wrapperPath: WRAPPER_PATH, realGitPath };
}

// ─── Pre/Post Command Handlers ─────────────────────────────────────────────

/**
 * Handle pre-command event from the git proxy wrapper.
 * Called before the real git command executes.
 *
 * Captures state needed for post-command attribution (e.g., HEAD before rebase).
 */
export function handlePreCommand(args: string[]): void {
  if (isKillSwitchActive()) return;

  const command = args[0] || '';
  if (!isInterceptedCommand(command)) return;

  const repoPath = getGitRoot();
  if (!repoPath) return;

  try {
    // Store pre-command state for post-command comparison
    const headBefore = getHeadSha();
    if (headBefore) {
      const stateDir = path.join(os.homedir(), '.origin', 'proxy-state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'pre-command.json'),
        JSON.stringify({
          command,
          args,
          headBefore,
          repoPath,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  } catch {
    // Non-fatal — proxy should never break git
  }
}

/**
 * Handle post-command event from the git proxy wrapper.
 * Called after the real git command completes.
 *
 * Detects rewrites and preserves attribution.
 */
export function handlePostCommand(args: string[]): void {
  if (isKillSwitchActive()) return;

  const command = args[0] || '';
  if (!isInterceptedCommand(command)) return;

  const repoPath = getGitRoot();
  if (!repoPath) return;

  try {
    // Read pre-command state
    const stateFile = path.join(os.homedir(), '.origin', 'proxy-state', 'pre-command.json');
    if (!fs.existsSync(stateFile)) return;

    const preState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    const headAfter = getHeadSha();

    // Clean up state file
    try { fs.unlinkSync(stateFile); } catch { /* ignore */ }

    if (!headAfter || !preState.headBefore) return;

    // Handle based on command type
    switch (command) {
      case 'rebase':
        handlePostRebase(repoPath, preState.headBefore, headAfter);
        break;

      case 'cherry-pick':
        handleCherryPick(repoPath);
        break;

      case 'commit':
        // Check if this was an amend (--amend flag in args)
        if (args.includes('--amend')) {
          preserveAttributionOnRewrite(repoPath, preState.headBefore, headAfter);
        }
        break;

      case 'stash':
        // stash pop/apply may change HEAD
        if (args.includes('pop') || args.includes('apply')) {
          if (preState.headBefore !== headAfter) {
            preserveAttributionOnRewrite(repoPath, preState.headBefore, headAfter);
          }
        }
        break;

      case 'merge':
        // Merge creates new commits — attribution from merged branch carries over
        // via notes automatically; no special handling needed
        break;
    }

    debugLog(`post-command: ${command} ${preState.headBefore.slice(0, 8)} -> ${headAfter.slice(0, 8)}`);
  } catch {
    // Non-fatal — proxy should never break git
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

/**
 * Handle post-rebase: walk the reflog to find rewritten commits
 * and copy their Origin notes to the new SHAs.
 */
function handlePostRebase(repoPath: string, headBefore: string, headAfter: string): void {
  try {
    // Use git reflog to find the rewrite mapping
    // After a rebase, the reflog contains entries like:
    //   sha1 HEAD@{0}: rebase (finish): returning to refs/heads/branch
    //   sha2 HEAD@{1}: rebase (pick): commit message
    //   sha3 HEAD@{2}: rebase (start): checkout upstream

    const execOpts = {
      cwd: repoPath,
      encoding: 'utf-8' as const,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    };

    // Get commits between old HEAD and new HEAD
    // Old branch commits (before rebase)
    const oldCommits = execSync(
      `git rev-list ${headBefore} --not ${headAfter} 2>/dev/null || true`,
      execOpts,
    ).trim().split('\n').filter(Boolean);

    // New branch commits (after rebase)
    const newCommits = execSync(
      `git rev-list ${headAfter} --not ${headBefore} 2>/dev/null || true`,
      execOpts,
    ).trim().split('\n').filter(Boolean);

    // Match old to new by commit message (best effort)
    const oldMessages = new Map<string, string>();
    for (const sha of oldCommits) {
      try {
        const msg = execSync(`git log -1 --format=%s ${sha}`, execOpts).trim();
        oldMessages.set(msg, sha);
      } catch { /* skip */ }
    }

    for (const newSha of newCommits) {
      try {
        const msg = execSync(`git log -1 --format=%s ${newSha}`, execOpts).trim();
        const oldSha = oldMessages.get(msg);
        if (oldSha) {
          preserveAttributionOnRewrite(repoPath, oldSha, newSha);
        }
      } catch { /* skip */ }
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Generate the wrapper shell script that intercepts git commands.
 */
function generateWrapperScript(realGitPath: string): string {
  return [
    '#!/bin/sh',
    '# Origin git proxy wrapper — intercepts git commands for attribution preservation',
    '# To disable: touch ~/.origin/proxy-disabled',
    '# To uninstall: origin proxy uninstall',
    '',
    `REAL_GIT="${realGitPath}"`,
    'KILL_SWITCH="$HOME/.origin/proxy-disabled"',
    '',
    '# Kill switch — bypass proxy entirely',
    'if [ -f "$KILL_SWITCH" ]; then',
    '  exec "$REAL_GIT" "$@"',
    'fi',
    '',
    '# Pre-command hook (non-blocking, best-effort)',
    'origin hooks git-pre-command "$@" 2>/dev/null || true',
    '',
    '# Run the real git command',
    '"$REAL_GIT" "$@"',
    'GIT_EXIT_CODE=$?',
    '',
    '# Post-command hook (non-blocking, best-effort)',
    'if [ $GIT_EXIT_CODE -eq 0 ]; then',
    '  origin hooks git-post-command "$@" 2>/dev/null &',
    'fi',
    '',
    'exit $GIT_EXIT_CODE',
    '',
  ].join('\n');
}

/**
 * Find the real git binary, excluding our wrapper.
 */
function findRealGit(): string | null {
  try {
    // Use `which -a git` to find all git binaries, skip our wrapper
    const allGits = execSync('which -a git 2>/dev/null || command -v git', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    for (const gitPath of allGits) {
      const resolved = gitPath.trim();
      // Skip our own wrapper
      if (resolved === WRAPPER_PATH) continue;
      if (resolved.includes('.origin/bin/')) continue;

      // Verify it's actually executable
      try {
        fs.accessSync(resolved, fs.constants.X_OK);
        return resolved;
      } catch { continue; }
    }

    // Fallback: check common locations
    const commonPaths = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
    for (const p of commonPaths) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch { continue; }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if the given command is one we intercept.
 */
function isInterceptedCommand(command: string): boolean {
  return INTERCEPTED_COMMANDS.has(command);
}

/**
 * Check if the kill switch is active (file exists at ~/.origin/proxy-disabled).
 */
function isKillSwitchActive(): boolean {
  return fs.existsSync(KILL_SWITCH_PATH);
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
    fs.appendFileSync(logPath, `[${timestamp}] [git-proxy] ${message}\n`);
  } catch {
    // Never fail on logging
  }
}
