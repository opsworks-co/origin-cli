import React, { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import * as api from '../api';
import type { Stats } from '../api';

const CHART_THEME = {
  grid: '#1f2937',
  text: '#6b7280',
  indigo: '#6366f1',
  purple: '#a855f7',
  cyan: '#06b6d4',
  amber: '#f59e0b',
};

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">{title}</h3>
      </div>
      <div className="p-4 h-72">{children}</div>
    </div>
  );
}

export default function Insights() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getStats()
      .then(setStats)
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
      <div>
        <h1 className="text-2xl font-bold">Insights</h1>
        <p className="text-sm text-gray-500 mt-1">Analytics across your AI coding operations</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* AI Authorship Over Time */}
        <ChartCard title="AI Authorship % Over Time">
          {stats.aiAuthorshipOverTime && stats.aiAuthorshipOverTime.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.aiAuthorshipOverTime}>
                <defs>
                  <linearGradient id="colorAi" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_THEME.indigo} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={CHART_THEME.indigo} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: CHART_THEME.text, fontSize: 11 }}
                  axisLine={{ stroke: CHART_THEME.grid }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: CHART_THEME.text, fontSize: 11 }}
                  axisLine={{ stroke: CHART_THEME.grid }}
                  tickLine={false}
                  unit="%"
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#111827',
                    border: '1px solid #374151',
                    borderRadius: '0.5rem',
                    color: '#f3f4f6',
                    fontSize: '0.75rem',
                  }}
                  formatter={(value: number) => [`${value}%`, 'AI Authored']}
                />
                <Area
                  type="monotone"
                  dataKey="percent"
                  stroke={CHART_THEME.indigo}
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorAi)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              No data available
            </div>
          )}
        </ChartCard>

        {/* Cost by Model */}
        <ChartCard title="Cost by Model">
          {stats.costByModel && stats.costByModel.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.costByModel} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: CHART_THEME.text, fontSize: 11 }}
                  axisLine={{ stroke: CHART_THEME.grid }}
                  tickLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <YAxis
                  type="category"
                  dataKey="model"
                  tick={{ fill: CHART_THEME.text, fontSize: 11 }}
                  axisLine={{ stroke: CHART_THEME.grid }}
                  tickLine={false}
                  width={140}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#111827',
                    border: '1px solid #374151',
                    borderRadius: '0.5rem',
                    color: '#f3f4f6',
                    fontSize: '0.75rem',
                  }}
                  formatter={(value: number) => [`$${value.toFixed(2)}`, 'Cost']}
                />
                <Bar dataKey="cost" fill={CHART_THEME.purple} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              No data available
            </div>
          )}
        </ChartCard>

        {/* Sessions by Repo */}
        <ChartCard title="Sessions by Repository">
          {stats.sessionsByRepo && stats.sessionsByRepo.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.sessionsByRepo}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis
                  dataKey="repo"
                  tick={{ fill: CHART_THEME.text, fontSize: 11 }}
                  axisLine={{ stroke: CHART_THEME.grid }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: CHART_THEME.text, fontSize: 11 }}
                  axisLine={{ stroke: CHART_THEME.grid }}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#111827',
                    border: '1px solid #374151',
                    borderRadius: '0.5rem',
                    color: '#f3f4f6',
                    fontSize: '0.75rem',
                  }}
                  formatter={(value: number) => [value, 'Sessions']}
                />
                <Bar dataKey="count" fill={CHART_THEME.cyan} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              No data available
            </div>
          )}
        </ChartCard>

        {/* Top Engineers by AI Usage */}
        <ChartCard title="Top Engineers by AI Usage">
          {stats.topEngineers && stats.topEngineers.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.topEngineers} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: CHART_THEME.text, fontSize: 11 }}
                  axisLine={{ stroke: CHART_THEME.grid }}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fill: CHART_THEME.text, fontSize: 11 }}
                  axisLine={{ stroke: CHART_THEME.grid }}
                  tickLine={false}
                  width={120}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#111827',
                    border: '1px solid #374151',
                    borderRadius: '0.5rem',
                    color: '#f3f4f6',
                    fontSize: '0.75rem',
                  }}
                  formatter={(value: number) => [value, 'Sessions']}
                />
                <Bar dataKey="sessions" fill={CHART_THEME.amber} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              No data available
            </div>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
