import { useState } from 'react';
import { Wrench } from 'lucide-react';

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
 * a stale price (e.g. before the Opus rate fix). Lives at the bottom
 * of the Budget page as an admin diagnostic.
 */
export default function RecomputeCostsCard() {
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
        className="w-full flex items-center justify-between text-left gap-3"
      >
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2">
            <Wrench className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <h2 className="text-sm font-semibold text-gray-200">Recompute session costs</h2>
          </div>
          <p className="text-xs text-gray-500 truncate">
            Diagnostic. Re-derives every session's cost from stored token counts using the current pricing table.
          </p>
        </div>
        <span className="text-gray-500 text-sm shrink-0">{open ? '▾' : '▸'}</span>
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
