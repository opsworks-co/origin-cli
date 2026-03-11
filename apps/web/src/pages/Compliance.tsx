import React, { useEffect, useState } from 'react';
import * as api from '../api';
import type { ComplianceReport, Stats } from '../api';
import ScoreGauge from '../components/ScoreGauge';
import KpiCard from '../components/KpiCard';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

export default function Compliance() {
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    api.getComplianceReport(from, to)
      .then(setReport)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error) {
    return <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>;
  }

  if (!report) return null;

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compliance-report-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const agingData = report.unreviewedAging ? [
    { label: '< 1 day', value: report.unreviewedAging.lessThan1d, color: '#22c55e' },
    { label: '1-3 days', value: report.unreviewedAging.from1to3d, color: '#f59e0b' },
    { label: '3-7 days', value: report.unreviewedAging.from3to7d, color: '#f97316' },
    { label: '7+ days', value: report.unreviewedAging.moreThan7d, color: '#ef4444' },
  ] : [];

  const violationTrend = report.complianceTrend || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Compliance Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            AI governance compliance overview &middot; Last 90 days
          </p>
        </div>
        <button onClick={handleExport} className="btn-secondary text-xs">
          Export JSON
        </button>
      </div>

      {/* Score + KPIs */}
      <div className="grid lg:grid-cols-5 gap-4 items-start">
        <div className="lg:col-span-1 card flex justify-center py-6">
          <ScoreGauge score={report.complianceScore} label="Compliance Score" size={140} />
        </div>
        <div className="lg:col-span-4 grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Total Sessions"
            value={report.summary.totalSessions}
            subtext="in reporting period"
          />
          <KpiCard
            label="Review Rate"
            value={`${report.summary.reviewRate.toFixed(0)}%`}
            color={report.summary.reviewRate >= 80 ? 'green' : report.summary.reviewRate >= 50 ? 'amber' : 'red'}
            subtext={`${report.reviewCoverage.reviewed} reviewed`}
          />
          <KpiCard
            label="Violations"
            value={report.summary.totalViolations}
            color={report.summary.totalViolations === 0 ? 'green' : 'red'}
            subtext="policy violations"
          />
          <KpiCard
            label="Secret Findings"
            value={report.summary.secretFindings}
            color={report.summary.secretFindings === 0 ? 'green' : 'amber'}
            subtext="secrets/PII detected"
          />
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Session Activity */}
        <div className="card">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Session Activity</p>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={report.sessionActivity}>
                <defs>
                  <linearGradient id="actGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#6b7280' }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} width={30} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                />
                <Area type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={2} fill="url(#actGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Unreviewed Aging */}
        <div className="card">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Unreviewed Session Aging</p>
          {agingData.length > 0 ? (
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={agingData}>
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} width={30} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                    formatter={(v: number) => [v, 'Sessions']}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {agingData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-sm text-gray-500 py-8 text-center">No aging data available</p>
          )}
        </div>
      </div>

      {/* Compliance Trend */}
      {violationTrend.length > 0 && (
        <div className="card">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Weekly Compliance Score Trend</p>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={violationTrend}>
                <defs>
                  <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="week" tick={{ fontSize: 9, fill: '#6b7280' }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#6b7280' }} width={30} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                  formatter={(v: number) => [v, 'Score']}
                />
                <Area type="monotone" dataKey="score" stroke="#22c55e" strokeWidth={2} fill="url(#trendGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Bottom Row */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Violations by Type */}
        <div className="card">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Violations by Type</p>
          {report.violations.length === 0 ? (
            <p className="text-sm text-green-400 py-4 text-center">No violations detected</p>
          ) : (
            <div className="space-y-2">
              {report.violations.map((v) => (
                <div key={v.type} className="flex items-center justify-between text-sm">
                  <span className="text-gray-400">{v.type.replace(/_/g, ' ')}</span>
                  <span className="badge-red text-xs">{v.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Policy Coverage */}
        {report.policyCoverage && report.policyCoverage.length > 0 && (
          <div className="card">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Policy Coverage</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-800">
                    <th className="pb-2 pr-3">Repository</th>
                    <th className="pb-2 text-center">Policies Applied</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {report.policyCoverage.map((r) => (
                    <tr key={r.repoId}>
                      <td className="py-2 pr-3 text-gray-300">{r.repo}</td>
                      <td className="py-2 text-center">
                        {r.policies.length === 0 ? (
                          <span className="text-red-400">None</span>
                        ) : (
                          <div className="flex flex-wrap gap-1 justify-center">
                            {r.policies.map((p) => (
                              <span key={p} className="badge-green text-xs">{p.replace(/_/g, ' ')}</span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Model Usage */}
        <div className="card">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Model Usage</p>
          <div className="space-y-2">
            {report.modelUsage.map((m) => (
              <div key={m.model} className="flex items-center justify-between text-sm">
                <span className="text-gray-300">{m.model}</span>
                <div className="text-xs text-gray-500">
                  {m.sessions} sessions &middot; ${m.cost.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
