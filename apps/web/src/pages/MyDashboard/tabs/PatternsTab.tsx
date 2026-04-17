import { CodingPatterns, fmt, fmtCost, fmtDuration } from '../utils';

export function PatternsTab({
  patternsLoading,
  patterns,
}: {
  patternsLoading: boolean;
  patterns: CodingPatterns | null;
}) {
  return (
        <div className="space-y-6" data-tour="tab-content-patterns">
          {patternsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="card py-8 animate-pulse">
                  <div className="h-4 w-32 bg-gray-800 rounded mb-3" />
                  <div className="h-24 bg-gray-800 rounded" />
                </div>
              ))}
            </div>
          ) : patterns ? (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Peak Hour</div>
                  <div className="text-2xl font-bold text-gray-100">
                    {patterns.peakHour}:00
                  </div>
                  <div className="text-xs text-gray-600">most active time</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Peak Day</div>
                  <div className="text-2xl font-bold text-gray-100">{patterns.peakDay}</div>
                  <div className="text-xs text-gray-600">most sessions</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">This Month</div>
                  <div className="text-2xl font-bold text-gray-100">{patterns.sessionsThisMonth}</div>
                  <div className="text-xs text-gray-600">sessions &middot; {fmtCost(patterns.costThisMonth)}</div>
                </div>
                <div className="card py-4">
                  <div className="text-xs text-gray-500 mb-1">Avg Session</div>
                  <div className="text-2xl font-bold text-gray-100">{fmtDuration(patterns.avgSessionDuration)}</div>
                  <div className="text-xs text-gray-600">{fmt(patterns.avgTokensPerSession)} tokens &middot; {fmtCost(patterns.avgCostPerSession)}</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Hour-of-day chart */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-4">Sessions by Hour</h3>
                  <div className="flex items-end gap-[3px] h-32">
                    {patterns.hourly.map((count, h) => {
                      const max = Math.max(1, ...patterns.hourly);
                      const pct = (count / max) * 100;
                      const isPeak = h === patterns.peakHour;
                      return (
                        <div key={h} className="flex-1 flex flex-col items-center gap-1">
                          <div
                            className={`w-full rounded-t transition-all ${isPeak ? 'bg-indigo-500' : 'bg-indigo-500/40'}`}
                            style={{ height: `${Math.max(pct, 2)}%` }}
                            title={`${h}:00 — ${count} sessions`}
                          />
                          {h % 4 === 0 && (
                            <span className="text-[9px] text-gray-600">{h}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-[9px] text-gray-600 mt-1">
                    <span>12am</span>
                    <span>12pm</span>
                    <span>11pm</span>
                  </div>
                </div>

                {/* Day-of-week chart */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-300 mb-4">Sessions by Day</h3>
                  <div className="space-y-2">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => {
                      const count = patterns.daily[i] || 0;
                      const max = Math.max(1, ...patterns.daily);
                      const pct = (count / max) * 100;
                      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                      const isPeak = dayNames[i] === patterns.peakDay;
                      return (
                        <div key={day} className="flex items-center gap-3">
                          <span className={`text-xs w-8 ${isPeak ? 'text-indigo-400 font-semibold' : 'text-gray-500'}`}>{day}</span>
                          <div className="flex-1 h-4 bg-gray-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${isPeak ? 'bg-indigo-500' : 'bg-indigo-500/40'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500 w-8 text-right">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="card py-12 text-center text-gray-600">No pattern data available.</div>
          )}
        </div>
  );
}
