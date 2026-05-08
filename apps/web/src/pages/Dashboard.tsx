import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';
import type { Stats, Session, Policy, IntegrationConfig, TeamPromptEntry, TeamEfficiency, TeamAdoption, TodayBrief } from '../api';
import { Trend } from './MyDashboard/Trend';
import { agentColor } from './MyDashboard/utils';
import { PageHeader } from '../components/ui';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  Tooltip, ResponsiveContainer, XAxis, YAxis, ReferenceLine, CartesianGrid,
} from 'recharts';
import {
  Sparkles, X, Play, Zap, DollarSign, Users, ChevronDown,
  ShieldCheck, BarChart3, AlertTriangle, ArrowRight, Clock,
  Search, Gauge, MessageSquare, ChevronRight, FileText, UserPlus,
} from 'lucide-react';

// ── AI Insight Generation ────────────────────────────────────────────────────

interface InsightResult {
  headline: string;
  advice: string;
}

function generateInsight(stats: Stats): InsightResult {
  const days = stats.sessionsByDay ?? [];
  const costByDay = stats.costByDay ?? [];

  const now = new Date();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - now.getDay());
  startOfThisWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

  let thisWeekSessions = 0;
  let lastWeekSessions = 0;
  for (const d of days) {
    const date = new Date(d.date);
    if (date >= startOfThisWeek) thisWeekSessions += d.count;
    else if (date >= startOfLastWeek && date < startOfThisWeek) lastWeekSessions += d.count;
  }

  let thisWeekCost = 0;
  let lastWeekCost = 0;
  for (const d of costByDay) {
    const date = new Date(d.date);
    if (date >= startOfThisWeek) thisWeekCost += d.cost;
    else if (date >= startOfLastWeek && date < startOfThisWeek) lastWeekCost += d.cost;
  }

  const costByModel = stats.costByModel ?? [];
  const totalModelSessions = costByModel.reduce((s, m) => s + m.count, 0);
  const topModel = costByModel.length > 0
    ? costByModel.reduce((a, b) => (a.count > b.count ? a : b))
    : null;
  const topModelPct = topModel && totalModelSessions > 0
    ? Math.round((topModel.count / totalModelSessions) * 100)
    : 0;

  const violations = stats.policyViolations ?? 0;
  const daysElapsed = stats.daysElapsed ?? 1;
  const dailyCostAvg = stats.estimatedCostThisMonth / Math.max(daysElapsed, 1);

  const sessionPctChange = lastWeekSessions > 0
    ? Math.round(((thisWeekSessions - lastWeekSessions) / lastWeekSessions) * 100)
    : 0;

  const costPctChange = lastWeekCost > 0
    ? Math.round(((thisWeekCost - lastWeekCost) / lastWeekCost) * 100)
    : 0;

  let headline: string;
  let advice: string;

  if (violations > 0) {
    headline = `⚠️ ${violations} policy violation${violations !== 1 ? 's' : ''} detected this week. Review flagged sessions promptly.`;
    advice = 'Review flagged sessions in the Sessions page.';
  } else if (sessionPctChange >= 10) {
    const modelNote = topModel && topModelPct > 60
      ? `, with ${topModel.model} driving ${topModelPct}% of activity`
      : '';
    headline = `AI sessions are up ${sessionPctChange}% this week${modelNote}. Cost is trending at $${dailyCostAvg.toFixed(2)}/day.`;
    advice = costPctChange > 20
      ? 'Consider setting budget limits in Budget settings.'
      : 'Everything looks healthy. Keep building.';
  } else if (sessionPctChange <= -10) {
    headline = `AI activity dropped ${Math.abs(sessionPctChange)}% this week. ${thisWeekSessions} sessions tracked so far.`;
    advice = 'AI adoption is below target. Check agent setup.';
  } else if (topModel && topModelPct > 60) {
    headline = `${topModel.model} is driving ${topModelPct}% of all sessions. $${dailyCostAvg.toFixed(2)}/day average cost.`;
    advice = costPctChange > 20
      ? 'Consider setting budget limits in Budget settings.'
      : 'Everything looks healthy. Keep building.';
  } else if (costPctChange > 20) {
    headline = `Spending is up ${costPctChange}% — $${dailyCostAvg.toFixed(2)}/day average this month.`;
    advice = 'Consider setting budget limits in Budget settings.';
  } else {
    headline = `${stats.totalSessions} sessions across ${stats.activeAgents} agent${stats.activeAgents !== 1 ? 's' : ''} this month, totaling $${stats.estimatedCostThisMonth.toFixed(2)}.`;
    advice = 'Everything looks healthy. Keep building.';
  }

  return { headline, advice };
}

function InsightBanner({ stats }: { stats: Stats }) {
  const storageKey = 'origin_insight_dismissed';
  const [dismissed, setDismissed] = useState(() => {
    try {
      const val = localStorage.getItem(storageKey);
      return val === 'true' || val === 'permanent';
    } catch { return false; }
  });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!dismissed) {
      const t = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(t);
    }
  }, [dismissed]);

  if (dismissed) return null;

  const { headline, advice } = generateInsight(stats);

  const handleDismiss = () => {
    try { localStorage.setItem(storageKey, 'permanent'); } catch { /* ignore */ }
    setVisible(false);
    setTimeout(() => setDismissed(true), 300);
  };

  return (
    <div
      className="relative rounded-xl p-[1px] transition-opacity duration-300"
      style={{
        opacity: visible ? 1 : 0,
        background: 'linear-gradient(135deg, rgba(99,102,241,0.4), rgba(168,85,247,0.4), rgba(99,102,241,0.2))',
      }}
    >
      <div className="relative rounded-xl bg-gray-900/95 px-5 py-4 flex items-start gap-4">
        <div className="flex-shrink-0 mt-0.5">
          <Sparkles className="h-5 w-5 text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 leading-relaxed">{headline}</p>
          <p className="text-xs text-gray-500 mt-1">{advice}</p>
        </div>
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 text-gray-600 hover:text-gray-400 transition-colors p-1 -m-1"
          title="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtCost(n: number) {
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}

// Sum a date-bucketed series for [start, end).
function sumWindow<T extends { date: string }>(
  rows: T[],
  start: Date,
  end: Date,
  pick: (r: T) => number,
): number {
  let total = 0;
  for (const r of rows) {
    const d = new Date(r.date);
    if (d >= start && d < end) total += pick(r);
  }
  return total;
}

// ── Stat cards (gradient style, matches /me) ────────────────────────────────

type StatKey = 'sessions' | 'tokens' | 'cost' | 'team';
type Accent = 'indigo' | 'purple' | 'cyan' | 'amber';

function StatCard({
  active, accent, label, Icon, value, sub, onClick,
}: {
  active: boolean;
  accent: Accent;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  value: React.ReactNode;
  sub: React.ReactNode;
  onClick: () => void;
}) {
  const accentMap: Record<Accent, { grad: string; text: string; ring: string }> = {
    indigo: { grad: 'from-indigo-500/20 to-indigo-500/0', text: 'text-indigo-300', ring: 'ring-indigo-500/40' },
    purple: { grad: 'from-purple-500/20 to-purple-500/0', text: 'text-purple-300', ring: 'ring-purple-500/40' },
    cyan:   { grad: 'from-cyan-500/20 to-cyan-500/0',     text: 'text-cyan-300',   ring: 'ring-cyan-500/40' },
    amber:  { grad: 'from-amber-500/20 to-amber-500/0',   text: 'text-amber-300',  ring: 'ring-amber-500/40' },
  };
  const a = accentMap[accent];
  return (
    <button
      onClick={onClick}
      className={`relative rounded-xl border p-4 text-left overflow-hidden transition-all hover:border-gray-700 ${
        active ? `border-gray-600 ring-1 ${a.ring}` : 'border-gray-800/80'
      } bg-gray-900/40`}
    >
      <div className={`absolute inset-0 bg-gradient-to-br ${a.grad} opacity-60 pointer-events-none`} />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Icon className={`w-3 h-3 ${a.text}`} />
            {label}
          </span>
          <ChevronDown className={`w-3 h-3 text-gray-600 transition-transform ${active ? 'rotate-180' : ''}`} />
        </div>
        <div className="text-2xl font-semibold text-gray-50 tabular-nums">{value}</div>
        <div className="text-[11px] text-gray-500 mt-1">{sub}</div>
      </div>
    </button>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'prompts' | 'cost' | 'efficiency' | 'quality' | 'team';
const TABS: { key: Tab; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'overview',   label: 'Activity',    Icon: BarChart3 },
  { key: 'team',       label: 'Team',        Icon: Users },
  { key: 'cost',       label: 'Cost',        Icon: DollarSign },
  { key: 'efficiency', label: 'Efficiency',  Icon: Gauge },
  { key: 'quality',    label: 'Quality',     Icon: ShieldCheck },
  { key: 'prompts',    label: 'Prompts',     Icon: Search },
];

const QUALITY_COLORS = ['#22c55e', '#ef4444', '#f59e0b', '#6b7280'];

// ── Page ────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user, activeOrg, activeOrgId } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentSessions, setRecentSessions] = useState<Session[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [agents, setAgents] = useState<api.Agent[]>([]);
  const [apiKeys, setApiKeys] = useState<{ id: string; repoScopes: any[]; agentScopes: any[] }[]>([]);
  const [memberGrants, setMemberGrants] = useState(false);
  const [activeSessions, setActiveSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [complianceScore, setComplianceScore] = useState<number | null>(null);

  const [tab, setTab] = useState<Tab>('overview');
  const [expandedKpi, setExpandedKpi] = useState<StatKey | null>(null);

  // Team-scoped data
  const [adoption, setAdoption] = useState<TeamAdoption | null>(null);
  const [efficiency, setEfficiency] = useState<TeamEfficiency | null>(null);
  const [efficiencyLoading, setEfficiencyLoading] = useState(false);

  // Prompts tab state
  const [promptQuery, setPromptQuery] = useState('');
  const [promptQueryDebounced, setPromptQueryDebounced] = useState('');
  const [promptUserFilter, setPromptUserFilter] = useState('');
  const [promptAgentFilter, setPromptAgentFilter] = useState('');
  const [promptRepoFilter, setPromptRepoFilter] = useState('');
  // Lazy-loaded list of repos for the filter dropdown — uses the same
  // /api/repos endpoint that the Repos page does, so the option list matches.
  const [promptRepoOptions, setPromptRepoOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [prompts, setPrompts] = useState<TeamPromptEntry[]>([]);
  const [promptsTotal, setPromptsTotal] = useState(0);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);

  // Today's sessions (org-wide) for the "What did the team ship today?" banner
  const [todaySessions, setTodaySessions] = useState<Session[]>([]);
  const [shipTodayOpen, setShipTodayOpen] = useState(false);
  const [brief, setBrief] = useState<TodayBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefGeneratedAt, setBriefGeneratedAt] = useState<string | null>(null);
  const [briefError, setBriefError] = useState<string | null>(null);

  const fetchTodayBrief = () => {
    setBriefLoading(true);
    api.getTodayBrief()
      .then((r) => {
        setBrief(r.brief);
        setBriefGeneratedAt(r.generatedAt);
        setBriefError(null);
      })
      .catch((err: any) => {
        setBriefError(err?.message || 'Failed to load brief');
      })
      .finally(() => setBriefLoading(false));
  };

  const onboardingKey = `origin_onboarding_dismissed_${activeOrgId || ''}`;
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try { return localStorage.getItem(onboardingKey) === 'true'; } catch { return false; }
  });

  useEffect(() => {
    Promise.all([
      api.getStats(),
      api.getSessions({ limit: 10 }),
      api.getIntegrations().catch(() => []),
      api.getPolicies().catch(() => []),
      api.getActiveSessions().catch(() => ({ sessions: [] })),
      api.getAgents().catch(() => []),
      api.getApiKeys().catch(() => []),
      api.getUsers().catch(() => ({ users: [] })),
    ])
      .then(([s, sess, integ, pol, active, ag, keys, usersResp]) => {
        setStats(s);
        setRecentSessions(sess.sessions);
        setIntegrations(integ);
        setPolicies(pol);
        setActiveSessions(active.sessions);
        setAgents(ag);
        setApiKeys(keys);
        setMemberGrants(usersResp.users.some((u) => (u.repoGrants ?? 0) > 0 || (u.agentGrants ?? 0) > 0));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    api.getComplianceScore()
      .then((r) => setComplianceScore(r.score))
      .catch(() => {});

    api.getTeamAdoption()
      .then(setAdoption)
      .catch(() => {});

    // Today's sessions (org-wide) for the ship-today banner.
    api.getSessions({ limit: 100 })
      .then((r) => {
        const today = new Date().toDateString();
        setTodaySessions(
          r.sessions.filter((s) => new Date(s.startedAt || s.createdAt).toDateString() === today),
        );
      })
      .catch(() => {});

    // Daily brief — server caches for 1h, page also re-fetches hourly so a
    // long-lived tab gets fresh narrative without a manual reload.
    fetchTodayBrief();
    const briefInterval = setInterval(fetchTodayBrief, 60 * 60 * 1000);

    const interval = setInterval(() => {
      api.getActiveSessions()
        .then((r) => setActiveSessions(r.sessions))
        .catch(() => {});
    }, 10000);

    return () => {
      clearInterval(interval);
      clearInterval(briefInterval);
    };
  }, []);

  // Lazy-load efficiency on tab open
  useEffect(() => {
    if (tab !== 'efficiency' || efficiency) return;
    setEfficiencyLoading(true);
    api.getTeamEfficiency()
      .then(setEfficiency)
      .catch(() => {})
      .finally(() => setEfficiencyLoading(false));
  }, [tab, efficiency]);

  // Debounce prompt search
  useEffect(() => {
    const t = setTimeout(() => setPromptQueryDebounced(promptQuery), 250);
    return () => clearTimeout(t);
  }, [promptQuery]);

  // Lazy-load prompts on tab open + on filter changes
  useEffect(() => {
    if (tab !== 'prompts') return;
    setPromptsLoading(true);
    api.getTeamPrompts({
      q: promptQueryDebounced,
      userId: promptUserFilter,
      agentId: promptAgentFilter,
      repoId: promptRepoFilter,
      limit: 50,
    })
      .then((r) => { setPrompts(r.prompts); setPromptsTotal(r.total); })
      .catch(() => {})
      .finally(() => setPromptsLoading(false));
  }, [tab, promptQueryDebounced, promptUserFilter, promptAgentFilter, promptRepoFilter]);

  // Load repo list once on first prompts-tab visit. Cached for the rest of
  // the session — repo lists don't change often enough to refetch.
  useEffect(() => {
    if (tab !== 'prompts' || promptRepoOptions.length > 0) return;
    api.getRepos()
      .then((repos) => setPromptRepoOptions(repos.map((r) => ({ id: r.id, name: r.name }))))
      .catch(() => {});
  }, [tab, promptRepoOptions.length]);

  // Week-over-week deltas, derived from sessionsByDay/costByDay.
  const weekly = useMemo(() => {
    const empty = {
      sessions: { current: 0, previous: 0 },
      cost:     { current: 0, previous: 0 },
      tokens:   { current: 0, previous: 0 },
    };
    if (!stats) return empty;
    const now = new Date();
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - now.getDay());
    startOfThisWeek.setHours(0, 0, 0, 0);
    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
    const sessionsByDay = stats.sessionsByDay ?? [];
    const costByDay = stats.costByDay ?? [];
    const tokensByDay = stats.tokensByDay ?? [];
    return {
      sessions: {
        current:  sumWindow(sessionsByDay, startOfThisWeek, now,            (r) => r.count),
        previous: sumWindow(sessionsByDay, startOfLastWeek, startOfThisWeek, (r) => r.count),
      },
      cost: {
        current:  sumWindow(costByDay, startOfThisWeek, now,            (r) => r.cost),
        previous: sumWindow(costByDay, startOfLastWeek, startOfThisWeek, (r) => r.cost),
      },
      tokens: {
        current:  sumWindow(tokensByDay, startOfThisWeek, now,            (r) => r.tokens),
        previous: sumWindow(tokensByDay, startOfLastWeek, startOfThisWeek, (r) => r.tokens),
      },
    };
  }, [stats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card text-center py-12">
        <p className="text-red-400 mb-2">Failed to load dashboard</p>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  if (!stats) return null;

  // ── Onboarding ───────────────────────────────────────────────────────────
  const hasGitHubConnected = integrations.some((i) => i.provider === 'github');
  const hasRepos = (stats.totalRepos ?? 0) > 0;
  const hasAgents = agents.length > 0;
  const hasApiKey = apiKeys.length > 0;
  const hasApiKeyScoped = apiKeys.some((k) => k.repoScopes.length > 0 || k.agentScopes.length > 0) || memberGrants;
  const hasSessions = (stats.totalSessions ?? 0) > 0;
  const hasPolicies = policies.length > 0;

  const setupSteps = [
    { label: 'Connect GitHub',     done: hasGitHubConnected, link: '/settings?tab=integrations', cta: 'Connect',       icon: '🔗' },
    { label: 'Import a repository', done: hasRepos,           link: '/repos',                     cta: 'Import',        icon: '📦' },
    { label: 'Register an agent',  done: hasAgents,          link: '/agents',                    cta: 'Create agent',  icon: '🤖' },
    { label: 'Create an API key',  done: hasApiKey,          link: '/iam',                       cta: 'Create key',    icon: '🔑' },
    { label: 'Assign permissions', done: hasApiKeyScoped,    link: '/iam',                       cta: 'Configure',     icon: '⚙️' },
    { label: 'Run a session',      done: hasSessions,        link: '/docs#quick-start',          cta: 'Setup guide',   icon: '⚡' },
    { label: 'Create a policy',    done: hasPolicies,        link: '/policies',                  cta: 'Create policy', icon: '🛡️' },
  ];
  const completedSteps = setupSteps.filter((s) => s.done).length;
  const allSetUp = completedSteps === setupSteps.length;

  // Recent sessions are only used for the AI quality score on the Quality tab.
  const scored = recentSessions.filter((s) => s.review?.score != null);
  const avgScore = scored.length > 0
    ? Math.round(scored.reduce((sum, s) => sum + (s.review?.score ?? 0), 0) / scored.length)
    : null;
  const autoReviewed = recentSessions.filter((s) => s.review?.isAutoReview).length;

  // Top engineers (already ranked server-side).
  const topEngineers = (stats.topContributors ?? []).slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle={activeOrg?.name ? `${activeOrg.name} · Team coding activity` : 'Team coding activity'}
        actions={activeSessions.length > 0 ? (
          <Link
            to="/sessions?status=running"
            className="flex items-center gap-2 rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-medium text-purple-300 hover:bg-purple-500/15 transition-colors"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
            </span>
            {activeSessions.length} active now
          </Link>
        ) : undefined}
      />

      {/* ── AI Insight Banner ──────────────────────────────────────────── */}
      <InsightBanner stats={stats} />

      {/* ── Onboarding (only when incomplete) ─────────────────────────── */}
      {!allSetUp && !onboardingDismissed && (() => {
        const firstIncomplete = setupSteps.findIndex((s) => !s.done);
        return (
          <div className="relative">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-medium text-gray-400">Setup</h2>
                <div className="flex items-center gap-1.5">
                  <div className="w-20 h-1 bg-gray-700/50 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-indigo-500 to-green-500 rounded-full transition-all duration-700"
                      style={{ width: `${(completedSteps / setupSteps.length) * 100}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-600">{completedSteps}/{setupSteps.length}</span>
                </div>
              </div>
              <button
                onClick={() => { try { localStorage.setItem(onboardingKey, 'true'); } catch { /* ignore */ } setOnboardingDismissed(true); }}
                className="text-gray-600 hover:text-gray-400 transition-colors"
                title="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
              {setupSteps.map((step, i) => {
                const isCurrent = i === firstIncomplete;
                return (
                  <Link
                    key={i}
                    to={step.link}
                    className={`group flex-shrink-0 rounded-lg px-3 py-2.5 transition-all duration-200 border w-[160px] ${
                      step.done
                        ? 'bg-green-900/8 border-green-800/20'
                        : isCurrent
                          ? 'bg-indigo-900/15 border-indigo-500/30 ring-1 ring-indigo-500/20'
                          : 'bg-gray-800/30 border-gray-700/30 opacity-50 hover:opacity-75'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm">{step.icon}</span>
                      {step.done ? (
                        <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <span className={`text-[9px] font-bold ${isCurrent ? 'text-indigo-400' : 'text-gray-600'}`}>{i + 1}</span>
                      )}
                    </div>
                    <p className={`text-[11px] font-medium leading-tight ${step.done ? 'text-green-400' : isCurrent ? 'text-gray-200' : 'text-gray-500'}`}>
                      {step.label}
                    </p>
                    {!step.done && isCurrent && (
                      <span className="inline-block mt-1.5 text-[10px] font-medium text-indigo-400">{step.cta} →</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Active sessions ribbon removed from the top — the running-session
          count is already exposed by the "N active now" pill in the page
          header, and a full-width row here pushed the KPI cards too far
          down for at-a-glance scanning. */}

      {/* ── Stat cards (gradient) ─────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            active={expandedKpi === 'sessions'}
            accent="indigo"
            label="Sessions"
            Icon={Play}
            value={fmt(stats.totalSessions)}
            sub={<Trend current={weekly.sessions.current} previous={weekly.sessions.previous} />}
            onClick={() => setExpandedKpi(expandedKpi === 'sessions' ? null : 'sessions')}
          />
          <StatCard
            active={expandedKpi === 'tokens'}
            accent="purple"
            label="Tokens"
            Icon={Zap}
            value={fmt(stats.tokensUsed)}
            sub={<Trend current={weekly.tokens.current} previous={weekly.tokens.previous} />}
            onClick={() => setExpandedKpi(expandedKpi === 'tokens' ? null : 'tokens')}
          />
          <StatCard
            active={expandedKpi === 'cost'}
            accent="cyan"
            label="Cost This Month"
            Icon={DollarSign}
            value={fmtCost(stats.estimatedCostThisMonth)}
            sub={<Trend current={weekly.cost.current} previous={weekly.cost.previous} />}
            onClick={() => setExpandedKpi(expandedKpi === 'cost' ? null : 'cost')}
          />
          <StatCard
            active={expandedKpi === 'team'}
            accent="amber"
            label="Adoption"
            Icon={Users}
            value={
              adoption
                ? <span>{adoption.activeThisWeek}<span className="text-gray-500">/{adoption.totalEngineers}</span></span>
                : fmt(topEngineers.length || stats.totalUsers || 0)
            }
            sub={
              adoption ? (
                <span className="flex items-center gap-1.5 text-gray-500">
                  <span>{adoption.adoptionPct}% active this week</span>
                  {adoption.newAdopters > 0 && (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] font-medium">
                      <UserPlus className="w-2.5 h-2.5" />
                      +{adoption.newAdopters}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-gray-500">engineers active</span>
              )
            }
            onClick={() => setExpandedKpi(expandedKpi === 'team' ? null : 'team')}
          />
        </div>

        {/* Expand-to-detail panel — mirrors solo dashboard's by-agent breakdown */}
        {expandedKpi === 'sessions' && stats.topAgents && stats.topAgents.length > 0 && (
          <BreakdownPanel
            title="Sessions by agent"
            rows={stats.topAgents.map((a) => ({ name: a.name, value: fmt(a.count), share: a.count, color: agentColor(a.name) }))}
            onClose={() => setExpandedKpi(null)}
          />
        )}
        {expandedKpi === 'cost' && (() => {
          const byAgent = (stats.tokensByAgent ?? []).filter((a) => a.cost > 0);
          if (byAgent.length > 0) {
            const sortedByCost = [...byAgent].sort((a, b) => b.cost - a.cost);
            return (
              <BreakdownPanel
                title="Cost by agent"
                rows={sortedByCost.map((a) => ({
                  name: a.name,
                  value: fmtCost(a.cost),
                  share: a.cost,
                  color: agentColor(a.name),
                }))}
                onClose={() => setExpandedKpi(null)}
              />
            );
          }
          if ((stats.costByModel ?? []).length > 0) {
            return (
              <BreakdownPanel
                title="Cost by model"
                rows={(stats.costByModel ?? []).map((m) => ({ name: m.model, value: fmtCost(m.cost), share: m.cost, color: agentColor(m.model) }))}
                onClose={() => setExpandedKpi(null)}
              />
            );
          }
          return null;
        })()}
        {expandedKpi === 'tokens' && (() => {
          // Prefer real tokens-by-agent if backend supplies it; otherwise fall back
          // to tokens-by-model from costByModel; otherwise show session counts.
          const byAgent = stats.tokensByAgent ?? [];
          if (byAgent.length > 0) {
            return (
              <BreakdownPanel
                title="Tokens by agent"
                rows={byAgent.map((a) => ({
                  name: a.name,
                  value: fmt(a.tokens),
                  share: a.tokens,
                  color: agentColor(a.name),
                }))}
                onClose={() => setExpandedKpi(null)}
              />
            );
          }
          const byModel = (stats.costByModel ?? []).filter((m) => (m.tokens ?? 0) > 0);
          if (byModel.length > 0) {
            return (
              <BreakdownPanel
                title="Tokens by model"
                rows={byModel.map((m) => ({
                  name: m.model,
                  value: fmt(m.tokens || 0),
                  share: m.tokens || 0,
                  color: agentColor(m.model),
                }))}
                onClose={() => setExpandedKpi(null)}
              />
            );
          }
          if ((stats.costByModel ?? []).length > 0) {
            return (
              <BreakdownPanel
                title="Sessions by model"
                rows={(stats.costByModel ?? []).map((m) => ({ name: m.model, value: fmt(m.count), share: m.count, color: agentColor(m.model) }))}
                onClose={() => setExpandedKpi(null)}
              />
            );
          }
          return null;
        })()}
        {expandedKpi === 'team' && topEngineers.length > 0 && (
          <BreakdownPanel
            title="Top engineers by sessions"
            rows={topEngineers.map((e) => ({ name: e.name, value: `${fmt(e.sessions)} sess`, share: e.sessions, color: '#a78bfa' }))}
            onClose={() => setExpandedKpi(null)}
          />
        )}
      </div>

      {/* ── What did the team ship today? ────────────────────────────── */}
      <ShipTodayBanner
        sessions={todaySessions}
        open={shipTodayOpen}
        onToggle={() => setShipTodayOpen((v) => !v)}
        brief={brief}
        briefLoading={briefLoading}
        briefGeneratedAt={briefGeneratedAt}
        briefError={briefError}
      />

      {/* ── Tabs ──────────────────────────────────────────────────────── */}
      <div className="border-b border-gray-800/80 flex items-center gap-1 -mb-px">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? 'border-indigo-500 text-indigo-300'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab stats={stats} />}
      {tab === 'prompts' && (
        <PromptsTab
          query={promptQuery}
          onQuery={setPromptQuery}
          userFilter={promptUserFilter}
          onUserFilter={setPromptUserFilter}
          agentFilter={promptAgentFilter}
          onAgentFilter={setPromptAgentFilter}
          repoFilter={promptRepoFilter}
          onRepoFilter={setPromptRepoFilter}
          loading={promptsLoading}
          prompts={prompts}
          total={promptsTotal}
          expanded={expandedPrompt}
          onExpand={setExpandedPrompt}
          engineers={topEngineers}
          agents={stats.topAgents ?? []}
          repos={promptRepoOptions}
        />
      )}
      {tab === 'cost' && <CostTab stats={stats} />}
      {tab === 'efficiency' && (
        <EfficiencyTab
          loading={efficiencyLoading}
          data={efficiency}
        />
      )}
      {tab === 'quality' && (
        <QualityTab
          stats={stats}
          avgScore={avgScore}
          scoredCount={scored.length}
          recentCount={recentSessions.length}
          autoReviewed={autoReviewed}
          complianceScore={complianceScore}
        />
      )}
      {tab === 'team' && <TeamTab stats={stats} topEngineers={topEngineers} adoption={adoption} />}
    </div>
  );
}

// ── BreakdownPanel ─────────────────────────────────────────────────────────

function BreakdownPanel({
  title, rows, onClose,
}: {
  title: string;
  rows: { name: string; value: string; share: number; color: string }[];
  onClose: () => void;
}) {
  const total = rows.reduce((s, r) => s + r.share, 0);
  return (
    <div className="card py-3 px-4 animate-fade-in">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">{title}</span>
        <button onClick={onClose} className="text-gray-600 hover:text-gray-400">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="space-y-2">
        {rows.slice(0, 6).map((r, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: r.color }} />
            <span className="text-sm text-gray-300 w-32 truncate">{r.name}</span>
            <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${total > 0 ? Math.max((r.share / total) * 100, 2) : 0}%`, backgroundColor: r.color }}
              />
            </div>
            <span className="text-sm font-medium text-gray-200 w-24 text-right tabular-nums">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Overview / Activity tab ────────────────────────────────────────────────

function OverviewTab({ stats }: { stats: Stats }) {
  const sessionsByDay14 = stats.sessionsByDay?.slice(-14) ?? [];
  const sessionsByHour = stats.sessionsByHour ?? [];
  const peak = sessionsByHour.reduce(
    (best, h) => (h.count > best.count ? h : best),
    { hour: 0, count: 0 } as { hour: number; count: number },
  );
  const totalSessions = sessionsByHour.reduce((s, h) => s + h.count, 0);
  const peakDayName = (() => {
    const tally: Record<number, number> = {};
    for (const d of stats.sessionsByDay ?? []) {
      const dow = new Date(d.date).getDay();
      tally[dow] = (tally[dow] ?? 0) + d.count;
    }
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (!top) return '—';
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(top[0])];
  })();

  const topAgents = (stats.topAgents ?? []).slice(0, 4);
  const topRepos = (stats.sessionsByRepo ?? []).slice(0, 4);
  const totalAgentSessions = topAgents.reduce((s, a) => s + a.count, 0);
  const totalRepoSessions = topRepos.reduce((s, r) => s + r.count, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Activity chart — wide */}
      <div className="card lg:col-span-2">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Sessions per day</p>
            <p className="text-xs text-gray-600 mt-0.5">Last 14 days</p>
          </div>
          <Link to="/insights" className="text-xs text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1">
            Insights <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sessionsByDay14}>
              <defs>
                <linearGradient id="sessGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.45} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={2} fill="url(#sessGrad)" />
              <XAxis dataKey="date" hide />
              <Tooltip
                contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                formatter={(v: number) => [v, 'Sessions']}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Patterns mini-card */}
      <div className="card">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">When the team codes</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Peak hour</p>
            <p className="text-2xl font-semibold text-gray-100 tabular-nums mt-0.5">
              {peak.count > 0 ? `${peak.hour.toString().padStart(2, '0')}:00` : '—'}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">
              {peak.count > 0 && totalSessions > 0
                ? `${Math.round((peak.count / totalSessions) * 100)}% of activity`
                : 'No data yet'}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Peak day</p>
            <p className="text-2xl font-semibold text-gray-100 mt-0.5">{peakDayName}</p>
            <p className="text-[10px] text-gray-600 mt-0.5">most sessions</p>
          </div>
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Avg session</p>
            <p className="text-2xl font-semibold text-gray-100 tabular-nums mt-0.5">
              {stats.avgSessionDuration > 0
                ? formatShortDuration(stats.avgSessionDuration)
                : '—'}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">
              {stats.avgSessionTokens > 0 ? `${fmt(stats.avgSessionTokens)} tok` : ''}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Avg cost</p>
            <p className="text-2xl font-semibold text-gray-100 tabular-nums mt-0.5">
              {stats.avgSessionCost > 0 ? `$${stats.avgSessionCost.toFixed(2)}` : '—'}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">per session</p>
          </div>
        </div>
      </div>

      {/* Top agents */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Top agents</p>
          <Link to="/agents" className="text-xs text-indigo-400 hover:text-indigo-300">View all →</Link>
        </div>
        {topAgents.length === 0 ? (
          <p className="text-xs text-gray-600">No agents yet.</p>
        ) : (
          <div className="space-y-2">
            {topAgents.map((a) => {
              const pct = totalAgentSessions > 0 ? (a.count / totalAgentSessions) * 100 : 0;
              const color = agentColor(a.name);
              return (
                <Link key={a.id} to={`/agents/${a.id}`} className="block group">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-sm text-gray-300 group-hover:text-gray-100 truncate flex-1">{a.name}</span>
                    <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">{fmt(a.count)}</span>
                  </div>
                  <div className="ml-5 h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: color }} />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Top repos */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Top repositories</p>
          <Link to="/repos" className="text-xs text-indigo-400 hover:text-indigo-300">View all →</Link>
        </div>
        {topRepos.length === 0 ? (
          <p className="text-xs text-gray-600">No repositories yet.</p>
        ) : (
          <div className="space-y-2">
            {topRepos.map((r) => {
              const pct = totalRepoSessions > 0 ? (r.count / totalRepoSessions) * 100 : 0;
              return (
                <div key={r.repo}>
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-sm text-gray-300 truncate flex-1">{r.repo}</span>
                    <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">{fmt(r.count)}</span>
                  </div>
                  <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-indigo-500/60" style={{ width: `${Math.max(pct, 2)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Lines written today */}
      <div className="card">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Lines written this month</p>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-gray-100 tabular-nums">{fmt(stats.linesWrittenThisMonth ?? 0)}</span>
        </div>
        <div className="mt-2 text-xs">
          <span className="text-emerald-400">+{fmt(stats.linesAdded ?? 0)}</span>
          <span className="text-gray-600 mx-1">/</span>
          <span className="text-red-400">-{fmt(stats.linesRemoved ?? 0)}</span>
        </div>
        <p className="text-[10px] text-gray-600 mt-2">
          AI authorship: <span className="text-indigo-300">{(stats.aiPercentage ?? 0).toFixed(0)}%</span> of recent commits
        </p>
      </div>
    </div>
  );
}

// ── Cost tab ────────────────────────────────────────────────────────────────

function CostTab({ stats }: { stats: Stats }) {
  const costByDay14 = stats.costByDay?.slice(-14) ?? [];
  const costByModel = stats.costByModel ?? [];
  const totalCost = costByModel.reduce((s, m) => s + m.cost, 0);

  // Annotate each day with a rolling 7-day average and an `isToday` flag so we
  // can render today's bar in a distinct shade — today is a partial day and
  // the previous smooth-area chart made it look like spending was "dropping"
  // when in fact it was the curve interpolating from a spike back to an
  // incomplete point. A bar chart removes that artifact entirely.
  const todayKey = new Date().toISOString().split('T')[0];
  const last14 = costByDay14.map((d, i, arr) => {
    const window = arr.slice(Math.max(0, i - 6), i + 1);
    const avg = window.reduce((s, w) => s + w.cost, 0) / window.length;
    const dt = new Date(d.date + 'T00:00:00Z');
    return {
      ...d,
      avg7: parseFloat(avg.toFixed(2)),
      isToday: d.date === todayKey,
      label: dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }),
    };
  });
  const totalSpend14 = last14.reduce((s, d) => s + d.cost, 0);
  const avgDaily = last14.length > 0 ? totalSpend14 / last14.length : 0;
  const peakDay = last14.reduce((max, d) => (d.cost > max.cost ? d : max), { cost: 0, date: '', label: '', avg7: 0, isToday: false });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Trend chart */}
      <div className="card lg:col-span-2">
        <div className="flex items-start justify-between mb-3 gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Daily spend</p>
            <p className="text-xs text-gray-600 mt-0.5">
              Last 14 days · ${totalSpend14.toFixed(2)} total · ${avgDaily.toFixed(2)}/day avg
              {peakDay.cost > 0 && <> · peak ${peakDay.cost.toFixed(2)} on {peakDay.label}</>}
            </p>
          </div>
          <Link to="/budget" className="text-xs text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1 flex-shrink-0">
            Set budget <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={last14} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="#6b7280"
                tick={{ fontSize: 10, fill: '#9ca3af' }}
                tickLine={false}
                axisLine={{ stroke: '#1f2937' }}
                interval={0}
              />
              <YAxis
                stroke="#6b7280"
                tick={{ fontSize: 10, fill: '#9ca3af' }}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) => `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`}
              />
              {avgDaily > 0 && (
                <ReferenceLine
                  y={avgDaily}
                  stroke="#6366f1"
                  strokeDasharray="4 3"
                  strokeOpacity={0.6}
                  label={{
                    value: `Avg $${avgDaily.toFixed(2)}`,
                    position: 'right',
                    fill: '#a5b4fc',
                    fontSize: 10,
                  }}
                />
              )}
              <Tooltip
                cursor={{ fill: '#1f293780' }}
                contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                labelFormatter={(label: string, payload: any) => {
                  const d = payload?.[0]?.payload;
                  return d?.isToday ? `${label} (today, partial)` : label;
                }}
                formatter={(v: number, name: string) => {
                  if (name === 'avg7') return [`$${v.toFixed(2)}`, '7-day avg'];
                  return [`$${v.toFixed(2)}`, 'Cost'];
                }}
              />
              <Bar dataKey="cost" radius={[3, 3, 0, 0]} maxBarSize={28}>
                {last14.map((d) => (
                  <Cell key={d.date} fill={d.isToday ? '#86efac' : '#22c55e'} fillOpacity={d.isToday ? 0.55 : 1} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Forecast */}
      {stats.projectedMonthlyCost !== undefined && stats.projectedMonthlyCost > 0 ? (
        <div className="card">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Month forecast</p>
          <div className="flex items-baseline gap-2">
            <p className="text-3xl font-semibold text-gray-100 tabular-nums">${stats.projectedMonthlyCost.toFixed(0)}</p>
            {stats.dailyCostTrend !== undefined && stats.dailyCostTrend !== 0 && (
              <span className={`flex items-center gap-0.5 text-xs font-medium ${stats.dailyCostTrend > 0 ? 'text-red-400' : 'text-green-400'}`}>
                {stats.dailyCostTrend > 0 ? '↑' : '↓'}
                {Math.abs(stats.dailyCostTrend * 100).toFixed(1)}%/day
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            Day {stats.daysElapsed ?? '?'} of {stats.daysInMonth ?? '?'} · ${stats.estimatedCostThisMonth.toFixed(2)} so far
          </p>
          {stats.projectedMonthlyCost > stats.estimatedCostThisMonth * 2 && (
            <div className="mt-3 flex items-start gap-2 text-[11px] bg-amber-900/20 border border-amber-800/30 rounded-md px-2.5 py-2">
              <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
              <span className="text-amber-300">Trending well above current spend. Set a budget.</span>
            </div>
          )}
        </div>
      ) : (
        <div className="card text-center text-xs text-gray-600 flex items-center justify-center">
          Forecast appears once you have a few days of data.
        </div>
      )}

      {/* Cost by model */}
      <div className="card lg:col-span-2">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Cost by model</p>
          <Link to="/insights" className="text-xs text-indigo-400 hover:text-indigo-300">Compare models →</Link>
        </div>
        {costByModel.length === 0 ? (
          <p className="text-xs text-gray-600">No spend yet.</p>
        ) : (
          <div className="space-y-2">
            {costByModel.map((m) => {
              const pct = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
              const color = agentColor(m.model);
              return (
                <div key={m.model}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-gray-300">{m.model}</span>
                    <span className="text-xs text-gray-500 tabular-nums">
                      {fmt(m.count)} sess · ${m.cost.toFixed(2)}
                    </span>
                  </div>
                  <div className="w-full bg-gray-800 rounded-full h-1.5">
                    <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Top spenders */}
      <div className="card">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Top spenders</p>
        {(stats.costByUser ?? []).length === 0 ? (
          <p className="text-xs text-gray-600">No data yet.</p>
        ) : (
          <div className="space-y-2">
            {(stats.costByUser ?? []).slice(0, 5).map((u) => (
              <div key={u.userId} className="flex items-center justify-between">
                <span className="text-sm text-gray-300 truncate">{u.name}</span>
                <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">${u.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Time-of-spend heatmap — full row. Self-fetching so we don't touch
          the existing Stats payload. Same data + look as the Spend Quality
          page; lives here so admins on the Cost tab see "when does the
          spend actually happen?" without leaving the dashboard. */}
      <div className="card lg:col-span-3">
        <DashboardSpendHeatmap />
      </div>
    </div>
  );
}

// Self-contained heatmap card for the Cost tab. Fetches the same /spend-
// heatmap endpoint Spend Quality uses; we don't share the SpendHeatmap
// component there because that one is wrapped in a SectionShell with
// loading/error semantics tuned to that page.
function DashboardSpendHeatmap() {
  const [cells, setCells] = React.useState<api.HeatmapCell[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    api.getSpendHeatmap({ range: '30d' })
      .then((res) => { if (!cancelled) { setCells(res.cells); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr(e.message || 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const max = cells.reduce((m, c) => Math.max(m, c.costUsd), 0.01);
  const grid = new Map<string, api.HeatmapCell>();
  for (const c of cells) grid.set(`${c.day}-${c.hour}`, c);
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Time-of-spend heatmap</p>
          <p className="text-xs text-gray-600 mt-0.5">Last 30 days · day × hour</p>
        </div>
        <Link to="/insights/spend-quality" className="text-xs text-indigo-400 hover:text-indigo-300">Open Spend Quality →</Link>
      </div>
      {loading && <p className="text-xs text-gray-500">Loading…</p>}
      {err && <p className="text-xs text-red-400">{err}</p>}
      {!loading && !err && cells.length === 0 && (
        <p className="text-xs text-gray-600">No spend in the last 30 days.</p>
      )}
      {!loading && !err && cells.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-[10px] border-separate border-spacing-0.5" aria-label="Spend heatmap day by hour">
            <thead>
              <tr>
                <th></th>
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} className="text-gray-600 font-normal w-4 text-center">{h % 6 === 0 ? h : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dayLabels.map((label, day) => (
                <tr key={day}>
                  <td className="text-gray-500 pr-2">{label}</td>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const cell = grid.get(`${day}-${hour}`);
                    const intensity = cell ? Math.min(1, cell.costUsd / max) : 0;
                    const bg = intensity > 0
                      ? `rgba(99,102,241,${0.1 + intensity * 0.7})`
                      : 'rgba(75,85,99,0.15)';
                    const title = cell
                      ? `${label} ${hour}:00 · $${cell.costUsd.toFixed(2)} · ${cell.sessionCount} sessions`
                      : `${label} ${hour}:00 · no spend`;
                    return (
                      <td key={hour}>
                        <div
                          className="w-4 h-4 rounded-sm"
                          title={title}
                          style={{ background: bg }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ── Quality tab ─────────────────────────────────────────────────────────────

function QualityTab({
  stats, avgScore, scoredCount, recentCount, autoReviewed, complianceScore,
}: {
  stats: Stats;
  avgScore: number | null;
  scoredCount: number;
  recentCount: number;
  autoReviewed: number;
  complianceScore: number | null;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* AI Quality Score */}
      <div className="card">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">AI quality score</p>
        <div className="flex items-center gap-5">
          <div className="text-center">
            <div className={`text-5xl font-semibold tabular-nums ${
              avgScore == null ? 'text-gray-500' :
              avgScore >= 80 ? 'text-green-400' :
              avgScore >= 50 ? 'text-amber-400' : 'text-red-400'
            }`}>
              {avgScore ?? '—'}
            </div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">Avg</p>
          </div>
          <div className="flex-1 space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Auto-reviewed</span>
              <span className="text-gray-300 font-medium tabular-nums">{autoReviewed}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Scored</span>
              <span className="text-gray-300 font-medium tabular-nums">{scoredCount}/{recentCount}</span>
            </div>
            {complianceScore !== null && (
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Compliance</span>
                <span className={`font-medium tabular-nums ${
                  complianceScore >= 80 ? 'text-green-400' : complianceScore >= 60 ? 'text-amber-400' : 'text-red-400'
                }`}>{complianceScore}</span>
              </div>
            )}
          </div>
        </div>
        <p className="text-[10px] text-gray-600 mt-3">
          Every session is scored automatically by AI. <Link to="/sessions" className="text-indigo-400 hover:text-indigo-300">Browse sessions →</Link>
        </p>
      </div>

      {/* Review status */}
      <div className="card">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Review status</p>
        {stats.qualityMetrics ? (
          <div className="flex items-center gap-5">
            <div className="w-24 h-24 flex-shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { name: 'Approved', value: stats.qualityMetrics.approved },
                      { name: 'Rejected', value: stats.qualityMetrics.rejected },
                      { name: 'Flagged',  value: stats.qualityMetrics.flagged },
                      { name: 'Pending',  value: stats.qualityMetrics.pending },
                    ]}
                    innerRadius={26}
                    outerRadius={44}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {QUALITY_COLORS.map((c, i) => <Cell key={i} fill={c} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-1 text-sm">
              <p className="text-gray-300"><span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-2" />{stats.qualityMetrics.approved} approved</p>
              <p className="text-gray-300"><span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-2" />{stats.qualityMetrics.rejected} rejected</p>
              <p className="text-gray-300"><span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-2" />{stats.qualityMetrics.flagged} flagged</p>
              <p className="text-gray-300"><span className="inline-block w-2 h-2 rounded-full bg-gray-500 mr-2" />{stats.qualityMetrics.pending} pending</p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-gray-600">No reviews yet.</p>
        )}
      </div>

      {/* Policy compliance */}
      <div className="card">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Policy compliance</p>
        <div className="flex items-baseline gap-2">
          <p className="text-3xl font-semibold text-gray-100 tabular-nums">{stats.policyViolations}</p>
          <p className="text-sm text-gray-500">violation{stats.policyViolations !== 1 ? 's' : ''}</p>
        </div>
        {stats.violationsByType && stats.violationsByType.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            {stats.violationsByType.slice(0, 4).map((v) => (
              <Link
                key={v.type}
                to="/sessions?violations=1"
                className="flex items-center justify-between text-sm hover:bg-gray-800/30 rounded px-2 py-1 -mx-2"
              >
                <span className="text-gray-400">{v.type.replace(/_/g, ' ')}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 tabular-nums">{v.count}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-600 mt-2">No violations detected.</p>
        )}
        <div className="mt-3 pt-3 border-t border-gray-800 text-xs text-gray-500">
          Compliance rate:{' '}
          <span className="text-green-400 font-medium">
            {stats.totalSessions > 0
              ? ((1 - stats.policyViolations / stats.totalSessions) * 100).toFixed(1)
              : '100.0'}%
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Team tab ────────────────────────────────────────────────────────────────

function TeamTab({
  stats,
  topEngineers,
  adoption,
}: {
  stats: Stats;
  topEngineers: Stats['topContributors'];
  adoption: TeamAdoption | null;
}) {
  const maxSessions = Math.max(1, ...topEngineers.map((e) => e.sessions));
  const adoptionDelta = adoption ? adoption.activeThisWeek - adoption.activeLastWeek : 0;
  return (
    <div className="space-y-4">
      {/* Adoption strip */}
      {adoption && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Team adoption</p>
            <span className="text-[10px] text-gray-600">this week</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold text-gray-100 tabular-nums">{adoption.adoptionPct}%</span>
                {adoptionDelta !== 0 && (
                  <span className={`text-xs font-medium ${adoptionDelta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {adoptionDelta > 0 ? '↑' : '↓'}{Math.abs(adoptionDelta)}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">Active</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-gray-100 tabular-nums">
                {adoption.activeThisWeek}<span className="text-gray-500">/{adoption.totalEngineers}</span>
              </p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">Engineers using AI</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-emerald-400 tabular-nums">{adoption.newAdopters}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">New adopters</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-gray-100 tabular-nums">{adoption.activeLastWeek}</p>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">Last week</p>
            </div>
          </div>
          {/* Adoption progress bar */}
          <div className="mt-3 h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${adoption.adoptionPct}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Top engineers</p>
            <Link to="/insights" className="text-xs text-indigo-400 hover:text-indigo-300">All contributors →</Link>
          </div>
          {topEngineers.length === 0 ? (
            <p className="text-xs text-gray-600">No engineer activity yet.</p>
          ) : (
            <div className="space-y-3">
              {topEngineers.map((e) => (
                <div key={e.id}>
                  <div className="flex items-center gap-3 text-sm mb-1">
                    <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">
                      {(e.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <span className="text-gray-200 flex-1 truncate">{e.name}</span>
                    <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">
                      {fmt(e.sessions)} sess · ${e.cost.toFixed(2)}
                    </span>
                  </div>
                  <div className="ml-9 h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full"
                      style={{ width: `${(e.sessions / maxSessions) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Sessions per day</p>
            <span className="text-[10px] text-gray-600">last 30d</span>
          </div>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={(stats.sessionsByDay ?? []).slice(-30)}>
                <Bar dataKey="count" fill="#a78bfa" radius={[2, 2, 0, 0]} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                  formatter={(v: number) => [v, 'Sessions']}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-gray-800/80">
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">This week</p>
              <p className="text-base font-semibold text-gray-100 tabular-nums mt-0.5">{stats.sessionsThisWeek}</p>
            </div>
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Engineers</p>
              <p className="text-base font-semibold text-gray-100 tabular-nums mt-0.5">{topEngineers.length}</p>
            </div>
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">AI %</p>
              <p className="text-base font-semibold text-indigo-300 tabular-nums mt-0.5">
                {(stats.aiPercentage ?? 0).toFixed(0)}%
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Ship-today banner ──────────────────────────────────────────────────────

function ShipTodayBanner({
  sessions, open, onToggle, brief, briefLoading, briefGeneratedAt, briefError,
}: {
  sessions: Session[];
  open: boolean;
  onToggle: () => void;
  brief: TodayBrief | null;
  briefLoading: boolean;
  briefGeneratedAt: string | null;
  briefError: string | null;
}) {
  // Group by engineer name. We aggregate session counts and total lines so the
  // collapsed summary is informative even when we can't see individual rows.
  const byEngineer = useMemo(() => {
    const map = new Map<string, { name: string; sessions: number; linesAdded: number; cost: number; topRepo: string | null }>();
    for (const s of sessions) {
      const name = s.userName || s.commitAuthor || s.apiKeyName || 'Unknown';
      const cur = map.get(name) ?? { name, sessions: 0, linesAdded: 0, cost: 0, topRepo: null };
      cur.sessions += 1;
      cur.linesAdded += s.linesAdded || 0;
      cur.cost += s.costUsd || 0;
      if (!cur.topRepo && s.repoName) cur.topRepo = s.repoName;
      map.set(name, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.sessions - a.sessions);
  }, [sessions]);

  const totalLines = sessions.reduce((s, x) => s + (x.linesAdded || 0), 0);
  const totalCost = sessions.reduce((s, x) => s + (x.costUsd || 0), 0);

  const empty = sessions.length === 0;

  return (
    <button
      onClick={empty ? undefined : onToggle}
      className={`w-full text-left rounded-xl border bg-gray-900/40 transition-colors ${
        empty
          ? 'border-gray-800/60 cursor-default'
          : 'border-gray-800/80 hover:border-gray-700'
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <FileText className={`w-4 h-4 flex-shrink-0 ${empty ? 'text-gray-600' : 'text-indigo-400'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">What did the team ship today?</p>
          {empty ? (
            <p className="text-sm text-gray-500 mt-0.5">
              No sessions yet today. The day's activity rolls up here as your team codes.
            </p>
          ) : (
            <p className="text-sm text-gray-300 mt-0.5 truncate">
              {byEngineer.length} engineer{byEngineer.length !== 1 ? 's' : ''} · {sessions.length} session{sessions.length !== 1 ? 's' : ''} ·{' '}
              <span className="text-emerald-400">+{fmt(totalLines)} lines</span>
              <span className="text-gray-600"> · ${totalCost.toFixed(2)}</span>
            </p>
          )}
        </div>
        {!empty && (
          <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </div>
      {open && !empty && (
        <div className="border-t border-gray-800/80 px-4 py-3 space-y-3">
          <BriefSection
            brief={brief}
            loading={briefLoading}
            generatedAt={briefGeneratedAt}
            error={briefError}
          />
        </div>
      )}
      {open && !empty && byEngineer.length > 0 && (
        <div className="border-t border-gray-800/80 px-4 py-3 space-y-2">
          {byEngineer.slice(0, 8).map((e) => (
            <div key={e.name} className="flex items-center gap-3 text-sm">
              <div className="w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
                {e.name.charAt(0).toUpperCase()}
              </div>
              <span className="text-gray-200 flex-shrink-0">{e.name}</span>
              <span className="text-xs text-gray-500 truncate">
                {e.sessions} session{e.sessions !== 1 ? 's' : ''}
                {e.topRepo && <> · {e.topRepo}</>}
              </span>
              <span className="ml-auto text-xs text-emerald-400 tabular-nums flex-shrink-0">
                +{fmt(e.linesAdded)} lines
              </span>
              <span className="text-xs text-gray-600 tabular-nums w-14 text-right flex-shrink-0">
                ${e.cost.toFixed(2)}
              </span>
            </div>
          ))}
          {byEngineer.length > 8 && (
            <p className="text-[11px] text-gray-600 mt-2">+{byEngineer.length - 8} more engineers</p>
          )}
        </div>
      )}
    </button>
  );
}

// ── LLM-generated daily brief, rendered inside the ShipTodayBanner ──────
function BriefSection({
  brief, loading, generatedAt, error,
}: {
  brief: TodayBrief | null;
  loading: boolean;
  generatedAt: string | null;
  error: string | null;
}) {
  const ageLabel = useMemo(() => {
    if (!generatedAt) return null;
    const ms = Date.now() - new Date(generatedAt).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
  }, [generatedAt]);

  if (loading && !brief) {
    return <p className="text-xs text-gray-500">Generating dispatch…</p>;
  }
  if (error) {
    return <p className="text-xs text-amber-400">{error}</p>;
  }
  if (!brief) return null;

  return (
    <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-100 leading-relaxed">{brief.headline}</p>
        {ageLabel && (
          <span className="text-[10px] text-gray-600 uppercase tracking-wider whitespace-nowrap mt-0.5">
            {ageLabel}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {brief.sections.map((sec) => (
          <div key={sec.title} className="rounded-md border border-gray-800/60 bg-gray-950/40 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400 mb-1.5">
              {sec.title}
            </p>
            <ul className="space-y-1.5">
              {sec.bullets.map((b, i) => (
                <li key={i} className="text-xs text-gray-300 leading-snug">
                  {b}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Compact filter chip ─────────────────────────────────────────────────
// Native <select> styled as a rounded pill with a leading icon. Inactive
// (empty value) chip is muted; the moment you pick a value it tints
// indigo so the active filters are scannable at a glance. Native select is
// kept for accessibility + zero-dep keyboard handling — we just hide the
// browser arrow and overlay our own chevron.

function FilterChip({
  icon, label, value, onChange, options, allLabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  allLabel: string;
}) {
  const active = value !== '';
  const selected = active ? options.find((o) => o.value === value) : null;
  return (
    <label
      className={`relative inline-flex items-center gap-1.5 pl-2.5 pr-7 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
        active
          ? 'bg-indigo-500/15 text-indigo-200 border-indigo-500/40 hover:bg-indigo-500/20'
          : 'bg-gray-900/60 text-gray-400 border-gray-800 hover:text-gray-200 hover:border-gray-700'
      }`}
    >
      <span className={`flex-shrink-0 ${active ? 'text-indigo-300' : 'text-gray-500'}`}>
        {icon}
      </span>
      <span>
        {selected ? `${label}: ${selected.label}` : allLabel}
      </span>
      <ChevronDown className={`absolute right-2 w-3 h-3 ${active ? 'text-indigo-300' : 'text-gray-500'}`} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
        aria-label={allLabel}
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// ── Prompts tab (org-wide search) ──────────────────────────────────────────

function PromptsTab({
  query, onQuery,
  userFilter, onUserFilter,
  agentFilter, onAgentFilter,
  repoFilter, onRepoFilter,
  loading, prompts, total,
  expanded, onExpand,
  engineers, agents, repos,
}: {
  query: string;
  onQuery: (v: string) => void;
  userFilter: string;
  onUserFilter: (v: string) => void;
  agentFilter: string;
  onAgentFilter: (v: string) => void;
  repoFilter: string;
  onRepoFilter: (v: string) => void;
  loading: boolean;
  prompts: TeamPromptEntry[];
  total: number;
  expanded: string | null;
  onExpand: (v: string | null) => void;
  engineers: Stats['topContributors'];
  agents: Stats['topAgents'];
  repos: Array<{ id: string; name: string }>;
}) {
  const anyFilterActive = !!(userFilter || agentFilter || repoFilter || query);
  const clearAll = () => {
    onQuery('');
    onUserFilter('');
    onAgentFilter('');
    onRepoFilter('');
  };
  return (
    <div className="space-y-4">
      {/* Filter row: full-width search up top, compact chip dropdowns
          beneath. The chips share a baseline visual language — small
          rounded pill, leading icon, native <select> for accessibility but
          styled to look custom. Active chips (non-empty value) get a
          subtle indigo tint so it's immediately clear what's narrowing
          the result set. */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search the team's prompts (e.g. 'Stripe webhook', 'auth migration')…"
            className="input pl-10"
          />
        </div>
        <div className="flex items-center flex-wrap gap-2">
          <FilterChip
            icon={<Users className="w-3.5 h-3.5" />}
            label="engineer"
            value={userFilter}
            onChange={onUserFilter}
            options={engineers.map((e) => ({ value: e.id, label: e.name }))}
            allLabel="All engineers"
          />
          <FilterChip
            icon={<Sparkles className="w-3.5 h-3.5" />}
            label="agent"
            value={agentFilter}
            onChange={onAgentFilter}
            options={agents.map((a) => ({ value: a.id, label: a.name }))}
            allLabel="All agents"
          />
          <FilterChip
            icon={<FileText className="w-3.5 h-3.5" />}
            label="repo"
            value={repoFilter}
            onChange={onRepoFilter}
            options={repos.map((r) => ({ value: r.id, label: r.name }))}
            allLabel="All repos"
          />
          <div className="flex items-center gap-3 ml-auto">
            {anyFilterActive && (
              <button
                onClick={clearAll}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" /> Clear
              </button>
            )}
            <span className="text-xs text-gray-500 whitespace-nowrap tabular-nums">
              {total.toLocaleString()} result{total !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card animate-pulse">
              <div className="h-3 w-32 bg-gray-800 rounded mb-2" />
              <div className="h-3 w-full bg-gray-800/50 rounded" />
            </div>
          ))}
        </div>
      ) : prompts.length === 0 ? (
        <div className="card py-12 text-center text-gray-600 text-sm">
          {query
            ? 'No prompts match that query.'
            : 'No prompts captured yet. Once your team runs sessions through the Origin CLI, prompts will be searchable here.'}
        </div>
      ) : (
        <div className="space-y-2">
          {prompts.map((p) => {
            const key = `${p.sessionId}:${p.promptIndex}`;
            const isOpen = expanded === key;
            const preview = p.promptText.split('\n')[0].slice(0, 180);
            return (
              <div key={key} className="card !p-0 overflow-hidden">
                <button
                  onClick={() => onExpand(isOpen ? null : key)}
                  className="w-full text-left px-4 py-3 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <ChevronRight className={`w-4 h-4 text-gray-600 mt-0.5 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-xs mb-1">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                          style={{ backgroundColor: `${agentColor(p.agentName)}22`, color: agentColor(p.agentName) }}>
                          {p.agentName}
                        </span>
                        <span className="text-gray-300">{p.userName}</span>
                        {p.repoName && <span className="text-gray-600">· {p.repoName}</span>}
                        <span className="text-gray-600 ml-auto">{relTime(p.createdAt)}</span>
                      </div>
                      <p className="text-sm text-gray-300 line-clamp-2">
                        {preview}{p.promptText.length > 180 ? '…' : ''}
                      </p>
                    </div>
                  </div>
                </button>
                {isOpen && (
                  <div className="border-t border-gray-800/80 px-4 py-3 bg-gray-900/40">
                    <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed max-h-80 overflow-auto">
                      {p.promptText}
                    </pre>
                    {p.filesChanged.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-gray-800/60">
                        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">
                          Files touched ({p.filesChanged.length})
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {p.filesChanged.slice(0, 12).map((f) => (
                            <span key={f} className="text-[11px] font-mono text-gray-400 bg-gray-800/60 rounded px-1.5 py-0.5">
                              {f.split('/').slice(-2).join('/')}
                            </span>
                          ))}
                          {p.filesChanged.length > 12 && (
                            <span className="text-[11px] text-gray-600">+{p.filesChanged.length - 12} more</span>
                          )}
                        </div>
                      </div>
                    )}
                    <Link
                      to={`/sessions/${p.sessionId}`}
                      className="mt-3 inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      Open session <ArrowRight className="w-3 h-3" />
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Efficiency tab ─────────────────────────────────────────────────────────

function EfficiencyTab({
  loading,
  data,
}: {
  loading: boolean;
  data: TeamEfficiency | null;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card py-6 animate-pulse">
            <div className="h-3 w-20 bg-gray-800 rounded mb-3" />
            <div className="h-7 w-16 bg-gray-800 rounded" />
          </div>
        ))}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card py-12 text-center text-sm text-gray-600">
        No efficiency data yet. Once sessions roll in, fleet-wide ratios appear here.
      </div>
    );
  }

  const checks = [
    { label: 'Tokens per line', value: data.tokensPerLine, suffix: '', good: data.tokensPerLine < 200, why: '< 200 is healthy' },
    { label: 'Cost per session', value: data.costPerSession, suffix: '', good: data.costPerSession < 0.5, why: '< $0.50 is healthy', currency: true },
    { label: 'Commits per session', value: data.commitsPerSession, suffix: '', good: data.commitsPerSession >= 1, why: '≥ 1 commit shows real output' },
    { label: 'Files per commit', value: data.avgFilesPerCommit, suffix: '', good: data.avgFilesPerCommit < 8, why: '< 8 keeps PRs reviewable' },
  ];

  // Per-engineer outliers: highlight engineers with tokens/line > 2x team average
  const teamTPL = data.tokensPerLine || 0;
  const outliers = data.byEngineer.filter((e) => teamTPL > 0 && e.tokensPerLine > teamTPL * 2);

  return (
    <div className="space-y-4">
      {/* Headline ratios */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <RatioCard label="Tokens / line" value={data.tokensPerLine > 0 ? data.tokensPerLine.toFixed(0) : '—'} sub="token efficiency" />
        <RatioCard label="Cost / session" value={`$${data.costPerSession.toFixed(2)}`} sub="avg spend" />
        <RatioCard label="Cost / commit" value={`$${data.costPerCommit.toFixed(2)}`} sub="per code commit" />
        <RatioCard label="Lines / session" value={fmt(data.avgLinesPerSession)} sub="avg output" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Health checks */}
        <div className="card">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Fleet health</p>
          <div className="space-y-2.5">
            {checks.map((c, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <div className="flex flex-col">
                  <span className="text-gray-300">{c.label}</span>
                  <span className="text-[10px] text-gray-600">{c.why}</span>
                </div>
                <span className={`text-sm font-semibold tabular-nums ${c.good ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {c.currency ? `$${c.value.toFixed(2)}` : c.value.toFixed(c.value < 10 ? 1 : 0)}
                  {c.good ? ' ✓' : ' !'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Per-engineer drill — fleet, not surveillance: just outliers + anyone with notable spend */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Per engineer</p>
            <span className="text-[10px] text-gray-600">
              {outliers.length > 0 ? `${outliers.length} outlier${outliers.length !== 1 ? 's' : ''} flagged` : 'all in band'}
            </span>
          </div>
          {data.byEngineer.length === 0 ? (
            <p className="text-xs text-gray-600">No engineer data yet.</p>
          ) : (
            <div className="space-y-2">
              {data.byEngineer.slice(0, 8).map((e) => {
                const isOutlier = teamTPL > 0 && e.tokensPerLine > teamTPL * 2;
                return (
                  <div key={e.userId} className="flex items-center gap-3 text-sm">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
                      {e.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-gray-300 flex-1 truncate">{e.name}</span>
                    <span className="text-xs text-gray-500 tabular-nums w-14 text-right">{e.sessions} sess</span>
                    <span className={`text-xs tabular-nums w-20 text-right ${isOutlier ? 'text-amber-400' : 'text-gray-500'}`}
                      title={isOutlier ? 'Above 2× team average' : undefined}>
                      {e.tokensPerLine > 0 ? `${e.tokensPerLine.toFixed(0)} t/l` : '—'}
                    </span>
                    <span className="text-xs text-gray-400 tabular-nums w-16 text-right">${e.cost.toFixed(2)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-gray-600 mt-3 leading-relaxed">
            Per-engineer ratios are for cost-optimization signal, not performance review.
            Outliers are flagged when tokens/line is more than 2× the team average — usually a sign the agent is over-thinking, not the engineer.
          </p>
        </div>
      </div>
    </div>
  );
}

function RatioCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card py-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gray-100 tabular-nums">{value}</div>
      <div className="text-[11px] text-gray-600 mt-0.5">{sub}</div>
    </div>
  );
}

function relTime(date: string): string {
  const ms = Date.now() - new Date(date).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(date).toLocaleDateString();
}

function formatShortDuration(ms: number): string {
  if (!ms) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
