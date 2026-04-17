import { MyStats, fmt, fmtCost } from '../utils';
import { ActivityHeatmap } from '../ActivityHeatmap';
import { AgentPie } from '../AgentPie';

export function StatsTab({
  statsLoading,
  stats,
}: {
  statsLoading: boolean;
  stats: MyStats | null;
}) {
  return (
        <div className="space-y-6" data-tour="tab-content-stats">
          {statsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="card py-8 animate-pulse">
                  <div className="h-4 w-32 bg-gray-800 rounded mb-3" />
                  <div className="h-20 bg-gray-800 rounded" />
                </div>
              ))}
            </div>
          ) : stats ? (
            <>
              {/* Activity heatmap */}
              <div className="card" data-tour="activity-heatmap">
                <h3 className="text-sm font-semibold text-gray-300 mb-3">Activity</h3>
                <ActivityHeatmap data={stats.heatmap} />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Agent breakdown */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Agents Used</h3>
                  <AgentPie data={stats.agentBreakdown} />
                  <div className="mt-3 space-y-1">
                    {stats.agentBreakdown.map((a, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-gray-400">{a.agentName}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-gray-500">{a.sessions} sessions</span>
                          <span className="text-gray-300">{fmtCost(a.cost)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Top files */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Most Modified Files</h3>
                  {stats.topFiles.length === 0 ? (
                    <p className="text-xs text-gray-600">No file data yet</p>
                  ) : (
                    <div className="space-y-2">
                      {stats.topFiles.slice(0, 10).map((f, i) => {
                        const maxCount = stats.topFiles[0]?.count || 1;
                        return (
                          <div key={i}>
                            <div className="flex items-center justify-between text-xs mb-0.5">
                              <span className="text-gray-400 font-mono truncate max-w-[250px]" title={f.file}>
                                {f.file}
                              </span>
                              <span className="text-gray-500 ml-2 flex-shrink-0">{f.count}x</span>
                            </div>
                            <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-indigo-500/60 rounded-full"
                                style={{ width: `${(f.count / maxCount) * 100}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Sessions by repo */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Sessions by Repository</h3>
                  {stats.sessionsByRepo.length === 0 ? (
                    <p className="text-xs text-gray-600">No repo data yet</p>
                  ) : (
                    <div className="space-y-2">
                      {stats.sessionsByRepo.slice(0, 8).map((r, i) => {
                        const maxSessions = stats.sessionsByRepo[0]?.sessions || 1;
                        return (
                          <div key={i}>
                            <div className="flex items-center justify-between text-xs mb-0.5">
                              <span className="text-gray-400">{r.repoName}</span>
                              <span className="text-gray-500">{r.sessions} sessions</span>
                            </div>
                            <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-cyan-500/60 rounded-full"
                                style={{ width: `${(r.sessions / maxSessions) * 100}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Model breakdown */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-3">Models Used</h3>
                  {stats.modelBreakdown.length === 0 ? (
                    <p className="text-xs text-gray-600">No model data yet</p>
                  ) : (
                    <div className="space-y-1.5">
                      {stats.modelBreakdown.map((m, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="text-gray-400 font-mono">{m.model}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-gray-500">{m.sessions}x</span>
                            <span className="text-gray-300">{fmtCost(m.cost)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Code impact summary */}
              <div className="card">
                <h3 className="text-sm font-semibold text-gray-300 mb-3">Code Impact</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs text-gray-500 mb-0.5">Lines Added</div>
                    <div className="text-lg font-bold text-green-400">+{fmt(stats.totalLinesAdded)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-0.5">Lines Removed</div>
                    <div className="text-lg font-bold text-red-400">-{fmt(stats.totalLinesRemoved)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-0.5">Tool Calls</div>
                    <div className="text-lg font-bold text-gray-200">{fmt(stats.totalToolCalls)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-0.5">Net Lines</div>
                    <div className={`text-lg font-bold ${stats.totalLinesAdded - stats.totalLinesRemoved >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {stats.totalLinesAdded - stats.totalLinesRemoved >= 0 ? '+' : ''}{fmt(stats.totalLinesAdded - stats.totalLinesRemoved)}
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="card py-12 text-center text-gray-600">
              Failed to load stats. Try refreshing.
            </div>
          )}
        </div>
  );
}
