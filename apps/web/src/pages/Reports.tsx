import React, { useEffect, useState } from 'react';
import {
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
} from 'recharts';
import * as api from '../api';
import type { ComplianceReport } from '../api';

const TT_STYLE = {
  backgroundColor: '#111827',
  border: '1px solid #374151',
  borderRadius: '0.5rem',
  color: '#f3f4f6',
  fontSize: '0.75rem',
};

function ScoreCard({ score }: { score: number }) {
  const color =
    score >= 80 ? 'text-green-400' : score >= 60 ? 'text-amber-400' : 'text-red-400';
  const bg =
    score >= 80 ? 'bg-green-900/20 border-green-800/30' : score >= 60 ? 'bg-amber-900/20 border-amber-800/30' : 'bg-red-900/20 border-red-800/30';

  return (
    <div className={`card border ${bg} text-center py-8`}>
      <p className="text-sm text-gray-400 uppercase tracking-wider mb-2">Compliance Score</p>
      <p className={`text-6xl font-bold ${color}`}>{score}</p>
      <p className="text-sm text-gray-500 mt-2">out of 100</p>
    </div>
  );
}

export default function Reports() {
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Date range
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const [fromDate, setFromDate] = useState(thirtyDaysAgo);
  const [toDate, setToDate] = useState(today);

  const setPreset = (days: number) => {
    const to = new Date();
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    setFromDate(from.toISOString().split('T')[0]);
    setToDate(to.toISOString().split('T')[0]);
  };

  const generateReport = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getComplianceReport(fromDate, toDate);
      setReport(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Auto-generate on mount
  useEffect(() => {
    generateReport();
  }, []);

  const downloadJSON = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compliance-report-${fromDate}-to-${toDate}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Compliance Reports</h1>
        <p className="text-sm text-gray-500 mt-1">
          Generate compliance reports with session activity, policy violations, and security findings.
        </p>
      </div>

      {/* Date range picker */}
      <div className="card">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="text-xs text-gray-500 block mb-1">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="input text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="input text-sm"
            />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setPreset(7)} className="btn-secondary text-xs">7 Days</button>
            <button onClick={() => setPreset(30)} className="btn-secondary text-xs">30 Days</button>
            <button onClick={() => setPreset(90)} className="btn-secondary text-xs">Quarter</button>
            <button onClick={() => setPreset(365)} className="btn-secondary text-xs">Year</button>
          </div>
          <button
            onClick={generateReport}
            disabled={loading}
            className="btn-primary text-sm"
          >
            {loading ? 'Generating...' : 'Generate Report'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card border border-red-800/30 bg-red-900/10">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {report && (
        <>
          {/* Compliance Score */}
          <div className="grid lg:grid-cols-3 gap-6">
            <ScoreCard score={report.complianceScore} />

            {/* Summary metrics */}
            <div className="lg:col-span-2 card">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Executive Summary
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-gray-500">Total Sessions</p>
                  <p className="text-2xl font-bold text-gray-200">{report.summary.totalSessions}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Total Cost</p>
                  <p className="text-2xl font-bold text-gray-200">${report.summary.totalCost.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Violations</p>
                  <p className={`text-2xl font-bold ${report.summary.totalViolations > 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {report.summary.totalViolations}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Review Rate</p>
                  <p className={`text-2xl font-bold ${report.summary.reviewRate >= 80 ? 'text-green-400' : report.summary.reviewRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                    {report.summary.reviewRate}%
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Secret Findings</p>
                  <p className={`text-2xl font-bold ${report.summary.secretFindings > 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {report.summary.secretFindings}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Charts row */}
          <div className="grid lg:grid-cols-2 gap-6">
            {/* Policy Violations */}
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Policy Violations
              </h3>
              {report.violations.length > 0 ? (
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={report.violations}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                      <XAxis
                        dataKey="type"
                        tick={{ fill: '#6b7280', fontSize: 10 }}
                        axisLine={{ stroke: '#1f2937' }}
                        tickLine={false}
                        tickFormatter={(v) => v.replace(/_/g, ' ')}
                      />
                      <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={{ stroke: '#1f2937' }} tickLine={false} />
                      <Tooltip contentStyle={TT_STYLE} />
                      <Bar dataKey="count" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-center text-gray-500 text-sm py-8">No violations in this period</p>
              )}
            </div>

            {/* Review Coverage */}
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Review Coverage
              </h3>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Reviewed', value: report.reviewCoverage.reviewed },
                        { name: 'Unreviewed', value: report.reviewCoverage.unreviewed },
                      ]}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={75}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      <Cell fill="#22c55e" />
                      <Cell fill="#6b7280" />
                    </Pie>
                    <Tooltip contentStyle={TT_STYLE} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex justify-center gap-6 text-xs text-gray-400 mt-2">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 bg-green-500 rounded-full inline-block" />
                  Reviewed ({report.reviewCoverage.reviewed})
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 bg-gray-500 rounded-full inline-block" />
                  Unreviewed ({report.reviewCoverage.unreviewed})
                </span>
              </div>
            </div>
          </div>

          {/* Security Findings + Model Usage */}
          <div className="grid lg:grid-cols-2 gap-6">
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Security Findings
              </h3>
              {report.securityFindings.length > 0 ? (
                <div className="space-y-2">
                  {report.securityFindings.map((f) => (
                    <div key={f.type} className="flex items-center justify-between text-sm">
                      <span className="text-gray-300">{f.type.replace(/_/g, ' ')}</span>
                      <span className="text-red-400 font-medium">{f.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-green-400 text-sm py-8">No secrets or PII detected</p>
              )}
            </div>

            <div className="card">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
                Model Usage
              </h3>
              {report.modelUsage.length > 0 ? (
                <div className="space-y-2">
                  {report.modelUsage.map((m) => (
                    <div key={m.model} className="flex items-center justify-between text-sm">
                      <span className="text-gray-300">{m.model}</span>
                      <span className="text-gray-400">
                        {m.sessions} sessions &middot; ${m.cost.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-gray-500 text-sm py-8">No model usage data</p>
              )}
            </div>
          </div>

          {/* Export */}
          <div className="flex justify-end">
            <button onClick={downloadJSON} className="btn-secondary text-sm">
              Download JSON
            </button>
          </div>
        </>
      )}
    </div>
  );
}
