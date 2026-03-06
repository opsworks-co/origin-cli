import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';
import type { TeamMember, Invitation } from '../api';

const ROLE_COLORS: Record<string, string> = {
  OWNER: 'badge-purple',
  ADMIN: 'badge-amber',
  MEMBER: 'badge-blue',
  VIEWER: 'badge-gray',
};

function roleBadge(role: string) {
  return <span className={ROLE_COLORS[role] ?? 'badge-gray'}>{role}</span>;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export default function Team() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'OWNER';

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Invite modal state
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const [inviteLink, setInviteLink] = useState('');
  const [inviting, setInviting] = useState(false);

  // Role edit state
  const [editingRole, setEditingRole] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const [usersRes, invitesRes] = await Promise.all([
        api.getUsers(),
        isAdmin ? api.getInvites().catch(() => ({ invites: [] })) : Promise.resolve({ invites: [] }),
      ]);
      setMembers(usersRes.users);
      setInvites(invitesRes.invites);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setInviteLink('');
    try {
      const res = await api.createInvite({ email: inviteEmail || undefined, role: inviteRole });
      const baseUrl = window.location.origin;
      setInviteLink(`${baseUrl}/invite/${res.token}`);
      loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInviting(false);
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

  const handleCancelInvite = async (id: string) => {
    try {
      await api.cancelInvite(id);
      loadData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
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
            onClick={() => { setShowInvite(true); setInviteLink(''); setInviteEmail(''); setInviteRole('MEMBER'); }}
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

      {/* Invite Modal */}
      {showInvite && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowInvite(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">Invite Team Member</h2>
            <form onSubmit={handleInvite} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Email (optional)</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  className="input w-full"
                />
                <p className="text-xs text-gray-600 mt-1">Leave blank to create a generic invite link</p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Role</label>
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="input w-full">
                  <option value="VIEWER">Viewer — read-only access</option>
                  <option value="MEMBER">Member — can create sessions</option>
                  <option value="ADMIN">Admin — can manage team & policies</option>
                </select>
              </div>
              <button type="submit" disabled={inviting} className="btn-primary w-full text-sm">
                {inviting ? 'Creating...' : 'Create Invite Link'}
              </button>
            </form>
            {inviteLink && (
              <div className="mt-4 p-3 bg-gray-800 rounded-lg">
                <p className="text-xs text-gray-400 mb-2">Share this link with your teammate:</p>
                <div className="flex items-center gap-2">
                  <input type="text" readOnly value={inviteLink} className="input flex-1 text-xs font-mono" />
                  <button onClick={() => copyToClipboard(inviteLink)} className="btn-secondary text-xs px-3 py-2 whitespace-nowrap">
                    Copy
                  </button>
                </div>
                <p className="text-xs text-gray-600 mt-2">Expires in 7 days</p>
              </div>
            )}
            <button onClick={() => setShowInvite(false)} className="mt-3 text-sm text-gray-500 hover:text-gray-300 w-full text-center">
              Close
            </button>
          </div>
        </div>
      )}

      {/* Pending Invites */}
      {isAdmin && invites.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Pending Invites ({invites.length})</h3>
          <div className="space-y-2">
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between bg-gray-800/30 rounded-lg px-4 py-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-300">{inv.email || 'Open link'}</span>
                  {roleBadge(inv.role)}
                  <span className="text-xs text-gray-600">expires {timeAgo(inv.expiresAt).replace(' ago', '')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => copyToClipboard(`${window.location.origin}/invite/${inv.token}`)}
                    className="text-xs text-indigo-400 hover:text-indigo-300"
                  >
                    Copy link
                  </button>
                  <button
                    onClick={() => handleCancelInvite(inv.id)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ))}
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
                  <td colSpan={isAdmin ? 8 : 7} className="px-6 py-12 text-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500 mx-auto" />
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 8 : 7} className="px-6 py-12 text-center text-gray-500">
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
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRemove(m); }}
                            className="text-xs text-red-400/60 hover:text-red-400 transition-colors"
                            title="Remove member"
                          >
                            Remove
                          </button>
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
