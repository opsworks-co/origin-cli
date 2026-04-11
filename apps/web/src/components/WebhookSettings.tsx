import React, { useEffect, useState } from 'react';
import * as api from '../api';

export default function WebhookSettings({ repoId }: { repoId: string }) {
  const [webhooks, setWebhooks] = useState<api.Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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

  if (loading) return null;

  const hasWebhook = webhooks.length > 0;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-800/30 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <span className="text-xs font-medium text-gray-300">GitHub Webhook</span>
          <span className="text-[10px] text-gray-600">(optional — repos sync automatically)</span>
          {hasWebhook && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-900/30 text-green-400">Active</span>
          )}
        </div>
        <svg
          className={`w-3 h-3 text-gray-500 transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-gray-800 p-3 space-y-3">
          <p className="text-xs text-gray-500">
            Origin already syncs your repos automatically. A webhook is only needed if you want
            <em className="text-gray-400"> real-time</em> push-event updates instead of the usual polling.
          </p>

          {!hasWebhook && !newSecret && (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="btn-secondary text-xs py-1.5 px-3"
            >
              {creating ? 'Creating...' : 'Create Webhook'}
            </button>
          )}

          {newSecret && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-600/5 p-3">
              <p className="text-xs font-medium text-amber-400 mb-1.5">Webhook secret (shown once):</p>
              <code className="block text-[11px] font-mono bg-gray-950 p-2 rounded text-gray-300 break-all select-all">
                {newSecret}
              </code>
              <p className="text-[10px] text-gray-500 mt-1.5">Copy and add it to your GitHub webhook configuration.</p>
            </div>
          )}

          {webhooks.map((wh) => (
            <div key={wh.id} className="rounded-lg border border-gray-800 bg-gray-950/50 p-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <code className="text-[11px] font-mono text-indigo-400 block truncate">
                    {window.location.origin}{wh.webhookUrl}
                  </code>
                  <p className="text-[10px] text-gray-600 mt-0.5">
                    Events: push · Created {new Date(wh.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(wh.id)}
                  className="text-[10px] text-red-400 hover:text-red-300 flex-shrink-0"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}

          <details className="text-[11px] text-gray-500">
            <summary className="cursor-pointer hover:text-gray-400">Setup instructions</summary>
            <ol className="list-decimal list-inside space-y-0.5 mt-2 pl-1">
              <li>Go to your GitHub repo &rarr; Settings &rarr; Webhooks</li>
              <li>Add the webhook URL shown above</li>
              <li>Set Content type to <code className="text-gray-400">application/json</code></li>
              <li>Paste the secret</li>
              <li>Select "Just the push event"</li>
            </ol>
          </details>
        </div>
      )}
    </div>
  );
}
