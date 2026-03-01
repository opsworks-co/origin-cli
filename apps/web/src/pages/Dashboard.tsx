import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { Stats, Session } from '../api';
import StatusBanner from '../components/StatusBanner';
import KpiCard from '../components/KpiCard';

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
  const [stats, setStats] = useState<Stats | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.getStats(), api.getSessions({ limit: 10 })])
      .then(([s, sess]) => {
        setStats(s);
        setSessions(sess.sessions);
      })
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
    return (
      <div className="card text-center py-12">
        <p className="text-red-400 mb-2">Failed to load dashboard</p>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  if (!stats) return null;

  const hoursSaved = Math.round(stats.linesWrittenThisMonth / 50);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">Governance overview for your organization</p>
      </div>

      {/* Status Banner */}
      <StatusBanner
        unreviewed={stats.unreviewed}
        policyViolations={stats.policyViolations}
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Active Agents" value={stats.activeAgents} />
        <KpiCard label="Sessions This Week" value={stats.sessionsThisWeek} />
        <KpiCard
          label="Unreviewed"
          value={stats.unreviewed}
          color={stats.unreviewed > 0 ? 'red' : 'green'}
        />
        <KpiCard
          label="Est. Cost This Month"
          value={`$${stats.estimatedCostThisMonth.toFixed(2)}`}
          subtext="across all agents"
        />
      </div>

      {/* ROI Card */}
      <div className="card bg-gradient-to-br from-gray-900 to-indigo-950/30 border-indigo-900/30">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
              Engineering ROI
            </p>
            <p className="text-gray-300 text-sm leading-relaxed">
              Your agents wrote{' '}
              <span className="text-indigo-400 font-semibold">
                {stats.linesWrittenThisMonth.toLocaleString()}
              </span>{' '}
              lines of code this month. Estimated engineering time saved:{' '}
              <span className="text-indigo-400 font-semibold">{hoursSaved} hours</span>.
            </p>
          </div>
          <div className="text-right ml-6 flex-shrink-0">
            <p className="text-3xl font-bold text-indigo-400">{hoursSaved}h</p>
            <p className="text-xs text-gray-500">saved</p>
          </div>
        </div>
      </div>

      {/* Recent Sessions */}
      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="font-semibold">Recent Sessions</h2>
          <Link to="/sessions" className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
            View all &rarr;
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-6 py-3 font-medium">Repo</th>
                <th className="px-6 py-3 font-medium">Commit</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium text-right">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {sessions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                    No sessions yet
                  </td>
                </tr>
              ) : (
                sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-6 py-3">
                      <span className="badge-blue">{s.model}</span>
                    </td>
                    <td className="px-6 py-3 text-gray-400">{s.repoName ?? '\u2014'}</td>
                    <td className="px-6 py-3 text-gray-300 max-w-[200px] truncate">
                      {s.commitMessage ?? '\u2014'}
                    </td>
                    <td className="px-6 py-3">
                      {statusBadge(s.review?.status ?? s.status)}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-500">{timeAgo(s.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
