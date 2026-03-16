#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Origin CLI — Background Heartbeat Daemon
// ---------------------------------------------------------------------------
// Spawned as a detached child process on session-start.
// Pings the API every 30s to keep the session marked as RUNNING.
// Exits when the PID file is removed (session-end cleanup).
// ---------------------------------------------------------------------------

import fs from 'fs';

const args = process.argv.slice(2);
const sessionId = args[0];
const apiUrl = args[1];
const apiKey = args[2];
const pidFile = args[3];

if (!sessionId || !apiUrl || !apiKey || !pidFile) {
  process.exit(1);
}

// Write our PID so the main process can kill us
fs.writeFileSync(pidFile, String(process.pid));

const PING_INTERVAL_MS = 30_000; // 30 seconds

async function ping() {
  try {
    // If PID file is gone, session ended — exit
    if (!fs.existsSync(pidFile)) {
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
