import { prisma } from '../db.js';
import { notifyOrgAdmins } from './notifications.js';

// ---------------------------------------------------------------------------
// Cost Controls & Budget Management
// ---------------------------------------------------------------------------
// Tracks spending per org, enforces budget limits, sends alerts at thresholds.
// Budget config is stored in a simple JSON column or Org-level settings.
// We use the IntegrationConfig table with provider='budget' to store settings.
// ---------------------------------------------------------------------------

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

// Per-period cap shape. `limit > 0` means a cap is set for that window;
// `block` decides whether overage hard-stops new sessions or just alerts.
export interface PeriodCap {
  limit: number;
  block: boolean;
}

export interface BudgetConfig {
  monthlyLimit: number;      // Legacy single-cap field; mirrored from `caps` so old API consumers keep working
  period: BudgetPeriod;      // Legacy single-period field; mirrors the dominant cap (monthly > weekly > daily)
  alertThresholds: number[]; // Percentages to alert at (e.g. [50, 80, 90, 100])
  blockOnExceed: boolean;    // Legacy single-block flag; mirrors the dominant cap's block setting
  alertedAt: number[];       // Percentages already alerted (avoid spam)

  // Multi-tier caps — admins can set daily AND weekly AND monthly limits
  // independently. Any unset window simply has no cap. Enforcement walks
  // every set cap, so the most-restrictive one fires first.
  caps?: Partial<Record<BudgetPeriod, PeriodCap>>;
}

const DEFAULT_CONFIG: BudgetConfig = {
  monthlyLimit: 0,
  period: 'monthly',
  alertThresholds: [50, 80, 90, 100],
  blockOnExceed: false,
  alertedAt: [],
  caps: {},
};

// "Dominant" cap = the longest configured period. Used to mirror legacy
// fields (monthlyLimit/period/blockOnExceed) so old code paths still see
// a single cap. Returns null when no caps are configured.
function dominantCap(caps: Partial<Record<BudgetPeriod, PeriodCap>>): { period: BudgetPeriod; cap: PeriodCap } | null {
  if (caps.monthly && caps.monthly.limit > 0) return { period: 'monthly', cap: caps.monthly };
  if (caps.weekly  && caps.weekly.limit > 0)  return { period: 'weekly',  cap: caps.weekly  };
  if (caps.daily   && caps.daily.limit > 0)   return { period: 'daily',   cap: caps.daily   };
  return null;
}

// Synthesize a `caps` map from the legacy single-cap fields. Used when
// reading a config that pre-dates the multi-tier feature so the new shape
// is always populated.
function synthesizeCapsFromLegacy(c: { monthlyLimit: number; period: BudgetPeriod; blockOnExceed: boolean }): Partial<Record<BudgetPeriod, PeriodCap>> {
  if (!c.monthlyLimit || c.monthlyLimit <= 0) return {};
  return { [c.period]: { limit: c.monthlyLimit, block: c.blockOnExceed } } as Partial<Record<BudgetPeriod, PeriodCap>>;
}

function normalizePeriod(p: unknown): BudgetPeriod {
  return p === 'daily' || p === 'weekly' ? p : 'monthly';
}

// Returns the start-of-period boundary for now. For weekly we anchor to
// Monday (ISO week) so cron alert resets line up with how teams plan.
export function periodStart(period: BudgetPeriod, now: Date = new Date()): Date {
  if (period === 'daily') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (period === 'weekly') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = d.getDay(); // 0=Sun..6=Sat
    const offset = day === 0 ? 6 : day - 1; // make Monday the anchor
    d.setDate(d.getDate() - offset);
    return d;
  }
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export async function getBudgetConfig(orgId: string): Promise<BudgetConfig> {
  const config = await prisma.integrationConfig.findFirst({
    where: { orgId, provider: 'budget' },
  });

  if (!config) return { ...DEFAULT_CONFIG, caps: {} };

  try {
    const parsed = JSON.parse(config.settings);
    const merged: BudgetConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      period: normalizePeriod(parsed.period),
    };
    // Pre-multi-tier configs only have legacy fields. Synthesize a caps
    // map so callers can rely on the new shape unconditionally.
    if (!merged.caps || Object.keys(merged.caps).length === 0) {
      merged.caps = synthesizeCapsFromLegacy(merged);
    }
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG, caps: {} };
  }
}

export async function saveBudgetConfig(orgId: string, config: Partial<BudgetConfig>): Promise<BudgetConfig> {
  const existing = await prisma.integrationConfig.findFirst({
    where: { orgId, provider: 'budget' },
  });

  // If caller sent a `caps` map, that's the authoritative source — derive
  // legacy fields from it. Otherwise, fall back to the legacy fields the
  // caller passed (and re-synthesize caps from those).
  const incomingCaps = config.caps;
  const merged: BudgetConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    period: normalizePeriod(config.period ?? DEFAULT_CONFIG.period),
  };
  if (incomingCaps) {
    // Sanitize: drop entries with non-positive limits or non-numeric values
    const clean: Partial<Record<BudgetPeriod, PeriodCap>> = {};
    for (const p of ['daily', 'weekly', 'monthly'] as BudgetPeriod[]) {
      const c = incomingCaps[p];
      if (c && typeof c.limit === 'number' && c.limit > 0) {
        clean[p] = { limit: c.limit, block: !!c.block };
      }
    }
    merged.caps = clean;
    // Mirror dominant cap into legacy fields so cron alerts, the budget
    // pill, and any other code path still using the old shape keeps
    // working without coordinated migration.
    const dom = dominantCap(clean);
    if (dom) {
      merged.monthlyLimit = dom.cap.limit;
      merged.period = dom.period;
      merged.blockOnExceed = dom.cap.block;
    } else {
      merged.monthlyLimit = 0;
      merged.blockOnExceed = false;
    }
  } else {
    // Legacy save path — synthesize caps from the single-cap fields.
    merged.caps = synthesizeCapsFromLegacy(merged);
  }
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

// Period-aware spend total. The org-wide rollup the Budget hero card and
// pill use — pass period='daily' for "today", 'weekly' for "this week",
// 'monthly' for "this month".
export async function getSpend(orgId: string, period: BudgetPeriod = 'monthly'): Promise<number> {
  const since = periodStart(period);
  const result = await prisma.codingSession.aggregate({
    _sum: { costUsd: true },
    where: {
      createdAt: { gte: since },
      commit: { repo: { orgId } },
    },
  });
  return result._sum.costUsd ?? 0;
}

// Back-compat alias — many call sites still ask for "monthly" specifically.
export async function getMonthlySpend(orgId: string): Promise<number> {
  return getSpend(orgId, 'monthly');
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

export async function getSpendByModel(orgId: string, period: BudgetPeriod = 'monthly'): Promise<Array<{ model: string; cost: number; sessions: number }>> {
  const since = periodStart(period);

  const sessions = await prisma.codingSession.findMany({
    where: {
      createdAt: { gte: since },
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

export async function getSpendByUser(orgId: string, period: BudgetPeriod = 'monthly'): Promise<Array<{ userId: string; name: string; cost: number; sessions: number }>> {
  const since = periodStart(period);

  const sessions = await prisma.codingSession.findMany({
    where: {
      createdAt: { gte: since },
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
  level?: 'model' | 'agent' | 'user-model' | 'repo-model' | 'repo' | 'org';
}

export interface BudgetCheckScope {
  agentId?: string;
  model?: string;
  userId?: string;
  repoId?: string;
}

// Sum of session cost in the current period, optionally narrowed to a
// single agent / user / repo / model. Used by the per-level limit checks
// so each scope's "spent so far" is computed against the matching scope only.
async function getSpendScope(opts: {
  orgId: string;
  period: BudgetPeriod;
  agentId?: string;
  userId?: string;
  repoId?: string;
  model?: string;
}): Promise<number> {
  const since = periodStart(opts.period);

  const result = await prisma.codingSession.aggregate({
    _sum: { costUsd: true },
    where: {
      createdAt: { gte: since },
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

function periodLabel(p: BudgetPeriod): string {
  return p === 'daily' ? 'daily' : p === 'weekly' ? 'weekly' : 'monthly';
}

// Session-start budget check. Walks every applicable level (agent-model →
// user-model → repo-model → org). Each level evaluates independently against
// its own configured period; the first level that's over its cap and
// configured to block fires.
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
    period: BudgetPeriod;
  };
  const levels: Level[] = [];

  // 1. AgentModel-level (most specific to agent + model)
  if (scope.agentId && scope.model) {
    const am = await prisma.agentModel.findUnique({
      where: { agentId_model: { agentId: scope.agentId, model: scope.model } },
      select: { monthlyLimit: true, period: true, agent: { select: { name: true } } },
    });
    if (am?.monthlyLimit && am.monthlyLimit > 0) {
      const period = normalizePeriod(am.period);
      const spent = await getSpendScope({ orgId, period, agentId: scope.agentId, model: scope.model });
      levels.push({
        name: 'model',
        label: `${am.agent.name} · ${scope.model} ${periodLabel(period)} model limit`,
        limit: am.monthlyLimit,
        spent,
        block: orgConfig.blockOnExceed,
        period,
      });
    }
  }

  // 2. UserModelLimit (per-developer × model). Only fires when both userId
  // and model are known, e.g. from a session bound to a logged-in dev's
  // API key.
  if (scope.userId && scope.model) {
    const um = await prisma.userModelLimit.findUnique({
      where: { userId_model: { userId: scope.userId, model: scope.model } },
      select: { monthlyLimit: true, period: true, user: { select: { name: true } } },
    });
    if (um?.monthlyLimit && um.monthlyLimit > 0) {
      const period = normalizePeriod(um.period);
      const spent = await getSpendScope({ orgId, period, userId: scope.userId, model: scope.model });
      levels.push({
        name: 'user-model',
        label: `${um.user.name} · ${scope.model} ${periodLabel(period)} user limit`,
        limit: um.monthlyLimit,
        spent,
        block: orgConfig.blockOnExceed,
        period,
      });
    }
  }

  // 3. RepoModelLimit (per-repo × model). Same shape, scoped by repo.
  if (scope.repoId && scope.model) {
    const rm = await prisma.repoModelLimit.findUnique({
      where: { repoId_model: { repoId: scope.repoId, model: scope.model } },
      select: { monthlyLimit: true, period: true, repo: { select: { name: true } } },
    });
    if (rm?.monthlyLimit && rm.monthlyLimit > 0) {
      const period = normalizePeriod(rm.period);
      const spent = await getSpendScope({ orgId, period, repoId: scope.repoId, model: scope.model });
      levels.push({
        name: 'repo-model',
        label: `${rm.repo.name} · ${scope.model} ${periodLabel(period)} repo limit`,
        limit: rm.monthlyLimit,
        spent,
        block: orgConfig.blockOnExceed,
        period,
      });
    }
  }

  // 3b. Repo-level flat cap (no model dimension). Stored in the
  // budget_repo_limits JSON blob the same way as agent/user limits.
  // Fires whenever the session's repo is known, regardless of which
  // model the agent picked — admins set "$50/mo on dolobanko-test"
  // without having to enumerate every model.
  if (scope.repoId) {
    const repoLimitsCfg = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_repo_limits' },
      select: { settings: true },
    });
    if (repoLimitsCfg) {
      try {
        const raw = JSON.parse(repoLimitsCfg.settings) as Record<string, unknown>;
        const entry = raw[scope.repoId];
        let limit = 0;
        let rPeriod: BudgetPeriod = 'monthly';
        if (typeof entry === 'number' && entry > 0) {
          limit = entry;
        } else if (entry && typeof entry === 'object') {
          const e = entry as { limit?: unknown; period?: unknown };
          if (typeof e.limit === 'number' && e.limit > 0) {
            limit = e.limit;
            rPeriod = normalizePeriod(e.period);
          }
        }
        if (limit > 0) {
          const repo = await prisma.repo.findUnique({
            where: { id: scope.repoId },
            select: { name: true },
          });
          const spent = await getSpendScope({ orgId, period: rPeriod, repoId: scope.repoId });
          levels.push({
            name: 'repo',
            label: `${repo?.name ?? 'repo'} ${periodLabel(rPeriod)} repo cap`,
            limit,
            spent,
            block: orgConfig.blockOnExceed,
            period: rPeriod,
          });
        }
      } catch {
        // malformed JSON — skip silently, never block on a parse error
      }
    }
  }

  // 4. Org-wide model cap (e.g. cap *every* Opus session combined). Stored
  // in the budget_model_limits JSON blob — same shape as the per-agent /
  // per-user maps. We read it inline here so a runaway model usage gets
  // blocked even when no specific (agent|user|repo)+model row matches.
  if (scope.model) {
    const modelLimitsCfg = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_model_limits' },
      select: { settings: true },
    });
    if (modelLimitsCfg) {
      try {
        const raw = JSON.parse(modelLimitsCfg.settings) as Record<string, unknown>;
        const entry = raw[scope.model];
        let limit = 0;
        let mPeriod: BudgetPeriod = 'monthly';
        if (typeof entry === 'number' && entry > 0) {
          limit = entry;
        } else if (entry && typeof entry === 'object') {
          const e = entry as { limit?: unknown; period?: unknown };
          if (typeof e.limit === 'number' && e.limit > 0) {
            limit = e.limit;
            mPeriod = normalizePeriod(e.period);
          }
        }
        if (limit > 0) {
          const spent = await getSpendScope({ orgId, period: mPeriod, model: scope.model });
          levels.push({
            name: 'model',
            label: `${scope.model} ${periodLabel(mPeriod)} model cap`,
            limit,
            spent,
            block: orgConfig.blockOnExceed,
            period: mPeriod,
          });
        }
      } catch {
        // malformed JSON — skip silently, never block a session because of it
      }
    }
  }

  // 5. Org-level — walk every configured cap (daily / weekly / monthly).
  // Each runs independently against its own period so an admin can set
  // a tight daily ceiling AND a generous monthly one and both fire.
  // Falls back to the legacy single-cap shape when `caps` is empty.
  const orgCaps = orgConfig.caps && Object.keys(orgConfig.caps).length > 0
    ? orgConfig.caps
    : (orgConfig.monthlyLimit > 0
        ? { [orgConfig.period]: { limit: orgConfig.monthlyLimit, block: orgConfig.blockOnExceed } } as Partial<Record<BudgetPeriod, PeriodCap>>
        : {});
  for (const period of ['daily', 'weekly', 'monthly'] as BudgetPeriod[]) {
    const cap = orgCaps[period];
    if (!cap || cap.limit <= 0) continue;
    const spent = await getSpend(orgId, period);
    levels.push({
      name: 'org',
      label: `${periodLabel(period).replace(/^./, (c) => c.toUpperCase())} budget`,
      limit: cap.limit,
      spent,
      block: cap.block,
      period,
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

  const spent = await getSpend(orgId, config.period);
  const percentage = (spent / config.monthlyLimit) * 100;
  const periodLbl = periodLabel(config.period);

  // Check each threshold and send alerts
  for (const threshold of config.alertThresholds) {
    if (percentage >= threshold && !config.alertedAt.includes(threshold)) {
      // Send alert
      const level = threshold >= 100 ? 'exceeded' : threshold >= 90 ? 'critical' : threshold >= 80 ? 'high' : 'approaching';

      await notifyOrgAdmins(
        orgId,
        'REVIEW_COMPLETED', // reuse type
        `Budget Alert: ${threshold}% of ${periodLbl} used`,
        `${periodLbl.replace(/^./, (c) => c.toUpperCase())} spend is $${spent.toFixed(2)} of $${config.monthlyLimit.toFixed(2)} limit (${percentage.toFixed(0)}%). Level: ${level}`,
        '/budget',
        { type: 'budget_alert', threshold, spent, limit: config.monthlyLimit, percentage, period: config.period }
      );

      // Mark as alerted
      config.alertedAt.push(threshold);
      await saveBudgetConfig(orgId, { alertedAt: config.alertedAt });

      console.log(`[budget] Alert sent for org ${orgId}: ${threshold}% threshold (${level}, ${periodLbl})`);
    }
  }
}

// Reset alert tracking at the start of each period. Called by a cron tick
// — for daily/weekly periods we still rely on the same column, just reset
// at the appropriate cadence.
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
