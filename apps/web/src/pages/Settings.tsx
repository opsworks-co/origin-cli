import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
}

export default function Settings() {
  const { user } = useAuth();

  // Active tab
  const [activeTab, setActiveTab] = useState<'general' | 'agent-setup'>('general');

  // API Keys
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Team invite
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState('');

  // Fetch API keys on mount
  useEffect(() => {
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    setLoadingKeys(true);
    setKeyError(null);
    try {
      const keys = await api.getApiKeys();
      setApiKeys(keys);
    } catch (err: any) {
      setKeyError(err.message || 'Failed to load API keys');
    } finally {
      setLoadingKeys(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingKey(true);
    setCreatedKey(null);
    setKeyError(null);
    try {
      const result = await api.createApiKey({ name: newKeyName || 'Unnamed key' });
      setCreatedKey(result.key);
      setNewKeyName('');
      // Refresh the list to include the new key
      await fetchApiKeys();
    } catch (err: any) {
      setKeyError(err.message || 'Failed to create API key');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleDeleteKey = async (id: string) => {
    setDeletingKeyId(id);
    setKeyError(null);
    try {
      await api.deleteApiKey(id);
      // Refresh the list after deletion
      await fetchApiKeys();
    } catch (err: any) {
      setKeyError(err.message || 'Failed to delete API key');
    } finally {
      setDeletingKeyId(null);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setInviteSuccess('');
    try {
      // Placeholder — team invite API not yet implemented
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

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-gray-800">
        <button
          onClick={() => setActiveTab('general')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'general'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          General
        </button>
        <button
          onClick={() => setActiveTab('agent-setup')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'agent-setup'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Agent Setup
        </button>
      </div>

      {activeTab === 'general' && (
        <>
          {/* API Keys Section */}
          <section className="card space-y-4">
            <div>
              <h2 className="text-lg font-semibold">API Keys</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Create API keys for integrating agents with Origin
              </p>
            </div>

            {/* Error message */}
            {keyError && (
              <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-400 text-sm">
                {keyError}
              </div>
            )}

            {/* Loading state */}
            {loadingKeys && (
              <div className="text-sm text-gray-500">Loading API keys...</div>
            )}

            {/* Existing keys */}
            {!loadingKeys && apiKeys.length > 0 && (
              <div className="space-y-2">
                {apiKeys.map((key) => (
                  <div
                    key={key.id}
                    className="flex items-center justify-between bg-gray-800/50 rounded-lg px-4 py-3"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm text-gray-200">{key.name}</span>
                      <code className="text-xs text-indigo-400">{key.keyPrefix}...</code>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500">
                        Created {new Date(key.createdAt).toLocaleDateString()}
                      </span>
                      <button
                        onClick={() => handleDeleteKey(key.id)}
                        disabled={deletingKeyId === key.id}
                        className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {deletingKeyId === key.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Empty state */}
            {!loadingKeys && apiKeys.length === 0 && !keyError && (
              <div className="text-sm text-gray-500">No API keys yet. Create one below.</div>
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
              <p className="text-xs text-amber-400 mt-1">Coming soon &mdash; team invites are not yet connected to the backend.</p>
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
        </>
      )}

      {activeTab === 'agent-setup' && (
        <>
          {/* Agent Setup Instructions */}
          <section className="card space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Agent Setup Guide</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Connect your AI coding agents to Origin in a few steps
              </p>
            </div>

            {/* Step 1 */}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-600 text-white text-sm font-bold flex items-center justify-center">
                  1
                </span>
                <h3 className="font-medium text-gray-200">Install the CLI</h3>
              </div>
              <div className="ml-10">
                <p className="text-sm text-gray-400 mb-2">
                  Install the Origin CLI globally via npm.
                </p>
                <pre className="bg-gray-800 rounded-lg px-4 py-3 text-sm font-mono text-gray-200 overflow-x-auto">
npm install -g @origin/cli</pre>
              </div>
            </div>

            {/* Step 2 */}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-600 text-white text-sm font-bold flex items-center justify-center">
                  2
                </span>
                <h3 className="font-medium text-gray-200">Login to your account</h3>
              </div>
              <div className="ml-10">
                <p className="text-sm text-gray-400 mb-2">
                  Authenticate with your Origin account. This will open a browser window for login.
                </p>
                <pre className="bg-gray-800 rounded-lg px-4 py-3 text-sm font-mono text-gray-200 overflow-x-auto">
origin login</pre>
              </div>
            </div>

            {/* Step 3 */}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-600 text-white text-sm font-bold flex items-center justify-center">
                  3
                </span>
                <h3 className="font-medium text-gray-200">Initialize your machine</h3>
              </div>
              <div className="ml-10">
                <p className="text-sm text-gray-400 mb-2">
                  Register this machine and detect installed tools (git, node, etc.).
                </p>
                <pre className="bg-gray-800 rounded-lg px-4 py-3 text-sm font-mono text-gray-200 overflow-x-auto">
origin init</pre>
              </div>
            </div>

            {/* Step 4 */}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-600 text-white text-sm font-bold flex items-center justify-center">
                  4
                </span>
                <h3 className="font-medium text-gray-200">Add MCP server configuration</h3>
              </div>
              <div className="ml-10">
                <p className="text-sm text-gray-400 mb-3">
                  Add Origin as an MCP server in your AI coding tool. Choose your tool below:
                </p>

                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Claude Code &mdash; <code className="text-gray-400">~/.claude/claude_desktop_config.json</code>
                    </p>
                    <pre className="bg-gray-800 rounded-lg px-4 py-3 text-sm font-mono text-gray-200 overflow-x-auto">
{`{
  "mcpServers": {
    "origin": {
      "command": "origin",
      "args": ["mcp", "serve"],
      "env": {
        "ORIGIN_API_URL": "${window.location.origin}"
      }
    }
  }
}`}</pre>
                  </div>

                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                      Cursor &mdash; <code className="text-gray-400">.cursor/mcp.json</code>
                    </p>
                    <pre className="bg-gray-800 rounded-lg px-4 py-3 text-sm font-mono text-gray-200 overflow-x-auto">
{`{
  "mcpServers": {
    "origin": {
      "command": "origin",
      "args": ["mcp", "serve"],
      "env": {
        "ORIGIN_API_URL": "${window.location.origin}"
      }
    }
  }
}`}</pre>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 5 */}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-600 text-white text-sm font-bold flex items-center justify-center">
                  5
                </span>
                <h3 className="font-medium text-gray-200">Start coding</h3>
              </div>
              <div className="ml-10">
                <p className="text-sm text-gray-400">
                  That&apos;s it! Your agent sessions will now be tracked, governed by your policies,
                  and visible on the Origin dashboard. Every commit made by an AI agent will be
                  logged with full context including model, tokens, cost, and files changed.
                </p>
              </div>
            </div>
          </section>

          {/* Quick Reference */}
          <section className="card space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Quick Reference</h2>
              <p className="text-sm text-gray-500 mt-0.5">Common CLI commands</p>
            </div>
            <div className="space-y-2">
              {[
                { cmd: 'origin status', desc: 'Check connection status and machine info' },
                { cmd: 'origin sessions', desc: 'List recent agent sessions' },
                { cmd: 'origin policies', desc: 'View active governance policies' },
                { cmd: 'origin mcp serve', desc: 'Start the MCP server manually' },
              ].map(({ cmd, desc }) => (
                <div key={cmd} className="flex items-start gap-3 bg-gray-800/50 rounded-lg px-4 py-3">
                  <code className="text-sm text-indigo-400 font-mono whitespace-nowrap">{cmd}</code>
                  <span className="text-sm text-gray-500">&mdash;</span>
                  <span className="text-sm text-gray-400">{desc}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
