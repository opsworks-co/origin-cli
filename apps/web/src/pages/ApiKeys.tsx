import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export default function ApiKeys() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

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
      setConfirmId(null);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (label === 'key') {
        setCopiedKey(true);
        setTimeout(() => setCopiedKey(false), 1500);
      } else {
        setCopiedCmd(label);
        setTimeout(() => setCopiedCmd(null), 1500);
      }
    } catch {}
  };

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">API Keys</h1>
          <p className="text-sm text-gray-500 mt-0.5">Connect the Origin CLI to your account</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
          <span>{apiKeys.length} active {apiKeys.length === 1 ? 'key' : 'keys'}</span>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-4 py-3 text-red-400 text-sm flex items-start gap-2">
          <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300">×</button>
        </div>
      )}

      {/* Newly created key banner */}
      {createdKey && (
        <div className="bg-gradient-to-br from-emerald-900/30 to-emerald-950/20 border border-emerald-700/40 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-emerald-300">Key created successfully</h3>
                <p className="text-[11px] text-emerald-400/70">Copy it now — it won't be shown again</p>
              </div>
            </div>
            <button
              onClick={() => setCreatedKey(null)}
              className="text-emerald-500/60 hover:text-emerald-400 text-lg leading-none"
            >
              ×
            </button>
          </div>
          <div className="flex items-center gap-2 bg-gray-950/60 border border-emerald-800/30 rounded-lg px-3 py-2.5">
            <code className="text-sm text-emerald-300 break-all flex-1 font-mono select-all">{createdKey}</code>
            <button
              onClick={() => copyToClipboard(createdKey, 'key')}
              className="px-2.5 py-1 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 text-xs font-medium transition-colors flex items-center gap-1.5 flex-shrink-0"
            >
              {copiedKey ? (
                <>
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                  Copy
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Create new key */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          <h2 className="text-sm font-semibold text-gray-200">Create new key</h2>
        </div>
        <div className="flex gap-2">
          <input
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="Name this key (e.g. macbook-pro, ci-server)"
            className="input flex-1 text-sm"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newKeyName.trim()}
            className="btn-primary text-sm px-5 whitespace-nowrap disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create Key'}
          </button>
        </div>
        <p className="text-[11px] text-gray-600 mt-2">Give it a memorable name so you can revoke it later if a device is lost.</p>
      </div>

      {/* Existing keys */}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Your keys</h2>
          {apiKeys.length > 0 && <span className="text-[11px] text-gray-600">{apiKeys.length} total</span>}
        </div>

        {loading && (
          <div className="px-5 py-8 text-sm text-gray-500 text-center">Loading…</div>
        )}

        {!loading && apiKeys.length === 0 && !error && (
          <div className="px-5 py-12 text-center">
            <svg className="w-10 h-10 mx-auto text-gray-700 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            <p className="text-sm text-gray-500">No API keys yet</p>
            <p className="text-xs text-gray-600 mt-1">Create one above to connect the CLI</p>
          </div>
        )}

        {!loading && apiKeys.length > 0 && (
          <div className="divide-y divide-gray-800/60">
            {apiKeys.map((key) => (
              <div
                key={key.id}
                className="px-5 py-3.5 flex items-center gap-4 hover:bg-gray-800/20 transition-colors group"
              >
                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200 truncate">{key.name}</span>
                    <code className="text-[11px] text-emerald-400/80 font-mono truncate">{key.keyPrefix}…</code>
                  </div>
                  <span className="text-[11px] text-gray-600">Created {timeAgo(key.createdAt)}</span>
                </div>
                {confirmId === key.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500">Revoke?</span>
                    <button
                      onClick={() => handleRevoke(key.id)}
                      disabled={deletingId === key.id}
                      className="text-[11px] px-2.5 py-1 rounded-md bg-red-500/20 hover:bg-red-500/30 text-red-400 font-medium transition-colors disabled:opacity-50"
                    >
                      {deletingId === key.id ? '…' : 'Yes, revoke'}
                    </button>
                    <button
                      onClick={() => setConfirmId(null)}
                      className="text-[11px] px-2.5 py-1 rounded-md text-gray-400 hover:text-gray-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmId(key.id)}
                    className="text-[11px] px-2.5 py-1 rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
