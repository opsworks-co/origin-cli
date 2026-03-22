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

if (!sessionId || !apiUrl || !apiKey || !pidFile) {
  process.exit(1);
}

// Write our PID so the main process can kill us
fs.writeFileSync(pidFile, String(process.pid));

const PING_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Check if a process is still alive (signal 0 = existence check).
 */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return true; // unknown parent — assume alive
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * End the session on the API when the agent process dies.
 * Cleans up state file so the next session-start doesn't find stale state.
 */
async function endSession() {
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
  // Clean up state file so next session starts fresh
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

    // If session state file was removed (session ended by hook), exit
    if (stateFile && !fs.existsSync(stateFile)) {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      process.exit(0);
    }

    await fetch(`${apiUrl}/api/mcp/session/${sessionId}/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
    });
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
