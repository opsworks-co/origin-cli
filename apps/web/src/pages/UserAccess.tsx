import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Lock, Save, X } from 'lucide-react';
import * as api from '../api';
import type { UserAccessSummary, RepoLevel, AgentLevel } from '../api';
import { useAuth } from '../context/AuthContext';

// Per-user access matrix. Lists every repo + agent in the active org and
// shows the user's level on each, with inline level pickers. The /:id/access
// endpoint pre-populates the matrix; PUT /repos/:id/members/:userId etc.
// commit changes one row at a time on save.
//
// Org OWNER/ADMIN show as fully inherited (every row locked) so admins
// using this page on themselves don't accidentally try to grant themselves
// access they already have.

export default function UserAccess() {
  const { id: targetUserId } = useParams<{ id: string }>();
  const { activeOrg } = useAuth();
  const [summary, setSummary] = useState<UserAccessSummary | null>(null);
  const [userName, setUserName] = useState<string>('');
  const [userEmail, setUserEmail] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // Local edits keyed by `repo:<id>` / `agent:<id>` — we only commit on
  // explicit Save click so the admin can scan the matrix without each
  // dropdown change firing a request.
  const [pendingRepo, setPendingRepo] = useState<Record<string, RepoLevel | null>>({});
  const [pendingAgent, setPendingAgent] = useState<Record<string, AgentLevel | null>>({});

  const canManage = activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN';

  async function load() {
    if (!targetUserId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, users] = await Promise.all([
        api.getUserAccess(targetUserId),
        api.getUsers(),
      ]);
      setSummary(s);
      const u = users.users.find((x) => x.id === targetUserId);
      if (u) {
        setUserName(u.name);
        setUserEmail(u.email);
      }
      setPendingRepo({});
      setPendingAgent({});
    } catch (err: any) {
      setError(err?.message || 'Failed to load access');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [targetUserId]);

  function repoCurrentLevel(repoId: string): RepoLevel | null {
    if (Object.prototype.hasOwnProperty.call(pendingRepo, repoId)) return pendingRepo[repoId];
    return summary?.repos.find((r) => r.id === repoId)?.level ?? null;
  }

  function agentCurrentLevel(agentId: string): AgentLevel | null {
    if (Object.prototype.hasOwnProperty.call(pendingAgent, agentId)) return pendingAgent[agentId];
    return summary?.agents.find((a) => a.id === agentId)?.level ?? null;
  }

  async function saveRepo(repoId: string) {
    if (!targetUserId) return;
    const next = repoCurrentLevel(repoId);
    setSavingKey(`repo:${repoId}`);
    try {
      if (next === null) {
        await api.removeRepoMember(repoId, targetUserId).catch((err) => {
          // 404 = was already not a member; that's fine here.
          if (!String(err?.message || '').includes('No explicit access')) throw err;
        });
      } else {
        await api.setRepoMember(repoId, targetUserId, next);
      }
      await load();
    } catch (err: any) {
      setError(err?.message || 'Save failed');
    } finally {
      setSavingKey(null);
    }
  }

  async function saveAgent(agentId: string) {
    if (!targetUserId) return;
    const next = agentCurrentLevel(agentId);
    setSavingKey(`agent:${agentId}`);
    try {
      if (next === null) {
        await api.removeAgentMember(agentId, targetUserId).catch((err) => {
          if (!String(err?.message || '').includes('No explicit access')) throw err;
        });
      } else {
        await api.setAgentMember(agentId, targetUserId, next);
      }
      await load();
    } catch (err: any) {
      setError(err?.message || 'Save failed');
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Link to="/iam" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300 mb-4">
        <ArrowLeft className="w-3.5 h-3.5" /> IAM
      </Link>
      <h1 className="text-2xl font-bold text-gray-100">Manage access</h1>
      <p className="text-sm text-gray-500 mt-1">
        {userName || targetUserId}
        {userEmail ? <span className="text-gray-600"> · {userEmail}</span> : null}
        {summary?.orgRole ? <span className="text-gray-600"> · org {summary.orgRole.toLowerCase()}</span> : null}
      </p>

      {summary?.inheritsAll && (
        <div className="mt-4 p-3 rounded-md border border-amber-500/40 bg-amber-500/5 text-amber-200 text-sm">
          <strong>{summary.orgRole}</strong> users inherit admin on every repo and agent.
          Change their org role on the IAM page to revoke access.
        </div>
      )}

      {error && (
        <div className="mt-4 p-3 rounded-md border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="mt-6 p-6 text-center text-sm text-gray-500">Loading…</div>
      ) : (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Repositories matrix ───────────────────────────────── */}
          <div className="rounded-lg border border-gray-200 dark:border-white/[0.08] overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-[#0a0b14]/60">
              <h2 className="text-sm font-medium text-gray-800 dark:text-gray-100">Repositories</h2>
              <p className="text-[11px] text-gray-500 mt-0.5">Read · Write · Admin · None</p>
            </div>
            {summary?.repos.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">No repositories in this org yet.</div>
            ) : (
              summary?.repos.map((r) => {
                const stored = r.level;
                const current = repoCurrentLevel(r.id);
                const dirty = current !== stored;
                const locked = r.inherited || !canManage;
                return (
                  <div key={r.id} className="grid grid-cols-[1fr_auto] gap-3 items-center px-4 py-2.5 border-b border-gray-200 dark:border-white/[0.05] last:border-b-0">
                    <div className="min-w-0">
                      <div className="text-sm text-gray-800 dark:text-gray-100 truncate flex items-center gap-1.5">
                        {r.name}
                        {r.inherited && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-gray-500">
                            <Lock className="w-2.5 h-2.5" /> inherited
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 truncate">{r.path}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <select
                        value={current ?? 'none'}
                        disabled={locked}
                        onChange={(e) => setPendingRepo({ ...pendingRepo, [r.id]: e.target.value === 'none' ? null : (e.target.value as RepoLevel) })}
                        className="text-[12px] px-2 py-1 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100 disabled:opacity-50"
                      >
                        <option value="none">— none</option>
                        <option value="read">Read</option>
                        <option value="write">Write</option>
                        <option value="admin">Admin</option>
                      </select>
                      {dirty && !locked && (
                        <>
                          <button
                            type="button"
                            onClick={() => saveRepo(r.id)}
                            disabled={savingKey === `repo:${r.id}`}
                            className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
                            title="Save"
                          >
                            <Save className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const next = { ...pendingRepo };
                              delete next[r.id];
                              setPendingRepo(next);
                            }}
                            className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 dark:border-white/[0.08] text-gray-500 hover:text-gray-300 transition-colors"
                            title="Discard"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* ── Agents matrix ─────────────────────────────────────── */}
          <div className="rounded-lg border border-gray-200 dark:border-white/[0.08] overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-[#0a0b14]/60">
              <h2 className="text-sm font-medium text-gray-800 dark:text-gray-100">Agents</h2>
              <p className="text-[11px] text-gray-500 mt-0.5">Use · Admin · None</p>
            </div>
            {summary?.agents.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">No agents in this org yet.</div>
            ) : (
              summary?.agents.map((a) => {
                const stored = a.level;
                const current = agentCurrentLevel(a.id);
                const dirty = current !== stored;
                const locked = a.inherited || !canManage;
                return (
                  <div key={a.id} className="grid grid-cols-[1fr_auto] gap-3 items-center px-4 py-2.5 border-b border-gray-200 dark:border-white/[0.05] last:border-b-0">
                    <div className="min-w-0">
                      <div className="text-sm text-gray-800 dark:text-gray-100 truncate flex items-center gap-1.5">
                        {a.name}
                        {a.inherited && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-gray-500">
                            <Lock className="w-2.5 h-2.5" /> inherited
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500 truncate">{a.model}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <select
                        value={current ?? 'none'}
                        disabled={locked}
                        onChange={(e) => setPendingAgent({ ...pendingAgent, [a.id]: e.target.value === 'none' ? null : (e.target.value as AgentLevel) })}
                        className="text-[12px] px-2 py-1 rounded-md border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-[#0a0b14] text-gray-900 dark:text-gray-100 disabled:opacity-50"
                      >
                        <option value="none">— none</option>
                        <option value="use">Use</option>
                        <option value="admin">Admin</option>
                      </select>
                      {dirty && !locked && (
                        <>
                          <button
                            type="button"
                            onClick={() => saveAgent(a.id)}
                            disabled={savingKey === `agent:${a.id}`}
                            className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
                            title="Save"
                          >
                            <Save className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const next = { ...pendingAgent };
                              delete next[a.id];
                              setPendingAgent(next);
                            }}
                            className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 dark:border-white/[0.08] text-gray-500 hover:text-gray-300 transition-colors"
                            title="Discard"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
