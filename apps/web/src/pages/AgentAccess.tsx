import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Lock } from 'lucide-react';
import * as api from '../api';
import type { AgentLevel, AgentMember, TeamMember } from '../api';
import { useAuth } from '../context/AuthContext';

// Per-agent Manage Access page. Mirrors RepoAccess but with the simpler
// 'use' / 'admin' level scheme. 'use' lets a user run sessions with the
// agent; 'admin' lets them edit it and manage its members.

const LEVEL_LABEL: Record<AgentLevel, string> = {
  use: 'Use — run sessions with this agent',
  admin: 'Admin — edit config, manage access',
};

function levelBadgeColor(level: AgentLevel) {
  return level === 'admin'
    ? 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40'
    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
}

export default function AgentAccess() {
  const { id: agentId } = useParams<{ id: string }>();
  const { activeOrg } = useAuth();
  const [agentName, setAgentName] = useState<string>('');
  const [members, setMembers] = useState<AgentMember[]>([]);
  const [allUsers, setAllUsers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string>('');
  const [pendingLevel, setPendingLevel] = useState<AgentLevel>('use');

  const canManage = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN';

  async function load() {
    if (!agentId) return;
    setLoading(true);
    setError(null);
    try {
      const [membersRes, usersRes, agents] = await Promise.all([
        api.getAgentMembers(agentId),
        api.getUsers(),
        api.getAgents(),
      ]);
      setMembers(membersRes.members);
      setAllUsers(usersRes.users);
      const agent = agents.find((a) => a.id === agentId);
      if (agent) setAgentName(agent.name);
    } catch (err: any) {
      setError(err?.message || 'Failed to load access list');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [agentId]);

  const addableUsers = useMemo(() => {
    const memberIds = new Set(members.map((m) => m.id));
    return allUsers.filter((u) => !memberIds.has(u.id) && u.role !== 'OWNER' && u.role !== 'ADMIN');
  }, [allUsers, members]);

  async function handleAdd() {
    if (!agentId || !pendingUserId) return;
    setAdding(true);
    try {
      await api.setAgentMember(agentId, pendingUserId, pendingLevel);
      setPendingUserId('');
      setPendingLevel('use');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to grant access');
    } finally {
      setAdding(false);
    }
  }

  async function handleLevelChange(userId: string, level: AgentLevel) {
    if (!agentId) return;
    try {
      await api.setAgentMember(agentId, userId, level);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to update level');
    }
  }

  async function handleRemove(userId: string) {
    if (!agentId) return;
    if (!confirm('Revoke access for this user?')) return;
    try {
      await api.removeAgentMember(agentId, userId);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke access');
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link to="/agents" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300 mb-4">
        <ArrowLeft className="w-3.5 h-3.5" /> Agents
      </Link>
      <h1 className="text-2xl font-bold text-gray-100">Manage access</h1>
      <p className="text-sm text-gray-500 mt-1">
        {agentName || agentId} · who can use or admin this agent
      </p>

      {error && (
        <div className="mt-4 p-3 rounded-md border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
          {error}
        </div>
      )}

      {canManage && (
        <div className="mt-6 p-4 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14]/60">
          <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-3">Add a member</h2>
          <div className="flex flex-wrap gap-2">
            <select
              value={pendingUserId}
              onChange={(e) => setPendingUserId(e.target.value)}
              className="text-sm px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100 min-w-[240px]"
            >
              <option value="">Pick a user…</option>
              {addableUsers.map((u) => (
                <option key={u.id} value={u.id}>{u.name} · {u.email}</option>
              ))}
            </select>
            <select
              value={pendingLevel}
              onChange={(e) => setPendingLevel(e.target.value as AgentLevel)}
              className="text-sm px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100"
            >
              <option value="use">Use</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!pendingUserId || adding}
              className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Grant access
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 rounded-lg border border-gray-200 dark:border-white/[0.08] overflow-hidden">
        <div className="grid grid-cols-[1fr_140px_120px] gap-3 px-4 py-2 text-[11px] uppercase tracking-wider text-gray-500 border-b border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-[#0a0b14]/60">
          <div>Member</div>
          <div>Level</div>
          <div className="text-right">Actions</div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-sm text-gray-500">Loading…</div>
        ) : members.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">No members yet.</div>
        ) : (
          members.map((m) => (
            <div key={m.id} className="grid grid-cols-[1fr_140px_120px] gap-3 px-4 py-3 items-center border-b border-gray-200 dark:border-white/[0.05] last:border-b-0">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500/25 to-indigo-600/15 ring-1 ring-indigo-500/25 flex items-center justify-center text-indigo-600 dark:text-indigo-300 text-[12px] font-semibold flex-shrink-0">
                  {m.name?.charAt(0).toUpperCase() ?? '?'}
                </div>
                <div className="min-w-0">
                  <div className="text-sm text-gray-800 dark:text-gray-100 truncate flex items-center gap-1.5">
                    {m.name}
                    {m.inherited && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-gray-500">
                        <Lock className="w-2.5 h-2.5" /> inherited
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500 truncate">{m.email}{m.orgRole ? ` · org ${m.orgRole.toLowerCase()}` : ''}</div>
                </div>
              </div>
              <div>
                {m.inherited || !canManage ? (
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${levelBadgeColor(m.level)}`}>
                    {m.level}
                  </span>
                ) : (
                  <select
                    value={m.level}
                    onChange={(e) => handleLevelChange(m.id, e.target.value as AgentLevel)}
                    className="text-[12px] px-2 py-1 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100"
                  >
                    <option value="use">Use</option>
                    <option value="admin">Admin</option>
                  </select>
                )}
              </div>
              <div className="text-right">
                {!m.inherited && canManage && (
                  <button
                    type="button"
                    onClick={() => handleRemove(m.id)}
                    className="inline-flex items-center gap-1 text-[12px] text-gray-500 hover:text-red-400 transition-colors"
                    title="Revoke access"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-6 text-[12px] text-gray-500 space-y-1">
        <p><strong>Use</strong> — {LEVEL_LABEL.use}</p>
        <p><strong>Admin</strong> — {LEVEL_LABEL.admin}</p>
      </div>
    </div>
  );
}
