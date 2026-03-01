import React, { useEffect, useState, useCallback } from 'react';
import * as api from '../api';
import type { AuditEntry } from '../api';

const ACTION_COLORS: Record<string, string> = {
  'session.created': 'text-blue-400',
  'session.completed': 'text-green-400',
  'session.reviewed': 'text-indigo-400',
  'session.rejected': 'text-red-400',
  'session.flagged': 'text-amber-400',
  'agent.created': 'text-cyan-400',
  'agent.updated': 'text-cyan-300',
  'policy.created': 'text-purple-400',
  'policy.updated': 'text-purple-300',
  'policy.deleted': 'text-red-400',
  'policy.violation': 'text-red-500',
  'user.login': 'text-gray-400',
  'user.register': 'text-green-400',
  'repo.synced': 'text-blue-300',
};

function getActionColor(action: string): string {
  return ACTION_COLORS[action] ?? 'text-gray-400';
}

const LIMIT = 30;

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [offset, setOffset] = useState(0);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getAuditLogs({ action: actionFilter, limit: LIMIT, offset });
      setEntries(res.entries);
      setTotal(res.total);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [actionFilter, offset]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    setOffset(0);
  }, [actionFilter]);

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  const actionTypes = [
    'session.created',
    'session.completed',
    'session.reviewed',
    'session.rejected',
    'session.flagged',
    'agent.created',
    'agent.updated',
    'policy.created',
    'policy.updated',
    'policy.deleted',
    'policy.violation',
    'user.login',
    'user.register',
    'repo.synced',
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Audit Log</h1>
        <p className="text-sm text-gray-500 mt-1">Complete record of all actions in your organization</p>
      </div>

      {/* Filter */}
      <div className="flex flex-wrap gap-3 items-center">
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="select text-sm"
        >
          <option value="">All actions</option>
          {actionTypes.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <span className="text-sm text-gray-500 ml-auto">
          {total} entr{total !== 1 ? 'ies' : 'y'}
        </span>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      {/* Timeline */}
      <div className="card p-0">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No audit entries found</div>
        ) : (
          <div className="divide-y divide-gray-800/50">
            {entries.map((entry) => (
              <div key={entry.id} className="px-5 py-4 hover:bg-gray-800/20 transition-colors">
                <div className="flex items-start gap-3">
                  {/* Timeline dot */}
                  <div className="mt-1.5 flex-shrink-0">
                    <div className={`w-2 h-2 rounded-full ${getActionColor(entry.action).replace('text-', 'bg-')}`} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-200">
                        {entry.userName ?? 'System'}
                      </span>
                      <span className={`text-sm font-mono ${getActionColor(entry.action)}`}>
                        {entry.action}
                      </span>
                      <span className="text-sm text-gray-500">
                        {entry.resource}
                        {entry.resourceId && (
                          <span className="text-gray-600 ml-1">#{entry.resourceId.slice(0, 8)}</span>
                        )}
                      </span>
                    </div>

                    {/* Metadata preview */}
                    {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                      <div className="mt-1.5 text-xs text-gray-500 bg-gray-800/50 rounded px-2 py-1 font-mono inline-block max-w-full truncate">
                        {JSON.stringify(entry.metadata).slice(0, 120)}
                        {JSON.stringify(entry.metadata).length > 120 ? '...' : ''}
                      </div>
                    )}
                  </div>

                  {/* Timestamp */}
                  <span className="text-xs text-gray-600 flex-shrink-0 whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-800">
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
