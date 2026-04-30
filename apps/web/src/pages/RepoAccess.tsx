import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Lock } from 'lucide-react';
import * as api from '../api';
import type { RepoLevel, RepoMember, TeamMember } from '../api';
import { useAuth } from '../context/AuthContext';

// Per-repo Manage Access page. Lists who can read/write/admin this repo,
// distinguishing inherited (org OWNER/ADMIN) from explicit grants. Admins
// can add other org members and pick a level.

const LEVEL_LABEL: Record<RepoLevel, string> = {
  read: 'Read — view sessions, prompts, commits',
  write: 'Write — sync, configure, archive',
  admin: 'Admin — manage members, delete',
};

function levelBadgeColor(level: RepoLevel) {
  switch (level) {
    case 'admin': return 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40';
    case 'write': return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
    case 'read': default: return 'bg-gray-700/40 text-gray-300 border-gray-600/40';
  }
}

export default function RepoAccess() {
  const { id: repoId } = useParams<{ id: string }>();
  const { activeOrg } = useAuth();
  const [repoName, setRepoName] = useState<string>('');
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [allUsers, setAllUsers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string>('');
  const [pendingLevel, setPendingLevel] = useState<RepoLevel>('read');

  const canManage = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN';

  async function load() {
    if (!repoId) return;
    setLoading(true);
    setError(null);
    try {
      const [membersRes, usersRes, repos] = await Promise.all([
        api.getRepoMembers(repoId),
        api.getUsers(),
        api.getRepos(),
      ]);
      setMembers(membersRes.members);
      setAllUsers(usersRes.users);
      const repo = repos.find((r) => r.id === repoId);
      if (repo) setRepoName(repo.name);
    } catch (err: any) {
      setError(err?.message || 'Failed to load access list');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [repoId]);

  // Users in the org who are not yet members of this repo (and aren't org
  // owners/admins, who inherit and can't be downgraded here).
  const addableUsers = useMemo(() => {
    const memberIds = new Set(members.map((m) => m.id));
    return allUsers.filter((u) => !memberIds.has(u.id) && u.role !== 'OWNER' && u.role !== 'ADMIN');
  }, [allUsers, members]);

  async function handleAdd() {
    if (!repoId || !pendingUserId) return;
    setAdding(true);
    try {
      await api.setRepoMember(repoId, pendingUserId, pendingLevel);
      setPendingUserId('');
      setPendingLevel('read');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to grant access');
    } finally {
      setAdding(false);
    }
  }

  async function handleLevelChange(userId: string, level: RepoLevel) {
    if (!repoId) return;
    try {
      await api.setRepoMember(repoId, userId, level);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to update level');
    }
  }

  async function handleRemove(userId: string) {
    if (!repoId) return;
    if (!confirm('Revoke access for this user?')) return;
    try {
      await api.removeRepoMember(repoId, userId);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke access');
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link to="/repos" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300 mb-4">
        <ArrowLeft className="w-3.5 h-3.5" /> Repositories
      </Link>
      <h1 className="text-2xl font-bold text-gray-100">Manage access</h1>
      <p className="text-sm text-gray-500 mt-1">
        {repoName || repoId} · who can read, write, or admin this repo
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
              onChange={(e) => setPendingLevel(e.target.value as RepoLevel)}
              className="text-sm px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100"
            >
              <option value="read">Read</option>
              <option value="write">Write</option>
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
          {addableUsers.length === 0 && allUsers.length > 0 && (
            <p className="mt-2 text-[12px] text-gray-500">
              All non-admin org members already have explicit access. (Org owners/admins inherit access automatically.)
            </p>
          )}
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
                    onChange={(e) => handleLevelChange(m.id, e.target.value as RepoLevel)}
                    className="text-[12px] px-2 py-1 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100"
                  >
                    <option value="read">Read</option>
                    <option value="write">Write</option>
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
        <p><strong>Read</strong> — {LEVEL_LABEL.read}</p>
        <p><strong>Write</strong> — {LEVEL_LABEL.write}</p>
        <p><strong>Admin</strong> — {LEVEL_LABEL.admin}</p>
      </div>
    </div>
  );
}
