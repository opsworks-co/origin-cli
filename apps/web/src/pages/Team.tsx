import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';
import type { TeamMember } from '../api';
import { timeAgo } from '../utils';

const ROLE_COLORS: Record<string, string> = {
  OWNER: 'badge-purple',
  ADMIN: 'badge-amber',
  MEMBER: 'badge-blue',
  VIEWER: 'badge-gray',
};

function roleBadge(role: string) {
  return <span className={ROLE_COLORS[role] ?? 'badge-gray'}>{role}</span>;
}

export default function Team() {
  const { user, activeOrg } = useAuth();
  const isAdmin = activeOrg?.role === 'ADMIN' || activeOrg?.role === 'OWNER';

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Invite modal state — GitHub-style email invite. The recipient gets
  // a link, signs up (or logs in), and joins this org as a separate user.
  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState('MEMBER');
  const [adding, setAdding] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ link: string | null; addedDirectly?: boolean; emailSent: boolean; emailError?: string; email: string } | null>(null);

  // Regenerate key modal state
  const [regenKey, setRegenKey] = useState('');
  const [regenMember, setRegenMember] = useState<TeamMember | null>(null);

  // Role edit state
  const [editingRole, setEditingRole] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);

  const loadData = async () => {
    try {
      const usersRes = await api.getUsers();
      setMembers(usersRes.users);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addEmail.trim()) return;
    setAdding(true);
    setInviteResult(null);
    try {
      const res = await api.createInvite({ email: addEmail.trim(), role: addRole });
      const link = res.added ? null : `${window.location.origin}/accept-invite/${res.token}`;
      setInviteResult({
        link,
        addedDirectly: res.added === true,
        emailSent: !!res.emailSent,
        emailError: res.emailError,
        email: addEmail.trim(),
      });
      loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAdding(false);
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
    if (!confirm(`Remove ${member.name} (${member.email}) from the team?`)) return;
    try {
      await api.removeUser(member.id);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRegenerateKey = async (member: TeamMember) => {
    if (!confirm(`Regenerate API key for ${member.name}? Their current key will stop working immediately.`)) return;
    try {
      const res = await api.regenerateKey(member.id);
      setRegenKey(res.apiKey);
      setRegenMember(member);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRevokeKey = async (member: TeamMember) => {
    if (!confirm(`Revoke all API keys for ${member.name}? They will no longer be able to access Origin.`)) return;
    try {
      await api.revokeKey(member.id);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const closeAddModal = () => {
    setShowAdd(false);
    setInviteResult(null);
    setAddEmail('');
    setAddRole('MEMBER');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Team</h1>
          <p className="text-sm text-gray-500 mt-1">Members of your organization</p>
        </div>
        {isAdmin && (
          <button
            onClick={() => { setShowAdd(true); setInviteResult(null); setAddEmail(''); setAddRole('MEMBER'); }}
            className="btn-primary text-sm"
          >
            + Invite Member
          </button>
        )}
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm p-3 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-300">×</button>
        </div>
      )}

      {/* Invite Member Modal — GitHub-style email invite. The recipient
          receives a link; signing up creates a personal Origin account
          they can later switch out of into this org. */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={closeAddModal}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1">Invite Member</h2>
            <p className="text-xs text-gray-500 mb-4">
              We'll email them a link to join {activeOrg?.name ?? 'your org'}. They can sign up or use an existing Origin account.
            </p>

            {!inviteResult ? (
              <form onSubmit={handleAddMember} className="space-y-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Email *</label>
                  <input
                    type="email"
                    value={addEmail}
                    onChange={(e) => setAddEmail(e.target.value)}
                    placeholder="jane@company.com"
                    className="input w-full"
                    required
                    autoFocus
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
                  {adding ? 'Sending invite...' : 'Send invite'}
                </button>
              </form>
            ) : (
              <div className="space-y-4">
                {inviteResult.addedDirectly ? (
                  <div className="p-3 bg-green-900/20 border border-green-800 rounded-lg">
                    <p className="text-sm text-green-400 font-medium mb-1">Added to the org</p>
                    <p className="text-xs text-green-400/80">
                      {inviteResult.email} already had an Origin account, so we added them directly. They'll see the org in their switcher next time they sign in.
                    </p>
                  </div>
                ) : inviteResult.emailSent ? (
                  <div className="p-3 bg-green-900/20 border border-green-800 rounded-lg">
                    <p className="text-sm text-green-400 font-medium mb-1">Invite sent</p>
                    <p className="text-xs text-green-400/80">An email is on its way to {inviteResult.email}.</p>
                  </div>
                ) : (
                  <div className="p-3 bg-amber-900/20 border border-amber-800/50 rounded-lg">
                    <p className="text-sm text-amber-300 font-medium mb-1">Invite created — email not delivered</p>
                    <p className="text-xs text-amber-400/80">{inviteResult.emailError || 'Email service is not configured.'} Share the link manually:</p>
                  </div>
                )}
                {inviteResult.link && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-2">Invite link (also in the email)</label>
                    <div className="p-3 bg-gray-800 rounded-lg font-mono text-xs text-gray-200 break-all select-all">
                      {inviteResult.link}
                    </div>
                    <button
                      onClick={() => copyToClipboard(inviteResult.link!)}
                      className="btn-secondary text-xs mt-2 w-full"
                    >
                      {copied ? 'Copied!' : 'Copy link'}
                    </button>
                  </div>
                )}
              </div>
            )}

            <button onClick={closeAddModal} className="mt-3 text-sm text-gray-500 hover:text-gray-300 w-full text-center">
              Close
            </button>
          </div>
        </div>
      )}

      {/* Regenerated Key Modal */}
      {regenKey && regenMember && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => { setRegenKey(''); setRegenMember(null); }}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">New API Key for {regenMember.name}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-2">API Key</label>
                <div className="p-3 bg-gray-800 rounded-lg font-mono text-sm text-gray-200 break-all select-all">
                  {regenKey}
                </div>
                <button
                  onClick={() => copyToClipboard(regenKey)}
                  className="btn-secondary text-xs mt-2 w-full"
                >
                  {copied ? 'Copied!' : 'Copy to Clipboard'}
                </button>
              </div>
              <div className="p-3 bg-amber-900/20 border border-amber-800/50 rounded-lg">
                <p className="text-xs text-amber-400">
                  Give this key to the developer. They run <code className="bg-gray-800 px-1.5 py-0.5 rounded text-amber-300">origin login</code> and paste it. This key is shown only once.
                </p>
              </div>
            </div>
            <button onClick={() => { setRegenKey(''); setRegenMember(null); }} className="mt-3 text-sm text-gray-500 hover:text-gray-300 w-full text-center">
              Close
            </button>
          </div>
        </div>
      )}

      {/* Members Table */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Member</th>
                <th className="px-6 py-3 font-medium">Role</th>
                <th className="px-6 py-3 font-medium">API Key</th>
                <th className="px-6 py-3 font-medium text-right">Sessions</th>
                <th className="px-6 py-3 font-medium text-right">Reviews</th>
                <th className="px-6 py-3 font-medium text-right">Cost</th>
                <th className="px-6 py-3 font-medium text-right">Lines</th>
                <th className="px-6 py-3 font-medium text-right">Last Active</th>
                {isAdmin && <th className="px-6 py-3 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {loading ? (
                <tr>
                  <td colSpan={isAdmin ? 9 : 8} className="px-6 py-12 text-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500 mx-auto" />
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 9 : 8} className="px-6 py-12 text-center text-gray-500">
                    No team members found
                  </td>
                </tr>
              ) : (
                members.map((m) => (
                  <tr key={m.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-6 py-3">
                      <Link to={`/team/${m.id}`} className="flex items-center gap-3 group">
                        <div className="w-8 h-8 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-400 text-sm font-medium flex-shrink-0">
                          {m.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-100 group-hover:text-indigo-400 transition-colors truncate">
                            {m.name}
                          </p>
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
                        >
                          <option value="VIEWER">VIEWER</option>
                          <option value="MEMBER">MEMBER</option>
                          <option value="ADMIN">ADMIN</option>
                          <option value="OWNER">OWNER</option>
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
                    <td className="px-6 py-3">
                      {m.keyPrefix ? (
                        <code className="text-xs font-mono text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
                          {m.keyPrefix}...
                        </code>
                      ) : (
                        <span className="text-xs text-gray-600">None</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-400">{m.sessions}</td>
                    <td className="px-6 py-3 text-right text-gray-400">{m.reviews}</td>
                    <td className="px-6 py-3 text-right text-gray-300">${m.totalCost.toFixed(2)}</td>
                    <td className="px-6 py-3 text-right text-gray-400">
                      {m.linesAdded > 0 ? `+${m.linesAdded.toLocaleString()}` : '0'}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-500">{timeAgo(m.lastActive)}</td>
                    {isAdmin && (
                      <td className="px-6 py-3 text-right">
                        {m.id !== user?.id && (
                          <div className="flex items-center justify-end gap-3">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRegenerateKey(m); }}
                              className="text-xs text-indigo-400/70 hover:text-indigo-400 transition-colors"
                              title="Regenerate API key"
                            >
                              Regenerate Key
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRevokeKey(m); }}
                              className="text-xs text-amber-400/70 hover:text-amber-400 transition-colors"
                              title="Revoke API key"
                            >
                              Revoke Key
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRemove(m); }}
                              className="text-xs text-red-400/60 hover:text-red-400 transition-colors"
                              title="Remove member"
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
