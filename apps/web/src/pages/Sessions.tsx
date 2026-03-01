import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { Session, Repo } from '../api';

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

const LIMIT = 20;

export default function Sessions() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  // Filters
  const [model, setModel] = useState('');
  const [status, setStatus] = useState('');
  const [repoId, setRepoId] = useState('');
  const [offset, setOffset] = useState(0);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    setSelectedIds(new Set());
    try {
      const res = await api.getSessions({ model, status, repoId, limit: LIMIT, offset });
      setSessions(res.sessions);
      setTotal(res.total);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [model, status, repoId, offset]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    api.getRepos().then(setRepos).catch(() => {});
  }, []);

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0);
  }, [model, status, repoId]);

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  const models = Array.from(new Set(sessions.map((s) => s.model).filter(Boolean)));

  // Sessions eligible for bulk review (no existing review / pending)
  const pendingSessions = sessions.filter(
    (s) => !s.review?.status || s.review.status.toLowerCase() === 'pending'
  );

  const allPendingSelected =
    pendingSessions.length > 0 && pendingSessions.every((s) => selectedIds.has(s.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allPendingSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingSessions.map((s) => s.id)));
    }
  };

  const handleBulkReview = async (reviewStatus: string) => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      await api.bulkReviewSessions(Array.from(selectedIds), reviewStatus);
      setSelectedIds(new Set());
      fetchSessions();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBulkLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sessions</h1>
        <p className="text-sm text-gray-500 mt-1">All AI coding sessions across your organization</p>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap gap-3">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="select text-sm"
        >
          <option value="">All models</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="claude-sonnet-4-20250514">claude-sonnet-4-20250514</option>
          <option value="gpt-4o">gpt-4o</option>
          <option value="claude-3-5-sonnet">claude-3-5-sonnet</option>
        </select>

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="select text-sm"
        >
          <option value="">All statuses</option>
          <option value="unreviewed">Unreviewed</option>
          <option value="reviewed">Reviewed</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="flagged">Flagged</option>
        </select>

        <select
          value={repoId}
          onChange={(e) => setRepoId(e.target.value)}
          className="select text-sm"
        >
          <option value="">All repos</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        <div className="ml-auto text-sm text-gray-500 self-center">
          {total} session{total !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-indigo-900/30 border border-indigo-700 px-4 py-3">
          <span className="text-sm text-indigo-300 font-medium">
            {selectedIds.size} session{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={() => handleBulkReview('approved')}
              disabled={bulkLoading}
              className="btn-primary text-xs py-1.5 px-3 bg-green-700 hover:bg-green-600"
            >
              {bulkLoading ? 'Processing...' : 'Approve Selected'}
            </button>
            <button
              onClick={() => handleBulkReview('rejected')}
              disabled={bulkLoading}
              className="btn-primary text-xs py-1.5 px-3 bg-red-700 hover:bg-red-600"
            >
              {bulkLoading ? 'Processing...' : 'Reject Selected'}
            </button>
            <button
              onClick={() => handleBulkReview('flagged')}
              disabled={bulkLoading}
              className="btn-primary text-xs py-1.5 px-3 bg-amber-700 hover:bg-amber-600"
            >
              {bulkLoading ? 'Processing...' : 'Flag Selected'}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-3 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allPendingSelected}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
                    title="Select all pending sessions"
                  />
                </th>
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-6 py-3 font-medium">Repo</th>
                <th className="px-6 py-3 font-medium">Commit</th>
                <th className="px-6 py-3 font-medium">Author</th>
                <th className="px-6 py-3 font-medium text-right">Files</th>
                <th className="px-6 py-3 font-medium text-right">Tokens</th>
                <th className="px-6 py-3 font-medium text-right">Cost</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium text-right">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-6 py-12 text-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500 mx-auto" />
                  </td>
                </tr>
              ) : sessions.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-6 py-12 text-center text-gray-500">
                    No sessions found
                  </td>
                </tr>
              ) : (
                sessions.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => navigate(`/sessions/${s.id}`)}
                    className="hover:bg-gray-800/30 transition-colors cursor-pointer"
                  >
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      {(!s.review?.status || s.review.status.toLowerCase() === 'pending') ? (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(s.id)}
                          onChange={() => toggleSelect(s.id)}
                          className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
                        />
                      ) : (
                        <span className="block w-4" />
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <span className="badge-blue">{s.model}</span>
                    </td>
                    <td className="px-6 py-3 text-gray-400">{s.repoName ?? '\u2014'}</td>
                    <td className="px-6 py-3 text-gray-300 max-w-[200px] truncate">
                      {s.commitMessage ?? '\u2014'}
                    </td>
                    <td className="px-6 py-3 text-gray-400">{s.commitAuthor ?? '\u2014'}</td>
                    <td className="px-6 py-3 text-right text-gray-400">
                      {(() => { try { return JSON.parse(s.filesChanged).length; } catch { return 0; } })()}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-400">
                      {(s.tokensUsed / 1000).toFixed(1)}k
                    </td>
                    <td className="px-6 py-3 text-right text-gray-300">
                      ${s.costUsd.toFixed(2)}
                    </td>
                    <td className="px-6 py-3">
                      {statusBadge(s.review?.status?.toLowerCase() ?? 'pending')}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-500">
                      {timeAgo(s.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-gray-800">
            <button
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              disabled={offset === 0}
              className="btn-secondary text-sm py-1.5 px-3"
            >
              Previous
            </button>
            <span className="text-sm text-gray-500">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setOffset(offset + LIMIT)}
              disabled={currentPage >= totalPages}
              className="btn-secondary text-sm py-1.5 px-3"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
