import { CodeBlock, H2, H3, P, Li, Callout } from '../shared/Markdown';

export default function DeveloperDashboardSection() {
  return (
    <>
          <div>
            <h1 id="developer-dashboard" className="text-2xl font-bold mb-2">Solo Dashboard</h1>
            <P>
              The Solo Dashboard (<a href="https://getorigin.io/me" className="text-emerald-400 hover:text-emerald-300 underline">/me</a>) is a personal workspace for individual developers.
              It provides a comprehensive view of your AI coding sessions, patterns, efficiency metrics, and prompt history.
              Available to both Solo accounts and org members.
            </P>

            <H2>Account Types</H2>
            <P>Origin supports two account types with different experiences:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Organization Account</strong> &mdash; Full admin dashboard with team management, policies, IAM, budget controls, compliance, and infrastructure</Li>
              <Li><strong className="text-gray-200">Solo Account</strong> &mdash; Lightweight personal dashboard focused on your sessions, stats, and efficiency</Li>
            </ul>
            <P>
              Both account types are available from a single <a href="https://getorigin.io/register" className="text-indigo-400 hover:text-indigo-300 underline">registration page</a> &mdash;
              choose <strong className="text-gray-200">Team</strong> or <strong className="text-emerald-400">Solo</strong> using the toggle at the top.
            </P>
            <Callout type="info">
              Solo accounts use an emerald-themed interface with a simplified sidebar.
              Org members can also access the Solo dashboard at <a href="https://getorigin.io/me" className="text-emerald-400 hover:text-emerald-300 underline">/me</a> alongside the org dashboard.
            </Callout>

            <H2>Overview Cards</H2>
            <P>
              At the top of the dashboard, four stat cards give you a real-time summary:
            </P>

            {/* Overview mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">/me &mdash; Overview Cards</span>
              </div>
              <div className="p-4 grid grid-cols-4 gap-3">
                {[
                  { label: 'Sessions', value: '142', trend: '+12%', color: 'text-indigo-400' },
                  { label: 'Tokens', value: '3.2M', trend: '+8%', color: 'text-yellow-400' },
                  { label: 'Cost', value: '$47.20', trend: '-3%', color: 'text-green-400' },
                  { label: 'Lines Written', value: '18.4k', trend: '+15%', color: 'text-emerald-400' },
                ].map((c) => (
                  <div key={c.label} className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
                    <div className="text-[10px] text-gray-500 mb-1">{c.label}</div>
                    <div className={`text-lg font-bold ${c.color}`}>{c.value}</div>
                    <div className="text-[10px] text-gray-600">{c.trend} vs last week</div>
                  </div>
                ))}
              </div>
            </div>

            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Sessions</strong> &mdash; Total number of AI coding sessions. Week-over-week trend shown below.</Li>
              <Li><strong className="text-gray-200">Tokens</strong> &mdash; Total tokens consumed across all sessions (input + output).</Li>
              <Li><strong className="text-gray-200">Cost</strong> &mdash; Cumulative API cost. Compared against last week.</Li>
              <Li><strong className="text-gray-200">Lines Written</strong> &mdash; Total lines added/removed. Breakdown shown as <span className="text-green-400">+added</span> / <span className="text-red-400">-removed</span>.</Li>
            </ul>
            <P>
              A streak counter appears when you have consecutive days of AI coding activity.
            </P>

            <H2>Sessions Tab</H2>
            <P>
              The Sessions tab is a searchable, filterable table of all your AI coding sessions.
              Each row shows the agent, repository, branch, duration, cost, tokens, status, tags, and when the session happened.
            </P>

            {/* Sessions mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Sessions</span>
              </div>
              <div className="p-4">
                <div className="flex gap-2 mb-3">
                  <div className="flex-1 bg-gray-800/50 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-500">Search sessions...</div>
                  <div className="bg-gray-800/50 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-400">All agents</div>
                  <div className="bg-gray-800/50 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-400">All repos</div>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase border-b border-gray-700/50">
                      <th className="text-left py-1.5 font-medium w-6"></th>
                      <th className="text-left py-1.5 font-medium">Agent</th>
                      <th className="text-left py-1.5 font-medium">Repo</th>
                      <th className="text-right py-1.5 font-medium">Duration</th>
                      <th className="text-right py-1.5 font-medium">Cost</th>
                      <th className="text-right py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {[
                      { agent: 'claude-code', repo: 'org/api', dur: '12m', cost: '$0.84', status: 'ENDED' },
                      { agent: 'cursor', repo: 'org/web', dur: '8m', cost: '$0.32', status: 'ENDED' },
                      { agent: 'claude-code', repo: 'org/api', dur: '45m', cost: '$3.10', status: 'ENDED' },
                    ].map((s, i) => (
                      <tr key={i} className="hover:bg-gray-800/30">
                        <td className="py-2 text-yellow-500/40">&#9733;</td>
                        <td className="py-2 text-indigo-400">{s.agent}</td>
                        <td className="py-2 text-gray-300">{s.repo}</td>
                        <td className="py-2 text-gray-400 text-right">{s.dur}</td>
                        <td className="py-2 text-gray-300 text-right">{s.cost}</td>
                        <td className="py-2 text-right"><span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{s.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <H3>Features</H3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Search</strong> &mdash; Full-text search across session metadata, commit messages, and agent names</Li>
              <Li><strong className="text-gray-200">Filter by Agent</strong> &mdash; Dropdown to isolate sessions by a specific AI agent (Claude Code, Cursor, etc.)</Li>
              <Li><strong className="text-gray-200">Filter by Repo</strong> &mdash; Scope to a single repository</Li>
              <Li><strong className="text-gray-200">Filter by Status</strong> &mdash; Show only RUNNING, ENDED, or specific review statuses</Li>
              <Li><strong className="text-gray-200">Star / Bookmark</strong> &mdash; Click the star icon to bookmark important sessions. Bookmarked sessions appear in the &ldquo;Saved&rdquo; filter</Li>
              <Li><strong className="text-gray-200">Inline Tags</strong> &mdash; Add custom tags (e.g. &ldquo;bugfix&rdquo;, &ldquo;refactor&rdquo;, &ldquo;feature&rdquo;) to bookmarked sessions for categorization</Li>
              <Li><strong className="text-gray-200">Pagination</strong> &mdash; Navigate through history with page controls. Default 20 sessions per page</Li>
              <Li><strong className="text-gray-200">Click to Detail</strong> &mdash; Click any session row to navigate to the full session detail view</Li>
            </ul>

            <H2>Timeline Tab</H2>
            <P>
              The Timeline provides a vertical chronological view of your last 100 sessions, grouped by day.
              Each session shows as a card with the agent name, model, duration, cost, and lines changed.
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Day Groups</strong> &mdash; Sessions are grouped under date headers (e.g. &ldquo;Today&rdquo;, &ldquo;Yesterday&rdquo;, &ldquo;March 28&rdquo;)</Li>
              <Li><strong className="text-gray-200">Agent Markers</strong> &mdash; Color-coded indicators show which agent was used. When you switch agents mid-day, a visual marker highlights the transition</Li>
              <Li><strong className="text-gray-200">Session Cards</strong> &mdash; Each card shows repo, branch, model, duration, cost, tokens, and lines changed at a glance</Li>
              <Li><strong className="text-gray-200">Quick Navigation</strong> &mdash; Click any session card to jump to the full session detail</Li>
            </ul>
            <P>
              The Timeline helps you review &ldquo;what did I do today/this week?&rdquo; without digging through individual sessions.
            </P>

            <H2>Agents Tab</H2>
            <P>
              The Agents tab shows a grid of cards &mdash; one per AI agent you&apos;ve used. Each card provides:
            </P>

            {/* Agents mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Agents</span>
              </div>
              <div className="p-4 grid grid-cols-3 gap-3">
                {[
                  { name: 'claude-code', model: 'claude-4-opus', sessions: 89, cost: '$32.10', status: 'active', color: '#818cf8' },
                  { name: 'cursor', model: 'gpt-4o', sessions: 41, cost: '$12.40', status: 'active', color: '#34d399' },
                  { name: 'copilot', model: 'gpt-4o-mini', sessions: 12, cost: '$2.80', status: 'inactive', color: '#f59e0b' },
                ].map((a) => (
                  <div key={a.name} className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold" style={{ backgroundColor: `${a.color}20`, color: a.color }}>AI</div>
                        <div>
                          <div className="text-xs font-semibold text-gray-200">{a.name}</div>
                          <div className="text-[9px] text-gray-600 font-mono">{a.model}</div>
                        </div>
                      </div>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${a.status === 'active' ? 'bg-green-900/30 text-green-400' : 'bg-gray-800 text-gray-500'}`}>{a.status}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                      <div><span className="text-gray-500">Sessions:</span> <span className="text-gray-300">{a.sessions}</span></div>
                      <div><span className="text-gray-500">Cost:</span> <span className="text-gray-300">{a.cost}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Agent Name &amp; Model</strong> &mdash; The agent slug and its most frequently used model</Li>
              <Li><strong className="text-gray-200">Total Sessions</strong> &mdash; Lifetime session count with this agent</Li>
              <Li><strong className="text-gray-200">Total Cost &amp; Monthly Cost</strong> &mdash; Lifetime and current month spend</Li>
              <Li><strong className="text-gray-200">Total Tokens</strong> &mdash; Lifetime token consumption</Li>
              <Li><strong className="text-gray-200">Avg Session Duration</strong> &mdash; Average length of sessions with this agent</Li>
              <Li><strong className="text-gray-200">Lines Added / Removed</strong> &mdash; Total code impact from this agent</Li>
              <Li><strong className="text-gray-200">Status</strong> &mdash; <span className="text-green-400">Active</span> if used in the last 7 days, otherwise <span className="text-gray-500">inactive</span></Li>
              <Li><strong className="text-gray-200">Last Active</strong> &mdash; Timestamp of the most recent session</Li>
            </ul>

            <H2>Stats Tab</H2>
            <P>
              The Stats tab provides visual analytics of your AI coding activity:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Contribution Heatmap</strong> &mdash; A 365-day calendar heatmap (similar to GitHub) showing your daily AI session activity. Darker cells = more sessions that day</Li>
              <Li><strong className="text-gray-200">Cost Breakdown</strong> &mdash; Pie chart showing cost distribution across agents</Li>
              <Li><strong className="text-gray-200">Model Distribution</strong> &mdash; Breakdown of which AI models you use (Claude Opus, Sonnet, GPT-4o, etc.) with session counts and costs</Li>
              <Li><strong className="text-gray-200">Top Files</strong> &mdash; The 10 most frequently modified files across all AI sessions</Li>
              <Li><strong className="text-gray-200">Repos</strong> &mdash; Session count per repository</Li>
              <Li><strong className="text-gray-200">Code Impact</strong> &mdash; Summary card showing total lines added (green) and removed (red) across all sessions</Li>
            </ul>
            <P>
              Data is fetched from <code className="text-indigo-400">GET /api/stats/me</code> which aggregates all sessions for the authenticated user.
            </P>

            <H2>Patterns Tab</H2>
            <P>
              The Patterns tab analyzes <em>when</em> you code with AI:
            </P>

            {/* Patterns mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Patterns &mdash; Hour of Day</span>
              </div>
              <div className="p-4">
                <div className="flex items-end gap-1 h-20">
                  {[1,2,3,5,8,12,18,22,28,35,30,25,20,22,28,32,25,18,12,8,5,3,2,1].map((v, i) => (
                    <div key={i} className="flex-1 rounded-t" style={{ height: `${(v/35)*100}%`, backgroundColor: v > 25 ? '#818cf8' : v > 15 ? '#818cf860' : '#818cf830' }} />
                  ))}
                </div>
                <div className="flex justify-between text-[9px] text-gray-600 mt-1">
                  <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
                </div>
              </div>
            </div>

            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Hour-of-Day Chart</strong> &mdash; Bar chart with 24 buckets (0&ndash;23) showing session distribution across hours. Identifies your peak coding hours</Li>
              <Li><strong className="text-gray-200">Day-of-Week Chart</strong> &mdash; Bar chart showing session distribution across weekdays (Mon&ndash;Sun). See which days you&apos;re most active</Li>
              <Li><strong className="text-gray-200">Peak Hour</strong> &mdash; The single hour with the most sessions (e.g. &ldquo;2pm&rdquo;)</Li>
              <Li><strong className="text-gray-200">Peak Day</strong> &mdash; The weekday with the most sessions (e.g. &ldquo;Wednesday&rdquo;)</Li>
              <Li><strong className="text-gray-200">Monthly Summary</strong> &mdash; Sessions and cost for the current month</Li>
              <Li><strong className="text-gray-200">Averages</strong> &mdash; Average session duration, tokens per session, and cost per session</Li>
            </ul>

            <H2>Efficiency Tab</H2>
            <P>
              The Efficiency tab measures how productively you use AI coding tools:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Tokens per Line</strong> &mdash; How many tokens are consumed to produce one line of code. Lower is more efficient. Calculated as <code className="text-gray-400">totalTokens / totalLinesAdded</code></Li>
              <Li><strong className="text-gray-200">Cost per Commit</strong> &mdash; Average API cost for each git commit made during AI sessions. Calculated as <code className="text-gray-400">totalCost / totalCommits</code></Li>
              <Li><strong className="text-gray-200">Cost per Session</strong> &mdash; Average cost per session. Track whether this trends up or down over time</Li>
              <Li><strong className="text-gray-200">Avg Lines per Session</strong> &mdash; Average lines of code produced per session</Li>
              <Li><strong className="text-gray-200">Commit Stats</strong> &mdash; Total commits, commits per session ratio, and average files changed per commit</Li>
            </ul>
            <P>
              Use these metrics to optimize your AI workflow &mdash; fewer tokens per line means you&apos;re writing better prompts, lower cost per commit means more efficient iteration.
            </P>

            <H2>Prompts Tab</H2>
            <P>
              The Prompts tab shows a paginated list of every prompt you sent to AI agents, paired with the code changes that resulted:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Prompt Text</strong> &mdash; The message you sent to the AI agent</Li>
              <Li><strong className="text-gray-200">Agent &amp; Session</strong> &mdash; Which agent received the prompt and which session it belongs to</Li>
              <Li><strong className="text-gray-200">Files Changed</strong> &mdash; List of files modified as a result of this prompt</Li>
              <Li><strong className="text-gray-200">Inline Diff</strong> &mdash; Click to expand and see the exact code changes (unified diff) produced by the prompt</Li>
              <Li><strong className="text-gray-200">Timestamp</strong> &mdash; When the prompt was sent</Li>
              <Li><strong className="text-gray-200">Pagination</strong> &mdash; Navigate through prompt history, 30 per page</Li>
            </ul>
            <P>
              This is useful for understanding which prompts led to the best outcomes, and for auditing what instructions
              were given to AI tools in your codebase.
            </P>

            <H2>Quick Start</H2>
            <P>
              When your dashboard has no sessions yet, a built-in quick start guide appears with 3 steps:
            </P>
            <ol className="space-y-2 mb-4 list-decimal list-inside text-sm text-gray-400">
              <li><strong className="text-gray-200">Install the CLI</strong> &mdash; <code className="text-emerald-400">npm i -g https://getorigin.io/cli/origin-cli-latest.tgz</code></li>
              <li><strong className="text-gray-200">Login &amp; Init</strong> &mdash; <code className="text-emerald-400">origin login</code> then <code className="text-emerald-400">origin init</code> to detect your AI tools and install hooks</li>
              <li><strong className="text-gray-200">Start Coding</strong> &mdash; Use any AI tool as normal. Sessions appear automatically</li>
            </ol>

            <H2>API Endpoints</H2>
            <CodeBlock title="Developer Dashboard API">{`# Personal stats overview (sessions, cost, tokens, lines, heatmap, streak)
GET /api/stats/me

# Your sessions (paginated, filterable)
GET /api/sessions?mine=true&limit=20&offset=0
GET /api/sessions?mine=true&model=claude-code&status=ENDED

# Bookmarked sessions
GET /api/sessions/bookmarked

# Agent breakdown cards
GET /api/stats/me/agents

# Coding patterns (hourly/daily distribution, peak times)
GET /api/stats/me/patterns

# Efficiency metrics (tokens/line, cost/commit, cost/session)
GET /api/stats/me/efficiency

# Prompt history with diffs (paginated)
GET /api/stats/me/prompts?limit=30&offset=0`}</CodeBlock>

            <H2>Developer Settings</H2>
            <P>
              Developer accounts have a streamlined Settings page with only relevant options:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">General</strong> &mdash; Profile info and API key management for CLI integration</Li>
              <Li><strong className="text-gray-200">Models</strong> &mdash; Compare and track AI model performance</Li>
            </ul>
            <P>
              Organization-level features like Integrations, Audit Log, Reports, Trails, and Compliance
              are only visible for org accounts.
            </P>
          </div>
    </>
  );
}
