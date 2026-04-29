import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../api';
import ProfileEditor from './ProfileEditor';
import PasswordChanger from './PasswordChanger';

export default function GeneralTab() {
  const { user } = useAuth();
  const isDev = user?.accountType === 'developer';

  // Org settings
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [orgStats, setOrgStats] = useState<{ users: number; repos: number; agents: number; policies: number } | null>(null);
  const [orgCreatedAt, setOrgCreatedAt] = useState('');
  const [orgLoading, setOrgLoading] = useState(false);
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgMsg, setOrgMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchOrg = useCallback(async () => {
    setOrgLoading(true);
    try {
      const data = await api.getOrgSettings();
      setOrgName(data.org.name);
      setOrgSlug(data.org.slug);
      setOrgStats(data.org._count);
      setOrgCreatedAt(data.org.createdAt);
    } catch {
      // ignore
    } finally {
      setOrgLoading(false);
    }
  }, []);

  const handleSaveOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingOrg(true);
    setOrgMsg(null);
    try {
      const data = await api.updateOrgSettings({ name: orgName, slug: orgSlug });
      setOrgName(data.org.name);
      setOrgSlug(data.org.slug);
      setOrgMsg({ type: 'success', text: 'Organization settings saved' });
    } catch (err: any) {
      setOrgMsg({ type: 'error', text: err.message || 'Failed to save' });
    } finally {
      setSavingOrg(false);
    }
  };

  useEffect(() => {
    fetchOrg();
  }, [fetchOrg]);

  return (
    <>
      {/* Profile section — both solo and team */}
      <section className="card space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Profile</h2>
          <p className="text-sm text-gray-500 mt-0.5">Manage your account details</p>
        </div>
        <ProfileEditor />
      </section>

      {/* Change Password — only for email/password accounts */}
      {user && !user.provider && (
      <section className="card space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Change Password</h2>
          <p className="text-sm text-gray-500 mt-0.5">Update your account password</p>
        </div>
        <PasswordChanger />
      </section>
      )}

      {/* Connected Accounts */}
      {user?.provider && (
      <section className="card space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Connected Account</h2>
          <p className="text-sm text-gray-500 mt-0.5">Your account is linked to an external provider</p>
        </div>
        <div className="flex items-center gap-3 bg-gray-800/50 rounded-lg px-4 py-3">
          <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
            {user.provider === 'github' && (
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-gray-300"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
            )}
            {user.provider === 'gitlab' && (
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-orange-400"><path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z" /></svg>
            )}
          </div>
          <div>
            <span className="text-sm text-gray-200 capitalize">{user.provider}</span>
            <span className="text-xs text-gray-500 block">Signed in via OAuth</span>
          </div>
        </div>
      </section>
      )}

      {/* Danger Zone */}
      <section className="card space-y-4 border-red-900/30">
        <div>
          <h2 className="text-lg font-semibold text-red-400">Danger Zone</h2>
          <p className="text-sm text-gray-500 mt-0.5">Irreversible actions for your account</p>
        </div>
        <div className="flex items-center justify-between bg-red-900/10 border border-red-900/30 rounded-lg px-4 py-3">
          <div>
            <p className="text-sm text-gray-200">Delete Account</p>
            <p className="text-xs text-gray-500">Permanently delete your account and all associated data</p>
          </div>
          <button
            className="text-xs font-medium text-red-400 hover:text-red-300 border border-red-800 hover:border-red-700 px-3 py-1.5 rounded-lg transition-colors"
            onClick={() => {
              if (window.confirm('Are you sure? This will permanently delete your account, all sessions, and all data. This cannot be undone.')) {
                alert('Please contact support@getorigin.io to delete your account.');
              }
            }}
          >
            Delete Account
          </button>
        </div>
      </section>

      {/* Org Section — hidden for developer accounts */}
      {!isDev && (
      <section className="card space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Organization</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage your organization settings
            {user?.role !== 'OWNER' && user?.role !== 'ADMIN' && (
              <span className="text-gray-600 ml-1">(read-only for your role)</span>
            )}
          </p>
        </div>

        {orgMsg && (
          <div
            className={`rounded-lg p-3 text-sm ${
              orgMsg.type === 'success'
                ? 'bg-green-900/20 border border-green-800 text-green-400'
                : 'bg-red-900/20 border border-red-800 text-red-400'
            }`}
          >
            {orgMsg.text}
          </div>
        )}

        {orgLoading ? (
          <div className="text-sm text-gray-500">Loading organization...</div>
        ) : (
          <form onSubmit={handleSaveOrg} className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Organization Name</label>
                {user?.role === 'OWNER' || user?.role === 'ADMIN' ? (
                  <input
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    className="input"
                    placeholder="Your organization"
                    required
                  />
                ) : (
                  <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
                    {orgName || '\u2014'}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Slug</label>
                {user?.role === 'OWNER' || user?.role === 'ADMIN' ? (
                  <>
                    <input
                      value={orgSlug}
                      onChange={(e) => setOrgSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                      className="input"
                      placeholder="my-org"
                      required
                      pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                      minLength={2}
                      maxLength={48}
                    />
                    <p className="text-xs text-gray-600 mt-1">
                      Used in URLs. Lowercase letters, numbers, and hyphens only.
                    </p>
                  </>
                ) : (
                  <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
                    {orgSlug || '\u2014'}
                  </div>
                )}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-500 mb-1">Your Role</label>
                <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
                  {user?.role ?? '\u2014'}
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1">Your Email</label>
                <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
                  {user?.email ?? '\u2014'}
                </div>
              </div>
            </div>

            {/* Org stats */}
            {orgStats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                <div className="bg-gray-800/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-gray-100">{orgStats.users}</div>
                  <div className="text-xs text-gray-500">Members</div>
                </div>
                <div className="bg-gray-800/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-gray-100">{orgStats.repos}</div>
                  <div className="text-xs text-gray-500">Repos</div>
                </div>
                <div className="bg-gray-800/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-gray-100">{orgStats.agents}</div>
                  <div className="text-xs text-gray-500">Agents</div>
                </div>
                <div className="bg-gray-800/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-semibold text-gray-100">{orgStats.policies}</div>
                  <div className="text-xs text-gray-500">Policies</div>
                </div>
              </div>
            )}

            {orgCreatedAt && (
              <p className="text-xs text-gray-600">
                Organization created {new Date(orgCreatedAt).toLocaleDateString()}
              </p>
            )}

            {(user?.role === 'OWNER' || user?.role === 'ADMIN') && (
              <button
                type="submit"
                disabled={savingOrg}
                className="btn-primary text-sm"
              >
                {savingOrg ? 'Saving...' : 'Save Changes'}
              </button>
            )}
          </form>
        )}
      </section>
      )}

      {/* Admin-only diagnostic. Not common-path enough for its own tab. */}
      {(isDev || user?.role === 'OWNER' || user?.role === 'ADMIN') && (
        <RecomputeCostsCard />
      )}
    </>
  );
}

interface RecomputeResult {
  scanned: number;
  updated: number;
  unchanged: number;
  skipped: number;
  totalCostBefore: number;
  totalCostAfter: number;
  topChanges: Array<{
    sessionId: string;
    model: string;
    before: number;
    after: number;
    delta: number;
  }>;
}

/**
 * Re-derive every session's costUsd from stored token counts using the
 * current pricing table. Useful when older sessions were stamped with
 * a stale price (e.g. before the Opus rate fix).
 *
 * Lives at the bottom of the General tab as an admin diagnostic — not
 * its own tab. Most users will never need it.
 */
function RecomputeCostsCard() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RecomputeResult | null>(null);
  const [error, setError] = useState('');

  const run = async (dryRun: boolean) => {
    setError('');
    setResult(null);
    setRunning(true);
    try {
      const res = await fetch('/api/settings/recompute-costs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (err: any) {
      setError(err?.message || 'Failed to recompute');
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-left"
      >
        <div>
          <h2 className="text-base font-semibold text-gray-200">Recompute session costs</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Diagnostic. Re-derives every session's cost from stored token counts using the current pricing table.
          </p>
        </div>
        <span className="text-gray-500 text-sm">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mt-5 space-y-4">
          <p className="text-xs text-gray-500">
            Idempotent — sessions whose stored cost already matches the recompute are skipped. Use this if older sessions
            were stamped with a stale price (e.g. before the Opus rate fix).
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => run(true)}
              disabled={running}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors disabled:opacity-50"
            >
              {running ? 'Computing…' : 'Dry-run preview'}
            </button>
            <button
              onClick={() => run(false)}
              disabled={running}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
            >
              {running ? 'Running…' : 'Run recompute'}
            </button>
          </div>

          {error && <div className="text-xs text-red-400">{error}</div>}

          {result && (
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-3 space-y-3 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div><div className="text-gray-500">Scanned</div><div className="text-gray-100 font-mono">{result.scanned}</div></div>
                <div><div className="text-gray-500">Updated</div><div className="text-indigo-300 font-mono">{result.updated}</div></div>
                <div><div className="text-gray-500">Unchanged</div><div className="text-gray-400 font-mono">{result.unchanged}</div></div>
                <div><div className="text-gray-500">Skipped</div><div className="text-gray-500 font-mono" title="No token data — can't recompute">{result.skipped}</div></div>
              </div>
              <div className="flex items-center gap-3 pt-2 border-t border-gray-800">
                <span className="text-gray-500">Org total:</span>
                <span className="text-gray-300 font-mono">${result.totalCostBefore.toFixed(2)}</span>
                <span className="text-gray-600">→</span>
                <span className="text-emerald-400 font-mono">${result.totalCostAfter.toFixed(2)}</span>
                {Math.abs(result.totalCostAfter - result.totalCostBefore) > 0.01 && (
                  <span className={`px-1.5 py-0.5 rounded ${
                    result.totalCostAfter < result.totalCostBefore
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-amber-500/15 text-amber-400'
                  }`}>
                    {result.totalCostAfter < result.totalCostBefore ? '−' : '+'}
                    ${Math.abs(result.totalCostAfter - result.totalCostBefore).toFixed(2)}
                  </span>
                )}
              </div>
              {result.topChanges.length > 0 && (
                <div className="pt-2 border-t border-gray-800">
                  <div className="text-gray-500 mb-1.5">Largest changes</div>
                  <div className="space-y-1">
                    {result.topChanges.map((c) => (
                      <div key={c.sessionId} className="flex items-center justify-between">
                        <code className="text-gray-500 font-mono">{c.sessionId.slice(0, 8)}</code>
                        <span className="text-gray-400 font-mono">{c.model}</span>
                        <span className="text-gray-300 font-mono">
                          ${c.before.toFixed(2)} → ${c.after.toFixed(2)}
                          <span className={c.delta < 0 ? 'text-emerald-400 ml-2' : 'text-amber-400 ml-2'}>
                            ({c.delta > 0 ? '+' : ''}${c.delta.toFixed(2)})
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
