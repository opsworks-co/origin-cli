import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import type { BudgetData, ForecastData } from '../api';
import { AlertTriangle, TrendingUp, TrendingDown, Minus, DollarSign, Users, Cpu, GitPullRequest, Shield, Calculator, Mail, BarChart3, FolderOpen } from 'lucide-react';

// Gradient stat card — same shape as the Dashboard StatCard so all the
// admin pages share visual language. Inlined here (not extracted to a
// shared component) because Dashboard's version is tightly coupled to
// `expandedKpi` state we don't have on this page.
function BudgetStat({
  accent, label, Icon, value, sub,
}: {
  accent: 'indigo' | 'purple' | 'cyan' | 'amber' | 'green' | 'red' | 'gray';
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  value: React.ReactNode;
  sub: React.ReactNode;
}) {
  const accentMap: Record<typeof accent, { grad: string; text: string }> = {
    indigo: { grad: 'from-indigo-500/20 to-indigo-500/0', text: 'text-indigo-300' },
    purple: { grad: 'from-purple-500/20 to-purple-500/0', text: 'text-purple-300' },
    cyan:   { grad: 'from-cyan-500/20 to-cyan-500/0',     text: 'text-cyan-300'   },
    amber:  { grad: 'from-amber-500/20 to-amber-500/0',   text: 'text-amber-300'  },
    green:  { grad: 'from-emerald-500/20 to-emerald-500/0', text: 'text-emerald-300' },
    red:    { grad: 'from-red-500/20 to-red-500/0',       text: 'text-red-300'    },
    gray:   { grad: 'from-gray-500/20 to-gray-500/0',     text: 'text-gray-400'   },
  };
  const a = accentMap[accent];
  return (
    <div className="relative rounded-xl border border-gray-800/80 bg-gray-900/40 p-4 overflow-hidden">
      <div className={`absolute inset-0 bg-gradient-to-br ${a.grad} opacity-60 pointer-events-none`} />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Icon className={`w-3 h-3 ${a.text}`} />
            {label}
          </span>
        </div>
        <div className="text-2xl font-semibold text-gray-50 tabular-nums">{value}</div>
        <div className="text-[11px] text-gray-500 mt-1 truncate">{sub}</div>
      </div>
    </div>
  );
}

// ── Types for new features ──────────────────────────────────────────────────

interface AgentBudget {
  agentId: string;
  agentName: string;
  slug: string;
  monthlyLimit: number;
  currentSpend: number;
  sessions: number;
}

interface UserBudget {
  userId: string;
  name: string;
  email: string;
  monthlyLimit: number;
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
  // ── Existing budget state ────────────────────────────────────────────────
  const [budgetData, setBudgetData] = useState<BudgetData | null>(null);
  const [forecastData, setForecastData] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(true);
  const [budgetLimit, setBudgetLimit] = useState('');
  const [budgetBlock, setBudgetBlock] = useState(false);
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
  const [userLimitValue, setUserLimitValue] = useState('');
  // Per-agent expand: lazy-load model rows + keyed inline-edit (`agentId:model`).
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [agentModels, setAgentModels] = useState<Record<string, api.AgentModel[]>>({});
  const [editingModelKey, setEditingModelKey] = useState<string | null>(null);
  const [modelLimitValue, setModelLimitValue] = useState('');
  // Per-developer expand mirrors per-agent: lazy load + edit by composite key.
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [userModels, setUserModels] = useState<Record<string, api.UserModelLimit[]>>({});
  // Per-repo limits + expand
  const [repoBudgets, setRepoBudgets] = useState<Array<{ repoId: string; repoName: string; currentSpend: number; sessions: number; monthlyLimit: number }>>([]);
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
  const [activeSection, setActiveSection] = useState<'overview' | 'agents' | 'developers' | 'repos' | 'prs' | 'anomalies'>('overview');

  // ── Fetch data ───────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [budget, forecast, agentsRes, usersRes, anomalyRes, prRes, emailSettings] = await Promise.allSettled([
        api.getBudget(),
        api.getForecast(),
        api.request<AgentBudget[]>('/api/budget/agents'),
        api.request<UserBudget[]>('/api/budget/users'),
        api.request<Anomaly[]>('/api/budget/anomalies'),
        api.request<PRCost[]>('/api/budget/pr-costs'),
        api.getEmailSettings(),
      ]);

      if (budget.status === 'fulfilled') {
        setBudgetData(budget.value);
        setBudgetLimit(budget.value.config.monthlyLimit > 0 ? String(budget.value.config.monthlyLimit) : '');
        setBudgetBlock(budget.value.config.blockOnExceed);
      }
      if (forecast.status === 'fulfilled') setForecastData(forecast.value);
      if (agentsRes.status === 'fulfilled') setAgentBudgets(agentsRes.value);
      if (usersRes.status === 'fulfilled') setUserBudgets(usersRes.value);
      if (anomalyRes.status === 'fulfilled') setAnomalies(anomalyRes.value);
      if (prRes.status === 'fulfilled') setPrCosts(prRes.value);
      if (emailSettings.status === 'fulfilled') setDigestEnabled(emailSettings.value.enabled);
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
    setSaving(true);
    setMsg('');
    try {
      const limit = parseFloat(budgetLimit) || 0;
      await api.updateBudget({ monthlyLimit: limit, blockOnExceed: budgetBlock });
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
        body: JSON.stringify({ monthlyLimit: limit }),
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
      const updated = await api.updateAgentModel(agentId, model, { monthlyLimit: value });
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
      const updated = await api.updateUserModel(userId, model, { monthlyLimit: value });
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
  // The repo list comes from the existing repos endpoint — we display limits
  // alongside, no separate spend aggregation yet (deferred — needs a backend
  // endpoint similar to /api/budget/agents but keyed by repo).
  const fetchRepoBudgets = useCallback(async () => {
    try {
      const repos = await api.getRepos();
      // Concurrent fetch of model limits per repo to surface "has limit set"
      // in the row at-a-glance. Falls back to empty list on error so the
      // section never blocks.
      setRepoBudgets(repos.map((r) => ({
        repoId: r.id,
        repoName: r.name,
        currentSpend: 0,
        sessions: 0,
        monthlyLimit: 0,
      })));
    } catch {
      setRepoBudgets([]);
    }
  }, []);
  useEffect(() => { if (activeSection === 'repos') fetchRepoBudgets(); }, [activeSection, fetchRepoBudgets]);

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
      const updated = await api.updateRepoModel(repoId, model, { monthlyLimit: value });
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
        body: JSON.stringify({ monthlyLimit: limit }),
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
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Budget</h1>
        <p className="text-sm text-gray-500 mt-1">Cost controls, spending limits, and forecasting</p>
      </div>

      {/* Hero — month spend with prominent progress bar.
          Big number, secondary projected number, segmented progress bar
          with milestone markers (50/80/100%). When no limit is set, shows
          the spend on its own with a subtle CTA to set a limit. */}
      {budgetData && (() => {
        const spent = budgetData.currentSpend.monthly;
        const limit = budgetData.config.monthlyLimit;
        const projected = forecastData?.projectedMonthly ?? 0;
        const hasLimit = limit > 0;
        const p = hasLimit ? Math.min((spent / limit) * 100, 110) : 0;
        const projP = hasLimit ? Math.min((projected / limit) * 100, 110) : 0;
        const tier = p >= 100 ? 'red' : p >= 80 ? 'amber' : 'green';
        const tierColor: Record<string, string> = {
          green: '#10b981',
          amber: '#f59e0b',
          red: '#ef4444',
        };
        const c = tierColor[tier];
        return (
          <div className="relative rounded-2xl border border-gray-800/80 bg-gradient-to-br from-indigo-500/[0.04] via-purple-500/[0.02] to-transparent p-5 overflow-hidden">
            {/* Soft radial bloom in the corner — same trick as Agents cards */}
            <div
              className="absolute -top-20 -right-20 w-64 h-64 pointer-events-none opacity-40"
              style={{ background: `radial-gradient(circle at center, ${c}22, transparent 60%)` }}
            />
            <div className="relative flex flex-col lg:flex-row lg:items-end gap-4 mb-4">
              <div>
                <p className="text-[11px] text-gray-500 uppercase tracking-[0.12em] font-semibold mb-1.5">
                  This month
                </p>
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-bold text-gray-50 tabular-nums">${spent.toFixed(2)}</span>
                  {hasLimit && (
                    <span className="text-lg text-gray-500 tabular-nums">/ ${limit.toFixed(0)}</span>
                  )}
                </div>
                {hasLimit ? (
                  <p className="text-xs mt-1">
                    <span style={{ color: c }} className="font-semibold tabular-nums">{p.toFixed(0)}%</span>
                    <span className="text-gray-500"> of monthly budget used</span>
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">No budget limit set — set one below to enable alerts.</p>
                )}
              </div>
              <div className="lg:ml-auto grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Projected</p>
                  <p className={`text-xl font-semibold tabular-nums ${forecastData?.trend === 'up' ? 'text-red-400' : forecastData?.trend === 'down' ? 'text-emerald-400' : 'text-gray-200'}`}>
                    ${projected.toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Anomalies</p>
                  <p className={`text-xl font-semibold tabular-nums ${anomalies.length > 0 ? 'text-red-400' : 'text-gray-200'}`}>
                    {anomalies.length}
                  </p>
                </div>
              </div>
            </div>

            {/* Progress bar with milestone markers + projected ghost */}
            {hasLimit && (
              <div className="relative">
                <div className="relative w-full h-2.5 bg-gray-800 rounded-full overflow-hidden">
                  {/* Projected ghost (faint) */}
                  {projected > 0 && projected !== spent && (
                    <div
                      className="absolute inset-y-0 left-0 rounded-full opacity-30"
                      style={{
                        width: `${Math.min(projP, 100)}%`,
                        background: `linear-gradient(90deg, ${c}88, ${c}aa)`,
                      }}
                    />
                  )}
                  {/* Actual spend */}
                  <div
                    className="relative h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(p, 100)}%`,
                      background: `linear-gradient(90deg, ${c}, ${c}cc)`,
                      boxShadow: `0 0 12px ${c}66`,
                    }}
                  />
                </div>
                {/* Milestone markers */}
                <div className="relative h-3 mt-1">
                  {[
                    { at: 50, label: '50%' },
                    { at: 80, label: '80%' },
                    { at: 100, label: '100%' },
                  ].map((m) => (
                    <div
                      key={m.at}
                      className="absolute -translate-x-1/2"
                      style={{ left: `${m.at}%` }}
                    >
                      <span className="text-[9px] text-gray-600 tabular-nums">{m.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* KPI strip — gradient cards matching the Dashboard treatment */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <BudgetStat
          accent="indigo"
          label="Monthly spend"
          Icon={DollarSign}
          value={`$${budgetData?.currentSpend.monthly.toFixed(2) || '0.00'}`}
          sub={budgetData?.currentSpend.byModel.length
            ? `Across ${budgetData.currentSpend.byModel.length} model${budgetData.currentSpend.byModel.length !== 1 ? 's' : ''}`
            : 'No spend yet'}
        />
        <BudgetStat
          accent={forecastData?.trend === 'up' ? 'red' : forecastData?.trend === 'down' ? 'green' : 'cyan'}
          label="Projected"
          Icon={forecastData?.trend === 'up' ? TrendingUp : forecastData?.trend === 'down' ? TrendingDown : Minus}
          value={`$${forecastData?.projectedMonthly.toFixed(2) || '0.00'}`}
          sub={`${Math.round((forecastData?.confidence ?? 0) * 100)}% confidence`}
        />
        <BudgetStat
          accent="purple"
          label="Models"
          Icon={Cpu}
          value={budgetData?.currentSpend.byModel.length || 0}
          sub={budgetData?.currentSpend.byUser.length
            ? `${budgetData.currentSpend.byUser.length} engineer${budgetData.currentSpend.byUser.length !== 1 ? 's' : ''}`
            : 'No engineers yet'}
        />
        <BudgetStat
          accent={anomalies.length > 0 ? 'red' : 'gray'}
          label="Anomalies"
          Icon={AlertTriangle}
          value={anomalies.length}
          sub={anomalies.length > 0 ? `${anomalies.length} flagged this month` : 'Nothing flagged'}
        />
      </div>

      {/* ROI Calculator */}
      {budgetData && (() => {
        const aiSpend = budgetData.currentSpend.monthly;
        const totalSessions = budgetData.currentSpend.byModel.reduce((sum, m) => sum + m.sessions, 0);
        const avgDurationMin = 8; // estimated avg session duration in minutes
        const timeSavedHours = (totalSessions * avgDurationMin * 2) / 60;
        const costSaved = timeSavedHours * hourlyRate;
        const roi = aiSpend > 0 ? costSaved / aiSpend : 0;
        const netSavings = costSaved - aiSpend;

        return (
          <div className="card p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
                <Calculator className="w-4 h-4 text-gray-500" />
                ROI Calculator
              </h3>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">Avg developer hourly rate:</label>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-gray-400">$</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={hourlyRate}
                    onChange={(e) => {
                      const val = Number(e.target.value) || 0;
                      setHourlyRate(val);
                      try { localStorage.setItem('origin_hourly_rate', String(val)); } catch { /* ignore */ }
                    }}
                    className="input text-xs w-20 py-1 px-2"
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="bg-gray-800/50 rounded-lg p-3">
                <div className="text-xs text-gray-500">AI Spend</div>
                <div className="text-lg font-bold text-gray-100">${aiSpend.toFixed(2)}</div>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Time Saved</div>
                <div className="text-lg font-bold text-gray-100">{timeSavedHours.toFixed(1)} hrs</div>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Developer Cost Saved</div>
                <div className="text-lg font-bold text-green-400">${costSaved.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <div className="text-xs text-gray-500">Net Savings</div>
                <div className={`text-lg font-bold ${netSavings >= 0 ? 'text-green-400' : 'text-red-400'}`}>${netSavings.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <div className="text-xs text-gray-500">ROI</div>
                <div className="text-lg font-bold text-indigo-400">{roi.toFixed(0)}x</div>
              </div>
            </div>
            <p className="text-xs text-gray-600">Based on {totalSessions} sessions &times; ~{avgDurationMin}min avg &times; 2x time multiplier (AI is ~3x faster). Adjust hourly rate above.</p>
          </div>
        );
      })()}

      {/* Section tabs — underlined-pill style matching Dashboard tabs. */}
      <div className="border-b border-gray-800/80 flex items-center gap-1 -mb-px overflow-x-auto">
        {([
          ['overview',   'Overview',  BarChart3],
          ['agents',     'Agents',    Cpu],
          ['developers', 'Engineers', Users],
          ['repos',      'Repos',     FolderOpen],
          ['prs',        'PRs',       GitPullRequest],
          ['anomalies',  `Anomalies${anomalies.length > 0 ? ` (${anomalies.length})` : ''}`, AlertTriangle],
        ] as [typeof activeSection, string, React.ComponentType<{ className?: string }>][]).map(([key, label, Icon]) => {
          const active = activeSection === key;
          const isAnomaly = key === 'anomalies' && anomalies.length > 0;
          return (
            <button
              key={key}
              onClick={() => setActiveSection(key)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                active
                  ? isAnomaly
                    ? 'border-red-500 text-red-300'
                    : 'border-indigo-500 text-indigo-300'
                  : `border-transparent ${isAnomaly ? 'text-red-400' : 'text-gray-500'} hover:text-gray-300`
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* OVERVIEW TAB                                                       */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* Three vertical zones, full-width:
            1. SPEND — daily chart full width, then by-model + by-engineer 2-col
            2. FORECAST strip — 3-up stat cards
            3. SETTINGS — Budget Settings + Weekly Digest 2-col
          Empty states keep cards rendered (with friendly copy) so layout
          never collapses to a half-empty page. */}
      {activeSection === 'overview' && (
        <div className="space-y-6">
          {/* ── Daily spend chart (full width) ─────────────────────────── */}
          <div className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-5">
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <h3 className="text-sm font-medium text-gray-200">Daily spend</h3>
                <p className="text-[11px] text-gray-500 mt-0.5">Last 30 days</p>
              </div>
              {budgetData && budgetData.currentSpend.dailySpend.length > 0 && (
                <div className="text-right">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Avg / day</p>
                  <p className="text-sm font-semibold text-gray-200 tabular-nums">
                    ${(budgetData.currentSpend.dailySpend.slice(-30).reduce((s, d) => s + d.cost, 0) / Math.max(budgetData.currentSpend.dailySpend.slice(-30).length, 1)).toFixed(2)}
                  </p>
                </div>
              )}
            </div>
            {budgetData && budgetData.currentSpend.dailySpend.length > 0 ? (
              <div className="flex items-end gap-1 h-32">
                {(() => {
                  const maxCost = Math.max(...budgetData.currentSpend.dailySpend.map(d => d.cost), 0.01);
                  return budgetData.currentSpend.dailySpend.slice(-30).map((d) => (
                    <div
                      key={d.date}
                      className="flex-1 rounded-t hover:opacity-100 opacity-80 transition-opacity group relative"
                      style={{
                        height: `${Math.max((d.cost / maxCost) * 100, d.cost > 0 ? 2 : 0)}%`,
                        background: d.cost > 0
                          ? 'linear-gradient(to top, rgba(99,102,241,0.3), rgba(99,102,241,0.7))'
                          : 'rgba(99,102,241,0.08)',
                        minHeight: d.cost > 0 ? '3px' : '4px',
                      }}
                    >
                      <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 border border-gray-800 text-xs text-gray-200 px-2 py-1 rounded hidden group-hover:block whitespace-nowrap z-10 shadow-xl">
                        {d.date.slice(5)}: <span className="text-indigo-300 font-medium">${d.cost.toFixed(2)}</span>
                      </div>
                    </div>
                  ));
                })()}
              </div>
            ) : (
              <div className="h-32 flex flex-col items-center justify-center text-gray-600 gap-2">
                <DollarSign className="w-6 h-6 opacity-30" />
                <p className="text-xs">No spend recorded in the last 30 days.</p>
              </div>
            )}
          </div>

          {/* ── By-model + by-engineer (2-col) ─────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-5 space-y-3">
              <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-purple-400" />
                Spend by model
              </h3>
              {budgetData && budgetData.currentSpend.byModel.length > 0 ? (
                <div className="space-y-1.5">
                  {[...budgetData.currentSpend.byModel].sort((a, b) => b.cost - a.cost).map((m) => {
                    const total = budgetData.currentSpend.byModel.reduce((s, x) => s + x.cost, 0) || 1;
                    const pct = (m.cost / total) * 100;
                    return (
                      <div key={m.model} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-200 truncate font-mono text-xs">{m.model}</span>
                          <span className="text-gray-200 tabular-nums font-medium">${m.cost.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-purple-500/70" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[10px] text-gray-500 tabular-nums w-20 text-right">
                            {m.sessions} sess · {pct.toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-8 flex flex-col items-center justify-center text-gray-600 gap-2">
                  <Cpu className="w-5 h-5 opacity-30" />
                  <p className="text-xs">No model spend yet.</p>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-5 space-y-3">
              <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2">
                <Users className="w-4 h-4 text-cyan-400" />
                Spend by engineer
              </h3>
              {budgetData && budgetData.currentSpend.byUser.length > 0 ? (
                <div className="space-y-1.5">
                  {[...budgetData.currentSpend.byUser].sort((a, b) => b.cost - a.cost).map((u) => {
                    const total = budgetData.currentSpend.byUser.reduce((s, x) => s + x.cost, 0) || 1;
                    const pct = (u.cost / total) * 100;
                    return (
                      <div key={u.userId} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-200 truncate">{u.name}</span>
                          <span className="text-gray-200 tabular-nums font-medium">${u.cost.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-cyan-500/70" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[10px] text-gray-500 tabular-nums w-20 text-right">
                            {u.sessions} sess · {pct.toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-8 flex flex-col items-center justify-center text-gray-600 gap-2">
                  <Users className="w-5 h-5 opacity-30" />
                  <p className="text-xs">No engineer spend yet.</p>
                </div>
              )}
            </div>
          </div>

          {/* ── Forecast strip (full width, 3-up) ──────────────────────── */}
          <div className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-5 space-y-4">
            <div className="flex items-baseline justify-between">
              <div>
                <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2">
                  {forecastData?.trend === 'up' ? <TrendingUp className="w-4 h-4 text-red-400" /> :
                   forecastData?.trend === 'down' ? <TrendingDown className="w-4 h-4 text-emerald-400" /> :
                   <Minus className="w-4 h-4 text-gray-500" />}
                  Cost forecast
                </h3>
                <p className="text-[11px] text-gray-500 mt-0.5">Projected month-end based on current spend rate</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">Projected</div>
                <div className="text-xl font-semibold text-gray-100 tabular-nums mt-1">
                  ${forecastData?.projectedMonthly.toFixed(2) ?? '0.00'}
                </div>
              </div>
              <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">Trend</div>
                <div className={`text-xl font-semibold mt-1 ${forecastData?.trend === 'up' ? 'text-red-400' : forecastData?.trend === 'down' ? 'text-emerald-400' : 'text-gray-300'}`}>
                  {forecastData?.trend === 'up' ? '↑ Up' : forecastData?.trend === 'down' ? '↓ Down' : '→ Flat'}
                </div>
              </div>
              <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">Confidence</div>
                <div className="text-xl font-semibold text-gray-100 tabular-nums mt-1">
                  {Math.round((forecastData?.confidence ?? 0) * 100)}%
                </div>
              </div>
            </div>

            {forecastData?.byModel && forecastData.byModel.length > 0 && (
              <div className="pt-3 border-t border-gray-800/80 space-y-1.5">
                <h4 className="text-[10px] text-gray-500 uppercase tracking-wider">Per model</h4>
                {forecastData.byModel.map((m) => (
                  <div key={m.model} className="flex items-center justify-between text-xs">
                    <span className="text-gray-300 font-mono">{m.model}</span>
                    <div className="tabular-nums">
                      <span className="text-gray-500">${m.currentMonthly.toFixed(2)}</span>
                      <span className="text-gray-600 mx-1.5">→</span>
                      <span className="text-gray-100 font-medium">${m.projectedMonthly.toFixed(2)}/mo</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Settings (Budget + Digest, 2-col) ──────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-5">
              <form onSubmit={handleSave} className="space-y-4">
                <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
                  <Shield className="w-4 h-4 text-gray-500" />
                  Budget Settings
                </h3>

                {msg && (
                  <div className={`text-sm rounded-lg p-3 ${msg.startsWith('Error') ? 'bg-red-900/20 border border-red-800 text-red-400' : 'bg-green-900/20 border border-green-800 text-green-400'}`}>
                    {msg}
                  </div>
                )}

                <div>
                  <label className="block text-sm text-gray-400 mb-1">Monthly Budget Limit (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={budgetLimit}
                    onChange={(e) => setBudgetLimit(e.target.value)}
                    className="input"
                    placeholder="0 = unlimited"
                  />
                  <p className="text-xs text-gray-600 mt-1">Set to 0 to disable budget limits</p>
                </div>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={budgetBlock}
                    onChange={(e) => setBudgetBlock(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="text-sm text-gray-200">Block new sessions when over budget</span>
                    <p className="text-xs text-gray-500">Prevents agents from starting if monthly limit is exceeded</p>
                  </div>
                </label>

                <div className="text-xs text-gray-500 bg-gray-800/50 rounded-lg p-3 space-y-1">
                  <p className="font-medium text-gray-400">Alert thresholds</p>
                  <p>Notifications at 50%, 80%, 90%, and 100% of budget limit via email and Slack.</p>
                </div>

                <button type="submit" disabled={saving} className="btn-primary text-sm">
                  {saving ? 'Saving...' : 'Save Budget Settings'}
                </button>
              </form>
            </div>

            {/* Weekly Digest Email */}
            <div className="rounded-xl border border-gray-800/80 bg-gray-900/40 p-5 space-y-4">
              <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
                <Mail className="w-4 h-4 text-gray-500" />
                Weekly Digest Email
              </h3>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={digestEnabled}
                  onChange={async (e) => {
                    const enabled = e.target.checked;
                    setDigestEnabled(enabled);
                    try {
                      await api.updateEmailSettings({ enabled });
                    } catch (err: any) {
                      setDigestEnabled(!enabled);
                      setDigestMsg(`Error: ${err.message}`);
                    }
                  }}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
                />
                <div>
                  <span className="text-sm text-gray-200">Send weekly digest email to admins</span>
                  <p className="text-xs text-gray-500">Delivers a summary every Monday at 9 AM UTC to all admin and owner users</p>
                </div>
              </label>

              {digestMsg && (
                <div className={`text-sm rounded-lg p-3 ${digestMsg.startsWith('Error') ? 'bg-red-900/20 border border-red-800 text-red-400' : 'bg-green-900/20 border border-green-800 text-green-400'}`}>
                  {digestMsg}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    setDigestSending(true);
                    setDigestMsg('');
                    try {
                      const res = await api.sendDigest();
                      setDigestMsg(res.success ? 'Digest sent successfully' : `Error: ${res.error || 'Unknown error'}`);
                    } catch (err: any) {
                      setDigestMsg(`Error: ${err.message}`);
                    } finally {
                      setDigestSending(false);
                    }
                  }}
                  disabled={digestSending}
                  className="btn-secondary text-sm"
                >
                  {digestSending ? 'Sending...' : 'Send test digest now'}
                </button>
                <a
                  href="/api/settings/digest-preview"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary text-sm inline-flex items-center"
                >
                  Preview
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* PER-AGENT LIMITS TAB                                              */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'agents' && (
        <div className="card">
          <div className="p-4 border-b border-gray-800">
            <h3 className="text-sm font-medium text-gray-300">Per-Agent Monthly Budgets</h3>
            <p className="text-xs text-gray-500 mt-1">Set individual spending caps per agent. Sessions are blocked when an agent exceeds its limit.</p>
          </div>
          <div className="divide-y divide-gray-800">
            {agentBudgets.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">
                No agents found. Agent budgets will appear here once agents start sessions.
              </div>
            ) : (
              agentBudgets.sort((a, b) => b.currentSpend - a.currentSpend).map((agent) => {
                const p = agent.monthlyLimit > 0 ? pct(agent.currentSpend, agent.monthlyLimit) : 0;
                const isExpanded = expandedAgentId === agent.agentId;
                const models = agentModels[agent.agentId] || [];
                // Skip the synthetic "Other" bucket — it has no real Agent row
                // backing it, so no AgentModel rows exist for it.
                const expandable = agent.agentId !== '__other__';
                return (
                  <div key={agent.agentId}>
                    <div className="p-4 flex items-center gap-4">
                      {expandable && (
                        <button
                          type="button"
                          onClick={() => toggleAgentExpand(agent.agentId)}
                          className={`text-gray-500 hover:text-gray-300 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                          title={isExpanded ? 'Collapse' : 'Show per-model breakdown'}
                        >
                          ▸
                        </button>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-gray-200">{agent.agentName}</span>
                          <span className="text-xs text-gray-500">{agent.slug}</span>
                          <span className="text-xs text-gray-500">• {agent.sessions} sessions</span>
                        </div>
                        {agent.monthlyLimit > 0 && (
                          <div className="w-full bg-gray-800 rounded-full h-2 mt-1">
                            <div className={`h-2 rounded-full transition-all ${barColor(p)}`} style={{ width: `${p}%` }} />
                          </div>
                        )}
                      </div>
                      <div className="text-right min-w-[120px]">
                        <div className="text-sm font-medium text-gray-200">${agent.currentSpend.toFixed(2)}</div>
                        {editingAgentLimit === agent.agentId ? (
                          <div className="flex items-center gap-1 mt-1">
                            <span className="text-xs text-gray-500">$</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={agentLimitValue}
                              onChange={(e) => setAgentLimitValue(e.target.value)}
                              className="input text-xs w-20 py-0.5 px-1"
                              autoFocus
                              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAgentLimit(agent.agentId); if (e.key === 'Escape') setEditingAgentLimit(null); }}
                            />
                            <button onClick={() => handleSaveAgentLimit(agent.agentId)} className="text-xs text-green-400 hover:text-green-300">✓</button>
                            <button onClick={() => setEditingAgentLimit(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setEditingAgentLimit(agent.agentId); setAgentLimitValue(agent.monthlyLimit > 0 ? String(agent.monthlyLimit) : ''); }}
                            className="text-xs text-gray-500 hover:text-gray-300 mt-0.5"
                          >
                            {agent.monthlyLimit > 0 ? `limit: $${agent.monthlyLimit.toFixed(0)}/mo` : 'Set limit →'}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Per-model expand body */}
                    {isExpanded && expandable && (
                      <div className="px-4 pb-4 pl-12">
                        {models.length === 0 ? (
                          <p className="text-xs text-gray-600 py-2">
                            No model overrides. Add one on the agent's detail page.
                          </p>
                        ) : (
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
                                      <button onClick={() => handleSaveModelLimit(agent.agentId, m.model)} className="text-xs text-green-400 hover:text-green-300">✓</button>
                                      <button onClick={() => setEditingModelKey(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => {
                                        setEditingModelKey(key);
                                        setModelLimitValue(m.monthlyLimit && m.monthlyLimit > 0 ? String(m.monthlyLimit) : '');
                                      }}
                                      className="text-xs text-gray-500 hover:text-gray-300"
                                    >
                                      {m.monthlyLimit && m.monthlyLimit > 0
                                        ? `limit: $${m.monthlyLimit.toFixed(0)}/mo`
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
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* PER-DEVELOPER LIMITS TAB                                          */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'developers' && (
        <div className="card">
          <div className="p-4 border-b border-gray-800">
            <h3 className="text-sm font-medium text-gray-300">Per-Developer Monthly Budgets</h3>
            <p className="text-xs text-gray-500 mt-1">Cap individual developer spending. Manager gets alerted when a developer exceeds their limit.</p>
          </div>
          <div className="divide-y divide-gray-800">
            {userBudgets.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">
                No developer activity found this month.
              </div>
            ) : (
              userBudgets.sort((a, b) => b.currentSpend - a.currentSpend).map((user) => {
                const p = user.monthlyLimit > 0 ? pct(user.currentSpend, user.monthlyLimit) : 0;
                const isExpanded = expandedUserId === user.userId;
                const models = userModels[user.userId] || [];
                return (
                  <div key={user.userId}>
                    <div className="p-4 flex items-center gap-4">
                      <button
                        type="button"
                        onClick={() => toggleUserExpand(user.userId)}
                        className={`text-gray-500 hover:text-gray-300 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                        title={isExpanded ? 'Collapse' : 'Show per-model breakdown'}
                      >
                        ▸
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-gray-200">{user.name}</span>
                          <span className="text-xs text-gray-500">{user.email}</span>
                          <span className="text-xs text-gray-500">• {user.sessions} sessions</span>
                        </div>
                        {user.monthlyLimit > 0 && (
                          <div className="w-full bg-gray-800 rounded-full h-2 mt-1">
                            <div className={`h-2 rounded-full transition-all ${barColor(p)}`} style={{ width: `${p}%` }} />
                          </div>
                        )}
                      </div>
                      <div className="text-right min-w-[120px]">
                        <div className="text-sm font-medium text-gray-200">${user.currentSpend.toFixed(2)}</div>
                        {editingUserLimit === user.userId ? (
                          <div className="flex items-center gap-1 mt-1">
                            <span className="text-xs text-gray-500">$</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={userLimitValue}
                              onChange={(e) => setUserLimitValue(e.target.value)}
                              className="input text-xs w-20 py-0.5 px-1"
                              autoFocus
                              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveUserLimit(user.userId); if (e.key === 'Escape') setEditingUserLimit(null); }}
                            />
                            <button onClick={() => handleSaveUserLimit(user.userId)} className="text-xs text-green-400 hover:text-green-300">✓</button>
                            <button onClick={() => setEditingUserLimit(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setEditingUserLimit(user.userId); setUserLimitValue(user.monthlyLimit > 0 ? String(user.monthlyLimit) : ''); }}
                            className="text-xs text-gray-500 hover:text-gray-300 mt-0.5"
                          >
                            {user.monthlyLimit > 0 ? `limit: $${user.monthlyLimit.toFixed(0)}/mo` : 'Set limit →'}
                          </button>
                        )}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="px-4 pb-4 pl-12">
                        {models.length === 0 ? (
                          <p className="text-xs text-gray-600 py-2">
                            No per-model overrides for this developer.
                          </p>
                        ) : (
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
                                      <button onClick={() => handleSaveUserModelLimit(user.userId, m.model)} className="text-xs text-green-400 hover:text-green-300">✓</button>
                                      <button onClick={() => setEditingModelKey(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => {
                                        setEditingModelKey(key);
                                        setModelLimitValue(m.monthlyLimit && m.monthlyLimit > 0 ? String(m.monthlyLimit) : '');
                                      }}
                                      className="text-xs text-gray-500 hover:text-gray-300"
                                    >
                                      {m.monthlyLimit && m.monthlyLimit > 0
                                        ? `limit: $${m.monthlyLimit.toFixed(0)}/mo`
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
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* PER-REPO LIMITS TAB                                               */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'repos' && (
        <div className="card">
          <div className="p-4 border-b border-gray-800">
            <h3 className="text-sm font-medium text-gray-300">Per-Repository Model Budgets</h3>
            <p className="text-xs text-gray-500 mt-1">Cap spend on a specific model inside a single repo. Useful when one project has different cost discipline than the rest.</p>
          </div>
          <div className="divide-y divide-gray-800">
            {repoBudgets.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">No repositories yet.</div>
            ) : (
              repoBudgets.map((repo) => {
                const isExpanded = expandedRepoId === repo.repoId;
                const models = repoModels[repo.repoId] || [];
                return (
                  <div key={repo.repoId}>
                    <div className="p-4 flex items-center gap-4">
                      <button
                        type="button"
                        onClick={() => toggleRepoExpand(repo.repoId)}
                        className={`text-gray-500 hover:text-gray-300 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                        title={isExpanded ? 'Collapse' : 'Show per-model limits'}
                      >
                        ▸
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-200 truncate">{repo.repoName}</span>
                          <span className="text-xs text-gray-500">
                            {models.length > 0 ? `${models.length} model${models.length !== 1 ? 's' : ''} configured` : 'No model overrides'}
                          </span>
                        </div>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="px-4 pb-4 pl-12">
                        {models.length === 0 ? (
                          <div className="flex items-center gap-2 py-2">
                            <p className="text-xs text-gray-600 flex-1">No model limits set for this repo yet.</p>
                            <input
                              type="text"
                              placeholder="e.g. claude-opus-4-7"
                              className="input text-xs px-2 py-1 w-44"
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
                          </div>
                        ) : (
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
                                      <button onClick={() => handleSaveRepoModelLimit(repo.repoId, m.model)} className="text-xs text-green-400 hover:text-green-300">✓</button>
                                      <button onClick={() => setEditingRepoLimit(null)} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => {
                                        setEditingRepoLimit(key);
                                        setRepoLimitValue(m.monthlyLimit && m.monthlyLimit > 0 ? String(m.monthlyLimit) : '');
                                      }}
                                      className="text-xs text-gray-500 hover:text-gray-300"
                                    >
                                      {m.monthlyLimit && m.monthlyLimit > 0
                                        ? `limit: $${m.monthlyLimit.toFixed(0)}/mo`
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
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* COST PER PR TAB                                                   */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'prs' && (
        <div className="card">
          <div className="p-4 border-b border-gray-800">
            <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
              <GitPullRequest className="w-4 h-4 text-gray-500" />
              Cost per Pull Request
            </h3>
            <p className="text-xs text-gray-500 mt-1">AI session cost attributed to each PR. Track ROI per feature.</p>
          </div>
          <div className="divide-y divide-gray-800">
            {prCosts.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">
                No PR cost data yet. Costs are attributed when sessions are linked to branches with open PRs.
              </div>
            ) : (
              prCosts.sort((a, b) => b.totalCost - a.totalCost).map((pr) => (
                <div key={`${pr.repo}-${pr.prNumber}`} className="p-4 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-gray-200">#{pr.prNumber}</span>
                      <span className="text-sm text-gray-300 truncate">{pr.title}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <span>{pr.repo}</span>
                      <span>•</span>
                      <span>{pr.branch}</span>
                      <span>•</span>
                      <span>{pr.sessions} AI sessions</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-gray-200">${pr.totalCost.toFixed(2)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ANOMALIES TAB                                                     */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'anomalies' && (
        <div className="card">
          <div className="p-4 border-b border-gray-800">
            <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              Anomaly Detection
            </h3>
            <p className="text-xs text-gray-500 mt-1">Sessions with unusually high costs compared to your average. Review for runaway agents or misconfiguration.</p>
          </div>
          <div className="divide-y divide-gray-800">
            {anomalies.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">
                No cost anomalies detected. Sessions exceeding 10x your average cost will appear here.
              </div>
            ) : (
              anomalies.sort((a, b) => b.multiplier - a.multiplier).map((a) => (
                <div key={a.sessionId} className="p-4 flex items-center gap-4">
                  <div className="flex-shrink-0">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
                      a.multiplier >= 50 ? 'bg-red-500/20 text-red-400' :
                      a.multiplier >= 20 ? 'bg-amber-500/20 text-amber-400' :
                      'bg-yellow-500/20 text-yellow-400'
                    }`}>
                      {a.multiplier.toFixed(0)}x
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-gray-200">${a.cost.toFixed(2)}</span>
                      <span className="text-xs text-gray-500">avg: ${a.avgCost.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <span className="badge-blue text-xs">{a.model}</span>
                      <span>{a.user}</span>
                      <span>•</span>
                      <span>{a.sessionId.slice(0, 8)}</span>
                      <span>•</span>
                      <span>{new Date(a.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <a
                    href={`/sessions?id=${a.sessionId}`}
                    className="text-xs text-indigo-400 hover:text-indigo-300"
                  >
                    Review →
                  </a>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
