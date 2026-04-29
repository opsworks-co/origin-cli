import { useState } from 'react';
import { Link } from 'react-router-dom';

// Settings → AI tab
//
// Single-purpose now: cost-recompute diagnostic. The LLM API key lives
// in Integrations (one key powers Chat, AI session titles, and any
// future LLM features) — no duplicate input here.

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
  const [recomputeRunning, setRecomputeRunning] = useState(false);
  const [recomputeResult, setRecomputeResult] = useState<RecomputeResult | null>(null);
  const [recomputeError, setRecomputeError] = useState('');

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
      {/* Pointer to canonical LLM key */}
      <section className="card">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-indigo-500/15 flex items-center justify-center">
            <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-gray-100">LLM API key</h2>
            <p className="text-sm text-gray-500 mt-1">
              One key powers Chat, AI-generated session titles, and any other LLM features.
              Configure it once in <Link to="/settings?tab=integrations" className="text-indigo-400 hover:underline">Settings → Integrations → AI Provider</Link>.
            </p>
          </div>
        </div>
      </section>

      {/* Cost recompute */}
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
