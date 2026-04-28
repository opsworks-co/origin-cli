import { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import { restoreSnapshot, getRestoreStatus, branchFromSnapshot } from '../api/sessions';
import type { Session, PromptChange } from '../api/sessions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SnapshotRow {
  sessionId: string;
  repoName: string;
  model: string;
  userName: string | null;
  branch: string | null;
  sessionStartedAt: string | null;
  costUsd: number;
  sessionCommitSha: string | null;
  // Short human-readable session summary (server derives from first
  // prompt). Lets the snapshot list say "Refactored auth middleware"
  // instead of just "claude · main · Adolf Cool".
  sessionTitle: string | null;
  promptChange: PromptChange;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const TYPE_STYLES: Record<string, { label: string; dot: string; badge: string }> = {
  'auto':          { label: 'Snapshot',        dot: 'bg-blue-400',    badge: 'bg-blue-500/15 text-blue-400 ring-blue-500/25' },
  'manual':        { label: 'Manual',          dot: 'bg-gray-400',    badge: 'bg-gray-500/15 text-gray-400 ring-gray-500/25' },
  'pre-prompt':    { label: 'Pre-prompt',      dot: 'bg-amber-400',   badge: 'bg-amber-500/15 text-amber-400 ring-amber-500/25' },
  'session-start': { label: 'Session Start',   dot: 'bg-emerald-400', badge: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/25' },
  'session-end':   { label: 'Session End',     dot: 'bg-red-400',     badge: 'bg-red-500/15 text-red-400 ring-red-500/25' },
};

// ---------------------------------------------------------------------------
// Diff renderer
// ---------------------------------------------------------------------------

function DiffBlock({ diff }: { diff: string }) {
  if (!diff) return <p className="text-xs text-gray-600 italic px-4 py-3">No diff available</p>;

  const lines = diff.split('\n').slice(0, 200); // cap for performance
  const truncated = diff.split('\n').length > 200;

  return (
    <div className="font-mono text-[11px] leading-[1.6] overflow-x-auto">
      {lines.map((line, i) => {
        if (line.startsWith('@@')) {
          return (
            <div key={i} className="bg-indigo-950/30 text-indigo-400 px-4 py-0.5 border-y border-indigo-900/20">
              {line}
            </div>
          );
        }
        if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          return null;
        }
        let bg = '';
        let textColor = 'text-gray-500';
        if (line.startsWith('+')) {
          bg = 'bg-emerald-950/30 border-l-2 border-emerald-700/50';
          textColor = 'text-emerald-300';
        } else if (line.startsWith('-')) {
          bg = 'bg-red-950/30 border-l-2 border-red-700/50';
          textColor = 'text-red-300';
        }
        return (
          <div key={i} className={`${bg} ${textColor} px-4 whitespace-pre`}>
            {line || ' '}
          </div>
        );
      })}
      {truncated && (
        <div className="text-xs text-gray-600 px-4 py-2 italic">... diff truncated (200 lines shown)</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function Snapshots() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterType, setFilterType] = useState<string>('');
  const [filterRepo, setFilterRepo] = useState<string>('');
  const [searchText, setSearchText] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getSessions({ limit: 50 })
      .then((r) => setSessions(r.sessions))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Flatten all prompt changes from all sessions into snapshot rows
  const allSnapshots: SnapshotRow[] = useMemo(() => {
    const rows: SnapshotRow[] = [];
    for (const s of sessions) {
      if (!s.promptChanges) continue;
      for (const pc of s.promptChanges) {
        rows.push({
          sessionId: s.id,
          repoName: s.repoName || 'Unknown',
          model: s.model,
          userName: s.userName || s.apiKeyName || null,
          branch: s.branch,
          sessionStartedAt: s.startedAt || s.createdAt,
          costUsd: s.costUsd || 0,
          sessionCommitSha: s.commitSha || null,
          sessionTitle: (s as any).aiTitle || null,
          promptChange: pc,
        });
      }
    }
    rows.sort((a, b) => {
      const ta = a.promptChange.createdAt || a.sessionStartedAt || '';
      const tb = b.promptChange.createdAt || b.sessionStartedAt || '';
      return tb.localeCompare(ta);
    });
    return rows;
  }, [sessions]);

  // Apply filters
  const filtered = useMemo(() => {
    return allSnapshots.filter(row => {
      if (filterType && row.promptChange.checkpointType !== filterType) return false;
      if (filterRepo && row.repoName !== filterRepo) return false;
      if (searchText) {
        const q = searchText.toLowerCase();
        const text = (row.promptChange.promptText || '').toLowerCase();
        const files = (row.promptChange.filesChanged || []).join(' ').toLowerCase();
        if (!text.includes(q) && !files.includes(q) && !row.repoName.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [allSnapshots, filterType, filterRepo, searchText]);

  const repos = useMemo(() => [...new Set(allSnapshots.map(r => r.repoName))].sort(), [allSnapshots]);

  // ── Session + date grouping ─────────────────────────────────────────────
  // Group filtered rows by session, then bucket sessions by date. This is
  // what turns a flat "15 snapshots" firehose into a structured
  //   Today · 8 snapshots
  //     Cursor · babak · feature/wave   5 snapshots   7m ago  ›
  //     claude · babak · main           3 snapshots   2h ago  ›
  // readout — click a session row to expand the snapshot timeline inline.
  type SessionGroup = {
    sessionId: string;
    repoName: string;
    branch: string | null;
    model: string;
    userName: string | null;
    title: string | null;
    rows: SnapshotRow[];
    latestTime: string;
    totalAdded: number;
    totalRemoved: number;
    totalCost: number;
  };

  const sessionGroups = useMemo<SessionGroup[]>(() => {
    const byId = new Map<string, SessionGroup>();
    for (const row of filtered) {
      const existing = byId.get(row.sessionId);
      const pc = row.promptChange;
      const rowTime = pc.createdAt || row.sessionStartedAt || '';
      if (!existing) {
        byId.set(row.sessionId, {
          sessionId: row.sessionId,
          repoName: row.repoName,
          branch: row.branch,
          model: row.model,
          userName: row.userName,
          title: row.sessionTitle,
          rows: [row],
          latestTime: rowTime,
          totalAdded: pc.linesAdded || 0,
          totalRemoved: pc.linesRemoved || 0,
          totalCost: row.costUsd || 0,
        });
      } else {
        existing.rows.push(row);
        existing.totalAdded += pc.linesAdded || 0;
        existing.totalRemoved += pc.linesRemoved || 0;
        if (rowTime && rowTime > existing.latestTime) existing.latestTime = rowTime;
      }
    }
    // Sort rows inside each session chronologically (latest first), then
    // sessions by latest activity (newest first).
    const groups = Array.from(byId.values());
    for (const g of groups) {
      g.rows.sort((a, b) => {
        const ta = a.promptChange.createdAt || '';
        const tb = b.promptChange.createdAt || '';
        return tb.localeCompare(ta);
      });
    }
    groups.sort((a, b) => b.latestTime.localeCompare(a.latestTime));
    return groups;
  }, [filtered]);

  // Date bucketing. Labels match GitHub's PR list vocabulary so returning
  // users feel at home.
  const dateGroups = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 24 * 60 * 60 * 1000;
    const lastWeek = today - 7 * 24 * 60 * 60 * 1000;

    const buckets: Record<string, SessionGroup[]> = {
      Today: [],
      Yesterday: [],
      'Earlier this week': [],
      Older: [],
    };
    for (const g of sessionGroups) {
      const t = g.latestTime ? new Date(g.latestTime).getTime() : 0;
      if (t >= today) buckets.Today.push(g);
      else if (t >= yesterday) buckets.Yesterday.push(g);
      else if (t >= lastWeek) buckets['Earlier this week'].push(g);
      else buckets.Older.push(g);
    }
    return (Object.entries(buckets) as Array<[string, SessionGroup[]]>).filter(([, arr]) => arr.length > 0);
  }, [sessionGroups]);

  // Expand state for session cards (independent from the per-snapshot
  // `expandedId`). We keep a Set so multiple sessions can be open at once.
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(new Set());
  const toggleSession = useCallback((id: string) => {
    setExpandedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Stats
  const totalSnapshots = allSnapshots.length;
  const totalAdded = allSnapshots.reduce((sum, r) => sum + (r.promptChange.linesAdded || 0), 0);
  const totalRemoved = allSnapshots.reduce((sum, r) => sum + (r.promptChange.linesRemoved || 0), 0);
  const uniqueSessions = new Set(allSnapshots.map(r => r.sessionId)).size;

  const toggle = useCallback((id: string) => {
    setExpandedId(prev => prev === id ? null : id);
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
      <div className="text-center py-12">
        <p className="text-red-400 mb-2">Failed to load snapshots</p>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-100">Snapshots</h1>
        <p className="text-sm text-gray-500 mt-1">What changed after every AI prompt, across all sessions</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-gray-800/60 bg-gray-900/30 px-4 py-3">
          <div className="text-2xl font-semibold text-gray-100 tabular-nums">{totalSnapshots}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">Snapshots</div>
        </div>
        <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3">
          <div className="text-2xl font-semibold text-indigo-400 tabular-nums">{uniqueSessions}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">Sessions</div>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
          <div className="text-2xl font-semibold text-emerald-400 tabular-nums">+{totalAdded.toLocaleString()}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">Lines Added</div>
        </div>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
          <div className="text-2xl font-semibold text-red-400 tabular-nums">-{totalRemoved.toLocaleString()}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">Lines Removed</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search prompts, files, repos..."
          className="input max-w-xs text-sm"
        />
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="select text-sm"
        >
          <option value="">All types</option>
          <option value="auto">Snapshot</option>
          <option value="manual">Manual</option>
          <option value="session-start">Session Start</option>
          <option value="session-end">Session End</option>
        </select>
        <select
          value={filterRepo}
          onChange={(e) => setFilterRepo(e.target.value)}
          className="select text-sm"
        >
          <option value="">All repos</option>
          {repos.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <button
          onClick={() => {
            setSelectMode(!selectMode);
            if (selectMode) setSelectedIds([]);
          }}
          className={`text-[11px] font-medium px-3 py-1.5 rounded-md border transition-all ${
            selectMode
              ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/50'
              : 'bg-gray-900/40 text-gray-400 border-gray-800 hover:border-gray-700'
          }`}
        >
          {selectMode ? `Comparing (${selectedIds.length}/2)` : 'Compare Mode'}
        </button>
        {selectMode && selectedIds.length === 2 && (
          <button
            onClick={() => setCompareOpen(true)}
            className="text-[11px] font-medium px-3 py-1.5 rounded-md bg-indigo-500 text-white hover:bg-indigo-400 transition-all"
          >
            Compare Selected →
          </button>
        )}
        <span className="text-[11px] text-gray-600 ml-auto">
          {filtered.length} snapshot{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Snapshot list */}
      {filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3 opacity-50">&#128247;</div>
          <p className="text-gray-400 font-medium">No snapshots found</p>
          <p className="text-sm text-gray-600 mt-1">
            {allSnapshots.length === 0
              ? 'Snapshots are created automatically during AI coding sessions'
              : 'Try adjusting your filters'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {dateGroups.map(([bucketLabel, sessionsInBucket]) => {
            const bucketCount = sessionsInBucket.reduce((sum, s) => sum + s.rows.length, 0);
            return (
              <section key={bucketLabel}>
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-2 flex items-center gap-2">
                  <span>{bucketLabel}</span>
                  <span className="text-gray-700">·</span>
                  <span className="text-gray-600 font-normal normal-case tracking-normal">
                    {bucketCount} snapshot{bucketCount === 1 ? '' : 's'} across {sessionsInBucket.length} session{sessionsInBucket.length === 1 ? '' : 's'}
                  </span>
                </h3>
                <div className="space-y-1.5">
                  {sessionsInBucket.map(group => {
                    const isOpen = expandedSessionIds.has(group.sessionId);
                    return (
                      <div
                        key={group.sessionId}
                        className={`rounded-lg border transition-colors ${
                          isOpen
                            ? 'border-indigo-500/30 bg-indigo-500/[0.03]'
                            : 'border-gray-800/60 bg-gray-900/20 hover:border-gray-700'
                        }`}
                      >
                        {/* Session summary row — always visible */}
                        <button
                          type="button"
                          onClick={() => toggleSession(group.sessionId)}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-left"
                        >
                          <svg
                            className={`w-3.5 h-3.5 text-gray-500 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                          <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-500/25 flex-shrink-0">
                            {group.model.split('/').pop()?.split('-').slice(0, 3).join('-') || group.model}
                          </span>
                          {/* Title-first layout: a derived session summary
                              (from the first prompt) is far more useful than
                              "claude · main · Adolf Cool" repeated 50 times. */}
                          {group.title ? (
                            <div className="flex-1 min-w-0 flex items-center gap-2">
                              <span className="text-sm text-gray-100 font-medium truncate" title={group.title}>
                                {group.title}
                              </span>
                              <span className="text-[11px] text-gray-500 truncate flex-shrink-0">
                                {group.repoName}
                                {group.branch && <> · <span className="font-mono">{group.branch}</span></>}
                                {group.userName && <> · {group.userName}</>}
                              </span>
                            </div>
                          ) : (
                            <>
                              <span className="text-sm text-gray-200 font-medium">{group.repoName}</span>
                              {group.branch && (
                                <span className="text-[11px] text-gray-500 font-mono truncate">{group.branch}</span>
                              )}
                              {group.userName && (
                                <span className="text-[11px] text-gray-500">· {group.userName}</span>
                              )}
                            </>
                          )}
                          <div className="ml-auto flex items-center gap-4 text-[11px] tabular-nums">
                            <span className="text-gray-300 font-medium">
                              {group.rows.length} <span className="text-gray-500 font-normal">snapshot{group.rows.length === 1 ? '' : 's'}</span>
                            </span>
                            {(group.totalAdded > 0 || group.totalRemoved > 0) && (
                              <span className="font-mono text-gray-500">
                                <span className="text-emerald-400/90">+{group.totalAdded}</span>
                                <span className="text-gray-700 mx-0.5">/</span>
                                <span className="text-red-400/90">-{group.totalRemoved}</span>
                              </span>
                            )}
                            <Link
                              to={`/sessions/${group.sessionId}`}
                              onClick={(e) => e.stopPropagation()}
                              className="text-[10px] text-indigo-400 hover:text-indigo-300 font-medium"
                            >
                              open session →
                            </Link>
                            <span className="text-gray-600">{relativeTime(group.latestTime)}</span>
                          </div>
                        </button>
                        {/* Expanded: snapshot timeline inside this session */}
                        {isOpen && (
                          <div className="border-t border-gray-800/60 px-2 py-1 space-y-0.5">
                            {group.rows.map((row, idx) => {
            const pc = row.promptChange;
            const cpType = pc.checkpointType || 'auto';
            const style = TYPE_STYLES[cpType] || TYPE_STYLES['auto'];
            const aiPct = pc.aiPercentage ?? 100;
            const added = pc.linesAdded || 0;
            const removed = pc.linesRemoved || 0;
            const files = pc.filesChanged || [];
            const time = pc.createdAt || row.sessionStartedAt || '';
            const rowId = `${row.sessionId}-${pc.promptIndex}-${idx}`;
            const isExpanded = expandedId === rowId;
            const hasDiff = !!(pc.diff || pc.uncommittedDiff);

            return (
              <div
                key={rowId}
                className={`rounded-lg border transition-all ${
                  isExpanded
                    ? 'border-gray-700/80 bg-gray-900/40'
                    : 'border-transparent hover:border-gray-800/60 hover:bg-gray-800/20'
                }`}
              >
                {/* Row header — always visible */}
                <div
                  onClick={() => {
                    if (selectMode) {
                      setSelectedIds(prev => {
                        if (prev.includes(rowId)) return prev.filter(i => i !== rowId);
                        if (prev.length >= 2) return [prev[1], rowId]; // keep 2 max
                        return [...prev, rowId];
                      });
                    } else {
                      toggle(rowId);
                    }
                  }}
                  className="flex items-start gap-3 px-4 py-3 cursor-pointer group"
                >
                  {/* Checkbox in select mode */}
                  {selectMode && (
                    <div className={`w-4 h-4 rounded border mt-1 flex-shrink-0 flex items-center justify-center transition-all ${
                      selectedIds.includes(rowId)
                        ? 'bg-indigo-500 border-indigo-500'
                        : 'border-gray-700 group-hover:border-gray-500'
                    }`}>
                      {selectedIds.includes(rowId) && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  )}
                  {/* Type dot */}
                  <div className={`w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0 ${style.dot}`} />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1 ${style.badge}`}>
                        {style.label}
                      </span>
                      <span className="text-[11px] text-gray-500 font-mono">{row.repoName}</span>
                      {row.branch && (
                        <span className="text-[10px] text-gray-600 font-mono">{row.branch}</span>
                      )}
                      {time && (
                        <span className="text-[10px] text-gray-600 ml-auto">{relativeTime(time)}</span>
                      )}
                    </div>

                    {/* Prompt text */}
                    <p className={`text-[13px] text-gray-300 leading-relaxed ${isExpanded ? '' : 'line-clamp-1'}`}>
                      {pc.promptText || '(no prompt)'}
                    </p>

                    {/* Stats bar */}
                    <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                      {files.length > 0 && (
                        <div className="flex items-center gap-1">
                          {files.slice(0, 3).map(f => (
                            <span key={f} className="text-[10px] px-1.5 py-0.5 bg-gray-800/60 rounded text-gray-500 font-mono">
                              {f.split('/').pop()}
                            </span>
                          ))}
                          {files.length > 3 && (
                            <span className="text-[10px] text-gray-600">+{files.length - 3}</span>
                          )}
                        </div>
                      )}

                      {(added > 0 || removed > 0) && (
                        <span className="text-[10px] font-mono">
                          <span className="text-emerald-400/80">+{added}</span>
                          <span className="text-gray-700 mx-0.5">/</span>
                          <span className="text-red-400/80">-{removed}</span>
                        </span>
                      )}

                      <span className={`text-[10px] font-medium ${
                        aiPct >= 90 ? 'text-blue-400/70' :
                        aiPct >= 50 ? 'text-purple-400/70' :
                        'text-green-400/70'
                      }`}>
                        {Math.round(aiPct)}% AI
                      </span>

                      <span className="text-[10px] text-gray-600">{row.model}</span>

                      {row.userName && (
                        <span className="text-[10px] text-gray-600">{row.userName}</span>
                      )}
                    </div>
                  </div>

                  {/* Expand chevron */}
                  <svg
                    className={`w-4 h-4 text-gray-700 group-hover:text-gray-500 transition-all mt-1.5 flex-shrink-0 ${
                      isExpanded ? 'rotate-90' : ''
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
                  </svg>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-gray-800/60">
                    {/* File list with full paths */}
                    {files.length > 0 && (
                      <div className="px-4 py-3 border-b border-gray-800/40">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-2">
                          Files changed ({files.length})
                        </div>
                        <div className="space-y-1">
                          {files.map(f => (
                            <div key={f} className="flex items-center gap-2 text-xs">
                              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500/60 flex-shrink-0" />
                              <span className="text-gray-400 font-mono">{f}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Metadata row */}
                    <div className="px-4 py-2.5 flex items-center gap-4 flex-wrap text-[10px] border-b border-gray-800/40">
                      {pc.commitSha && (
                        <span className="text-gray-500">
                          commit <code className="text-gray-400 font-mono">{pc.commitSha.slice(0, 7)}</code>
                        </span>
                      )}
                      {pc.treeSha && (
                        <span className="text-gray-500">
                          tree <code className="text-gray-400 font-mono">{pc.treeSha.slice(0, 7)}</code>
                        </span>
                      )}
                      <span className="text-gray-500">
                        model <span className="text-gray-400">{row.model}</span>
                      </span>

                      <div className="flex items-center gap-3 ml-auto flex-wrap">
                        {/* Branch button — non-destructive, creates branch at commit */}
                        {(pc.commitSha || row.sessionCommitSha) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (restoring === rowId) return;
                              const defaultName = `snapshot-${(pc.commitSha || row.sessionCommitSha || '').slice(0, 7)}`;
                              const name = window.prompt('Branch name:', defaultName);
                              if (!name) return;
                              const doCheckout = window.confirm(
                                `Create branch "${name}" and switch to it?\n\nOK = create & checkout\nCancel = just create (stay on current branch)`
                              );
                              setRestoring(rowId);
                              setRestoreMsg({ id: rowId, text: 'Queuing branch...', ok: true });
                              branchFromSnapshot(row.sessionId, {
                                commitSha: pc.commitSha || row.sessionCommitSha!,
                                branchName: name,
                                checkout: doCheckout,
                              })
                                .then(() => {
                                  setRestoreMsg({ id: rowId, text: 'Queued — waiting for CLI...', ok: true });
                                  const start = Date.now();
                                  const poll = setInterval(async () => {
                                    try {
                                      const status = await getRestoreStatus(row.sessionId);
                                      if (status.sessionStatus !== 'RUNNING') {
                                        clearInterval(poll);
                                        setRestoring(null);
                                        setRestoreMsg({ id: rowId, text: 'Session is not running — start an AI session in this repo first.', ok: false });
                                        return;
                                      }
                                      if (status.result) {
                                        clearInterval(poll);
                                        setRestoring(null);
                                        setRestoreMsg({
                                          id: rowId,
                                          text: status.result.status === 'success' ? status.result.message : `Failed: ${status.result.message}`,
                                          ok: status.result.status === 'success',
                                        });
                                      } else if (Date.now() - start > 90_000) {
                                        clearInterval(poll);
                                        setRestoring(null);
                                        setRestoreMsg({ id: rowId, text: 'Timed out — is the CLI heartbeat running?', ok: false });
                                      } else {
                                        const waited = Math.round((Date.now() - start) / 1000);
                                        setRestoreMsg({ id: rowId, text: `Waiting for CLI (${waited}s)...`, ok: true });
                                      }
                                    } catch { /* keep polling */ }
                                  }, 3000);
                                })
                                .catch((err) => {
                                  setRestoring(null);
                                  setRestoreMsg({ id: rowId, text: err.message || 'Branch failed', ok: false });
                                });
                            }}
                            disabled={restoring === rowId}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium bg-purple-500/10 text-purple-400 border border-purple-500/30 hover:bg-purple-500/20 hover:border-purple-500/50 transition-all disabled:opacity-50"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 3v12m0 0a3 3 0 106 0 3 3 0 00-6 0zm12-6a3 3 0 11-6 0 3 3 0 016 0zm0 0v6a3 3 0 01-3 3H9" />
                            </svg>
                            Branch
                          </button>
                        )}

                        {/* Restore button — uses snapshot SHA if available, falls back to session commit */}
                        {(pc.treeSha || pc.commitSha || row.sessionCommitSha) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (restoring === rowId) return;
                              setRestoring(rowId);
                              setRestoreMsg({ id: rowId, text: 'Queuing restore...', ok: true });
                              restoreSnapshot(row.sessionId, {
                                treeSha: pc.treeSha,
                                commitSha: pc.commitSha || row.sessionCommitSha,
                                promptIndex: pc.promptIndex,
                              })
                                .then(() => {
                                  setRestoreMsg({ id: rowId, text: 'Queued — waiting for CLI to pick up...', ok: true });
                                  // Poll for status every 3s for up to 90s
                                  const start = Date.now();
                                  const poll = setInterval(async () => {
                                    try {
                                      const status = await getRestoreStatus(row.sessionId);
                                      if (status.sessionStatus !== 'RUNNING') {
                                        clearInterval(poll);
                                        setRestoring(null);
                                        setRestoreMsg({ id: rowId, text: 'Session is not running — start an AI session in this repo first, then retry.', ok: false });
                                        return;
                                      }
                                      if (status.result) {
                                        clearInterval(poll);
                                        setRestoring(null);
                                        setRestoreMsg({
                                          id: rowId,
                                          text: status.result.status === 'success'
                                            ? `Restored: ${status.result.message}`
                                            : `Failed: ${status.result.message}`,
                                          ok: status.result.status === 'success',
                                        });
                                      } else if (Date.now() - start > 90_000) {
                                        clearInterval(poll);
                                        setRestoring(null);
                                        setRestoreMsg({ id: rowId, text: 'Timed out — CLI heartbeat may be offline. Is Claude Code running in this repo?', ok: false });
                                      } else {
                                        const waited = Math.round((Date.now() - start) / 1000);
                                        setRestoreMsg({ id: rowId, text: `Waiting for CLI (${waited}s)...`, ok: true });
                                      }
                                    } catch {
                                      /* keep polling */
                                    }
                                  }, 3000);
                                })
                                .catch((err) => {
                                  setRestoring(null);
                                  setRestoreMsg({ id: rowId, text: err.message || 'Restore failed', ok: false });
                                });
                            }}
                            disabled={restoring === rowId}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 hover:border-amber-500/50 transition-all disabled:opacity-50"
                          >
                            {restoring === rowId ? (
                              <span className="animate-spin inline-block w-3 h-3 border border-amber-400 border-t-transparent rounded-full" />
                            ) : (
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                              </svg>
                            )}
                            Restore
                          </button>
                        )}
                        <Link
                          to={`/sessions/${row.sessionId}?tab=turns`}
                          className="text-indigo-400 hover:text-indigo-300 font-medium"
                          onClick={(e) => e.stopPropagation()}
                        >
                          View full session &rarr;
                        </Link>
                      </div>
                    </div>

                    {/* Restore status message */}
                    {restoreMsg && restoreMsg.id === rowId && (
                      <div className={`px-4 py-2 text-xs border-b border-gray-800/40 ${
                        restoreMsg.ok ? 'bg-emerald-950/30 text-emerald-400' : 'bg-red-950/30 text-red-400'
                      }`}>
                        {restoreMsg.text}
                      </div>
                    )}

                    {/* Diff */}
                    {hasDiff ? (
                      <div className="max-h-[400px] overflow-y-auto">
                        <DiffBlock diff={pc.diff || pc.uncommittedDiff || ''} />
                      </div>
                    ) : (
                      <div className="px-4 py-6 text-center">
                        <p className="text-xs text-gray-600">No diff captured for this snapshot</p>
                        <Link
                          to={`/sessions/${row.sessionId}?tab=turns`}
                          className="text-xs text-indigo-400 hover:text-indigo-300 mt-1 inline-block"
                          onClick={(e) => e.stopPropagation()}
                        >
                          View session for full details &rarr;
                        </Link>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {filtered.length > 200 && (
            <div className="text-center py-4 text-sm text-gray-600">
              Showing first 200 of {filtered.length} snapshots
            </div>
          )}
        </div>
      )}

      {/* Compare modal */}
      {compareOpen && selectedIds.length === 2 && (() => {
        const rowA = filtered.find((_, i) => `${filtered[i].sessionId}-${filtered[i].promptChange.promptIndex}-${i}` === selectedIds[0]);
        const rowB = filtered.find((_, i) => `${filtered[i].sessionId}-${filtered[i].promptChange.promptIndex}-${i}` === selectedIds[1]);
        if (!rowA || !rowB) return null;

        // Order by time: older = A, newer = B
        const timeA = new Date(rowA.promptChange.createdAt || rowA.sessionStartedAt || 0).getTime();
        const timeB = new Date(rowB.promptChange.createdAt || rowB.sessionStartedAt || 0).getTime();
        const [older, newer] = timeA < timeB ? [rowA, rowB] : [rowB, rowA];

        return (
          <div
            onClick={() => setCompareOpen(false)}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl"
            >
              {/* Header */}
              <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
                <div>
                  <h2 className="text-lg font-semibold text-gray-100">Compare Snapshots</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {older.repoName} · {relativeTime(older.promptChange.createdAt || older.sessionStartedAt || '')} → {relativeTime(newer.promptChange.createdAt || newer.sessionStartedAt || '')}
                  </p>
                </div>
                <button
                  onClick={() => setCompareOpen(false)}
                  className="w-8 h-8 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-gray-200 flex items-center justify-center transition-colors"
                >
                  ✕
                </button>
              </div>

              {/* Side-by-side snapshot metadata */}
              <div className="grid grid-cols-2 gap-4 px-6 py-4 border-b border-gray-800 flex-shrink-0">
                {[
                  { label: 'OLDER', row: older, badge: 'bg-amber-500/15 text-amber-400 ring-amber-500/25' },
                  { label: 'NEWER', row: newer, badge: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/25' },
                ].map((side) => (
                  <div key={side.label} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1 ${side.badge}`}>
                        {side.label}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        {relativeTime(side.row.promptChange.createdAt || side.row.sessionStartedAt || '')}
                      </span>
                    </div>
                    <p className="text-sm text-gray-200 line-clamp-2">
                      {side.row.promptChange.promptText || '(no prompt)'}
                    </p>
                    <div className="flex items-center gap-3 text-[10px] text-gray-500">
                      <span>{side.row.promptChange.filesChanged?.length || 0} files</span>
                      <span className="text-emerald-400/70">+{side.row.promptChange.linesAdded || 0}</span>
                      <span className="text-red-400/70">-{side.row.promptChange.linesRemoved || 0}</span>
                      {side.row.promptChange.commitSha && (
                        <code className="font-mono text-gray-600">{side.row.promptChange.commitSha.slice(0, 7)}</code>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* File changes summary */}
              <div className="px-6 py-3 border-b border-gray-800 flex-shrink-0">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-2">
                  Files touched between snapshots
                </div>
                {(() => {
                  const allFiles = new Set<string>([
                    ...(older.promptChange.filesChanged || []),
                    ...(newer.promptChange.filesChanged || []),
                  ]);
                  if (allFiles.size === 0) {
                    return <p className="text-xs text-gray-600">No files recorded</p>;
                  }
                  return (
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from(allFiles).map(f => {
                        const inOlder = older.promptChange.filesChanged?.includes(f);
                        const inNewer = newer.promptChange.filesChanged?.includes(f);
                        const color = inOlder && inNewer ? 'text-purple-300 bg-purple-500/10 border-purple-500/20'
                          : inOlder ? 'text-amber-300 bg-amber-500/10 border-amber-500/20'
                          : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20';
                        return (
                          <span key={f} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${color}`}>
                            {f.split('/').pop()}
                          </span>
                        );
                      })}
                    </div>
                  );
                })()}
                <p className="text-[10px] text-gray-600 mt-2">
                  <span className="text-amber-400/70">●</span> older only ·
                  <span className="text-emerald-400/70 ml-2">●</span> newer only ·
                  <span className="text-purple-400/70 ml-2">●</span> in both
                </p>
              </div>

              {/* Diffs side-by-side */}
              <div className="flex-1 overflow-y-auto">
                <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-800">
                  <div>
                    <div className="px-4 py-2 bg-amber-500/5 border-b border-gray-800 text-[10px] text-amber-400 font-medium uppercase tracking-wider">
                      Older snapshot diff
                    </div>
                    <DiffBlock diff={older.promptChange.diff || older.promptChange.uncommittedDiff || ''} />
                  </div>
                  <div>
                    <div className="px-4 py-2 bg-emerald-500/5 border-b border-gray-800 text-[10px] text-emerald-400 font-medium uppercase tracking-wider">
                      Newer snapshot diff
                    </div>
                    <DiffBlock diff={newer.promptChange.diff || newer.promptChange.uncommittedDiff || ''} />
                  </div>
                </div>
              </div>

              {/* Footer with CLI hint */}
              <div className="px-6 py-3 border-t border-gray-800 bg-gray-900/40 flex-shrink-0">
                <p className="text-[11px] text-gray-500">
                  For the exact tree diff between these two states, run in your repo:
                </p>
                {older.promptChange.commitSha && newer.promptChange.commitSha && (
                  <code className="text-[11px] text-indigo-400 font-mono mt-1 block">
                    git diff {older.promptChange.commitSha.slice(0, 7)}..{newer.promptChange.commitSha.slice(0, 7)}
                  </code>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
