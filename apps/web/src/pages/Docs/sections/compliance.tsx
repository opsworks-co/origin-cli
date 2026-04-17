import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function ComplianceSection() {
  return (
    <>
          <div>
            <h1 id="compliance" className="text-2xl font-bold mb-2">Compliance Reports</h1>
            <P>
              Generate comprehensive compliance reports covering session activity, policy violations,
              review coverage, and security findings. Reports can be filtered by date range and
              exported as JSON.
            </P>

            {/* Compliance Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Compliance Report &mdash; Jan 2025</span>
              </div>
              <div className="p-4">
                {/* Score gauge */}
                <div className="flex items-center gap-6 mb-4">
                  <div className="relative w-20 h-20">
                    <svg viewBox="0 0 36 36" className="w-20 h-20">
                      <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#374151" strokeWidth="3" />
                      <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#22c55e" strokeWidth="3" strokeDasharray="85, 100" strokeLinecap="round" />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-lg font-bold text-green-400">85</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-200 font-medium">Compliance Score</div>
                    <div className="text-[10px] text-green-400">Excellent</div>
                  </div>
                </div>

                {/* Section breakdown */}
                <div className="space-y-2">
                  {[
                    { label: 'Review Coverage', weight: '40%', score: 92, color: 'green' },
                    { label: 'Violation Rate', weight: '30%', score: 78, color: 'green' },
                    { label: 'Secret Detection', weight: '20%', score: 85, color: 'green' },
                    { label: 'Base Score', weight: '10%', score: 100, color: 'green' },
                  ].map((s, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs">
                      <span className="text-gray-400 w-32">{s.label}</span>
                      <span className="text-gray-600 w-8">{s.weight}</span>
                      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${s.score >= 80 ? 'bg-green-500/60' : s.score >= 60 ? 'bg-amber-500/60' : 'bg-red-500/60'}`} style={{ width: `${s.score}%` }} />
                      </div>
                      <span className="text-gray-300 w-8 text-right">{s.score}</span>
                    </div>
                  ))}
                </div>

                {/* Summary stats */}
                <div className="grid grid-cols-4 gap-2 mt-4 pt-3 border-t border-gray-700/50">
                  {[
                    { label: 'Sessions', value: '124' },
                    { label: 'Violations', value: '3' },
                    { label: 'Secrets Found', value: '1' },
                    { label: 'Review Rate', value: '92%' },
                  ].map((s, i) => (
                    <div key={i} className="text-center">
                      <div className="text-sm font-bold text-gray-200">{s.value}</div>
                      <div className="text-[10px] text-gray-500">{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <H2 id="compliance-score">Compliance Score</H2>
            <P>
              The compliance score is a 0-100 metric calculated from four weighted factors:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Review Coverage (40%)</strong> &mdash; Percentage of sessions that have been reviewed</Li>
              <Li><strong className="text-gray-200">Violation Rate (30%)</strong> &mdash; Ratio of policy violations to total sessions (lower is better)</Li>
              <Li><strong className="text-gray-200">Secret Detection Rate (20%)</strong> &mdash; Ratio of secret findings to sessions (lower is better)</Li>
              <Li><strong className="text-gray-200">Base Score (10%)</strong> &mdash; Awarded for having the governance platform active</Li>
            </ul>
            <P>
              Score interpretation: <strong className="text-green-400">80+</strong> is excellent,{' '}
              <strong className="text-amber-400">60-79</strong> needs improvement,{' '}
              <strong className="text-red-400">below 60</strong> requires attention.
            </P>

            <H2>Generating Reports</H2>
            <P>
              Navigate to <strong className="text-gray-200">Reports</strong> in the sidebar. Select a date
              range using the date pickers or preset buttons (7 days, 30 days, Quarter, Year),
              then click &ldquo;Generate Report&rdquo;.
            </P>

            <H2>Report Sections</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Executive Summary</strong> &mdash; Total sessions, cost, violations, review rate, and secret findings</Li>
              <Li><strong className="text-gray-200">Policy Violations</strong> &mdash; Breakdown by policy type with visual chart</Li>
              <Li><strong className="text-gray-200">Review Coverage</strong> &mdash; Pie chart showing reviewed vs unreviewed sessions</Li>
              <Li><strong className="text-gray-200">Security Findings</strong> &mdash; Secret/PII detections by type</Li>
              <Li><strong className="text-gray-200">Model Usage</strong> &mdash; Sessions and cost per AI model</Li>
            </ul>

            <H2>Export</H2>
            <P>
              Click &ldquo;Download JSON&rdquo; to export the full report as a JSON file. The export includes
              all metrics, daily session activity, violation breakdowns, and model usage data.
            </P>

            <H2>API Access</H2>
            <CodeBlock title="Compliance Report API">{`# Generate report for date range
GET /api/reports/compliance?from=2025-01-01&to=2025-01-31

# Quick compliance score (last 30 days)
GET /api/reports/compliance/summary
# Response: { "score": 85 }`}</CodeBlock>

            <Callout type="info">
              The compliance score on the Dashboard is refreshed automatically and reflects the
              last 30 days of activity.
            </Callout>
          </div>
    </>
  );
}
