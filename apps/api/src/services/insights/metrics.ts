// Pure metric functions for the Spend Quality dashboard.
//
// Why pure: every function takes plain data shapes (numbers, arrays of POJOs)
// and returns plain values. Routes do the DB query, hand the rows to these
// functions, and ship the result. Keeping the math here means
//   1. Unit tests are trivial — no DB, no mocks needed.
//   2. The same functions can later run on a CLI or a worker without
//      pulling in Prisma.
//   3. Threshold tuning happens in insights-config.ts only.

import { INSIGHTS_CONFIG } from './insights-config.js';

// ── Section 1: Spend Quality table ─────────────────────────────────────────

export interface PromptForAttribution {
  linesAdded: number;
  aiPercentage: number; // 0..100
}

/**
 * Weighted "AI authorship %" for a developer's prompts. Each prompt
 * contributes its `linesAdded` weight × `aiPercentage`. Returns a
 * fraction 0..1 (so the table can format it however it wants).
 *
 * Empty input or zero total lines → 0 (not NaN).
 *
 * Note: this is "authorship at write time" — *not* "kept after review".
 * The dashboard column is labeled "AI authorship %" and tooltips that
 * distinction. Persisting "kept" requires running attribution.ts on the
 * server side; out of scope for v1.
 */
export function computeAiAuthorship(prompts: PromptForAttribution[]): number {
  let totalLines = 0;
  let weighted = 0;
  for (const p of prompts) {
    if (p.linesAdded <= 0) continue;
    totalLines += p.linesAdded;
    weighted += p.linesAdded * (p.aiPercentage / 100);
  }
  if (totalLines === 0) return 0;
  return weighted / totalLines;
}

export interface PromptForRework {
  // ISO string is fine — comparison is via Date.parse below. We accept either
  // to keep callers honest about types they pull from Prisma.
  createdAt: Date | string;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Rework rate = fraction of a developer's prompts whose files were
 * touched by a *later* prompt within `reworkWindowDays` whose
 * `linesRemoved > 0` (someone deleting/rewriting work the dev did).
 *
 * O(n²) over a single dev's prompts — bounded by route-side caps. We
 * intentionally do not cross devs: "rewrites within 7d" is about a single
 * dev's churn, not collaboration.
 *
 * Returns a fraction 0..1.
 */
export function computeReworkRate(
  prompts: PromptForRework[],
  cfg: { reworkWindowDays: number } = INSIGHTS_CONFIG,
): number {
  if (prompts.length === 0) return 0;
  const windowMs = cfg.reworkWindowDays * 24 * 60 * 60 * 1000;
  const sorted = [...prompts]
    .map((p) => ({
      ...p,
      _t: p.createdAt instanceof Date ? p.createdAt.getTime() : Date.parse(p.createdAt as string),
    }))
    .sort((a, b) => a._t - b._t);

  let reworked = 0;
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (p.linesAdded <= 0) continue;
    const files = new Set(p.filesChanged);
    if (files.size === 0) continue;

    for (let j = i + 1; j < sorted.length; j++) {
      const q = sorted[j];
      if (q._t - p._t > windowMs) break; // sorted by time → stop scanning
      if (q.linesRemoved <= 0) continue;
      // any file overlap counts as rework
      if (q.filesChanged.some((f) => files.has(f))) {
        reworked++;
        break;
      }
    }
  }
  // Denominator: prompts that produced lines (could have been reworked).
  const eligible = sorted.filter((p) => p.linesAdded > 0).length;
  if (eligible === 0) return 0;
  return reworked / eligible;
}

export interface SessionForPr {
  userId: string;
  costUsd: number;
  commitSha: string;
}

export interface MergedPr {
  prNumber: number;
  // commitShas as parsed JSON array — route is responsible for parsing.
  commitShas: string[];
}

/**
 * Per-dev "$/PR merged" — total session cost attributable to merged PRs
 * divided by the count of distinct PRs the dev landed in.
 *
 * Attribution rule: a session's cost belongs to a PR iff the session's
 * commit SHA appears in that PR's commitShas array. A session linked to
 * multiple merged PRs is double-counted (rare in practice; documented).
 *
 * Returns null when the dev has zero merged PRs in the range — rendering
 * "—" is more honest than rendering "$0".
 */
export function computeCostPerMergedPr(
  userId: string,
  sessions: SessionForPr[],
  mergedPrs: MergedPr[],
): { totalCostUsd: number; mergedPrCount: number; costPerMergedPr: number | null } {
  const userSessions = sessions.filter((s) => s.userId === userId);
  if (userSessions.length === 0 || mergedPrs.length === 0) {
    return { totalCostUsd: 0, mergedPrCount: 0, costPerMergedPr: null };
  }

  const sessionShaToCost = new Map<string, number>();
  for (const s of userSessions) {
    if (!s.commitSha) continue;
    sessionShaToCost.set(s.commitSha, (sessionShaToCost.get(s.commitSha) || 0) + s.costUsd);
  }

  const matchedPrs = new Set<number>();
  let totalCostUsd = 0;
  for (const pr of mergedPrs) {
    let prCost = 0;
    for (const sha of pr.commitShas) {
      const c = sessionShaToCost.get(sha);
      if (c) prCost += c;
    }
    if (prCost > 0) {
      matchedPrs.add(pr.prNumber);
      totalCostUsd += prCost;
    }
  }

  const mergedPrCount = matchedPrs.size;
  if (mergedPrCount === 0) {
    return { totalCostUsd: 0, mergedPrCount: 0, costPerMergedPr: null };
  }
  return { totalCostUsd, mergedPrCount, costPerMergedPr: totalCostUsd / mergedPrCount };
}

// ── Section 2: Top expensive sessions ──────────────────────────────────────

export type SessionFlag = 'zero-commit' | 'cost-outlier';
// 'snapshot-restore' intentionally omitted — see schema audit; restore
// events are not persisted so we can't compute it server-side.

export interface SessionForFlag {
  costUsd: number;
  commitId: string | null;
}

export function flagSession(
  s: SessionForFlag,
  devAvgCostUsd: number,
  cfg: { expensiveSessionMultiplier: number } = INSIGHTS_CONFIG,
): SessionFlag[] {
  const flags: SessionFlag[] = [];
  if (s.commitId === null) flags.push('zero-commit');
  if (devAvgCostUsd > 0 && s.costUsd > devAvgCostUsd * cfg.expensiveSessionMultiplier) {
    flags.push('cost-outlier');
  }
  return flags;
}

// ── Section 3: Model-fit warnings ──────────────────────────────────────────

export interface SessionForModelFit {
  sessionId: string;
  model: string;
  costUsd: number;
  promptCount: number;
  filesTouched: number;
  commitId: string | null;
}

export interface ModelFitWarning {
  sessionId: string;
  modelUsed: string;
  suggestedModel: string;
  reason: 'oversized-for-cheap-task' | 'undersized-for-long-session';
  estimatedSavingsUsd: number;
}

const isOpus = (model: string) => /opus/i.test(model);
const isSonnet = (model: string) => /sonnet/i.test(model);

// Pick a versioned cheaper alternative for a flagship model. Used by the
// "Opus on a tiny task" branch so the suggestion is concrete (e.g.
// `claude-haiku-4-5`) rather than the vague `'claude-haiku'` the first
// version emitted. We try to keep the family version suffix the model
// already uses, so an org standardised on the 4-x family stays in family.
function pickCheaperAlternative(modelUsed: string): string {
  // Claude family: Opus → Haiku within the same major version when possible.
  // Match `claude-opus-4-7`, `claude-opus-4-6`, etc. and rewrite the slug.
  const claudeMatch = modelUsed.match(/^claude-opus-(\d+)(?:[-.](\d+))?/i);
  if (claudeMatch) {
    const major = claudeMatch[1];
    return `claude-haiku-${major}-5`;
  }
  if (isOpus(modelUsed)) return 'claude-haiku-4-5';
  // OpenAI flagship → mini equivalent.
  if (/^gpt-5/i.test(modelUsed)) return 'gpt-5-mini';
  if (/^gpt-4o/i.test(modelUsed)) return 'gpt-4o-mini';
  // Gemini flagship → Flash.
  if (/^gemini-.*-pro/i.test(modelUsed)) return modelUsed.replace(/pro/i, 'flash');
  // Fallback — generic Haiku slug. Better than the un-versioned one.
  return 'claude-haiku-4-5';
}

export function flagModelFit(
  s: SessionForModelFit,
  fullCfg: { modelFit: typeof INSIGHTS_CONFIG.modelFit } = INSIGHTS_CONFIG,
): ModelFitWarning | null {
  const cfg = fullCfg.modelFit;

  // "Opus on a tiny task" — all conditions inclusive
  if (
    isOpus(s.model) &&
    s.costUsd <= cfg.opusCheap.maxCostUsd &&
    s.promptCount <= cfg.opusCheap.maxPrompts &&
    s.filesTouched <= cfg.opusCheap.maxFilesChanged
  ) {
    return {
      sessionId: s.sessionId,
      modelUsed: s.model,
      suggestedModel: pickCheaperAlternative(s.model),
      reason: 'oversized-for-cheap-task',
      estimatedSavingsUsd: s.costUsd * cfg.opusCheap.savingsRatio,
    };
  }

  // "Sonnet over N prompts and produced no commit" — scope warning
  if (
    isSonnet(s.model) &&
    s.promptCount >= cfg.sonnetLong.minPrompts &&
    s.commitId === null
  ) {
    return {
      sessionId: s.sessionId,
      modelUsed: s.model,
      suggestedModel: 'reduce scope',
      reason: 'undersized-for-long-session',
      estimatedSavingsUsd: s.costUsd * cfg.sonnetLong.savingsRatio,
    };
  }

  return null;
}

// ── Section 4: Time heatmap ────────────────────────────────────────────────

export interface SessionForHeatmap {
  createdAt: Date;
  costUsd: number;
}

/**
 * Bucket sessions into a 7×24 grid keyed by (dayOfWeek, hour).
 * Uses local time of the *server* — same convention as existing dashboards.
 * Returns sparse cells (only buckets with data).
 */
export function bucketHeatmap(sessions: SessionForHeatmap[]): Array<{
  day: number; hour: number; costUsd: number; sessionCount: number;
}> {
  const buckets = new Map<string, { day: number; hour: number; costUsd: number; sessionCount: number }>();
  for (const s of sessions) {
    const day = s.createdAt.getDay();   // 0=Sun..6=Sat
    const hour = s.createdAt.getHours();
    const key = `${day}-${hour}`;
    const b = buckets.get(key);
    if (b) {
      b.costUsd += s.costUsd;
      b.sessionCount++;
    } else {
      buckets.set(key, { day, hour, costUsd: s.costUsd, sessionCount: 1 });
    }
  }
  return Array.from(buckets.values());
}

// ── Section 6: Token-class breakdown ───────────────────────────────────────

export interface TokenRowRaw {
  userId: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface TokenRow {
  userId: string;
  name: string;
  generatedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  // ratio of cacheReadTokens / generatedTokens, or 0 if generated is 0
  cacheReadRatio: number;
  isOutlier: boolean;
}

/**
 * Compute cache-read ratio per dev and flag outliers (> N× median).
 * "Generated" = inputTokens + outputTokens (the only tokens billed at full
 * price). Cache reads are billed at ~10%, cache writes at ~125%.
 *
 * Outlier flag only applied when there are at least 3 devs — for smaller
 * teams the median is meaningless.
 */
export function classifyTokenUsage(rows: TokenRowRaw[]): TokenRow[] {
  const enriched = rows.map((r) => {
    const generated = r.inputTokens + r.outputTokens;
    const ratio = generated > 0 ? r.cacheReadTokens / generated : 0;
    return {
      userId: r.userId,
      name: r.name,
      generatedTokens: generated,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      cacheReadRatio: ratio,
      isOutlier: false,
    };
  });

  if (enriched.length < 3) return enriched;

  // Median of non-zero ratios — if everyone has 0 cache reads, skip outlier
  // detection entirely (the whole org just isn't using caching).
  const ratios = enriched.map((r) => r.cacheReadRatio).filter((r) => r > 0).sort((a, b) => a - b);
  if (ratios.length === 0) return enriched;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid];
  if (median <= 0) return enriched;

  const threshold = median * INSIGHTS_CONFIG.cacheRatioOutlierMultiplier;
  for (const r of enriched) {
    if (r.cacheReadRatio > threshold) r.isOutlier = true;
  }
  return enriched;
}

// ── Date-range parsing ─────────────────────────────────────────────────────

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Parse a date range from query params. Supports either:
 *   - shorthand: ?range=7d|30d|90d
 *   - explicit:  ?from=ISO&to=ISO
 *   - neither:   default 30d
 *
 * Throws on malformed input — caller wraps in try/catch and returns 400.
 */
export function parseDateRange(query: { range?: unknown; from?: unknown; to?: unknown }): DateRange {
  const now = new Date();

  if (typeof query.from === 'string' || typeof query.to === 'string') {
    const from = typeof query.from === 'string' ? new Date(query.from) : new Date(now.getTime() - INSIGHTS_CONFIG.defaultRangeDays * 86_400_000);
    const to = typeof query.to === 'string' ? new Date(query.to) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new Error('Invalid from/to date');
    }
    if (from > to) throw new Error('from must be <= to');
    return { from, to };
  }

  const presets = INSIGHTS_CONFIG.rangePresets;
  const range = typeof query.range === 'string' ? query.range : `${INSIGHTS_CONFIG.defaultRangeDays}d`;
  const days = (presets as Record<string, number>)[range];
  if (typeof days !== 'number') {
    throw new Error(`Invalid range. Expected one of ${Object.keys(presets).join(', ')} or explicit from/to.`);
  }
  return { from: new Date(now.getTime() - days * 86_400_000), to: now };
}
