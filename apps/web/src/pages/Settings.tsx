import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';

interface ApiKey {
  id: string;
  prefix: string;
  createdAt: string;
}

export default function Settings() {
  const { user } = useAuth();

  // API Keys (local state — would be fetched from API in production)
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);

  // Team invite
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState('');

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingKey(true);
    setCreatedKey(null);
    try {
      // Simulate API call — in production this would hit /api/api-keys
      await new Promise((r) => setTimeout(r, 500));
      const fakeKey = `org_${Math.random().toString(36).slice(2, 10)}_${Math.random().toString(36).slice(2, 26)}`;
      const prefix = fakeKey.slice(0, 12) + '...';
      setApiKeys((prev) => [
        ...prev,
        { id: Math.random().toString(), prefix, createdAt: new Date().toISOString() },
      ]);
      setCreatedKey(fakeKey);
      setNewKeyName('');
    } catch {
      // Handle error
    } finally {
      setCreatingKey(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setInviteSuccess('');
    try {
      // Simulate API call — in production this would hit /api/team/invite
      await new Promise((r) => setTimeout(r, 500));
      setInviteSuccess(`Invitation sent to ${inviteEmail}`);
      setInviteEmail('');
      setInviteRole('member');
    } catch {
      // Handle error
    } finally {
      setInviting(false);
    }
  };

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Manage API keys, team, and organization</p>
      </div>

      {/* API Keys Section */}
      <section className="card space-y-4">
        <div>
          <h2 className="text-lg font-semibold">API Keys</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Create API keys for integrating agents with Origin
          </p>
        </div>

        {/* Existing keys */}
        {apiKeys.length > 0 && (
          <div className="space-y-2">
            {apiKeys.map((key) => (
              <div
                key={key.id}
                className="flex items-center justify-between bg-gray-800/50 rounded-lg px-4 py-3"
              >
                <div>
                  <code className="text-sm text-indigo-400">{key.prefix}</code>
                </div>
                <span className="text-xs text-gray-500">
                  Created {new Date(key.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Created key warning */}
        {createdKey && (
          <div className="bg-amber-900/20 border border-amber-800 rounded-lg p-4">
            <p className="text-sm text-amber-400 font-medium mb-1">
              Copy your API key now. You won&apos;t be able to see it again.
            </p>
            <code className="text-sm text-gray-200 bg-gray-800 px-3 py-1.5 rounded block break-all">
              {createdKey}
            </code>
          </div>
        )}

        {/* Create new key */}
        <form onSubmit={handleCreateKey} className="flex gap-3">
          <input
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="input flex-1"
            placeholder="Key name (optional)"
          />
          <button type="submit" disabled={creatingKey} className="btn-primary text-sm whitespace-nowrap">
            {creatingKey ? 'Creating...' : 'Create New'}
          </button>
        </form>
      </section>

      {/* Team Section */}
      <section className="card space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Team</h2>
          <p className="text-sm text-gray-500 mt-0.5">Invite team members to your organization</p>
        </div>

        {inviteSuccess && (
          <div className="bg-green-900/20 border border-green-800 rounded-lg p-3 text-green-400 text-sm">
            {inviteSuccess}
          </div>
        )}

        <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
          <input
            type="email"
            required
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            className="input flex-1"
            placeholder="colleague@company.com"
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            className="select text-sm"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="viewer">Viewer</option>
          </select>
          <button type="submit" disabled={inviting} className="btn-primary text-sm whitespace-nowrap">
            {inviting ? 'Sending...' : 'Send Invite'}
          </button>
        </form>
      </section>

      {/* Org Section */}
      <section className="card space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Organization</h2>
          <p className="text-sm text-gray-500 mt-0.5">Your organization details</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-500 mb-1">Organization Name</label>
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
              {user?.orgName ?? '\u2014'}
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">Slug</label>
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
              {user?.orgSlug ?? '\u2014'}
            </div>
          </div>
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
      </section>
    </div>
  );
}
