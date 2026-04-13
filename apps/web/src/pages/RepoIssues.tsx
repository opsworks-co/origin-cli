import React, { useEffect, useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../api';
import type { Issue, IssueStats } from '../api';
import { timeAgo } from '../utils';

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: 'P1 Critical', color: 'text-red-400 bg-red-500/10 ring-red-500/20' },
  2: { label: 'P2 High', color: 'text-amber-400 bg-amber-500/10 ring-amber-500/20' },
  3: { label: 'P3 Medium', color: 'text-blue-400 bg-blue-500/10 ring-blue-500/20' },
  4: { label: 'P4 Low', color: 'text-gray-400 bg-white/[0.04] ring-white/[0.06]' },
};

const STATUS_CONFIG: Record<string, { icon: string; color: string }> = {
  'open': { icon: '○', color: 'text-green-400' },
  'in-progress': { icon: '◉', color: 'text-cyan-400' },
  'blocked': { icon: '⊘', color: 'text-red-400' },
  'closed': { icon: '✓', color: 'text-gray-500' },
};

type StatusFilter = 'open' | 'closed' | 'all';

function PriorityBadge({ priority }: { priority: number }) {
  const cfg = PRIORITY_LABELS[priority] || PRIORITY_LABELS[3];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide ring-1 ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG['open'];
  return <span className={`${cfg.color} text-sm`}>{cfg.icon}</span>;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h ${mins % 60}m`;
}

export default function RepoIssues() {
  const { id: repoId } = useParams<{ id: string }>();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [stats, setStats] = useState<IssueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('open');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState('task');
  const [newPriority, setNewPriority] = useState(3);
  const [expandedIssue, setExpandedIssue] = useState<string | null>(null);

  const fetchData = async () => {
    if (!repoId) return;
    try {
      const [issuesData, statsData] = await Promise.all([
        api.getIssues(repoId, filter === 'all' ? {} : { status: filter === 'open' ? undefined : filter }),
        api.getIssueStats(repoId),
      ]);
      setIssues(issuesData);
      setStats(statsData);
    } catch (err) {
      console.error('Failed to load issues:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [repoId, filter]);

  const filteredIssues = useMemo(() => {
    if (filter === 'all') return issues;
    if (filter === 'closed') return issues.filter(i => i.status === 'closed');
    return issues.filter(i => i.status !== 'closed');
  }, [issues, filter]);

  const handleCreate = async () => {
    if (!repoId || !newTitle.trim()) return;
    const shortId = `ori-${Math.random().toString(36).slice(2, 6)}`;
    try {
      await api.createIssue(repoId, {
        shortId,
        title: newTitle.trim(),
        type: newType,
        priority: newPriority,
      });
      setNewTitle('');
      setCreating(false);
      fetchData();
    } catch (err) {
      console.error('Failed to create issue:', err);
    }
  };

  const handleStatusChange = async (issue: Issue, newStatus: string) => {
    if (!repoId) return;
    try {
      await api.updateIssue(repoId, issue.shortId, { status: newStatus });
      fetchData();
    } catch (err) {
      console.error('Failed to update issue:', err);
    }
  };

  if (loading) {
    return (
      <div className="animate-fade-in max-w-6xl mx-auto space-y-6">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Link to="/repos" className="hover:text-gray-300 transition-colors">Repositories</Link>
            <span>/</span>
            <Link to={`/repos/${repoId}`} className="hover:text-gray-300 transition-colors">Repo</Link>
            <span>/</span>
            <span className="text-gray-200">Issues</span>
          </div>
          <h1 className="text-xl font-bold text-gray-100">Issues</h1>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="btn-primary text-sm"
        >
          + New Issue
        </button>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="card p-4">
            <p className="text-2xl font-bold text-green-400">{stats.counts.open}</p>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide">Open</p>
          </div>
          <div className="card p-4">
            <p className="text-2xl font-bold text-cyan-400">{stats.counts.inProgress}</p>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide">In Progress</p>
          </div>
          <div className="card p-4">
            <p className="text-2xl font-bold text-red-400">{stats.counts.blocked}</p>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide">Blocked</p>
          </div>
          <div className="card p-4">
            <p className="text-2xl font-bold text-gray-400">{stats.counts.closed}</p>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide">Closed</p>
          </div>
          <div className="card p-4">
            <p className="text-2xl font-bold text-indigo-400">{formatCost(stats.cost.totalCost)}</p>
            <p className="text-[11px] text-gray-500 uppercase tracking-wide">Total AI Cost</p>
          </div>
        </div>
      )}

      {/* Top issues by cost */}
      {stats && stats.topIssuesByCost.length > 0 && stats.topIssuesByCost[0].cost > 0 && (
        <div className="card p-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Top Issues by AI Cost</h3>
          <div className="space-y-2">
            {stats.topIssuesByCost.filter(i => i.cost > 0).map((item) => (
              <div key={item.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-500 text-xs font-mono">{item.id}</span>
                  <span className="text-gray-200 truncate">{item.title}</span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-gray-500 text-xs">{item.sessions} session{item.sessions !== 1 ? 's' : ''}</span>
                  <span className="text-indigo-400 font-medium text-xs">{formatCost(item.cost)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <div className="card p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-200">New Issue</h3>
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Issue title..."
            className="input text-sm"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <div className="flex items-center gap-3">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="select text-sm"
            >
              <option value="bug">Bug</option>
              <option value="feature">Feature</option>
              <option value="task">Task</option>
              <option value="chore">Chore</option>
            </select>
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(parseInt(e.target.value))}
              className="select text-sm"
            >
              <option value={1}>P1 Critical</option>
              <option value={2}>P2 High</option>
              <option value={3}>P3 Medium</option>
              <option value={4}>P4 Low</option>
            </select>
            <div className="flex-1" />
            <button onClick={() => setCreating(false)} className="btn-ghost text-sm py-1.5">Cancel</button>
            <button onClick={handleCreate} disabled={!newTitle.trim()} className="btn-primary text-sm py-1.5">Create</button>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex items-center gap-1 border-b border-white/[0.06] pb-0">
        {(['open', 'closed', 'all'] as StatusFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              filter === f
                ? 'border-indigo-500 text-gray-200'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {f === 'open' ? `Open (${stats?.counts.open ?? 0})` : f === 'closed' ? `Closed (${stats?.counts.closed ?? 0})` : `All (${stats?.counts.total ?? 0})`}
          </button>
        ))}
      </div>

      {/* Issue list */}
      {filteredIssues.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg mb-1">No issues found</p>
          <p className="text-sm">Create one with the button above or <code className="text-xs bg-gray-800 px-1.5 py-0.5 rounded">origin issue create "title"</code></p>
        </div>
      ) : (
        <div className="space-y-1">
          {filteredIssues.map((issue) => {
            const isExpanded = expandedIssue === issue.shortId;
            const totalCost = issue.sessions.reduce((sum, s) => sum + s.costUsd, 0);
            const totalTokens = issue.sessions.reduce((sum, s) => sum + s.tokensUsed, 0);
            const totalDuration = issue.sessions.reduce((sum, s) => sum + s.durationMs, 0);

            return (
              <div key={issue.id} className="card p-0 overflow-hidden">
                {/* Issue row */}
                <button
                  onClick={() => setExpandedIssue(isExpanded ? null : issue.shortId)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
                >
                  <StatusIcon status={issue.status} />

                  <span className="text-xs font-mono text-gray-500 w-16 flex-shrink-0">{issue.shortId}</span>

                  <span className="text-sm text-gray-200 flex-1 min-w-0 truncate">{issue.title}</span>

                  {issue.labels.map((l) => (
                    <span key={l} className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 ring-1 ring-cyan-500/20">
                      {l}
                    </span>
                  ))}

                  <PriorityBadge priority={issue.priority} />

                  {issue.sessions.length > 0 && (
                    <span className="text-xs text-gray-500 flex-shrink-0">
                      {issue.sessions.length} session{issue.sessions.length !== 1 ? 's' : ''} · {formatCost(totalCost)}
                    </span>
                  )}

                  <span className="text-xs text-gray-500 flex-shrink-0 w-16 text-right">{timeAgo(issue.updatedAt)}</span>

                  <svg className={`w-4 h-4 text-gray-500 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-white/[0.06] px-4 py-4 space-y-4 bg-white/[0.01]">
                    {/* Description */}
                    {issue.description && (
                      <p className="text-sm text-gray-400">{issue.description}</p>
                    )}

                    {/* Metadata */}
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span>Type: <span className="text-gray-300">{issue.type}</span></span>
                      <span>Created: <span className="text-gray-300">{timeAgo(issue.createdAt)}</span></span>
                      {issue.deps.length > 0 && (
                        <span>Deps: <span className="text-gray-300">{issue.deps.join(', ')}</span></span>
                      )}
                    </div>

                    {/* Status actions */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 mr-2">Set status:</span>
                      {['open', 'in-progress', 'blocked', 'closed'].map((s) => (
                        <button
                          key={s}
                          onClick={() => handleStatusChange(issue, s)}
                          className={`text-xs px-2 py-1 rounded-md transition-colors ${
                            issue.status === s
                              ? 'bg-indigo-600 text-white'
                              : 'bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.08]'
                          }`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>

                    {/* Linked sessions */}
                    {issue.sessions.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                          Linked Sessions ({issue.sessions.length}) — {formatCost(totalCost)} total · {totalTokens.toLocaleString()} tokens · {formatDuration(totalDuration)}
                        </h4>
                        <div className="space-y-1">
                          {issue.sessions.map((s) => (
                            <Link
                              key={s.sessionId}
                              to={`/sessions/${s.sessionId}`}
                              className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
                            >
                              <div className="flex items-center gap-3 text-xs">
                                <span className="font-mono text-gray-500">{s.sessionId.slice(0, 8)}</span>
                                <span className="text-gray-300">{s.model}</span>
                                <span className="text-green-400">+{s.linesAdded}</span>
                                <span className="text-red-400">-{s.linesRemoved}</span>
                              </div>
                              <div className="flex items-center gap-3 text-xs">
                                <span className="text-gray-500">{s.tokensUsed.toLocaleString()} tokens</span>
                                <span className="text-indigo-400 font-medium">{formatCost(s.costUsd)}</span>
                                <span className="text-gray-500">{timeAgo(s.createdAt)}</span>
                              </div>
                            </Link>
                          ))}
                        </div>
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
}
