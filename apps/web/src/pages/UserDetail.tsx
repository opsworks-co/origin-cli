import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import type { UserDetail as UserDetailType } from '../api';

function roleBadge(role: string) {
  const map: Record<string, string> = {
    OWNER: 'badge-purple',
    ADMIN: 'badge-amber',
    MEMBER: 'badge-blue',
    VIEWER: 'badge-gray',
  };
  return <span className={map[role] ?? 'badge-gray'}>{role}</span>;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    APPROVED: 'badge-green',
    REJECTED: 'badge-red',
    FLAGGED: 'badge-amber',
  };
  return <span className={map[status] ?? 'badge-gray'}>{status}</span>;
}

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

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<UserDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'sessions' | 'reviews' | 'activity'>('sessions');

  useEffect(() => {
    if (!id) return;
    api
      .getUser(id)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card text-center py-12">
        <p className="text-red-400 mb-2">Failed to load user</p>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  const { user, sessions, reviews, audit } = data;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/team" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
        &larr; Back to Team
      </Link>

      {/* Header */}
      <div className="card flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-400 text-xl font-bold flex-shrink-0">
          {user.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold truncate">{user.name}</h1>
            {roleBadge(user.role)}
          </div>
          <p className="text-sm text-gray-500">{user.email}</p>
          <p className="text-xs text-gray-600 mt-0.5">
            Member since {new Date(user.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card text-center">
          <p className="text-2xl font-bold text-gray-100">{user.stats.sessions}</p>
          <p className="text-xs text-gray-500 mt-1">Sessions</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-bold text-gray-100">{user.stats.reviews}</p>
          <p className="text-xs text-gray-500 mt-1">Reviews</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-bold text-gray-100">${user.stats.totalCost.toFixed(2)}</p>
          <p className="text-xs text-gray-500 mt-1">Total Cost</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-bold text-gray-100">
            {user.stats.linesAdded > 0 ? `+${user.stats.linesAdded.toLocaleString()}` : '0'}
          </p>
          <p className="text-xs text-gray-500 mt-1">Lines Written</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800">
        {(['sessions', 'reviews', 'activity'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              activeTab === tab
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab === 'sessions'
              ? `Sessions (${sessions.length})`
              : tab === 'reviews'
                ? `Reviews (${reviews.length})`
                : `Activity (${audit.length})`}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'sessions' && (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-6 py-3 font-medium">Repo</th>
                <th className="px-6 py-3 font-medium">Commit</th>
                <th className="px-6 py-3 font-medium text-right">Cost</th>
                <th className="px-6 py-3 font-medium text-right">Lines</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium text-right">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {sessions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                    No sessions yet
                  </td>
                </tr>
              ) : (
                sessions.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => navigate(`/sessions/${s.id}`)}
                    className="hover:bg-gray-800/30 transition-colors cursor-pointer"
                  >
                    <td className="px-6 py-3">
                      <span className="badge-blue">{s.model}</span>
                    </td>
                    <td className="px-6 py-3 text-gray-400">{s.repoName ?? '\u2014'}</td>
                    <td className="px-6 py-3 text-gray-300 max-w-[200px] truncate">
                      {s.commitMessage ?? '\u2014'}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-300">${s.costUsd.toFixed(2)}</td>
                    <td className="px-6 py-3 text-right text-gray-400">+{s.linesAdded}</td>
                    <td className="px-6 py-3">
                      {s.review ? statusBadge(s.review.status) : <span className="badge-gray">pending</span>}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-500">{timeAgo(s.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'reviews' && (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Repo</th>
                <th className="px-6 py-3 font-medium">Commit</th>
                <th className="px-6 py-3 font-medium">Note</th>
                <th className="px-6 py-3 font-medium text-right">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {reviews.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                    No reviews yet
                  </td>
                </tr>
              ) : (
                reviews.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => navigate(`/sessions/${r.sessionId}`)}
                    className="hover:bg-gray-800/30 transition-colors cursor-pointer"
                  >
                    <td className="px-6 py-3">{statusBadge(r.status)}</td>
                    <td className="px-6 py-3 text-gray-400">{r.repoName ?? '\u2014'}</td>
                    <td className="px-6 py-3 text-gray-300 max-w-[200px] truncate">
                      {r.commitMessage ?? '\u2014'}
                    </td>
                    <td className="px-6 py-3 text-gray-400 max-w-[200px] truncate">
                      {r.note ?? '\u2014'}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-500">{timeAgo(r.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Action</th>
                <th className="px-6 py-3 font-medium">Resource</th>
                <th className="px-6 py-3 font-medium text-right">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {audit.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-6 py-8 text-center text-gray-500">
                    No activity yet
                  </td>
                </tr>
              ) : (
                audit.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-6 py-3">
                      <span className="badge-blue">{a.action}</span>
                    </td>
                    <td className="px-6 py-3 text-gray-400 font-mono text-xs">
                      {a.resource ? a.resource.slice(0, 8) + '...' : '\u2014'}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-500">{timeAgo(a.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
