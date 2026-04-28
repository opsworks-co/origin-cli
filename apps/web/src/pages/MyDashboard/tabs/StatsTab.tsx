import { Link } from 'react-router-dom';
import { MyStats, fmt, fmtCost } from '../utils';
import { ActivityHeatmap } from '../ActivityHeatmap';
import { AgentPie } from '../AgentPie';

// `topFiles[].file` sometimes arrives as a JSON-stringified array (e.g. when
// a session's `filesChanged` column was aggregated upstream without being
// flattened). Render each underlying path as its own row instead of dumping
// the raw JSON string in the UI.
function expandFileEntries(entries: { file: string; count: number }[]): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = [];
  for (const e of entries) {
    const raw = (e.file || '').trim();
    let parsed: string[] | null = null;
    if (raw.startsWith('[')) {
      try {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) parsed = v.filter((x) => typeof x === 'string');
      } catch { /* fall through */ }
    }
    if (parsed && parsed.length > 0) {
      for (const p of parsed) out.push({ file: p, count: e.count });
    } else if (parsed && parsed.length === 0) {
      // Empty array — skip ("[]" is noise).
      continue;
    } else {
      out.push({ file: raw, count: e.count });
    }
  }
  // Re-aggregate by path so duplicates from multiple buckets sum.
  const agg = new Map<string, number>();
  for (const e of out) {
    if (!e.file) continue;
    agg.set(e.file, (agg.get(e.file) || 0) + e.count);
  }
  return Array.from(agg.entries())
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count);
}

// Strip the user's homedir prefix so paths read as repo-relative.
function shortenFilePath(p: string): string {
  if (!p) return p;
  const m = p.match(/^["']?\/Users\/[^/]+\/(.+?)["']?$/);
  if (m) return m[1];
  return p.replace(/^["']|["']$/g, '');
}

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
                  {(() => {
                    const expanded = expandFileEntries(stats.topFiles).slice(0, 10);
                    if (expanded.length === 0) {
                      return <p className="text-xs text-gray-600">No file data yet</p>;
                    }
                    const maxCount = expanded[0]?.count || 1;
                    return (
                      <div className="space-y-2">
                        {expanded.map((f, i) => {
                          const display = shortenFilePath(f.file);
                          // Link to Sessions filtered to this file. We pass the
                          // basename — the Sessions search filter matches it
                          // against the per-session filesChanged list.
                          // Strip stray quotes/brackets from JSON-stringified
                          // entries so the URL prefill is just `mcp.ts` not
                          // `mcp.ts"`.
                          const basename = (f.file.split('/').pop() || f.file)
                            .replace(/^["[\]]+|["[\]]+$/g, '')
                            .trim();
                          return (
                            <Link
                              key={i}
                              to={`/sessions?q=${encodeURIComponent(basename)}`}
                              className="block group"
                              title={`See sessions touching ${f.file}`}
                            >
                              <div className="flex items-center justify-between text-xs mb-0.5 gap-2">
                                <span className="text-gray-400 group-hover:text-gray-200 font-mono truncate transition-colors" title={f.file}>
                                  {display}
                                </span>
                                <span className="text-gray-500 flex-shrink-0">{f.count}x</span>
                              </div>
                              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-indigo-500/60 group-hover:bg-indigo-400 rounded-full transition-colors"
                                  style={{ width: `${(f.count / maxCount) * 100}%` }}
                                />
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    );
                  })()}
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
                          <Link
                            key={i}
                            to={r.repoId ? `/repos/${r.repoId}` : '#'}
                            className="block group"
                            title={`Open ${r.repoName}`}
                          >
                            <div className="flex items-center justify-between text-xs mb-0.5">
                              <span className="text-gray-400 group-hover:text-gray-200 transition-colors">{r.repoName}</span>
                              <span className="text-gray-500">{r.sessions} sessions</span>
                            </div>
                            <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-cyan-500/60 group-hover:bg-cyan-400 rounded-full transition-colors"
                                style={{ width: `${(r.sessions / maxSessions) * 100}%` }}
                              />
                            </div>
                          </Link>
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
