import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { Session, Repo, Agent, PRSessionGroup, SessionStreamEvent, TeamMember } from '../api';
import { timeAgo, formatCost, formatDuration, getStatusBadgeClass } from '../utils';
import { Archive, ArchiveRestore, GitBranch } from 'lucide-react';
import { useToast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';

function statusBadge(status: string) {
  return <span className={getStatusBadgeClass(status)}>{status}</span>;
}

type SortField = 'model' | 'cost' | 'tokens' | 'duration' | 'toolCalls' | 'date' | 'score';
type SortDir = 'asc' | 'desc';
type ViewMode = 'list' | 'by-pr';

const LIMIT = 20;

export default function Sessions() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const isDev = user?.accountType === 'developer';
  const [sessions, setSessions] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [aggregates, setAggregates] = useState<any>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  // View mode
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [prGroups, setPrGroups] = useState<PRSessionGroup[]>([]);
  const [prLoading, setPrLoading] = useState(false);

  // Live streaming
  const [liveConnected, setLiveConnected] = useState(false);
  const [liveEvents, setLiveEvents] = useState<number>(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  // Agents
  const [agents, setAgents] = useState<Agent[]>([]);

  // Users
  const [users, setUsers] = useState<TeamMember[]>([]);

  // Filters
  const [model, setModel] = useState('');
  const [status, setStatus] = useState('');
  const [repoId, setRepoId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [userId, setUserId] = useState('');
  const [branch, setBranch] = useState('');
  const [offset, setOffset] = useState(0);

  // Sorting
  const [sortBy, setSortBy] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    setSelectedIds(new Set());
    try {
      const res = await api.getSessions({ model, status, repoId, agentId, userId, branch, archived: showArchived ? 'true' : undefined, limit: LIMIT, offset });
      setSessions(res.sessions);
      setTotal(res.total);
      if (res.aggregates) setAggregates(res.aggregates);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [model, status, repoId, agentId, userId, branch, offset, showArchived]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    api.getRepos().then(setRepos).catch(() => {});
    api.getAgents().then(setAgents).catch(() => {});
    api.getUsers().then((res) => setUsers(res.users)).catch(() => {});
  }, []);

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0);
  }, [model, status, repoId, agentId, userId, branch]);

  // Fetch PR groups when view mode changes
  useEffect(() => {
    if (viewMode === 'by-pr') {
      setPrLoading(true);
      api
        .getSessionsByPR()
        .then((res) => setPrGroups(res.groups))
        .catch((err) => setError(err.message))
        .finally(() => setPrLoading(false));
    }
  }, [viewMode]);

  // SSE live stream
  useEffect(() => {
    const es = api.createSessionStream((event: SessionStreamEvent) => {
      if (event.type === 'connected') {
        setLiveConnected(true);
      } else {
        setLiveEvents((prev) => prev + 1);
        // Auto-refresh sessions list on new events
        if (event.type === 'session:started' || event.type === 'session:ended') {
          fetchSessions();
        }
      }
    });

    eventSourceRef.current = es;

    es.onerror = () => {
      setLiveConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [fetchSessions]);

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  const models = Array.from(new Set(sessions.map((s) => s.model).filter(Boolean)));
  const branches = Array.from(new Set(sessions.map((s) => s.branch).filter(Boolean))) as string[];

  // Analytics summary from API aggregates (across ALL matching sessions, not just current page)
  const analytics = useMemo(() => {
    if (!aggregates && sessions.length === 0) return null;
    if (aggregates) {
      return {
        totalCost: aggregates.totalCost || 0,
        totalTokens: aggregates.totalTokens || 0,
        avgCost: aggregates.avgCost || 0,
        avgDuration: aggregates.avgDuration || 0,
        totalTools: aggregates.totalTools || 0,
        avgScore: aggregates.avgScore,
        flaggedCount: aggregates.flaggedCount || 0,
      };
    }
    // Fallback to page-level calculation if API doesn't return aggregates
    const totalCost = sessions.reduce((sum, s) => sum + s.costUsd, 0);
    const totalTokens = sessions.reduce((sum, s) => sum + s.tokensUsed, 0);
    const totalDuration = sessions.reduce((sum, s) => sum + s.durationMs, 0);
    const totalTools = sessions.reduce((sum, s) => sum + s.toolCalls, 0);
    const flaggedCount = sessions.filter(
      (s) => s.review?.status?.toLowerCase() === 'flagged' || s.review?.status?.toLowerCase() === 'rejected'
    ).length;
    const scoredSessions = sessions.filter((s) => s.review?.score != null);
    const avgScore = scoredSessions.length > 0
      ? Math.round(scoredSessions.reduce((sum, s) => sum + (s.review?.score ?? 0), 0) / scoredSessions.length)
      : null;
    return {
      totalCost,
      totalTokens,
      avgCost: sessions.length > 0 ? totalCost / sessions.length : 0,
      avgDuration: sessions.length > 0 ? totalDuration / sessions.length : 0,
      totalTools,
      avgScore,
      flaggedCount,
    };
  }, [aggregates, sessions]);

  // Sessions eligible for bulk review (no existing review / pending)
  const allSelected =
    sessions.length > 0 && sessions.every((s) => selectedIds.has(s.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sessions.map((s) => s.id)));
    }
  };

  const handleBulkArchive = async () => {
    if (selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      await api.bulkArchiveSessions(Array.from(selectedIds), !showArchived);
      toast('success', showArchived ? 'Sessions restored' : 'Sessions archived');
      setSelectedIds(new Set());
      fetchSessions();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setBulkLoading(false);
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

  const toggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir(field === 'date' ? 'desc' : 'asc');
    }
  };

  const sortedSessions = useMemo(() => {
    const list = [...sessions];
    list.sort((a, b) => {
      // RUNNING sessions always float to the top
      const aRunning = a.status === 'RUNNING' ? 1 : 0;
      const bRunning = b.status === 'RUNNING' ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;

      let cmp = 0;
      switch (sortBy) {
        case 'cost':
          cmp = a.costUsd - b.costUsd;
          break;
        case 'tokens':
          cmp = a.tokensUsed - b.tokensUsed;
          break;
        case 'duration':
          cmp = a.durationMs - b.durationMs;
          break;
        case 'toolCalls':
          cmp = a.toolCalls - b.toolCalls;
          break;
        case 'model':
          cmp = a.model.localeCompare(b.model);
          break;
        case 'score':
          cmp = (a.review?.score ?? -1) - (b.review?.score ?? -1);
          break;
        case 'date':
        default:
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [sessions, sortBy, sortDir]);

  const SortHeader = ({
    field,
    children,
    align,
  }: {
    field: SortField;
    children: React.ReactNode;
    align?: 'right';
  }) => (
    <th
      className={`px-6 py-3 font-medium cursor-pointer hover:text-gray-300 select-none ${
        align === 'right' ? 'text-right' : ''
      }`}
      onClick={() => toggleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortBy === field && (
          <span className="text-indigo-400">{sortDir === 'asc' ? '↑' : '↓'}</span>
        )}
      </span>
    </th>
  );

  const prStatusBadge = (reviewStatus: string) => {
    const map: Record<string, { cls: string; label: string }> = {
      all_approved: { cls: 'badge-green', label: 'All Approved' },
      has_rejections: { cls: 'badge-red', label: 'Has Rejections' },
      has_flags: { cls: 'badge-amber', label: 'Has Flags' },
      pending: { cls: 'badge-gray', label: 'Pending Review' },
    };
    const info = map[reviewStatus] ?? map.pending;
    return <span className={info.cls}>{info.label}</span>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Sessions</h1>
          <p className="text-sm text-gray-500 mt-1">
            All AI coding sessions across your organization
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Live indicator */}
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                liveConnected ? 'bg-green-500 animate-pulse' : 'bg-gray-600'
              }`}
            />
            <span className={liveConnected ? 'text-green-400' : 'text-gray-500'}>
              {liveConnected ? 'Live' : 'Connecting...'}
            </span>
            {liveEvents > 0 && (
              <span className="text-gray-600">({liveEvents} events)</span>
            )}
          </div>

          {/* View mode toggle — team only (PR grouping) */}
          {!isDev && (
          <div className="flex rounded-lg border border-gray-700 overflow-hidden">
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'list'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              List
            </button>
            <button
              onClick={() => setViewMode('by-pr')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'by-pr'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              By PR
            </button>
          </div>
          )}

          {/* Archive toggle */}
          <button
            onClick={() => setShowArchived(!showArchived)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              showArchived
                ? 'bg-amber-600/20 text-amber-400 border border-amber-700/50'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700'
            }`}
          >
            {showArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
            {showArchived ? 'Archived' : 'Archive'}
          </button>
        </div>
      </div>

      {/* Analytics Summary Bar */}
      {viewMode === 'list' && analytics && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <div className="card py-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Total Cost</p>
            <p className="text-lg font-semibold text-gray-200 mt-0.5">
              ${analytics.totalCost.toFixed(2)}
            </p>
          </div>
          <div className="card py-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Avg Cost</p>
            <p className="text-lg font-semibold text-gray-200 mt-0.5">
              ${analytics.avgCost.toFixed(2)}
            </p>
          </div>
          <div className="card py-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Tokens</p>
            <p className="text-lg font-semibold text-gray-200 mt-0.5">
              {(analytics.totalTokens / 1000).toFixed(1)}k
            </p>
          </div>
          <div className="card py-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Avg Duration</p>
            <p className="text-lg font-semibold text-gray-200 mt-0.5">
              {formatDuration(analytics.avgDuration)}
            </p>
          </div>
          <div className="card py-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Tool Calls</p>
            <p className="text-lg font-semibold text-gray-200 mt-0.5">{analytics.totalTools}</p>
          </div>
          {!isDev && (
          <div className="card py-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Avg Score</p>
            <p className={`text-lg font-semibold mt-0.5 ${
              analytics.avgScore == null ? 'text-gray-500' :
              analytics.avgScore >= 80 ? 'text-green-400' :
              analytics.avgScore >= 50 ? 'text-amber-400' : 'text-red-400'
            }`}>
              {analytics.avgScore ?? '—'}
            </p>
          </div>
          )}
          {!isDev && (
          <div className="card py-3 px-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Flagged</p>
            <p className={`text-lg font-semibold mt-0.5 ${analytics.flaggedCount > 0 ? 'text-red-400' : 'text-green-400'}`}>
              {analytics.flaggedCount}
            </p>
          </div>
          )}
        </div>
      )}

      {/* Filter Bar - only in list view */}
      {viewMode === 'list' && (
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

          {!isDev && (
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
          )}

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

          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="select text-sm"
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          {!isDev && (
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="select text-sm"
          >
            <option value="">All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          )}

          <select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="select text-sm"
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>

          <div className="ml-auto text-sm text-gray-500 self-center">
            {total} session{total !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      {/* Bulk Action Bar */}
      {viewMode === 'list' && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-indigo-900/30 border border-indigo-700 px-4 py-3">
          <span className="text-sm text-indigo-300 font-medium">
            {selectedIds.size} session{selectedIds.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex gap-2 ml-auto">
            {!isDev && (
            <>
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
            </>
            )}
            <button
              onClick={handleBulkArchive}
              disabled={bulkLoading}
              className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
            >
              {showArchived ? <ArchiveRestore className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
              {bulkLoading ? 'Processing...' : showArchived ? 'Restore' : 'Archive'}
            </button>
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/* PR-Grouped View */}
      {/* ================================================================== */}
      {viewMode === 'by-pr' && (
        <div className="space-y-4">
          {prLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
            </div>
          ) : prGroups.length === 0 ? (
            <div className="card text-center py-12 text-gray-500">
              <p>No pull requests with sessions found</p>
              <p className="text-xs mt-1">Sessions will appear here once linked to PRs via commit SHAs</p>
            </div>
          ) : (
            prGroups.map((group) => (
              <div key={group.pr.id} className="card p-0 overflow-hidden">
                {/* PR Header */}
                <div className="px-5 py-4 border-b border-gray-800 bg-gray-900/50">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <a
                          href={group.pr.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
                        >
                          #{group.pr.number}
                        </a>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            group.pr.state === 'merged'
                              ? 'bg-purple-500/20 text-purple-400'
                              : group.pr.state === 'open'
                                ? 'bg-green-500/20 text-green-400'
                                : 'bg-gray-700 text-gray-400'
                          }`}
                        >
                          {group.pr.state}
                        </span>
                        {group.pr.checkStatus && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              group.pr.checkStatus === 'success'
                                ? 'bg-green-500/20 text-green-400'
                                : group.pr.checkStatus === 'failure'
                                  ? 'bg-red-500/20 text-red-400'
                                  : 'bg-amber-500/20 text-amber-400'
                            }`}
                          >
                            {group.pr.checkStatus}
                          </span>
                        )}
                        {prStatusBadge(group.stats.reviewStatus)}
                      </div>
                      <p className="text-gray-200 mt-1 text-sm">{group.pr.title}</p>
                      <p className="text-gray-500 text-xs mt-0.5">
                        {group.pr.headBranch} &rarr; {group.pr.baseBranch} &middot;{' '}
                        {group.pr.repoName} &middot; by {group.pr.author}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0 space-y-1">
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-gray-400">
                          {group.stats.sessionCount} session
                          {group.stats.sessionCount !== 1 ? 's' : ''}
                        </span>
                        <span className="text-gray-300 font-medium">
                          ${group.stats.totalCost.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-green-400">+{group.stats.totalLinesAdded}</span>
                        <span className="text-red-400">-{group.stats.totalLinesRemoved}</span>
                        <span className="text-gray-500">
                          {(group.stats.totalTokens / 1000).toFixed(1)}k tokens
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sessions under this PR */}
                <div className="divide-y divide-gray-800/50">
                  {group.sessions.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => navigate(`/sessions/${s.id}`)}
                      className="flex items-center gap-4 px-5 py-3 hover:bg-gray-800/30 transition-colors cursor-pointer"
                    >
                      <span className="badge-blue text-xs">{s.model}</span>
                      <span className="text-gray-300 text-sm truncate flex-1 max-w-[250px]">
                        {s.commitMessage || s.prompt?.slice(0, 80) || '—'}
                      </span>
                      <span className="text-gray-500 text-xs tabular-nums">
                        {formatDuration(s.durationMs)}
                      </span>
                      <span className="text-gray-400 text-xs tabular-nums">
                        {formatCost(s.costUsd)}
                      </span>
                      {s.review?.score != null ? (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          s.review.score >= 80 ? 'bg-green-500/20 text-green-400' :
                          s.review.score >= 50 ? 'bg-amber-500/20 text-amber-400' :
                          'bg-red-500/20 text-red-400'
                        }`}>{s.review.score}</span>
                      ) : statusBadge(s.review?.status?.toLowerCase() ?? (s.status === 'RUNNING' ? 'running' : 'ended'))}
                      <span className="text-gray-600 text-xs">{timeAgo(s.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ================================================================== */}
      {/* List View (default) */}
      {/* ================================================================== */}
      {viewMode === 'list' && (
        <div className="card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-gray-500 uppercase tracking-wider border-b border-white/[0.06]">
                  <th className="px-3 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
                      title="Select all pending sessions"
                    />
                  </th>
                  <SortHeader field="model">Model</SortHeader>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Agent</th>
                  {!isDev && <th className="px-6 py-3 font-medium">User</th>}
                  <th className="px-6 py-3 font-medium">Repo</th>
                  <th className="px-6 py-3 font-medium">Branch</th>
                  <SortHeader field="duration" align="right">
                    Duration
                  </SortHeader>
                  <SortHeader field="tokens" align="right">
                    Tokens
                  </SortHeader>
                  <SortHeader field="cost" align="right">
                    Cost
                  </SortHeader>
                  {!isDev && <SortHeader field="score">Score</SortHeader>}
                  <SortHeader field="date" align="right">
                    Age
                  </SortHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {loading ? (
                  <tr>
                    <td colSpan={13} className="px-6 py-12 text-center">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500 mx-auto" />
                    </td>
                  </tr>
                ) : sortedSessions.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="px-6 py-12 text-center text-gray-500">
                      No sessions found
                    </td>
                  </tr>
                ) : (
                  sortedSessions.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => navigate(`/sessions/${s.id}`)}
                      className="hover:bg-white/[0.02] transition-colors duration-100 cursor-pointer"
                    >
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(s.id)}
                          onChange={() => toggleSelect(s.id)}
                          className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-6 py-3">
                        <span className="badge-blue">{s.model}</span>
                      </td>
                      <td className="px-6 py-3">
                        {s.status === 'RUNNING' ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-400">
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
                            </span>
                            running
                          </span>
                        ) : s.status === 'ERROR' ? (
                          <span className="text-xs font-medium text-red-400">error</span>
                        ) : (
                          <span className="text-xs text-gray-500">ended</span>
                        )}
                      </td>
                      <td className="px-6 py-3 text-gray-400 text-xs">
                        {s.agentName ?? <span className="text-gray-600">—</span>}
                        {s.agentVersion && <span className="text-gray-600 ml-1">v{s.agentVersion}</span>}
                      </td>
                      {!isDev && (
                      <td className="px-6 py-3 text-gray-400 text-xs">
                        {s.userName || s.commitAuthor ||
                          <span className="text-gray-600">—</span>}
                      </td>
                      )}
                      <td className="px-6 py-3 text-gray-400">{s.repoName ?? '—'}</td>
                      <td className="px-6 py-3 text-gray-400 text-xs max-w-[140px] truncate">
                        {s.branch ? (
                          <span className="inline-flex items-center gap-1">
                            <GitBranch className="w-3 h-3 text-gray-500" />
                            {s.branch}
                          </span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-6 py-3 text-right text-gray-400 tabular-nums">
                        {formatDuration(s.durationMs)}
                      </td>
                      <td className="px-6 py-3 text-right text-gray-400 tabular-nums">
                        {(s.tokensUsed / 1000).toFixed(1)}k
                      </td>
                      <td className="px-6 py-3 text-right text-gray-300 tabular-nums">
                        {formatCost(s.costUsd)}
                      </td>
                      {!isDev && (
                      <td className="px-6 py-3">
                        {s.review?.score != null ? (
                          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full ${
                            s.review.score >= 80 ? 'bg-green-500/20 text-green-400' :
                            s.review.score >= 50 ? 'bg-amber-500/20 text-amber-400' :
                            'bg-red-500/20 text-red-400'
                          }`}>
                            {s.review.score}
                            {s.review.isAutoReview && (
                              <span className="text-[9px] opacity-60">AI</span>
                            )}
                          </span>
                        ) : s.review?.status ? (
                          statusBadge(s.review.status.toLowerCase())
                        ) : (
                          <span className="text-xs text-gray-600">—</span>
                        )}
                      </td>
                      )}
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
      )}
    </div>
  );
}
