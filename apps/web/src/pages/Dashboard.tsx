import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';
import type { Stats, Session, Policy, Machine, IntegrationConfig } from '../api';
import StatusBanner from '../components/StatusBanner';
import KpiCard from '../components/KpiCard';
import {
  AreaChart, Area, PieChart, Pie, Cell,
  Tooltip, ResponsiveContainer,
} from 'recharts';

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    approved: 'badge-green',
    rejected: 'badge-red',
    flagged: 'badge-amber',
    pending: 'badge-gray',
    completed: 'badge-blue',
    running: 'badge-purple',
  };
  return <span className={map[status] ?? 'badge-gray'}>{status}</span>;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [complianceScore, setComplianceScore] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      api.getStats(),
      api.getSessions({ limit: 10 }),
      api.getMachines(),
      api.getIntegrations().catch(() => []),
      api.getPolicies().catch(() => []),
    ])
      .then(([s, sess, m, integ, pol]) => {
        setStats(s);
        setSessions(sess.sessions);
        setMachines(m);
        setIntegrations(integ);
        setPolicies(pol);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    api.getComplianceScore()
      .then((r) => setComplianceScore(r.score))
      .catch(() => {});
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

  // ── Setup checklist ──────────────────────────────────────────────────────
  const setupSteps = [
    {
      label: 'Register machine',
      description: 'Connect a developer machine to Origin',
      done: machines.length > 0,
      link: '/docs',
    },
    {
      label: 'Connect agent',
      description: 'Set up Claude Code, Cursor, or Gemini hooks',
      done: stats.activeAgents > 0,
      link: '/agents',
    },
    {
      label: 'Track a session',
      description: 'Complete your first AI coding session',
      done: stats.totalSessions > 0,
      link: '/sessions',
    },
    {
      label: 'Create policy',
      description: 'Set governance rules for AI coding',
      done: policies.length > 0,
      link: '/policies',
    },
    {
      label: 'Connect GitHub',
      description: 'Auto-discover repos and post PR checks',
      done: integrations.some((i) => i.provider === 'github'),
      link: '/settings',
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

      {/* ── Setup Status ──────────────────────────────────────────────────── */}
      {!allSetUp ? (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-300">Getting Started</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {completedSteps} of {setupSteps.length} steps completed
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {setupSteps.map((step, i) => (
                <div
                  key={i}
                  className={`h-2 w-8 rounded-full transition-colors ${
                    step.done ? 'bg-green-500' : 'bg-gray-700'
                  }`}
                />
              ))}
            </div>
          </div>
          <div className="grid sm:grid-cols-5 gap-3">
            {setupSteps.map((step, i) => (
              <Link
                key={i}
                to={step.link}
                className={`rounded-lg px-3 py-3 text-center transition-colors ${
                  step.done
                    ? 'bg-green-900/20 border border-green-800/50'
                    : 'bg-gray-800/50 border border-gray-700/50 hover:border-indigo-600/50 hover:bg-gray-800'
                }`}
              >
                <div className="text-lg mb-1">
                  {step.done ? (
                    <span className="text-green-400">&#10003;</span>
                  ) : (
                    <span className="text-gray-600">{i + 1}</span>
                  )}
                </div>
                <p className={`text-xs font-medium ${step.done ? 'text-green-400' : 'text-gray-300'}`}>
                  {step.label}
                </p>
                <p className="text-xs text-gray-500 mt-0.5 leading-tight">{step.description}</p>
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-1 text-xs text-green-400/70">
          <span>&#10003;</span>
          <span>All systems connected and configured</span>
        </div>
      )}

      {/* ── Action Banner ─────────────────────────────────────────────────── */}
      <StatusBanner
        unreviewed={stats.unreviewed}
        policyViolations={stats.policyViolations}
      />

      {/* ── Key Metrics ───────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Overview</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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

      {/* ── Review Pipeline ───────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
          Review Pipeline
          <span className="text-gray-600 font-normal normal-case ml-2">Every AI session is tracked for human review</span>
        </h2>
        <div className="grid lg:grid-cols-2 gap-4">
          {/* Session Quality */}
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
              <p className="text-sm text-gray-500">violations detected</p>
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
                      {statusBadge(s.review?.status?.toLowerCase() ?? 'pending')}
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
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Connected Infrastructure</h2>
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
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
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
