import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { Agent } from '../api';
import { timeAgo } from '../utils';
import { Bot, Plus, Settings, Trash2, Power } from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { PageHeader, Pill, EmptyState } from '../components/ui';

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
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const { toast } = useToast();

  const handleDelete = async (id: string) => {
    setDeleteTarget(null);
    setDeleting((prev) => ({ ...prev, [id]: true }));
    try {
      await api.deleteAgent(id);
      toast('success', 'Agent deleted');
      fetchAgents();
    } catch (err: any) {
      toast('error', err.message);
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
      <PageHeader
        title="Agents"
        subtitle="Manage your AI coding agents and their configurations"
        actions={
          <button onClick={() => setShowForm(!showForm)} className={`${showForm ? 'btn-secondary' : 'btn-primary'} text-sm flex items-center gap-2`}>
            {showForm ? (
              'Cancel'
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Add Agent
              </>
            )}
          </button>
        }
      />

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
              <select
                required
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                className="input w-full"
              >
                <option value="">Select a model...</option>
                <optgroup label="Anthropic">
                  <option value="claude-sonnet-4">Claude Sonnet 4</option>
                  <option value="claude-opus-4">Claude Opus 4</option>
                  <option value="claude-haiku-3.5">Claude Haiku 3.5</option>
                </optgroup>
                <optgroup label="OpenAI">
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="gpt-4.1">GPT-4.1</option>
                  <option value="o3">o3</option>
                </optgroup>
                <optgroup label="Google">
                  <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                </optgroup>
                <optgroup label="Other">
                  <option value="custom">Custom</option>
                </optgroup>
              </select>
              <p className="text-[11px] text-gray-600 mt-1">The LLM this agent uses. For tracking and cost estimation.</p>
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
        <div className="card p-0">
          <EmptyState
            icon={<Bot className="w-5 h-5" />}
            title="No agents configured yet"
            description="Agents represent your AI coding assistants. Add one to start tracking sessions and managing configurations."
          />
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => {
            const isActive = agent.status.toUpperCase() === 'ACTIVE';
            return (
              <div key={agent.id} className="card hover:border-white/[0.1] transition-all duration-150 group/card">
                <div className="flex items-start justify-between mb-3">
                  <Link to={`/agents/${agent.id}`} className="group flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        isActive ? 'bg-indigo-500/10 text-indigo-400' : 'bg-white/[0.04] text-gray-500'
                      }`}>
                        <Bot className="w-[18px] h-[18px]" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-semibold text-gray-100 group-hover:text-indigo-400 transition-colors truncate">{agent.name}</h3>
                        <p className="text-[11px] text-gray-500 font-mono truncate">{agent.slug}</p>
                      </div>
                    </div>
                  </Link>
                  <button
                    onClick={() => handleToggleStatus(agent)}
                    disabled={toggling[agent.id]}
                    title={isActive ? 'Deactivate agent' : 'Activate agent'}
                    className="transition-all duration-150"
                  >
                    <Pill
                      variant={isActive ? 'success' : 'neutral'}
                      icon={<Power className="w-3 h-3" />}
                    >
                      {toggling[agent.id] ? '...' : isActive ? 'Active' : 'Inactive'}
                    </Pill>
                  </button>
                </div>

                {agent.description && (
                  <p className="text-xs text-gray-400 mb-3 line-clamp-2 ml-12">{agent.description}</p>
                )}

                <div className="mb-3 ml-12">
                  <span className="badge-blue">{agent.model}</span>
                </div>

                <div className="grid grid-cols-3 gap-3 text-sm border-t border-white/[0.06] pt-3 mt-1">
                  <div>
                    <p className="text-[11px] text-gray-500">Sessions</p>
                    <p className="text-gray-200 font-medium">{agent._count?.sessions ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-500">Versions</p>
                    <p className="text-gray-200 font-medium">{agent._count?.versions ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-500">Updated</p>
                    <p className="text-gray-200 font-medium">{timeAgo(agent.updatedAt)}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/[0.06]">
                  <Link
                    to={`/agents/${agent.id}`}
                    className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    Configure
                  </Link>
                  <button
                    onClick={() => setDeleteTarget({ id: agent.id, name: agent.name })}
                    disabled={deleting[agent.id]}
                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-400 transition-colors opacity-0 group-hover/card:opacity-100"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {deleting[agent.id] ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Agent"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? Sessions will be unlinked but not deleted.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
