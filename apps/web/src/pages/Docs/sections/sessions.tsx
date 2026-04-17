import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function SessionsSection() {
  return (
    <>
          <div>
            <h1 id="sessions" className="text-2xl font-bold mb-2">Sessions & Reviews</h1>
            <P>
              Sessions represent individual AI coding interactions. Every time an agent
              writes code, Origin captures it as a session.
            </P>

            {/* Session List Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Sessions</span>
              </div>
              <div className="p-4">
                {/* Filter bar */}
                <div className="flex gap-2 mb-3">
                  {['All Models', 'All Status', 'All Agents', 'All Repos'].map((f) => (
                    <div key={f} className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-[10px] text-gray-400">{f} ▾</div>
                  ))}
                  <div className="ml-auto flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-[10px] text-gray-500">Live</span>
                  </div>
                </div>

                {/* Session table */}
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase border-b border-gray-700/50">
                      <th className="text-left py-1.5 font-medium">Status</th>
                      <th className="text-left py-1.5 font-medium">Model</th>
                      <th className="text-left py-1.5 font-medium">Agent</th>
                      <th className="text-left py-1.5 font-medium">Repo</th>
                      <th className="text-right py-1.5 font-medium">Duration</th>
                      <th className="text-right py-1.5 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {[
                      { status: 'running', model: 'sonnet-4', agent: 'claude-code', repo: 'acme/backend', dur: '3m 22s', cost: '$0.14' },
                      { status: 'approved', model: 'opus-4', agent: 'claude-code', repo: 'acme/frontend', dur: '12m 05s', cost: '$1.87' },
                      { status: 'unreviewed', model: 'sonnet-4', agent: 'cursor', repo: 'acme/api', dur: '5m 41s', cost: '$0.32' },
                      { status: 'flagged', model: 'sonnet-4', agent: 'claude-code', repo: 'acme/backend', dur: '8m 19s', cost: '$0.68' },
                    ].map((s, i) => (
                      <tr key={i} className="hover:bg-gray-800/30 cursor-pointer">
                        <td className="py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            s.status === 'running' ? 'bg-purple-900/40 text-purple-400' :
                            s.status === 'approved' ? 'bg-green-900/40 text-green-400' :
                            s.status === 'flagged' ? 'bg-amber-900/40 text-amber-400' :
                            'bg-gray-700/40 text-gray-400'
                          }`}>{s.status}</span>
                        </td>
                        <td className="py-2 text-gray-400 font-mono">{s.model}</td>
                        <td className="py-2 text-gray-400">{s.agent}</td>
                        <td className="py-2 text-gray-300">{s.repo}</td>
                        <td className="py-2 text-gray-500 text-right">{s.dur}</td>
                        <td className="py-2 text-gray-300 text-right">{s.cost}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Session Detail Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Session Detail &mdash; acme/backend</span>
              </div>
              <div className="p-4">
                <div className="flex gap-4">
                  {/* Left sidebar */}
                  <div className="w-44 flex-shrink-0 space-y-3">
                    <div className="text-xs text-gray-500 uppercase font-medium">Info</div>
                    <div className="space-y-2 text-xs">
                      <div><span className="text-gray-500">Model</span><br /><span className="text-gray-300 font-mono">sonnet-4</span></div>
                      <div><span className="text-gray-500">Agent</span><br /><span className="text-gray-300">claude-code</span></div>
                      <div><span className="text-gray-500">Commit</span><br /><span className="text-indigo-400 font-mono">a3f8c21</span></div>
                      <div><span className="text-gray-500">Cost</span><br /><span className="text-gray-300">$1.87</span></div>
                      <div><span className="text-gray-500">Tokens</span><br /><span className="text-gray-300">48,210</span></div>
                    </div>
                  </div>
                  {/* Right content */}
                  <div className="flex-1 min-w-0">
                    {/* Tabs */}
                    <div className="flex gap-4 border-b border-gray-700/50 mb-3">
                      <span className="text-xs text-indigo-400 border-b-2 border-indigo-400 pb-1.5 font-medium">Session</span>
                      <span className="text-xs text-gray-500 pb-1.5">AI Blame</span>
                      <span className="text-xs text-gray-500 pb-1.5">Security</span>
                      <div className="ml-auto"><span className="text-xs bg-purple-600/30 text-purple-300 px-2 py-0.5 rounded">Ask</span></div>
                    </div>
                    {/* Prompt timeline */}
                    <div className="space-y-2 mb-3">
                      <div className="bg-gray-800/50 rounded-lg p-2">
                        <div className="text-[10px] text-indigo-400 mb-1">Prompt 1</div>
                        <div className="text-xs text-gray-300">Add user authentication middleware with JWT validation</div>
                        <div className="mt-1 flex gap-2 text-[10px] text-gray-500">
                          <span>3 files changed</span>
                          <span className="text-green-500">+142</span>
                          <span className="text-red-500">-8</span>
                        </div>
                      </div>
                    </div>
                    {/* Diff preview */}
                    <div className="bg-gray-950 rounded border border-gray-700/50 font-mono text-[11px] overflow-hidden">
                      <div className="px-3 py-1.5 bg-gray-800/50 text-gray-500 border-b border-gray-700/50">src/middleware/auth.ts</div>
                      <div className="px-3 py-1">
                        <div className="text-green-400/80">+ import {'{'} verify {'}'} from &apos;jsonwebtoken&apos;;</div>
                        <div className="text-green-400/80">+ export function authMiddleware(req, res, next) {'{'}</div>
                        <div className="text-green-400/80">+   const token = req.headers.authorization;</div>
                        <div className="text-gray-600">  ...</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <H2 id="session-data">Session Data</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Model</strong> &mdash; Which AI model was used (e.g. claude-sonnet-4-20250514)</Li>
              <Li><strong className="text-gray-200">Prompt</strong> &mdash; What the developer asked the agent to do</Li>
              <Li><strong className="text-gray-200">Transcript</strong> &mdash; Full conversation between human and AI</Li>
              <Li><strong className="text-gray-200">Files Changed</strong> &mdash; List of files the agent modified</Li>
              <Li><strong className="text-gray-200">Git Diff</strong> &mdash; Full unified diff of all code changes (committed and uncommitted)</Li>
              <Li><strong className="text-gray-200">Commit SHAs</strong> &mdash; Real git commit hashes created during the session</Li>
              <Li><strong className="text-gray-200">Prompt &rarr; Changes</strong> &mdash; Maps each prompt to the files modified as a result</Li>
              <Li><strong className="text-gray-200">Tokens Used</strong> &mdash; Total input + output tokens</Li>
              <Li><strong className="text-gray-200">Cost</strong> &mdash; Estimated API cost in USD</Li>
              <Li><strong className="text-gray-200">Tool Calls</strong> &mdash; Number of tool invocations during the session</Li>
              <Li><strong className="text-gray-200">Duration</strong> &mdash; How long the session took</Li>
              <Li><strong className="text-gray-200">Lines Added/Removed</strong> &mdash; Net code changes from actual git diff</Li>
              <Li><strong className="text-gray-200">Pull Requests</strong> &mdash; Linked PRs (if GitHub integration is active)</Li>
            </ul>

            <H2>Session Status</H2>
            <P>
              Sessions have a status field that tracks their lifecycle:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-purple-400">RUNNING</strong> &mdash; Session is currently active (an AI agent is working). Shown with a purple pulsing badge.</Li>
              <Li><strong className="text-gray-200">COMPLETED</strong> &mdash; Session has ended. All data (transcript, diffs, costs) is finalized.</Li>
            </ul>
            <P>
              Running sessions appear in the Dashboard&apos;s active sessions section and in the Sessions
              list with a purple &ldquo;running&rdquo; badge. They transition to COMPLETED when
              the agent sends the session-end hook.
            </P>

            <H2>Session Detail View</H2>
            <P>
              Click any session to open the detail page. The right panel has four tabs:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Session</strong> &mdash; Full replay of the AI conversation with user prompts, agent responses, prompt-to-change timeline, and full diff view</Li>
              <Li><strong className="text-gray-200">AI Blame</strong> &mdash; Line-level attribution showing which prompt wrote each line of code (see <strong className="text-indigo-400">AI Blame</strong> docs)</Li>
              <Li><strong className="text-gray-200">Security</strong> &mdash; Secret and PII scan results for the session&apos;s code changes</Li>
            </ul>
            <P>
              The header also includes a purple <strong className="text-purple-400">Ask</strong> button
              that opens the Ask the Author panel for contextual Q&amp;A about the session
              (see <strong className="text-indigo-400">Ask the Author</strong> docs).
            </P>
            <P>
              The left panel shows commit info (real SHA hashes, HEAD range), linked PRs,
              agent/model info, session stats, and any existing review.
            </P>

            <H2>Filtering Sessions</H2>
            <P>
              Use the filter bar at the top of the Sessions page to filter by model, status
              (reviewed/unreviewed/flagged), agent, and repository.
            </P>

            <H2 id="reviewing-sessions">Reviewing Sessions</H2>
            <P>
              Open a session and scroll to the review bar at the bottom. You can:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-green-400">Approve</strong> &mdash; Code looks good, passes review</Li>
              <Li><strong className="text-red-400">Reject</strong> &mdash; Code has issues and needs changes</Li>
              <Li><strong className="text-amber-400">Flag</strong> &mdash; Mark for further investigation</Li>
            </ul>
            <P>
              Each review can include an optional note explaining the decision. Reviews are logged
              in the audit trail and, if GitHub integration is active, update PR status checks in real-time.
            </P>

            <Callout type="tip">
              Set up a REQUIRE_REVIEW policy to automatically flag sessions that meet certain criteria
              (e.g. large changes, high cost, sensitive files) for mandatory human review.
            </Callout>

            <H2>Session Analytics</H2>
            <P>
              The sessions list includes an inline analytics summary bar showing key metrics
              for the current page of sessions: total cost, average cost, total tokens,
              average duration, tool call count, review rate, and approval rate.
            </P>

            <H2>PR-Grouped View</H2>
            <P>
              Toggle the &ldquo;By PR&rdquo; view to see sessions grouped by pull request.
              Each PR card shows:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">PR metadata</strong> &mdash; Number, title, state (open/merged/closed), branch info, author</Li>
              <Li><strong className="text-gray-200">Check status</strong> &mdash; CI/CD check results (success/failure/pending)</Li>
              <Li><strong className="text-gray-200">Aggregated stats</strong> &mdash; Total sessions, cost, tokens, and lines changed across all sessions in that PR</Li>
              <Li><strong className="text-gray-200">Review status</strong> &mdash; Overall review state (all approved, has rejections, has flags, pending)</Li>
            </ul>
            <P>
              Click any session within a PR group to view its full detail page.
            </P>

            <H2>Real-Time Updates</H2>
            <P>
              The sessions list has a live indicator in the top-right corner. When connected
              (green pulsing dot), new sessions and session updates are automatically
              reflected in the list without requiring a page refresh.
            </P>

            <H2>Bulk Review</H2>
            <P>
              Select multiple unreviewed sessions using checkboxes, then use the bulk action bar
              to approve, reject, or flag all selected sessions at once. The select-all checkbox
              applies only to sessions that haven&apos;t been reviewed yet.
            </P>

            <H2>Archiving Sessions</H2>
            <P>
              Sessions can be archived to declutter your active session list without permanently
              deleting data. Archived sessions are hidden from the default view but remain fully
              accessible.
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Archive</strong> &mdash; Click the archive icon on any session row, or select multiple sessions and use the bulk archive button. Admin role required.</Li>
              <Li><strong className="text-gray-200">View Archived</strong> &mdash; Toggle the &ldquo;Show Archived&rdquo; button in the session list header to switch between active and archived sessions.</Li>
              <Li><strong className="text-gray-200">Restore</strong> &mdash; From the archived view, select sessions and use the bulk restore button to move them back to the active list.</Li>
            </ul>
            <CodeBlock title="API">{`# Archive a session
PATCH /api/sessions/:id/archive  { "archived": true }

# Restore a session
PATCH /api/sessions/:id/archive  { "archived": false }

# Bulk archive/restore
PATCH /api/sessions/bulk/archive  { "sessionIds": [...], "archived": true }`}</CodeBlock>

            <H2 id="sharing-sessions">Sharing Sessions</H2>
            <P>
              Generate public share links for any session. Shared sessions are accessible without
              authentication &mdash; anyone with the link can view the full session replay, review status,
              diffs, and prompt timeline. Like CodePen, but for agent sessions.
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Create Share Link</strong> &mdash; Click the share icon on a session detail page. Origin generates a unique short URL.</Li>
              <Li><strong className="text-gray-200">Expiry</strong> &mdash; Share links can optionally expire. By default, links have no expiry.</Li>
              <Li><strong className="text-gray-200">Public Page</strong> &mdash; Shared sessions live at <code className="text-indigo-400">/s/:slug</code> and show the full session including metadata, transcript, diffs, prompt timeline, and review status.</Li>
            </ul>
            <CodeBlock title="API">{`# Create a share link
POST /api/sessions/:id/share
# Returns: { slug, url, expiresAt }

# View shared session (public, no auth)
GET /api/share/:slug`}</CodeBlock>
            <Callout type="tip">
              Use <code className="text-indigo-400">origin share &lt;sessionId&gt; --public</code> from the CLI
              to generate a public share link directly from the terminal.
            </Callout>
          </div>
    </>
  );
}
