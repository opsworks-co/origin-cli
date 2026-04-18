import React, { useMemo } from 'react';
import { Search, Bookmark, Star, BarChart3, GitMerge } from 'lucide-react';
import { Session, agentColor, fmt, fmtCost, fmtDuration, timeAgo } from '../utils';
import { TagEditor } from '../TagEditor';

// ── Chain grouping ─────────────────────────────────────────────────────────
// Re-orders sessions so that descendants appear directly under their root
// (if the root is on the current page) and annotates each with `chainDepth`
// for visual indentation. Keeps non-chained sessions in their original order
// relative to each other.
function groupChains(sessions: Session[]): Array<Session & { chainDepth: number; isChainRoot: boolean }> {
  if (sessions.length === 0) return [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // Build parent→children adjacency restricted to sessions currently on screen.
  const children = new Map<string, Session[]>();
  const isChild = new Set<string>();
  for (const s of sessions) {
    if (s.parentSessionId && byId.has(s.parentSessionId)) {
      const arr = children.get(s.parentSessionId) || [];
      arr.push(s);
      children.set(s.parentSessionId, arr);
      isChild.add(s.id);
    }
  }
  // Sort children by startedAt ascending so they read chronologically after the root.
  for (const arr of children.values()) {
    arr.sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return ta - tb;
    });
  }
  const out: Array<Session & { chainDepth: number; isChainRoot: boolean }> = [];
  const seen = new Set<string>();
  const walk = (s: Session, depth: number, root: boolean) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push(Object.assign({}, s, { chainDepth: depth, isChainRoot: root && (children.get(s.id)?.length ?? 0) > 0 }));
    const kids = children.get(s.id);
    if (kids) for (const k of kids) walk(k, depth + 1, false);
  };
  for (const s of sessions) {
    if (isChild.has(s.id)) continue; // children are emitted by walk()
    walk(s, 0, true);
  }
  return out;
}

type SortField = 'agent' | 'repo' | 'duration' | 'cost' | 'tokens' | 'status' | 'date';

interface SessionsTabProps {
  // search/filters
  search: string;
  setSearch: (v: string) => void;
  agentFilter: string;
  setAgentFilter: (v: string) => void;
  repoFilter: string;
  setRepoFilter: (v: string) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  setSessionsOffset: (v: number) => void;
  uniqueAgents: string[];
  uniqueRepos: string[];
  // bookmarks
  showBookmarked: boolean;
  setShowBookmarked: (v: boolean) => void;
  bookmarkedIds: Set<string>;
  bookmarkTags: Record<string, string[]>;
  toggleBookmark: (sessionId: string) => void;
  updateBookmarkTags: (sessionId: string, tags: string[]) => void;
  // compare / merge
  compareIds: string[];
  setCompareIds: React.Dispatch<React.SetStateAction<string[]>>;
  merging: boolean;
  handleMerge: () => void;
  navigate: (path: string) => void;
  // table
  sessionsLoading: boolean;
  filteredSessions: Session[];
  SortHeader: React.ComponentType<{ field: SortField; children: React.ReactNode; align?: 'right'; className?: string }>;
  // pagination
  sessionsOffset: number;
  sessionsTotal: number;
  totalPages: number;
  currentPage: number;
  LIMIT: number;
}

export function SessionsTab(props: SessionsTabProps) {
  const {
    search, setSearch,
    agentFilter, setAgentFilter,
    repoFilter, setRepoFilter,
    statusFilter, setStatusFilter,
    setSessionsOffset,
    uniqueAgents, uniqueRepos,
    showBookmarked, setShowBookmarked,
    bookmarkedIds, bookmarkTags,
    toggleBookmark, updateBookmarkTags,
    compareIds, setCompareIds,
    merging, handleMerge,
    navigate,
    sessionsLoading, filteredSessions, SortHeader,
    sessionsOffset, sessionsTotal, totalPages, currentPage, LIMIT,
  } = props;

  // Group chained sessions: children appear directly under their root with
  // an indent + tree-connector glyph. If the root isn't on this page, the
  // child still gets an indent so the "Chain" badge has visual context.
  const orderedSessions = useMemo(() => groupChains(filteredSessions), [filteredSessions]);

  return (
        <div className="space-y-4">
          {/* Filters row */}
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
              value={agentFilter}
              onChange={(e) => { setAgentFilter(e.target.value); setSessionsOffset(0); }}
              className="select text-sm"
            >
              <option value="">All agents</option>
              {uniqueAgents.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <select
              value={repoFilter}
              onChange={(e) => { setRepoFilter(e.target.value); setSessionsOffset(0); }}
              className="select text-sm"
            >
              <option value="">All repos</option>
              {uniqueRepos.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setSessionsOffset(0); }}
              className="select text-sm"
            >
              <option value="">All statuses</option>
              <option value="RUNNING">Running</option>
              <option value="IDLE">Idle</option>
              <option value="COMPLETED">Completed</option>
              <option value="approved">Approved</option>
              <option value="flagged">Flagged</option>
              <option value="rejected">Rejected</option>
              <option value="unreviewed">Unreviewed</option>
            </select>
            <button
              onClick={() => setShowBookmarked(!showBookmarked)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                showBookmarked
                  ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200 border border-gray-700'
              }`}
            >
              <Bookmark className="w-3.5 h-3.5" />
              Saved
            </button>
            {compareIds.length > 0 && (
              <>
                <button
                  disabled={compareIds.length !== 2}
                  onClick={() => navigate(`/compare/${compareIds[0]}/${compareIds[1]}`)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    compareIds.length === 2
                      ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/25'
                      : 'bg-gray-800 text-gray-500 border-gray-700 opacity-60'
                  }`}
                >
                  <BarChart3 className="w-3.5 h-3.5" />
                  Compare {compareIds.length}/2
                </button>
                <button
                  disabled={compareIds.length < 2 || merging}
                  onClick={handleMerge}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    compareIds.length >= 2
                      ? 'bg-purple-500/15 text-purple-400 border-purple-500/30 hover:bg-purple-500/25'
                      : 'bg-gray-800 text-gray-500 border-gray-700 opacity-60'
                  }`}
                >
                  <GitMerge className="w-3.5 h-3.5" />
                  {merging ? 'Merging...' : `Merge ${compareIds.length}`}
                </button>
              </>
            )}
          </div>

          {/* Sessions table */}
          <div className="card overflow-hidden" data-tour="session-table">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                    <th className="px-2 py-3 font-medium w-8"></th>
                    <th className="px-4 py-3 font-medium w-8"></th>
                    <SortHeader field="agent">Agent</SortHeader>
                    <SortHeader field="repo">Repo</SortHeader>
                    <th className="px-4 py-3 font-medium hidden md:table-cell">Branch</th>
                    <SortHeader field="duration">Duration</SortHeader>
                    <SortHeader field="cost">Cost</SortHeader>
                    <SortHeader field="tokens" className="hidden lg:table-cell">Tokens</SortHeader>
                    <SortHeader field="status">Status</SortHeader>
                    <th className="px-4 py-3 font-medium hidden xl:table-cell">Tags</th>
                    <SortHeader field="date" align="right">When</SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {sessionsLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i} className="border-b border-gray-800/50">
                        <td colSpan={11} className="px-4 py-3">
                          <div className="h-4 bg-gray-800 rounded animate-pulse" />
                        </td>
                      </tr>
                    ))
                  ) : filteredSessions.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-4 py-8 text-center text-gray-600">
                        {showBookmarked ? 'No saved sessions yet. Star a session to save it.' : 'No sessions found.'}
                      </td>
                    </tr>
                  ) : (
                    orderedSessions.map((s) => (
                      <tr
                        key={s.id}
                        className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors cursor-pointer ${
                          s.chainDepth > 0 ? 'bg-sky-950/10' : ''
                        }`}
                        onClick={() => navigate(`/sessions/${s.id}`)}
                      >
                        <td className="px-2 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={compareIds.includes(s.id)}
                            onChange={() => {
                              setCompareIds((prev) =>
                                prev.includes(s.id)
                                  ? prev.filter((x) => x !== s.id)
                                  : [...prev, s.id]
                              );
                            }}
                            className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-indigo-500 focus:ring-indigo-500/30 cursor-pointer"
                            title="Select to compare"
                          />
                        </td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => toggleBookmark(s.id)}
                            className="p-0.5 rounded hover:bg-gray-700 transition-colors"
                            title={bookmarkedIds.has(s.id) ? 'Remove bookmark' : 'Bookmark session'}
                          >
                            <Star
                              className={`w-4 h-4 ${
                                bookmarkedIds.has(s.id) ? 'text-amber-400 fill-amber-400' : 'text-gray-600'
                              }`}
                            />
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5" style={{ paddingLeft: s.chainDepth > 0 ? `${Math.min(s.chainDepth, 3) * 14}px` : 0 }}>
                            {s.chainDepth > 0 && (
                              <span className="text-sky-500/60 font-mono text-xs leading-none select-none" aria-hidden>└─</span>
                            )}
                            <span
                              className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded"
                              style={{
                                backgroundColor: `${agentColor(s.agentName)}15`,
                                color: agentColor(s.agentName),
                              }}
                            >
                              {s.agentName || s.model.split('/').pop()?.split('-').slice(0, 2).join('-') || s.model}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-400">{s.repoName || '—'}</td>
                        <td className="px-4 py-3 text-gray-500 hidden md:table-cell font-mono text-xs">
                          {s.branch || '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-300">{fmtDuration(s.durationMs)}</td>
                        <td className="px-4 py-3 text-gray-300">{fmtCost(s.costUsd)}</td>
                        <td className="px-4 py-3 text-gray-400 hidden lg:table-cell">{fmt(s.tokensUsed)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {s.mergedFrom && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-900/30 text-purple-400">
                                <GitMerge className="w-3 h-3" />
                                Merged
                              </span>
                            )}
                            {s.parentSessionId && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); navigate(`/sessions/${s.parentSessionId}`); }}
                                title={`Chained to session ${s.parentSessionId.slice(0, 8)} — same agent, same branch, ended within 10 minutes before this one started. Click to open the parent.`}
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-900/30 text-sky-400 hover:bg-sky-800/50 hover:text-sky-300 transition-colors cursor-pointer"
                              >
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                                Chain
                              </button>
                            )}
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
                            ) : s.review ? (
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                  s.review.status === 'APPROVED'
                                    ? 'bg-green-900/30 text-green-400'
                                    : s.review.status === 'FLAGGED'
                                    ? 'bg-amber-900/30 text-amber-400'
                                    : s.review.status === 'REJECTED'
                                    ? 'bg-red-900/30 text-red-400'
                                    : 'bg-gray-800 text-gray-400'
                                }`}
                              >
                                {s.review.status.charAt(0) + s.review.status.slice(1).toLowerCase()}
                                {s.review.score !== null && ` ${s.review.score}`}
                              </span>
                            ) : !s.mergedFrom ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-800 text-gray-500">
                                Done
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden xl:table-cell" onClick={(e) => e.stopPropagation()}>
                          <TagEditor
                            tags={bookmarkTags[s.id] || []}
                            onSave={(tags) => updateBookmarkTags(s.id, tags)}
                          />
                        </td>
                        <td className="px-4 py-3 text-right text-gray-500 text-xs whitespace-nowrap">
                          {timeAgo(s.createdAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {!showBookmarked && totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
                <span className="text-xs text-gray-500">
                  {sessionsOffset + 1}–{Math.min(sessionsOffset + LIMIT, sessionsTotal)} of {sessionsTotal}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    disabled={sessionsOffset === 0}
                    onClick={() => setSessionsOffset(Math.max(0, sessionsOffset - LIMIT))}
                    className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                  >
                    Prev
                  </button>
                  <span className="text-xs text-gray-500 px-2">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    disabled={sessionsOffset + LIMIT >= sessionsTotal}
                    onClick={() => setSessionsOffset(sessionsOffset + LIMIT)}
                    className="px-2 py-1 text-xs rounded bg-gray-800 text-gray-400 hover:text-gray-200 disabled:opacity-30"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
  );
}
