// Recompute CodingSession.costUsd from the row's token counts using the
// current pricing table. Useful when old sessions were stamped with a
// stale or buggy cost (e.g. before the Opus pricing fix that brought
// $5/$25 → $15/$75 per 1M tokens). Idempotent: a session whose stored
// cost already matches the recompute is skipped.
//
// Mirrors packages/cli/src/transcript.ts estimateCost(). When that table
// changes, update both — there is no shared module yet.

import { prisma } from '../db.js';

type ModelPricing = Record<string, { input: number; output: number }>;

const DEFAULT_MODEL_PRICING: ModelPricing = {
  'sonnet': { input: 3,    output: 15 },
  'opus':   { input: 15,   output: 75 },
  'haiku':  { input: 0.80, output: 4  },
  'gemini-2.5-pro':        { input: 1.25, output: 10 },
  'gemini-2.5-flash':      { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-3-pro':          { input: 1.25, output: 10 },
  'gemini-3-flash':        { input: 0.15, output: 0.60 },
  'gemini-2.0-flash':      { input: 0.10, output: 0.40 },
  'gemini-2.0':            { input: 0.10, output: 0.40 },
  'gpt-4o':         { input: 2.50, output: 10 },
  'gpt-4o-mini':    { input: 0.15, output: 0.60 },
  'o1':       { input: 15,   output: 60 },
  'o3':       { input: 10,   output: 40 },
  'o3-mini':  { input: 1.10, output: 4.40 },
  'o4-mini':  { input: 1.10, output: 4.40 },
  'gpt-5':    { input: 2.00, output: 8.00 },
  'gpt-5.3':  { input: 2.00, output: 8.00 },
  'gpt-5.4':  { input: 3.00, output: 12.00 },
  'codex':    { input: 2.00, output: 8.00 },
  'cursor':   { input: 3,    output: 15 },
  'composer': { input: 2.50, output: 10.00 },
};

const SORTED_KEYS = Object.keys(DEFAULT_MODEL_PRICING).sort((a, b) => b.length - a.length);

function priceFor(model: string): { input: number; output: number } {
  const lower = (model || '').toLowerCase();
  for (const key of SORTED_KEYS) {
    if (lower.includes(key)) return DEFAULT_MODEL_PRICING[key];
  }
  return DEFAULT_MODEL_PRICING['sonnet']; // safe default — Claude Sonnet
}

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  const p = priceFor(model);
  const inputCost = (inputTokens / 1_000_000) * p.input;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * (p.input * 0.1);
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * (p.input * 1.25);
  const outputCost = (outputTokens / 1_000_000) * p.output;
  return parseFloat((inputCost + cacheReadCost + cacheCreationCost + outputCost).toFixed(4));
}

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
