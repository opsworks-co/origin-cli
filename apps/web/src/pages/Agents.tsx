import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { Agent } from '../api';
import { Plus, Trash2, X } from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/ui';
import AgentIcon, { AGENT_ACCENT } from '../components/AgentIcon';
import { useAuth } from '../context/AuthContext';

// New Agents page: a small catalog of natively-supported agents (Claude
// Code, Cursor, Gemini CLI, Codex CLI) that admins toggle on/off, plus
// a "Custom agents" section for in-house tooling. The catalog rows are
// pre-seeded for every org server-side; this page only flips
// `isEnabled`. Custom agents still flow through the create form, now in
// a modal, and are the only kind that can be deleted.

function fmtCurrency(n: number) {
  return n.toFixed(2);
}

function CatalogCard({
  agent,
  onToggle,
  onConfigure,
  isAdmin,
  toggling,
}: {
  agent: Agent;
  onToggle: (a: Agent) => void;
  onConfigure: (a: Agent) => void;
  isAdmin: boolean;
  toggling: boolean;
}) {
  const iconKey = (['claude-code', 'cursor', 'gemini', 'codex'] as const).find((k) => k === agent.slug) ?? 'custom';
  const accent = AGENT_ACCENT[iconKey] || 'text-gray-300';
  const enabled = agent.isEnabled;

  return (
    <div
      className={`rounded-lg border transition-all ${
        enabled
          ? 'border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14]/80 shadow-sm'
          : 'border-gray-200/70 dark:border-white/[0.05] bg-gray-50/40 dark:bg-[#0a0b14]/40'
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <div
          className={`w-10 h-10 rounded-md flex items-center justify-center flex-shrink-0 ring-1 ${
            enabled ? `${accent} ring-current/30` : 'text-gray-500 ring-gray-700/40'
          }`}
        >
          <AgentIcon iconKey={iconKey} size={28} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{agent.name}</h3>
            {agent.isCustom ? (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-700/40 text-gray-400">Custom</span>
            ) : (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">Catalog</span>
            )}
          </div>
          <p className="text-[12px] text-gray-500 mt-0.5">
            {agent.description || '—'}
            {agent.model && <span className="text-gray-600"> · {agent.model}</span>}
          </p>

          {enabled ? (
            <div className="mt-3 flex items-center gap-3 text-[11px] text-gray-500">
              <span>
                <span className="text-gray-300 font-medium">{agent.sessionsThisMonth ?? 0}</span> sessions
                <span className="text-gray-600"> this month</span>
              </span>
              <span>·</span>
              <span>
                <span className="text-gray-300 font-medium">${fmtCurrency(agent.costThisMonth ?? 0)}</span> spent
              </span>
              {agent.maxCostPerSession ? (
                <>
                  <span>·</span>
                  <span>${agent.maxCostPerSession}/session cap</span>
                </>
              ) : (
                <>
                  <span>·</span>
                  <span className="text-gray-600">No budget set</span>
                </>
              )}
            </div>
          ) : (
            <p className="mt-3 text-[11px] text-gray-500">
              Disabled — toggle on to start tracking sessions for this agent.
            </p>
          )}
        </div>

        {/* Toggle */}
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={() => onToggle(agent)}
            disabled={!isAdmin || toggling}
            aria-pressed={enabled}
            aria-label={enabled ? 'Disable' : 'Enable'}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              enabled ? 'bg-emerald-500' : 'bg-gray-700'
            } ${!isAdmin ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-5' : 'translate-x-1'
              }`}
            />
          </button>
          {enabled && (
            <button
              type="button"
              onClick={() => onConfigure(agent)}
              className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Configure →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CustomAgentRow({
  agent,
  onToggle,
  onDelete,
  isAdmin,
}: {
  agent: Agent;
  onToggle: (a: Agent) => void;
  onDelete: (a: Agent) => void;
  isAdmin: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-white/[0.05] last:border-b-0">
      <div className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 ring-1 ring-gray-700/40">
        <AgentIcon iconKey="custom" size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Link to={`/agents/${agent.id}`} className="text-sm font-medium text-gray-800 dark:text-gray-100 hover:text-indigo-300">
            {agent.name}
          </Link>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-700/40 text-gray-400">Custom</span>
        </div>
        <p className="text-[11px] text-gray-500 truncate">
          slug: <code className="text-gray-400">{agent.slug}</code>
          <span className="text-gray-600"> · {agent.model}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={() => onToggle(agent)}
        aria-pressed={agent.isEnabled}
        disabled={!isAdmin}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          agent.isEnabled ? 'bg-emerald-500' : 'bg-gray-700'
        } ${!isAdmin ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            agent.isEnabled ? 'translate-x-5' : 'translate-x-1'
          }`}
        />
      </button>
      {isAdmin && (
        <button
          type="button"
          onClick={() => onDelete(agent)}
          className="text-gray-500 hover:text-red-400 transition-colors"
          title="Delete custom agent"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const { toast } = useToast();
  const { activeOrg } = useAuth();
  const isAdmin = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN';

  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function fetchAgents() {
    setLoading(true);
    api.getAgents()
      .then((rows) => setAgents(rows))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { fetchAgents(); }, []);

  const { catalogAgents, customAgents } = useMemo(() => {
    // Order catalog rows by canonical slug order so the UI is stable
    // regardless of insert order in the DB.
    const order = ['claude-code', 'cursor', 'gemini', 'codex'];
    const cat = agents.filter((a) => !a.isCustom)
      .sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
    const cus = agents.filter((a) => a.isCustom);
    return { catalogAgents: cat, customAgents: cus };
  }, [agents]);

  async function handleToggle(a: Agent) {
    setToggling((p) => ({ ...p, [a.id]: true }));
    // Optimistic flip — revert on error.
    setAgents((prev) => prev.map((x) => x.id === a.id ? { ...x, isEnabled: !x.isEnabled } : x));
    try {
      await api.toggleAgent(a.id, !a.isEnabled);
    } catch (err: any) {
      setAgents((prev) => prev.map((x) => x.id === a.id ? { ...x, isEnabled: a.isEnabled } : x));
      toast('error', err?.message || 'Toggle failed');
    } finally {
      setToggling((p) => ({ ...p, [a.id]: false }));
    }
  }

  async function handleDelete(id: string) {
    setDeleteTarget(null);
    try {
      await api.deleteAgent(id);
      toast('success', 'Agent deleted');
      fetchAgents();
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    setSubmitting(true);
    try {
      await api.createAgent({
        name: formName,
        slug: formSlug,
        model: formModel,
        description: formDescription || undefined,
      });
      toast('success', 'Custom agent created');
      setShowCreate(false);
      setFormName(''); setFormSlug(''); setFormModel(''); setFormDescription('');
      fetchAgents();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agents"
        subtitle="Enable the agents your team uses. Origin tracks sessions for enabled agents automatically."
        actions={
          isAdmin && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] text-gray-700 dark:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add custom agent
            </button>
          )
        }
      />

      {error && (
        <div className="p-3 rounded-md border border-red-500/40 bg-red-500/10 text-red-300 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {catalogAgents.map((a) => (
              <CatalogCard
                key={a.id}
                agent={a}
                isAdmin={isAdmin}
                toggling={!!toggling[a.id]}
                onToggle={handleToggle}
                onConfigure={(x) => { window.location.href = `/agents/${x.id}`; }}
              />
            ))}
          </div>

          <div className="pt-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="flex-1 h-px bg-gray-200 dark:bg-white/[0.06]" />
              <span className="text-[11px] uppercase tracking-wider text-gray-500">Custom agents</span>
              <div className="flex-1 h-px bg-gray-200 dark:bg-white/[0.06]" />
            </div>
            {customAgents.length === 0 ? (
              <p className="text-center text-[12px] text-gray-500 py-4">
                No custom agents. {isAdmin && <button type="button" onClick={() => setShowCreate(true)} className="text-indigo-400 hover:text-indigo-300">Add one</button>} for in-house tooling.
              </p>
            ) : (
              <div className="rounded-lg border border-gray-200 dark:border-white/[0.08] overflow-hidden">
                {customAgents.map((a) => (
                  <CustomAgentRow
                    key={a.id}
                    agent={a}
                    isAdmin={isAdmin}
                    onToggle={handleToggle}
                    onDelete={(x) => setDeleteTarget({ id: x.id, name: x.name })}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-[#0a0b14] border border-gray-200 dark:border-white/[0.08] rounded-lg p-5 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Add custom agent</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-gray-300"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Name</label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => {
                    setFormName(e.target.value);
                    if (!formSlug || formSlug === slugify(formName)) setFormSlug(slugify(e.target.value));
                  }}
                  placeholder="My internal CLI"
                  className="w-full text-sm px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">
                  Slug <span className="text-gray-600">— must match what your CLI's hooks emit</span>
                </label>
                <input
                  type="text"
                  required
                  value={formSlug}
                  onChange={(e) => setFormSlug(slugify(e.target.value))}
                  pattern="[a-z0-9-]+"
                  placeholder="my-internal-cli"
                  className="w-full text-sm px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100 font-mono"
                />
                <p className="text-[10px] text-gray-500 mt-1">
                  Built-in slugs (claude-code, cursor, gemini, codex) are reserved.
                </p>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Default model</label>
                <input
                  type="text"
                  required
                  value={formModel}
                  onChange={(e) => setFormModel(e.target.value)}
                  placeholder="claude-sonnet-4-6"
                  className="w-full text-sm px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100 font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Description</label>
                <input
                  type="text"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="What this agent does"
                  className="w-full text-sm px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100"
                />
              </div>
              {formError && <p className="text-[12px] text-red-400">{formError}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={submitting || !formName || !formSlug || !formModel}
                  className="flex-1 text-sm font-medium px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
                >
                  {submitting ? 'Creating…' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="text-sm px-3 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] text-gray-700 dark:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete custom agent?"
        message={deleteTarget ? `"${deleteTarget.name}" will be removed and its sessions unlinked. Catalog agents can't be deleted — only disabled.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
