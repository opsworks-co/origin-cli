import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function AnalyticsSection() {
  return (
    <>
          <div>
            <h1 id="analytics" className="text-2xl font-bold mb-2">Enhanced Analytics</h1>
            <P>
              The Insights page provides comprehensive analytics across all AI coding operations
              with customizable date range filtering and multiple chart types.
            </P>

            {/* Analytics Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Insights</span>
              </div>
              <div className="p-4">
                {/* Date range controls */}
                <div className="flex gap-1.5 mb-4">
                  {['7d', '30d', '90d', 'Year'].map((p, i) => (
                    <div key={i} className={`px-2 py-1 rounded text-[10px] cursor-pointer ${i === 1 ? 'bg-indigo-600/30 text-indigo-400 border border-indigo-500/40' : 'bg-gray-800 text-gray-500 border border-gray-700'}`}>{p}</div>
                  ))}
                </div>

                {/* Chart grid */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Cost Over Time */}
                  <div className="bg-gray-800/40 rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase mb-2">Cost Over Time</div>
                    <div className="flex items-end gap-0.5 h-16">
                      {[12, 18, 15, 22, 19, 25, 20, 28, 24, 30, 26, 22, 18, 24].map((h, i) => (
                        <div key={i} className="flex-1 bg-indigo-500/40 rounded-t hover:bg-indigo-500/60" style={{ height: `${h * 3}%` }} />
                      ))}
                    </div>
                    <div className="flex justify-between text-[9px] text-gray-600 mt-1">
                      <span>Mar 1</span><span>Mar 30</span>
                    </div>
                  </div>

                  {/* Token Usage */}
                  <div className="bg-gray-800/40 rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase mb-2">Tokens Over Time</div>
                    <div className="flex items-end gap-0.5 h-16">
                      {[8, 14, 11, 18, 15, 20, 17, 22, 19, 25, 21, 18, 14, 20].map((h, i) => (
                        <div key={i} className="flex-1 bg-purple-500/40 rounded-t hover:bg-purple-500/60" style={{ height: `${h * 3}%` }} />
                      ))}
                    </div>
                    <div className="flex justify-between text-[9px] text-gray-600 mt-1">
                      <span>Mar 1</span><span>Mar 30</span>
                    </div>
                  </div>

                  {/* Cost by Model */}
                  <div className="bg-gray-800/40 rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase mb-2">Cost by Model</div>
                    <div className="space-y-1.5">
                      {[
                        { model: 'sonnet-4', pct: 60, cost: '$168' },
                        { model: 'opus-4', pct: 33, cost: '$92' },
                        { model: 'gpt-4o', pct: 7, cost: '$24' },
                      ].map((m, i) => (
                        <div key={i} className="flex items-center gap-2 text-[10px]">
                          <span className="text-gray-400 w-14 truncate">{m.model}</span>
                          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                            <div className="h-full bg-indigo-500/60 rounded-full" style={{ width: `${m.pct}%` }} />
                          </div>
                          <span className="text-gray-300 w-10 text-right">{m.cost}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Session Quality */}
                  <div className="bg-gray-800/40 rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase mb-2">Session Quality</div>
                    <div className="flex items-center justify-center gap-4 h-12">
                      <div className="text-center">
                        <div className="text-sm font-bold text-green-400">78%</div>
                        <div className="text-[9px] text-gray-500">Approved</div>
                      </div>
                      <div className="text-center">
                        <div className="text-sm font-bold text-amber-400">14%</div>
                        <div className="text-[9px] text-gray-500">Flagged</div>
                      </div>
                      <div className="text-center">
                        <div className="text-sm font-bold text-red-400">3%</div>
                        <div className="text-[9px] text-gray-500">Rejected</div>
                      </div>
                      <div className="text-center">
                        <div className="text-sm font-bold text-gray-400">5%</div>
                        <div className="text-[9px] text-gray-500">Pending</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <H2>Date Range Filtering</H2>
            <P>
              Use the date range controls at the top of the Insights page to filter all charts:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Preset buttons</strong> &mdash; Quick filters: 7d, 30d, 90d, Year</Li>
              <Li><strong className="text-gray-200">Custom range</strong> &mdash; Pick exact start and end dates</Li>
            </ul>
            <P>
              All charts update simultaneously when the date range changes.
              The stats API accepts <code className="text-indigo-400">from</code> and{' '}
              <code className="text-indigo-400">to</code> query parameters.
            </P>

            <H2>Available Charts</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">AI Authorship % Over Time</strong> &mdash; Percentage of commits authored by AI agents per day</Li>
              <Li><strong className="text-gray-200">Cost by Model</strong> &mdash; Total spend broken down by AI model</Li>
              <Li><strong className="text-gray-200">Cost Over Time</strong> &mdash; Daily cost trend chart</Li>
              <Li><strong className="text-gray-200">Lines Changed Over Time</strong> &mdash; Stacked area chart showing lines added (green) and removed (red) per day</Li>
              <Li><strong className="text-gray-200">Sessions by Repository</strong> &mdash; Session count per repo</Li>
              <Li><strong className="text-gray-200">Cost by Repository</strong> &mdash; Spend breakdown per repository</Li>
              <Li><strong className="text-gray-200">Top Engineers</strong> &mdash; Developers with most AI-assisted sessions</Li>
              <Li><strong className="text-gray-200">Activity by Hour</strong> &mdash; Session distribution across hours (0-23), useful for understanding work patterns</Li>
              <Li><strong className="text-gray-200">Session Quality</strong> &mdash; Donut chart of approved/rejected/flagged/pending reviews</Li>
              <Li><strong className="text-gray-200">Secret Detections</strong> &mdash; Findings by detection type</Li>
              <Li><strong className="text-gray-200">Policy Violations</strong> &mdash; Violations by policy type</Li>
              <Li><strong className="text-gray-200">Cost by User</strong> &mdash; Individual developer spend</Li>
              <Li><strong className="text-gray-200">Tokens Over Time</strong> &mdash; Daily token consumption trend</Li>
              <Li><strong className="text-gray-200">Duration Distribution</strong> &mdash; Session duration buckets (&lt;1m, 1-5m, 5-15m, 15m+)</Li>
            </ul>

            <H2>Dashboard Integration</H2>
            <P>
              Key metrics are surfaced directly on the Dashboard:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Compliance Score</strong> &mdash; Overall governance health (0-100)</Li>
              <Li><strong className="text-gray-200">Secrets Found</strong> &mdash; Total secret/PII findings across scanned diffs</Li>
              <Li>Standard KPIs: active agents, sessions this week, unreviewed count, estimated monthly cost</Li>
            </ul>

            <H2>API Access</H2>
            <CodeBlock title="Stats API with date filtering">{`# Default: last 30 days
GET /api/stats

# Custom date range
GET /api/stats?from=2025-01-01&to=2025-03-31

# Response includes all chart data:
# sessionsByDay, costByDay, tokensByDay, linesByDay,
# costByModel, costByRepo, sessionsByHour,
# secretsByType, violationsByType, qualityMetrics, etc.`}</CodeBlock>

            <Callout type="tip">
              Combine Insights with Compliance Reports for a complete governance picture.
              The Reports page generates exportable compliance snapshots while Insights provides
              interactive, drill-down analytics.
            </Callout>
          </div>
    </>
  );
}
