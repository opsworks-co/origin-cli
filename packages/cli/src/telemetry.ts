import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from './config.js';

// ─── Telemetry ────────────────────────────────────────────────────────────
//
// Fire-and-forget event tracking. Opt-in via config.telemetry.
// Events are queued to ~/.origin/telemetry-queue.json and flushed in batch.

const QUEUE_PATH = path.join(os.homedir(), '.origin', 'telemetry-queue.json');
const MAX_QUEUE_SIZE = 100;
const FLUSH_INTERVAL_MS = 60_000; // 1 minute
const FLUSH_TIMEOUT_MS = 5000;

interface TelemetryEvent {
  event: string;
  properties: Record<string, any>;
  timestamp: string;
}

interface TelemetryQueue {
  events: TelemetryEvent[];
}

/**
 * Track an event. Fire-and-forget — never throws, never blocks.
 * Respects config.telemetry opt-in setting.
 */
export function trackEvent(event: string, properties: Record<string, any> = {}): void {
  try {
    const config = loadConfig();
    if (!config?.telemetry) return; // Opt-in only

    const entry: TelemetryEvent = {
      event,
      properties: {
        ...properties,
        cliVersion: '0.1.0',
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
      timestamp: new Date().toISOString(),
    };

    // Append to queue
    const queue = loadQueue();
    queue.events.push(entry);

    // Trim if too large
    if (queue.events.length > MAX_QUEUE_SIZE) {
      queue.events = queue.events.slice(-MAX_QUEUE_SIZE);
    }

    saveQueue(queue);

    // Try to flush if queue is getting full
    if (queue.events.length >= 10) {
      flushQueue().catch(() => { /* ignore */ });
    }
  } catch {
    // Never fail on telemetry
  }
}

/**
 * Flush the telemetry queue to the API. Best-effort, never throws.
 */
export async function flushQueue(): Promise<void> {
  try {
    const config = loadConfig();
    if (!config?.telemetry || !config.apiUrl) return;

    const queue = loadQueue();
    if (queue.events.length === 0) return;

    const events = [...queue.events];

    // Clear queue first (optimistic)
    saveQueue({ events: [] });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);

    try {
      const res = await fetch(`${config.apiUrl}/api/telemetry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey,
        },
        body: JSON.stringify({
          orgId: config.orgId,
          machineId: config.machineId,
          events,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        // Put events back if send failed
        const currentQueue = loadQueue();
        currentQueue.events = [...events, ...currentQueue.events].slice(-MAX_QUEUE_SIZE);
        saveQueue(currentQueue);
      }
    } catch {
      clearTimeout(timeout);
      // Put events back on failure
      const currentQueue = loadQueue();
      currentQueue.events = [...events, ...currentQueue.events].slice(-MAX_QUEUE_SIZE);
      saveQueue(currentQueue);
    }
  } catch {
    // Never fail on telemetry
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function loadQueue(): TelemetryQueue {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
  } catch {
    return { events: [] };
  }
}

function saveQueue(queue: TelemetryQueue): void {
  try {
    const dir = path.dirname(QUEUE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue), { mode: 0o600 });
  } catch { /* best effort */ }
}
