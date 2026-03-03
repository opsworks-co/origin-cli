import React, { useEffect, useState } from 'react';
import * as api from '../api';

export default function WebhookSettings({ repoId }: { repoId: string }) {
  const [webhooks, setWebhooks] = useState<api.Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const load = async () => {
    try {
      const wh = await api.getRepoWebhooks(repoId);
      setWebhooks(wh);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, [repoId]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await api.createRepoWebhook(repoId);
      setNewSecret(result.secret);
      await load();
    } catch { /* ignore */ }
    setCreating(false);
  };

  const handleDelete = async (webhookId: string) => {
    await api.deleteRepoWebhook(repoId, webhookId).catch(() => {});
    setNewSecret(null);
    await load();
  };

  if (loading) return <p className="text-gray-500 text-sm">Loading webhooks...</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">GitHub Webhooks</h3>
        {webhooks.length === 0 && (
          <button onClick={handleCreate} disabled={creating} className="btn-primary text-sm">
            {creating ? 'Creating...' : 'Create Webhook'}
          </button>
        )}
      </div>

      {newSecret && (
        <div className="card border-amber-500/30 bg-amber-600/5">
          <p className="text-sm font-medium text-amber-400 mb-2">Webhook secret (shown once):</p>
          <code className="block text-xs font-mono bg-gray-800 p-3 rounded-lg text-gray-300 break-all select-all">
            {newSecret}
          </code>
          <p className="text-xs text-gray-500 mt-2">Copy this secret and add it to your GitHub webhook configuration.</p>
        </div>
      )}

      {webhooks.length === 0 && !newSecret ? (
        <p className="text-gray-500 text-sm">No webhooks configured. Create one to auto-sync commits from GitHub.</p>
      ) : (
        webhooks.map(wh => (
          <div key={wh.id} className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-200">Webhook URL</p>
                <code className="text-xs font-mono text-indigo-400 mt-1 block">
                  {window.location.origin}{wh.webhookUrl}
                </code>
                <p className="text-xs text-gray-500 mt-2">
                  Events: push &middot; Created {new Date(wh.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  wh.active ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'
                }`}>
                  {wh.active ? 'Active' : 'Inactive'}
                </span>
                <button onClick={() => handleDelete(wh.id)} className="text-xs text-red-400 hover:text-red-300">
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))
      )}

      <div className="text-xs text-gray-500">
        <p className="font-medium text-gray-400 mb-1">Setup instructions:</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>Go to your GitHub repo &rarr; Settings &rarr; Webhooks</li>
          <li>Add the webhook URL shown above</li>
          <li>Set Content type to <code className="text-gray-400">application/json</code></li>
          <li>Paste the secret</li>
          <li>Select "Just the push event"</li>
        </ol>
      </div>
    </div>
  );
}
