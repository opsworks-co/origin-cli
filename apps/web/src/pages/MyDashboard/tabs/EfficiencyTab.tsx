import { DollarSign, GitCommit } from 'lucide-react';
import { Efficiency, fmtCost } from '../utils';

export function EfficiencyTab({
  efficiencyLoading,
  efficiency,
}: {
  efficiencyLoading: boolean;
  efficiency: Efficiency | null;
}) {
  return (
        <div className="space-y-6" data-tour="tab-content-efficiency">
          {efficiencyLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="card py-8 animate-pulse">
                  <div className="h-4 w-32 bg-gray-800 rounded mb-3" />
                  <div className="h-24 bg-gray-800 rounded" />
                </div>
              ))}
            </div>
          ) : efficiency ? (
            <>
              {/* Efficiency metrics */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Tokens / Line</div>
                  <div className="text-2xl font-bold text-gray-100">
                    {efficiency.tokensPerLine > 0 ? efficiency.tokensPerLine.toFixed(0) : '—'}
                  </div>
                  <div className="text-xs text-gray-600">token efficiency</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Cost / Session</div>
                  <div className="text-2xl font-bold text-gray-100">{fmtCost(efficiency.costPerSession)}</div>
                  <div className="text-xs text-gray-600">average spend</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Cost / Commit</div>
                  <div className="text-2xl font-bold text-gray-100">{fmtCost(efficiency.costPerCommit)}</div>
                  <div className="text-xs text-gray-600">per code commit</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Lines / Session</div>
                  <div className="text-2xl font-bold text-gray-100">{efficiency.avgLinesPerSession.toFixed(0)}</div>
                  <div className="text-xs text-gray-600">avg output</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Commit stats */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">
                    <GitCommit className="w-4 h-4 inline mr-1.5 text-gray-500" />
                    Commit Stats
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <div className="text-xs text-gray-500 mb-0.5">Total Commits</div>
                      <div className="text-lg font-bold text-gray-200">{efficiency.commitStats.totalCommits}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-0.5">Per Session</div>
                      <div className="text-lg font-bold text-gray-200">{efficiency.commitStats.commitsPerSession.toFixed(1)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-0.5">Files / Commit</div>
                      <div className="text-lg font-bold text-gray-200">{efficiency.commitStats.avgFilesPerCommit.toFixed(1)}</div>
                    </div>
                  </div>
                </div>

                {/* Cost breakdown visual */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">
                    <DollarSign className="w-4 h-4 inline mr-1.5 text-gray-500" />
                    Efficiency Ratios
                  </h3>
                  <div className="space-y-3">
                    {[
                      { label: 'Tokens per line of code', value: efficiency.tokensPerLine, unit: '', good: efficiency.tokensPerLine < 200 },
                      { label: 'Avg cost per session', value: efficiency.costPerSession, unit: '$', good: efficiency.costPerSession < 0.50 },
                      { label: 'Commits per session', value: efficiency.commitStats.commitsPerSession, unit: '', good: efficiency.commitStats.commitsPerSession > 1 },
                    ].map((m, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-xs text-gray-400">{m.label}</span>
                        <span className={`text-sm font-semibold ${m.good ? 'text-green-400' : 'text-amber-400'}`}>
                          {m.unit === '$' ? fmtCost(m.value) : m.value.toFixed(1)}
                          {m.good ? ' ✓' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="card py-12 text-center text-gray-600">No efficiency data available.</div>
          )}
        </div>
  );
}
