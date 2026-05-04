import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { BudgetData, ForecastData } from '../api';
import { AlertTriangle, TrendingUp, TrendingDown, Minus, DollarSign, Users, Cpu, GitPullRequest, Shield, Calculator, Mail, FolderOpen, Wrench } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import RecomputeCostsCard from '../components/RecomputeCostsCard';

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
// One panel that renders below the top KPI grid when any of the 6 cards is
// clicked. Spend cards (today/week/month) get a 3-tab sub-view (engineers /
// agents / models). Projected gets a forecast read-out. Models/Engineers
// cards each get a single ranked list. Closing the panel collapses it.
type KpiPanelKey = 'today' | 'week' | 'month' | 'projected' | 'models' | 'engineers';
const KPI_TITLES: Record<KpiPanelKey, string> = {
  today: "Today's spend — who and what",
  week: "This week's spend — who and what",
  month: "This month's spend — who and what",
  projected: 'Month-end forecast',
  models: 'Models in use',
  engineers: 'Engineers active',
};

const KpiDetailPanel = React.forwardRef<HTMLDivElement, {
  kpi: KpiPanelKey;
  onClose: () => void;
  spend: BudgetSpendShape;
  forecast: ForecastData | null;
  agentBudgets: Array<{ agentId: string; agentName: string; slug: string; currentSpend: number; sessions: number }>;
}>(function KpiDetailPanel({ kpi, onClose, spend, forecast, agentBudgets }, ref) {
  // Spend cards share a 3-tab inner switcher; default tab varies by which
  // card was clicked so the most-relevant breakdown opens first.
  const isSpendCard = kpi === 'today' || kpi === 'week' || kpi === 'month';
  const [tab, setTab] = useState<'engineers' | 'agents' | 'models'>('engineers');

  const totalForCard =
    kpi === 'today'   ? spend.byPeriod?.daily   ?? 0 :
    kpi === 'week'    ? spend.byPeriod?.weekly  ?? 0 :
    kpi === 'month'   ? spend.byPeriod?.monthly ?? 0 :
    null;

  return (
    <div ref={ref} className="rounded-xl border border-indigo-500/30 bg-gray-900/60 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">{KPI_TITLES[kpi]}</h3>
          {isSpendCard && totalForCard !== null && (
            <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">${totalForCard.toFixed(2)} this period</p>
          )}
        </div>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1" aria-label="Close panel">
          Close ✕
        </button>
      </div>

      {/* Spend cards — 3 sub-tabs */}
      {isSpendCard && (
        <>
          <div className="border-b border-gray-800 flex items-center gap-1" role="tablist">
            {([
              ['engineers', 'Engineers', spend.byUser?.length ?? 0],
              ['agents',    'Agents',    agentBudgets.length],
              ['models',    'Models',    spend.byModel?.length ?? 0],
            ] as Array<[typeof tab, string, number]>).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === key ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                {label} <span className="text-[10px] text-gray-600 ml-1 tabular-nums">({count})</span>
              </button>
            ))}
          </div>
          {tab === 'engineers' && (
            <RankedList
              rows={(spend.byUser ?? []).map((u) => ({
                key: u.userId, name: u.name || u.userId, sub: `${u.sessions} session${u.sessions !== 1 ? 's' : ''}`, value: u.cost,
              }))}
              emptyMsg="No engineer activity in this period."
              format={(n) => `$${n.toFixed(2)}`}
            />
          )}
          {tab === 'agents' && (
            <RankedList
              rows={agentBudgets.map((a) => ({
                key: a.agentId, name: a.agentName, sub: `${a.sessions} session${a.sessions !== 1 ? 's' : ''} · ${a.slug}`, value: a.currentSpend,
              }))}
              emptyMsg="No agent-attributed sessions yet."
              format={(n) => `$${n.toFixed(2)}`}
            />
          )}
          {tab === 'models' && (
            <RankedList
              rows={(spend.byModel ?? []).map((m) => ({
                key: m.model, name: m.model, sub: `${m.sessions} session${m.sessions !== 1 ? 's' : ''}`, value: m.cost,
              }))}
              emptyMsg="No model usage in this period."
              format={(n) => `$${n.toFixed(2)}`}
              mono
            />
          )}
          <p className="text-[10px] text-gray-600">
            Breakdown shows the active enforcement period — same scope as the highlighted Today/Week/Month cell.
          </p>
        </>
      )}

      {/* Projected month-end — show forecast.byModel ranked, plus
          confidence + trend explanation. */}
      {kpi === 'projected' && (
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

      {/* Models in use — single ranked list of cost/sessions per model */}
      {kpi === 'models' && (
        <RankedList
          rows={(spend.byModel ?? []).map((m) => ({
            key: m.model, name: m.model, sub: `${m.sessions} session${m.sessions !== 1 ? 's' : ''}`, value: m.cost,
          }))}
          emptyMsg="No models recorded yet."
          format={(n) => `$${n.toFixed(2)}`}
          mono
        />
      )}

      {/* Engineers active — single ranked list of cost/sessions per engineer */}
      {kpi === 'engineers' && (
        <RankedList
          rows={(spend.byUser ?? []).map((u) => ({
            key: u.userId, name: u.name || u.userId, sub: `${u.sessions} session${u.sessions !== 1 ? 's' : ''}`, value: u.cost,
          }))}
          emptyMsg="No engineer activity recorded yet."
          format={(n) => `$${n.toFixed(2)}`}
        />
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

  // ── Active section tab ───────────────────────────────────────────────────
  const [activeSection, setActiveSection] = useState<'agents' | 'developers' | 'repos'>('agents');

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
  type KpiKey = 'today' | 'week' | 'month' | 'projected' | 'models' | 'engineers';
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
      }
    } catch (err) {
      console.error('Budget fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

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
        <h1 className="text-2xl font-bold text-gray-100">Budget</h1>
        <p className="text-sm text-gray-500">Loading budget data...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header — title + jump-to-limits CTA so admins land on the
          control surface in one click instead of scrolling past charts. */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Budget</h1>
          <p className="text-sm text-gray-500 mt-1">Cost controls, spending limits, and forecasting</p>
        </div>
        {isAdmin && pageTab === 'budget' && (
          <div className="flex items-center gap-2">
            {/* Recompute costs — admin diagnostic. Used to live as a
                full-width card at the bottom of the page; now a small
                button up top that toggles the panel inline below the
                header. Same component, smaller footprint. */}
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
        )}
      </div>

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

      {/* Three-period strip — daily/weekly/monthly side-by-side. Each cell
          is a button: click expands the inline detail panel below the
          two-row card grid, scoped to that period. */}
      {budgetData && (() => {
        const byPeriod = budgetData.currentSpend.byPeriod || { daily: 0, weekly: 0, monthly: budgetData.currentSpend.monthly };
        const activePeriod: Period = (budgetData.config.period || 'monthly') as Period;
        const limit = budgetData.config.monthlyLimit;
        const cells: Array<{ key: Period; kpi: KpiKey; label: string; value: number }> = [
          { key: 'daily',   kpi: 'today', label: 'Today',      value: byPeriod.daily   },
          { key: 'weekly',  kpi: 'week',  label: 'This week',  value: byPeriod.weekly  },
          { key: 'monthly', kpi: 'month', label: 'This month', value: byPeriod.monthly },
        ];
        return (
          <div className="grid grid-cols-3 gap-3">
            {cells.map(({ key, kpi, label, value }) => {
              const isActive = key === activePeriod;
              const isExpanded = expandedKpi === kpi;
              const showLimit = isActive && limit > 0;
              const pct = showLimit ? Math.min((value / limit) * 100, 110) : 0;
              const tier = pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'green';
              const baseTone =
                tier === 'red' ? 'border-red-500/40 bg-red-500/[0.06]' :
                tier === 'amber' ? 'border-amber-500/40 bg-amber-500/[0.05]' :
                isActive ? 'border-indigo-500/40 bg-indigo-500/[0.05]' : 'border-gray-800 bg-gray-900/40';
              const expandedTone = isExpanded ? 'ring-2 ring-indigo-400/60 bg-gray-900/70' : '';
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleKpi(kpi)}
                  aria-pressed={isExpanded}
                  className={`relative rounded-xl border p-4 text-left w-full transition-colors hover:bg-gray-900/60 cursor-pointer ${baseTone} ${expandedTone}`}
                  title="Click for breakdown"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">{label}</span>
                    {isActive ? (
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-indigo-300">Enforcing</span>
                    ) : (
                      <span className={`text-[9px] uppercase tracking-wider ${isExpanded ? 'text-indigo-300' : 'text-gray-600'}`}>
                        {isExpanded ? 'shown ↓' : 'details →'}
                      </span>
                    )}
                  </div>
                  <div className="text-2xl font-semibold text-gray-50 tabular-nums mt-1">${value.toFixed(2)}</div>
                  {showLimit ? (
                    <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">{pct.toFixed(0)}% of ${limit.toFixed(0)} {key} cap</p>
                  ) : (
                    <p className="text-[11px] text-gray-600 mt-0.5">{key === 'monthly' ? 'lifetime since 1st' : key === 'weekly' ? 'since Monday' : 'since 00:00'}</p>
                  )}
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* Slim KPI strip — Projected + Models + Engineers. "Monthly spend"
          and "Anomalies" used to live here too, but they duplicate the
          period-strip number above and the Anomalies tab badge. Three
          forward-looking cells is enough; raw spend belongs in the strip. */}
      <div className="grid grid-cols-3 gap-4">
        <BudgetStat
          accent={forecastData?.trend === 'up' ? 'red' : forecastData?.trend === 'down' ? 'green' : 'cyan'}
          label="Projected month-end"
          Icon={forecastData?.trend === 'up' ? TrendingUp : forecastData?.trend === 'down' ? TrendingDown : Minus}
          value={`$${forecastData?.projectedMonthly.toFixed(2) || '0.00'}`}
          sub={`${Math.round((forecastData?.confidence ?? 0) * 100)}% confidence`}
          active={expandedKpi === 'projected'}
          onClick={() => toggleKpi('projected')}
        />
        <BudgetStat
          accent="purple"
          label="Models in use"
          Icon={Cpu}
          value={budgetData?.currentSpend.byModel.length || 0}
          sub={budgetData?.currentSpend.byUser.length
            ? `${budgetData.currentSpend.byUser.length} engineer${budgetData.currentSpend.byUser.length !== 1 ? 's' : ''}`
            : 'No engineers yet'}
          active={expandedKpi === 'models'}
          onClick={() => toggleKpi('models')}
        />
        <BudgetStat
          accent="indigo"
          label="Engineers active"
          Icon={Users}
          value={budgetData?.currentSpend.byUser.length || 0}
          sub={budgetData?.currentSpend.byUser.length
            ? 'this period'
            : 'No activity yet'}
          active={expandedKpi === 'engineers'}
          onClick={() => toggleKpi('engineers')}
        />
      </div>

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
          const agentLimitCount = agentBudgets.filter((a) => a.monthlyLimit > 0).length;
          const userLimitCount = userBudgets.filter((u) => u.monthlyLimit > 0).length;
          const repoLimitCount = Object.values(repoModels).filter((arr) => arr.some((m) => m.monthlyLimit && m.monthlyLimit > 0)).length;
          type SectionKey = 'agents' | 'developers' | 'repos';
          const tabs: Array<{ key: SectionKey; label: string; Icon: typeof Cpu; count: number; total: number | null }> = [
            { key: 'agents',     label: 'Agents',    Icon: Cpu,        count: agentLimitCount, total: agentBudgets.length || null },
            { key: 'developers', label: 'Engineers', Icon: Users,      count: userLimitCount,  total: userBudgets.length || null },
            { key: 'repos',      label: 'Repos',     Icon: FolderOpen, count: repoLimitCount,  total: null },
          ];
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">Tighter caps for specific scopes</label>
                <span className="text-[10px] text-gray-600">overrides default caps</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
                <div className="space-y-1" role="tablist" aria-orientation="vertical" aria-label="Scope">
                  {tabs.map((t) => {
                    const Icon = t.Icon;
                    const isActive = activeSection === t.key;
                    const hasOverrides = t.count > 0;
                    return (
                      <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => setActiveSection(t.key)}
                        className={`w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs transition-all ${
                          isActive
                            ? 'border-transparent ring-2 ring-indigo-400/60 bg-indigo-500/15 text-gray-50'
                            : hasOverrides
                              ? 'border-indigo-500/40 bg-indigo-500/[0.06] text-gray-100 hover:border-indigo-400/70 hover:bg-indigo-500/[0.12]'
                              : 'border-gray-700/80 bg-gray-800/30 text-gray-300 hover:border-gray-600 hover:bg-gray-800/60'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Icon className={`w-3.5 h-3.5 ${isActive || hasOverrides ? 'text-indigo-300' : 'text-gray-500'}`} />
                          <span className="font-medium">{t.label}</span>
                        </span>
                        <span className={`tabular-nums text-[11px] ${isActive ? 'text-indigo-100' : hasOverrides ? 'text-indigo-200' : 'text-gray-500'}`}>
                          {t.count}{t.total !== null ? `/${t.total}` : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div role="tabpanel" className="rounded-xl border border-gray-800/80 bg-gray-950/40 divide-y divide-gray-800/80 min-h-[180px]">

      {activeSection === 'agents' && (
        <div className="divide-y divide-gray-800/80">
          {agentBudgets.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              No agents yet — they'll appear here after their first session.
            </div>
          ) : (
            agentBudgets.sort((a, b) => b.currentSpend - a.currentSpend).map((agent) => {
              const p = agent.monthlyLimit > 0 ? pct(agent.currentSpend, agent.monthlyLimit) : 0;
              const isExpanded = expandedAgentId === agent.agentId;
              const models = agentModels[agent.agentId] || [];
              // Skip the synthetic "Other" bucket — it has no real Agent row
              // backing it, so no AgentModel rows exist for it.
              const expandable = agent.agentId !== '__other__';
              const hasLimit = agent.monthlyLimit > 0;
              const isEditing = editingAgentLimit === agent.agentId;
              // "+ Add limit" focuses the per-model input inside the expand
              // body. Mirrors the repo flow so all three scopes share the
              // same one-click-then-type rhythm.
              const focusAgentAddInput = () => {
                setTimeout(() => {
                  const el = document.getElementById(`agent-add-${agent.agentId}`) as HTMLInputElement | null;
                  el?.focus();
                }, 0);
              };
              const handleAgentAddClick = () => {
                if (!expandable) return;
                if (!isExpanded) toggleAgentExpand(agent.agentId);
                focusAgentAddInput();
              };
              return (
                <div key={agent.agentId}>
                  <div className="px-3 py-2 flex items-center gap-3">
                    {expandable ? (
                      <button
                        type="button"
                        onClick={() => toggleAgentExpand(agent.agentId)}
                        className={`text-gray-500 hover:text-gray-300 transition-transform flex-shrink-0 w-4 ${isExpanded ? 'rotate-90' : ''}`}
                        title={isExpanded ? 'Collapse' : 'Show per-model breakdown'}
                      >
                        ▸
                      </button>
                    ) : (
                      <span className="w-4 flex-shrink-0" />
                    )}
                    <div className="flex items-baseline gap-2 min-w-0 flex-1">
                      <span className="text-sm font-medium text-gray-200 truncate">{agent.agentName}</span>
                      <span className="text-[11px] text-gray-500 truncate">{agent.slug}</span>
                      <span className="text-[11px] text-gray-600 whitespace-nowrap">· {agent.sessions} sess · ${agent.currentSpend.toFixed(2)} spent</span>
                    </div>
                    {hasLimit && !isEditing && (
                      <div className="w-20 h-1.5 rounded-full bg-gray-800 overflow-hidden flex-shrink-0">
                        <div className={`h-full rounded-full transition-all ${barColor(p)}`} style={{ width: `${Math.min(p, 100)}%` }} />
                      </div>
                    )}
                    {isEditing ? (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-xs text-gray-500">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={agentLimitValue}
                          onChange={(e) => setAgentLimitValue(e.target.value)}
                          className="input text-xs w-20 py-0.5 px-1 tabular-nums"
                          autoFocus
                          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAgentLimit(agent.agentId); if (e.key === 'Escape') setEditingAgentLimit(null); }}
                        />
                        <select
                          value={agentPeriodValue}
                          onChange={(e) => setAgentPeriodValue(e.target.value as Period)}
                          className="input text-[10px] py-0.5 px-1"
                          aria-label="Period"
                        >
                          <option value="daily">/d</option>
                          <option value="weekly">/w</option>
                          <option value="monthly">/mo</option>
                        </select>
                        <button onClick={() => handleSaveAgentLimit(agent.agentId)} className="text-xs text-green-400 hover:text-green-300 px-1">✓</button>
                        <button onClick={() => setEditingAgentLimit(null)} className="text-xs text-gray-500 hover:text-gray-300 px-1">✕</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingAgentLimit(agent.agentId);
                          setAgentLimitValue(hasLimit ? String(agent.monthlyLimit) : '');
                          setAgentPeriodValue((agent.period || 'monthly') as Period);
                        }}
                        className={`text-[11px] tabular-nums px-2 py-0.5 rounded-md transition-colors flex-shrink-0 ${
                          hasLimit
                            ? 'text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30'
                            : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 border border-gray-800'
                        }`}
                        title="Click to edit limit"
                      >
                        {hasLimit
                          ? `$${agent.monthlyLimit.toFixed(0)}${PERIOD_SUFFIX[(agent.period || 'monthly') as Period]}`
                          : 'no cap'}
                      </button>
                    )}
                    {expandable && (
                      <button
                        type="button"
                        onClick={handleAgentAddClick}
                        className="inline-flex items-center gap-1 text-[11px] tabular-nums px-2 py-0.5 rounded-md transition-colors flex-shrink-0 text-gray-400 hover:text-indigo-200 hover:bg-indigo-500/10 border border-gray-800 hover:border-indigo-500/30"
                        title="Add a per-model override for this agent"
                      >
                        <span className="text-sm leading-none">+</span> Add limit
                      </button>
                    )}
                  </div>

                  {isExpanded && expandable && (
                    <div className="px-4 pb-4 pl-12 space-y-2">
                      <div className="flex items-center gap-2 rounded-md border border-gray-800 bg-gray-950/50 px-3 py-1.5 focus-within:border-indigo-500/60">
                        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">Model</span>
                        <input
                          id={`agent-add-${agent.agentId}`}
                          type="text"
                          placeholder="e.g. claude-opus-4-7"
                          className="bg-transparent flex-1 text-xs font-mono text-gray-100 focus:outline-none placeholder:text-gray-600"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = (e.target as HTMLInputElement).value.trim();
                              if (v) {
                                handleAddAgentModel(agent.agentId, v);
                                (e.target as HTMLInputElement).value = '';
                              }
                            }
                          }}
                        />
                        <span className="text-[10px] text-gray-600 whitespace-nowrap">press ↵ to add</span>
                      </div>
                      {models.length > 0 && (
                        <div className="rounded border border-gray-800/80 divide-y divide-gray-800">
                          {models.map((m) => {
                            const key = `${agent.agentId}::${m.model}`;
                            const isEdit = editingModelKey === key;
                            return (
                              <div key={m.id} className="px-3 py-2 flex items-center gap-3">
                                <span className="font-mono text-xs text-gray-300 flex-1 truncate">{m.model}</span>
                                {isEdit ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-500">$</span>
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={modelLimitValue}
                                      onChange={(e) => setModelLimitValue(e.target.value)}
                                      className="input text-xs w-20 py-0.5 px-1"
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSaveModelLimit(agent.agentId, m.model);
                                        if (e.key === 'Escape') setEditingModelKey(null);
                                      }}
                                    />
                                    <select
                                      value={modelPeriodValue}
                                      onChange={(e) => setModelPeriodValue(e.target.value as Period)}
                                      className="input text-[10px] py-0.5 px-1"
                                      aria-label="Period"
                                    >
                                      <option value="daily">/d</option>
                                      <option value="weekly">/w</option>
                                      <option value="monthly">/mo</option>
                                    </select>
                                    <button type="button" onClick={() => handleSaveModelLimit(agent.agentId, m.model)} className="text-xs text-green-400 hover:text-green-300">✓</button>
                                    <button type="button" onClick={() => setEditingModelKey(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingModelKey(key);
                                      setModelLimitValue(m.monthlyLimit && m.monthlyLimit > 0 ? String(m.monthlyLimit) : '');
                                      setModelPeriodValue((m.period || 'monthly') as Period);
                                    }}
                                    className={`text-[11px] tabular-nums px-2 py-0.5 rounded-md transition-colors ${
                                      m.monthlyLimit && m.monthlyLimit > 0
                                        ? 'text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30'
                                        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 border border-gray-800'
                                    }`}
                                  >
                                    {m.monthlyLimit && m.monthlyLimit > 0
                                      ? `$${m.monthlyLimit.toFixed(0)}${PERIOD_SUFFIX[(m.period || 'monthly') as Period]}`
                                      : 'Inherits agent default'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {activeSection === 'developers' && (
        <div className="divide-y divide-gray-800/80">
          {userBudgets.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              No developer activity yet — they'll appear here after their first session.
            </div>
          ) : (
            userBudgets.sort((a, b) => b.currentSpend - a.currentSpend).map((user) => {
              const p = user.monthlyLimit > 0 ? pct(user.currentSpend, user.monthlyLimit) : 0;
              const isExpanded = expandedUserId === user.userId;
              const models = userModels[user.userId] || [];
              const hasLimit = user.monthlyLimit > 0;
              const isEditing = editingUserLimit === user.userId;
              const focusUserAddInput = () => {
                setTimeout(() => {
                  const el = document.getElementById(`user-add-${user.userId}`) as HTMLInputElement | null;
                  el?.focus();
                }, 0);
              };
              const handleUserAddClick = () => {
                if (!isExpanded) toggleUserExpand(user.userId);
                focusUserAddInput();
              };
              return (
                <div key={user.userId}>
                  <div className="px-3 py-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => toggleUserExpand(user.userId)}
                      className={`text-gray-500 hover:text-gray-300 transition-transform flex-shrink-0 w-4 ${isExpanded ? 'rotate-90' : ''}`}
                      title={isExpanded ? 'Collapse' : 'Show per-model breakdown'}
                    >
                      ▸
                    </button>
                    <div className="flex items-baseline gap-2 min-w-0 flex-1">
                      <span className="text-sm font-medium text-gray-200 truncate">{user.name}</span>
                      <span className="text-[11px] text-gray-500 truncate">{user.email}</span>
                      <span className="text-[11px] text-gray-600 whitespace-nowrap">· {user.sessions} sess · ${user.currentSpend.toFixed(2)} spent</span>
                    </div>
                    {hasLimit && !isEditing && (
                      <div className="w-20 h-1.5 rounded-full bg-gray-800 overflow-hidden flex-shrink-0">
                        <div className={`h-full rounded-full transition-all ${barColor(p)}`} style={{ width: `${Math.min(p, 100)}%` }} />
                      </div>
                    )}
                    {isEditing ? (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-xs text-gray-500">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={userLimitValue}
                          onChange={(e) => setUserLimitValue(e.target.value)}
                          className="input text-xs w-20 py-0.5 px-1 tabular-nums"
                          autoFocus
                          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveUserLimit(user.userId); if (e.key === 'Escape') setEditingUserLimit(null); }}
                        />
                        <select
                          value={userPeriodValue}
                          onChange={(e) => setUserPeriodValue(e.target.value as Period)}
                          className="input text-[10px] py-0.5 px-1"
                          aria-label="Period"
                        >
                          <option value="daily">/d</option>
                          <option value="weekly">/w</option>
                          <option value="monthly">/mo</option>
                        </select>
                        <button onClick={() => handleSaveUserLimit(user.userId)} className="text-xs text-green-400 hover:text-green-300 px-1">✓</button>
                        <button onClick={() => setEditingUserLimit(null)} className="text-xs text-gray-500 hover:text-gray-300 px-1">✕</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingUserLimit(user.userId);
                          setUserLimitValue(hasLimit ? String(user.monthlyLimit) : '');
                          setUserPeriodValue((user.period || 'monthly') as Period);
                        }}
                        className={`text-[11px] tabular-nums px-2 py-0.5 rounded-md transition-colors flex-shrink-0 ${
                          hasLimit
                            ? 'text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30'
                            : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 border border-gray-800'
                        }`}
                        title="Click to edit limit"
                      >
                        {hasLimit
                          ? `$${user.monthlyLimit.toFixed(0)}${PERIOD_SUFFIX[(user.period || 'monthly') as Period]}`
                          : 'no cap'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleUserAddClick}
                      className="inline-flex items-center gap-1 text-[11px] tabular-nums px-2 py-0.5 rounded-md transition-colors flex-shrink-0 text-gray-400 hover:text-indigo-200 hover:bg-indigo-500/10 border border-gray-800 hover:border-indigo-500/30"
                      title="Add a per-model override for this engineer"
                    >
                      <span className="text-sm leading-none">+</span> Add limit
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-4 pl-12 space-y-2">
                      <div className="flex items-center gap-2 rounded-md border border-gray-800 bg-gray-950/50 px-3 py-1.5 focus-within:border-indigo-500/60">
                        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">Model</span>
                        <input
                          id={`user-add-${user.userId}`}
                          type="text"
                          placeholder="e.g. claude-opus-4-7"
                          className="bg-transparent flex-1 text-xs font-mono text-gray-100 focus:outline-none placeholder:text-gray-600"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = (e.target as HTMLInputElement).value.trim();
                              if (v) {
                                handleAddUserModel(user.userId, v);
                                (e.target as HTMLInputElement).value = '';
                              }
                            }
                          }}
                        />
                        <span className="text-[10px] text-gray-600 whitespace-nowrap">press ↵ to add</span>
                      </div>
                      {models.length > 0 && (
                        <div className="rounded border border-gray-800/80 divide-y divide-gray-800">
                          {models.map((m) => {
                            const key = `user:${user.userId}::${m.model}`;
                            const isEdit = editingModelKey === key;
                            return (
                              <div key={m.id} className="px-3 py-2 flex items-center gap-3">
                                <span className="font-mono text-xs text-gray-300 flex-1 truncate">{m.model}</span>
                                {isEdit ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-500">$</span>
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={modelLimitValue}
                                      onChange={(e) => setModelLimitValue(e.target.value)}
                                      className="input text-xs w-20 py-0.5 px-1"
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSaveUserModelLimit(user.userId, m.model);
                                        if (e.key === 'Escape') setEditingModelKey(null);
                                      }}
                                    />
                                    <select
                                      value={modelPeriodValue}
                                      onChange={(e) => setModelPeriodValue(e.target.value as Period)}
                                      className="input text-[10px] py-0.5 px-1"
                                      aria-label="Period"
                                    >
                                      <option value="daily">/d</option>
                                      <option value="weekly">/w</option>
                                      <option value="monthly">/mo</option>
                                    </select>
                                    <button type="button" onClick={() => handleSaveUserModelLimit(user.userId, m.model)} className="text-xs text-green-400 hover:text-green-300">✓</button>
                                    <button type="button" onClick={() => setEditingModelKey(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingModelKey(key);
                                      setModelLimitValue(m.monthlyLimit && m.monthlyLimit > 0 ? String(m.monthlyLimit) : '');
                                      setModelPeriodValue((m.period || 'monthly') as Period);
                                    }}
                                    className={`text-[11px] tabular-nums px-2 py-0.5 rounded-md transition-colors ${
                                      m.monthlyLimit && m.monthlyLimit > 0
                                        ? 'text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30'
                                        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 border border-gray-800'
                                    }`}
                                  >
                                    {m.monthlyLimit && m.monthlyLimit > 0
                                      ? `$${m.monthlyLimit.toFixed(0)}${PERIOD_SUFFIX[(m.period || 'monthly') as Period]}`
                                      : 'Inherits user default'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {activeSection === 'repos' && (
        <div className="divide-y divide-gray-800/80">
          {repoBudgets.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">No repositories yet.</div>
          ) : (
            repoBudgets.map((repo) => {
              const isExpanded = expandedRepoId === repo.repoId;
              const models = repoModels[repo.repoId] || [];
              const cappedCount = models.filter((m) => m.monthlyLimit && m.monthlyLimit > 0).length;
              const hasOverrides = cappedCount > 0;
              // Click "+ Add limit" → expand the row (if collapsed) and
              // immediately focus the model-name input so the user goes
              // straight from one click to typing. Without the focus jump,
              // they'd have to expand → mouse-over → click input → type.
              const focusAddInput = () => {
                setTimeout(() => {
                  const el = document.getElementById(`repo-add-${repo.repoId}`) as HTMLInputElement | null;
                  el?.focus();
                }, 0);
              };
              const handleAddClick = () => {
                if (!isExpanded) toggleRepoExpand(repo.repoId);
                focusAddInput();
              };
              const hasFlatLimit = repo.monthlyLimit > 0;
              const isEditingFlat = editingRepoFlatLimit === repo.repoId;
              const flatPct = hasFlatLimit ? pct(repo.currentSpend, repo.monthlyLimit) : 0;
              return (
                <div key={repo.repoId}>
                  <div className="px-3 py-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => toggleRepoExpand(repo.repoId)}
                      className={`text-gray-500 hover:text-gray-300 transition-transform flex-shrink-0 w-4 ${isExpanded ? 'rotate-90' : ''}`}
                      title={isExpanded ? 'Collapse' : 'Show per-model overrides'}
                    >
                      ▸
                    </button>
                    <div className="flex items-baseline gap-2 min-w-0 flex-1">
                      <span className="text-sm font-medium text-gray-200 truncate">{repo.repoName}</span>
                      <span className="text-[11px] text-gray-600 whitespace-nowrap tabular-nums">
                        · {repo.sessions} sess · ${repo.currentSpend.toFixed(2)} spent
                        {hasOverrides && ` · ${cappedCount} model cap${cappedCount !== 1 ? 's' : ''}`}
                      </span>
                    </div>
                    {hasFlatLimit && !isEditingFlat && (
                      <div className="w-20 h-1.5 rounded-full bg-gray-800 overflow-hidden flex-shrink-0">
                        <div className={`h-full rounded-full transition-all ${barColor(flatPct)}`} style={{ width: `${Math.min(flatPct, 100)}%` }} />
                      </div>
                    )}
                    {isEditingFlat ? (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-xs text-gray-500">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={repoFlatLimitValue}
                          onChange={(e) => setRepoFlatLimitValue(e.target.value)}
                          className="input text-xs w-20 py-0.5 px-1 tabular-nums"
                          autoFocus
                          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveRepoFlatLimit(repo.repoId); if (e.key === 'Escape') setEditingRepoFlatLimit(null); }}
                        />
                        <select
                          value={repoFlatPeriodValue}
                          onChange={(e) => setRepoFlatPeriodValue(e.target.value as Period)}
                          className="input text-[10px] py-0.5 px-1"
                          aria-label="Period"
                        >
                          <option value="daily">/d</option>
                          <option value="weekly">/w</option>
                          <option value="monthly">/mo</option>
                        </select>
                        <button type="button" onClick={() => handleSaveRepoFlatLimit(repo.repoId)} className="text-xs text-green-400 hover:text-green-300 px-1">✓</button>
                        <button type="button" onClick={() => setEditingRepoFlatLimit(null)} className="text-xs text-gray-500 hover:text-gray-300 px-1">✕</button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingRepoFlatLimit(repo.repoId);
                          setRepoFlatLimitValue(hasFlatLimit ? String(repo.monthlyLimit) : '');
                          setRepoFlatPeriodValue((repo.period || 'monthly') as Period);
                        }}
                        className={`text-[11px] tabular-nums px-2 py-0.5 rounded-md transition-colors flex-shrink-0 ${
                          hasFlatLimit
                            ? 'text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30'
                            : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800/60 border border-gray-800'
                        }`}
                        title="Click to set a flat dollar cap on this repo"
                      >
                        {hasFlatLimit
                          ? `$${repo.monthlyLimit.toFixed(0)}${PERIOD_SUFFIX[(repo.period || 'monthly') as Period]}`
                          : 'no cap'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleAddClick}
                      className="inline-flex items-center gap-1 text-[11px] tabular-nums px-2 py-0.5 rounded-md transition-colors flex-shrink-0 text-gray-400 hover:text-indigo-200 hover:bg-indigo-500/10 border border-gray-800 hover:border-indigo-500/30"
                      title="Add a per-model override for this repo"
                    >
                      <span className="text-sm leading-none">+</span> Add limit
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-4 pl-12 space-y-2">
                      {/* Always-visible add input — same surface whether
                          this repo has 0 or N existing model caps. Removes
                          the dead-end where users had to leave the page to
                          add a 2nd model after the 1st. */}
                      <div className="flex items-center gap-2 rounded-md border border-gray-800 bg-gray-950/50 px-3 py-1.5 focus-within:border-indigo-500/60">
                        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">Model</span>
                        <input
                          id={`repo-add-${repo.repoId}`}
                          type="text"
                          placeholder="e.g. claude-opus-4-7"
                          className="bg-transparent flex-1 text-xs font-mono text-gray-100 focus:outline-none placeholder:text-gray-600"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = (e.target as HTMLInputElement).value.trim();
                              if (v) {
                                handleAddRepoModel(repo.repoId, v);
                                (e.target as HTMLInputElement).value = '';
                              }
                            }
                          }}
                        />
                        <span className="text-[10px] text-gray-600 whitespace-nowrap">press ↵ to add</span>
                      </div>
                      {models.length > 0 && (
                        <div className="rounded border border-gray-800/80 divide-y divide-gray-800">
                          {models.map((m) => {
                            const key = `repo:${repo.repoId}::${m.model}`;
                            const isEdit = editingRepoLimit === key;
                            return (
                              <div key={m.id} className="px-3 py-2 flex items-center gap-3">
                                <span className="font-mono text-xs text-gray-300 flex-1 truncate">{m.model}</span>
                                {isEdit ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-500">$</span>
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={repoLimitValue}
                                      onChange={(e) => setRepoLimitValue(e.target.value)}
                                      className="input text-xs w-20 py-0.5 px-1"
                                      autoFocus
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSaveRepoModelLimit(repo.repoId, m.model);
                                        if (e.key === 'Escape') setEditingRepoLimit(null);
                                      }}
                                    />
                                    <select
                                      value={modelPeriodValue}
                                      onChange={(e) => setModelPeriodValue(e.target.value as Period)}
                                      className="input text-[10px] py-0.5 px-1"
                                      aria-label="Period"
                                    >
                                      <option value="daily">/d</option>
                                      <option value="weekly">/w</option>
                                      <option value="monthly">/mo</option>
                                    </select>
                                    <button type="button" onClick={() => handleSaveRepoModelLimit(repo.repoId, m.model)} className="text-xs text-green-400 hover:text-green-300">✓</button>
                                    <button type="button" onClick={() => setEditingRepoLimit(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingRepoLimit(key);
                                      setRepoLimitValue(m.monthlyLimit && m.monthlyLimit > 0 ? String(m.monthlyLimit) : '');
                                      setModelPeriodValue((m.period || 'monthly') as Period);
                                    }}
                                    className={`text-[11px] tabular-nums px-2 py-0.5 rounded-md transition-colors ${
                                      m.monthlyLimit && m.monthlyLimit > 0
                                        ? 'text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30'
                                        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 border border-gray-800'
                                    }`}
                                  >
                                    {m.monthlyLimit && m.monthlyLimit > 0
                                      ? `$${m.monthlyLimit.toFixed(0)}${PERIOD_SUFFIX[(m.period || 'monthly') as Period]}`
                                      : 'Set limit →'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
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
        <TokensTab tokenMix={tokenMix} byAgent={tokenByAgent} byModel={tokenByModel} />
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
function TokensTab({ tokenMix, byAgent, byModel }: {
  tokenMix: api.TokenBreakdownRow[];
  byAgent: api.TokenBreakdownAgentRow[];
  byModel: api.TokenBreakdownModelRow[];
}) {
  // Inner-tab state — Engineers / Agents / Models. Defaults to whichever
  // breakdown actually has rows; engineers first if all populated. Keeps
  // this view useful even when one dimension has no data yet.
  const [view, setView] = useState<'engineers' | 'agents' | 'models'>(() => {
    if (tokenMix.length > 0) return 'engineers';
    if (byAgent.length > 0) return 'agents';
    if (byModel.length > 0) return 'models';
    return 'engineers';
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

  if (tokenMix.length === 0 && byAgent.length === 0 && byModel.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-12 text-center text-sm text-gray-500">
        No token usage in the last 30 days.
        <p className="text-xs text-gray-600 mt-2">
          Sessions feed token data automatically — once activity lands, this view populates.
        </p>
      </div>
    );
  }

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
