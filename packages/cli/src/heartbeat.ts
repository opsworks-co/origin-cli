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

const args = process.argv.slice(2);
const sessionId = args[0];
const apiUrl = args[1];
const apiKey = args[2];
const pidFile = args[3];
const parentPid = args[4] ? parseInt(args[4], 10) : 0;
const stateFile = args[5] || '';

if (!sessionId || !pidFile) {
  process.exit(1);
}
const isConnected = !!(apiUrl && apiKey);

// Write our PID so the main process can kill us
fs.writeFileSync(pidFile, String(process.pid));

const PING_INTERVAL_MS = 30_000; // 30 seconds
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without state file update = stale

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
 * Each prompt submission updates the state file, so if it hasn't been
 * touched in 5 minutes, the agent is likely dead.
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
 * End the session on the API when the agent process dies.
 * Cleans up state file so the next session-start doesn't find stale state.
 */
async function endSession() {
  // Archive state file to ~/.origin/sessions/ before deleting
  if (stateFile) {
    try {
      const raw = fs.readFileSync(stateFile, 'utf-8');
      const state = JSON.parse(raw);
      state.status = 'ENDED';
      state.endedAt = new Date().toISOString();
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
      const archiveDir = `${homeDir}/.origin/sessions`;
      fs.mkdirSync(archiveDir, { recursive: true });
      const archivePath = `${archiveDir}/${(state.sessionId || sessionId).slice(0, 12)}.json`;
      fs.writeFileSync(archivePath, JSON.stringify(state));
    } catch { /* best effort */ }
  }

  // End on API if connected
  if (apiKey && apiUrl) {
    try {
      await fetch(`${apiUrl}/api/mcp/session/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ sessionId }),
      });
    } catch { /* best effort */ }
  }

  // Clean up active state file
  if (stateFile) {
    try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
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
      await fetch(`${apiUrl}/api/mcp/session/${sessionId}/ping`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
      });
    }
  } catch {
    // Silently ignore network errors — will retry next interval
  }
}

// Initial ping
ping();

// Ping every 30s
const interval = setInterval(ping, PING_INTERVAL_MS);

// Clean exit on signals
process.on('SIGTERM', () => { clearInterval(interval); process.exit(0); });
process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });

// Safety: auto-exit after 24 hours (prevents zombie processes)
setTimeout(() => { clearInterval(interval); process.exit(0); }, 24 * 60 * 60 * 1000);
