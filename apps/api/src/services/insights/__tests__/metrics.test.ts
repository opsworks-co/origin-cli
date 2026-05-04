import { describe, it, expect } from 'vitest';
import {
  computeAiAuthorship,
  computeReworkRate,
  computeCostPerMergedPr,
  flagSession,
  flagModelFit,
  bucketHeatmap,
  classifyTokenUsage,
  parseDateRange,
} from '../metrics.js';
import { INSIGHTS_CONFIG } from '../insights-config.js';

describe('computeAiAuthorship', () => {
  it('returns 0 for empty input', () => {
    expect(computeAiAuthorship([])).toBe(0);
  });

  it('returns 0 when all prompts have zero linesAdded', () => {
    expect(computeAiAuthorship([
      { linesAdded: 0, aiPercentage: 100 },
      { linesAdded: 0, aiPercentage: 50 },
    ])).toBe(0);
  });

  it('returns weighted average — equal weights', () => {
    // 100 lines @ 100% ai + 100 lines @ 0% ai = 50%
    const r = computeAiAuthorship([
      { linesAdded: 100, aiPercentage: 100 },
      { linesAdded: 100, aiPercentage: 0 },
    ]);
    expect(r).toBe(0.5);
  });

  it('returns weighted average — unequal weights', () => {
    // 90 lines @ 100% + 10 lines @ 0% = 90%
    const r = computeAiAuthorship([
      { linesAdded: 90, aiPercentage: 100 },
      { linesAdded: 10, aiPercentage: 0 },
    ]);
    expect(r).toBeCloseTo(0.9, 5);
  });

  it('ignores zero-line prompts in the denominator', () => {
    // 50 lines @ 80% + a zero-line 0% prompt → still 80%
    const r = computeAiAuthorship([
      { linesAdded: 50, aiPercentage: 80 },
      { linesAdded: 0, aiPercentage: 0 },
    ]);
    expect(r).toBeCloseTo(0.8, 5);
  });
});

describe('computeReworkRate', () => {
  const T0 = new Date('2026-04-01T00:00:00Z').getTime();
  const day = (n: number) => new Date(T0 + n * 86_400_000).toISOString();

  it('returns 0 for empty input', () => {
    expect(computeReworkRate([])).toBe(0);
  });

  it('returns 0 when no later prompt removes lines', () => {
    expect(computeReworkRate([
      { createdAt: day(0), filesChanged: ['a.ts'], linesAdded: 10, linesRemoved: 0 },
      { createdAt: day(1), filesChanged: ['a.ts'], linesAdded: 5,  linesRemoved: 0 },
    ])).toBe(0);
  });

  it('flags rework when later prompt within window touches same file with linesRemoved > 0', () => {
    const r = computeReworkRate([
      { createdAt: day(0), filesChanged: ['a.ts'], linesAdded: 10, linesRemoved: 0 },
      { createdAt: day(2), filesChanged: ['a.ts'], linesAdded: 0,  linesRemoved: 8 },
      { createdAt: day(3), filesChanged: ['b.ts'], linesAdded: 5,  linesRemoved: 0 },
    ]);
    // 1 rework / 2 eligible = 0.5
    expect(r).toBe(0.5);
  });

  it('does NOT flag rework outside the 7d window', () => {
    expect(computeReworkRate([
      { createdAt: day(0), filesChanged: ['a.ts'], linesAdded: 10, linesRemoved: 0 },
      { createdAt: day(8), filesChanged: ['a.ts'], linesAdded: 0,  linesRemoved: 8 },
    ])).toBe(0);
  });

  it('does NOT flag rework when files do not overlap', () => {
    expect(computeReworkRate([
      { createdAt: day(0), filesChanged: ['a.ts'], linesAdded: 10, linesRemoved: 0 },
      { createdAt: day(1), filesChanged: ['b.ts'], linesAdded: 0,  linesRemoved: 8 },
    ])).toBe(0);
  });
});

describe('computeCostPerMergedPr', () => {
  it('returns null when dev has no merged PRs', () => {
    const r = computeCostPerMergedPr('u1', [], []);
    expect(r.costPerMergedPr).toBeNull();
    expect(r.mergedPrCount).toBe(0);
  });

  it('attributes session cost to PR via commit SHA match', () => {
    const sessions = [
      { userId: 'u1', costUsd: 10, commitSha: 'abc' },
      { userId: 'u1', costUsd: 5,  commitSha: 'def' },
      { userId: 'u2', costUsd: 99, commitSha: 'abc' }, // wrong dev — ignored
    ];
    const prs = [
      { prNumber: 1, commitShas: ['abc'] },
      { prNumber: 2, commitShas: ['def'] },
    ];
    const r = computeCostPerMergedPr('u1', sessions, prs);
    expect(r.totalCostUsd).toBe(15);
    expect(r.mergedPrCount).toBe(2);
    expect(r.costPerMergedPr).toBe(7.5);
  });

  it('returns null when sessions exist but none match merged-PR commits', () => {
    const sessions = [{ userId: 'u1', costUsd: 10, commitSha: 'orphan' }];
    const prs = [{ prNumber: 1, commitShas: ['unrelated'] }];
    const r = computeCostPerMergedPr('u1', sessions, prs);
    expect(r.costPerMergedPr).toBeNull();
  });
});

describe('flagSession', () => {
  it('flags zero-commit sessions', () => {
    expect(flagSession({ costUsd: 1, commitId: null }, 1)).toContain('zero-commit');
  });

  it('flags sessions > 2× dev avg cost', () => {
    expect(flagSession({ costUsd: 10, commitId: 'c1' }, 3)).toContain('cost-outlier');
  });

  it('does not flag sessions <= 2× dev avg', () => {
    expect(flagSession({ costUsd: 4, commitId: 'c1' }, 3)).not.toContain('cost-outlier');
  });

  it('does not crash when devAvg is 0', () => {
    expect(flagSession({ costUsd: 5, commitId: 'c1' }, 0)).toEqual([]);
  });
});

describe('flagModelFit', () => {
  it('flags Opus on a tiny task', () => {
    const w = flagModelFit({
      sessionId: 's', model: 'claude-opus-4-7',
      costUsd: 0.3, promptCount: 1, filesTouched: 1, commitId: 'c',
    });
    expect(w).not.toBeNull();
    expect(w?.reason).toBe('oversized-for-cheap-task');
    expect(w?.estimatedSavingsUsd).toBeCloseTo(0.27, 5); // 0.3 × 0.9
  });

  it('does NOT flag Haiku on a tiny task', () => {
    expect(flagModelFit({
      sessionId: 's', model: 'claude-haiku-4-5',
      costUsd: 0.3, promptCount: 1, filesTouched: 1, commitId: 'c',
    })).toBeNull();
  });

  it('flags Sonnet running long with no commit', () => {
    const w = flagModelFit({
      sessionId: 's', model: 'claude-sonnet-4-6',
      costUsd: 50, promptCount: 150, filesTouched: 5, commitId: null,
    });
    expect(w?.reason).toBe('undersized-for-long-session');
  });

  it('does NOT flag Sonnet running long *with* a commit', () => {
    expect(flagModelFit({
      sessionId: 's', model: 'claude-sonnet-4-6',
      costUsd: 50, promptCount: 150, filesTouched: 5, commitId: 'c',
    })).toBeNull();
  });

  it('does NOT flag Opus when work was meaningful', () => {
    expect(flagModelFit({
      sessionId: 's', model: 'claude-opus-4-7',
      costUsd: 5, promptCount: 10, filesTouched: 5, commitId: 'c',
    })).toBeNull();
  });
});

describe('bucketHeatmap', () => {
  it('returns empty for empty input', () => {
    expect(bucketHeatmap([])).toEqual([]);
  });

  it('aggregates sessions in same hour bucket', () => {
    const d1 = new Date(2026, 3, 6, 14, 0); // Monday 14:00
    const d2 = new Date(2026, 3, 6, 14, 30);
    const cells = bucketHeatmap([
      { createdAt: d1, costUsd: 1.5 },
      { createdAt: d2, costUsd: 2.5 },
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toEqual({ day: 1, hour: 14, costUsd: 4, sessionCount: 2 });
  });

  it('separates different hour buckets', () => {
    const cells = bucketHeatmap([
      { createdAt: new Date(2026, 3, 6, 14, 0), costUsd: 1 },
      { createdAt: new Date(2026, 3, 6, 15, 0), costUsd: 2 },
      { createdAt: new Date(2026, 3, 7, 14, 0), costUsd: 3 },
    ]);
    expect(cells).toHaveLength(3);
  });
});

describe('classifyTokenUsage', () => {
  it('returns rows with computed ratios', () => {
    const rows = classifyTokenUsage([
      { userId: 'u1', name: 'A', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 750, cacheCreationTokens: 100 },
    ]);
    expect(rows[0].generatedTokens).toBe(1500);
    expect(rows[0].cacheReadRatio).toBe(0.5);
  });

  it('skips outlier detection when fewer than 3 devs', () => {
    const rows = classifyTokenUsage([
      { userId: 'u1', name: 'A', inputTokens: 100, outputTokens: 0, cacheReadTokens: 5000, cacheCreationTokens: 0 },
      { userId: 'u2', name: 'B', inputTokens: 100, outputTokens: 0, cacheReadTokens: 1, cacheCreationTokens: 0 },
    ]);
    expect(rows.every((r) => !r.isOutlier)).toBe(true);
  });

  it('flags outliers > 10× median', () => {
    const rows = classifyTokenUsage([
      { userId: 'u1', name: 'A', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 100, cacheCreationTokens: 0 }, // ratio 0.1
      { userId: 'u2', name: 'B', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 100, cacheCreationTokens: 0 }, // ratio 0.1
      { userId: 'u3', name: 'C', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 100, cacheCreationTokens: 0 }, // ratio 0.1
      { userId: 'u4', name: 'D', inputTokens: 100,  outputTokens: 0, cacheReadTokens: 5000, cacheCreationTokens: 0 }, // ratio 50 → outlier
    ]);
    const outlier = rows.find((r) => r.userId === 'u4');
    expect(outlier?.isOutlier).toBe(true);
    expect(rows.filter((r) => r.userId !== 'u4').every((r) => !r.isOutlier)).toBe(true);
  });
});

describe('parseDateRange', () => {
  it('defaults to 30 days', () => {
    const { from, to } = parseDateRange({});
    const span = to.getTime() - from.getTime();
    expect(span).toBeGreaterThan(29 * 86_400_000);
    expect(span).toBeLessThan(31 * 86_400_000);
  });

  it('honors shorthand 7d', () => {
    const { from, to } = parseDateRange({ range: '7d' });
    const span = to.getTime() - from.getTime();
    expect(span).toBeGreaterThan(6.9 * 86_400_000);
    expect(span).toBeLessThan(7.1 * 86_400_000);
  });

  it('throws on unknown shorthand', () => {
    expect(() => parseDateRange({ range: '14d' })).toThrow(/Invalid range/);
  });

  it('honors explicit from/to', () => {
    const r = parseDateRange({ from: '2026-04-01T00:00:00Z', to: '2026-04-30T00:00:00Z' });
    expect(r.from.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });

  it('throws on inverted range', () => {
    expect(() => parseDateRange({ from: '2026-04-30T00:00:00Z', to: '2026-04-01T00:00:00Z' })).toThrow(/from must be/);
  });

  it('throws on malformed date', () => {
    expect(() => parseDateRange({ from: 'not-a-date' })).toThrow();
  });
});
