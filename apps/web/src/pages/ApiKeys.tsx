import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
}

export default function ApiKeys() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await api.getApiKeys();
      setApiKeys(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api.createApiKey({ name: newKeyName.trim() });
      setCreatedKey(res.key);
      setNewKeyName('');
      await fetchKeys();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setDeletingId(id);
    try {
      await api.deleteApiKey(id);
      await fetchKeys();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">API Keys</h1>
        <p className="text-sm text-gray-500 mt-1">Create and manage keys to connect the Origin CLI to your account</p>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Existing keys */}
      <section className="card space-y-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Your Keys</h2>

        {loading && <div className="text-sm text-gray-500">Loading...</div>}

        {!loading && apiKeys.length > 0 && (
          <div className="space-y-2">
            {apiKeys.map((key) => (
              <div key={key.id} className="flex items-center justify-between bg-gray-800/50 rounded-lg px-4 py-3">
                <div>
                  <span className="text-sm text-gray-200">{key.name}</span>
                  <code className="block text-xs text-emerald-400 mt-0.5">{key.keyPrefix}...</code>
                  <span className="text-[10px] text-gray-600">Created {new Date(key.createdAt).toLocaleDateString()}</span>
                </div>
                <button
                  onClick={() => handleRevoke(key.id)}
                  disabled={deletingId === key.id}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  {deletingId === key.id ? 'Revoking...' : 'Revoke'}
                </button>
              </div>
            ))}
          </div>
        )}

        {!loading && apiKeys.length === 0 && !error && (
          <div className="text-sm text-gray-500 bg-gray-800/30 rounded-lg p-4 text-center">
            No API keys yet. Create one to connect the CLI.
          </div>
        )}

        {createdKey && (
          <div className="bg-emerald-900/20 border border-emerald-800 rounded-lg p-3">
            <p className="text-xs text-emerald-400 mb-1">Copy this key — it won't be shown again:</p>
            <code className="text-sm text-emerald-300 break-all select-all">{createdKey}</code>
          </div>
        )}

        <div className="flex gap-2">
          <input
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="Key name (e.g. laptop)"
            className="input flex-1 text-sm"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newKeyName.trim()}
            className="btn-primary text-sm px-4"
          >
            {creating ? 'Creating...' : 'Create Key'}
          </button>
        </div>
      </section>

      {/* Quick Setup */}
      <section className="card space-y-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Quick Setup</h2>
        <div className="space-y-1 font-mono text-sm text-emerald-400">
          <p>$ npm i -g https://getorigin.io/cli/origin-cli-latest.tgz</p>
          <p>$ origin login --key YOUR_KEY</p>
          <p>$ origin init</p>
        </div>
        <a href="/docs" className="inline-block text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
          View full setup guide &rarr;
        </a>
      </section>
    </div>
  );
}
