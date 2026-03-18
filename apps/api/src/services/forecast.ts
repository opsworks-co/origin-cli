import { getDailySpend, getSpendByModel } from './budget.js';

// ---------------------------------------------------------------------------
// Cost Forecast Engine
// ---------------------------------------------------------------------------
// Projects future AI spending based on historical daily cost data.
// Uses weighted moving average (recent days weighted more heavily).
// ---------------------------------------------------------------------------

export interface ForecastResult {
  projectedMonthly: number;
  trend: 'up' | 'down' | 'flat';
  confidence: number; // 0–1
  daily: Array<{ date: string; actual: number | null; projected: number | null }>;
  byModel: Array<{ model: string; currentMonthly: number; projectedMonthly: number; trend: 'up' | 'down' | 'flat' }>;
}

/**
 * Weighted moving average: recent days get higher weights.
 * Returns average daily cost.
 */
function weightedMovingAverage(values: number[]): number {
  if (values.length === 0) return 0;
  let weightSum = 0;
  let valueSum = 0;
  for (let i = 0; i < values.length; i++) {
    const weight = i + 1; // later entries (more recent) get higher weight
    valueSum += values[i] * weight;
    weightSum += weight;
  }
  return valueSum / weightSum;
}

/**
 * Compute trend direction from daily values.
 * Compares first half average to second half average.
 */
function computeTrend(values: number[]): 'up' | 'down' | 'flat' {
  if (values.length < 4) return 'flat';
  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  const change = avgFirst > 0 ? (avgSecond - avgFirst) / avgFirst : 0;
  if (change > 0.15) return 'up';
  if (change < -0.15) return 'down';
  return 'flat';
}

/**
 * Build a full date range array filling gaps with 0.
 */
function fillDailyGaps(dailyData: Array<{ date: string; cost: number }>, days: number): number[] {
  const dateMap = new Map(dailyData.map(d => [d.date, d.cost]));
  const result: number[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    result.push(dateMap.get(key) || 0);
  }
  return result;
}

export async function forecastMonthlyCost(orgId: string): Promise<ForecastResult> {
  // Fetch 60 days of historical data
  const dailyData = await getDailySpend(orgId, 60);
  const dailyValues = fillDailyGaps(dailyData, 60);

  // Use last 30 days for projection
  const recent30 = dailyValues.slice(-30);
  const avgDailyCost = weightedMovingAverage(recent30);
  const projectedMonthly = parseFloat((avgDailyCost * 30).toFixed(2));
  const trend = computeTrend(recent30);

  // Confidence based on data density (more data = higher confidence)
  const nonZeroDays = recent30.filter(v => v > 0).length;
  const confidence = parseFloat(Math.min(nonZeroDays / 15, 1).toFixed(2));

  // Build daily timeline: 30 days history + 14 days projected
  const daily: ForecastResult['daily'] = [];
  const now = new Date();

  // Historical (last 30 days)
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    daily.push({ date: key, actual: recent30[30 - 1 - i] || 0, projected: null });
  }

  // Projected (next 14 days)
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().split('T')[0];
    daily.push({ date: key, actual: null, projected: parseFloat(avgDailyCost.toFixed(2)) });
  }

  // Per-model forecast
  const modelData = await getSpendByModel(orgId);
  const totalCurrentMonthly = modelData.reduce((sum, m) => sum + m.cost, 0);
  const byModel: ForecastResult['byModel'] = modelData.map(m => {
    const share = totalCurrentMonthly > 0 ? m.cost / totalCurrentMonthly : 0;
    return {
      model: m.model,
      currentMonthly: parseFloat(m.cost.toFixed(2)),
      projectedMonthly: parseFloat((projectedMonthly * share).toFixed(2)),
      trend: 'flat' as const, // per-model trend requires per-model daily data (future enhancement)
    };
  });

  return { projectedMonthly, trend, confidence, daily, byModel };
}
