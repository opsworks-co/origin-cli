import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import type { TrailDetail as TrailDetailType, Session } from '../api';
import { timeAgo, formatCost, getStatusBadgeClass } from '../utils';
import { safeHref } from '../utils/safe-url';
import { PageHeader, Pill, ActionButtonGroup } from '../components/ui';
import type { PillVariant } from '../components/ui';

function statusToVariant(status: string): PillVariant {
  const s = status.toLowerCase();
  if (s === 'running' || s === 'active') return 'running';
  if (s === 'completed' || s === 'approved' || s === 'done' || s === 'success') return 'success';
  if (s === 'pending' || s === 'warn' || s === 'flagged' || s === 'paused' || s === 'review') return 'warning';
  if (s === 'rejected' || s === 'failed' || s === 'error') return 'error';
  if (s === 'reviewed' || s === 'info' || s === 'medium') return 'info';
  return 'neutral';
}

function priorityToVariant(priority: string): PillVariant {
  const p = priority.toLowerCase();
  if (p === 'critical') return 'error';
  if (p === 'high') return 'warning';
  if (p === 'medium') return 'info';
  return 'neutral';
}

const STATUS_OPTIONS = ['active', 'review', 'done', 'paused'];
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'];

export default function TrailDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [trail, setTrail] = useState<TrailDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editStatus, setEditStatus] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [showAddSession, setShowAddSession] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Session[]>([]);
  const [searching, setSearching] = useState(false);

  const fetchTrail = () => {
    if (!id) return;
    setLoading(true);
    api.getTrail(id)
      .then((t) => {
        setTrail(t);
        setEditStatus(t.status);
        setEditPriority(t.priority);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchTrail(); }, [id]);

  const handleUpdate = async () => {
    if (!id) return;
    try {
      await api.updateTrail(id, { status: editStatus, priority: editPriority });
      setEditing(false);
      fetchTrail();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async () => {
    if (!id || !confirm('Delete this trail? This cannot be undone.')) return;
    try {
      await api.deleteTrail(id);
      navigate('/trails');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSearchSessions = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await api.getSessions({ limit: 10 });
      setSearchResults(res.sessions.filter((s) =>
        s.prompt?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.commitMessage?.toLowerCase().includes(searchQuery.toLowerCase())
      ));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  };

  const handleAddSession = async (sessionId: string) => {
    if (!id) return;
    try {
      await api.addTrailSessions(id, [sessionId]);
      setSearchResults((prev) => prev.filter((s) => s.id !== sessionId));
      fetchTrail();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRemoveSession = async (sessionId: string) => {
    if (!id) return;
    try {
      await api.removeTrailSession(id, sessionId);
      fetchTrail();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error && !trail) {
    return <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>;
  }

  if (!trail) return null;

  const labels: string[] = Array.isArray(trail.labels) ? trail.labels : (() => { try { return JSON.parse(trail.labels as any); } catch { return []; } })();
  const totalCost = trail.sessions.reduce((s, x) => s + x.costUsd, 0);
  const totalLines = trail.sessions.reduce((s, x) => s + x.linesAdded + x.linesRemoved, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        breadcrumb={[{ label: 'Trails', to: '/trails' }, { label: trail.name }]}
        title={trail.name}
        subtitle={trail.description || undefined}
        meta={
          <>
            <Pill variant={statusToVariant(trail.status)}>{trail.status}</Pill>
            <Pill variant={priorityToVariant(trail.priority)}>{trail.priority}</Pill>
            {trail.branch && (
              <Pill variant="neutral">
                <span className="font-mono">{trail.branch}</span>
              </Pill>
            )}
            {labels.map((l, i) => (
              <Pill key={i} variant="ai">{l}</Pill>
            ))}
          </>
        }
        actions={
          <ActionButtonGroup
            secondary={[
              { label: editing ? 'Cancel' : 'Edit', onClick: () => setEditing(!editing) },
            ]}
            overflow={[
              { label: 'Delete', onClick: handleDelete, destructive: true },
            ]}
          />
        }
      />

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">
          {error}<button onClick={() => setError('')} className="ml-2">&times;</button>
        </div>
      )}

      {/* Edit panel */}
      {editing && (
        <div className="card flex items-center gap-4">
          <div>
            <label className="text-xs text-gray-500">Status</label>
            <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className="select text-sm ml-2">
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">Priority</label>
            <select value={editPriority} onChange={(e) => setEditPriority(e.target.value)} className="select text-sm ml-2">
              {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <button onClick={handleUpdate} className="btn-primary text-xs">Save</button>
        </div>
      )}

      <div className="grid lg:grid-cols-4 gap-6">
        {/* Timeline */}
        <div className="lg:col-span-3 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-300">Session Timeline</h2>
            <button onClick={() => setShowAddSession(!showAddSession)} className="btn-secondary text-xs">
              {showAddSession ? 'Cancel' : 'Add Session'}
            </button>
          </div>

          {/* Add session search */}
          {showAddSession && (
            <div className="card space-y-3">
              <div className="flex gap-2">
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearchSessions()}
                  className="input flex-1"
                  placeholder="Search sessions by prompt or commit..."
                />
                <button onClick={handleSearchSessions} disabled={searching} className="btn-primary text-xs">
                  {searching ? 'Searching...' : 'Search'}
                </button>
              </div>
              {searchResults.map((s) => (
                <div key={s.id} className="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="badge-blue text-xs">{s.model}</span>
                    <span className="text-sm text-gray-300 truncate">{s.prompt?.split('\n')[0]?.slice(0, 60) || s.commitMessage || 'Session'}</span>
                  </div>
                  <button onClick={() => handleAddSession(s.id)} className="btn-primary text-xs flex-shrink-0">Add</button>
                </div>
              ))}
            </div>
          )}

          {/* Sessions timeline */}
          {trail.sessions.length === 0 ? (
            <div className="card text-center py-8 text-gray-500">
              No sessions linked to this trail yet. Add sessions to build the timeline.
            </div>
          ) : (
            <div className="relative pl-6 border-l-2 border-gray-800 space-y-4">
              {trail.sessions.map((s) => (
                <div key={s.id} className="relative">
                  {/* Timeline dot */}
                  <div className="absolute -left-[31px] top-3 w-3 h-3 rounded-full bg-indigo-500 border-2 border-gray-900" />

                  <Link
                    to={`/sessions/${s.sessionId}`}
                    className="card hover:border-gray-600 transition-colors block"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="badge-blue text-xs">{s.model}</span>
                        {s.reviewStatus && <span className={getStatusBadgeClass(s.reviewStatus.toLowerCase())}>{s.reviewStatus}</span>}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        {s.userName && <span>{s.userName}</span>}
                        <span>{timeAgo(s.createdAt)}</span>
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRemoveSession(s.sessionId); }}
                          className="text-gray-600 hover:text-red-400 transition-colors"
                          title="Remove from trail"
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                    <p className="text-sm text-gray-300 mb-2">{s.prompt?.slice(0, 120)}{s.prompt?.length > 120 ? '...' : ''}</p>
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      {s.repoName && <span>{s.repoName}</span>}
                      {s.commitSha && <span className="font-mono">{s.commitSha.slice(0, 7)}</span>}
                      <span>+{s.linesAdded} -{s.linesRemoved}</span>
                      <span>${s.costUsd.toFixed(2)}</span>
                    </div>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Stats Sidebar */}
        <div className="space-y-4">
          <div className="card">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Trail Stats</p>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Sessions</span>
                <span className="text-gray-200 font-medium">{trail.sessions.length}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Total Cost</span>
                <span className="text-gray-200 font-medium">${totalCost.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Total Lines</span>
                <span className="text-gray-200 font-medium">{totalLines.toLocaleString()}</span>
              </div>
              {trail.sessions.length > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Started</span>
                    <span className="text-gray-200">{timeAgo(trail.sessions[trail.sessions.length - 1].createdAt)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Last Activity</span>
                    <span className="text-gray-200">{timeAgo(trail.sessions[0].createdAt)}</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Linked PRs */}
          {trail.pullRequests && trail.pullRequests.length > 0 && (
            <div className="card">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Linked PRs</p>
              <div className="space-y-2">
                {trail.pullRequests.map((pr) => (
                  <a
                    key={pr.id}
                    href={safeHref(pr.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between text-sm hover:bg-gray-800/50 rounded px-2 py-1 -mx-2 transition-colors"
                  >
                    <span className="text-indigo-400">#{pr.number}</span>
                    <span className="text-gray-400 truncate ml-2">{pr.title}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
