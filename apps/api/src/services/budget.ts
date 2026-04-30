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
  level?: 'model' | 'agent' | 'user-model' | 'repo-model' | 'org';
}

export interface BudgetCheckScope {
  agentId?: string;
  model?: string;
  userId?: string;
  repoId?: string;
}

// Sum of session cost in the current month, optionally narrowed to a single
// agent / user / repo / model. Used by the per-level limit checks so each
// scope's "spent so far" is computed against the matching scope only.
async function getMonthlySpendScope(opts: {
  orgId: string;
  agentId?: string;
  userId?: string;
  repoId?: string;
  model?: string;
}): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const result = await prisma.codingSession.aggregate({
    _sum: { costUsd: true },
    where: {
      createdAt: { gte: startOfMonth },
      commit: {
        repo: {
          orgId: opts.orgId,
          ...(opts.repoId ? { id: opts.repoId } : {}),
        },
      },
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    },
  });
  return result._sum.costUsd ?? 0;
}

// Session-start budget check. Walks every applicable level (agent-model →
// user-model → repo-model → org). Each level evaluates independently; the
// first that's over its cap and configured to block fires. Per spec,
// "fall back" means inheritance for null-valued fields, not short-circuit
// evaluation — a too-loose model limit can't bypass a tighter org cap.
//
// Backward-compatible: callers passing only `orgId` get the org-only check.
// Old (orgId, agentId, model) signature is still accepted via union typing.
export async function checkBudget(
  orgId: string,
  scopeOrAgentId?: BudgetCheckScope | string,
  legacyModel?: string,
): Promise<BudgetCheckResult> {
  // Coerce legacy positional args into the scope bag.
  const scope: BudgetCheckScope =
    typeof scopeOrAgentId === 'string'
      ? { agentId: scopeOrAgentId, model: legacyModel }
      : scopeOrAgentId ?? {};

  const orgConfig = await getBudgetConfig(orgId);

  type Level = {
    name: NonNullable<BudgetCheckResult['level']>;
    label: string;
    limit: number;
    spent: number;
    block: boolean;
  };
  const levels: Level[] = [];

  // 1. AgentModel-level (most specific to agent + model)
  if (scope.agentId && scope.model) {
    const am = await prisma.agentModel.findUnique({
      where: { agentId_model: { agentId: scope.agentId, model: scope.model } },
      select: { monthlyLimit: true, agent: { select: { name: true } } },
    });
    if (am?.monthlyLimit && am.monthlyLimit > 0) {
      const spent = await getMonthlySpendScope({ orgId, agentId: scope.agentId, model: scope.model });
      levels.push({
        name: 'model',
        label: `${am.agent.name} · ${scope.model} monthly model limit`,
        limit: am.monthlyLimit,
        spent,
        block: orgConfig.blockOnExceed,
      });
    }
  }

  // 2. UserModelLimit (per-developer × model). Only fires when both userId
  // and model are known, e.g. from a session bound to a logged-in dev's
  // API key.
  if (scope.userId && scope.model) {
    const um = await prisma.userModelLimit.findUnique({
      where: { userId_model: { userId: scope.userId, model: scope.model } },
      select: { monthlyLimit: true, user: { select: { name: true } } },
    });
    if (um?.monthlyLimit && um.monthlyLimit > 0) {
      const spent = await getMonthlySpendScope({ orgId, userId: scope.userId, model: scope.model });
      levels.push({
        name: 'user-model',
        label: `${um.user.name} · ${scope.model} monthly user limit`,
        limit: um.monthlyLimit,
        spent,
        block: orgConfig.blockOnExceed,
      });
    }
  }

  // 3. RepoModelLimit (per-repo × model). Same shape, scoped by repo.
  if (scope.repoId && scope.model) {
    const rm = await prisma.repoModelLimit.findUnique({
      where: { repoId_model: { repoId: scope.repoId, model: scope.model } },
      select: { monthlyLimit: true, repo: { select: { name: true } } },
    });
    if (rm?.monthlyLimit && rm.monthlyLimit > 0) {
      const spent = await getMonthlySpendScope({ orgId, repoId: scope.repoId, model: scope.model });
      levels.push({
        name: 'repo-model',
        label: `${rm.repo.name} · ${scope.model} monthly repo limit`,
        limit: rm.monthlyLimit,
        spent,
        block: orgConfig.blockOnExceed,
      });
    }
  }

  // 4. Org-level (least specific). Existing budget_agent_limits /
  // budget_user_limits JSON maps remain display-only and aren't enforced
  // here (see open question #3 in the plan).
  if (orgConfig.monthlyLimit > 0) {
    const spent = await getMonthlySpend(orgId);
    levels.push({
      name: 'org',
      label: 'Monthly budget',
      limit: orgConfig.monthlyLimit,
      spent,
      block: orgConfig.blockOnExceed,
    });
  }

  if (levels.length === 0) {
    return { blocked: false, message: 'No budget limit set', spent: 0, limit: 0, percentage: 0 };
  }

  const blocking = levels.find((l) => l.block && l.spent >= l.limit);
  if (blocking) {
    return {
      blocked: true,
      level: blocking.name,
      message: `${blocking.label} exceeded ($${blocking.spent.toFixed(2)} / $${blocking.limit.toFixed(2)})`,
      spent: blocking.spent,
      limit: blocking.limit,
      percentage: (blocking.spent / blocking.limit) * 100,
    };
  }

  const hottest = levels.reduce((best, l) =>
    l.spent / l.limit > best.spent / best.limit ? l : best,
  );
  const pct = (hottest.spent / hottest.limit) * 100;
  return {
    blocked: false,
    level: hottest.name,
    message: pct >= 90
      ? `Warning: ${pct.toFixed(0)}% of ${hottest.label} used ($${hottest.spent.toFixed(2)}/$${hottest.limit.toFixed(2)})`
      : 'Budget OK',
    spent: hottest.spent,
    limit: hottest.limit,
    percentage: pct,
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
