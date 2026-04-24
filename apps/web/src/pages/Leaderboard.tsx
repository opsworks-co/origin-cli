import React, { useEffect, useState, useMemo } from 'react';
import * as api from '../api';
import type { LeaderboardEntry } from '../api';
import ActivityHeatmap from '../components/ActivityHeatmap';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { PageHeader, EmptyState, DataTable } from '../components/ui';
import type { DataTableColumn } from '../components/ui';

type Period = 'week' | 'month' | 'quarter' | 'all';
type SortField = 'sessions' | 'lines' | 'cost' | 'quality';

type LeaderboardRow = LeaderboardEntry & { _rank: number };

const leaderboardColumns: DataTableColumn<LeaderboardRow>[] = [
  {
    key: 'rank',
    label: '#',
    width: '40px',
    className: 'font-mono',
    render: (e) => <span className="text-gray-600 font-mono">{e._rank}</span>,
  },
  {
    key: 'developer',
    label: 'Developer',
    render: (e) => (
      <>
        <p className="text-gray-200 font-medium">{e.name}</p>
        <p className="text-xs text-gray-600">{e.email}</p>
      </>
    ),
  },
  {
    key: 'sessions',
    label: 'Sessions',
    align: 'right',
    render: (e) => e.sessions,
  },
  {
    key: 'lines',
    label: 'Lines',
    align: 'right',
    render: (e) => e.lines.toLocaleString(),
  },
  {
    key: 'cost',
    label: 'Cost',
    align: 'right',
    render: (e) => `$${e.cost.toFixed(2)}`,
  },
  {
    key: 'approval',
    label: 'Approval',
    align: 'right',
    render: (e) => e.approvalRate > 0 ? (
      <span className={e.approvalRate >= 80 ? 'text-green-400' : e.approvalRate >= 50 ? 'text-amber-400' : 'text-red-400'}>
        {e.approvalRate.toFixed(0)}%
      </span>
    ) : (
      <span className="text-gray-600">—</span>
    ),
  },
  {
    key: 'quality',
    label: 'Quality',
    align: 'right',
    render: (e) => (
      <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold ${
        e.qualityScore >= 80 ? 'bg-green-500/20 text-green-400'
        : e.qualityScore >= 50 ? 'bg-amber-500/20 text-amber-400'
        : 'bg-red-500/20 text-red-400'
      }`}>
        {Math.round(e.qualityScore)}
      </span>
    ),
  },
];

export default function Leaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<Period>('month');
  const [sortBy, setSortBy] = useState<SortField>('sessions');
  const [selectedUser, setSelectedUser] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.getLeaderboard({ period, sortBy })
      .then((r) => {
        setEntries(r.entries);
        if (r.entries.length > 0 && !selectedUser) setSelectedUser(r.entries[0].userId);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [period, sortBy]);

  const selectedEntry = useMemo(
    () => entries.find((e) => e.userId === selectedUser),
    [entries, selectedUser],
  );

  const chartData = useMemo(
    () => entries.slice(0, 8).map((e) => ({
      name: (e.name || 'Unknown').split(' ')[0],
      value: sortBy === 'sessions' ? e.sessions
        : sortBy === 'lines' ? e.lines
        : sortBy === 'cost' ? e.cost
        : e.qualityScore,
    })),
    [entries, sortBy],
  );

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

  const periods: { value: Period; label: string }[] = [
    { value: 'week', label: 'This Week' },
    { value: 'month', label: 'This Month' },
    { value: 'quarter', label: 'Quarter' },
    { value: 'all', label: 'All Time' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Developer Leaderboard"
        subtitle="Track AI coding activity and quality across your team"
        actions={
          <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-1">
            {periods.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  period === p.value ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      />

      {entries.length === 0 ? (
        <div className="card p-0">
          <EmptyState
            title="No activity data"
            description="No activity data for the selected period. Sessions need to be linked to users."
          />
        </div>
      ) : (
        <>
          {/* Activity Heatmap */}
          {selectedEntry && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm font-medium text-gray-300">{selectedEntry.name}</p>
                  <p className="text-xs text-gray-500">{selectedEntry.email}</p>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span>{selectedEntry.sessions ?? 0} sessions</span>
                  <span>{(selectedEntry.lines ?? 0).toLocaleString()} lines</span>
                  <span>${(selectedEntry.cost ?? 0).toFixed(2)} cost</span>
                  <span className={`font-medium ${(selectedEntry.qualityScore ?? 0) >= 80 ? 'text-green-400' : (selectedEntry.qualityScore ?? 0) >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                    Quality: {selectedEntry.qualityScore ?? 0}
                  </span>
                </div>
              </div>
              <ActivityHeatmap data={selectedEntry.activityGrid} />
            </div>
          )}

          <div className="grid lg:grid-cols-3 gap-4">
            {/* Rankings Table */}
            <div className="lg:col-span-2 card p-0 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
                <h2 className="font-semibold">Rankings</h2>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortField)}
                  className="select text-xs py-1"
                >
                  <option value="sessions">By Sessions</option>
                  <option value="lines">By Lines Written</option>
                  <option value="cost">By Cost</option>
                  <option value="quality">By Quality Score</option>
                </select>
              </div>
              <DataTable<LeaderboardRow>
                data={entries.map((e, i) => ({ ...e, _rank: i + 1 }))}
                columns={leaderboardColumns}
                rowKey={(e) => e.userId}
                onRowClick={(e) => setSelectedUser(e.userId)}
                rowClassName={(e) => selectedUser === e.userId ? 'bg-indigo-600/10' : ''}
                className="rounded-none border-0 bg-transparent"
              />
            </div>

            {/* Bar Chart */}
            <div className="card">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-4">
                Top by {sortBy === 'quality' ? 'Quality Score' : sortBy.charAt(0).toUpperCase() + sortBy.slice(1)}
              </p>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical">
                    <XAxis type="number" tick={{ fontSize: 10, fill: '#6b7280' }} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#9ca3af' }} width={60} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '0.5rem', color: '#f3f4f6', fontSize: '0.75rem' }}
                      formatter={(v: number) => [
                        sortBy === 'cost' ? `$${v.toFixed(2)}` : v.toLocaleString(),
                        sortBy.charAt(0).toUpperCase() + sortBy.slice(1),
                      ]}
                    />
                    <Bar dataKey="value" fill="#6366f1" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
