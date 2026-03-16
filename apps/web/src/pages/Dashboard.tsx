import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';
import type { Stats, Session, Policy, Machine, IntegrationConfig } from '../api';
import KpiCard from '../components/KpiCard';
import { timeAgo, getStatusBadgeClass } from '../utils';
import {
  AreaChart, Area, PieChart, Pie, Cell,
  Tooltip, ResponsiveContainer,
} from 'recharts';

function statusBadge(status: string) {
  return <span className={getStatusBadgeClass(status)}>{status}</span>;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [activeSessions, setActiveSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [complianceScore, setComplianceScore] = useState<number | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => localStorage.getItem('origin_onboarding_dismissed') === 'true');

  useEffect(() => {
    Promise.all([
      api.getStats(),
      api.getSessions({ limit: 10 }),
      api.getMachines(),
      api.getIntegrations().catch(() => []),
      api.getPolicies().catch(() => []),
      api.getActiveSessions().catch(() => ({ sessions: [] })),
    ])
      .then(([s, sess, m, integ, pol, active]) => {
        setStats(s);
        setSessions(sess.sessions);
        setMachines(m);
        setIntegrations(integ);
        setPolicies(pol);
        setActiveSessions(active.sessions);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    api.getComplianceScore()
      .then((r) => setComplianceScore(r.score))
      .catch(() => {});

    // Poll active sessions every 10 seconds
    const interval = setInterval(() => {
      api.getActiveSessions()
        .then((r) => setActiveSessions(r.sessions))
        .catch(() => {});
    }, 10000);

    return () => clearInterval(interval);
  }, []);

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

  // ── Onboarding checklist ─────────────────────────────────────────────────
  const setupSteps = [
    {
      label: 'Connect your first repo',
      description: 'Link a GitHub repo or add a local repository to start tracking AI-authored code.',
      done: (stats.totalRepos ?? 0) > 0,
      link: '/repos',
      cta: 'Add repo',
    },
    {
      label: 'Install the CLI',
      description: 'Run origin login then origin init on your dev machine to start capturing sessions.',
      done: machines.length > 0,
      link: '/docs',
      cta: 'View setup guide',
    },
    {
      label: 'Create your first policy',
      description: 'Set governance rules to control which files AI can touch, cost limits, and required reviews.',
      done: policies.length > 0,
      link: '/policies',
      cta: 'Create policy',
    },
    {
      label: 'Invite a team member',
      description: 'Add your team so they can review AI-generated code and share governance policies.',
      done: (stats.totalUsers ?? 0) > 1,
      link: '/settings?tab=team',
      cta: 'Invite team',
    },
  ];

  const completedSteps = setupSteps.filter((s) => s.done).length;
  const allSetUp = completedSteps === setupSteps.length;

  const QUALITY_COLORS = ['#22c55e', '#ef4444', '#f59e0b', '#6b7280'];

  return (
    <div className="space-y-6">
      {/* ── Welcome Header ────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold">
          {user?.name ? `Welcome, ${user.name.split(' ')[0]}` : 'Dashboard'}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Track, review, and enforce policies on AI-authored code
          {user?.orgName ? ` at ${user.orgName}` : ''}.
        </p>
      </div>

      {/* ── Onboarding Checklist ─────────────────────────────────────────── */}
      {!allSetUp && !onboardingDismissed && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-100">Get started with Origin</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Complete these steps to set up AI code governance for your team.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">{completedSteps}/{setupSteps.length}</span>
              <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-500"
                  style={{ width: `${(completedSteps / setupSteps.length) * 100}%` }}
                />
              </div>
              <button
                onClick={() => { localStorage.setItem('origin_onboarding_dismissed', 'true'); setOnboardingDismissed(true); }}
                className="text-gray-600 hover:text-gray-400 transition-colors"
                title="Dismiss"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          </div>
          <div className="space-y-2">
            {setupSteps.map((step, i) => (
              <div
                key={i}
                className={`flex items-center gap-4 rounded-lg px-4 py-3 transition-colors ${
                  step.done
                    ? 'bg-green-900/10 border border-green-800/30'
                    : 'bg-gray-800/50 border border-gray-700/50'
                }`}
              >
                {/* Step indicator */}
                <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  step.done
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-gray-700/50 text-gray-500'
                }`}>
                  {step.done ? '\u2713' : i + 1}
                </div>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${step.done ? 'text-green-400 line-through decoration-green-700' : 'text-gray-200'}`}>
                    {step.label}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{step.description}</p>
                </div>
                {/* CTA */}
                {!step.done && (
                  <Link
                    to={step.link}
                    className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                  >
                    {step.cta}
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Action Banner (removed) ──────────────────────────────────────── */}

      {/* ── Active Sessions ──────────────────────────────────────────────── */}
      {activeSessions.length > 0 && (
        <div className="card border-purple-500/30">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-purple-500" />
              </span>
              <h2 className="text-sm font-semibold text-purple-300">
                {activeSessions.length} Active Session{activeSessions.length !== 1 ? 's' : ''}
              </h2>
            </div>
            <Link to="/sessions" className="text-xs text-purple-400 hover:text-purple-300 transition-colors">
              View all &rarr;
            </Link>
          </div>
          <div className="space-y-2">
            {activeSessions.map((s) => {
              const elapsed = s.startedAt
                ? Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000)
                : 0;
              const elapsedStr = elapsed < 60
                ? `${elapsed}s`
                : elapsed < 3600
                  ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                  : `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;

              return (
                <Link
                  key={s.id}
                  to={`/sessions/${s.id}`}
                  className="flex items-center justify-between bg-purple-500/5 hover:bg-purple-500/10 rounded-lg px-4 py-3 transition-colors border border-purple-500/10"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="badge-purple text-xs">{s.model}</span>
                    <span className="text-gray-300 text-sm truncate max-w-[300px]">
                      {s.prompt
                        ? s.prompt.split('\n')[0].slice(0, 80) + (s.prompt.length > 80 ? '...' : '')
                        : 'Session in progress...'}
                    </span>
                    {s.repoName && (
                      <span className="text-xs text-gray-600">{s.repoName}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 flex-shrink-0">
                    {s.agentName && (
                      <span className="text-xs text-gray-500">{s.agentName}</span>
                    )}
                    <span className="text-xs text-purple-400 font-mono">{elapsedStr}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Key Metrics ───────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Overview</h2>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <KpiCard
            label="Active Now"
            value={stats.activeSessions ?? activeSessions.length}
            color={stats.activeSessions > 0 ? 'purple' : undefined}
            subtext="sessions currently running"
            to="/sessions"
          />
          <KpiCard
            label="Sessions This Week"
            value={stats.sessionsThisWeek}
            subtext="AI coding sessions tracked"
            to="/sessions"
          />
          <KpiCard
            label="Est. Cost This Month"
            value={`$${stats.estimatedCostThisMonth.toFixed(2)}`}
            subtext={`across ${stats.totalSessions} total sessions`}
            to="/insights"
          />
          <KpiCard
            label="Unreviewed"
            value={stats.unreviewed}
            color={stats.unreviewed > 0 ? 'red' : 'green'}
            subtext="sessions awaiting human review"
            to="/sessions?status=pending"
          />
          <KpiCard
            label="Compliance Score"
            value={complianceScore !== null ? complianceScore : '\u2014'}
            color={complianceScore !== null ? (complianceScore >= 80 ? 'green' : complianceScore >= 60 ? undefined : 'red') : undefined}
            subtext="policy adherence rating"
            to="/reports"
          />
        </div>
      </div>

      {/* ── Activity & Cost ───────────────────────────────────────────────── */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Agent Activity */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Agent Activity</p>
              <p className="text-xs text-gray-600 mt-0.5">Sessions per day, last 14 days</p>
            </div>
            <Link to="/agents" className="text-xs text-indigo-400 hover:text-indigo-300">View agents &rarr;</Link>
          </div>
          <div className="h-24 mb-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.sessionsByDay?.slice(-14) ?? []}>
                <defs>
                  <linearGradient id="sessGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={2} fill="url(#sessGrad)" />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                  formatter={(v: number) => [v, 'Sessions']}
                  labelFormatter={(l: string) => l}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {/* Top agents inline */}
          {stats.topAgents && stats.topAgents.length > 0 && (
            <div className="space-y-1.5 border-t border-gray-800 pt-3">
              {stats.topAgents.slice(0, 3).map((a) => (
                <Link
                  key={a.id}
                  to={`/agents/${a.id}`}
                  className="flex items-center justify-between text-sm hover:bg-gray-800/30 rounded px-2 py-1 -mx-2 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-gray-300 font-medium">{a.name}</span>
                    <span className="text-xs text-gray-600">{a.model}</span>
                  </div>
                  <span className="text-xs text-gray-500">{a.count} sessions</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Cost & Model Usage */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Cost & Usage</p>
              <p className="text-xs text-gray-600 mt-0.5">Spending trend, last 14 days</p>
            </div>
            <Link to="/insights" className="text-xs text-indigo-400 hover:text-indigo-300">View insights &rarr;</Link>
          </div>
          <div className="h-24 mb-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.costByDay?.slice(-14) ?? []}>
                <defs>
                  <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="cost" stroke="#22c55e" strokeWidth={2} fill="url(#costGrad)" />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cost']}
                  labelFormatter={(l: string) => l}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {/* Model breakdown inline */}
          {stats.costByModel && stats.costByModel.length > 0 && (
            <div className="space-y-2 border-t border-gray-800 pt-3">
              {stats.costByModel.map((m) => {
                const pct = stats.totalSessions > 0 ? (m.count / stats.totalSessions) * 100 : 0;
                return (
                  <div key={m.model}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-300">{m.model}</span>
                      <span className="text-gray-500 text-xs">{m.count} sessions &middot; ${m.cost.toFixed(2)}</span>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-1.5">
                      <div className="bg-green-500/60 h-1.5 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Cost Forecast ──────────────────────────────────────────────────── */}
      {stats.projectedMonthlyCost !== undefined && stats.projectedMonthlyCost > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Cost Forecast</p>
              <p className="text-xs text-gray-600 mt-0.5">Projected end-of-month spend based on current trend</p>
            </div>
            <Link to="/models" className="text-xs text-indigo-400 hover:text-indigo-300">Model comparison &rarr;</Link>
          </div>
          <div className="flex items-center gap-6">
            <div>
              <div className="flex items-baseline gap-2">
                <p className="text-3xl font-bold text-gray-100">
                  ${stats.projectedMonthlyCost.toFixed(2)}
                </p>
                {stats.dailyCostTrend !== undefined && stats.dailyCostTrend !== 0 && (
                  <span className={`flex items-center gap-0.5 text-sm font-medium ${stats.dailyCostTrend > 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {stats.dailyCostTrend > 0 ? '↑' : '↓'}
                    {Math.abs(stats.dailyCostTrend * 100).toFixed(1)}%/day
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Projected total &middot; Day {stats.daysElapsed ?? '?'} of {stats.daysInMonth ?? '?'}
              </p>
            </div>
            <div className="flex-1 h-16">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={[
                  ...(stats.costByDay?.slice(-14) ?? []),
                  ...(stats.projectedMonthlyCost ? [
                    { date: 'Projected', cost: stats.projectedMonthlyCost / (stats.daysInMonth ?? 30) },
                  ] : []),
                ]}>
                  <defs>
                    <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="cost" stroke="#f59e0b" strokeWidth={2} fill="url(#forecastGrad)" strokeDasharray="0" />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                    formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cost']}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          {stats.projectedMonthlyCost > stats.estimatedCostThisMonth * 2 && (
            <div className="mt-3 flex items-center gap-2 text-xs bg-amber-900/20 border border-amber-800/30 rounded-lg px-3 py-2">
              <span className="text-amber-400">&#9888;</span>
              <span className="text-amber-300">Projected cost is significantly higher than current spend. Consider reviewing agent usage.</span>
            </div>
          )}
        </div>
      )}

      {/* ── AI Quality & Compliance ──────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
          AI Quality & Compliance
          <span className="text-gray-600 font-normal normal-case ml-2">Every session is scored automatically by AI</span>
        </h2>
        <div className="grid lg:grid-cols-3 gap-4">
          {/* AI Score Overview */}
          <div className="card">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">AI Quality Score</p>
            {(() => {
              const scored = sessions.filter(s => s.review?.score != null);
              const avgScore = scored.length > 0
                ? Math.round(scored.reduce((sum, s) => sum + (s.review?.score ?? 0), 0) / scored.length)
                : null;
              const autoReviewed = sessions.filter(s => s.review?.isAutoReview).length;
              return (
                <div className="flex items-center gap-5">
                  <div className="text-center">
                    <div className={`text-4xl font-bold tabular-nums ${
                      avgScore == null ? 'text-gray-500' :
                      avgScore >= 80 ? 'text-green-400' :
                      avgScore >= 50 ? 'text-amber-400' : 'text-red-400'
                    }`}>
                      {avgScore ?? '—'}
                    </div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">Avg Score</p>
                  </div>
                  <div className="flex-1 space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-gray-400">Auto-reviewed</span>
                      <span className="text-gray-300 font-medium">{autoReviewed}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-gray-400">Scored</span>
                      <span className="text-gray-300 font-medium">{scored.length}/{sessions.length}</span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Review Status Breakdown */}
          <div className="card">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Review Status</p>
            {stats.qualityMetrics && (
              <div className="flex items-center gap-6">
                <div className="w-28 h-28 flex-shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={[
                          { name: 'Approved', value: stats.qualityMetrics.approved },
                          { name: 'Rejected', value: stats.qualityMetrics.rejected },
                          { name: 'Flagged', value: stats.qualityMetrics.flagged },
                          { name: 'Pending', value: stats.qualityMetrics.pending },
                        ]}
                        innerRadius={28}
                        outerRadius={48}
                        paddingAngle={2}
                        dataKey="value"
                      >
                        {QUALITY_COLORS.map((c, i) => (
                          <Cell key={i} fill={c} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-1.5 text-sm">
                  <p className="text-gray-300"><span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-2" />{stats.qualityMetrics.approved} approved</p>
                  <p className="text-gray-300"><span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-2" />{stats.qualityMetrics.rejected} rejected</p>
                  <p className="text-gray-300"><span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-2" />{stats.qualityMetrics.flagged} flagged</p>
                  <p className="text-gray-300"><span className="inline-block w-2 h-2 rounded-full bg-gray-500 mr-2" />{stats.qualityMetrics.pending} pending</p>
                </div>
              </div>
            )}
          </div>

          {/* Policy Compliance */}
          <div className="card">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Policy Compliance</p>
            <div className="flex items-baseline gap-2">
              <p className="text-3xl font-bold text-gray-100">{stats.policyViolations}</p>
              <p className="text-sm text-gray-500">violations</p>
            </div>
            {stats.violationsByType && stats.violationsByType.length > 0 && (
              <div className="mt-3 space-y-2">
                {stats.violationsByType.map((v) => (
                  <div key={v.type} className="flex items-center justify-between text-sm">
                    <span className="text-gray-400">{v.type.replace(/_/g, ' ')}</span>
                    <span className="badge-red text-xs">{v.count}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 pt-3 border-t border-gray-800">
              <p className="text-xs text-gray-500">
                Compliance rate:{' '}
                <span className="text-green-400 font-medium">
                  {stats.totalSessions > 0
                    ? ((1 - stats.policyViolations / stats.totalSessions) * 100).toFixed(1)
                    : '100.0'}%
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Recent Sessions ───────────────────────────────────────────────── */}
      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Latest AI Coding Sessions</h2>
            <p className="text-xs text-gray-500 mt-0.5">Each row is a tracked AI coding interaction with prompt, files, cost, and review status</p>
          </div>
          <Link to="/sessions" className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
            View all &rarr;
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Agent / Model</th>
                <th className="px-6 py-3 font-medium">Repo</th>
                <th className="px-6 py-3 font-medium">Prompt</th>
                <th className="px-6 py-3 font-medium">Review</th>
                <th className="px-6 py-3 font-medium text-right">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {sessions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                    No sessions yet. Start an AI coding session with hooks enabled to see data here.
                  </td>
                </tr>
              ) : (
                sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-6 py-3">
                      <div>
                        {s.agentName && <span className="text-xs text-gray-400 block">{s.agentName}</span>}
                        <span className="badge-blue">{s.model}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3 text-gray-400">{s.repoName ?? '\u2014'}</td>
                    <td className="px-6 py-3 text-gray-300 max-w-[200px] truncate">
                      {s.prompt
                        ? s.prompt.split('\n')[0].slice(0, 60) + (s.prompt.length > 60 ? '...' : '')
                        : s.commitMessage ?? '\u2014'}
                    </td>
                    <td className="px-6 py-3">
                      {s.review?.score != null ? (
                        <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                          s.review.score >= 80 ? 'bg-green-500/20 text-green-400' :
                          s.review.score >= 50 ? 'bg-amber-500/20 text-amber-400' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {s.review.score}
                          {s.review.isAutoReview && <span className="text-[9px] opacity-60">AI</span>}
                        </span>
                      ) : statusBadge(s.review?.status?.toLowerCase() ?? 'pending')}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-500">{timeAgo(s.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Connected Infrastructure ──────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Connected Infrastructure</h2>
          <Link to="/infrastructure" className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
            View all &rarr;
          </Link>
        </div>
        <div className="card">
          <div className="flex flex-wrap items-center gap-6">
            {/* Machines */}
            <div>
              <p className="text-xs text-gray-500 mb-2">Machines</p>
              {machines.length === 0 ? (
                <p className="text-xs text-gray-600">
                  None. Run <code className="text-indigo-400 bg-gray-800 px-1 py-0.5 rounded text-xs">origin init</code> to register.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {machines.map((m) => (
                    <Link key={m.id} to={`/machines/${m.id}`} className="inline-flex items-center gap-1.5 text-xs bg-gray-800 rounded-full px-2.5 py-1 text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors">
                      <span className={`h-1.5 w-1.5 rounded-full ${(Date.now() - new Date(m.lastSeenAt).getTime()) < 1000 * 60 * 30 ? 'bg-green-500' : 'bg-gray-600'}`} />
                      {m.hostname}
                      <span className="text-gray-500">&middot; {timeAgo(m.lastSeenAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="h-8 w-px bg-gray-800 hidden sm:block" />

            {/* Integrations */}
            <div>
              <p className="text-xs text-gray-500 mb-2">Integrations</p>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-300">GitHub</span>
                  {integrations.some((i) => i.provider === 'github') ? (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400">Connected</span>
                  ) : (
                    <Link to="/settings" className="text-xs px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors">
                      Set up &rarr;
                    </Link>
                  )}
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="h-8 w-px bg-gray-800 hidden sm:block" />

            {/* Active Agents */}
            <div>
              <p className="text-xs text-gray-500 mb-2">Active Agents</p>
              <Link to="/agents" className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
                {stats.activeAgents} configured &rarr;
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
