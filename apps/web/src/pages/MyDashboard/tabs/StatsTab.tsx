import { Link } from 'react-router-dom';
import { MyStats, fmt, fmtCost } from '../utils';
import { displayAgentName } from '../../../utils';
import { ActivityHeatmap } from '../ActivityHeatmap';
import { AgentPie } from '../AgentPie';

// `topFiles[].file` sometimes arrives as a JSON-stringified array (legacy
// rows where the upstream stored the entire array as the file string). Now
// the backend parses JSON properly, but we keep this layer as a safety net
// for legacy data and to strip stray quotes/brackets that survived the
// pre-fix CSV-style split.
type TopFile = { file: string; count: number; repoId?: string | null };
function cleanFilePath(p: string): string {
  return p.replace(/^["[\]]+|["[\]]+$/g, '').trim();
}
function expandFileEntries(entries: TopFile[]): TopFile[] {
  const out: TopFile[] = [];
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
      for (const p of parsed) out.push({ file: p, count: e.count, repoId: e.repoId });
    } else if (parsed && parsed.length === 0) {
      continue;
    } else {
      out.push({ file: raw, count: e.count, repoId: e.repoId });
    }
  }
  // Re-aggregate by cleaned path so duplicates from multiple buckets sum.
  const agg = new Map<string, { count: number; repoId: string | null | undefined }>();
  for (const e of out) {
    const file = cleanFilePath(e.file);
    if (!file) continue;
    const cur = agg.get(file);
    if (cur) {
      cur.count += e.count;
      if (!cur.repoId && e.repoId) cur.repoId = e.repoId;
    } else {
      agg.set(file, { count: e.count, repoId: e.repoId });
    }
  }
  return Array.from(agg.entries())
    .map(([file, { count, repoId }]) => ({ file, count, repoId }))
    .sort((a, b) => b.count - a.count);
}

// Strip the user's homedir prefix so paths read as repo-relative.
function shortenFilePath(p: string): string {
  if (!p) return p;
  const m = p.match(/^["']?\/Users\/[^/]+\/(.+?)["']?$/);
  if (m) return m[1];
  return p.replace(/^["']|["']$/g, '');
}

function KpiTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="card !p-4">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-semibold ${accent || 'text-gray-100'}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
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
              {/* Top-level KPI strip — gives the Stats view a sturdy
                  visual anchor instead of a hollow heatmap card. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiTile label="Total Sessions" value={fmt(stats.totalSessions)} />
                <KpiTile
                  label="This Week"
                  value={`${fmt(stats.thisWeek.sessions)} sessions`}
                  sub={fmtCost(stats.thisWeek.cost)}
                />
                <KpiTile
                  label="Streak"
                  value={`${stats.streak} day${stats.streak === 1 ? '' : 's'}`}
                  sub={stats.streak > 0 ? 'keep it up' : 'start today'}
                  accent={stats.streak > 0 ? 'text-amber-300' : undefined}
                />
                <KpiTile
                  label="Total Spend"
                  value={fmtCost(stats.totalCost)}
                  sub={`${fmt(stats.totalTokens)} tokens`}
                />
              </div>

              {/* Activity heatmap + inline mini-summary so the wide card
                  no longer renders with a dead empty band below. */}
              <div className="card" data-tour="activity-heatmap">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-300">Activity</h3>
                  <div className="flex items-center gap-4 text-[11px] text-gray-500">
                    <span><span className="text-gray-300 font-medium">{fmt(stats.thisWeek.sessions)}</span> this week</span>
                    <span><span className="text-gray-300 font-medium">{fmt(stats.lastWeek.sessions)}</span> last week</span>
                    <span><span className="text-gray-300 font-medium">{stats.streak}</span>-day streak</span>
                  </div>
                </div>
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
                        <span className="text-gray-400">{displayAgentName(a.agentName) || a.agentName}</span>
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
                          // Prefer linking into the repo file viewer with the
                          // exact path so clicking opens the file's blame +
                          // diff. When repoId isn't known (legacy rows that
                          // didn't capture it), fall back to a Sessions search
                          // by basename so the link still goes somewhere
                          // useful.
                          const basename = (f.file.split('/').pop() || f.file)
                            .replace(/^["[\]]+|["[\]]+$/g, '')
                            .trim();
                          const linkTo = f.repoId
                            ? `/repos/${f.repoId}?file=${encodeURIComponent(f.file)}`
                            : `/sessions?q=${encodeURIComponent(basename)}`;
                          const linkTitle = f.repoId
                            ? `Open ${f.file} with authorship + changes`
                            : `See sessions touching ${f.file}`;
                          return (
                            <Link
                              key={i}
                              to={linkTo}
                              className="block group"
                              title={linkTitle}
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
