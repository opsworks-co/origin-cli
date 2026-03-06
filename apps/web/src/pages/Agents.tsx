import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
  const [formDescription, setFormDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete ${name}? Sessions will be unlinked but not deleted.`)) return;
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
      const newStatus = agent.status.toUpperCase() === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
      await api.updateAgent(agent.id, { status: newStatus });
      fetchAgents();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setToggling((prev) => ({ ...prev, [agent.id]: false }));
    }
  };

  // Auto-generate slug from name
  const handleNameChange = (name: string) => {
    setFormName(name);
    if (!formSlug || formSlug === slugify(formName)) {
      setFormSlug(slugify(name));
    }
  };

  const slugify = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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
      await api.createAgent({
        name: formName,
        slug: formSlug,
        model: formModel,
        description: formDescription || undefined,
      });
      setFormName('');
      setFormSlug('');
      setFormModel('');
      setFormDescription('');
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
          <p className="text-sm text-gray-500 mt-1">Manage your AI coding agents and their configurations</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary text-sm">
          {showForm ? 'Cancel' : 'Add Agent'}
        </button>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 text-red-300 hover:text-red-200">&times;</button>
        </div>
      )}

      {/* Inline form */}
      {showForm && (
        <form onSubmit={handleCreate} className="card space-y-4">
          <h3 className="font-semibold">New Agent</h3>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name</label>
              <input
                required
                value={formName}
                onChange={(e) => handleNameChange(e.target.value)}
                className="input w-full"
                placeholder="My Claude Agent"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Slug</label>
              <input
                required
                value={formSlug}
                onChange={(e) => setFormSlug(e.target.value)}
                className="input w-full font-mono"
                placeholder="my-claude-agent"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Model</label>
              <input
                required
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                className="input w-full"
                placeholder="claude-sonnet-4-20250514"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Description (optional)</label>
              <input
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                className="input w-full"
                placeholder="Handles backend API development"
              />
            </div>
          </div>
          <p className="text-xs text-gray-500">
            You can configure system prompt, allowed tools, and permissions after creation on the agent detail page.
          </p>
          <button type="submit" disabled={submitting} className="btn-primary text-sm">
            {submitting ? 'Creating...' : 'Create Agent'}
          </button>
        </form>
      )}

      {/* Agent cards */}
      {agents.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-400 text-lg mb-2">No agents configured yet</p>
          <p className="text-gray-500 text-sm">Agents represent your AI coding assistants. Add one to start tracking sessions and managing configurations.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => {
            const isActive = agent.status.toUpperCase() === 'ACTIVE';
            return (
              <div key={agent.id} className="card hover:border-gray-700 transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <Link to={`/agents/${agent.id}`} className="group flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isActive ? 'bg-green-500' : 'bg-gray-600'}`}
                      />
                      <h3 className="font-semibold text-gray-100 group-hover:text-indigo-400 transition-colors">{agent.name}</h3>
                    </div>
                    <p className="text-xs text-gray-500 font-mono ml-[18px]">{agent.slug}</p>
                  </Link>
                  <button
                    onClick={() => handleToggleStatus(agent)}
                    disabled={toggling[agent.id]}
                    className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                      isActive
                        ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                    title={isActive ? 'Deactivate agent' : 'Activate agent'}
                  >
                    {toggling[agent.id] ? '...' : isActive ? 'Active' : 'Inactive'}
                  </button>
                </div>

                {agent.description && (
                  <p className="text-xs text-gray-400 mb-3 line-clamp-2">{agent.description}</p>
                )}

                <div className="mb-3">
                  <span className="badge-blue">{agent.model}</span>
                </div>

                <div className="grid grid-cols-3 gap-3 text-sm border-t border-gray-800 pt-3">
                  <div>
                    <p className="text-gray-500 text-xs">Sessions</p>
                    <p className="text-gray-200 font-medium">{agent._count?.sessions ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Versions</p>
                    <p className="text-gray-200 font-medium">{agent._count?.versions ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs">Updated</p>
                    <p className="text-gray-200 font-medium">{timeAgo(agent.updatedAt)}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-800">
                  <Link
                    to={`/agents/${agent.id}`}
                    className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    Configure &rarr;
                  </Link>
                  <button
                    onClick={() => handleDelete(agent.id, agent.name)}
                    disabled={deleting[agent.id]}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    {deleting[agent.id] ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
