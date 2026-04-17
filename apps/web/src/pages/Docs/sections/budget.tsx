import { H2, P, Li, Callout } from '../shared/Markdown';

export default function BudgetSection() {
  return (
    <>
          <div>
            <h1 id="budget" className="text-2xl font-bold mb-2">Budget & Cost Controls</h1>
            <P>
              Origin provides budget management to help organizations control AI coding costs
              with monthly limits, spend alerts, and optional hard blocks.
            </P>

            {/* Budget Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Budget &mdash; March 2025</span>
              </div>
              <div className="p-4">
                {/* Progress bar */}
                <div className="mb-4">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-400">Monthly Spend</span>
                    <span className="text-gray-300">$284 <span className="text-gray-500">/ $500</span></span>
                  </div>
                  <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden relative">
                    <div className="h-full bg-gradient-to-r from-indigo-600 to-indigo-400 rounded-full" style={{ width: '57%' }} />
                    {/* Alert threshold markers */}
                    <div className="absolute top-0 bottom-0 w-px bg-amber-500/60" style={{ left: '80%' }} />
                    <div className="absolute top-0 bottom-0 w-px bg-red-500/60" style={{ left: '100%' }} />
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                    <span>57% used</span>
                    <div className="flex gap-3">
                      <span className="text-amber-500/80">80% alert</span>
                      <span className="text-red-500/80">100% block</span>
                    </div>
                  </div>
                </div>

                {/* Spend breakdown */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gray-800/40 rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase mb-2">By Model</div>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between"><span className="text-gray-400">claude-sonnet-4</span><span className="text-gray-300">$168</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">claude-opus-4</span><span className="text-gray-300">$92</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">gpt-4o</span><span className="text-gray-300">$24</span></div>
                    </div>
                  </div>
                  <div className="bg-gray-800/40 rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase mb-2">Daily Trend (last 7d)</div>
                    <div className="flex items-end gap-1 h-10">
                      {[3, 5, 4, 7, 6, 8, 5].map((h, i) => (
                        <div key={i} className="flex-1 bg-indigo-500/40 rounded-t" style={{ height: `${h * 12}%` }} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <H2>Configuration</H2>
            <P>
              Navigate to <strong className="text-gray-200">Settings &rarr; Budget</strong> to configure:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Monthly Limit</strong> &mdash; Maximum USD spend per calendar month (0 = unlimited)</Li>
              <Li><strong className="text-gray-200">Block on Exceed</strong> &mdash; When enabled, new sessions are blocked once the limit is reached. Returns HTTP 429 to the CLI.</Li>
              <Li><strong className="text-gray-200">Alert Thresholds</strong> &mdash; Percentage thresholds (default: 50%, 80%, 90%, 100%) that trigger admin notifications</Li>
            </ul>

            <H2>Spend Dashboard</H2>
            <P>The budget tab shows:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Progress bar</strong> &mdash; Visual indicator of current spend vs limit</Li>
              <Li><strong className="text-gray-200">Spend by model</strong> &mdash; Cost breakdown by AI model</Li>
              <Li><strong className="text-gray-200">Spend by user</strong> &mdash; Cost breakdown by team member</Li>
              <Li><strong className="text-gray-200">Daily trend</strong> &mdash; Mini chart showing daily spend over the last 30 days</Li>
            </ul>

            <H2>How Blocking Works</H2>
            <P>
              When &ldquo;Block on Exceed&rdquo; is enabled and the monthly limit is reached,
              the <code className="text-indigo-400">POST /api/mcp/session/start</code> endpoint
              returns a 429 status code with a message explaining the budget has been exceeded.
              The CLI will display this message to the developer.
            </P>

            <H2>Alert Notifications</H2>
            <P>
              When spend crosses a threshold (e.g. 80% of limit), all org admins receive a
              notification. Each threshold only fires once per month &mdash; alerts reset
              when the budget configuration is updated.
            </P>

            <Callout type="warning">
              Budget limits apply per organization per calendar month. Costs are tracked in
              real-time as sessions end. Setting a limit to 0 disables budget enforcement.
            </Callout>
          </div>
    </>
  );
}
