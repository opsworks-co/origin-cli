import React, { useEffect, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import * as api from '../api';
import type { Stats, ModelStats, ModelTrend } from '../api';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { PageHeader } from '../components/ui';

const CHART_THEME = {
  grid: '#1f2937',
  text: '#6b7280',
  indigo: '#6366f1',
  purple: '#a855f7',
  cyan: '#06b6d4',
  amber: '#f59e0b',
  green: '#22c55e',
  red: '#ef4444',
};

const MODEL_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];

const TT_STYLE = {
  backgroundColor: 'rgba(11, 18, 32, 0.96)',
  border: '1px solid #1f2937',
  borderRadius: '0.625rem',
  color: '#f3f4f6',
  fontSize: '0.75rem',
  boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
  padding: '0.5rem 0.75rem',
};
// Subtle vertical-line cursor for area/line charts. The default recharts
// rectangle cursor is heavy on dark backgrounds; a thin dashed indigo line
// reads as "you are here" without obscuring the curve.
const CHART_CURSOR = { stroke: '#6366f1', strokeWidth: 1, strokeDasharray: '4 3', strokeOpacity: 0.5 };

// Format YYYY-MM-DD → MMM DD so axis ticks stay one line on narrow charts.
// Falls through unchanged when the input is already short (e.g. "Mon",
// week labels, or projection markers).
function shortDate(s: string | number): string {
  if (typeof s !== 'string') return String(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}`;
}

// Color tied to each model name. Mirrors the `agentColor` palette on the
// Dashboard so a "claude-opus-4-7" bar in Insights matches the indigo/
// purple of Claude everywhere else.
function modelColor(name: string): string {
  const lower = (name || '').toLowerCase();
  if (lower.includes('claude') || lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku')) return '#a78bfa';
  if (lower.includes('cursor') || lower.includes('composer')) return '#38bdf8';
  if (lower.includes('codex') || lower.includes('gpt') || lower.includes('o3') || lower.includes('o1')) return '#34d399';
  if (lower.includes('gemini')) return '#fbbf24';
  if (lower.includes('copilot')) return '#f472b6';
  if (lower.includes('aider')) return '#fb7185';
  return '#8b5cf6';
}

// ── Layout primitives ────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-4 mt-2">
      <div>
        <h2 className="text-sm font-semibold text-gray-200 tracking-tight">{title}</h2>
        {subtitle && <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  hint,
  children,
  tall,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  tall?: boolean;
}) {
  return (
    <div className="rounded-xl border border-gray-800/80 bg-gradient-to-b from-gray-900/60 to-gray-950/40 backdrop-blur-sm overflow-hidden hover:border-gray-700/80 transition-colors">
      <div className="px-5 py-3 flex items-baseline justify-between border-b border-gray-800/60">
        <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.08em]">
          {title}
        </h3>
        {hint && <span className="text-[10px] text-gray-600">{hint}</span>}
      </div>
      <div className={`p-4 ${tall ? 'h-80' : 'h-64'}`}>{children}</div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: 'indigo' | 'purple' | 'cyan' | 'amber' | 'green';
  icon?: React.ReactNode;
}) {
  const accentMap: Record<string, string> = {
    indigo: 'from-indigo-500/20 to-indigo-500/0 text-indigo-300',
    purple: 'from-purple-500/20 to-purple-500/0 text-purple-300',
    cyan: 'from-cyan-500/20 to-cyan-500/0 text-cyan-300',
    amber: 'from-amber-500/20 to-amber-500/0 text-amber-300',
    green: 'from-emerald-500/20 to-emerald-500/0 text-emerald-300',
  };
  const a = accentMap[accent || 'indigo'];
  return (
    <div className="relative rounded-xl border border-gray-800/80 bg-gray-900/40 p-4 overflow-hidden hover:border-gray-700 transition-colors">
      <div className={`absolute inset-0 bg-gradient-to-br ${a.split(' ').slice(0, 2).join(' ')} opacity-60 pointer-events-none`} />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">{label}</span>
          {icon && <span className={a.split(' ').slice(-1)[0]}>{icon}</span>}
        </div>
        <div className="text-2xl font-semibold text-gray-50 tabular-nums">{value}</div>
        {sub && <div className="text-[11px] text-gray-500 mt-1">{sub}</div>}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-2">
      {/* Faint mock-chart so the empty card still feels like a chart, not
          a blank box. SVG, no animation, no DOM cost. */}
      <svg className="w-20 h-12 opacity-25" viewBox="0 0 80 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="emptyGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M0 28 L10 22 L20 24 L30 16 L40 18 L50 10 L60 14 L70 6 L80 8 L80 32 L0 32 Z" fill="url(#emptyGrad)" />
        <path d="M0 28 L10 22 L20 24 L30 16 L40 18 L50 10 L60 14 L70 6 L80 8" stroke="#6366f1" strokeWidth="1" strokeOpacity="0.6" fill="none" strokeLinejoin="round" />
      </svg>
      <span className="text-xs">{message}</span>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const formatDuration = (ms: number) => {
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
};

const formatCompact = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
};

const shortModel = (m: string) =>
  m
    .replace('claude-', '')
    .replace('-20250514', '')
    .replace('-20251001', '')
    .replace('gpt-', 'gpt-');

// Trim trailing days where every numeric field is zero — the API zero-fills
// the range up to `to`, which often includes a partial/empty "today" that
// makes charts show a misleading cliff down to 0.
function trimTrailingZeros<T extends Record<string, any>>(series: T[] | undefined): T[] {
  if (!series || series.length === 0) return series || [];
  const isZero = (row: T) =>
    Object.entries(row).every(([k, v]) => k === 'date' || k === 'week' || k === 'hour' || k === 'bucket' || !v);
  let end = series.length;
  while (end > 1 && isZero(series[end - 1])) end--;
  return series.slice(0, end);
}

// ── Main component ──────────────────────────────────────────────────────────

export default function Insights() {
  const { user, activeOrg } = useAuth();
  const isDev = user?.accountType === 'developer';
  const isAdmin = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN';

  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Model comparison
  const [models, setModels] = useState<ModelStats[]>([]);
  const [trend, setTrend] = useState<ModelTrend[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  // Date range filter
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const [fromDate, setFromDate] = useState(thirtyDaysAgo);
  const [toDate, setToDate] = useState(today);
  const [activePreset, setActivePreset] = useState('30d');

  const fetchStats = (from: string, to: string) => {
    setLoading(true);
    api
      .getStats(from, to)
      .then(setStats)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchStats(fromDate, toDate);
    api
      .getModelComparison()
      .then((r) => {
        setModels(r.models);
        setTrend(r.trend);
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => setLoadingModels(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPreset = (days: number, label: string) => {
    const to = new Date();
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = to.toISOString().split('T')[0];
    setFromDate(fromStr);
    setToDate(toStr);
    setActivePreset(label);
    fetchStats(fromStr, toStr);
  };

  const applyCustomRange = () => {
    setActivePreset('');
    fetchStats(fromDate, toDate);
  };

  const trendData = useMemo(() => {
    if (!trend.length) return [];
    const modelNames = [...new Set(models.map((m) => m.model))];
    return trend.map((t) => ({
      week: t.week,
      ...Object.fromEntries(modelNames.map((m) => [m, t.models[m] || 0])),
    }));
  }, [trend, models]);

  // Pre-trim all daily series so charts don't cliff down to zero on a partial
  // trailing day (API zero-fills the range through `to`).
  // Then accumulate to running totals — these charts read as "where are we
  // in the period overall" rather than "what happened on day X", which is
  // why dips in the middle of a window felt wrong.
  const aiAuthorshipOverTime = useMemo(() => {
    const trimmed = trimTrailingZeros(stats?.aiAuthorshipOverTime) as Array<{ date: string; percent: number }>;
    let sum = 0;
    return trimmed.map((d, i) => {
      sum += d.percent;
      return { date: d.date, percent: Math.round(sum / (i + 1)) };
    });
  }, [stats?.aiAuthorshipOverTime]);
  const linesByDay = useMemo(() => {
    const trimmed = trimTrailingZeros(stats?.linesByDay) as Array<{ date: string; added: number; removed: number }>;
    let added = 0;
    let removed = 0;
    return trimmed.map((d) => {
      added += d.added || 0;
      removed += d.removed || 0;
      return { date: d.date, added, removed };
    });
  }, [stats?.linesByDay]);
  const costByDay = useMemo(() => {
    const trimmed = trimTrailingZeros(stats?.costByDay) as Array<{ date: string; cost: number }>;
    let cost = 0;
    return trimmed.map((d) => {
      cost += d.cost || 0;
      return { date: d.date, cost: parseFloat(cost.toFixed(2)) };
    });
  }, [stats?.costByDay]);

  const modelNames = useMemo(() => models.map((m) => m.model), [models]);

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="card text-center py-12">
        <p className="text-red-400 mb-2">Failed to load insights</p>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Insights"
        subtitle={isDev
          ? 'Your personal AI coding analytics'
          : 'Analytics across your AI coding operations'}
        meta={isAdmin ? (
          <Link
            to="/insights/spend-quality"
            className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/20 transition-colors"
          >
            <span className="font-medium">Open Spend Quality dashboard →</span>
            <span className="text-[10px] uppercase tracking-wider text-indigo-300/70">manager view</span>
          </Link>
        ) : undefined}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex gap-1 p-1 rounded-lg bg-gray-900/60 border border-gray-800">
              {[
                { label: '1d', days: 1 },
                { label: '7d', days: 7 },
                { label: '30d', days: 30 },
                { label: '90d', days: 90 },
              ].map(({ label, days }) => (
                <button
                  key={label}
                  onClick={() => applyPreset(days, label)}
                  className={`px-3 py-1 text-xs rounded-md transition-colors ${
                    activePreset === label
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="input text-xs py-1"
              />
              <span className="text-gray-600 text-xs">→</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="input text-xs py-1"
              />
              <button onClick={applyCustomRange} className="btn-secondary text-xs py-1">
                Apply
              </button>
            </div>
          </div>
        }
      />

      {loading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-indigo-500" />
          Updating...
        </div>
      )}

      {/* ── Overview stat cards ───────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Sessions"
          value={formatCompact(stats.totalSessions)}
          sub={`${stats.sessionsThisWeek} this week`}
          accent="indigo"
        />
        <StatCard
          label="AI authorship"
          value={`${stats.aiPercentage}%`}
          sub={`${formatCompact(stats.linesAdded)} lines added`}
          accent="purple"
        />
        <StatCard
          label="Spend"
          value={`$${stats.costUsd.toFixed(2)}`}
          sub={`${formatCompact(stats.tokensUsed)} tokens`}
          accent="cyan"
        />
        <StatCard
          label="Est. month"
          value={`$${stats.estimatedCostThisMonth.toFixed(2)}`}
          sub={`${formatCompact(stats.linesWrittenThisMonth)} lines`}
          accent="amber"
        />
      </div>

      {/* ── Activity & authorship ─────────────────────────────────────── */}
      <section>
        <SectionHeader title="Activity & authorship" subtitle="How AI usage changes over time" />
        <div className="grid lg:grid-cols-2 gap-5">
          <ChartCard title="AI Authorship %" hint="Running average % AI-authored">
            {aiAuthorshipOverTime.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={aiAuthorshipOverTime} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradAi" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_THEME.indigo} stopOpacity={0.55} />
                      <stop offset="100%" stopColor={CHART_THEME.indigo} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={shortDate} minTickGap={24} />
                  <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} unit="%" width={36} domain={[0, 100]} />
                  <Tooltip contentStyle={TT_STYLE} cursor={CHART_CURSOR} formatter={(v: number) => [`${v}%`, 'AI Authored']} labelFormatter={shortDate} />
                  <Area type="monotone" dataKey="percent" stroke={CHART_THEME.indigo} strokeWidth={2.5} fill="url(#gradAi)" activeDot={{ r: 4, strokeWidth: 0 }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message="No authorship data yet" />
            )}
          </ChartCard>

          <ChartCard title="Lines changed" hint="Added vs removed per day">
            {linesByDay.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={linesByDay} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradAdded" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_THEME.green} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={CHART_THEME.green} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradRemoved" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_THEME.red} stopOpacity={0.45} />
                      <stop offset="100%" stopColor={CHART_THEME.red} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={shortDate} minTickGap={24} />
                  <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} width={36} />
                  <Tooltip contentStyle={TT_STYLE} cursor={CHART_CURSOR} labelFormatter={shortDate} />
                  <Legend wrapperStyle={{ fontSize: '0.7rem', paddingTop: 4 }} iconType="circle" iconSize={8} />
                  <Area type="monotone" dataKey="added" stroke={CHART_THEME.green} strokeWidth={2} fill="url(#gradAdded)" name="Added" activeDot={{ r: 4, strokeWidth: 0 }} />
                  <Area type="monotone" dataKey="removed" stroke={CHART_THEME.red} strokeWidth={2} fill="url(#gradRemoved)" name="Removed" activeDot={{ r: 4, strokeWidth: 0 }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message="No line-change data yet" />
            )}
          </ChartCard>

        </div>
      </section>

      {/* ── Cost & tokens ─────────────────────────────────────────────── */}
      <section>
        <SectionHeader title="Cost & tokens" subtitle="Where your AI budget is going" />
        <div className="grid lg:grid-cols-2 gap-5">
          <ChartCard title="Cost over time" hint="Daily spend">
            {costByDay.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={costByDay} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_THEME.cyan} stopOpacity={0.55} />
                      <stop offset="100%" stopColor={CHART_THEME.cyan} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={shortDate} minTickGap={24} />
                  <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} width={42} />
                  <Tooltip contentStyle={TT_STYLE} cursor={CHART_CURSOR} formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cost']} labelFormatter={shortDate} />
                  <Area type="monotone" dataKey="cost" stroke={CHART_THEME.cyan} strokeWidth={2.5} fill="url(#gradCost)" activeDot={{ r: 4, strokeWidth: 0 }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message="No spend recorded yet" />
            )}
          </ChartCard>

          <ChartCard title="Cost by model" hint="Top model spenders">
            {stats.costByModel && stats.costByModel.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={[...stats.costByModel].sort((a, b) => b.cost - a.cost)} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                  <XAxis type="number" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                  <YAxis type="category" dataKey="model" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} width={140} />
                  <Tooltip contentStyle={TT_STYLE} cursor={{ fill: 'rgba(99,102,241,0.06)' }} formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cost']} />
                  <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                    {stats.costByModel.map((m) => (
                      <Cell key={m.model} fill={modelColor(m.model)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message="No model spend yet" />
            )}
          </ChartCard>

          <ChartCard title="Cost by repository" hint="Top repos by spend">
            {stats.costByRepo && stats.costByRepo.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={[...stats.costByRepo].sort((a, b) => b.cost - a.cost)} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                  <XAxis type="number" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                  <YAxis type="category" dataKey="repo" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} width={140} />
                  <Tooltip contentStyle={TT_STYLE} cursor={{ fill: 'rgba(99,102,241,0.06)' }} formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cost']} />
                  <Bar dataKey="cost" fill={CHART_THEME.indigo} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message="No repo spend yet" />
            )}
          </ChartCard>
        </div>
      </section>

      {/* ── Model comparison ──────────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Model comparison"
          subtitle="Side-by-side performance across the models you use"
        />

        {loadingModels ? (
          <div className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-10 flex items-center justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
          </div>
        ) : models.length === 0 ? (
          <div className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-10 text-center text-gray-500 text-sm">
            No session data available for model comparison yet.
          </div>
        ) : (
          <div className="space-y-5">
            {/* Per-model summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {models.map((m, i) => {
                const color = MODEL_COLORS[i % MODEL_COLORS.length];
                return (
                  <div
                    key={m.model}
                    className="relative rounded-xl border border-gray-800/80 bg-gray-900/40 p-4 overflow-hidden hover:border-gray-700 transition-colors"
                  >
                    <div
                      className="absolute top-0 left-0 right-0 h-0.5"
                      style={{ background: color }}
                    />
                    <p
                      className="text-xs font-semibold mb-3 truncate"
                      style={{ color }}
                      title={m.model}
                    >
                      {shortModel(m.model)}
                    </p>
                    <div className="space-y-1.5 text-[11px]">
                      <div className="flex justify-between">
                        <span className="text-gray-500">Sessions</span>
                        <span className="text-gray-200 font-medium tabular-nums">{m.sessions}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Total cost</span>
                        <span className="text-gray-200 tabular-nums">${m.totalCost.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Avg cost</span>
                        <span className="text-gray-200 tabular-nums">${m.avgCost.toFixed(4)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Avg duration</span>
                        <span className="text-gray-200 tabular-nums">{formatDuration(m.avgDuration)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Avg lines</span>
                        <span className="text-gray-200 tabular-nums">{Math.round(m.avgLines)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Approval</span>
                        <span
                          className={`tabular-nums ${
                            m.approvalRate >= 80
                              ? 'text-emerald-400'
                              : m.approvalRate >= 50
                                ? 'text-amber-400'
                                : 'text-red-400'
                          }`}
                        >
                          {m.approvalRate.toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Adoption trend */}
            {trendData.length > 0 && (
              <ChartCard title="Adoption trend" hint="Weekly share by model" tall>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} vertical={false} />
                    <XAxis dataKey="week" tick={{ fontSize: 10, fill: CHART_THEME.text }} axisLine={false} tickLine={false} tickFormatter={shortDate} minTickGap={32} />
                    <YAxis tick={{ fontSize: 10, fill: CHART_THEME.text }} axisLine={false} tickLine={false} width={36} />
                    <Tooltip contentStyle={TT_STYLE} cursor={CHART_CURSOR} labelFormatter={shortDate} />
                    <Legend wrapperStyle={{ fontSize: '0.7rem', paddingTop: 4 }} iconType="circle" iconSize={8} />
                    {modelNames.map((name) => (
                      <Area
                        key={name}
                        type="monotone"
                        dataKey={name}
                        stackId="1"
                        stroke={modelColor(name)}
                        fill={modelColor(name)}
                        fillOpacity={0.4}
                        strokeWidth={1.5}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            )}
          </div>
        )}
      </section>

      {/* ── Repositories ──────────────────────────────────────────────── */}
      <section>
        <SectionHeader title="Repositories" subtitle="Where work is happening" />
        <div className="grid lg:grid-cols-2 gap-5">
          <ChartCard title="Sessions by repository" hint="Where AI is most active">
            {stats.sessionsByRepo && stats.sessionsByRepo.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={[...stats.sessionsByRepo].sort((a, b) => b.count - a.count)} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} vertical={false} />
                  <XAxis dataKey="repo" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} interval={0} angle={-12} textAnchor="end" height={50} />
                  <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} width={36} />
                  <Tooltip contentStyle={TT_STYLE} cursor={{ fill: 'rgba(99,102,241,0.06)' }} formatter={(v: number) => [v, 'Sessions']} />
                  <Bar dataKey="count" fill={CHART_THEME.cyan} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message="No repository activity yet" />
            )}
          </ChartCard>

          {!isDev && (
            <ChartCard title="Top engineers" hint="By AI session count">
              {stats.topEngineers && stats.topEngineers.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={[...stats.topEngineers].sort((a, b) => b.sessions - a.sessions)} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                    <XAxis type="number" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} width={120} />
                    <Tooltip contentStyle={TT_STYLE} cursor={{ fill: 'rgba(99,102,241,0.06)' }} formatter={(v: number) => [v, 'Sessions']} />
                    <Bar dataKey="sessions" fill={CHART_THEME.amber} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState message="No engineer activity yet" />
              )}
            </ChartCard>
          )}
        </div>
      </section>

      {/* ── Governance (team only) ────────────────────────────────────── */}
      {!isDev && (
        <section>
          <SectionHeader title="Governance" subtitle="Quality, secrets, and policy enforcement" />
          <div className="grid lg:grid-cols-2 gap-5">
            <ChartCard title="Session quality" hint="Review status mix">
              {stats.qualityMetrics ? (() => {
                const data = [
                  { name: 'Approved', value: stats.qualityMetrics.approved, color: CHART_THEME.green },
                  { name: 'Rejected', value: stats.qualityMetrics.rejected, color: CHART_THEME.red },
                  { name: 'Flagged',  value: stats.qualityMetrics.flagged,  color: CHART_THEME.amber },
                  { name: 'Pending',  value: stats.qualityMetrics.pending,  color: '#6b7280' },
                ];
                const total = data.reduce((s, d) => s + d.value, 0);
                if (total === 0) return <EmptyState message="No reviewed sessions yet" />;
                return (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={data}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={90}
                        paddingAngle={3}
                        dataKey="value"
                        // Donut center "total" via secondary <text> drawn
                        // by recharts' label callback. Cheap and stays
                        // dynamic without extra render plumbing.
                        labelLine={false}
                        label={({ percent, name }) =>
                          percent && percent >= 0.06 ? `${name} ${(percent * 100).toFixed(0)}%` : ''
                        }
                      >
                        {data.map((d) => <Cell key={d.name} fill={d.color} stroke="rgba(11,18,32,0.6)" strokeWidth={2} />)}
                      </Pie>
                      <Tooltip contentStyle={TT_STYLE} formatter={(v: number, _n, p: any) => [`${v} (${total > 0 ? ((v / total) * 100).toFixed(0) : 0}%)`, p.payload.name]} />
                      <Legend wrapperStyle={{ fontSize: '0.7rem', paddingTop: 4 }} iconType="circle" iconSize={8} />
                    </PieChart>
                  </ResponsiveContainer>
                );
              })() : (
                <EmptyState message="No reviewed sessions yet" />
              )}
            </ChartCard>

            <ChartCard title="Cost by user">
              {stats.costByUser && stats.costByUser.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.costByUser} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                    <XAxis type="number" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                    <YAxis type="category" dataKey="name" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} width={140} />
                    <Tooltip contentStyle={TT_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cost']} />
                    <Bar dataKey="cost" fill={CHART_THEME.indigo} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState message="No data yet" />
              )}
            </ChartCard>

            <ChartCard title="Secrets detected" hint="By type">
              {stats.secretsByType && stats.secretsByType.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.secretsByType}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                    <XAxis dataKey="type" tick={{ fill: CHART_THEME.text, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => v.replace(/_/g, ' ')} />
                    <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TT_STYLE} />
                    <Bar dataKey="count" fill={CHART_THEME.red} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState message="No secrets detected" />
              )}
            </ChartCard>

            <ChartCard title="Policy violations" hint="By type">
              {stats.violationsByType && stats.violationsByType.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.violationsByType}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                    <XAxis dataKey="type" tick={{ fill: CHART_THEME.text, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => v.replace(/_/g, ' ')} />
                    <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TT_STYLE} />
                    <Bar dataKey="count" fill={CHART_THEME.red} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState message="No violations recorded" />
              )}
            </ChartCard>
          </div>
        </section>
      )}
    </div>
  );
}
