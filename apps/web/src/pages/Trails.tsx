import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { Trail } from '../api';
import { timeAgo } from '../utils';

const STATUS_OPTIONS = ['active', 'review', 'done', 'paused'];
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'];

const statusBadge = (s: string) => {
  const cls: Record<string, string> = { active: 'badge-blue', review: 'badge-amber', done: 'badge-green', paused: 'badge-gray' };
  return <span className={cls[s] || 'badge-gray'}>{s}</span>;
};

const priorityBadge = (p: string) => {
  const cls: Record<string, string> = { critical: 'badge-red', high: 'badge-amber', medium: 'badge-blue', low: 'badge-gray' };
  return <span className={cls[p] || 'badge-gray'}>{p}</span>;
};

export default function Trails() {
  const navigate = useNavigate();
  const [trails, setTrails] = useState<Trail[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formBranch, setFormBranch] = useState('');
  const [formPriority, setFormPriority] = useState('medium');
  const [formLabels, setFormLabels] = useState('');

  const fetchTrails = () => {
    setLoading(true);
    api.getTrails({ status: filterStatus || undefined })
      .then((r) => { setTrails(r.trails); setTotal(r.total); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchTrails(); }, [filterStatus]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const labels = formLabels ? formLabels.split(',').map((l) => l.trim()).filter(Boolean) : undefined;
      await api.createTrail({
        name: formName,
        description: formDesc || undefined,
        branch: formBranch || undefined,
        priority: formPriority,
        labels,
      });
      setFormName(''); setFormDesc(''); setFormBranch(''); setFormPriority('medium'); setFormLabels('');
      setShowForm(false);
      fetchTrails();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && trails.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Feature Trails</h1>
          <p className="text-sm text-gray-500 mt-1">Track features across sessions, branches, and PRs</p>
        </div>
        <button onClick={() => { setShowForm(!showForm); }} className="btn-primary">
          {showForm ? 'Cancel' : 'Create Trail'}
        </button>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-300">&times;</button>
        </div>
      )}

      {/* Create Form */}
      {showForm && (
        <form onSubmit={handleCreate} className="card space-y-4">
          <h3 className="font-semibold">New Trail</h3>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name *</label>
              <input required value={formName} onChange={(e) => setFormName(e.target.value)} className="input w-full" placeholder="e.g. User Authentication" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Branch</label>
              <input value={formBranch} onChange={(e) => setFormBranch(e.target.value)} className="input w-full" placeholder="e.g. feat/auth" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Priority</label>
              <select value={formPriority} onChange={(e) => setFormPriority(e.target.value)} className="select w-full">
                {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Labels (comma-separated)</label>
              <input value={formLabels} onChange={(e) => setFormLabels(e.target.value)} className="input w-full" placeholder="e.g. frontend, auth" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Description</label>
            <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} className="input w-full" rows={2} placeholder="What is this trail tracking?" />
          </div>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Creating...' : 'Create Trail'}
          </button>
        </form>
      )}

      {/* Filter */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Status:</span>
        <button onClick={() => setFilterStatus('')} className={`text-xs px-2 py-1 rounded ${!filterStatus ? 'bg-indigo-600/20 text-indigo-400' : 'text-gray-400 hover:text-gray-200'}`}>All</button>
        {STATUS_OPTIONS.map((s) => (
          <button key={s} onClick={() => setFilterStatus(s)} className={`text-xs px-2 py-1 rounded ${filterStatus === s ? 'bg-indigo-600/20 text-indigo-400' : 'text-gray-400 hover:text-gray-200'}`}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <span className="text-xs text-gray-600 ml-auto">{total} trail{total !== 1 ? 's' : ''}</span>
      </div>

      {/* Trail Cards */}
      {trails.length === 0 ? (
        <div className="card text-center py-12 text-gray-500">
          No trails yet. Create one to start tracking a feature across sessions.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {trails.map((t) => {
            const labels: string[] = Array.isArray(t.labels) ? t.labels : (() => { try { return JSON.parse(t.labels as any); } catch { return []; } })();
            return (
              <div
                key={t.id}
                onClick={() => navigate(`/trails/${t.id}`)}
                className="card hover:border-gray-600 transition-colors cursor-pointer"
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-medium text-gray-200 truncate">{t.name}</h3>
                  {statusBadge(t.status)}
                </div>
                {t.description && (
                  <p className="text-xs text-gray-500 mb-3 line-clamp-2">{t.description}</p>
                )}
                <div className="flex items-center gap-2 flex-wrap mb-3">
                  {priorityBadge(t.priority)}
                  {t.branch && <span className="text-xs text-gray-500 font-mono bg-gray-800 px-1.5 py-0.5 rounded">{t.branch}</span>}
                  {labels.map((l, i) => (
                    <span key={i} className="badge-purple text-xs">{l}</span>
                  ))}
                </div>
                <div className="flex items-center justify-between text-xs text-gray-600 pt-2 border-t border-gray-800">
                  <span>{t.sessionCount} session{t.sessionCount !== 1 ? 's' : ''}</span>
                  <span>${(t.totalCost || 0).toFixed(2)}</span>
                  <span>{timeAgo(t.updatedAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
