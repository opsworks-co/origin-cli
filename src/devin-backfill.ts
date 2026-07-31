// Deferred backfill of Devin CLI turn data.
//
// Devin only writes its ATIF transcript when a conversation ENDS — verified on
// disk: `sweet-duck.json` appeared at 19:26, exactly when the NEXT conversation
// (`catkin-lamprey`) started, and the live conversation had no transcript file
// at all. So at Stop/SessionEnd time there is frequently nothing to read, and
// the turn lands with no assistant response, no tool count, and only a
// prompt-text token ESTIMATE (reported: a Devin session showing "32 tokens" and
// "No response or code changes captured").
//
// Fix: when a Devin turn ends without a transcript, queue a small record. The
// next Devin hook in ANY repo drains the queue — by then the conversation has
// ended and its transcript exists, so we recover the real model, token metrics,
// tool-call count and assistant output, and PATCH the (already-created) session.
//
// The queue lives outside the repo (~/.origin/devin-backfill) because the
// session's own state file is cleared when the session ends, which is precisely
// when the transcript becomes readable.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { discoverDevinCliSessionDataByPrompt } from './devin-cli.js';

const QUEUE_DIR = path.join(os.homedir(), '.origin', 'devin-backfill');

// Give up after a week — the transcript is never going to appear, and we must
// not accumulate junk in the queue forever.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Bound the work a single hook does: draining is best-effort and must never
// slow the agent down.
const MAX_DRAIN_PER_RUN = 10;

export interface DevinBackfillRecord {
  sessionId: string;
  prompts: string[];
  startedAt: string;
  queuedAt: string;
}

function safeName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Queue a Devin session whose transcript wasn't available when its turn ended. */
export function queueDevinBackfill(rec: Omit<DevinBackfillRecord, 'queuedAt'>): void {
  if (!rec.sessionId || rec.sessionId.startsWith('local-')) return;
  if (!rec.prompts || rec.prompts.length === 0) return;
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    const full: DevinBackfillRecord = { ...rec, queuedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(QUEUE_DIR, `${safeName(rec.sessionId)}.json`), JSON.stringify(full));
  } catch { /* best-effort */ }
}

export function listDevinBackfills(): Array<{ file: string; rec: DevinBackfillRecord }> {
  let names: string[] = [];
  try { names = fs.readdirSync(QUEUE_DIR); } catch { return []; }
  const out: Array<{ file: string; rec: DevinBackfillRecord }> = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(QUEUE_DIR, n);
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf-8')) as DevinBackfillRecord;
      if (rec && rec.sessionId && Array.isArray(rec.prompts)) out.push({ file, rec });
    } catch {
      try { fs.unlinkSync(file); } catch { /* ignore */ }  // malformed — drop it
    }
  }
  return out;
}

/** The PATCH body a recovered transcript produces, or null when it adds nothing. */
export function buildDevinBackfillPatch(
  rec: DevinBackfillRecord,
  discover = discoverDevinCliSessionDataByPrompt,
): Record<string, unknown> | null {
  const data = discover(rec.prompts, { since: rec.startedAt });
  if (!data) return null;
  const patch: Record<string, unknown> = {};
  if (data.model) patch.model = data.model;
  if (data.tokensUsed > 0) {
    patch.tokensUsed = data.tokensUsed;
    patch.inputTokens = data.inputTokens;
    patch.outputTokens = data.outputTokens;
    patch.cacheReadTokens = data.cacheReadTokens;
  }
  if (data.toolCalls > 0) patch.toolCalls = data.toolCalls;
  if (data.transcript) patch.transcript = data.transcript;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Drain the queue: for each pending Devin session whose transcript now exists,
 * PATCH the recovered data and drop the record. Expired records are discarded.
 * Fully guarded — a backfill failure must never break the hook that called it.
 */
export async function drainDevinBackfills(
  updateSession: (id: string, data: Record<string, unknown>) => Promise<unknown>,
  opts: { now?: number; log?: (msg: string, meta: Record<string, unknown>) => void } = {},
): Promise<{ patched: number; expired: number; pending: number }> {
  const now = opts.now ?? Date.now();
  const log = opts.log || (() => {});
  let patched = 0;
  let expired = 0;
  let pending = 0;

  const entries = listDevinBackfills();
  let processed = 0;
  for (const { file, rec } of entries) {
    const age = now - (Date.parse(rec.queuedAt) || now);
    if (age > MAX_AGE_MS) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      expired++;
      continue;
    }
    if (processed >= MAX_DRAIN_PER_RUN) { pending++; continue; }
    processed++;
    let patch: Record<string, unknown> | null = null;
    try {
      patch = buildDevinBackfillPatch(rec);
    } catch { patch = null; }
    if (!patch) { pending++; continue; }  // transcript still not written — retry later
    try {
      await updateSession(rec.sessionId, patch);
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      patched++;
      log('devin backfill applied', {
        sessionId: rec.sessionId,
        model: patch.model,
        tokensUsed: patch.tokensUsed,
        toolCalls: patch.toolCalls,
        hasTranscript: !!patch.transcript,
      });
    } catch (err: any) {
      // Leave the record so a later hook retries — unless the session is gone.
      if (/not found/i.test(String(err?.message || ''))) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        expired++;
      } else {
        pending++;
      }
    }
  }
  return { patched, expired, pending };
}

/** Test seam. */
export function __devinBackfillQueueDir(): string {
  return QUEUE_DIR;
}
