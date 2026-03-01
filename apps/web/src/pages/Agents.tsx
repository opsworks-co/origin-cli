import React, { useEffect, useState } from 'react';
import * as api from '../api';
import type { Agent } from '../api';

function timeAgo(dateStr: string | undefined): string {
  if (!dateStr) return 'Never';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add agent form
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formModel, setFormModel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete ${name}?`)) return;
    setDeleting((prev) => ({ ...prev, [id]: true }));
    try {
      await api.deleteAgent(id);
      fetchAgents();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeleting((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handleToggleStatus = async (agent: Agent) => {
    setToggling((prev) => ({ ...prev, [agent.id]: true }));
    try {
      await api.updateAgent(agent.id, { status: agent.status === 'active' ? 'INACTIVE' : 'ACTIVE' });
      fetchAgents();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setToggling((prev) => ({ ...prev, [agent.id]: false }));
    }
  };

  const fetchAgents = () => {
    setLoading(true);
    api
      .getAgents()
      .then(setAgents)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createAgent({ name: formName, slug: formSlug, model: formModel });
      setFormName('');
      setFormSlug('');
      setFormModel('');
      setShowForm(false);
      fetchAgents();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-sm text-gray-500 mt-1">Manage your AI coding agents</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary text-sm">
          {showForm ? 'Cancel' : 'Add Agent'}
        </button>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      {/* Inline form */}
      {showForm && (
        <form onSubmit={handleCreate} className="card space-y-4">
          <h3 className="font-semibold">New Agent</h3>
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name</label>
              <input
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="input"
                placeholder="My Claude Agent"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Slug</label>
              <input
                required
                value={formSlug}
                onChange={(e) => setFormSlug(e.target.value)}
                className="input"
                placeholder="my-claude-agent"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Model</label>
              <input
                required
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                className="input"
                placeholder="claude-sonnet-4-20250514"
              />
            </div>
          </div>
          <button type="submit" disabled={submitting} className="btn-primary text-sm">
            {submitting ? 'Creating...' : 'Create Agent'}
          </button>
        </form>
      )}

      {/* Agent cards */}
      {agents.length === 0 ? (
        <div className="card text-center py-12 text-gray-500">
          No agents configured yet. Add one to get started.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => {
            const isActive = agent.status === 'active';
            return (
              <div key={agent.id} className="card hover:border-gray-700 transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-green-500' : 'bg-gray-600'}`}
                    />
                    <button
                      onClick={() => handleToggleStatus(agent)}
                      disabled={toggling[agent.id]}
                      className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
                      title={isActive ? 'Deactivate agent' : 'Activate agent'}
                    >
                      {toggling[agent.id] ? '...' : isActive ? 'Active' : 'Inactive'}
                    </button>
                    <h3 className="font-semibold text-gray-100">{agent.name}</h3>
                  </div>
                </div>
                <div className="mb-3">
                  <span className="badge-blue">{agent.model}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-gray-500">Sessions</p>
                    <p className="text-gray-200 font-medium">{agent._count?.sessions ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Status</p>
                    <p className="text-gray-200 font-medium capitalize">{agent.status}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-gray-500">Created</p>
                    <p className="text-gray-200 font-medium">{timeAgo(agent.createdAt)}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(agent.id, agent.name)}
                  disabled={deleting[agent.id]}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors mt-3"
                >
                  {deleting[agent.id] ? 'Deleting...' : 'Delete Agent'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
