// ── Webhook Delivery Queue ──────────────────────────────────────────────
// Persists incoming webhooks so they survive crashes, then processes them
// in the background with exponential backoff. GitHub/GitLab will give up
// retrying after a few minutes, so we own retry semantics from the moment
// we 200-OK the delivery.
//
// Backoff schedule (attempt → wait):
//   1 → 30s    2 → 2m    3 → 8m    4 → 30m    5 → 2h
// After maxAttempts (default 5), the row is marked DEAD.

import { prisma } from '../db.js';
import {
  processGitHubPush,
  processGitHubPR,
  processGitLabPush,
  processGitLabMR,
} from './webhook.js';

const POLL_INTERVAL_MS = 30 * 1000;       // poll queue every 30s
const CLAIM_BATCH_SIZE = 10;               // process up to 10 deliveries per tick
const STALE_PROCESSING_MS = 5 * 60 * 1000; // requeue stuck PROCESSING after 5 min

function backoffMs(attempt: number): number {
  // 30s, 2m, 8m, 30m, 2h, then capped
  const schedule = [30_000, 120_000, 480_000, 1_800_000, 7_200_000];
  return schedule[Math.min(attempt, schedule.length - 1)];
}

export interface EnqueueDeliveryInput {
  provider: 'github' | 'gitlab' | 'github-app';
  repoId?: string | null;
  event: string;
  payload: any;
  headers?: Record<string, any>;
}

/**
 * Persist a webhook for later processing. Returns immediately so the route
 * handler can 200-OK the provider before doing any real work.
 */
export async function enqueueDelivery(input: EnqueueDeliveryInput): Promise<string> {
  const row = await prisma.webhookDelivery.create({
    data: {
      provider: input.provider,
      repoId: input.repoId || null,
      event: input.event,
      payload: JSON.stringify(input.payload ?? {}),
      headers: JSON.stringify(input.headers ?? {}),
      status: 'PENDING',
    },
  });
  return row.id;
}

/**
 * Process a single delivery. Throws on failure so the caller can retry.
 */
async function processDelivery(deliveryId: string): Promise<void> {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) return;

  let payload: any;
  try {
    payload = JSON.parse(delivery.payload);
  } catch (err) {
    // Malformed stored payload — retrying won't help. Surface a distinctive
    // error so the outer tick can mark it DEAD fast rather than retrying 5x.
    throw new Error(`malformed payload JSON: ${(err as Error).message}`);
  }

  if (delivery.provider === 'github' || delivery.provider === 'github-app') {
    if (delivery.event === 'push' && delivery.repoId) {
      await processGitHubPush(delivery.repoId, payload);
    } else if (delivery.event === 'pull_request' && delivery.repoId) {
      await processGitHubPR(delivery.repoId, payload);
    }
    // Other events are no-ops; mark delivered.
  } else if (delivery.provider === 'gitlab') {
    if (delivery.event === 'push' && delivery.repoId) {
      await processGitLabPush(delivery.repoId, payload);
    } else if (delivery.event === 'merge_request' && delivery.repoId) {
      await processGitLabMR(delivery.repoId, payload);
    }
  }
}

async function tickQueue(): Promise<void> {
  // Reclaim stale PROCESSING rows (worker likely crashed)
  const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  await prisma.webhookDelivery.updateMany({
    where: { status: 'PROCESSING', updatedAt: { lt: staleCutoff } },
    data: { status: 'PENDING' },
  });

  // Find ready deliveries
  const ready = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: CLAIM_BATCH_SIZE,
  });

  for (const delivery of ready) {
    // Claim
    const claimed = await prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue; // someone else got it

    try {
      await processDelivery(delivery.id);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
      });
    } catch (err) {
      const message = (err as Error).message?.slice(0, 500) || 'unknown error';
      const nextAttempts = delivery.attempts + 1;
      const isDead = nextAttempts >= delivery.maxAttempts;
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: isDead ? 'DEAD' : 'FAILED',
          lastError: message,
          nextAttemptAt: isDead ? delivery.nextAttemptAt : new Date(Date.now() + backoffMs(nextAttempts)),
        },
      });
      console.error(
        `[webhook-queue] delivery ${delivery.id} ${isDead ? 'DEAD' : 'FAILED'} (attempt ${nextAttempts}): ${message}`
      );
    }
  }
}

let started = false;
// In-process re-entrancy guard: if a single tick takes longer than
// POLL_INTERVAL_MS (slow network, big batch, DB hiccup) the interval
// would otherwise start a second tick while the first is still running
// inside the same Node process. The DB-level claim is still safe, but
// two concurrent ticks waste DB roundtrips and interleave logs. Skip
// the new tick if the old one hasn't returned yet.
let ticking = false;

async function safeTickQueue(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await tickQueue();
  } catch (err) {
    console.error('[webhook-queue] tick error:', err);
  } finally {
    ticking = false;
  }
}

export function startWebhookQueue(): void {
  if (started) return;
  started = true;
  console.log('🔁 Webhook delivery queue started');
  // .unref() so the poller does not keep the Node event loop alive during
  // graceful shutdown — otherwise rolling deploys exceed termination grace
  // and get SIGKILL'd mid-delivery.
  setInterval(safeTickQueue, POLL_INTERVAL_MS).unref();
  // Run once immediately on boot
  safeTickQueue();
}
