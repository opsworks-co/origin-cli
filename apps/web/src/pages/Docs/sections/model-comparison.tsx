import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function ModelComparisonSection() {
  return (
    <>
          <div>
            <h1 id="model-comparison" className="text-2xl font-bold mb-2">Model Comparison</h1>
            <P>
              Compare AI model performance across your organization. See which models
              are most cost-effective, produce the highest-quality code, and best fit
              different task types.
            </P>

            {/* Model Comparison Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Model Comparison</span>
              </div>
              <div className="p-4">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase border-b border-gray-700/50">
                      <th className="text-left py-1.5 font-medium">Model</th>
                      <th className="text-right py-1.5 font-medium">Sessions</th>
                      <th className="text-right py-1.5 font-medium">Avg Cost</th>
                      <th className="text-right py-1.5 font-medium">Avg Duration</th>
                      <th className="text-right py-1.5 font-medium">Avg Tokens</th>
                      <th className="text-right py-1.5 font-medium">Approval</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {[
                      { model: 'claude-sonnet-4', sessions: 89, cost: '$0.68', dur: '6m 12s', tokens: '24.1k', approval: '94%', best: true },
                      { model: 'claude-opus-4', sessions: 24, cost: '$3.42', dur: '14m 05s', tokens: '62.3k', approval: '97%', best: false },
                      { model: 'gpt-4o', sessions: 34, cost: '$0.52', dur: '4m 38s', tokens: '18.7k', approval: '86%', best: false },
                    ].map((m, i) => (
                      <tr key={i} className="hover:bg-gray-800/30">
                        <td className="py-2">
                          <span className="text-gray-200 font-mono">{m.model}</span>
                          {m.best && <span className="ml-1.5 text-[9px] text-indigo-400">best value</span>}
                        </td>
                        <td className="py-2 text-gray-300 text-right">{m.sessions}</td>
                        <td className="py-2 text-gray-300 text-right">{m.cost}</td>
                        <td className="py-2 text-gray-400 text-right">{m.dur}</td>
                        <td className="py-2 text-gray-400 text-right">{m.tokens}</td>
                        <td className="py-2 text-right">
                          <span className={parseInt(m.approval) >= 90 ? 'text-green-400' : 'text-amber-400'}>{m.approval}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <H2>How It Works</H2>
            <P>
              Origin aggregates session data by model to compute comparative statistics.
              Every session records the model used (e.g. <code className="text-indigo-400">claude-code</code>,
              <code className="text-indigo-400">cursor</code>, <code className="text-indigo-400">copilot</code>),
              along with cost, duration, token usage, and review outcomes. The comparison page
              queries these aggregations side by side.
            </P>

            <H2>Comparison Metrics</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Total Sessions</strong> &mdash; How many sessions used each model</Li>
              <Li><strong className="text-gray-200">Average Cost</strong> &mdash; Mean cost per session for the model</Li>
              <Li><strong className="text-gray-200">Average Duration</strong> &mdash; Mean session duration (how long it takes to complete tasks)</Li>
              <Li><strong className="text-gray-200">Token Usage</strong> &mdash; Average input and output tokens per session</Li>
              <Li><strong className="text-gray-200">Approval Rate</strong> &mdash; Percentage of reviewed sessions approved for each model</Li>
              <Li><strong className="text-gray-200">Lines Changed</strong> &mdash; Average code output per session</Li>
            </ul>

            <H2>Trend Analysis</H2>
            <P>
              The comparison includes a timeline chart showing model usage trends over time.
              Track adoption shifts as your team experiments with different models, and correlate
              model switches with changes in cost or quality metrics.
            </P>

            <H2>API</H2>
            <CodeBlock title="Model Comparison API">{`GET /api/models/comparison
# Returns: per-model stats (sessions, avgCost, avgDuration, avgTokens, approvalRate)
#          and daily trend data for charts`}</CodeBlock>

            <Callout type="tip">
              Use Model Comparison to inform your MODEL_ALLOWLIST policy. If a model consistently
              produces low-quality output (low approval rate), consider restricting it.
            </Callout>
          </div>
    </>
  );
}
