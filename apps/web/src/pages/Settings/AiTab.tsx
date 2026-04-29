import React, { useEffect, useState } from 'react';

// Settings → AI tab: manage the org-level LLM API key (used for AI-generated
// session titles + future LLM-backed features) and provide a "recompute
// costs" diagnostic for sessions whose stored cost looks wrong vs. their
// stored token counts.

type Provider = 'anthropic' | 'openai';

interface LlmConfig {
  provider: Provider | null;
  configured: boolean;
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

export default function AiTab() {
  const [cfg, setCfg] = useState<LlmConfig | null>(null);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [removing, setRemoving] = useState(false);

  // Recompute panel
  const [recomputeRunning, setRecomputeRunning] = useState(false);
  const [recomputeResult, setRecomputeResult] = useState<RecomputeResult | null>(null);
  const [recomputeError, setRecomputeError] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const res = await fetch('/api/settings/llm', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCfg(data);
        if (data.provider) setProvider(data.provider);
      }
    } catch { /* ignore */ }
  };

  const save = async () => {
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setSuccess('Saved. AI summaries enabled.');
      setApiKey('');
      await loadConfig();
    } catch (err: any) {
      setError(err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setError('');
    setSuccess('');
    setRemoving(true);
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setSuccess('Removed. Falling back to heuristic titles.');
      await loadConfig();
    } catch (err: any) {
      setError(err?.message || 'Failed to remove');
    } finally {
      setRemoving(false);
    }
  };

  const runRecompute = async (dryRun: boolean) => {
    setRecomputeError('');
    setRecomputeResult(null);
    setRecomputeRunning(true);
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
      const data = await res.json();
      setRecomputeResult(data);
    } catch (err: any) {
      setRecomputeError(err?.message || 'Failed to recompute');
    } finally {
      setRecomputeRunning(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* ── LLM API Key ───────────────────────────────────────── */}
      <section className="card space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">LLM API Key</h2>
          <p className="text-sm text-gray-500 mt-1">
            Used to generate AI session titles ("Refactored auth middleware") and other
            LLM-backed features. Without a key, Origin falls back to a deterministic
            heuristic (first prompt's first line).
          </p>
        </div>

        {cfg?.configured && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.05] px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-sm text-emerald-300">
                Configured · {cfg.provider === 'anthropic' ? 'Anthropic (Claude Haiku)' : 'OpenAI (gpt-4o-mini)'}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">Key is encrypted on the server. Never returned in API responses.</div>
            </div>
            <button
              onClick={remove}
              disabled={removing}
              className="px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
            >
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 mb-2 block">Provider</label>
            <div className="flex gap-2">
              {(['anthropic', 'openai'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    provider === p
                      ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40'
                      : 'bg-gray-900/40 text-gray-400 border-white/[0.06] hover:text-gray-200'
                  }`}
                >
                  {p === 'anthropic' ? 'Anthropic (Claude Haiku)' : 'OpenAI (gpt-4o-mini)'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-1.5 block">
              {cfg?.configured ? 'Replace API key' : 'API key'}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
              className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-white/[0.08] text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500/50 font-mono"
              autoComplete="off"
            />
            <p className="text-[11px] text-gray-600 mt-1.5">
              Cheap models — one ~30-token call per session = fractions of a cent.
            </p>
          </div>

          {error && <div className="text-sm text-red-400">{error}</div>}
          {success && <div className="text-sm text-emerald-400">{success}</div>}

          <div className="flex justify-end">
            <button
              onClick={save}
              disabled={saving || apiKey.trim().length < 10}
              className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : cfg?.configured ? 'Replace key' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      {/* ── Cost recompute ────────────────────────────────────── */}
      <section className="card space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Recompute session costs</h2>
          <p className="text-sm text-gray-500 mt-1">
            Re-derives every session's cost from the stored token counts using the current
            pricing table. Useful if older sessions were stamped with a stale price (e.g.
            before the Opus rate fix). Idempotent — sessions that already match are skipped.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => runRecompute(true)}
            disabled={recomputeRunning}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 transition-colors disabled:opacity-50"
          >
            {recomputeRunning ? 'Computing…' : 'Dry-run preview'}
          </button>
          <button
            onClick={() => runRecompute(false)}
            disabled={recomputeRunning}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
          >
            {recomputeRunning ? 'Running…' : 'Run recompute'}
          </button>
        </div>

        {recomputeError && <div className="text-sm text-red-400">{recomputeError}</div>}

        {recomputeResult && (
          <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-xs text-gray-500">Scanned</div>
                <div className="text-gray-100 font-mono">{recomputeResult.scanned}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Updated</div>
                <div className="text-indigo-300 font-mono">{recomputeResult.updated}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Unchanged</div>
                <div className="text-gray-400 font-mono">{recomputeResult.unchanged}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Skipped</div>
                <div className="text-gray-500 font-mono" title="No token data — can't recompute">
                  {recomputeResult.skipped}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm pt-2 border-t border-gray-800">
              <div>
                <span className="text-xs text-gray-500 mr-2">Org total:</span>
                <span className="text-gray-300 font-mono">${recomputeResult.totalCostBefore.toFixed(2)}</span>
                <span className="text-gray-600 mx-2">→</span>
                <span className="text-emerald-400 font-mono">${recomputeResult.totalCostAfter.toFixed(2)}</span>
              </div>
              {Math.abs(recomputeResult.totalCostAfter - recomputeResult.totalCostBefore) > 0.01 && (
                <span className={`text-xs px-2 py-0.5 rounded ${
                  recomputeResult.totalCostAfter < recomputeResult.totalCostBefore
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-amber-500/15 text-amber-400'
                }`}>
                  {recomputeResult.totalCostAfter < recomputeResult.totalCostBefore ? '−' : '+'}
                  ${Math.abs(recomputeResult.totalCostAfter - recomputeResult.totalCostBefore).toFixed(2)}
                </span>
              )}
            </div>
            {recomputeResult.topChanges.length > 0 && (
              <div className="pt-2 border-t border-gray-800">
                <div className="text-xs text-gray-500 mb-2">Largest changes</div>
                <div className="space-y-1">
                  {recomputeResult.topChanges.map((c) => (
                    <div key={c.sessionId} className="flex items-center justify-between text-xs">
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
      </section>
    </div>
  );
}
