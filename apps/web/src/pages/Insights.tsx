import React, { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
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
import type { Stats } from '../api';
import { useAuth } from '../context/AuthContext';

const CHART_THEME = {
  grid: '#1f2937',
  text: '#6b7280',
  indigo: '#6366f1',
  purple: '#a855f7',
  cyan: '#06b6d4',
  amber: '#f59e0b',
};

const TT_STYLE = {
  backgroundColor: '#111827',
  border: '1px solid #374151',
  borderRadius: '0.5rem',
  color: '#f3f4f6',
  fontSize: '0.75rem',
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
  const { user } = useAuth();
  const isDev = user?.accountType === 'developer';
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Date range filter
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const [fromDate, setFromDate] = useState(thirtyDaysAgo);
  const [toDate, setToDate] = useState(today);
  const [activePreset, setActivePreset] = useState('30d');

  const fetchStats = (from: string, to: string) => {
    setLoading(true);
    api
      .getStats(from, to)
      .then(setStats)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchStats(fromDate, toDate);
  }, []);

  const applyPreset = (days: number, label: string) => {
    const to = new Date();
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = to.toISOString().split('T')[0];
    setFromDate(fromStr);
    setToDate(toStr);
    setActivePreset(label);
    fetchStats(fromStr, toStr);
  };

  const applyCustomRange = () => {
    setActivePreset('');
    fetchStats(fromDate, toDate);
  };

  if (loading && !stats) {
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
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold">Insights</h1>
          <p className="text-sm text-gray-500 mt-1">{isDev ? 'Your personal AI coding analytics' : 'Analytics across your AI coding operations'}</p>
        </div>

        {/* Date range filter */}
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex gap-1.5">
            {[
              { label: '7d', days: 7 },
              { label: '30d', days: 30 },
              { label: '90d', days: 90 },
              { label: 'Year', days: 365 },
            ].map(({ label, days }) => (
              <button
                key={label}
                onClick={() => applyPreset(days, label)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  activePreset === label
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="input text-xs py-1"
          />
          <span className="text-gray-600 text-xs">to</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="input text-xs py-1"
          />
          <button onClick={applyCustomRange} className="btn-secondary text-xs py-1">
            Apply
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-indigo-500" />
          Updating...
        </div>
      )}

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
                <XAxis dataKey="date" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} unit="%" />
                <Tooltip contentStyle={TT_STYLE} formatter={(value: number) => [`${value}%`, 'AI Authored']} />
                <Area type="monotone" dataKey="percent" stroke={CHART_THEME.indigo} strokeWidth={2} fillOpacity={1} fill="url(#colorAi)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>

        {/* Cost by Model */}
        <ChartCard title="Cost by Model">
          {stats.costByModel && stats.costByModel.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.costByModel} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <YAxis type="category" dataKey="model" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} width={140} />
                <Tooltip contentStyle={TT_STYLE} formatter={(value: number) => [`$${value.toFixed(2)}`, 'Cost']} />
                <Bar dataKey="cost" fill={CHART_THEME.purple} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>

        {/* Cost Over Time */}
        <ChartCard title="Cost Over Time">
          {stats.costByDay && stats.costByDay.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.costByDay}>
                <defs>
                  <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_THEME.cyan} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={CHART_THEME.cyan} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis dataKey="date" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <Tooltip contentStyle={TT_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cost']} />
                <Area type="monotone" dataKey="cost" stroke={CHART_THEME.cyan} strokeWidth={2} fillOpacity={1} fill="url(#colorCost)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>

        {/* Lines Changed Over Time */}
        <ChartCard title="Lines Changed Over Time">
          {stats.linesByDay && stats.linesByDay.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.linesByDay}>
                <defs>
                  <linearGradient id="colorAdded" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorRemoved" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis dataKey="date" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <Tooltip contentStyle={TT_STYLE} />
                <Area type="monotone" dataKey="added" stroke="#22c55e" strokeWidth={2} fillOpacity={1} fill="url(#colorAdded)" name="Added" />
                <Area type="monotone" dataKey="removed" stroke="#ef4444" strokeWidth={2} fillOpacity={1} fill="url(#colorRemoved)" name="Removed" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>

        {/* Sessions by Repo */}
        <ChartCard title="Sessions by Repository">
          {stats.sessionsByRepo && stats.sessionsByRepo.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.sessionsByRepo}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis dataKey="repo" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <Tooltip contentStyle={TT_STYLE} formatter={(value: number) => [value, 'Sessions']} />
                <Bar dataKey="count" fill={CHART_THEME.cyan} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>

        {/* Cost by Repository */}
        <ChartCard title="Cost by Repository">
          {stats.costByRepo && stats.costByRepo.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.costByRepo} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <YAxis type="category" dataKey="repo" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} width={140} />
                <Tooltip contentStyle={TT_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cost']} />
                <Bar dataKey="cost" fill={CHART_THEME.indigo} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>

        {/* Top Engineers — team only */}
        {!isDev && (
        <ChartCard title="Top Engineers by AI Usage">
          {stats.topEngineers && stats.topEngineers.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.topEngineers} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} width={120} />
                <Tooltip contentStyle={TT_STYLE} formatter={(value: number) => [value, 'Sessions']} />
                <Bar dataKey="sessions" fill={CHART_THEME.amber} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>
        )}

        {/* Activity by Hour */}
        <ChartCard title="Activity by Hour of Day">
          {stats.sessionsByHour && stats.sessionsByHour.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.sessionsByHour}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis dataKey="hour" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} tickFormatter={(h) => `${h}:00`} />
                <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <Tooltip contentStyle={TT_STYLE} formatter={(v: number) => [v, 'Sessions']} labelFormatter={(h) => `${h}:00 - ${h}:59`} />
                <Bar dataKey="count" fill={CHART_THEME.purple} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>

        {/* Session Quality Distribution — team only */}
        {!isDev && (
        <ChartCard title="Session Quality Distribution">
          {stats.qualityMetrics ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={[
                    { name: 'Approved', value: stats.qualityMetrics.approved },
                    { name: 'Rejected', value: stats.qualityMetrics.rejected },
                    { name: 'Flagged', value: stats.qualityMetrics.flagged },
                    { name: 'Pending', value: stats.qualityMetrics.pending },
                  ]}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={3}
                  dataKey="value"
                >
                  <Cell fill="#22c55e" />
                  <Cell fill="#ef4444" />
                  <Cell fill={CHART_THEME.amber} />
                  <Cell fill="#6b7280" />
                </Pie>
                <Tooltip contentStyle={TT_STYLE} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>
        )}

        {/* Secret Detections by Type — team only */}
        {!isDev && (
        <ChartCard title="Secret Detections by Type">
          {stats.secretsByType && stats.secretsByType.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.secretsByType}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis dataKey="type" tick={{ fill: CHART_THEME.text, fontSize: 10 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} tickFormatter={(v) => v.replace(/_/g, ' ')} />
                <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <Tooltip contentStyle={TT_STYLE} />
                <Bar dataKey="count" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No secrets detected</div>
          )}
        </ChartCard>
        )}

        {/* Policy Violations by Type — team only */}
        {!isDev && (
        <ChartCard title="Policy Violations by Type">
          {stats.violationsByType && stats.violationsByType.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.violationsByType}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis dataKey="type" tick={{ fill: CHART_THEME.text, fontSize: 10 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} tickFormatter={(v) => v.replace(/_/g, ' ')} />
                <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <Tooltip contentStyle={TT_STYLE} />
                <Bar dataKey="count" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No violations recorded</div>
          )}
        </ChartCard>
        )}

        {/* Cost by User — team only */}
        {!isDev && (
        <ChartCard title="Cost by User">
          {stats.costByUser && stats.costByUser.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.costByUser} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <YAxis type="category" dataKey="name" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} width={140} />
                <Tooltip contentStyle={TT_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`, 'Cost']} />
                <Bar dataKey="cost" fill={CHART_THEME.indigo} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>
        )}

        {/* Tokens Over Time */}
        <ChartCard title="Tokens Used Over Time">
          {stats.tokensByDay && stats.tokensByDay.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.tokensByDay}>
                <defs>
                  <linearGradient id="colorTokens" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_THEME.purple} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={CHART_THEME.purple} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis dataKey="date" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
                <Tooltip contentStyle={TT_STYLE} formatter={(v: number) => [v.toLocaleString(), 'Tokens']} />
                <Area type="monotone" dataKey="tokens" stroke={CHART_THEME.purple} strokeWidth={2} fillOpacity={1} fill="url(#colorTokens)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>

        {/* Session Duration Distribution */}
        <ChartCard title="Session Duration Distribution">
          {stats.durationBuckets && stats.durationBuckets.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.durationBuckets}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid} />
                <XAxis dataKey="bucket" tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <YAxis tick={{ fill: CHART_THEME.text, fontSize: 11 }} axisLine={{ stroke: CHART_THEME.grid }} tickLine={false} />
                <Tooltip contentStyle={TT_STYLE} />
                <Bar dataKey="count" fill={CHART_THEME.amber} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">No data available</div>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
