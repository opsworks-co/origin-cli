import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';
import type { TeamMember } from '../api';
import { timeAgo } from '../utils';
import { Key, Users, Shield, RefreshCw, XCircle, Copy, Check, Plus, ChevronDown, Terminal, Sparkles, Mail } from 'lucide-react';
import { PageHeader } from '../components/ui';

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
  const { user, activeOrg } = useAuth();
  const isAdmin = activeOrg?.role === 'ADMIN' || activeOrg?.role === 'OWNER';

  // ── State ────────────────────────────────────────────────────────────────
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  // Pending invites — admins issue an invite via "Invite Member" but until
  // the invitee accepts, no Membership row exists, so /api/users (members)
  // doesn't include them. We fetch /api/users/invites separately and
  // render those as pending rows above the active members so the admin can
  // see "I sent it, here's the status" without leaving IAM.
  const [pendingInvites, setPendingInvites] = useState<api.Invitation[]>([]);
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);
  const [allAgents, setAllAgents] = useState<AgentOption[]>([]);
  const [allRepos, setAllRepos] = useState<RepoOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Invite-by-email modal — GitHub-style: recipient gets a link, signs up
  // (or logs in) on their own, joins this org as a separate user profile
  // they can switch into/out of from the sidebar org switcher.
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ link: string | null; addedDirectly?: boolean; emailSent: boolean; emailError?: string; email: string; grantCount: number } | null>(null);
  // Two-step modal: 'form' = email + role; 'permissions' = pre-stage repo
  // and agent grants the new member will receive when they accept the
  // invite. Result screen ('result') replaces both once the POST succeeds.
  type InviteStep = 'form' | 'permissions';
  const [inviteStep, setInviteStep] = useState<InviteStep>('form');
  const [invitePendingRepos, setInvitePendingRepos] = useState<Record<string, 'read' | 'write' | 'admin'>>({});
  const [invitePendingAgents, setInvitePendingAgents] = useState<Record<string, 'use' | 'admin'>>({});

  // Add member modal (legacy direct-add flow with auto-generated API key —
  // kept as a secondary action for admins who want to skip the email loop).
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState('MEMBER');
  // Scope the new key at creation time. agentIds defaults to "all agents"
  // so admins don't have to manually select every one for the common case;
  // empty repoIds = all repos.
  const [addAgentIds, setAddAgentIds] = useState<string[]>([]);
  const [addRepoIds, setAddRepoIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [generatedKey, setGeneratedKey] = useState('');

  // Key modal (regenerate result)
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyModalKey, setKeyModalKey] = useState('');
  const [keyModalName, setKeyModalName] = useState('');

  // Generate key modal with scope selection
  const [showGenerate, setShowGenerate] = useState(false);
  const [genMember, setGenMember] = useState<TeamMember | null>(null);
  const [genKeyName, setGenKeyName] = useState('');
  const [genAgentIds, setGenAgentIds] = useState<string[]>([]);
  const [genRepoIds, setGenRepoIds] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);

  // Role editing
  const [editingRole, setEditingRole] = useState<string | null>(null);

  // Expanded members (shows key details) — supports multiple expanded at once
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set());

  const [copied, setCopied] = useState(false);

  // Remove-member confirmation modal — tracks which member is being
  // removed and whether the admin also opted into purging their
  // org-scoped data (sessions / reviews / repo + agent grants). Default
  // is off; purge is destructive and rarely the right call.
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null);
  const [removePurge, setRemovePurge] = useState(false);
  const [removing, setRemoving] = useState(false);

  // ── Data loading ─────────────────────────────────────────────────────────
  const loadData = async () => {
    try {
      const [usersRes, keysRes, agentsRes, reposRes, invitesRes] = await Promise.allSettled([
        api.getUsers(),
        api.getApiKeys(),
        api.getAgents(),
        api.getRepos(),
        // Pending invites — non-admins get a 403 here; allSettled means
        // their page still renders without the pending block.
        api.getInvites(),
      ]);
      if (usersRes.status === 'fulfilled') setMembers(usersRes.value.users);
      if (keysRes.status === 'fulfilled') setApiKeys(keysRes.value);
      if (agentsRes.status === 'fulfilled') setAllAgents((agentsRes.value as any[]).map((a) => ({ id: a.id, name: a.name, slug: a.slug })));
      if (reposRes.status === 'fulfilled') setAllRepos((reposRes.value as any[]).map((r) => ({ id: r.id, name: r.name })));
      if (invitesRes.status === 'fulfilled') setPendingInvites(invitesRes.value.invites);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Revoke a pending invite. Optimistic remove from the list — the
  // backend cancels the token; if the call fails we put the row back.
  const handleRevokeInvite = async (inv: api.Invitation) => {
    setRevokingInviteId(inv.id);
    const prev = pendingInvites;
    setPendingInvites((list) => list.filter((i) => i.id !== inv.id));
    try {
      await api.cancelInvite(inv.id);
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke invite');
      setPendingInvites(prev);
    } finally {
      setRevokingInviteId(null);
    }
  };

  useEffect(() => { loadData(); }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────
  // Step 1 → step 2: validate email and advance. The actual POST happens
  // from the permission step so the invite + pre-staged grants are
  // created in a single atomic call (server validates org membership of
  // every grant id).
  const handleInviteContinue = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setError('');
    setInviteStep('permissions');
  };

  // Step 2 submit: build pendingGrants from selection state and POST.
  const handleInviteSubmit = async () => {
    setInviting(true);
    setError('');
    setInviteResult(null);
    try {
      const repos = Object.entries(invitePendingRepos).map(([id, level]) => ({ id, level }));
      const agents = Object.entries(invitePendingAgents).map(([id, level]) => ({ id, level }));
      const res = await api.createInvite({
        email: inviteEmail.trim(),
        role: inviteRole,
        pendingGrants: (repos.length > 0 || agents.length > 0) ? { repos, agents } : undefined,
      });
      const link = res.added ? null : `${window.location.origin}/accept-invite/${res.token}`;
      setInviteResult({
        link,
        addedDirectly: res.added === true,
        emailSent: !!res.emailSent,
        emailError: res.emailError,
        email: inviteEmail.trim(),
        grantCount: repos.length + agents.length,
      });
      // Refresh the page state so the new invite shows up as a Pending row
      // immediately. Without this, the admin sees "invite created" in the
      // modal but the IAM table doesn't reflect it until they reload.
      loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInviting(false);
    }
  };

  // Resets every piece of invite-modal state when the admin closes the
  // modal — otherwise the next invite remembers the previous email/grants.
  const closeInviteModal = () => {
    setShowInvite(false);
    setInviteStep('form');
    setInviteEmail('');
    setInviteRole('MEMBER');
    setInvitePendingRepos({});
    setInvitePendingAgents({});
    setInviteResult(null);
    setError('');
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim() || !addEmail.trim()) return;
    if (addAgentIds.length === 0) {
      setError('Select at least one agent — the API key won\'t work without agent access.');
      return;
    }
    setAdding(true);
    setError('');
    try {
      const res = await api.addMember({
        name: addName,
        email: addEmail,
        role: addRole,
        // Empty repoIds means "all repos"; agentIds is required.
        agentIds: addAgentIds,
        repoIds: addRepoIds.length > 0 ? addRepoIds : undefined,
      });
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

  // Two-state confirmation: open a dialog with an optional "also delete
  // their data" toggle. Default off — most admins just want to revoke
  // access without erasing the team's record of work this person did.
  const handleRemove = (member: TeamMember) => {
    setRemoveTarget(member);
    setRemovePurge(false);
  };
  const performRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.removeUser(removeTarget.id, { purgeData: removePurge });
      setRemoveTarget(null);
      loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRemoving(false);
    }
  };

  const openGenerateKey = (member: TeamMember, keyLabel?: string) => {
    setGenMember(member);
    setGenKeyName(keyLabel || `${member.name}'s key`);
    setGenAgentIds(allAgents.map((a) => a.id)); // All agents selected by default
    setGenRepoIds([]); // Empty = all repos
    setShowGenerate(true);
  };

  const handleGenerateKey = async () => {
    if (!genMember) return;
    const keyRole = genMember.role === 'OWNER' ? 'ADMIN' : genMember.role;
    setGenerating(true);
    try {
      const res = await api.createApiKey({
        name: genKeyName,
        role: keyRole,
        agentIds: genAgentIds,
        repoIds: genRepoIds.length > 0 ? genRepoIds : undefined,
        // Without targetUserId the API silently issued the key to the
        // current admin instead of the member named in the modal.
        targetUserId: genMember.id,
      });
      setShowGenerate(false);
      setKeyModalKey(res.key);
      setKeyModalName(genMember.name);
      setShowKeyModal(true);
      const keysRes = await api.getApiKeys();
      setApiKeys(keysRes);
      loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to generate key');
    } finally {
      setGenerating(false);
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
  // Standalone keys not assigned to any user
  const standaloneKeys = apiKeys.filter((k) => !k.userId);
  const [showStandaloneKeys, setShowStandaloneKeys] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="IAM"
        subtitle="Team members, API keys, and access control"
        actions={isAdmin ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowAdd(true);
                setGeneratedKey('');
                setAddName('');
                setAddEmail('');
                setAddRole('MEMBER');
                setAddAgentIds(allAgents.map((a) => a.id));
                setAddRepoIds([]);
              }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              title="Skip the email and create a member with an API key right now"
            >
              Add directly
            </button>
            <button
              onClick={() => {
                setShowInvite(true);
                setInviteResult(null);
                setInviteEmail('');
                setInviteRole('MEMBER');
              }}
              className="btn-primary text-sm flex items-center gap-1.5"
            >
              <Mail className="w-3.5 h-3.5" />
              Invite Member
            </button>
          </div>
        ) : undefined}
      />

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm p-3 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-300">×</button>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* REMOVE MEMBER CONFIRMATION                                         */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {removeTarget && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => !removing && setRemoveTarget(null)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h2 className="text-lg font-semibold text-gray-100">Remove {removeTarget.name}?</h2>
              <p className="text-xs text-gray-500 mt-1">
                They lose access to {activeOrg?.name ?? 'this org'} immediately. Their API keys for this org are revoked. They can be re-invited later.
              </p>
            </div>

            <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              removePurge ? 'border-red-500/50 bg-red-500/[0.05]' : 'border-gray-800 hover:border-gray-700'
            }`}>
              <input
                type="checkbox"
                checked={removePurge}
                onChange={(e) => setRemovePurge(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-gray-600 bg-gray-800 text-red-600 focus:ring-red-500"
              />
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${removePurge ? 'text-red-300' : 'text-gray-200'}`}>
                  Also delete their data in this org
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Deletes their sessions, reviews, and repo / agent grants in {activeOrg?.name ?? 'this org'}. Sessions in other orgs they belong to stay intact. <span className="text-amber-300">Cannot be undone.</span>
                </p>
              </div>
            </label>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                disabled={removing}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-300 hover:text-gray-100 hover:bg-gray-800/60 border border-gray-800 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={performRemove}
                disabled={removing}
                className={`flex-1 px-4 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  removePurge
                    ? 'bg-red-600 hover:bg-red-500 text-white'
                    : 'bg-amber-600 hover:bg-amber-500 text-white'
                }`}
              >
                {removing ? 'Removing…' : removePurge ? 'Remove + delete data' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* INVITE MEMBER MODAL (GitHub-style email invite)                    */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showInvite && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={closeInviteModal}>
          <div
            className={`bg-gray-900 border border-gray-700 rounded-xl p-6 w-full shadow-2xl ${
              inviteStep === 'permissions' && !inviteResult ? 'max-w-2xl' : 'max-w-md'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
              <Mail className="w-5 h-5 text-indigo-400" />
              Invite Member
              {!inviteResult && (
                <span className="ml-auto text-[10px] uppercase tracking-wider text-gray-500 font-normal">
                  Step {inviteStep === 'form' ? '1' : '2'} of 2
                </span>
              )}
            </h2>
            <p className="text-xs text-gray-500 mb-4">
              {inviteResult
                ? `Sent to ${inviteResult.email}.`
                : inviteStep === 'form'
                  ? `We'll email them a link to join ${activeOrg?.name ?? 'your org'}. They sign up (or use an existing Origin account) and the org appears in their sidebar switcher.`
                  : 'Pre-stage repo and agent access — applied automatically when they accept the invite. You can also leave everything blank and grant access later.'}
            </p>

            {/* ─── STEP 1: email + role ──────────────────────────────────── */}
            {!inviteResult && inviteStep === 'form' && (
              <form onSubmit={handleInviteContinue} className="space-y-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Email</label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="jane@company.com"
                    className="input w-full"
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Role</label>
                  <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="input w-full">
                    <option value="VIEWER">Viewer — read-only access</option>
                    <option value="MEMBER">Member — can create sessions</option>
                    <option value="ADMIN">Admin — can manage team & policies</option>
                  </select>
                </div>
                <button type="submit" className="btn-primary w-full text-sm">
                  Continue → assign permissions
                </button>
              </form>
            )}

            {/* ─── STEP 2: permission matrix ─────────────────────────────── */}
            {!inviteResult && inviteStep === 'permissions' && (
              <div className="space-y-4">
                {/* Repo grants — checkbox + level dropdown per row */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">
                      Repo access · {Object.keys(invitePendingRepos).length} of {allRepos.length}
                    </label>
                    {allRepos.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const all = Object.keys(invitePendingRepos).length === allRepos.length;
                          setInvitePendingRepos(all ? {} : Object.fromEntries(allRepos.map((r) => [r.id, 'read' as const])));
                        }}
                        className="text-[11px] text-indigo-400 hover:text-indigo-300"
                      >
                        {Object.keys(invitePendingRepos).length === allRepos.length ? 'Clear all' : 'Select all (read)'}
                      </button>
                    )}
                  </div>
                  <div className="rounded-lg border border-gray-800 max-h-44 overflow-y-auto divide-y divide-gray-800/60">
                    {allRepos.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-gray-500 text-center">No repos in this org yet.</div>
                    ) : allRepos.map((r) => {
                      const selected = r.id in invitePendingRepos;
                      const level = invitePendingRepos[r.id];
                      return (
                        <label key={r.id} className="px-3 py-2 flex items-center gap-3 cursor-pointer hover:bg-gray-800/40">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(e) => {
                              setInvitePendingRepos((prev) => {
                                const next = { ...prev };
                                if (e.target.checked) next[r.id] = 'read';
                                else delete next[r.id];
                                return next;
                              });
                            }}
                            className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600"
                          />
                          <span className="text-sm text-gray-200 flex-1 truncate">{r.name}</span>
                          {selected && (
                            <select
                              value={level}
                              onChange={(e) => setInvitePendingRepos((prev) => ({ ...prev, [r.id]: e.target.value as 'read' | 'write' | 'admin' }))}
                              onClick={(e) => e.stopPropagation()}
                              className="input text-[11px] py-0.5 px-1.5 w-20"
                            >
                              <option value="read">Read</option>
                              <option value="write">Write</option>
                              <option value="admin">Admin</option>
                            </select>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Agent grants — same shape, fewer level options */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">
                      Agent access · {Object.keys(invitePendingAgents).length} of {allAgents.length}
                    </label>
                    {allAgents.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const all = Object.keys(invitePendingAgents).length === allAgents.length;
                          setInvitePendingAgents(all ? {} : Object.fromEntries(allAgents.map((a) => [a.id, 'use' as const])));
                        }}
                        className="text-[11px] text-indigo-400 hover:text-indigo-300"
                      >
                        {Object.keys(invitePendingAgents).length === allAgents.length ? 'Clear all' : 'Select all (use)'}
                      </button>
                    )}
                  </div>
                  <div className="rounded-lg border border-gray-800 max-h-44 overflow-y-auto divide-y divide-gray-800/60">
                    {allAgents.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-gray-500 text-center">No agents in this org yet.</div>
                    ) : allAgents.map((a) => {
                      const selected = a.id in invitePendingAgents;
                      const level = invitePendingAgents[a.id];
                      return (
                        <label key={a.id} className="px-3 py-2 flex items-center gap-3 cursor-pointer hover:bg-gray-800/40">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(e) => {
                              setInvitePendingAgents((prev) => {
                                const next = { ...prev };
                                if (e.target.checked) next[a.id] = 'use';
                                else delete next[a.id];
                                return next;
                              });
                            }}
                            className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600"
                          />
                          <span className="text-sm text-gray-200 flex-1 truncate">{a.name}</span>
                          <span className="text-[11px] text-gray-500 truncate">{a.slug}</span>
                          {selected && (
                            <select
                              value={level}
                              onChange={(e) => setInvitePendingAgents((prev) => ({ ...prev, [a.id]: e.target.value as 'use' | 'admin' }))}
                              onClick={(e) => e.stopPropagation()}
                              className="input text-[11px] py-0.5 px-1.5 w-20"
                            >
                              <option value="use">Use</option>
                              <option value="admin">Admin</option>
                            </select>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setInviteStep('form')}
                    className="text-sm text-gray-500 hover:text-gray-300 px-3 py-2"
                  >
                    ← Back
                  </button>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={handleInviteSubmit}
                    disabled={inviting}
                    className="btn-primary text-sm px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {inviting
                      ? 'Sending invite…'
                      : (Object.keys(invitePendingRepos).length + Object.keys(invitePendingAgents).length) > 0
                        ? `Send invite + ${Object.keys(invitePendingRepos).length + Object.keys(invitePendingAgents).length} grant${(Object.keys(invitePendingRepos).length + Object.keys(invitePendingAgents).length) === 1 ? '' : 's'}`
                        : 'Send invite without permissions'}
                  </button>
                </div>
              </div>
            )}

            {/* ─── RESULT: invite created ────────────────────────────────── */}
            {inviteResult && (
              <div className="space-y-4">
                {inviteResult.addedDirectly ? (
                  <div className="p-3 bg-emerald-900/20 border border-emerald-800/40 rounded-lg flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm text-emerald-300 font-medium">Added to the org</p>
                      <p className="text-xs text-emerald-400/80">
                        {inviteResult.email} already had an Origin account, so we added them directly. They'll see the org in their switcher next time they sign in.
                        {inviteResult.grantCount > 0 && ` ${inviteResult.grantCount} permission${inviteResult.grantCount === 1 ? '' : 's'} applied.`}
                      </p>
                    </div>
                  </div>
                ) : inviteResult.emailSent ? (
                  <div className="p-3 bg-emerald-900/20 border border-emerald-800/40 rounded-lg flex items-start gap-2">
                    <Check className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm text-emerald-300 font-medium">Invite sent</p>
                      <p className="text-xs text-emerald-400/80">
                        An email is on its way to {inviteResult.email}.
                        {inviteResult.grantCount > 0 && ` ${inviteResult.grantCount} permission${inviteResult.grantCount === 1 ? '' : 's'} will apply on accept.`}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="p-3 bg-amber-900/20 border border-amber-800/50 rounded-lg">
                    <p className="text-sm text-amber-300 font-medium mb-1">Invite created — email not delivered</p>
                    <p className="text-xs text-amber-400/80">{inviteResult.emailError || 'Email service is not configured.'} Share this link manually:</p>
                  </div>
                )}
                {inviteResult.link && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-2">Invite link</label>
                    <div className="p-3 bg-gray-800 rounded-lg font-mono text-xs text-gray-200 break-all select-all">
                      {inviteResult.link}
                    </div>
                    <button
                      onClick={() => { navigator.clipboard.writeText(inviteResult.link!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="btn-secondary text-xs mt-2 w-full flex items-center justify-center gap-1.5"
                    >
                      <Copy className="w-3 h-3" />
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                  </div>
                )}
              </div>
            )}

            <button onClick={closeInviteModal} className="mt-3 text-sm text-gray-500 hover:text-gray-300 w-full text-center">
              Close
            </button>
          </div>
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

                  {/* Scope-up-front: pick the agents + repos the new API key
                      can use. Defaults: all agents selected, no repo filter
                      (= access to all repos). Same chip style used in the
                      Generate-Key modal. */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-2">
                      Agents <span className="text-gray-600">— required</span>
                    </label>
                    {allAgents.length === 0 ? (
                      <p className="text-[11px] text-gray-600 italic">No agents configured yet. Create one on the Agents page first.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {allAgents.map((a) => {
                          const selected = addAgentIds.includes(a.id);
                          return (
                            <label
                              key={a.id}
                              className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full cursor-pointer transition-colors border ${
                                selected
                                  ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40'
                                  : 'bg-gray-800/50 text-gray-500 border-gray-700 hover:border-gray-600 hover:text-gray-300'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => setAddAgentIds(selected
                                  ? addAgentIds.filter((id) => id !== a.id)
                                  : [...addAgentIds, a.id])}
                                className="sr-only"
                              />
                              {selected ? '✓ ' : ''}{a.name}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs text-gray-400 mb-2">
                      Repos <span className="text-gray-600">— empty = all repos</span>
                    </label>
                    {allRepos.length === 0 ? (
                      <p className="text-[11px] text-gray-600 italic">No repos imported yet. Import on the Repos page or leave empty for default access.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                        {allRepos.map((r) => {
                          const selected = addRepoIds.includes(r.id);
                          return (
                            <label
                              key={r.id}
                              className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full cursor-pointer transition-colors border ${
                                selected
                                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                                  : 'bg-gray-800/50 text-gray-500 border-gray-700 hover:border-gray-600 hover:text-gray-300'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => setAddRepoIds(selected
                                  ? addRepoIds.filter((id) => id !== r.id)
                                  : [...addRepoIds, r.id])}
                                className="sr-only"
                              />
                              {selected ? '✓ ' : ''}{r.name}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={adding || addAgentIds.length === 0}
                    className="btn-primary w-full text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {adding ? 'Creating…' : 'Add Member & Generate Key'}
                  </button>
                </form>
              </>
            ) : (
              <>
                {/* Celebration header */}
                <div className="flex flex-col items-center text-center mb-5">
                  <div className="relative mb-3">
                    <div className="absolute inset-0 bg-emerald-500/20 blur-xl rounded-full" />
                    <div className="relative w-14 h-14 rounded-full bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 border border-emerald-500/40 flex items-center justify-center">
                      <Check className="w-7 h-7 text-emerald-400" strokeWidth={3} />
                    </div>
                  </div>
                  <h2 className="text-xl font-semibold text-gray-100 mb-1">
                    {addName} is in
                  </h2>
                  <p className="text-sm text-gray-400">
                    Send them the key below to get started.
                  </p>
                </div>

                {/* Hero: API key card */}
                <div className="relative rounded-xl bg-gradient-to-b from-amber-500/10 to-amber-500/[0.02] border border-amber-500/30 p-4 mb-4">
                  <div className="flex items-center gap-1.5 mb-3">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    <p className="text-[11px] uppercase tracking-wider text-amber-400 font-semibold">
                      Shown only once
                    </p>
                  </div>
                  <div className="flex items-stretch gap-2">
                    <code className="text-[13px] leading-relaxed text-gray-100 bg-black/40 border border-gray-800 px-3 py-2.5 rounded-lg flex-1 break-all font-mono select-all">
                      {generatedKey}
                    </code>
                    <button
                      onClick={() => copyKey(generatedKey)}
                      className={`px-3 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all border ${
                        copied
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                          : 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40 hover:bg-indigo-500/25'
                      }`}
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>

                {/* Access summary */}
                <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3.5 mb-4 space-y-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px] uppercase tracking-wider text-gray-500 font-medium w-14 shrink-0">Agents</span>
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      {addAgentIds.length === allAgents.length ? (
                        <span className="px-2 py-0.5 rounded-md bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-medium">
                          All ({allAgents.length})
                        </span>
                      ) : (
                        addAgentIds.map((id) => {
                          const a = allAgents.find((x) => x.id === id);
                          return a ? (
                            <span key={id} className="px-2 py-0.5 rounded-md bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                              {a.name}
                            </span>
                          ) : null;
                        })
                      )}
                    </div>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px] uppercase tracking-wider text-gray-500 font-medium w-14 shrink-0">Repos</span>
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      {addRepoIds.length === 0 ? (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-medium">
                          All repos
                        </span>
                      ) : (
                        addRepoIds.map((id) => {
                          const r = allRepos.find((x) => x.id === id);
                          return r ? (
                            <span key={id} className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                              {r.name}
                            </span>
                          ) : null;
                        })
                      )}
                    </div>
                  </div>
                  <p className="text-[10px] text-gray-600 pt-0.5 border-t border-gray-800/60">
                    Edit anytime from this member's row → API Keys.
                  </p>
                </div>

                {/* Developer setup */}
                <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                  <div className="flex items-center gap-1.5 mb-3">
                    <Terminal className="w-3.5 h-3.5 text-gray-400" />
                    <p className="text-[11px] uppercase tracking-wider text-gray-400 font-semibold">
                      Developer setup
                    </p>
                  </div>
                  <ol className="space-y-2 text-xs text-gray-400">
                    <li className="flex items-start gap-2.5">
                      <span className="shrink-0 w-5 h-5 rounded-full bg-gray-800 text-gray-300 text-[10px] font-semibold flex items-center justify-center mt-px">1</span>
                      <span className="leading-relaxed">
                        Install:{' '}
                        <code className="text-indigo-300 bg-gray-950/60 px-1.5 py-0.5 rounded border border-gray-800 break-all">
                          npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
                        </code>
                      </span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <span className="shrink-0 w-5 h-5 rounded-full bg-gray-800 text-gray-300 text-[10px] font-semibold flex items-center justify-center mt-px">2</span>
                      <span className="leading-relaxed">
                        Login:{' '}
                        <code className="text-indigo-300 bg-gray-950/60 px-1.5 py-0.5 rounded border border-gray-800">
                          origin login
                        </code>
                      </span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <span className="shrink-0 w-5 h-5 rounded-full bg-gray-800 text-gray-300 text-[10px] font-semibold flex items-center justify-center mt-px">3</span>
                      <span className="leading-relaxed">Paste the API key above</span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <span className="shrink-0 w-5 h-5 rounded-full bg-gray-800 text-gray-300 text-[10px] font-semibold flex items-center justify-center mt-px">4</span>
                      <span className="leading-relaxed">
                        Enable:{' '}
                        <code className="text-indigo-300 bg-gray-950/60 px-1.5 py-0.5 rounded border border-gray-800">
                          origin init
                        </code>
                      </span>
                    </li>
                  </ol>
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
      {/* GENERATE KEY MODAL (with scope selection)                          */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showGenerate && genMember && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowGenerate(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Key className="w-5 h-5 text-indigo-400" />
              Generate Key for {genMember.name}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Key Name</label>
                <input
                  type="text"
                  value={genKeyName}
                  onChange={(e) => setGenKeyName(e.target.value)}
                  className="input w-full"
                  placeholder="e.g. MacBook Pro, CI Pipeline"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-2">Agents (required — key won't work without agents)</label>
                <div className="flex flex-wrap gap-2">
                  {allAgents.map((a) => {
                    const selected = genAgentIds.includes(a.id);
                    return (
                      <label
                        key={a.id}
                        className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded cursor-pointer transition-colors border ${
                          selected
                            ? 'bg-indigo-900/40 text-indigo-300 border-indigo-700'
                            : 'bg-gray-800/50 text-gray-500 border-gray-700 hover:border-gray-600'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            setGenAgentIds(selected
                              ? genAgentIds.filter((id) => id !== a.id)
                              : [...genAgentIds, a.id]
                            );
                          }}
                          className="sr-only"
                        />
                        {selected ? '✓ ' : ''}{a.name}
                      </label>
                    );
                  })}
                </div>
                {genAgentIds.length === 0 && (
                  <p className="text-[10px] text-red-400 mt-1">Select at least one agent</p>
                )}
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-2">Repos (optional — empty = access to all repos)</label>
                <div className="flex flex-wrap gap-2">
                  {allRepos.map((r) => {
                    const selected = genRepoIds.includes(r.id);
                    return (
                      <label
                        key={r.id}
                        className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded cursor-pointer transition-colors border ${
                          selected
                            ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700'
                            : 'bg-gray-800/50 text-gray-500 border-gray-700 hover:border-gray-600'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            setGenRepoIds(selected
                              ? genRepoIds.filter((id) => id !== r.id)
                              : [...genRepoIds, r.id]
                            );
                          }}
                          className="sr-only"
                        />
                        {selected ? '✓ ' : ''}{r.name}
                      </label>
                    );
                  })}
                  {allRepos.length === 0 && <span className="text-xs text-gray-600 italic">No repos added yet</span>}
                </div>
              </div>

              <button
                onClick={handleGenerateKey}
                disabled={generating || genAgentIds.length === 0}
                className="btn-primary w-full text-sm disabled:opacity-50"
              >
                {generating ? 'Generating...' : 'Generate Key'}
              </button>
            </div>
            <button onClick={() => setShowGenerate(false)} className="mt-3 text-sm text-gray-500 hover:text-gray-300 w-full text-center">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* KEY REGENERATED MODAL                                              */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showKeyModal && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowKeyModal(false)}
        >
          <div
            className="relative w-full max-w-lg rounded-2xl border border-white/[0.08] bg-gradient-to-b from-[#0d0e16] to-[#080910] shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8)] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top gradient hairline so the modal reads as the focal element
                rather than a flat box. */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-400/60 to-transparent" />

            <div className="px-6 pt-6 pb-5">
              {/* Header — icon disc + title + subtitle, modal close in the
                  corner so the body of the modal is uncluttered. */}
              <div className="flex items-start gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/15 ring-1 ring-indigo-500/30 flex items-center justify-center flex-shrink-0">
                  <Key className="w-[18px] h-[18px] text-indigo-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold text-gray-50 tracking-tight">
                    API key created
                  </h2>
                  <p className="text-[12.5px] text-gray-500 mt-0.5 truncate">
                    For <span className="text-gray-300">{keyModalName}</span>
                  </p>
                </div>
                <button
                  onClick={() => setShowKeyModal(false)}
                  className="-mr-1.5 -mt-1.5 p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-white/[0.04] transition-colors"
                  aria-label="Close"
                  title="Close"
                >
                  <XCircle className="w-4 h-4" />
                </button>
              </div>

              {/* Save-it-now warning — quiet amber bar instead of a chunky
                  alert box. The label sits flush with the key block below. */}
              <div className="mt-5 mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider font-medium text-amber-300/90">
                <span className="inline-block h-1 w-1 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
                Save this key — it won&apos;t be shown again
              </div>

              {/* Key surface — single-row monospace with inline copy button. */}
              <button
                type="button"
                onClick={() => copyKey(keyModalKey)}
                className="group/key w-full flex items-center gap-3 rounded-lg border border-white/[0.06] bg-black/40 hover:bg-black/60 hover:border-white/[0.12] transition-colors px-3.5 py-3 text-left"
                title="Click to copy"
              >
                <code className="flex-1 min-w-0 text-[12px] font-mono text-emerald-300/90 truncate">
                  {keyModalKey}
                </code>
                <span
                  className={`flex items-center gap-1.5 text-[11px] font-medium transition-colors ${
                    copied
                      ? 'text-emerald-400'
                      : 'text-gray-400 group-hover/key:text-gray-100'
                  }`}
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </span>
              </button>

              {/* Helper command — what the recipient should run. Click to
                  copy the full command, not just the key, so they don't have
                  to assemble it themselves. */}
              <div className="mt-4 rounded-lg bg-white/[0.02] border border-white/[0.04] px-3.5 py-3">
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium flex items-center gap-1.5">
                    <Terminal className="w-3 h-3" />
                    Run on the developer machine
                  </span>
                  <button
                    type="button"
                    onClick={() => copyKey(`origin login --key ${keyModalKey}`)}
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    Copy command
                  </button>
                </div>
                <code className="block text-[11.5px] font-mono text-gray-300 truncate">
                  <span className="text-gray-600">$</span> origin login --key{' '}
                  <span className="text-emerald-300/90">{keyModalKey.slice(0, 14)}…</span>
                </code>
              </div>
            </div>

            {/* Footer — single primary action. Done feels resolved; Close
                feels incidental. Right-aligned so the eye lands on it last. */}
            <div className="px-6 py-3.5 border-t border-white/[0.06] bg-white/[0.015] flex items-center justify-between">
              <span className="text-[11px] text-gray-600">
                Stored as a hash on our side — we can&apos;t recover it.
              </span>
              <button
                onClick={() => setShowKeyModal(false)}
                className="px-4 py-1.5 rounded-md bg-indigo-500/90 hover:bg-indigo-500 text-white text-[12.5px] font-medium transition-colors shadow-[0_4px_14px_-4px_rgba(99,102,241,0.5)]"
              >
                Done
              </button>
            </div>
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
              ) : (members.length === 0 && pendingInvites.length === 0) ? (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} className="px-6 py-12 text-center text-gray-500">
                    No team members yet. Click "Add Member" to get started.
                  </td>
                </tr>
              ) : (
                <>
                  {/* Pending invites — render above active members so admins
                      see "I sent it, hasn't accepted yet" at a glance.
                      Each row shows the invitee email, the role they'll
                      land at on accept, and a Revoke action for admins. */}
                  {pendingInvites.map((inv) => {
                    const expires = new Date(inv.expiresAt);
                    const daysLeft = Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86400000));
                    return (
                      <tr key={`invite-${inv.id}`} className="bg-amber-500/[0.03]">
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-amber-500/15 flex items-center justify-center text-amber-300 text-sm font-medium flex-shrink-0">
                              {(inv.email || '?').charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-200 truncate">{inv.email || '(link-only invite)'}</p>
                              <p className="text-xs text-gray-500 truncate">
                                Awaiting acceptance · {daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left` : 'expired'}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-3">
                          <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded ring-1 ring-inset ring-amber-500/40 bg-amber-500/10 text-amber-300">
                            Pending · {inv.role.toLowerCase()}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-xs text-gray-600">—</td>
                        <td className="px-6 py-3 text-right text-xs text-gray-600">—</td>
                        <td className="px-6 py-3 text-right text-xs text-gray-600">—</td>
                        <td className="px-6 py-3 text-right text-xs text-gray-500 tabular-nums">
                          invited {new Date(inv.createdAt).toLocaleDateString()}
                        </td>
                        {isAdmin && (
                          <td className="px-6 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => handleRevokeInvite(inv)}
                              disabled={revokingInviteId === inv.id}
                              className="text-xs text-gray-400 hover:text-red-400 disabled:opacity-50"
                              title="Revoke this pending invite"
                            >
                              {revokingInviteId === inv.id ? 'Revoking…' : 'Revoke'}
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {members.map((m) => {
                    const memberKeys = getMemberKeys(m.id);
                    const isExpanded = expandedMembers.has(m.id);
                    return (
                      <>
                      <tr
                        key={m.id}
                        className={`hover:bg-gray-800/30 transition-colors cursor-pointer ${isExpanded ? 'bg-gray-800/20' : ''}`}
                        onClick={() => {
                          const next = new Set(expandedMembers);
                          if (isExpanded) next.delete(m.id); else next.add(m.id);
                          setExpandedMembers(next);
                        }}
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
                        <td className="px-6 py-3">
                          {memberKeys.length > 0 ? (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={(e) => { e.stopPropagation(); const next = new Set(expandedMembers); if (isExpanded) next.delete(m.id); else next.add(m.id); setExpandedMembers(next); }}
                                className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors ${
                                  isExpanded
                                    ? 'bg-indigo-900/30 text-indigo-300 border-indigo-700'
                                    : 'bg-gray-800/50 text-gray-300 border-gray-700 hover:border-indigo-600 hover:text-indigo-400'
                                }`}
                              >
                                <Key className="w-3 h-3" />
                                {memberKeys.length} {memberKeys.length === 1 ? 'key' : 'keys'}
                                <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                              </button>
                              {isAdmin && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); openGenerateKey(m, `${m.name} key ${memberKeys.length + 1}`); }}
                                  className="text-indigo-400/50 hover:text-indigo-400 transition-colors"
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
                              onClick={(e) => { e.stopPropagation(); openGenerateKey(m); }}
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
                              <Link
                                to={`/iam/users/${m.id}/access`}
                                className="text-xs text-indigo-300 hover:text-indigo-200 transition-colors"
                                title="Manage repo + agent access"
                              >
                                Manage access
                              </Link>
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
                      {isExpanded && memberKeys.length > 0 && (
                        <tr key={`${m.id}-scopes`}>
                          <td colSpan={isAdmin ? 7 : 6} className="px-6 py-4 bg-gray-900/50">
                            <div className="space-y-3">
                              {memberKeys.map((mk) => (
                                <div key={mk.id} className="bg-gray-800/40 border border-gray-700/50 rounded-lg p-4 space-y-3">
                                  {/* Key header */}
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                      <Key className="w-4 h-4 text-green-500" />
                                      <div>
                                        <div className="flex items-center gap-2">
                                          <span className="text-sm font-medium text-gray-200">{mk.name}</span>
                                          {mk.role && (
                                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-900/50 text-indigo-300 uppercase">
                                              {mk.role}
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                          <code className="text-xs text-indigo-400 font-mono">{mk.keyPrefix}...</code>
                                          <span className="text-[10px] text-gray-600">Created {new Date(mk.createdAt).toLocaleDateString()}</span>
                                        </div>
                                      </div>
                                    </div>
                                    {isAdmin && (
                                      <button
                                        onClick={() => handleDeleteKey(mk.id)}
                                        className="text-xs text-red-400/60 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-900/20"
                                      >
                                        Delete
                                      </button>
                                    )}
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
                  })}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* STANDALONE / UNASSIGNED KEYS                                       */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {standaloneKeys.length > 0 && (
        <div className="card">
          <button
            onClick={() => setShowStandaloneKeys(!showStandaloneKeys)}
            className="flex items-center justify-between w-full text-left"
          >
            <div>
              <h2 className="text-sm font-semibold text-gray-200">Unassigned Keys</h2>
              <p className="text-xs text-gray-500 mt-0.5">{standaloneKeys.length} key{standaloneKeys.length !== 1 ? 's' : ''} not linked to any team member</p>
            </div>
            <span className="text-xs text-gray-500">{showStandaloneKeys ? '▲' : '▼'}</span>
          </button>

          {showStandaloneKeys && (
            <div className="mt-4 space-y-3">
              {standaloneKeys.map((sk) => (
                <div key={sk.id} className="bg-gray-800/30 rounded-lg p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Key className="w-3 h-3 text-amber-500" />
                      <span className="text-sm text-gray-200">{sk.name}</span>
                      <code className="text-xs text-indigo-400">{sk.keyPrefix}...</code>
                      {sk.role && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-900/50 text-indigo-300 uppercase">{sk.role}</span>
                      )}
                      <span className="text-[10px] text-gray-600">Created {new Date(sk.createdAt).toLocaleDateString()}</span>
                    </div>
                    <button
                      onClick={() => handleDeleteKey(sk.id)}
                      className="text-xs text-red-400/60 hover:text-red-400 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                  {/* Agent scopes */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider w-16">Agents</span>
                    <div className="flex flex-wrap gap-1.5">
                      {allAgents.map((a) => {
                        const assigned = sk.agentScopes?.some((s) => s.agentId === a.id);
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
                                sk.id, 'agent', a.id,
                                (sk.agentScopes || []).map((s) => s.agentId),
                                !!assigned,
                              )}
                              className="sr-only"
                            />
                            {assigned ? '✓ ' : ''}{a.name}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  {/* Repo scopes */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider w-16">Repos</span>
                    <div className="flex flex-wrap gap-1.5">
                      {allRepos.map((r) => {
                        const assigned = sk.repoScopes?.some((s) => s.repoId === r.id);
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
                                sk.id, 'repo', r.id,
                                (sk.repoScopes || []).map((s) => s.repoId),
                                !!assigned,
                              )}
                              className="sr-only"
                            />
                            {assigned ? '✓ ' : ''}{r.name}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Users className="w-3.5 h-3.5" />
            Total Members
          </div>
          <div className="text-xl font-bold text-gray-100">{members.length}</div>
        </div>
        <div
          className="card p-4 cursor-pointer hover:border-indigo-700/50 transition-colors"
          onClick={() => {
            // Toggle expand ALL members that have keys + show standalone keys
            const membersWithKeys = members.filter((m) => getMemberKeys(m.id).length > 0).map((m) => m.id);
            const allExpanded = membersWithKeys.every((id) => expandedMembers.has(id)) && (standaloneKeys.length === 0 || showStandaloneKeys);
            if (allExpanded) {
              setExpandedMembers(new Set());
              setShowStandaloneKeys(false);
            } else {
              setExpandedMembers(new Set(membersWithKeys));
              setShowStandaloneKeys(true);
            }
          }}
        >
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
