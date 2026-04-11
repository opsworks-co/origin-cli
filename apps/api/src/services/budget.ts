import { prisma } from '../db.js';
import { notifyOrgAdmins } from './notifications.js';

// ---------------------------------------------------------------------------
// Cost Controls & Budget Management
// ---------------------------------------------------------------------------
// Tracks spending per org, enforces budget limits, sends alerts at thresholds.
// Budget config is stored in a simple JSON column or Org-level settings.
// We use the IntegrationConfig table with provider='budget' to store settings.
// ---------------------------------------------------------------------------

interface BudgetConfig {
  monthlyLimit: number;      // Monthly budget in USD (0 = unlimited)
  alertThresholds: number[]; // Percentages to alert at (e.g. [50, 80, 90, 100])
  blockOnExceed: boolean;    // Block new sessions when over budget
  alertedAt: number[];       // Percentages already alerted (avoid spam)
}

const DEFAULT_CONFIG: BudgetConfig = {
  monthlyLimit: 0,
  alertThresholds: [50, 80, 90, 100],
  blockOnExceed: false,
  alertedAt: [],
};

export async function getBudgetConfig(orgId: string): Promise<BudgetConfig> {
  const config = await prisma.integrationConfig.findFirst({
    where: { orgId, provider: 'budget' },
  });

  if (!config) return { ...DEFAULT_CONFIG };

  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(config.settings) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveBudgetConfig(orgId: string, config: Partial<BudgetConfig>): Promise<BudgetConfig> {
  const existing = await prisma.integrationConfig.findFirst({
    where: { orgId, provider: 'budget' },
  });

  const merged = { ...DEFAULT_CONFIG, ...config };
  const settingsJson = JSON.stringify(merged);

  if (existing) {
    await prisma.integrationConfig.update({
      where: { id: existing.id },
      data: { settings: settingsJson },
    });
  } else {
    await prisma.integrationConfig.create({
      data: {
        orgId,
        provider: 'budget',
        token: '', // not needed for budget
        settings: settingsJson,
      },
    });
  }

  return merged;
}

export async function getMonthlySpend(orgId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const result = await prisma.codingSession.aggregate({
    _sum: { costUsd: true },
    where: {
      createdAt: { gte: startOfMonth },
      commit: { repo: { orgId } },
    },
  });

  return result._sum.costUsd ?? 0;
}

export async function getDailySpend(orgId: string, days: number = 30): Promise<Array<{ date: string; cost: number }>> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Cap at 200k rows — daily spend is a day-bucket histogram, partial
  // scans are still accurate, and unbounded scans OOM the budget panel
  // on active tenants.
  const sessions = await prisma.codingSession.findMany({
    where: {
      createdAt: { gte: since },
      commit: { repo: { orgId } },
    },
    select: { costUsd: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 200_000,
  });

  // Group by day
  const byDay: Record<string, number> = {};
  for (const s of sessions) {
    const day = s.createdAt.toISOString().split('T')[0];
    byDay[day] = (byDay[day] || 0) + s.costUsd;
  }

  return Object.entries(byDay).map(([date, cost]) => ({ date, cost }));
}

export async function getSpendByModel(orgId: string): Promise<Array<{ model: string; cost: number; sessions: number }>> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const sessions = await prisma.codingSession.findMany({
    where: {
      createdAt: { gte: startOfMonth },
      commit: { repo: { orgId } },
    },
    select: { model: true, costUsd: true },
    take: 200_000,
    orderBy: { createdAt: 'desc' },
  });

  const byModel: Record<string, { cost: number; sessions: number }> = {};
  for (const s of sessions) {
    if (!byModel[s.model]) byModel[s.model] = { cost: 0, sessions: 0 };
    byModel[s.model].cost += s.costUsd;
    byModel[s.model].sessions++;
  }

  return Object.entries(byModel).map(([model, data]) => ({ model, ...data }));
}

export async function getSpendByUser(orgId: string): Promise<Array<{ userId: string; name: string; cost: number; sessions: number }>> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const sessions = await prisma.codingSession.findMany({
    where: {
      createdAt: { gte: startOfMonth },
      commit: { repo: { orgId } },
      userId: { not: null },
    },
    select: { userId: true, costUsd: true, user: { select: { name: true } } },
    take: 200_000,
    orderBy: { createdAt: 'desc' },
  });

  const byUser: Record<string, { name: string; cost: number; sessions: number }> = {};
  for (const s of sessions) {
    const uid = s.userId!;
    if (!byUser[uid]) byUser[uid] = { name: s.user?.name || 'Unknown', cost: 0, sessions: 0 };
    byUser[uid].cost += s.costUsd;
    byUser[uid].sessions++;
  }

  return Object.entries(byUser).map(([userId, data]) => ({ userId, ...data }));
}

interface BudgetCheckResult {
  blocked: boolean;
  message: string;
  spent: number;
  limit: number;
  percentage: number;
}

export async function checkBudget(orgId: string): Promise<BudgetCheckResult> {
  const config = await getBudgetConfig(orgId);

  if (config.monthlyLimit <= 0) {
    return { blocked: false, message: 'No budget limit set', spent: 0, limit: 0, percentage: 0 };
  }

  const spent = await getMonthlySpend(orgId);
  const percentage = (spent / config.monthlyLimit) * 100;

  if (config.blockOnExceed && spent >= config.monthlyLimit) {
    return {
      blocked: true,
      message: `Monthly budget of $${config.monthlyLimit.toFixed(2)} exceeded. Current spend: $${spent.toFixed(2)}`,
      spent,
      limit: config.monthlyLimit,
      percentage,
    };
  }

  return {
    blocked: false,
    message: percentage >= 90
      ? `Warning: ${percentage.toFixed(0)}% of monthly budget used ($${spent.toFixed(2)}/$${config.monthlyLimit.toFixed(2)})`
      : 'Budget OK',
    spent,
    limit: config.monthlyLimit,
    percentage,
  };
}

export async function recordSpend(orgId: string, amount: number): Promise<void> {
  if (amount <= 0) return;

  const config = await getBudgetConfig(orgId);
  if (config.monthlyLimit <= 0) return;

  const spent = await getMonthlySpend(orgId);
  const percentage = (spent / config.monthlyLimit) * 100;

  // Check each threshold and send alerts
  for (const threshold of config.alertThresholds) {
    if (percentage >= threshold && !config.alertedAt.includes(threshold)) {
      // Send alert
      const level = threshold >= 100 ? 'exceeded' : threshold >= 90 ? 'critical' : threshold >= 80 ? 'high' : 'approaching';

      await notifyOrgAdmins(
        orgId,
        'REVIEW_COMPLETED', // reuse type
        `Budget Alert: ${threshold}% used`,
        `Monthly spend is $${spent.toFixed(2)} of $${config.monthlyLimit.toFixed(2)} limit (${percentage.toFixed(0)}%). Level: ${level}`,
        '/settings',
        { type: 'budget_alert', threshold, spent, limit: config.monthlyLimit, percentage }
      );

      // Mark as alerted
      config.alertedAt.push(threshold);
      await saveBudgetConfig(orgId, { alertedAt: config.alertedAt });

      console.log(`[budget] Alert sent for org ${orgId}: ${threshold}% threshold (${level})`);
    }
  }
}

// Reset alert tracking at the start of each month
export async function resetMonthlyAlerts(): Promise<void> {
  // Cap at 50k — a single unbounded scan across every tenant's budget
  // config grows with customer count and would OOM on large fleets.
  // A rerun picks up the tail.
  const budgetConfigs = await prisma.integrationConfig.findMany({
    where: { provider: 'budget' },
    take: 50_000,
    orderBy: { id: 'asc' },
  });

  for (const config of budgetConfigs) {
    try {
      const settings = JSON.parse(config.settings);
      if (settings.alertedAt && settings.alertedAt.length > 0) {
        settings.alertedAt = [];
        await prisma.integrationConfig.update({
          where: { id: config.id },
          data: { settings: JSON.stringify(settings) },
        });
      }
    } catch {
      // skip invalid configs
    }
  }
}
