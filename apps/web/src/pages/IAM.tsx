import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';
import type { TeamMember } from '../api';
import { timeAgo } from '../utils';
import { Key, Users, Shield, RefreshCw, XCircle, Copy, Check, Plus } from 'lucide-react';

const ROLE_COLORS: Record<string, string> = {
  OWNER: 'badge-purple',
  ADMIN: 'badge-amber',
  MEMBER: 'badge-blue',
  VIEWER: 'badge-gray',
};

function roleBadge(role: string) {
  return <span className={ROLE_COLORS[role] ?? 'badge-gray'}>{role}</span>;
}

type ApiKeyEntry = {
  id: string; name: string; keyPrefix: string; createdAt: string;
  userId: string | null; role: string | null;
  user: { name: string; email: string } | null;
  repoScopes: { repoId: string; repoName: string }[];
  agentScopes: { agentId: string; agentName: string; agentSlug: string }[];
};

type AgentOption = { id: string; name: string; slug: string };
type RepoOption = { id: string; name: string };

export default function IAM() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'OWNER';

  // ── State ────────────────────────────────────────────────────────────────
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [allAgents, setAllAgents] = useState<AgentOption[]>([]);
  const [allRepos, setAllRepos] = useState<RepoOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add member modal
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState('MEMBER');
  const [adding, setAdding] = useState(false);
  const [generatedKey, setGeneratedKey] = useState('');

  // Key modal (regenerate result)
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyModalKey, setKeyModalKey] = useState('');
  const [keyModalName, setKeyModalName] = useState('');

  // Role editing
  const [editingRole, setEditingRole] = useState<string | null>(null);

  // Expanded member (shows key details)
  const [expandedMember, setExpandedMember] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);

  // ── Data loading ─────────────────────────────────────────────────────────
  const loadData = async () => {
    try {
      const [usersRes, keysRes, agentsRes, reposRes] = await Promise.allSettled([
        api.getUsers(),
        api.getApiKeys(),
        api.getAgents(),
        api.getRepos(),
      ]);
      if (usersRes.status === 'fulfilled') setMembers(usersRes.value.users);
      if (keysRes.status === 'fulfilled') setApiKeys(keysRes.value);
      if (agentsRes.status === 'fulfilled') setAllAgents((agentsRes.value as any[]).map((a) => ({ id: a.id, name: a.name, slug: a.slug })));
      if (reposRes.status === 'fulfilled') setAllRepos((reposRes.value as any[]).map((r) => ({ id: r.id, name: r.name })));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim() || !addEmail.trim()) return;
    setAdding(true);
    setError('');
    try {
      const res = await api.addMember({ name: addName, email: addEmail, role: addRole });
      setGeneratedKey(res.apiKey);
      loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleRegenerate = async (member: TeamMember) => {
    if (!confirm(`Regenerate API key for ${member.name}? Their current key will stop working.`)) return;
    try {
      const res = await api.regenerateKey(member.id);
      setKeyModalKey(res.apiKey);
      setKeyModalName(member.name);
      setShowKeyModal(true);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRevoke = async (member: TeamMember) => {
    if (!confirm(`Revoke all API keys for ${member.name}? They will lose access immediately.`)) return;
    try {
      await api.revokeKey(member.id);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRoleChange = async (memberId: string, newRole: string) => {
    try {
      await api.updateUserRole(memberId, newRole);
      setEditingRole(null);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRemove = async (member: TeamMember) => {
    if (!confirm(`Remove ${member.name} from the team? This will delete their account and all API keys.`)) return;
    try {
      await api.removeUser(member.id);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleGenerateKey = async (member: TeamMember, keyLabel?: string) => {
    // Map OWNER → ADMIN for API key roles (API keys only accept VIEWER/MEMBER/ADMIN)
    const keyRole = member.role === 'OWNER' ? 'ADMIN' : member.role;
    const label = keyLabel || `${member.name}'s key`;
    try {
      const res = await api.createApiKey({
        name: label,
        role: keyRole,
        agentIds: allAgents.map((a) => a.id), // Grant all agents by default
      });
      setKeyModalKey(res.key);
      setKeyModalName(member.name);
      setShowKeyModal(true);
      // Reload to show the new key
      const keysRes = await api.getApiKeys();
      setApiKeys(keysRes);
      loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to generate key');
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    if (!confirm('Delete this API key? It will stop working immediately.')) return;
    try {
      await api.deleteApiKey(keyId);
      const keysRes = await api.getApiKeys();
      setApiKeys(keysRes);
    } catch (err: any) {
      setError(err.message || 'Failed to delete key');
    }
  };

  const handleScopeToggle = async (keyId: string, type: 'agent' | 'repo', targetId: string, currentIds: string[], assigned: boolean) => {
    const newIds = assigned
      ? currentIds.filter((id) => id !== targetId)
      : [...currentIds, targetId];
    try {
      if (type === 'agent') {
        await api.updateApiKey(keyId, { agentIds: newIds });
      } else {
        await api.updateApiKey(keyId, { repoIds: newIds });
      }
      // Reload keys
      const keysRes = await api.getApiKeys();
      setApiKeys(keysRes);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Get ALL API keys for a member
  const getMemberKeys = (memberId: string) => apiKeys.filter((k) => k.userId === memberId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">IAM</h1>
          <p className="text-sm text-gray-500 mt-0.5">Team members, API keys, and access control</p>
        </div>
        {isAdmin && (
          <button
            onClick={() => { setShowAdd(true); setGeneratedKey(''); setAddName(''); setAddEmail(''); setAddRole('MEMBER'); }}
            className="btn-primary text-sm"
          >
            + Add Member
          </button>
        )}
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm p-3 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-300">×</button>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* ADD MEMBER MODAL                                                   */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowAdd(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {!generatedKey ? (
              <>
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Users className="w-5 h-5 text-indigo-400" />
                  Add Team Member
                </h2>
                <form onSubmit={handleAddMember} className="space-y-4">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Name</label>
                    <input
                      type="text"
                      value={addName}
                      onChange={(e) => setAddName(e.target.value)}
                      placeholder="John Doe"
                      className="input w-full"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Email</label>
                    <input
                      type="email"
                      value={addEmail}
                      onChange={(e) => setAddEmail(e.target.value)}
                      placeholder="john@company.com"
                      className="input w-full"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Role</label>
                    <select value={addRole} onChange={(e) => setAddRole(e.target.value)} className="input w-full">
                      <option value="VIEWER">Viewer — read-only access</option>
                      <option value="MEMBER">Member — can create sessions</option>
                      <option value="ADMIN">Admin — can manage team & policies</option>
                    </select>
                  </div>
                  <button type="submit" disabled={adding} className="btn-primary w-full text-sm">
                    {adding ? 'Creating...' : 'Add Member & Generate Key'}
                  </button>
                </form>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold mb-2 flex items-center gap-2 text-green-400">
                  <Check className="w-5 h-5" />
                  Member Added
                </h2>
                <p className="text-sm text-gray-400 mb-4">
                  Give this API key to <span className="text-gray-200 font-medium">{addName}</span>. They run <code className="text-indigo-400">origin login</code> and paste it.
                </p>
                <div className="bg-amber-900/20 border border-amber-800 rounded-lg p-4 mb-4">
                  <p className="text-xs text-amber-400 font-medium mb-2">This key is shown only once</p>
                  <div className="flex items-center gap-2">
                    <code className="text-sm text-gray-200 bg-gray-800 px-3 py-2 rounded flex-1 break-all font-mono">
                      {generatedKey}
                    </code>
                    <button
                      onClick={() => copyKey(generatedKey)}
                      className="btn-secondary text-xs px-3 py-2 flex items-center gap-1"
                    >
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3 text-xs text-gray-400 space-y-1">
                  <p><span className="text-gray-300">Developer setup:</span></p>
                  <p>1. Install: <code className="text-indigo-400">npm i -g https://getorigin.io/cli/origin-cli-latest.tgz</code></p>
                  <p>2. Login: <code className="text-indigo-400">origin login</code></p>
                  <p>3. Paste the API key above</p>
                  <p>4. Enable: <code className="text-indigo-400">origin init</code></p>
                </div>
              </>
            )}
            <button onClick={() => setShowAdd(false)} className="mt-4 text-sm text-gray-500 hover:text-gray-300 w-full text-center">
              Close
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* KEY REGENERATED MODAL                                              */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showKeyModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowKeyModal(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <RefreshCw className="w-5 h-5 text-indigo-400" />
              New Key for {keyModalName}
            </h2>
            <div className="bg-amber-900/20 border border-amber-800 rounded-lg p-4 mt-4">
              <p className="text-xs text-amber-400 font-medium mb-2">This key is shown only once</p>
              <div className="flex items-center gap-2">
                <code className="text-sm text-gray-200 bg-gray-800 px-3 py-2 rounded flex-1 break-all font-mono">
                  {keyModalKey}
                </code>
                <button
                  onClick={() => copyKey(keyModalKey)}
                  className="btn-secondary text-xs px-3 py-2 flex items-center gap-1"
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <button onClick={() => setShowKeyModal(false)} className="mt-4 text-sm text-gray-500 hover:text-gray-300 w-full text-center">
              Close
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* MEMBERS + KEYS TABLE                                               */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Member</th>
                <th className="px-6 py-3 font-medium">Role</th>
                <th className="px-6 py-3 font-medium">API Keys</th>
                <th className="px-6 py-3 font-medium text-right">Sessions</th>
                <th className="px-6 py-3 font-medium text-right">Cost</th>
                <th className="px-6 py-3 font-medium text-right">Last Active</th>
                {isAdmin && <th className="px-6 py-3 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {loading ? (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} className="px-6 py-12 text-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500 mx-auto" />
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} className="px-6 py-12 text-center text-gray-500">
                    No team members yet. Click "Add Member" to get started.
                  </td>
                </tr>
              ) : (
                members.map((m) => {
                  const memberKeys = getMemberKeys(m.id);
                  const isExpanded = expandedMember === m.id;
                  return (
                    <>
                      <tr
                        key={m.id}
                        className={`hover:bg-gray-800/30 transition-colors cursor-pointer ${isExpanded ? 'bg-gray-800/20' : ''}`}
                        onClick={() => setExpandedMember(isExpanded ? null : m.id)}
                      >
                        <td className="px-6 py-3">
                          <Link to={`/team/${m.id}`} className="flex items-center gap-3 group" onClick={(e) => e.stopPropagation()}>
                            <div className="w-8 h-8 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-400 text-sm font-medium flex-shrink-0">
                              {m.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-100 group-hover:text-indigo-400 transition-colors truncate">{m.name}</p>
                              <p className="text-xs text-gray-500 truncate">{m.email}</p>
                            </div>
                          </Link>
                        </td>
                        <td className="px-6 py-3">
                          {isAdmin && m.id !== user?.id && editingRole === m.id ? (
                            <select
                              value={m.role}
                              onChange={(e) => handleRoleChange(m.id, e.target.value)}
                              onBlur={() => setEditingRole(null)}
                              autoFocus
                              className="input text-xs py-1 px-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value="VIEWER">VIEWER</option>
                              <option value="MEMBER">MEMBER</option>
                              <option value="ADMIN">ADMIN</option>
                            </select>
                          ) : (
                            <span
                              onClick={(e) => {
                                if (isAdmin && m.id !== user?.id) {
                                  e.stopPropagation();
                                  setEditingRole(m.id);
                                }
                              }}
                              className={isAdmin && m.id !== user?.id ? 'cursor-pointer' : ''}
                              title={isAdmin && m.id !== user?.id ? 'Click to change role' : undefined}
                            >
                              {roleBadge(m.role)}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3" onClick={(e) => e.stopPropagation()}>
                          {memberKeys.length > 0 ? (
                            <div className="flex items-center gap-2">
                              <div className="flex flex-col gap-0.5">
                                {memberKeys.map((k) => (
                                  <div key={k.id} className="flex items-center gap-1.5">
                                    <Key className="w-3 h-3 text-green-500 flex-shrink-0" />
                                    <code className="text-xs text-gray-400">{k.keyPrefix}...</code>
                                    <span className="text-[9px] text-gray-600">{k.name}</span>
                                  </div>
                                ))}
                              </div>
                              {isAdmin && (
                                <button
                                  onClick={() => handleGenerateKey(m, `${m.name} key ${memberKeys.length + 1}`)}
                                  className="text-indigo-400/50 hover:text-indigo-400 transition-colors flex-shrink-0"
                                  title="Add another key"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          ) : m.keyPrefix ? (
                            <div className="flex items-center gap-1.5">
                              <Key className="w-3 h-3 text-green-500" />
                              <code className="text-xs text-gray-400">{m.keyPrefix}...</code>
                            </div>
                          ) : isAdmin ? (
                            <button
                              onClick={() => handleGenerateKey(m)}
                              className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
                            >
                              <Plus className="w-3 h-3" />
                              Generate Key
                            </button>
                          ) : (
                            <span className="text-xs text-red-400/60">No key</span>
                          )}
                        </td>
                        <td className="px-6 py-3 text-right text-gray-400">{m.sessions}</td>
                        <td className="px-6 py-3 text-right text-gray-300">${m.totalCost.toFixed(2)}</td>
                        <td className="px-6 py-3 text-right text-gray-500">{timeAgo(m.lastActive)}</td>
                        {isAdmin && (
                          <td className="px-6 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-2">
                              {m.id !== user?.id && (
                                <>
                                  <button
                                    onClick={() => handleRegenerate(m)}
                                    className="text-xs text-indigo-400/60 hover:text-indigo-400 transition-colors"
                                    title="Regenerate key"
                                  >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleRevoke(m)}
                                    className="text-xs text-amber-400/60 hover:text-amber-400 transition-colors"
                                    title="Revoke key"
                                  >
                                    <XCircle className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleRemove(m)}
                                    className="text-xs text-red-400/60 hover:text-red-400 transition-colors"
                                    title="Remove member"
                                  >
                                    Remove
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>

                      {/* Expanded: all keys with scopes */}
                      {isExpanded && isAdmin && memberKeys.length > 0 && (
                        <tr key={`${m.id}-scopes`} className="bg-gray-800/10">
                          <td colSpan={isAdmin ? 7 : 6} className="px-6 py-3">
                            <div className="space-y-4">
                              {memberKeys.map((mk) => (
                                <div key={mk.id} className="space-y-2 pb-3 border-b border-gray-800/50 last:border-0 last:pb-0">
                                  {/* Key header */}
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <Key className="w-3 h-3 text-green-500" />
                                      <code className="text-xs text-indigo-400">{mk.keyPrefix}...</code>
                                      <span className="text-[10px] text-gray-500">{mk.name}</span>
                                      <span className="text-[10px] text-gray-600">Created {new Date(mk.createdAt).toLocaleDateString()}</span>
                                    </div>
                                    <button
                                      onClick={() => handleDeleteKey(mk.id)}
                                      className="text-[10px] text-red-400/60 hover:text-red-400 transition-colors"
                                    >
                                      Delete
                                    </button>
                                  </div>
                                  {/* Agent scopes */}
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-gray-500 uppercase tracking-wider w-16">Agents</span>
                                    <div className="flex flex-wrap gap-1.5">
                                      {allAgents.map((a) => {
                                        const assigned = mk.agentScopes?.some((s) => s.agentId === a.id);
                                        return (
                                          <label
                                            key={a.id}
                                            className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded cursor-pointer transition-colors border ${
                                              assigned
                                                ? 'bg-indigo-900/40 text-indigo-300 border-indigo-700'
                                                : 'bg-gray-800/50 text-gray-600 border-gray-700 hover:border-gray-600'
                                            }`}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={assigned}
                                              onChange={() => handleScopeToggle(
                                                mk.id, 'agent', a.id,
                                                (mk.agentScopes || []).map((s) => s.agentId),
                                                !!assigned,
                                              )}
                                              className="sr-only"
                                            />
                                            {assigned ? '✓ ' : ''}{a.name}
                                          </label>
                                        );
                                      })}
                                      {allAgents.length === 0 && <span className="text-[10px] text-gray-600 italic">No agents configured</span>}
                                    </div>
                                  </div>
                                  {/* Repo scopes */}
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-gray-500 uppercase tracking-wider w-16">Repos</span>
                                    <div className="flex flex-wrap gap-1.5">
                                      {allRepos.map((r) => {
                                        const assigned = mk.repoScopes?.some((s) => s.repoId === r.id);
                                        return (
                                          <label
                                            key={r.id}
                                            className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded cursor-pointer transition-colors border ${
                                              assigned
                                                ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700'
                                                : 'bg-gray-800/50 text-gray-600 border-gray-700 hover:border-gray-600'
                                            }`}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={assigned}
                                              onChange={() => handleScopeToggle(
                                                mk.id, 'repo', r.id,
                                                (mk.repoScopes || []).map((s) => s.repoId),
                                                !!assigned,
                                              )}
                                              className="sr-only"
                                            />
                                            {assigned ? '✓ ' : ''}{r.name}
                                          </label>
                                        );
                                      })}
                                      {allRepos.length === 0 && <span className="text-[10px] text-gray-600 italic">No repos added</span>}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Users className="w-3.5 h-3.5" />
            Total Members
          </div>
          <div className="text-xl font-bold text-gray-100">{members.length}</div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Key className="w-3.5 h-3.5" />
            Active Keys
          </div>
          <div className="text-xl font-bold text-gray-100">{apiKeys.length}</div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Shield className="w-3.5 h-3.5" />
            Agents Available
          </div>
          <div className="text-xl font-bold text-gray-100">{allAgents.length}</div>
        </div>
      </div>
    </div>
  );
}
