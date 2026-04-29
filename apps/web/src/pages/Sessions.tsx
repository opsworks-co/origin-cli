import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '../api';
import type { Session, Repo, Agent, PRSessionGroup, SessionStreamEvent, TeamMember } from '../api';
import { timeAgo, formatCost, formatDuration, getStatusBadgeClass } from '../utils';
import { Archive, ArchiveRestore, GitBranch, GitMerge, Search, Bookmark, Star } from 'lucide-react';
import { useToast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { safeHref } from '../utils/safe-url';
import { PageHeader, Pill, PulseDot } from '../components/ui';
import type { PillVariant } from '../components/ui';
import { agentColor } from './MyDashboard/utils';

// Maps a session/review status string to the Pill variant defined in design-tokens.md.
// Kept as a simple function so the rest of the file can swap badges for Pills
// without touching the call sites in the table body.
function statusToVariant(status: string): PillVariant {
  const s = status.toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'completed' || s === 'approved' || s === 'done') return 'success';
  if (s === 'flagged' || s === 'warn' || s === 'pending') return 'warning';
  if (s === 'rejected' || s === 'failed' || s === 'error') return 'error';
  if (s === 'reviewed' || s === 'info') return 'info';
  return 'neutral';
}

function statusBadge(status: string) {
  return <Pill variant={statusToVariant(status)}>{status}</Pill>;
}


type SortField = 'model' | 'agent' | 'repo' | 'status' | 'cost' | 'tokens' | 'duration' | 'toolCalls' | 'date' | 'score';
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

  // Filters. Seed `search` from the `?q=` URL param so deep-links from
  // dashboard tiles (e.g. "files most modified") prefill the search box.
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [model, setModel] = useState('');
  const [status, setStatus] = useState('');
  const [repoId, setRepoId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [userId, setUserId] = useState('');
  const [branch, setBranch] = useState('');
  const [offset, setOffset] = useState(0);
  // Saved/bookmarked-only toggle — client-side for now, matches the look of
  // the Insights page's SessionsTab filter.
  const [showSaved, setShowSaved] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const req = (api as any).request;
    if (typeof req !== 'function') return;
    req('/api/sessions/bookmarked')
      .then((data: any) => {
        if (Array.isArray(data)) {
          setSavedIds(new Set(data.map((s: { id: string }) => s.id)));
        }
      })
      .catch(() => {});
  }, []);
  const toggleSaved = async (id: string) => {
    const isBookmarked = savedIds.has(id);
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (isBookmarked) next.delete(id);
      else next.add(id);
      return next;
    });
    try {
      await (api as any).request(`/api/sessions/${id}/bookmark`, {
        method: isBookmarked ? 'DELETE' : 'POST',
      });
    } catch {
      // Revert on error
      setSavedIds((prev) => {
        const next = new Set(prev);
        if (isBookmarked) next.add(id);
        else next.delete(id);
        return next;
      });
    }
  };

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

  const handleMerge = async () => {
    if (selectedIds.size < 2) return;
    const ids = Array.from(selectedIds);
    const selected = sessions.filter((s) => ids.includes(s.id));
    if (selected.some((s) => s.status === 'RUNNING')) {
      toast('error', 'Cannot merge running sessions. Wait for them to complete.');
      return;
    }
    setBulkLoading(true);
    try {
      const res = await api.request<{ mergedSessionId: string }>('/api/sessions/merge', {
        method: 'POST',
        body: JSON.stringify({ sessionIds: ids }),
      });
      toast('success', `Merged ${ids.length} sessions`);
      setSelectedIds(new Set());
      navigate(`/sessions/${res.mergedSessionId}`);
    } catch (err: any) {
      toast('error', err.message || 'Failed to merge sessions');
    } finally {
      setBulkLoading(false);
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
    let list = [...sessions];
    // Client-side text search across common fields + saved-only toggle.
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((s) => {
        // filesChanged comes back from the API as a JSON-stringified array
        // ("[\"foo.ts\",\"bar.ts\"]"), not a parsed array. Match against the
        // raw string — substring match still finds basename hits and avoids
        // a JSON.parse per row on every keystroke.
        const fc = (s as any).filesChanged;
        const filesText = typeof fc === 'string' ? fc.toLowerCase() : Array.isArray(fc) ? fc.join('|').toLowerCase() : '';
        return (
          (s.model || '').toLowerCase().includes(q) ||
          (s.agentName || '').toLowerCase().includes(q) ||
          (s.repoName || '').toLowerCase().includes(q) ||
          (s.branch || '').toLowerCase().includes(q) ||
          (s.userName || '').toLowerCase().includes(q) ||
          filesText.includes(q)
        );
      });
    }
    if (showSaved) {
      list = list.filter((s) => savedIds.has(s.id));
    }
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
        case 'agent':
          cmp = (a.agentName || '').localeCompare(b.agentName || '');
          break;
        case 'repo':
          cmp = (a.repoName || '').localeCompare(b.repoName || '');
          break;
        case 'status':
          cmp = (a.status || '').localeCompare(b.status || '');
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
  }, [sessions, sortBy, sortDir, search, showSaved, savedIds]);

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
      className={`px-3 py-2 font-medium cursor-pointer hover:text-gray-300 select-none ${
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

  // Extracted so the viewMode toggle lives OUTSIDE the "list view only"
  // conditional — otherwise TS narrows viewMode to 'list' and the toggle
  // becomes a dead button.
  const viewModeToggle = !isDev ? (
    <div className="flex rounded-md border border-gray-800 overflow-hidden">
      <button
        onClick={() => setViewMode('list')}
        className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
          viewMode === 'list' ? 'bg-indigo-500/15 text-indigo-300' : 'text-gray-500 hover:text-gray-300'
        }`}
      >List</button>
      <button
        onClick={() => setViewMode('by-pr')}
        className={`px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
          (viewMode as ViewMode) === 'by-pr' ? 'bg-indigo-500/15 text-indigo-300' : 'text-gray-500 hover:text-gray-300'
        }`}
      >By PR</button>
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      {/* SessionsTab-style filter row — clean, flat, no page header band.
          Search input takes remaining space; small right-side pills carry
          the live/archive/view-mode chrome that used to eat a whole row. */}
      {viewMode === 'list' ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search sessions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input w-full pl-9 text-sm"
            />
          </div>
          <select
            value={agentId}
            onChange={(e) => { setAgentId(e.target.value); setOffset(0); }}
            className="select text-sm"
          >
            <option value="">All agents</option>
            {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
          </select>
          <select
            value={repoId}
            onChange={(e) => { setRepoId(e.target.value); setOffset(0); }}
            className="select text-sm"
          >
            <option value="">All repos</option>
            {repos.map((r) => (<option key={r.id} value={r.id}>{r.name}</option>))}
          </select>
          {!isDev && (
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
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
          <button
            onClick={() => setShowSaved(!showSaved)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              showSaved
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700'
            }`}
          >
            <Bookmark className="w-3.5 h-3.5" />
            Saved
          </button>
          <Pill
            variant={liveConnected ? 'running' : 'neutral'}
            size="sm"
            icon={liveConnected ? <PulseDot variant="running" /> : undefined}
            title={liveConnected ? 'Real-time session events connected' : 'Connecting to real-time session stream'}
          >
            {liveConnected ? 'Live' : 'Connecting…'}
          </Pill>
          {viewModeToggle}
          <button
            onClick={() => setShowArchived(!showArchived)}
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-md text-[12px] font-medium border transition-colors ${
              showArchived
                ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                : 'bg-transparent text-gray-400 border-gray-800 hover:text-gray-200 hover:border-gray-700'
            }`}
          >
            {showArchived ? <ArchiveRestore className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
            {showArchived ? 'Archived' : 'Archive'}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-end">{viewModeToggle}</div>
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
            {selectedIds.size >= 2 && (
              <button
                onClick={handleMerge}
                disabled={bulkLoading}
                className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 border-purple-500/30 text-purple-400 hover:bg-purple-500/10"
              >
                <GitMerge className="w-3 h-3" />
                {bulkLoading ? 'Merging...' : `Merge ${selectedIds.size}`}
              </button>
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
                          href={safeHref(group.pr.url)}
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
                      <span className="text-gray-300 text-sm truncate flex-1 max-w-[280px]" title={(s as any).aiTitle || s.commitMessage || s.prompt}>
                        {(s as any).aiTitle || s.commitMessage || s.prompt?.slice(0, 80) || '—'}
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
                      ) : statusBadge(s.review?.status?.toLowerCase() ?? s.status.toLowerCase())}
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
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
                      title="Select all pending sessions"
                    />
                  </th>
                  <th className="px-2 py-2 w-8"></th>
                  <SortHeader field="agent">Agent</SortHeader>
                  <SortHeader field="model">Model</SortHeader>
                  <SortHeader field="repo">Repo</SortHeader>
                  <th className="px-3 py-2 font-medium hidden md:table-cell">Branch</th>
                  <SortHeader field="duration" align="right">Duration</SortHeader>
                  <SortHeader field="cost" align="right">Cost</SortHeader>
                  <SortHeader field="tokens" align="right">Tokens</SortHeader>
                  <SortHeader field="status">Status</SortHeader>
                  {!isDev && <th className="px-3 py-2 font-medium">User</th>}
                  <th className="px-3 py-2 font-medium hidden xl:table-cell">Tags</th>
                  <SortHeader field="date" align="right">When</SortHeader>
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
                      {/* Bookmark star */}
                      <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => toggleSaved(s.id)}
                          className="p-0.5 rounded hover:bg-gray-700 transition-colors"
                          title={savedIds.has(s.id) ? 'Remove bookmark' : 'Bookmark session'}
                        >
                          <Star
                            className={`w-4 h-4 ${
                              savedIds.has(s.id) ? 'text-amber-400 fill-amber-400' : 'text-gray-600'
                            }`}
                          />
                        </button>
                      </td>
                      {/* Agent */}
                      <td className="px-3 py-2">
                        <span
                          className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded"
                          style={{
                            backgroundColor: `${agentColor(s.agentName)}22`,
                            color: agentColor(s.agentName),
                          }}
                        >
                          {s.agentName || s.model.split('/').pop()?.split('-').slice(0, 2).join('-') || s.model}
                        </span>
                      </td>
                      {/* Model */}
                      <td className="px-3 py-2 text-gray-400 text-xs font-mono truncate max-w-[160px]" title={s.model}>
                        {s.model || '—'}
                      </td>
                      {/* Repo — match solo dashboard: just the repo name.
                          The session's AI title belongs in its own column
                          or the row's primary text, not displacing this
                          one. */}
                      <td className="px-3 py-2 text-gray-400 text-sm">
                        {(s.repoNames && s.repoNames.length > 1 ? s.repoNames.join(', ') : s.repoName) ?? '—'}
                      </td>
                      {/* Branch */}
                      <td className="px-3 py-2 text-gray-500 hidden md:table-cell font-mono text-xs max-w-[140px] truncate">
                        {s.branch ? (
                          <span className="inline-flex items-center gap-1">
                            <GitBranch className="w-3 h-3 text-gray-500" />
                            {s.branch}
                          </span>
                        ) : '—'}
                      </td>
                      {/* Duration */}
                      <td className="px-3 py-2 text-right text-gray-300 tabular-nums">
                        {formatDuration(s.durationMs)}
                      </td>
                      {/* Cost */}
                      <td className="px-3 py-2 text-right text-gray-300 tabular-nums">
                        {formatCost(s.costUsd)}
                      </td>
                      {/* Tokens */}
                      <td className="px-3 py-2 text-right text-gray-400 tabular-nums">
                        {(() => {
                          const total = (s.tokensUsed || 0) + ((s as any).cacheReadTokens || 0) + ((s as any).cacheCreationTokens || 0);
                          const cacheShare = total - (s.tokensUsed || 0);
                          const formatted = total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}M` : `${(total / 1000).toFixed(1)}k`;
                          const title = cacheShare > 0
                            ? `${s.inputTokens?.toLocaleString() || 0} in + ${s.outputTokens?.toLocaleString() || 0} out + ${cacheShare.toLocaleString()} cache`
                            : `${s.tokensUsed?.toLocaleString() || 0} tokens`;
                          return <span title={title}>{formatted}</span>;
                        })()}
                      </td>
                      {/* Status */}
                      <td className="px-3 py-2">
                        {s.status === 'RUNNING' ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-900/30 text-green-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                            Running
                          </span>
                        ) : s.status === 'IDLE' ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-900/30 text-amber-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                            Idle
                          </span>
                        ) : s.review?.status ? (
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              s.review.status === 'APPROVED' ? 'bg-green-900/30 text-green-400' :
                              s.review.status === 'FLAGGED' ? 'bg-amber-900/30 text-amber-400' :
                              s.review.status === 'REJECTED' ? 'bg-red-900/30 text-red-400' :
                              'bg-gray-800 text-gray-400'
                            }`}
                          >
                            {s.review.status.charAt(0) + s.review.status.slice(1).toLowerCase()}
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-800 text-gray-500">
                            Done
                          </span>
                        )}
                      </td>
                      {/* User — team only.
                          Skip the "mcp-agent" placeholder commit-author
                          string. That label leaks in when a session was
                          created via an API key with no linked user;
                          showing it as the User makes the column useless.
                          Prefer real user → API key name → em-dash. */}
                      {!isDev && (
                        <td className="px-3 py-2 text-gray-400 text-xs">
                          {(() => {
                            if (s.userName) return s.userName;
                            const author = (s.commitAuthor || '').trim();
                            if (author && author !== 'mcp-agent' && author !== 'ai-agent') return author;
                            if (s.apiKeyName) return s.apiKeyName;
                            return <span className="text-gray-600">—</span>;
                          })()}
                        </td>
                      )}
                      {/* Tags — xl only to keep table dense */}
                      <td className="px-3 py-2 hidden xl:table-cell text-gray-600 text-xs">+</td>
                      {/* When */}
                      <td className="px-3 py-2 text-right text-gray-500 text-xs whitespace-nowrap">
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
            <div className="flex items-center justify-between px-3 py-2 border-t border-gray-800">
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
