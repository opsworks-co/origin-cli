import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { BudgetData, ForecastData } from '../api';
import { AlertTriangle, TrendingUp, TrendingDown, Minus, DollarSign, Users, Cpu, GitPullRequest, Shield, Calculator, Mail, FolderOpen, Wrench } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import RecomputeCostsCard from '../components/RecomputeCostsCard';
import { PageHeader } from '../components/ui';

// Gradient stat card — same shape as the Dashboard StatCard so all the
// admin pages share visual language. Inlined here (not extracted to a
// shared component) because Dashboard's version is tightly coupled to
// `expandedKpi` state we don't have on this page.
function BudgetStat({
  accent, label, Icon, value, sub, onClick, active = false,
}: {
  accent: 'indigo' | 'purple' | 'cyan' | 'amber' | 'green' | 'red' | 'gray';
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  value: React.ReactNode;
  sub: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  const accentMap: Record<typeof accent, { grad: string; text: string; ring: string }> = {
    indigo: { grad: 'from-indigo-500/20 to-indigo-500/0', text: 'text-indigo-300',  ring: 'ring-indigo-400/60' },
    purple: { grad: 'from-purple-500/20 to-purple-500/0', text: 'text-purple-300',  ring: 'ring-purple-400/60' },
    cyan:   { grad: 'from-cyan-500/20 to-cyan-500/0',     text: 'text-cyan-300',    ring: 'ring-cyan-400/60'   },
    amber:  { grad: 'from-amber-500/20 to-amber-500/0',   text: 'text-amber-300',   ring: 'ring-amber-400/60'  },
    green:  { grad: 'from-emerald-500/20 to-emerald-500/0', text: 'text-emerald-300', ring: 'ring-emerald-400/60' },
    red:    { grad: 'from-red-500/20 to-red-500/0',       text: 'text-red-300',     ring: 'ring-red-400/60'    },
    gray:   { grad: 'from-gray-500/20 to-gray-500/0',     text: 'text-gray-400',    ring: 'ring-gray-400/60'   },
  };
  const a = accentMap[accent];
  const Wrapper = onClick ? 'button' : 'div';
  const wrapperProps = onClick
    ? { type: 'button' as const, onClick, 'aria-pressed': active, title: 'Click for breakdown' }
    : {};
  return (
    <Wrapper
      {...wrapperProps}
      className={`relative rounded-xl border bg-gray-900/40 p-4 overflow-hidden text-left w-full ${
        active
          ? `border-transparent ring-2 ${a.ring} bg-gray-900/70`
          : `border-gray-800/80 ${onClick ? 'hover:border-gray-700 hover:bg-gray-900/60 cursor-pointer transition-colors' : ''}`
      }`}
    >
      <div className={`absolute inset-0 bg-gradient-to-br ${a.grad} opacity-60 pointer-events-none`} />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Icon className={`w-3 h-3 ${a.text}`} />
            {label}
          </span>
          {onClick && (
            <span className={`text-[9px] uppercase tracking-wider ${active ? a.text : 'text-gray-600'}`}>
              {active ? 'shown ↓' : 'details →'}
            </span>
          )}
        </div>
        <div className="text-2xl font-semibold text-gray-50 tabular-nums">{value}</div>
        <div className="text-[11px] text-gray-500 mt-1 truncate">{sub}</div>
      </div>
    </Wrapper>
  );
}

// ── KPI detail panel ────────────────────────────────────────────────────────
// One dropdown panel that renders below the 3-card KPI strip when any card
// is clicked. Three keys, three panels:
//   • spend → period strip (today/week/month) + 3-tab breakdown
//   • forecast → projected month-end with per-model ranking
//   • activity → engineers list + models list under a 2-tab switcher
type KpiPanelKey = 'spend' | 'forecast' | 'activity';
const KPI_TITLES: Record<KpiPanelKey, string> = {
  spend: 'Spend — who and what',
  forecast: 'Month-end forecast',
  activity: 'Activity — engineers and models',
};

const KpiDetailPanel = React.forwardRef<HTMLDivElement, {
  kpi: KpiPanelKey;
  onClose: () => void;
  spend: BudgetSpendShape;
  forecast: ForecastData | null;
  agentBudgets: Array<{ agentId: string; agentName: string; slug: string; currentSpend: number; sessions: number }>;
}>(function KpiDetailPanel({ kpi, onClose, spend, forecast, agentBudgets }, ref) {
  // Spend panel — 3-tab inner switcher (engineers / agents / models).
  const [spendTab, setSpendTab] = useState<'engineers' | 'agents' | 'models'>('engineers');
  // Activity panel — 2-tab inner switcher (engineers / models).
  const [actTab, setActTab] = useState<'engineers' | 'models'>('engineers');

  const byPeriod = spend.byPeriod ?? { daily: 0, weekly: 0, monthly: 0 };

  return (
    <div ref={ref} className="rounded-xl border border-indigo-500/30 bg-gray-900/60 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-100">{KPI_TITLES[kpi]}</h3>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1" aria-label="Close panel">
          Close ✕
        </button>
      </div>

      {/* Spend — period strip on top, then 3-tab breakdown */}
      {kpi === 'spend' && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {([
              ['Today',    byPeriod.daily,   'since 00:00'],
              ['This week', byPeriod.weekly,  'since Monday'],
              ['This month', byPeriod.monthly, 'lifetime since 1st'],
            ] as Array<[string, number, string]>).map(([label, value, sub]) => (
              <div key={label} className="rounded-lg bg-gray-800/40 px-3 py-2">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</div>
                <div className="text-lg font-semibold text-gray-100 tabular-nums">${value.toFixed(2)}</div>
                <div className="text-[10px] text-gray-600">{sub}</div>
              </div>
            ))}
          </div>
          <div className="border-b border-gray-800 flex items-center gap-1" role="tablist">
            {([
              ['engineers', 'Engineers', spend.byUser?.length ?? 0],
              ['agents',    'Agents',    agentBudgets.length],
              ['models',    'Models',    spend.byModel?.length ?? 0],
            ] as Array<[typeof spendTab, string, number]>).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={spendTab === key}
                onClick={() => setSpendTab(key)}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  spendTab === key ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                {label} <span className="text-[10px] text-gray-600 ml-1 tabular-nums">({count})</span>
              </button>
            ))}
          </div>
          {spendTab === 'engineers' && (
            <RankedList
              rows={(spend.byUser ?? []).map((u) => ({
                key: u.userId, name: u.name || u.userId, sub: `${u.sessions} session${u.sessions !== 1 ? 's' : ''}`, value: u.cost,
              }))}
              emptyMsg="No engineer activity yet."
              format={(n) => `$${n.toFixed(2)}`}
            />
          )}
          {spendTab === 'agents' && (
            <RankedList
              rows={agentBudgets.map((a) => ({
                key: a.agentId, name: a.agentName, sub: `${a.sessions} session${a.sessions !== 1 ? 's' : ''} · ${a.slug}`, value: a.currentSpend,
              }))}
              emptyMsg="No agent-attributed sessions yet."
              format={(n) => `$${n.toFixed(2)}`}
            />
          )}
          {spendTab === 'models' && (
            <RankedList
              rows={(spend.byModel ?? []).map((m) => ({
                key: m.model, name: m.model, sub: `${m.sessions} session${m.sessions !== 1 ? 's' : ''}`, value: m.cost,
              }))}
              emptyMsg="No model usage yet."
              format={(n) => `$${n.toFixed(2)}`}
              mono
            />
          )}
        </>
      )}

      {/* Forecast — projected month-end with confidence + trend + per-model */}
      {kpi === 'forecast' && (
        <div className="space-y-3">
          {forecast ? (
            <>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">Projected</div>
                  <div className="text-lg font-semibold text-gray-100 tabular-nums">${forecast.projectedMonthly.toFixed(2)}</div>
                </div>
                <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">Trend</div>
                  <div className={`text-lg font-semibold capitalize ${forecast.trend === 'up' ? 'text-red-300' : forecast.trend === 'down' ? 'text-emerald-300' : 'text-gray-300'}`}>{forecast.trend}</div>
                </div>
                <div className="rounded-lg bg-gray-800/40 px-3 py-2">
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider">Confidence</div>
                  <div className="text-lg font-semibold text-gray-100 tabular-nums">{Math.round(forecast.confidence * 100)}%</div>
                </div>
              </div>
              <h4 className="text-xs font-medium text-gray-300 mt-2">Per-model projection</h4>
              <RankedList
                rows={forecast.byModel.map((m) => ({
                  key: m.model,
                  name: m.model,
                  sub: `${m.trend === 'up' ? '↑' : m.trend === 'down' ? '↓' : '→'} from $${m.currentMonthly.toFixed(2)}`,
                  value: m.projectedMonthly,
                }))}
                emptyMsg="No per-model forecast available yet."
                format={(n) => `$${n.toFixed(2)}`}
                mono
              />
            </>
          ) : (
            <p className="text-xs text-gray-500">Forecast data not available yet — needs at least a few days of spend.</p>
          )}
        </div>
      )}

      {/* Activity — engineers + models combined into one panel with a switcher */}
      {kpi === 'activity' && (
        <>
          <div className="border-b border-gray-800 flex items-center gap-1" role="tablist">
            {([
              ['engineers', 'Engineers', spend.byUser?.length ?? 0],
              ['models',    'Models',    spend.byModel?.length ?? 0],
            ] as Array<[typeof actTab, string, number]>).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={actTab === key}
                onClick={() => setActTab(key)}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  actTab === key ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                {label} <span className="text-[10px] text-gray-600 ml-1 tabular-nums">({count})</span>
              </button>
            ))}
          </div>
          {actTab === 'engineers' && (
            <RankedList
              rows={(spend.byUser ?? []).map((u) => ({
                key: u.userId, name: u.name || u.userId, sub: `${u.sessions} session${u.sessions !== 1 ? 's' : ''}`, value: u.cost,
              }))}
              emptyMsg="No engineer activity recorded yet."
              format={(n) => `$${n.toFixed(2)}`}
            />
          )}
          {actTab === 'models' && (
            <RankedList
              rows={(spend.byModel ?? []).map((m) => ({
                key: m.model, name: m.model, sub: `${m.sessions} session${m.sessions !== 1 ? 's' : ''}`, value: m.cost,
              }))}
              emptyMsg="No models recorded yet."
              format={(n) => `$${n.toFixed(2)}`}
              mono
            />
          )}
        </>
      )}
    </div>
  );
});

// Minimal ranked-list renderer used by KpiDetailPanel. Bars are scaled to
// the row max so the largest item is always full-width — emphasises the
// rank ordering rather than absolute scale.
function RankedList({
  rows, emptyMsg, format, mono = false,
}: {
  rows: Array<{ key: string; name: string; sub: string; value: number }>;
  emptyMsg: string;
  format: (n: number) => string;
  mono?: boolean;
}) {
  if (rows.length === 0) {
    return <div className="p-4 text-center text-xs text-gray-500">{emptyMsg}</div>;
  }
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const max = Math.max(...sorted.map((r) => r.value), 0.0001);
  return (
    <ul className="divide-y divide-gray-800/60">
      {sorted.map((r) => (
        <li key={r.key} className="py-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className={`text-gray-200 truncate ${mono ? 'font-mono text-xs' : ''}`}>
              {r.name}
              <span className="ml-2 text-[10px] text-gray-500">{r.sub}</span>
            </span>
            <span className="text-gray-100 tabular-nums text-xs font-medium">{format(r.value)}</span>
          </div>
          <div className="h-1 rounded-full bg-gray-800 overflow-hidden">
            <div className="h-full bg-indigo-500/70" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// Minimal local typing for what KpiDetailPanel actually reads off
// BudgetSpend — keeps the panel decoupled from the broader BudgetData type
// in api.ts. Mirrors the shape exported from there.
interface BudgetSpendShape {
  byPeriod?: { daily: number; weekly: number; monthly: number };
  byModel?: Array<{ model: string; cost: number; sessions: number }>;
  byUser?: Array<{ userId: string; name: string; cost: number; sessions: number }>;
}

// ── Types for new features ──────────────────────────────────────────────────

type Period = 'daily' | 'weekly' | 'monthly';

const PERIOD_LABEL: Record<Period, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};
const PERIOD_SUFFIX: Record<Period, string> = {
  daily: '/d',
  weekly: '/w',
  monthly: '/mo',
};

interface AgentBudget {
  agentId: string;
  agentName: string;
  slug: string;
  monthlyLimit: number;
  period: Period;
  currentSpend: number;
  sessions: number;
}

interface UserBudget {
  userId: string;
  name: string;
  email: string;
  monthlyLimit: number;
  period: Period;
  currentSpend: number;
  sessions: number;
}

interface Anomaly {
  sessionId: string;
  model: string;
  user: string;
  cost: number;
  avgCost: number;
  multiplier: number;
  createdAt: string;
}

interface PRCost {
  prNumber: number;
  title: string;
  repo: string;
  totalCost: number;
  sessions: number;
  branch: string;
}

export default function BudgetPage() {
  const { activeOrg } = useAuth();
  const isAdmin = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN';
  // ── Existing budget state ────────────────────────────────────────────────
  const [budgetData, setBudgetData] = useState<BudgetData | null>(null);
  const [forecastData, setForecastData] = useState<ForecastData | null>(null);
  // Token mix — reuses the Spend Quality endpoint so the org's input/output
  // vs cache-read vs cache-write split is visible right next to spend
  // without leaving the Budget page. Admin-only (endpoint is gated).
  // Three breakdowns: per-engineer (legacy `rows`), per-agent, per-model.
  const [tokenMix, setTokenMix] = useState<api.TokenBreakdownRow[]>([]);
  const [tokenByAgent, setTokenByAgent] = useState<api.TokenBreakdownAgentRow[]>([]);
  const [tokenByModel, setTokenByModel] = useState<api.TokenBreakdownModelRow[]>([]);
  const [tokenCombined, setTokenCombined] = useState<api.TokenBreakdownComboRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Multi-tier caps state — daily / weekly / monthly each with their own
  // amount + soft/hard toggle. Empty string `limit` = no cap for that
  // window. Replaces the old single budgetLimit/budgetPeriod/budgetBlock
  // trio so admins can run e.g. a tight $50 daily ceiling alongside a
  // looser $1k monthly safety net.
  type CapDraft = { limit: string; block: boolean };
  const EMPTY_CAPS: Record<Period, CapDraft> = {
    daily:   { limit: '', block: false },
    weekly:  { limit: '', block: false },
    monthly: { limit: '', block: false },
  };
  const [caps, setCaps] = useState<Record<Period, CapDraft>>(EMPTY_CAPS);
  const setCap = (period: Period, patch: Partial<CapDraft>) =>
    setCaps((prev) => ({ ...prev, [period]: { ...prev[period], ...patch } }));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  // ── New feature state ────────────────────────────────────────────────────
  const [agentBudgets, setAgentBudgets] = useState<AgentBudget[]>([]);
  const [userBudgets, setUserBudgets] = useState<UserBudget[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [prCosts, setPrCosts] = useState<PRCost[]>([]);
  const [editingAgentLimit, setEditingAgentLimit] = useState<string | null>(null);
  const [editingUserLimit, setEditingUserLimit] = useState<string | null>(null);
  const [agentLimitValue, setAgentLimitValue] = useState('');
  const [agentPeriodValue, setAgentPeriodValue] = useState<Period>('monthly');
  const [userLimitValue, setUserLimitValue] = useState('');
  const [userPeriodValue, setUserPeriodValue] = useState<Period>('monthly');
  const [modelPeriodValue, setModelPeriodValue] = useState<Period>('monthly');
  // Per-agent expand: lazy-load model rows + keyed inline-edit (`agentId:model`).
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [agentModels, setAgentModels] = useState<Record<string, api.AgentModel[]>>({});
  const [editingModelKey, setEditingModelKey] = useState<string | null>(null);
  const [modelLimitValue, setModelLimitValue] = useState('');
  // Per-developer expand mirrors per-agent: lazy load + edit by composite key.
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [userModels, setUserModels] = useState<Record<string, api.UserModelLimit[]>>({});
  // Per-repo limits + expand
  const [repoBudgets, setRepoBudgets] = useState<Array<{ repoId: string; repoName: string; currentSpend: number; sessions: number; monthlyLimit: number; period: Period }>>([]);
  const [editingRepoFlatLimit, setEditingRepoFlatLimit] = useState<string | null>(null);
  const [repoFlatLimitValue, setRepoFlatLimitValue] = useState('');
  const [repoFlatPeriodValue, setRepoFlatPeriodValue] = useState<Period>('monthly');
  const [expandedRepoId, setExpandedRepoId] = useState<string | null>(null);
  const [repoModels, setRepoModels] = useState<Record<string, api.RepoModelLimit[]>>({});
  const [editingRepoLimit, setEditingRepoLimit] = useState<string | null>(null);
  const [repoLimitValue, setRepoLimitValue] = useState('');

  // ── ROI Calculator state ────────────────────────────────────────────────
  const [hourlyRate, setHourlyRate] = useState(() => {
    try {
      const saved = localStorage.getItem('origin_hourly_rate');
      return saved ? Number(saved) : 75;
    } catch { return 75; }
  });

  // ── Digest state ────────────────────────────────────────────────────────
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [digestSending, setDigestSending] = useState(false);
  const [digestMsg, setDigestMsg] = useState('');

  // ── Active section tab — Agents | Engineers | Repos under the scope-
  //    overrides block. Tab choice is local-only (no URL param) since the
  //    block sits inside a longer page and tab churn shouldn't change the
  //    URL.
  const [activeSection, setActiveSection] = useState<'agents' | 'developers' | 'repos'>('agents');
  // Track which row is expanded inside the active table. `null` collapses
  // everything. Single-expand keeps the table compact on long lists.
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);

  // ── Top-level page tab — Budget vs Tokens ────────────────────────────────
  // The page got too long — splitting into two top tabs keeps each view in
  // a manageable single scroll. "Budget" owns spend + limits + ROI + the
  // sub-tabs; "Tokens" owns the input/output/cache breakdown.
  const [pageTab, setPageTab] = useState<'budget' | 'tokens'>('budget');
  // Toggles the inline RecomputeCostsCard panel under the page header.
  // Hidden by default — admin diagnostic, not something they need to see
  // every time they open the page.
  const [showRecompute, setShowRecompute] = useState(false);

  // Which top-of-page KPI card is "expanded" — drives the inline detail
  // panel rendered below the two card rows. Null = nothing expanded.
  type KpiKey = KpiPanelKey;
  const [expandedKpi, setExpandedKpi] = useState<KpiKey | null>(null);
  const kpiPanelRef = useRef<HTMLDivElement>(null);
  const toggleKpi = (k: KpiKey) => {
    setExpandedKpi((prev) => (prev === k ? null : k));
    setTimeout(() => {
      const el = kpiPanelRef.current;
      if (!el) return;
      const scroller = el.closest('main') as HTMLElement | null;
      if (!scroller) { el.scrollIntoView({ block: 'nearest' }); return; }
      // Only scroll if the panel is below the fold
      const elTop = el.getBoundingClientRect().top;
      const scrollerBottom = scroller.getBoundingClientRect().bottom;
      if (elTop > scrollerBottom - 200) {
        const target = elTop - scroller.getBoundingClientRect().top + scroller.scrollTop - 80;
        scroller.scrollTop = target;
      }
    }, 50);
  };

  // ── Fetch data ───────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [budget, forecast, agentsRes, usersRes, anomalyRes, prRes, emailSettings, tokenRes] = await Promise.allSettled([
        api.getBudget(),
        api.getForecast(),
        api.request<AgentBudget[]>('/api/budget/agents'),
        api.request<UserBudget[]>('/api/budget/users'),
        api.request<Anomaly[]>('/api/budget/anomalies'),
        api.request<PRCost[]>('/api/budget/pr-costs'),
        api.getEmailSettings(),
        // Token-mix endpoint is admin-only — Promise.allSettled means a 403
        // for non-admins quietly leaves tokenMix empty (the section just
        // doesn't render); doesn't break the page for member viewers.
        api.getTokenBreakdown({ range: '30d' }),
      ]);

      if (budget.status === 'fulfilled') {
        setBudgetData(budget.value);
        // Hydrate the per-period caps from the server. Falls back to the
        // legacy single-cap shape so configs saved before this feature
        // landed still show up in the right row.
        const cfg = budget.value.config;
        const serverCaps = cfg.caps && Object.keys(cfg.caps).length > 0
          ? cfg.caps
          : (cfg.monthlyLimit > 0
              ? { [cfg.period as Period]: { limit: cfg.monthlyLimit, block: cfg.blockOnExceed } }
              : {});
        setCaps({
          daily:   { limit: serverCaps.daily?.limit   ? String(serverCaps.daily.limit)   : '', block: !!serverCaps.daily?.block   },
          weekly:  { limit: serverCaps.weekly?.limit  ? String(serverCaps.weekly.limit)  : '', block: !!serverCaps.weekly?.block  },
          monthly: { limit: serverCaps.monthly?.limit ? String(serverCaps.monthly.limit) : '', block: !!serverCaps.monthly?.block },
        });
      }
      if (forecast.status === 'fulfilled') setForecastData(forecast.value);
      if (agentsRes.status === 'fulfilled') setAgentBudgets(agentsRes.value);
      if (usersRes.status === 'fulfilled') setUserBudgets(usersRes.value);
      if (anomalyRes.status === 'fulfilled') setAnomalies(anomalyRes.value);
      if (prRes.status === 'fulfilled') setPrCosts(prRes.value);
      if (emailSettings.status === 'fulfilled') setDigestEnabled(emailSettings.value.enabled);
      if (tokenRes.status === 'fulfilled') {
        setTokenMix(tokenRes.value.rows);
        setTokenByAgent(tokenRes.value.byAgent || []);
        setTokenByModel(tokenRes.value.byModel || []);
        setTokenCombined(tokenRes.value.combined || []);
      }
    } catch (err) {
      console.error('Budget fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Lazy-load per-model overrides whenever a row is expanded. Cached in
  // the {agent,user,repo}Models maps so re-expanding the same row is
  // instant. Encoded keys: "agent-<id>" / "user-<id>" / "repo-<id>".
  useEffect(() => {
    if (!expandedRowKey) return;
    const dash = expandedRowKey.indexOf('-');
    if (dash <= 0) return;
    const kind = expandedRowKey.slice(0, dash);
    const id = expandedRowKey.slice(dash + 1);
    if (kind === 'agent' && !agentModels[id] && id !== '__other__') {
      api.getAgentModels(id)
        .then((models) => setAgentModels((prev) => ({ ...prev, [id]: models })))
        .catch(() => setAgentModels((prev) => ({ ...prev, [id]: [] })));
    } else if (kind === 'user' && !userModels[id]) {
      api.getUserModels(id)
        .then((models) => setUserModels((prev) => ({ ...prev, [id]: models })))
        .catch(() => setUserModels((prev) => ({ ...prev, [id]: [] })));
    } else if (kind === 'repo' && !repoModels[id]) {
      api.getRepoModels(id)
        .then((models) => setRepoModels((prev) => ({ ...prev, [id]: models })))
        .catch(() => setRepoModels((prev) => ({ ...prev, [id]: [] })));
    }
  }, [expandedRowKey, agentModels, userModels, repoModels]);

  // ── Save org budget ──────────────────────────────────────────────────────
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) {
      setMsg(`Error: Only org admins can change budget settings. You're signed in as ${activeOrg?.role || 'a member'}. Ask an admin or owner.`);
      return;
    }
    setSaving(true);
    setMsg('');
    try {
      // Build the caps payload from current draft state. Empty/zero values
      // are dropped so an unset row stays unset (no accidental $0 cap).
      const capsPayload: Partial<Record<Period, { limit: number; block: boolean }>> = {};
      for (const p of ['daily', 'weekly', 'monthly'] as Period[]) {
        const v = parseFloat(caps[p].limit);
        if (Number.isFinite(v) && v > 0) {
          capsPayload[p] = { limit: v, block: caps[p].block };
        }
      }
      await api.updateBudget({ caps: capsPayload });
      setMsg('Budget settings saved');
      await fetchAll();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // ── Save per-agent limit ─────────────────────────────────────────────────
  const handleSaveAgentLimit = async (agentId: string) => {
    try {
      const limit = parseFloat(agentLimitValue) || 0;
      await api.request(`/api/budget/agents/${agentId}`, {
        method: 'PUT',
        body: JSON.stringify({ monthlyLimit: limit, period: agentPeriodValue }),
      });
      setEditingAgentLimit(null);
      await fetchAll();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  // ── Per-agent expand: lazy-load AgentModel rows for the model breakdown ──
  const toggleAgentExpand = async (agentId: string) => {
    if (expandedAgentId === agentId) { setExpandedAgentId(null); return; }
    setExpandedAgentId(agentId);
    if (!agentModels[agentId]) {
      try {
        const models = await api.getAgentModels(agentId);
        setAgentModels((prev) => ({ ...prev, [agentId]: models }));
      } catch {
        // non-fatal — leave the row expanded with an empty body
        setAgentModels((prev) => ({ ...prev, [agentId]: [] }));
      }
    }
  };

  // ── Save per-model limit (Budget page inline-edit) ───────────────────────
  const handleSaveModelLimit = async (agentId: string, model: string) => {
    try {
      const num = parseFloat(modelLimitValue);
      const value = Number.isFinite(num) && num > 0 ? num : null;
      const updated = await api.updateAgentModel(agentId, model, { monthlyLimit: value, period: modelPeriodValue });
      setAgentModels((prev) => ({
        ...prev,
        [agentId]: (prev[agentId] || []).map((m) => (m.model === model ? updated : m)),
      }));
      setEditingModelKey(null);
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  // ── Per-developer expand (mirrors per-agent) ──────────────────────────
  const toggleUserExpand = async (userId: string) => {
    if (expandedUserId === userId) { setExpandedUserId(null); return; }
    setExpandedUserId(userId);
    if (!userModels[userId]) {
      try {
        const models = await api.getUserModels(userId);
        setUserModels((prev) => ({ ...prev, [userId]: models }));
      } catch {
        setUserModels((prev) => ({ ...prev, [userId]: [] }));
      }
    }
  };
  const handleSaveUserModelLimit = async (userId: string, model: string) => {
    try {
      const num = parseFloat(modelLimitValue);
      const value = Number.isFinite(num) && num > 0 ? num : null;
      const updated = await api.updateUserModel(userId, model, { monthlyLimit: value, period: modelPeriodValue });
      setUserModels((prev) => ({
        ...prev,
        [userId]: (prev[userId] || []).map((m) => (m.model === model ? updated : m)),
      }));
      setEditingModelKey(null);
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  // ── Per-repo: load list + per-model expand ────────────────────────────
  // /api/budget/repos returns spend + flat dollar caps in one shot, same
  // shape as /agents and /users — no need to merge two queries on the
  // client. Per-(repo, model) overrides still load lazily on expand.
  const fetchRepoBudgets = useCallback(async () => {
    try {
      const rows = await api.getRepoBudgets();
      setRepoBudgets(rows.map((r) => ({
        repoId: r.repoId,
        repoName: r.repoName,
        currentSpend: r.currentSpend,
        sessions: r.sessions,
        monthlyLimit: r.monthlyLimit,
        period: r.period,
      })));
    } catch {
      setRepoBudgets([]);
    }
  }, []);

  // Save the flat per-repo cap. Mirrors handleSaveAgentLimit /
  // handleSaveUserLimit — clears the editing state on success.
  const handleSaveRepoFlatLimit = async (repoId: string) => {
    try {
      const limit = parseFloat(repoFlatLimitValue) || 0;
      await api.updateRepoBudget(repoId, { monthlyLimit: limit, period: repoFlatPeriodValue });
      setEditingRepoFlatLimit(null);
      await fetchRepoBudgets();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  // ── Add a per-model override to an Agent / Engineer / Repo ──────────────
  // Used by the inline "+ Add limit" model input in each scope's expand
  // body. Same pattern across all three: take a model name, POST a new
  // override row, update local state so the UI shows it without a refetch.
  const handleAddAgentModel = async (agentId: string, model: string) => {
    try {
      const created = await api.createAgentModel(agentId, { model });
      setAgentModels((prev) => ({
        ...prev,
        [agentId]: [...(prev[agentId] || []), created].sort((a, b) => a.model.localeCompare(b.model)),
      }));
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };
  const handleAddUserModel = async (userId: string, model: string) => {
    try {
      const created = await api.createUserModel(userId, { model });
      setUserModels((prev) => ({
        ...prev,
        [userId]: [...(prev[userId] || []), created].sort((a, b) => a.model.localeCompare(b.model)),
      }));
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };
  // Repos used to fetch only when their tab opened. With the unified
  // single-block layout the section is always rendered, so fetch on
  // mount alongside the other scopes.
  useEffect(() => { fetchRepoBudgets(); }, [fetchRepoBudgets]);

  const toggleRepoExpand = async (repoId: string) => {
    if (expandedRepoId === repoId) { setExpandedRepoId(null); return; }
    setExpandedRepoId(repoId);
    if (!repoModels[repoId]) {
      try {
        const models = await api.getRepoModels(repoId);
        setRepoModels((prev) => ({ ...prev, [repoId]: models }));
      } catch {
        setRepoModels((prev) => ({ ...prev, [repoId]: [] }));
      }
    }
  };
  const handleSaveRepoModelLimit = async (repoId: string, model: string) => {
    try {
      const num = parseFloat(repoLimitValue);
      const value = Number.isFinite(num) && num > 0 ? num : null;
      const updated = await api.updateRepoModel(repoId, model, { monthlyLimit: value, period: modelPeriodValue });
      setRepoModels((prev) => ({
        ...prev,
        [repoId]: (prev[repoId] || []).map((m) => (m.model === model ? updated : m)),
      }));
      setEditingRepoLimit(null);
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };
  const handleAddRepoModel = async (repoId: string, model: string) => {
    try {
      const created = await api.createRepoModel(repoId, { model });
      setRepoModels((prev) => ({
        ...prev,
        [repoId]: [...(prev[repoId] || []), created].sort((a, b) => a.model.localeCompare(b.model)),
      }));
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  // ── Save per-user limit ──────────────────────────────────────────────────
  const handleSaveUserLimit = async (userId: string) => {
    try {
      const limit = parseFloat(userLimitValue) || 0;
      await api.request(`/api/budget/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ monthlyLimit: limit, period: userPeriodValue }),
      });
      setEditingUserLimit(null);
      await fetchAll();
    } catch (err: any) {
      setMsg(`Error: ${err.message}`);
    }
  };

  const pct = (val: number, max: number) => max > 0 ? Math.min((val / max) * 100, 100) : 0;
  const barColor = (p: number) => p >= 100 ? 'bg-red-500' : p >= 80 ? 'bg-amber-500' : 'bg-green-500';

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Budget" subtitle="Loading budget data..." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budget"
        subtitle="Cost controls, spending limits, and forecasting"
        actions={isAdmin && pageTab === 'budget' ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowRecompute((v) => !v)}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                showRecompute
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
                  : 'border-gray-700/80 bg-gray-800/40 text-gray-300 hover:border-gray-600 hover:bg-gray-800/70'
              }`}
              title="Re-derive every session's cost from stored token counts"
            >
              <Wrench className="w-3.5 h-3.5" />
              Recompute costs
            </button>
            <a
              href="#set-limits"
              className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/20 transition-colors"
            >
              <Shield className="w-3.5 h-3.5" />
              Set limits
            </a>
          </div>
        ) : undefined}
      />

      {isAdmin && pageTab === 'budget' && showRecompute && (
        <RecomputeCostsCard />
      )}

      {/* Top-level page tabs — keeps the page short. Budget = spend +
          limits + ROI + per-X sub-tabs. Tokens = generated/cache breakdown. */}
      <div className="border-b border-gray-800/80 flex items-center gap-1 -mb-px">
        {([
          ['budget', 'Budget',  DollarSign],
          ['tokens', 'Tokens',  Cpu],
        ] as [typeof pageTab, string, React.ComponentType<{ className?: string }>][]).map(([key, label, Icon]) => {
          const active = pageTab === key;
          return (
            <button
              key={key}
              onClick={() => setPageTab(key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                active ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          );
        })}
      </div>

      {/* ─── BUDGET TAB BODY — opens here, closes right before the
            RecomputeCostsCard at the bottom. ──────────────────────────── */}
      {pageTab === 'budget' && (<>

      {/* ── Three KPI cards — Spend / Forecast / Activity ───────────────
          Consolidated from the old 6-card layout (Today/Week/Month +
          Projected/Models/Engineers). Each card is a button → opens the
          KpiDetailPanel below with the matching dropdown content.
          • Spend headline = this-month total (the enforcement default);
            cap % shows when a monthly cap is set.
          • Forecast headline = projected month-end + confidence.
          • Activity headline = engineers active + models in use. */}
      {budgetData && (() => {
        const byPeriod = budgetData.currentSpend.byPeriod || { daily: 0, weekly: 0, monthly: budgetData.currentSpend.monthly };
        const monthSpend = byPeriod.monthly;
        const activePeriod: Period = (budgetData.config.period || 'monthly') as Period;
        const monthlyLimit = budgetData.config.monthlyLimit;
        const showCap = activePeriod === 'monthly' && monthlyLimit > 0;
        const pct = showCap ? Math.min((monthSpend / monthlyLimit) * 100, 110) : 0;
        const tier = pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'green';
        const spendTone =
          tier === 'red' ? 'border-red-500/40 bg-red-500/[0.06]' :
          tier === 'amber' ? 'border-amber-500/40 bg-amber-500/[0.05]' :
          'border-gray-800 bg-gray-900/40';
        const engineers = budgetData.currentSpend.byUser.length;
        const models = budgetData.currentSpend.byModel.length;
        const expandedTone = (active: boolean) => active ? ' ring-2 ring-indigo-400/60 bg-gray-900/70' : '';

        return (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Spend */}
            <button
              type="button"
              onClick={() => toggleKpi('spend')}
              aria-pressed={expandedKpi === 'spend'}
              className={`relative rounded-xl border p-4 text-left w-full transition-colors hover:bg-gray-900/60 cursor-pointer ${spendTone}${expandedTone(expandedKpi === 'spend')}`}
              title="Click for spend breakdown"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">This month</span>
                <span className={`text-[9px] uppercase tracking-wider ${expandedKpi === 'spend' ? 'text-indigo-300' : 'text-gray-600'}`}>
                  {expandedKpi === 'spend' ? 'shown ↓' : 'details →'}
                </span>
              </div>
              <div className="text-2xl font-semibold text-gray-50 tabular-nums mt-1">${monthSpend.toFixed(2)}</div>
              {showCap ? (
                <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">{pct.toFixed(0)}% of ${monthlyLimit.toFixed(0)} monthly cap</p>
              ) : (
                <p className="text-[11px] text-gray-600 mt-0.5 tabular-nums">
                  ${byPeriod.daily.toFixed(2)} today · ${byPeriod.weekly.toFixed(2)} this week
                </p>
              )}
            </button>

            {/* Forecast */}
            <BudgetStat
              accent={forecastData?.trend === 'up' ? 'red' : forecastData?.trend === 'down' ? 'green' : 'cyan'}
              label="Projected month-end"
              Icon={forecastData?.trend === 'up' ? TrendingUp : forecastData?.trend === 'down' ? TrendingDown : Minus}
              value={`$${forecastData?.projectedMonthly.toFixed(2) || '0.00'}`}
              sub={`${Math.round((forecastData?.confidence ?? 0) * 100)}% confidence`}
              active={expandedKpi === 'forecast'}
              onClick={() => toggleKpi('forecast')}
            />

            {/* Activity — engineers + models combined */}
            <BudgetStat
              accent="indigo"
              label="Activity"
              Icon={Users}
              value={engineers}
              sub={engineers === 0
                ? 'No activity yet'
                : `${engineers} engineer${engineers !== 1 ? 's' : ''} · ${models} model${models !== 1 ? 's' : ''}`}
              active={expandedKpi === 'activity'}
              onClick={() => toggleKpi('activity')}
            />
          </div>
        );
      })()}

      {/* ── KPI detail panel — inline expansion below the card grid.
          Drives off `expandedKpi`. Each card opens to a default sub-tab
          (Engineers / Agents / Models for spend cards; chart for projected;
          single list for models/engineers cards). One panel handles all
          six cards rather than rendering six separate panels — keeps the
          page short and the UX consistent ("click a card → see one panel
          appear"). */}
      {expandedKpi && budgetData && (
        <KpiDetailPanel
          ref={kpiPanelRef}
          kpi={expandedKpi}
          onClose={() => setExpandedKpi(null)}
          spend={budgetData.currentSpend}
          forecast={forecastData}
          agentBudgets={agentBudgets}
        />
      )}

      {/* ── Budget limits — unified card ────────────────────────────────
          One card with two halves stitched together by a divider:
            - Default caps at top (apply to everything) — Daily/Weekly/Monthly rows
            - Scope overrides at bottom — vertical tab rail (Agents | Engineers
              | Repos) with the selected scope's row list rendered alongside.
          The Models scope was removed: org-wide model caps added confusion
          without paying their way; per-model caps still exist one layer down,
          inside each agent / engineer / repo expansion. */}
      <div id="set-limits" className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-5 space-y-5">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-200">Budget limits</h3>
          </div>
          {!isAdmin && (
            <span className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
              {activeOrg?.role || 'member'} · read-only
            </span>
          )}
        </div>

        {msg && (
          <div className={`text-xs rounded-lg p-2 ${msg.startsWith('Error') ? 'bg-red-900/20 border border-red-800 text-red-400' : 'bg-green-900/20 border border-green-800 text-green-400'}`}>
            {msg}
          </div>
        )}

        {/* Default caps — own form so submit only fires for these three rows.
            Inline-edit buttons in the scope panels below sit OUTSIDE this form
            so their default `type` doesn't accidentally trigger handleSave. */}
        <form onSubmit={handleSave}>
          {(() => {
            const byPeriod = budgetData?.currentSpend.byPeriod || { daily: 0, weekly: 0, monthly: 0 };
            const periodMeta: Array<{ key: Period; label: string; sub: string; spent: number }> = [
              { key: 'daily',   label: 'Daily',   sub: 'resets at midnight', spent: byPeriod.daily   },
              { key: 'weekly',  label: 'Weekly',  sub: 'resets Monday',      spent: byPeriod.weekly  },
              { key: 'monthly', label: 'Monthly', sub: 'resets on 1st',      spent: byPeriod.monthly },
            ];
            const activeCount = (['daily','weekly','monthly'] as Period[])
              .filter(p => parseFloat(caps[p].limit) > 0).length;
            return (
              <div className="space-y-3">
                <div className="flex items-end justify-between">
                  <div>
                    <label className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">Default caps (apply to everything)</label>
                    <p className="text-[11px] text-gray-600 mt-0.5">
                      {activeCount === 0
                        ? 'No caps set — sessions run unrestricted.'
                        : activeCount === 1
                          ? '1 cap active. The most-restrictive window fires first.'
                          : `${activeCount} caps active. Whichever cap is breached first triggers.`}
                    </p>
                  </div>
                  <button
                    type="submit"
                    disabled={saving || !isAdmin}
                    className="btn-primary text-xs px-4 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Saving…' : 'Save all'}
                  </button>
                </div>
                <div className="rounded-xl border border-gray-800 bg-gray-950/40 divide-y divide-gray-800/80">
                  {periodMeta.map(({ key, label, sub, spent }) => {
                    const draft = caps[key];
                    const limit = parseFloat(draft.limit) || 0;
                    const enabled = limit > 0;
                    const pctVal = enabled ? Math.min((spent / limit) * 100, 110) : 0;
                    const tier: 'green' | 'amber' | 'red' = pctVal >= 100 ? 'red' : pctVal >= 80 ? 'amber' : 'green';
                    const barCls = tier === 'red' ? 'bg-red-500/70' : tier === 'amber' ? 'bg-amber-500/70' : 'bg-emerald-500/60';
                    const labelTone = enabled ? 'text-gray-100' : 'text-gray-500';
                    return (
                      <div key={key} className="grid grid-cols-12 gap-3 items-center px-4 py-3">
                        <div className="col-span-2">
                          <div className={`text-sm font-medium ${labelTone}`}>{label}</div>
                          <div className="text-[10px] text-gray-600">{sub}</div>
                        </div>
                        <div className="col-span-5 space-y-1">
                          <div className="flex items-center justify-between text-[11px] tabular-nums">
                            <span className={enabled ? 'text-gray-300' : 'text-gray-600'}>${spent.toFixed(2)} spent</span>
                            {enabled ? (
                              <span className={tier === 'red' ? 'text-red-300' : tier === 'amber' ? 'text-amber-300' : 'text-gray-500'}>
                                {pctVal.toFixed(0)}% of ${limit.toFixed(0)}
                              </span>
                            ) : (
                              <span className="text-gray-600">no cap</span>
                            )}
                          </div>
                          <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
                            <div className={`h-full transition-all ${enabled ? barCls : 'bg-gray-700'}`} style={{ width: `${enabled ? Math.min(pctVal, 100) : 0}%` }} />
                          </div>
                        </div>
                        <div className="col-span-2">
                          <div className={`flex items-center gap-1 rounded-lg border bg-gray-900/60 px-2 ${enabled ? 'border-gray-700 focus-within:border-indigo-500/60' : 'border-gray-800'}`}>
                            <span className="text-xs text-gray-500">$</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={draft.limit}
                              onChange={(e) => setCap(key, { limit: e.target.value })}
                              className="bg-transparent text-sm font-semibold text-gray-100 tabular-nums w-full py-1 focus:outline-none"
                              placeholder="0"
                              disabled={!isAdmin}
                              aria-label={`${label} cap`}
                            />
                          </div>
                        </div>
                        <div className="col-span-3 flex justify-end">
                          <div
                            className={`inline-flex rounded-lg border p-0.5 transition-opacity ${enabled ? 'border-gray-700 bg-gray-800/40' : 'border-gray-800 bg-gray-900/40 opacity-50'}`}
                            role="radiogroup"
                            aria-label={`${label} enforcement`}
                          >
                            <button
                              type="button"
                              role="radio"
                              aria-checked={!draft.block}
                              onClick={() => isAdmin && enabled && setCap(key, { block: false })}
                              disabled={!isAdmin || !enabled}
                              className={`px-2.5 py-0.5 text-[11px] font-medium rounded-md transition-colors ${
                                !draft.block && enabled
                                  ? 'bg-gray-700/80 text-gray-100 shadow-sm'
                                  : 'text-gray-400 hover:text-gray-200'
                              } ${(!isAdmin || !enabled) ? 'cursor-not-allowed' : ''}`}
                              title="Warn only when over budget"
                            >
                              Soft
                            </button>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={draft.block}
                              onClick={() => isAdmin && enabled && setCap(key, { block: true })}
                              disabled={!isAdmin || !enabled}
                              className={`px-2.5 py-0.5 text-[11px] font-medium rounded-md transition-colors ${
                                draft.block && enabled
                                  ? 'bg-red-500/15 text-red-300 ring-1 ring-red-500/40'
                                  : 'text-gray-400 hover:text-gray-200'
                              } ${(!isAdmin || !enabled) ? 'cursor-not-allowed' : ''}`}
                              title="Block new sessions when over budget"
                            >
                              Hard
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </form>

        {/* Divider */}
        <div className="h-px bg-gray-800" />

        {/* Scope overrides — vertical tab rail + active scope's row list.
            Replaces the old horizontal chip strip + separate per-scope cards
            below the limits card. Now everything lives on the same surface
            and switches between scopes without leaving the card. */}
        {(() => {
          // Table-style scope overrides. Tab bar switches between
          // Agents / Engineers / Repos; each tab is a single compact
          // table where rows expand inline to show per-model overrides.
          // No more separate "+ Add limit" button — the expand toggle
          // and the cap-edit badge are the only interactive surfaces in
          // each row, so the row is denser and scannable side-by-side.
          const agentLimitCount = agentBudgets.filter((a) => a.monthlyLimit > 0).length;
          const userLimitCount = userBudgets.filter((u) => u.monthlyLimit > 0).length;
          const repoLimitCount = repoBudgets.filter((r) => r.monthlyLimit > 0).length;

          type SectionKey = 'agents' | 'developers' | 'repos';
          const tabs: Array<{ key: SectionKey; label: string; Icon: typeof Cpu; capped: number; total: number }> = [
            { key: 'agents',     label: 'Agents',    Icon: Cpu,        capped: agentLimitCount, total: agentBudgets.length },
            { key: 'developers', label: 'Engineers', Icon: Users,      capped: userLimitCount,  total: userBudgets.length },
            { key: 'repos',      label: 'Repos',     Icon: FolderOpen, capped: repoLimitCount,  total: repoBudgets.length },
          ];

          // ── Inline cap-badge / cap-editor ──────────────────────────
          // One render path for both the row-level "scope cap" and the
          // per-model cap. Each caller passes its own state slot so the
          // editor is isolated per row even though the visual is shared.
          const renderCapCell = (opts: {
            isEditing: boolean;
            currentLimit: number;
            currentPeriod: Period;
            value: string;
            setValue: (v: string) => void;
            periodValue: Period;
            setPeriodValue: (p: Period) => void;
            beginEdit: () => void;
            cancelEdit: () => void;
            save: () => void;
            placeholderLabel?: string; // text shown when no cap, e.g. "no cap" or "Set cap →"
          }) => {
            if (opts.isEditing) {
              return (
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center gap-1 rounded-md border border-indigo-500/40 bg-gray-950/60 px-2 py-1">
                    <span className="text-[11px] text-gray-500">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={opts.value}
                      onChange={(e) => opts.setValue(e.target.value)}
                      className="bg-transparent text-xs text-gray-100 w-16 focus:outline-none tabular-nums"
                      autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') opts.save(); if (e.key === 'Escape') opts.cancelEdit(); }}
                    />
                    <select
                      value={opts.periodValue}
                      onChange={(e) => opts.setPeriodValue(e.target.value as Period)}
                      className="bg-transparent text-[11px] text-gray-300 focus:outline-none"
                      aria-label="Period"
                    >
                      <option value="daily">/d</option>
                      <option value="weekly">/w</option>
                      <option value="monthly">/mo</option>
                    </select>
                  </div>
                  <button onClick={opts.save} className="text-[11px] px-2 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-medium">Save</button>
                  <button onClick={opts.cancelEdit} className="text-[11px] px-1.5 py-1 rounded-md text-gray-500 hover:text-gray-300">×</button>
                </div>
              );
            }
            const has = opts.currentLimit > 0;
            return (
              <button
                type="button"
                onClick={opts.beginEdit}
                className={`text-[11px] tabular-nums px-2 py-1 rounded-md transition-colors ${
                  has
                    ? 'text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30'
                    : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 border border-gray-800'
                }`}
                title="Click to edit"
              >
                {has
                  ? `$${opts.currentLimit.toFixed(0)}${PERIOD_SUFFIX[opts.currentPeriod]}`
                  : (opts.placeholderLabel || 'no cap')}
              </button>
            );
          };

          // ── Usage cell: bar + dollar amounts (or just dash if no cap) ──
          const renderUsageCell = (currentSpend: number, monthlyLimit: number) => {
            if (monthlyLimit > 0) {
              const p = pct(currentSpend, monthlyLimit);
              return (
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 rounded-full bg-gray-800 overflow-hidden flex-shrink-0">
                    <div className={`h-full rounded-full transition-all ${barColor(p)}`} style={{ width: `${Math.min(p, 100)}%` }} />
                  </div>
                  <span className="text-[11px] text-gray-500 tabular-nums whitespace-nowrap">
                    ${currentSpend.toFixed(2)}<span className="text-gray-700"> / ${monthlyLimit.toFixed(0)}</span>
                  </span>
                </div>
              );
            }
            return (
              <span className="text-[11px] text-gray-500 tabular-nums">
                ${currentSpend.toFixed(2)} <span className="text-gray-700">spent</span>
              </span>
            );
          };

          // ── One scope row + (when expanded) the per-model sub-rows ──
          // Wraps both the parent row and its expanded body so the visual
          // tree mirrors the data: same indent baseline, same column widths.
          const renderScopeRow = (opts: {
            rowKey: string;
            name: string;
            sub: string;
            sessions: number;
            currentSpend: number;
            monthlyLimit: number;
            period: Period;
            expandable: boolean;
            // scope-cap edit hooks
            isEditingFlat: boolean;
            beginEditFlat: () => void;
            cancelEditFlat: () => void;
            saveFlat: () => void;
            flatValue: string;
            setFlatValue: (v: string) => void;
            flatPeriod: Period;
            setFlatPeriod: (p: Period) => void;
            // model section
            models: Array<{ id: string; model: string; monthlyLimit: number | null; period: string | null }>;
            addModel: (m: string) => void;
            // per-model edit (uses ctx-specific state — one editing slot
            // shared across the active table is fine since UI is one-at-a-time)
            modelEditPrefix: string;
            beginEditModel: (m: string, current: number | null, p: Period) => void;
            cancelEditModel: () => void;
            saveModel: (m: string) => void;
            modelValue: string;
            setModelValue: (v: string) => void;
            activeEditKey: string | null;
          }) => {
            const isExpanded = expandedRowKey === opts.rowKey;
            return (
              <div key={opts.rowKey}>
                <div
                  className={`grid grid-cols-[20px_minmax(0,1fr)_220px_auto] items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
                    isExpanded ? 'bg-gray-900/50' : 'hover:bg-gray-900/30'
                  }`}
                  onClick={() => opts.expandable && setExpandedRowKey(isExpanded ? null : opts.rowKey)}
                >
                  <span className={`text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''} ${opts.expandable ? '' : 'opacity-0'}`}>▸</span>
                  <div className="min-w-0">
                    <div className="text-sm text-gray-200 truncate">{opts.name}</div>
                    {opts.sub && (
                      <div className="text-[11px] text-gray-500 truncate">
                        {opts.sub}
                        <span className="text-gray-700"> · {opts.sessions} session{opts.sessions === 1 ? '' : 's'}</span>
                      </div>
                    )}
                    {!opts.sub && (
                      <div className="text-[11px] text-gray-700 truncate">{opts.sessions} session{opts.sessions === 1 ? '' : 's'}</div>
                    )}
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    {renderUsageCell(opts.currentSpend, opts.monthlyLimit)}
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    {renderCapCell({
                      isEditing: opts.isEditingFlat,
                      currentLimit: opts.monthlyLimit,
                      currentPeriod: opts.period,
                      value: opts.flatValue,
                      setValue: opts.setFlatValue,
                      periodValue: opts.flatPeriod,
                      setPeriodValue: opts.setFlatPeriod,
                      beginEdit: opts.beginEditFlat,
                      cancelEdit: opts.cancelEditFlat,
                      save: opts.saveFlat,
                    })}
                  </div>
                </div>

                {isExpanded && opts.expandable && (
                  <div className="bg-gray-950/40 border-t border-gray-800/60 pl-10 pr-3 py-2 space-y-1">
                    {opts.models.length > 0 && opts.models.map((m) => {
                      const editKey = `${opts.modelEditPrefix}${m.model}`;
                      const isEdit = opts.activeEditKey === editKey;
                      return (
                        <div key={m.id} className="grid grid-cols-[minmax(0,1fr)_220px_auto] items-center gap-3 py-1">
                          <span className="font-mono text-[11px] text-gray-300 truncate">{m.model}</span>
                          <span className="text-[11px] text-gray-600 tabular-nums">— per-model cap</span>
                          {renderCapCell({
                            isEditing: isEdit,
                            currentLimit: m.monthlyLimit && m.monthlyLimit > 0 ? m.monthlyLimit : 0,
                            currentPeriod: ((m.period as Period) || 'monthly'),
                            value: opts.modelValue,
                            setValue: opts.setModelValue,
                            periodValue: modelPeriodValue,
                            setPeriodValue: setModelPeriodValue,
                            beginEdit: () => opts.beginEditModel(m.model, m.monthlyLimit ?? null, ((m.period as Period) || 'monthly')),
                            cancelEdit: opts.cancelEditModel,
                            save: () => opts.saveModel(m.model),
                            placeholderLabel: 'Set cap →',
                          })}
                        </div>
                      );
                    })}
                    {/* Always-visible add-model input. Pressing Enter
                        creates the override and clears the field so the
                        admin can keep typing to add another. */}
                    <div className="flex items-center gap-2 mt-1 rounded-md border border-dashed border-gray-800 hover:border-indigo-500/40 focus-within:border-indigo-500/60 px-2.5 py-1.5">
                      <span className="text-indigo-400 text-sm leading-none">+</span>
                      <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">Model</span>
                      <input
                        type="text"
                        placeholder="e.g. claude-opus-4-7"
                        className="bg-transparent flex-1 text-xs font-mono text-gray-100 focus:outline-none placeholder:text-gray-600"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const v = (e.target as HTMLInputElement).value.trim();
                            if (v) {
                              opts.addModel(v);
                              (e.target as HTMLInputElement).value = '';
                            }
                          }
                        }}
                      />
                      <span className="text-[10px] text-gray-600 whitespace-nowrap">↵ to add</span>
                    </div>
                  </div>
                )}
              </div>
            );
          };

          return (
            <div className="space-y-3">
              <div className="flex items-end justify-between">
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">Tighter caps for specific scopes</label>
                  <p className="text-[11px] text-gray-600 mt-0.5">Override the defaults for an individual agent, engineer, or repo.</p>
                </div>
                <span className="text-[10px] text-gray-600">overrides default caps</span>
              </div>

              {/* Tab bar */}
              <div className="border-b border-gray-800/80 flex items-center gap-1 -mb-px" role="tablist" aria-label="Scope">
                {tabs.map((t) => {
                  const Icon = t.Icon;
                  const isActive = activeSection === t.key;
                  const hasOverrides = t.capped > 0;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => { setActiveSection(t.key); setExpandedRowKey(null); }}
                      className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                        isActive
                          ? 'border-indigo-500 text-indigo-300'
                          : 'border-transparent text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <Icon className={`w-4 h-4 ${isActive || hasOverrides ? 'text-indigo-300' : ''}`} />
                      {t.label}
                      <span className={`tabular-nums text-[11px] ml-0.5 ${isActive ? 'text-indigo-200' : hasOverrides ? 'text-indigo-300/80' : 'text-gray-600'}`}>
                        ({t.capped}/{t.total})
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Table */}
              <div role="tabpanel" className="rounded-xl border border-gray-800/80 bg-gray-950/40 overflow-hidden">
                {/* Column header */}
                <div className="grid grid-cols-[20px_minmax(0,1fr)_220px_auto] gap-3 px-3 py-2 text-[10px] uppercase tracking-wider text-gray-600 font-medium border-b border-gray-800/80 bg-gray-950/60">
                  <span />
                  <span>Name</span>
                  <span>Usage</span>
                  <span className="justify-self-end pr-1">Cap</span>
                </div>

                <div className="divide-y divide-gray-800/60">
                  {activeSection === 'agents' && (
                    agentBudgets.length === 0
                      ? <div className="p-6 text-center text-sm text-gray-500">No agents yet — they'll appear here after their first session.</div>
                      : [...agentBudgets].sort((a, b) => b.currentSpend - a.currentSpend).map((agent) => renderScopeRow({
                          rowKey: `agent-${agent.agentId}`,
                          name: agent.agentName,
                          sub: agent.slug,
                          sessions: agent.sessions,
                          currentSpend: agent.currentSpend,
                          monthlyLimit: agent.monthlyLimit,
                          period: (agent.period || 'monthly') as Period,
                          // Synthetic "Other" aggregate has no real Agent row
                          // → no AgentModel rows can hang off it. Keep the cap
                          // editor; just disable expansion.
                          expandable: agent.agentId !== '__other__',
                          isEditingFlat: editingAgentLimit === agent.agentId,
                          beginEditFlat: () => {
                            setEditingAgentLimit(agent.agentId);
                            setAgentLimitValue(agent.monthlyLimit > 0 ? String(agent.monthlyLimit) : '');
                            setAgentPeriodValue((agent.period || 'monthly') as Period);
                          },
                          cancelEditFlat: () => setEditingAgentLimit(null),
                          saveFlat: () => handleSaveAgentLimit(agent.agentId),
                          flatValue: agentLimitValue,
                          setFlatValue: setAgentLimitValue,
                          flatPeriod: agentPeriodValue,
                          setFlatPeriod: setAgentPeriodValue,
                          models: (agentModels[agent.agentId] || []) as any,
                          addModel: (model) => handleAddAgentModel(agent.agentId, model),
                          modelEditPrefix: `${agent.agentId}::`,
                          beginEditModel: (model, current, p) => {
                            setEditingModelKey(`${agent.agentId}::${model}`);
                            setModelLimitValue(current && current > 0 ? String(current) : '');
                            setModelPeriodValue(p);
                          },
                          cancelEditModel: () => setEditingModelKey(null),
                          saveModel: (model) => handleSaveModelLimit(agent.agentId, model),
                          modelValue: modelLimitValue,
                          setModelValue: setModelLimitValue,
                          activeEditKey: editingModelKey,
                        }))
                  )}

                  {activeSection === 'developers' && (
                    userBudgets.length === 0
                      ? <div className="p-6 text-center text-sm text-gray-500">No engineer activity yet — they'll appear here after their first session.</div>
                      : [...userBudgets].sort((a, b) => b.currentSpend - a.currentSpend).map((user) => renderScopeRow({
                          rowKey: `user-${user.userId}`,
                          name: user.name,
                          sub: user.email,
                          sessions: user.sessions,
                          currentSpend: user.currentSpend,
                          monthlyLimit: user.monthlyLimit,
                          period: (user.period || 'monthly') as Period,
                          expandable: true,
                          isEditingFlat: editingUserLimit === user.userId,
                          beginEditFlat: () => {
                            setEditingUserLimit(user.userId);
                            setUserLimitValue(user.monthlyLimit > 0 ? String(user.monthlyLimit) : '');
                            setUserPeriodValue((user.period || 'monthly') as Period);
                          },
                          cancelEditFlat: () => setEditingUserLimit(null),
                          saveFlat: () => handleSaveUserLimit(user.userId),
                          flatValue: userLimitValue,
                          setFlatValue: setUserLimitValue,
                          flatPeriod: userPeriodValue,
                          setFlatPeriod: setUserPeriodValue,
                          models: (userModels[user.userId] || []) as any,
                          addModel: (model) => handleAddUserModel(user.userId, model),
                          modelEditPrefix: `user:${user.userId}::`,
                          beginEditModel: (model, current, p) => {
                            setEditingModelKey(`user:${user.userId}::${model}`);
                            setModelLimitValue(current && current > 0 ? String(current) : '');
                            setModelPeriodValue(p);
                          },
                          cancelEditModel: () => setEditingModelKey(null),
                          saveModel: (model) => handleSaveUserModelLimit(user.userId, model),
                          modelValue: modelLimitValue,
                          setModelValue: setModelLimitValue,
                          activeEditKey: editingModelKey,
                        }))
                  )}

                  {activeSection === 'repos' && (
                    repoBudgets.length === 0
                      ? <div className="p-6 text-center text-sm text-gray-500">No repositories yet.</div>
                      : [...repoBudgets].sort((a, b) => b.currentSpend - a.currentSpend).map((repo) => renderScopeRow({
                          rowKey: `repo-${repo.repoId}`,
                          name: repo.repoName,
                          sub: '',
                          sessions: repo.sessions,
                          currentSpend: repo.currentSpend,
                          monthlyLimit: repo.monthlyLimit,
                          period: (repo.period || 'monthly') as Period,
                          expandable: true,
                          isEditingFlat: editingRepoFlatLimit === repo.repoId,
                          beginEditFlat: () => {
                            setEditingRepoFlatLimit(repo.repoId);
                            setRepoFlatLimitValue(repo.monthlyLimit > 0 ? String(repo.monthlyLimit) : '');
                            setRepoFlatPeriodValue((repo.period || 'monthly') as Period);
                          },
                          cancelEditFlat: () => setEditingRepoFlatLimit(null),
                          saveFlat: () => handleSaveRepoFlatLimit(repo.repoId),
                          flatValue: repoFlatLimitValue,
                          setFlatValue: setRepoFlatLimitValue,
                          flatPeriod: repoFlatPeriodValue,
                          setFlatPeriod: setRepoFlatPeriodValue,
                          models: (repoModels[repo.repoId] || []) as any,
                          addModel: (model) => handleAddRepoModel(repo.repoId, model),
                          modelEditPrefix: `repo:${repo.repoId}::`,
                          beginEditModel: (model, current, p) => {
                            setEditingRepoLimit(`repo:${repo.repoId}::${model}`);
                            setRepoLimitValue(current && current > 0 ? String(current) : '');
                            setModelPeriodValue(p);
                          },
                          cancelEditModel: () => setEditingRepoLimit(null),
                          saveModel: (model) => handleSaveRepoModelLimit(repo.repoId, model),
                          modelValue: repoLimitValue,
                          setModelValue: setRepoLimitValue,
                          activeEditKey: editingRepoLimit,
                        }))
                  )}
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ─── close BUDGET TAB BODY ─────────────────────────────────────── */}
      </>)}

      {/* ─── TOKENS TAB BODY ─ token mix from /api/insights/token-breakdown.
          Same data the Spend Quality dashboard's Section 6 uses; surfaced
          here so admins can review token efficiency next to spend caps
          without leaving the Budget area. ────────────────────────────── */}
      {pageTab === 'tokens' && (
        <TokensTab tokenMix={tokenMix} byAgent={tokenByAgent} byModel={tokenByModel} combined={tokenCombined} />
      )}

      {/* Recompute diagnostic moved to a header button — see the
          showRecompute panel under the page title. No bottom render. */}
    </div>
  );
}

// ── Tokens tab — full-width breakdown with per-engineer/agent/model ───────
// Three things it shows:
//   1. Org totals (generated / cache-read / cache-write) + cache-hit ratio
//   2. Stacked bar — relative split across the org
//   3. Per-engineer / per-agent / per-model lists, switched via inner tabs
// Reuses the data already fetched by the page (no extra API call); this
// component is dumb and renders whatever the parent passes in.
function TokensTab({ tokenMix, byAgent, byModel, combined }: {
  tokenMix: api.TokenBreakdownRow[];
  byAgent: api.TokenBreakdownAgentRow[];
  byModel: api.TokenBreakdownModelRow[];
  combined: api.TokenBreakdownComboRow[];
}) {
  // Inner-tab state — Combined / Engineers / Agents / Models. Combined is the
  // default because it's the most informative single view: every row carries
  // engineer + agent + model attribution side by side. Falls back to whichever
  // single-axis breakdown has rows when Combined is empty.
  const [view, setView] = useState<'combined' | 'engineers' | 'agents' | 'models'>(() => {
    if (combined.length > 0) return 'combined';
    if (tokenMix.length > 0) return 'engineers';
    if (byAgent.length > 0) return 'agents';
    if (byModel.length > 0) return 'models';
    return 'combined';
  });

  // Which KPI card was clicked to drill in — drives sort order in the
  // per-row list and the "highlighted" bar segment. null = no drill,
  // sort by total tokens (default).
  type TokenMetric = 'gen' | 'read' | 'write' | 'hit';
  const [drillMetric, setDrillMetric] = useState<TokenMetric | null>(null);
  const breakdownRef = useRef<HTMLDivElement>(null);

  // Click a KPI card → switch to Agents view (per user's ask), set the
  // sort/highlight metric, and scroll the breakdown into view. The agent
  // breakdown is what answers "who is driving this?".
  const drillToAgents = (metric: TokenMetric) => {
    setView('agents');
    setDrillMetric((prev) => (prev === metric ? null : metric));
    setTimeout(() => {
      const el = breakdownRef.current;
      if (!el) return;
      const scroller = el.closest('main') as HTMLElement | null;
      if (!scroller) { el.scrollIntoView({ block: 'start' }); return; }
      const target = el.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top
        + scroller.scrollTop
        - 12;
      scroller.scrollTop = target;
    }, 50);
  };

  // Render the KPI cards + bar + breakdown shell even with zero data
  // — the per-row lists already carry their own empty messages, and a
  // skeleton view is more useful than a wall of "no data" text on a
  // freshly-set-up org.

  // Org totals computed off whichever breakdown has the most rows — they
  // should sum to the same numbers, but engineer-rollup is the most likely
  // to have full coverage (every session has a userId; not every session
  // has agentId).
  const sourceForTotals = tokenMix.length > 0 ? tokenMix : byAgent.length > 0 ? byAgent : byModel;
  const totals = sourceForTotals.reduce((t, r) => ({
    gen: t.gen + r.generatedTokens,
    read: t.read + r.cacheReadTokens,
    write: t.write + r.cacheCreationTokens,
  }), { gen: 0, read: 0, write: 0 });
  const sum = totals.gen + totals.read + totals.write;
  const cacheHit = (totals.gen + totals.read) > 0
    ? totals.read / (totals.gen + totals.read)
    : 0;
  const wGen = sum > 0 ? (totals.gen / sum) * 100 : 0;
  const wRead = sum > 0 ? (totals.read / sum) * 100 : 0;
  const wWrite = sum > 0 ? (totals.write / sum) * 100 : 0;
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}k` : String(n);
  const outliers = sourceForTotals.filter((r) => r.isOutlier).length;

  return (
    <div className="space-y-6">
      {/* Org totals — 4 KPI cells. Each is a button: click jumps to the
          per-agent breakdown sorted by that metric, so "Generated 144k"
          becomes "which agents generated those 144k tokens, ranked".
          Active card gets an indigo ring matching the per-tab color. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {([
          { key: 'gen' as TokenMetric,   label: 'Generated',   value: fmt(totals.gen),   sub: 'input + output (full price)', valueClass: 'text-gray-50',   ring: 'ring-indigo-400/60' },
          { key: 'read' as TokenMetric,  label: 'Cache reads', value: fmt(totals.read),  sub: '~10% of input pricing',       valueClass: 'text-cyan-300',  ring: 'ring-cyan-400/60' },
          { key: 'write' as TokenMetric, label: 'Cache writes', value: fmt(totals.write), sub: '~125% of input pricing',     valueClass: 'text-amber-300', ring: 'ring-amber-400/60' },
          { key: 'hit' as TokenMetric,   label: 'Cache hit %',  value: `${(cacheHit * 100).toFixed(0)}%`,
            sub: outliers > 0 ? `⚠ ${outliers} outlier${outliers !== 1 ? 's' : ''}` : 'higher = cheaper',
            valueClass: cacheHit >= 0.5 ? 'text-emerald-300' : cacheHit >= 0.25 ? 'text-gray-100' : 'text-amber-300',
            ring: 'ring-emerald-400/60',
          },
        ]).map((c) => {
          const active = drillMetric === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => drillToAgents(c.key)}
              aria-pressed={active}
              className={`text-left rounded-xl border bg-gray-900/40 p-4 transition-colors cursor-pointer ${
                active
                  ? `border-transparent ring-2 ${c.ring} bg-gray-900/70`
                  : 'border-gray-800 hover:border-gray-700 hover:bg-gray-900/60'
              }`}
              title="Click to see per-agent breakdown"
            >
              <div className="flex items-center justify-between">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">{c.label}</div>
                <div className="text-[10px] text-gray-600 group-hover:text-gray-400">per agent →</div>
              </div>
              <div className={`text-2xl font-semibold tabular-nums mt-1 ${c.valueClass}`}>{c.value}</div>
              <div className="text-[10px] text-gray-600 mt-0.5">{c.sub}</div>
            </button>
          );
        })}
      </div>

      {/* Org-wide stacked bar */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-200">Org-wide token mix</h3>
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">last 30 days</span>
        </div>
        <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-800">
          <div className="bg-indigo-500/80" style={{ width: `${wGen}%` }} title={`Generated: ${totals.gen.toLocaleString()}`} />
          <div className="bg-cyan-500/70" style={{ width: `${wRead}%` }} title={`Cache reads: ${totals.read.toLocaleString()}`} />
          <div className="bg-amber-500/60" style={{ width: `${wWrite}%` }} title={`Cache writes: ${totals.write.toLocaleString()}`} />
        </div>
        <div className="flex flex-wrap gap-4 text-[11px] text-gray-500">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-indigo-500/80" /> Generated</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-cyan-500/70" /> Cache reads</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-amber-500/60" /> Cache writes</span>
        </div>
      </div>

      {/* Inner sub-tabs — switch breakdown axis */}
      <div ref={breakdownRef} className="rounded-xl border border-gray-800 bg-gray-900/40">
        <div className="border-b border-gray-800 flex items-center justify-between px-2" role="tablist" aria-label="Token breakdown axis">
          <div className="flex items-center gap-1">
            {([
              ['combined',  'Combined',  combined.length],
              ['engineers', 'Engineers', tokenMix.length],
              ['agents',    'Agents',    byAgent.length],
              ['models',    'Models',    byModel.length],
            ] as Array<[typeof view, string, number]>).map(([key, label, count]) => {
              const active = view === key;
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setView(key)}
                  className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    active ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {label} <span className="text-[10px] text-gray-600 ml-1 tabular-nums">({count})</span>
                </button>
              );
            })}
          </div>
          {drillMetric && (
            <button
              type="button"
              onClick={() => setDrillMetric(null)}
              className="text-[10px] uppercase tracking-wider text-gray-500 hover:text-gray-300 px-2 py-1"
              title="Clear sort, show by total tokens"
            >
              Sorted by {drillMetric === 'gen' ? 'generated' : drillMetric === 'read' ? 'cache reads' : drillMetric === 'write' ? 'cache writes' : 'cache hit %'} · clear ✕
            </button>
          )}
        </div>

        {view === 'engineers' && (
          <TokenRowList
            rows={tokenMix.map((r) => ({ key: r.userId, name: r.name, sub: '', generated: r.generatedTokens, read: r.cacheReadTokens, write: r.cacheCreationTokens, isOutlier: r.isOutlier }))}
            emptyMsg="No engineer activity in the last 30 days."
            fmt={fmt}
            sortBy={drillMetric}
          />
        )}
        {view === 'agents' && (
          <TokenRowList
            rows={byAgent.map((r) => ({ key: r.agentId, name: r.name, sub: r.slug, generated: r.generatedTokens, read: r.cacheReadTokens, write: r.cacheCreationTokens, isOutlier: r.isOutlier }))}
            emptyMsg="No agent-attributed sessions yet. Sessions without an agentId fall through to engineer-only rollup."
            fmt={fmt}
            sortBy={drillMetric}
          />
        )}
        {view === 'models' && (
          <TokenRowList
            rows={byModel.map((r) => ({ key: r.model, name: r.name, sub: '', generated: r.generatedTokens, read: r.cacheReadTokens, write: r.cacheCreationTokens, isOutlier: r.isOutlier }))}
            emptyMsg="No model usage in the last 30 days."
            fmt={fmt}
            mono
            sortBy={drillMetric}
          />
        )}
        {view === 'combined' && (
          <CombinedTokenTable rows={combined} fmt={fmt} sortBy={drillMetric} />
        )}
      </div>
    </div>
  );
}

// Cross-tab table — one row per (engineer × agent × model). Sortable on any
// column; default sort matches whichever KPI the user drilled in from, falling
// back to total tokens. Uses a real <table> so column alignment stays tight
// regardless of name length, and the data is scannable horizontally (which is
// the point of having all three dimensions in one view).
function CombinedTokenTable({
  rows, fmt, sortBy = null,
}: {
  rows: api.TokenBreakdownComboRow[];
  fmt: (n: number) => string;
  sortBy?: 'gen' | 'read' | 'write' | 'hit' | null;
}) {
  type ColKey = 'engineer' | 'agent' | 'model' | 'gen' | 'read' | 'write' | 'hit' | 'total' | 'sessions';
  type SortEntry = { col: ColKey; dir: 'asc' | 'desc' };
  // Sort stack — first entry is the primary sort, subsequent are tiebreakers.
  // Click a header to replace; shift-click (or cmd/ctrl-click) to append a
  // secondary sort. Same-column click toggles direction; same-column
  // shift-click while it's already in the stack also toggles its direction
  // in place.
  const [sortStack, setSortStack] = useState<SortEntry[]>(() => {
    if (sortBy === 'gen')   return [{ col: 'gen',   dir: 'desc' }];
    if (sortBy === 'read')  return [{ col: 'read',  dir: 'desc' }];
    if (sortBy === 'write') return [{ col: 'write', dir: 'desc' }];
    if (sortBy === 'hit')   return [{ col: 'hit',   dir: 'desc' }];
    return [{ col: 'total', dir: 'desc' }];
  });
  const [filter, setFilter] = useState('');

  if (rows.length === 0) {
    return <div className="p-6 text-center text-xs text-gray-500">No combined breakdown yet — once sessions land with engineer + agent + model attribution, they'll appear here.</div>;
  }

  const hitRate = (r: api.TokenBreakdownComboRow) =>
    (r.generatedTokens + r.cacheReadTokens) > 0
      ? r.cacheReadTokens / (r.generatedTokens + r.cacheReadTokens)
      : 0;

  const f = filter.trim().toLowerCase();
  const filtered = !f
    ? rows
    : rows.filter((r) =>
        r.userName.toLowerCase().includes(f) ||
        r.agentName.toLowerCase().includes(f) ||
        r.agentSlug.toLowerCase().includes(f) ||
        r.model.toLowerCase().includes(f),
      );

  const valueFor = (r: api.TokenBreakdownComboRow, col: ColKey): number | string => {
    switch (col) {
      case 'engineer': return r.userName;
      case 'agent':    return r.agentName;
      case 'model':    return r.model;
      case 'gen':      return r.generatedTokens;
      case 'read':     return r.cacheReadTokens;
      case 'write':    return r.cacheCreationTokens;
      case 'hit':      return hitRate(r);
      case 'sessions': return r.sessionCount;
      case 'total':
      default:
        return r.generatedTokens + r.cacheReadTokens + r.cacheCreationTokens;
    }
  };

  const sorted = [...filtered].sort((a, b) => {
    for (const { col, dir } of sortStack) {
      const av = valueFor(a, col);
      const bv = valueFor(b, col);
      const sign = dir === 'asc' ? 1 : -1;
      let c: number;
      if (typeof av === 'number' && typeof bv === 'number') c = (av - bv) * sign;
      else c = String(av).localeCompare(String(bv)) * sign;
      if (c !== 0) return c;
    }
    return 0;
  });

  // Click → replace the stack with this column. Shift/Cmd/Ctrl-click → append
  // (or toggle direction if already in stack). Same-column re-click toggles
  // direction at its current position.
  const handleHeaderClick = (col: ColKey, e: React.MouseEvent) => {
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const defaultDir: 'asc' | 'desc' = (col === 'engineer' || col === 'agent' || col === 'model') ? 'asc' : 'desc';
    setSortStack((prev) => {
      const existingIdx = prev.findIndex((s) => s.col === col);
      if (additive) {
        if (existingIdx === -1) return [...prev, { col, dir: defaultDir }];
        return prev.map((s, i) => i === existingIdx ? { ...s, dir: s.dir === 'desc' ? 'asc' : 'desc' } : s);
      }
      // Non-additive: reset stack to just this column.
      if (prev.length === 1 && prev[0].col === col) {
        return [{ col, dir: prev[0].dir === 'desc' ? 'asc' : 'desc' }];
      }
      return [{ col, dir: defaultDir }];
    });
  };

  const stackIndex = (col: ColKey) => sortStack.findIndex((s) => s.col === col);
  const arrow = (col: ColKey) => {
    const idx = stackIndex(col);
    if (idx === -1) return '';
    const dir = sortStack[idx].dir === 'desc' ? '↓' : '↑';
    // Show the priority number when there's more than one sort key.
    return sortStack.length > 1 ? ` ${dir}${idx + 1}` : ` ${dir}`;
  };

  const headerCls = (col: ColKey, align: 'left' | 'right' = 'left') =>
    `px-3 py-2 text-[10px] uppercase tracking-wider font-medium cursor-pointer select-none hover:text-gray-200 ${
      align === 'right' ? 'text-right' : 'text-left'
    } ${stackIndex(col) !== -1 ? 'text-gray-100' : 'text-gray-500'}`;

  const sortHint = sortStack.length > 1
    ? `${sortStack.length}-key sort · shift-click a column to add another · click to reset`
    : 'shift-click another column to add a secondary sort';

  return (
    <div>
      <div className="px-3 py-2.5 border-b border-gray-800/60 flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by engineer, agent or model…"
          className="flex-1 max-w-sm bg-gray-900/60 border border-gray-800 rounded-md px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-700"
        />
        <span className="text-[10px] text-gray-600 tabular-nums">
          {filtered.length === rows.length ? `${rows.length} rows` : `${filtered.length} of ${rows.length}`}
        </span>
        <span className="text-[10px] text-gray-600 ml-auto" title={sortHint}>{sortHint}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-900/30">
            <tr>
              <th className={headerCls('engineer')}    onClick={(e) => handleHeaderClick('engineer', e)}>Engineer{arrow('engineer')}</th>
              <th className={headerCls('agent')}       onClick={(e) => handleHeaderClick('agent', e)}>Agent{arrow('agent')}</th>
              <th className={headerCls('model')}       onClick={(e) => handleHeaderClick('model', e)}>Model{arrow('model')}</th>
              <th className={headerCls('gen', 'right')}      onClick={(e) => handleHeaderClick('gen', e)}>Generated{arrow('gen')}</th>
              <th className={headerCls('read', 'right')}     onClick={(e) => handleHeaderClick('read', e)}>Cache read{arrow('read')}</th>
              <th className={headerCls('write', 'right')}    onClick={(e) => handleHeaderClick('write', e)}>Cache write{arrow('write')}</th>
              <th className={headerCls('hit', 'right')}      onClick={(e) => handleHeaderClick('hit', e)}>Hit %{arrow('hit')}</th>
              <th className={headerCls('total', 'right')}    onClick={(e) => handleHeaderClick('total', e)}>Total{arrow('total')}</th>
              <th className={headerCls('sessions', 'right')} onClick={(e) => handleHeaderClick('sessions', e)}>Sessions{arrow('sessions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {sorted.map((r) => {
              const total = r.generatedTokens + r.cacheReadTokens + r.cacheCreationTokens;
              const hit = hitRate(r);
              const hitClass = hit >= 0.5 ? 'text-emerald-300' : hit >= 0.25 ? 'text-gray-300' : 'text-amber-300';
              return (
                <tr key={`${r.userId}|${r.agentId}|${r.model}`} className="hover:bg-gray-900/40">
                  <td className="px-3 py-2 text-gray-200 whitespace-nowrap">{r.userName}</td>
                  <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                    {r.agentName}
                    {r.agentSlug && <span className="text-[10px] text-gray-600 ml-1">{r.agentSlug}</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-300 font-mono whitespace-nowrap">{r.model}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-100">{fmt(r.generatedTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-cyan-300">{fmt(r.cacheReadTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-300">{fmt(r.cacheCreationTokens)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${hitClass}`}>{(hit * 100).toFixed(0)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-100">{fmt(total)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-400">{r.sessionCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Shared row renderer — same shape regardless of breakdown axis. `mono`
// renders the name in a monospace font (used for model rows so SHAs and
// version numbers line up). `sortBy` re-orders rows by the chosen metric
// (set when the user clicks a top-level KPI card) and emphasises the
// matching label below each bar.
function TokenRowList({
  rows, emptyMsg, fmt, mono = false, sortBy = null,
}: {
  rows: Array<{ key: string; name: string; sub: string; generated: number; read: number; write: number; isOutlier: boolean }>;
  emptyMsg: string;
  fmt: (n: number) => string;
  mono?: boolean;
  sortBy?: 'gen' | 'read' | 'write' | 'hit' | null;
}) {
  if (rows.length === 0) {
    return <div className="p-6 text-center text-xs text-gray-500">{emptyMsg}</div>;
  }
  // Cache-hit ratio per row: read / (gen + read). Falls back to 0 when no
  // input pricing applies, so a row with only cache-writes doesn't sort
  // ahead of rows that actually exercised the cache.
  const hitRate = (r: { generated: number; read: number }) =>
    (r.generated + r.read) > 0 ? r.read / (r.generated + r.read) : 0;
  const sorted = [...rows].sort((a, b) => {
    if (sortBy === 'gen') return b.generated - a.generated;
    if (sortBy === 'read') return b.read - a.read;
    if (sortBy === 'write') return b.write - a.write;
    if (sortBy === 'hit') return hitRate(b) - hitRate(a);
    // default: total tokens
    return (b.generated + b.read + b.write) - (a.generated + a.read + a.write);
  });
  const totals = sorted.map((r) => r.generated + r.read + r.write);
  const orgMax = Math.max(...totals, 1);
  const emph = (k: 'gen' | 'read' | 'write' | 'hit') =>
    sortBy === k ? 'text-gray-100 font-medium' : 'text-gray-500';
  return (
    <ul className="divide-y divide-gray-800/60">
      {sorted.map((r) => {
        const total = r.generated + r.read + r.write;
        const w = (n: number) => total > 0 ? (n / orgMax) * 100 : 0;
        const hit = hitRate(r);
        // When user sorted by a specific metric, surface that number
        // prominently in the right-hand value slot instead of total.
        const headlineValue = sortBy === 'gen'  ? `${fmt(r.generated)} generated`
                            : sortBy === 'read' ? `${fmt(r.read)} cache-read`
                            : sortBy === 'write' ? `${fmt(r.write)} cache-write`
                            : sortBy === 'hit'  ? `${(hit * 100).toFixed(0)}% cache hit`
                            : `${fmt(total)} tokens`;
        return (
          <li key={r.key} className="p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className={`text-gray-200 ${mono ? 'font-mono text-xs' : ''}`}>
                {r.name}
                {r.sub && <span className="ml-2 text-[10px] text-gray-500">{r.sub}</span>}
                {r.isOutlier && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300" title="Cache-read ratio is more than 10× the median">
                    ⚠ cache outlier
                  </span>
                )}
              </span>
              <span className={`tabular-nums text-xs ${sortBy ? 'text-gray-100' : 'text-gray-500'}`}>{headlineValue}</span>
            </div>
            <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-800">
              <div className={`bg-indigo-500/80 ${sortBy && sortBy !== 'gen' ? 'opacity-30' : ''}`} style={{ width: `${w(r.generated)}%` }} />
              <div className={`bg-cyan-500/70 ${sortBy && sortBy !== 'read' && sortBy !== 'hit' ? 'opacity-30' : ''}`} style={{ width: `${w(r.read)}%` }} />
              <div className={`bg-amber-500/60 ${sortBy && sortBy !== 'write' ? 'opacity-30' : ''}`} style={{ width: `${w(r.write)}%` }} />
            </div>
            <div className="flex gap-3 text-[10px] tabular-nums">
              <span className={emph('gen')}>gen {fmt(r.generated)}</span>
              <span className={emph('read')}>cache-read {fmt(r.read)}</span>
              <span className={emph('write')}>cache-write {fmt(r.write)}</span>
              {sortBy === 'hit' && <span className={emph('hit')}>hit {(hit * 100).toFixed(0)}%</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
