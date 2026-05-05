import React, { useEffect, useState, useMemo } from 'react';
import * as api from '../api';
import type { ModelStats, ModelTrend } from '../api';
import { formatCost } from '../utils';
import { PageHeader } from '../components/ui';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  AreaChart, Area,
} from 'recharts';

const MODEL_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];

export default function ModelComparison() {
  const [models, setModels] = useState<ModelStats[]>([]);
  const [trend, setTrend] = useState<ModelTrend[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getModelComparison()
      .then((r) => { setModels(r.models); setTrend(r.trend); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Build stacked area data
  const trendData = useMemo(() => {
    if (!trend.length) return [];
    const modelNames = [...new Set(models.map((m) => m.model))];
    return trend.map((t) => ({
      week: t.week,
      ...Object.fromEntries(modelNames.map((m) => [m, t.models[m] || 0])),
    }));
  }, [trend, models]);

  const modelNames = useMemo(() => models.map((m) => m.model), [models]);

  // Comparison bar data
  const comparisonData = useMemo(() => [
    { metric: 'Avg Cost', ...Object.fromEntries(models.map((m) => [m.model, m.avgCost])) },
    { metric: 'Approval %', ...Object.fromEntries(models.map((m) => [m.model, m.approvalRate])) },
    { metric: 'Avg Lines', ...Object.fromEntries(models.map((m) => [m.model, m.avgLines])) },
  ], [models]);

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

  if (models.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Model Comparison" />
        <div className="card text-center py-12 text-gray-500">No session data available for model comparison.</div>
      </div>
    );
  }

  const formatDuration = (ms: number) => {
    if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Model Comparison"
        subtitle="Compare AI model performance across your sessions"
      />

      {/* Model Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {models.map((m, i) => (
          <div key={m.model} className="card" style={{ borderTopColor: MODEL_COLORS[i % MODEL_COLORS.length], borderTopWidth: 2 }}>
            <p className="text-sm font-medium text-gray-200 mb-3 truncate">{m.model}</p>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">Sessions</span>
                <span className="text-gray-200 font-medium">{m.sessions}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Avg Cost</span>
                <span className="text-gray-200">${m.avgCost.toFixed(4)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Total Cost</span>
                <span className="text-gray-200">${m.totalCost.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Avg Duration</span>
                <span className="text-gray-200">{formatDuration(m.avgDuration)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Avg Lines</span>
                <span className="text-gray-200">{Math.round(m.avgLines)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Approval Rate</span>
                <span className={m.approvalRate >= 80 ? 'text-green-400' : m.approvalRate >= 50 ? 'text-amber-400' : 'text-red-400'}>
                  {m.approvalRate.toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Comparison Table */}
      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800">
          <h2 className="font-semibold">Side-by-Side Comparison</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Metric</th>
                {models.map((m, i) => (
                  <th key={m.model} className="px-4 py-3 font-medium text-center">
                    <div className="flex items-center justify-center gap-1">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: MODEL_COLORS[i % MODEL_COLORS.length] }} />
                      <span className="truncate max-w-[100px]">{m.model.replace('claude-', '').replace('sonnet-4-20250514', 'sonnet-4').replace('opus-4-20250514', 'opus-4')}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              <tr>
                <td className="px-6 py-3 text-gray-400">Sessions</td>
                {models.map((m) => <td key={m.model} className="px-4 py-3 text-center text-gray-200">{m.sessions}</td>)}
              </tr>
              <tr>
                <td className="px-6 py-3 text-gray-400">Avg Cost / Session</td>
                {models.map((m) => <td key={m.model} className="px-4 py-3 text-center text-gray-200">${m.avgCost.toFixed(4)}</td>)}
              </tr>
              <tr>
                <td className="px-6 py-3 text-gray-400">Total Cost</td>
                {models.map((m) => <td key={m.model} className="px-4 py-3 text-center text-gray-200">${m.totalCost.toFixed(2)}</td>)}
              </tr>
              <tr>
                <td className="px-6 py-3 text-gray-400">Avg Duration</td>
                {models.map((m) => <td key={m.model} className="px-4 py-3 text-center text-gray-200">{formatDuration(m.avgDuration)}</td>)}
              </tr>
              <tr>
                <td className="px-6 py-3 text-gray-400">Avg Tokens</td>
                {models.map((m) => <td key={m.model} className="px-4 py-3 text-center text-gray-200">{Math.round(m.avgTokens).toLocaleString()}</td>)}
              </tr>
              <tr>
                <td className="px-6 py-3 text-gray-400">Avg Lines / Session</td>
                {models.map((m) => <td key={m.model} className="px-4 py-3 text-center text-gray-200">{Math.round(m.avgLines)}</td>)}
              </tr>
              <tr>
                <td className="px-6 py-3 text-gray-400">Approval Rate</td>
                {models.map((m) => (
                  <td key={m.model} className="px-4 py-3 text-center">
                    <span className={m.approvalRate >= 80 ? 'text-green-400' : m.approvalRate >= 50 ? 'text-amber-400' : 'text-red-400'}>
                      {m.approvalRate.toFixed(0)}%
                    </span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Trend Chart */}
      {trendData.length > 0 && (
        <div className="card">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-4">Model Adoption Trend (12 Weeks)</p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData}>
                <XAxis dataKey="week" tick={{ fontSize: 9, fill: '#6b7280' }} />
                <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} width={30} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                />
                <Legend wrapperStyle={{ fontSize: '0.7rem' }} />
                {modelNames.map((name, i) => (
                  <Area
                    key={name}
                    type="monotone"
                    dataKey={name}
                    stackId="1"
                    stroke={MODEL_COLORS[i % MODEL_COLORS.length]}
                    fill={MODEL_COLORS[i % MODEL_COLORS.length]}
                    fillOpacity={0.3}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
