import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import type { BudgetData, ForecastData } from '../api';
import { AlertTriangle, TrendingUp, TrendingDown, Minus, DollarSign, Users, Cpu, GitPullRequest, Shield, Calculator, Mail } from 'lucide-react';

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

  // ── ROI Calculator state ────────────────────────────────────────────────
  const [hourlyRate, setHourlyRate] = useState(() => {
    const saved = localStorage.getItem('origin_hourly_rate');
    return saved ? Number(saved) : 75;
  });

  // ── Digest state ────────────────────────────────────────────────────────
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [digestSending, setDigestSending] = useState(false);
  const [digestMsg, setDigestMsg] = useState('');

  // ── Active section tab ───────────────────────────────────────────────────
  const [activeSection, setActiveSection] = useState<'overview' | 'agents' | 'developers' | 'prs' | 'anomalies'>('overview');

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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Budget</h1>
          <p className="text-sm text-gray-500 mt-0.5">Cost controls, spending limits, and forecasting</p>
        </div>
        {budgetData && budgetData.config.monthlyLimit > 0 && (
          <div className="text-right">
            <div className="text-2xl font-bold text-gray-100">
              ${budgetData.currentSpend.monthly.toFixed(2)}
              <span className="text-gray-500 text-base font-normal"> / ${budgetData.config.monthlyLimit.toFixed(2)}</span>
            </div>
            <div className="text-xs text-gray-500">
              {budgetData.currentSpend.percentage.toFixed(0)}% used this month
            </div>
          </div>
        )}
      </div>

      {/* Top Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <DollarSign className="w-3.5 h-3.5" />
            Monthly Spend
          </div>
          <div className="text-xl font-bold text-gray-100">
            ${budgetData?.currentSpend.monthly.toFixed(2) || '0.00'}
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <TrendingUp className="w-3.5 h-3.5" />
            Projected
          </div>
          <div className={`text-xl font-bold ${forecastData?.trend === 'up' ? 'text-red-400' : forecastData?.trend === 'down' ? 'text-green-400' : 'text-gray-100'}`}>
            ${forecastData?.projectedMonthly.toFixed(2) || '0.00'}
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Cpu className="w-3.5 h-3.5" />
            Active Agents
          </div>
          <div className="text-xl font-bold text-gray-100">
            {budgetData?.currentSpend.byModel.length || 0}
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            Anomalies
          </div>
          <div className={`text-xl font-bold ${anomalies.length > 0 ? 'text-red-400' : 'text-gray-100'}`}>
            {anomalies.length}
          </div>
        </div>
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
                      localStorage.setItem('origin_hourly_rate', String(val));
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

      {/* Budget Progress Bar */}
      {budgetData && budgetData.config.monthlyLimit > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-gray-400">Budget Usage</span>
            <span className={`font-medium ${budgetData.currentSpend.percentage >= 100 ? 'text-red-400' : budgetData.currentSpend.percentage >= 80 ? 'text-amber-400' : 'text-green-400'}`}>
              {budgetData.currentSpend.percentage.toFixed(1)}%
            </span>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-4">
            <div
              className={`h-4 rounded-full transition-all ${barColor(budgetData.currentSpend.percentage)}`}
              style={{ width: `${pct(budgetData.currentSpend.monthly, budgetData.config.monthlyLimit)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-600 mt-1">
            <span>$0</span>
            <span>${budgetData.config.monthlyLimit.toFixed(0)}</span>
          </div>
        </div>
      )}

      {/* Section Tabs */}
      <div className="flex gap-1 bg-gray-900 rounded-lg p-1">
        {([
          ['overview', 'Overview'],
          ['agents', 'Per-Agent Limits'],
          ['developers', 'Per-Developer Limits'],
          ['prs', 'Cost per PR'],
          ['anomalies', `Anomalies${anomalies.length > 0 ? ` (${anomalies.length})` : ''}`],
        ] as [typeof activeSection, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveSection(key)}
            className={`flex-1 text-sm py-2 px-3 rounded-md transition-colors ${
              activeSection === key
                ? 'bg-gray-800 text-gray-100 font-medium'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* OVERVIEW TAB                                                       */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Spend breakdowns */}
          <div className="space-y-6">
            {/* By Model */}
            {budgetData && budgetData.currentSpend.byModel.length > 0 && (
              <div className="card p-4 space-y-3">
                <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-gray-500" />
                  Spend by Model
                </h3>
                <div className="space-y-2">
                  {budgetData.currentSpend.byModel
                    .sort((a, b) => b.cost - a.cost)
                    .map((m) => (
                      <div key={m.model} className="flex items-center justify-between bg-gray-800/50 rounded px-3 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="badge-blue text-xs">{m.model}</span>
                          <span className="text-gray-500">{m.sessions} sessions</span>
                        </div>
                        <span className="text-gray-200 font-medium">${m.cost.toFixed(2)}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* By User */}
            {budgetData && budgetData.currentSpend.byUser.length > 0 && (
              <div className="card p-4 space-y-3">
                <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
                  <Users className="w-4 h-4 text-gray-500" />
                  Spend by Developer
                </h3>
                <div className="space-y-2">
                  {budgetData.currentSpend.byUser
                    .sort((a, b) => b.cost - a.cost)
                    .map((u) => (
                      <div key={u.userId} className="flex items-center justify-between bg-gray-800/50 rounded px-3 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-200">{u.name}</span>
                          <span className="text-gray-500">{u.sessions} sessions</span>
                        </div>
                        <span className="text-gray-200 font-medium">${u.cost.toFixed(2)}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Daily Spend Chart */}
            {budgetData && budgetData.currentSpend.dailySpend.length > 0 && (
              <div className="card p-4 space-y-3">
                <h3 className="text-sm font-medium text-gray-300">Daily Spend (Last 30 Days)</h3>
                <div className="flex items-end gap-0.5 h-28">
                  {(() => {
                    const maxCost = Math.max(...budgetData.currentSpend.dailySpend.map(d => d.cost), 0.01);
                    return budgetData.currentSpend.dailySpend.slice(-30).map((d) => (
                      <div
                        key={d.date}
                        className="flex-1 bg-indigo-500/60 rounded-t hover:bg-indigo-400/60 transition-colors group relative"
                        style={{ height: `${(d.cost / maxCost) * 100}%`, minHeight: d.cost > 0 ? '2px' : '0' }}
                      >
                        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-xs text-gray-200 px-2 py-1 rounded hidden group-hover:block whitespace-nowrap z-10">
                          {d.date.slice(5)}: ${d.cost.toFixed(2)}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}
          </div>

          {/* Right: Forecast + Settings */}
          <div className="space-y-6">
            {/* Forecast */}
            {forecastData && (
              <div className="card p-4 space-y-4">
                <h3 className="text-sm font-medium text-gray-300 flex items-center gap-2">
                  {forecastData.trend === 'up' ? <TrendingUp className="w-4 h-4 text-red-400" /> :
                   forecastData.trend === 'down' ? <TrendingDown className="w-4 h-4 text-green-400" /> :
                   <Minus className="w-4 h-4 text-gray-400" />}
                  Cost Forecast
                </h3>
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-gray-800/50 rounded-lg p-3">
                    <div className="text-xs text-gray-500">Projected</div>
                    <div className="text-lg font-bold text-gray-100">${forecastData.projectedMonthly.toFixed(2)}</div>
                  </div>
                  <div className="bg-gray-800/50 rounded-lg p-3">
                    <div className="text-xs text-gray-500">Trend</div>
                    <div className={`text-lg font-bold ${forecastData.trend === 'up' ? 'text-red-400' : forecastData.trend === 'down' ? 'text-green-400' : 'text-gray-400'}`}>
                      {forecastData.trend === 'up' ? '↑ Up' : forecastData.trend === 'down' ? '↓ Down' : '→ Flat'}
                    </div>
                  </div>
                  <div className="bg-gray-800/50 rounded-lg p-3">
                    <div className="text-xs text-gray-500">Confidence</div>
                    <div className="text-lg font-bold text-gray-100">{Math.round(forecastData.confidence * 100)}%</div>
                  </div>
                </div>

                {/* Per-model forecast */}
                {forecastData.byModel.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs text-gray-500">By Model</h4>
                    {forecastData.byModel.map((m) => (
                      <div key={m.model} className="flex items-center justify-between text-sm">
                        <span className="text-gray-300">{m.model}</span>
                        <div className="text-gray-400">
                          <span className="text-gray-500">${m.currentMonthly.toFixed(2)} →</span>{' '}
                          <span className="text-gray-200 font-medium">${m.projectedMonthly.toFixed(2)}/mo</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Budget Settings */}
            <div className="card p-4">
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
            <div className="card p-4 space-y-4">
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
                return (
                  <div key={agent.agentId} className="p-4 flex items-center gap-4">
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
                return (
                  <div key={user.userId} className="p-4 flex items-center gap-4">
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
