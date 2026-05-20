// Recompute CodingSession.costUsd from the row's token counts using the
// current pricing table. Useful when old sessions were stamped with a
// stale or buggy cost (e.g. before the Opus pricing fix that brought
// $5/$25 → $15/$75 per 1M tokens). Idempotent: a session whose stored
// cost already matches the recompute is skipped.

import { prisma } from '../db.js';
import { estimateCost } from '../utils/pricing.js';

export interface RecomputeResult {
  scanned: number;
  updated: number;
  unchanged: number;
  skipped: number;          // missing token data → can't recompute
  totalCostBefore: number;
  totalCostAfter: number;
  // Top 10 deltas, sorted by absolute change. Helps users spot whether
  // the recompute moved any session significantly (and which model).
  topChanges: Array<{
    sessionId: string;
    model: string;
    before: number;
    after: number;
    delta: number;
  }>;
}

/**
 * Recompute every CodingSession.costUsd in the org from stored token
 * counts. Sessions with no token data (Codex without rollout, etc.) are
 * skipped — we don't have data to recompute from.
 */
export async function recomputeOrgSessionCosts(orgId: string, opts: { dryRun?: boolean } = {}): Promise<RecomputeResult> {
  const sessions = await prisma.codingSession.findMany({
    where: { commit: { repo: { orgId } } },
    select: {
      id: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheCreationTokens: true,
      costUsd: true,
    },
    take: 100_000,
  });

  const result: RecomputeResult = {
    scanned: sessions.length,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    totalCostBefore: 0,
    totalCostAfter: 0,
    topChanges: [],
  };

  const changes: Array<{ sessionId: string; model: string; before: number; after: number; delta: number }> = [];

  for (const s of sessions) {
    result.totalCostBefore += s.costUsd || 0;
    const totalTokens = (s.inputTokens || 0) + (s.outputTokens || 0) + (s.cacheReadTokens || 0) + (s.cacheCreationTokens || 0);
    if (totalTokens === 0) {
      result.skipped++;
      result.totalCostAfter += s.costUsd || 0; // preserve
      continue;
    }
    const newCost = estimateCost(
      s.model || 'sonnet',
      s.inputTokens || 0,
      s.outputTokens || 0,
      s.cacheReadTokens || 0,
      s.cacheCreationTokens || 0,
    );
    result.totalCostAfter += newCost;
    const before = s.costUsd || 0;
    const delta = newCost - before;
    if (Math.abs(delta) < 0.005) {
      result.unchanged++;
      continue;
    }
    changes.push({
      sessionId: s.id,
      model: s.model || 'unknown',
      before: parseFloat(before.toFixed(4)),
      after: newCost,
      delta: parseFloat(delta.toFixed(4)),
    });
    if (!opts.dryRun) {
      try {
        await prisma.codingSession.update({
          where: { id: s.id },
          data: { costUsd: newCost },
        });
        result.updated++;
      } catch (err: any) {
        console.error('[cost-recompute] update failed', s.id, err?.message);
      }
    } else {
      result.updated++;
    }
  }

  // Pick top 10 absolute deltas for the response
  changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  result.topChanges = changes.slice(0, 10);

  result.totalCostBefore = parseFloat(result.totalCostBefore.toFixed(2));
  result.totalCostAfter = parseFloat(result.totalCostAfter.toFixed(2));
  return result;
}
