// ── Shared hook debug logger ────────────────────────────────────────────────
// Extracted from commands/hooks.ts so agent adapter modules (agents/*) can
// log to the same rotating ~/.origin/hooks.log without importing the hooks
// monolith. Never throws — logging must never break a hook.
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEBUG_LOG = path.join(os.homedir(), '.origin', 'hooks.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function rotateLogIfNeeded(logPath: string): void {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size >= LOG_MAX_BYTES) {
      fs.renameSync(logPath, logPath + '.old');
    }
  } catch {
    // File may not exist yet — that's fine
  }
}

export function debugLog(event: string, message: string, data?: any): void {
  try {
    rotateLogIfNeeded(DEBUG_LOG);
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] [${event}] ${message}`;
    if (data !== undefined) {
      line += ' ' + JSON.stringify(data, null, 0);
    }
    line += '\n';
    fs.appendFileSync(DEBUG_LOG, line, { mode: 0o600 });
  } catch {
    // Never fail on logging
  }
}

