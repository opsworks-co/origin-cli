#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Origin CLI — Background Heartbeat Daemon
// ---------------------------------------------------------------------------
// Spawned as a detached child process on session-start.
// Pings the API every 30s to keep the session marked as RUNNING.
// Exits when:
//   - PID file is removed (session-end cleanup)
//   - Parent agent process is no longer alive (Ctrl+C, terminal closed)
//   - Session state file is gone (session ended by another hook)
//   - 24 hours elapsed (safety net)
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const args = process.argv.slice(2);
const sessionId = args[0];
const apiUrl = args[1];
const apiKey = process.env.ORIGIN_HEARTBEAT_API_KEY || args[2];
const pidFile = args[3];
const parentPid = args[4] ? parseInt(args[4], 10) : 0;
const stateFile = args[5] || '';

if (!sessionId || !pidFile) {
  process.exit(1);
}
const isConnected = !!(apiUrl && apiKey);

// Write our PID so the main process can kill us
fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });

const PING_INTERVAL_MS = 30_000; // 30 seconds
// For agents where we can't detect parent PID (Cursor, Codex), we fall back to
// state file freshness. Use a long threshold — the heartbeat should keep running
// as long as the editor/terminal is open. Sessions stay IDLE on the dashboard
// until the heartbeat dies (app closed) or the agent explicitly ends the session.
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours — safety net only

/**
 * Check if a process is still alive (signal 0 = existence check).
 */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false; // unknown parent — can't verify, use stale check instead
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the session state file was recently updated.
 * Only used as safety net for agents where parent PID is unknown (Cursor, Codex).
 * Uses 2-hour threshold to avoid killing sessions during long idle periods.
 */
function isStateFileStale(): boolean {
  if (!stateFile) return false; // can't check without state file
  try {
    const stat = fs.statSync(stateFile);
    const age = Date.now() - stat.mtimeMs;
    return age > STALE_THRESHOLD_MS;
  } catch {
    return true; // file gone = session ended
  }
}

/**
 * Read the agent's current git branch from the session's repo path.
 * Hooks fire on prompt-submit which Gemini/Codex/etc don't always trigger,
 * so the heartbeat reports branch every 30s as a backstop — keeps the
 * dashboard in sync after a mid-session `git checkout`.
 */
function getCurrentBranch(): string | null {
  if (!stateFile) return null;
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const state = JSON.parse(raw) as { repoPath?: string };
    const repoPath = state.repoPath;
    if (!repoPath) return null;
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Report command execution result back to the dashboard.
 */
async function reportResult(type: string, status: 'success' | 'failed', message: string) {
  if (!isConnected) return;
  try {
    await fetch(`${apiUrl}/api/mcp/session/${sessionId}/command-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ type, status, message }),
    });
  } catch { /* ignore */ }
}

/**
 * Handle a branch command from the dashboard.
 * Creates a new branch at the snapshot's commit, optionally checks it out.
 * Non-destructive by default — doesn't touch current HEAD or working tree.
 */
async function handleBranch(command: { commitSha?: string; branchName?: string; checkout?: boolean }) {
  let repoPath = '';
  if (stateFile) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      repoPath = state.repoPath || '';
    } catch { /* ignore */ }
  }
  if (!repoPath) {
    await reportResult('branch', 'failed', 'Could not resolve repo path from session state');
    return;
  }
  if (!command.commitSha || !/^[a-fA-F0-9]+$/.test(command.commitSha)) {
    await reportResult('branch', 'failed', 'Invalid or missing commit SHA');
    return;
  }

  const gitOpts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: 'pipe' as const, timeout: 15000 };

  try {
    // Generate branch name if not provided
    const shortSha = command.commitSha.slice(0, 7);
    const sanitizedName = (command.branchName || `snapshot-${shortSha}`)
      .replace(/[^a-zA-Z0-9/_-]/g, '-')
      .slice(0, 80);

    // Create the branch pointing to the commit (no checkout by default)
    execFileSync('git', ['branch', sanitizedName, command.commitSha], gitOpts);

    let msg = `Created branch "${sanitizedName}" at commit ${shortSha}.`;

    // Optionally check it out
    if (command.checkout) {
      // Stash uncommitted work first so we don't lose anything
      let stashed = false;
      try {
        const dirty = execFileSync('git', ['status', '--porcelain'], gitOpts).trim();
        if (dirty) {
          execFileSync('git', ['stash', 'push', '-u', '-m', `origin-branch-autostash-${Date.now()}`], gitOpts);
          stashed = true;
        }
      } catch { /* ignore */ }

      try {
        execFileSync('git', ['checkout', sanitizedName], gitOpts);
        msg += ` Checked out.${stashed ? ' Uncommitted changes stashed.' : ''}`;
      } catch (err: any) {
        if (stashed) {
          try { execFileSync('git', ['stash', 'pop'], gitOpts); } catch { /* ignore */ }
        }
        msg += ` Could not checkout: ${err?.message || 'unknown error'}`;
      }
    } else {
      msg += ` Run "git checkout ${sanitizedName}" when ready.`;
    }

    await reportResult('branch', 'success', msg);
  } catch (err: any) {
    const errMsg = err?.message || 'Unknown error';
    // Common case: branch already exists
    if (errMsg.includes('already exists')) {
      await reportResult('branch', 'failed', `Branch already exists. Try a different name.`);
    } else {
      await reportResult('branch', 'failed', errMsg);
    }
  }
}

/**
 * Handle a restore command from the dashboard.
 * Creates a new branch at the snapshot's commit so HEAD moves cleanly
 * and the user's current branch is preserved.
 */
async function handleRestore(command: { treeSha?: string; commitSha?: string }) {
  // Get repo path from state file
  let repoPath = '';
  if (stateFile) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      repoPath = state.repoPath || '';
    } catch { /* ignore */ }
  }
  if (!repoPath) {
    await reportResult('restore', 'failed', 'Could not resolve repo path from session state');
    return;
  }

  const sha = command.commitSha || command.treeSha;
  if (!sha || !/^[a-fA-F0-9]+$/.test(sha)) {
    await reportResult('restore', 'failed', 'Invalid or missing SHA');
    return;
  }

  const gitOpts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: 'pipe' as const, timeout: 15000 };

  try {
    // Get current branch (fallback to HEAD sha if detached)
    let originalBranch = '';
    try {
      originalBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts).trim();
    } catch { /* ignore */ }

    // Stash any uncommitted work so we don't lose it
    let stashed = false;
    try {
      const dirty = execFileSync('git', ['status', '--porcelain'], gitOpts).trim();
      if (dirty) {
        execFileSync('git', ['stash', 'push', '-u', '-m', `origin-restore-autostash-${Date.now()}`], gitOpts);
        stashed = true;
      }
    } catch { /* ignore */ }

    // If we have a commit SHA, branch off of it. Otherwise use tree SHA (still does soft restore).
    if (command.commitSha) {
      const branchName = `origin-restore-${command.commitSha.slice(0, 7)}-${Date.now().toString(36)}`;
      try {
        execFileSync('git', ['checkout', '-b', branchName, command.commitSha], gitOpts);
      } catch (err: any) {
        // Restore stash if checkout failed
        if (stashed) {
          try { execFileSync('git', ['stash', 'pop'], gitOpts); } catch { /* ignore */ }
        }
        throw err;
      }

      // Write marker file
      const markerPath = path.join(repoPath, '.git', 'origin-restore-marker');
      fs.writeFileSync(markerPath, JSON.stringify({
        restoredAt: new Date().toISOString(),
        commitSha: command.commitSha,
        branch: branchName,
        originalBranch,
        stashed,
        sessionId,
      }), { mode: 0o600 });

      const msg = `Checked out branch "${branchName}" at commit ${command.commitSha.slice(0, 7)}. ` +
        (originalBranch ? `Original branch "${originalBranch}" preserved. ` : '') +
        (stashed ? 'Uncommitted changes stashed. ' : '') +
        `Run "git checkout ${originalBranch || 'main'}" to return.`;
      await reportResult('restore', 'success', msg);
      return;
    }

    // Fallback: no commitSha, only treeSha — do soft restore (working tree only)
    const treeSha = command.treeSha!;
    execFileSync('git', ['read-tree', treeSha], gitOpts);
    execFileSync('git', ['checkout-index', '-a', '-f'], gitOpts);
    execFileSync('git', ['read-tree', 'HEAD'], gitOpts);

    const markerPath = path.join(repoPath, '.git', 'origin-restore-marker');
    fs.writeFileSync(markerPath, JSON.stringify({
      restoredAt: new Date().toISOString(),
      treeSha,
      sessionId,
      mode: 'soft',
    }), { mode: 0o600 });

    await reportResult('restore', 'success',
      `Soft-restored files to tree ${treeSha.slice(0, 7)}. HEAD unchanged — use "git diff" to review or "git checkout ." to revert.`);
  } catch (err: any) {
    await reportResult('restore', 'failed', err?.message || 'Unknown error during restore');
  }
}

/**
 * End the session on the API when the agent process dies.
 * Cleans up state file so the next session-start doesn't find stale state.
 */
async function endSession() {
  // Read state file to send accumulated data with end request
  let stateData: any = null;
  if (stateFile) {
    try {
      const raw = fs.readFileSync(stateFile, 'utf-8');
      stateData = JSON.parse(raw);
    } catch { /* best effort */ }
  }

  // Archive state file to ~/.origin/sessions/ before deleting
  if (stateData) {
    try {
      stateData.status = 'ENDED';
      stateData.endedAt = new Date().toISOString();
      const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
      const archiveDir = `${homeDir}/.origin/sessions`;
      fs.mkdirSync(archiveDir, { recursive: true });
      const archivePath = `${archiveDir}/${(stateData.sessionId || sessionId).slice(0, 12)}.json`;
      fs.writeFileSync(archivePath, JSON.stringify(stateData), { mode: 0o600 });
    } catch { /* best effort */ }
  }

  // End on API if connected — include accumulated prompt/session data
  if (apiKey && apiUrl) {
    try {
      const endPayload: any = { sessionId };

      if (stateData) {
        // Send prompts accumulated during the session
        const prompts: string[] = stateData.prompts || [];
        if (prompts.length > 0) {
          endPayload.prompt = prompts.join('\n\n---\n\n');
        }

        // Send duration
        if (stateData.startedAt) {
          const durationMs = Date.now() - new Date(stateData.startedAt).getTime();
          if (durationMs > 0) endPayload.durationMs = durationMs;
        }

        // Send model if known
        if (stateData.model && stateData.model !== 'unknown' && stateData.model !== 'default') {
          // Don't overwrite — server already has model from updateSession calls
        }

        // Use saved per-prompt mappings (from stop handler) if available.
        // Only build empty fallback if no real mappings exist — avoids
        // overwriting real diffs that stop already sent to the API.
        const savedMappings = stateData.completedPromptMappings;
        if (savedMappings && Array.isArray(savedMappings) && savedMappings.length > 0) {
          endPayload.promptChanges = savedMappings;
        } else if (prompts.length > 0) {
          endPayload.promptChanges = prompts.map((p: string, i: number) => ({
            promptIndex: i,
            promptText: p.slice(0, 1000),
            filesChanged: [],
            diff: '',
          }));
        }
      }

      await fetch(`${apiUrl}/api/mcp/session/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(endPayload),
      });
    } catch { /* best effort */ }
  }

  // Clean up ALL state files for this session (multiple hooks can create duplicates)
  if (stateFile) {
    try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
    // Also clean sibling state files with the same session ID in the same directory
    try {
      // path.dirname handles all edge cases (windows paths, missing
      // separator, trailing slash). The old stateFile.lastIndexOf('/')
      // returned -1 on any path without '/', which then produced
      // substring(0, -1) === '' and readdirSync('') scanned cwd.
      const dir = path.dirname(stateFile);
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          try {
            const filePath = path.join(dir, entry);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.sessionId === sessionId) {
              fs.unlinkSync(filePath);
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
  }
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
}

async function ping() {
  try {
    // If PID file is gone, session ended — exit
    if (!fs.existsSync(pidFile)) {
      process.exit(0);
    }

    // If parent agent process died, end the session and exit
    if (parentPid > 0 && !isProcessAlive(parentPid)) {
      await endSession();
      process.exit(0);
    }

    // If we couldn't find the parent PID (common for Codex/Cursor), fall back
    // to state file freshness — if no prompt activity for 5 minutes, agent is dead
    if (parentPid <= 0 && isStateFileStale()) {
      await endSession();
      process.exit(0);
    }

    // If session state file was removed (session ended by hook), exit
    if (stateFile && !fs.existsSync(stateFile)) {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      process.exit(0);
    }

    // Only ping API in connected mode
    if (isConnected) {
      const resp = await fetch(`${apiUrl}/api/mcp/session/${sessionId}/ping`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ branch: getCurrentBranch() }),
      });
      const data = await resp.json() as { ok: boolean; status?: string; command?: any };

      // Handle pending commands from the dashboard
      if (data.command && data.command.type === 'restore') {
        handleRestore(data.command);
      }
      if (data.command && data.command.type === 'branch') {
        handleBranch(data.command);
      }

      // If server says session is ended/completed, self-terminate
      if (data.status && data.status !== 'RUNNING') {
        // Clean up PID and state files
        try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
        if (stateFile) {
          try {
            const raw = fs.readFileSync(stateFile, 'utf-8');
            const state = JSON.parse(raw);
            state.status = 'ENDED';
            state.endedAt = new Date().toISOString();
            const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
            const archiveDir = `${homeDir}/.origin/sessions`;
            fs.mkdirSync(archiveDir, { recursive: true });
            fs.writeFileSync(`${archiveDir}/${(state.sessionId || sessionId).slice(0, 12)}.json`, JSON.stringify(state), { mode: 0o600 });
          } catch { /* best effort */ }
          try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
        }
        process.exit(0);
      }
    }
  } catch {
    // Silently ignore network errors — will retry next interval
  }
}

// Initial ping
ping();

// Ping every 30s
const interval = setInterval(ping, PING_INTERVAL_MS);

// Clean exit on signals — always call endSession so the server knows
async function signalExit() {
  clearInterval(interval);
  await endSession();
  process.exit(0);
}
process.on('SIGTERM', signalExit);
process.on('SIGINT', signalExit);
process.on('SIGHUP', signalExit);

// Safety: auto-exit after 24 hours (prevents zombie processes)
setTimeout(() => { clearInterval(interval); process.exit(0); }, 24 * 60 * 60 * 1000);
