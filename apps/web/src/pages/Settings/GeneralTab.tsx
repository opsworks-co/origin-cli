import React, { useState, useEffect, useCallback } from 'react';
import { User, Lock, Link2, Building2, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../api';
import ProfileEditor from './ProfileEditor';
import PasswordChanger from './PasswordChanger';

function SectionHeader({ icon: Icon, title, subtitle, accent = 'indigo' }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: React.ReactNode;
  accent?: 'indigo' | 'emerald' | 'amber' | 'red';
}) {
  const iconColor: Record<string, string> = {
    indigo:  'text-indigo-400',
    emerald: 'text-emerald-400',
    amber:   'text-amber-400',
    red:     'text-red-400',
  };
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <Icon className={`w-3.5 h-3.5 ${iconColor[accent]}`} />
        <h2 className={`text-sm font-semibold ${accent === 'red' ? 'text-red-400' : 'text-gray-200'}`}>{title}</h2>
      </div>
      {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
    </div>
  );
}

export default function GeneralTab() {
  const { user, activeOrg } = useAuth();
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
      <section className="card space-y-5">
        <SectionHeader icon={User} title="Profile" subtitle="Manage your account details" accent="indigo" />
        <ProfileEditor />
      </section>

      {/* Change Password — only for email/password accounts */}
      {user && !user.provider && (
      <section className="card space-y-5">
        <SectionHeader icon={Lock} title="Change Password" subtitle="Update your account password" accent="indigo" />
        <PasswordChanger />
      </section>
      )}

      {/* Connected Accounts */}
      {user?.provider && (
      <section className="card space-y-5">
        <SectionHeader icon={Link2} title="Connected Account" subtitle="Your account is linked to an external provider" accent="emerald" />
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

      {/* Org Section — hidden for developer accounts */}
      {!isDev && (
      <section className="card space-y-5">
        <SectionHeader
          icon={Building2}
          title="Organization"
          subtitle={
            <>
              Manage your organization settings
              {activeOrg?.role !== 'OWNER' && activeOrg?.role !== 'ADMIN' && (
                <span className="text-gray-600 ml-1">(read-only for your role)</span>
              )}
            </>
          }
          accent="indigo"
        />

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
                {activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN' ? (
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
                {activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN' ? (
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
                  {activeOrg?.role ?? '\u2014'}
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

            {(activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN') && (
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

      {/* Danger Zone — pinned to the bottom of General so it never hides
          above an org/diagnostic block the user isn't reading. */}
      <section className="card space-y-5 border-red-900/30">
        <SectionHeader icon={AlertTriangle} title="Danger Zone" subtitle="Irreversible actions for your account" accent="red" />
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
    </>
  );
}

