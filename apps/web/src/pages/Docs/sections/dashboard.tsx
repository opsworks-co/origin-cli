import { H3, P, Li } from '../shared/Markdown';

export default function DashboardSection() {
  return (
    <>
          <div>
            <h1 id="dashboard" className="text-2xl font-bold mb-2">Dashboard</h1>
            <P>The dashboard provides a high-level governance overview of your organization&apos;s AI coding activity.</P>

            {/* Dashboard Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Origin Dashboard</span>
              </div>
              <div className="p-6">
                {/* Active Session Banner */}
                <div className="bg-purple-900/30 border border-purple-700/50 rounded-lg p-3 mb-4 flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                  <span className="text-xs text-purple-300 font-medium">1 Active Session</span>
                  <div className="ml-auto flex items-center gap-4 text-xs text-gray-400">
                    <span className="text-purple-300">claude-sonnet-4</span>
                    <span>acme/backend</span>
                    <span className="text-gray-500">3m 22s</span>
                  </div>
                </div>

                {/* KPI Cards */}
                <div className="grid grid-cols-5 gap-3 mb-4">
                  <div className="bg-purple-900/20 border border-purple-700/40 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-purple-400">1</div>
                    <div className="text-[10px] text-gray-500 uppercase">Active Now</div>
                  </div>
                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-gray-200">47</div>
                    <div className="text-[10px] text-gray-500 uppercase">This Week</div>
                  </div>
                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-gray-200">$284</div>
                    <div className="text-[10px] text-gray-500 uppercase">Est. Cost</div>
                  </div>
                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-amber-400">12</div>
                    <div className="text-[10px] text-gray-500 uppercase">Unreviewed</div>
                  </div>
                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 text-center">
                    <div className="text-lg font-bold text-green-400">94</div>
                    <div className="text-[10px] text-gray-500 uppercase">Compliance</div>
                  </div>
                </div>

                {/* Recent Sessions Table */}
                <div className="bg-gray-800/30 rounded-lg border border-gray-700/50">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50">
                    <span className="text-xs font-medium text-gray-300">Recent Sessions</span>
                    <span className="text-[10px] text-indigo-400 cursor-pointer">View all &rarr;</span>
                  </div>
                  <div className="divide-y divide-gray-700/30 text-xs">
                    {[
                      { model: 'sonnet-4', repo: 'acme/backend', msg: 'Add user auth middleware', status: 'approved', age: '2h' },
                      { model: 'opus-4', repo: 'acme/frontend', msg: 'Refactor dashboard layout', status: 'unreviewed', age: '5h' },
                      { model: 'sonnet-4', repo: 'acme/api', msg: 'Fix rate limiter bug', status: 'flagged', age: '1d' },
                    ].map((s, i) => (
                      <div key={i} className="flex items-center gap-3 px-3 py-2">
                        <span className="text-gray-500 font-mono w-20 truncate">{s.model}</span>
                        <span className="text-gray-400 w-28 truncate">{s.repo}</span>
                        <span className="text-gray-300 flex-1 truncate">{s.msg}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                          s.status === 'approved' ? 'bg-green-900/40 text-green-400' :
                          s.status === 'flagged' ? 'bg-amber-900/40 text-amber-400' :
                          'bg-gray-700/40 text-gray-400'
                        }`}>{s.status}</span>
                        <span className="text-gray-600 w-8 text-right">{s.age}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <H3>Active Sessions</H3>
            <P>
              When AI coding sessions are currently running, a purple card appears at the top of the
              dashboard with a pulsing indicator. Each active session shows the model, prompt, repo,
              agent name, and elapsed time. Click any session to view its detail page. The active
              sessions section polls every 10 seconds to stay up-to-date.
            </P>

            <H3>KPI Cards</H3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-purple-400">Active Now</strong> &mdash; Number of sessions currently running (purple when &gt; 0)</Li>
              <Li><strong className="text-gray-200">Sessions This Week</strong> &mdash; AI coding sessions in the past 7 days</Li>
              <Li><strong className="text-gray-200">Est. Cost This Month</strong> &mdash; Total API cost from all sessions this month</Li>
              <Li><strong className="text-gray-200">Unreviewed</strong> &mdash; Sessions awaiting human review</Li>
              <Li><strong className="text-gray-200">Compliance Score</strong> &mdash; Policy adherence rating (0-100)</Li>
            </ul>

            <H3>Recent Sessions</H3>
            <P>
              The last 10 sessions across all repos with model, repo, commit message, status, and age.
              Click &ldquo;View all&rdquo; to go to the full Sessions page.
            </P>

            <H3>Registered Machines</H3>
            <P>
              Machines connected via the CLI (<code className="text-indigo-400">origin enable</code>).
              Shows hostname, detected tools, last seen time, and machine ID.
            </P>
          </div>
    </>
  );
}
