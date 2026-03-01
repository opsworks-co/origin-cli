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
  const [formModel, setFormModel] = useState('');
  const [formProvider, setFormProvider] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
      await api.createAgent({ name: formName, model: formModel, provider: formProvider || undefined });
      setFormName('');
      setFormModel('');
      setFormProvider('');
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
              <label className="block text-sm text-gray-400 mb-1">Model</label>
              <input
                required
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                className="input"
                placeholder="claude-sonnet-4-20250514"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Provider</label>
              <input
                value={formProvider}
                onChange={(e) => setFormProvider(e.target.value)}
                className="input"
                placeholder="anthropic"
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
            const isActive =
              agent.lastActiveAt &&
              Date.now() - new Date(agent.lastActiveAt).getTime() < 1000 * 60 * 60;
            return (
              <div key={agent.id} className="card hover:border-gray-700 transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-green-500' : 'bg-gray-600'}`}
                    />
                    <h3 className="font-semibold text-gray-100">{agent.name}</h3>
                  </div>
                </div>
                <div className="mb-3">
                  <span className="badge-blue">{agent.model}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-gray-500">Sessions</p>
                    <p className="text-gray-200 font-medium">{agent.totalSessions}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Total Cost</p>
                    <p className="text-gray-200 font-medium">${agent.totalCost.toFixed(2)}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-gray-500">Last Active</p>
                    <p className="text-gray-200 font-medium">{timeAgo(agent.lastActiveAt)}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
