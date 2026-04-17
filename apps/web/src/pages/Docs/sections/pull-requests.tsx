import { CodeBlock, H2, P, Li, Step, Callout } from '../shared/Markdown';

export default function PullRequestsSection() {
  return (
    <>
          <div>
            <h1 id="pull-requests" className="text-2xl font-bold mb-2">Pull Request Checks</h1>
            <P>
              Origin integrates with GitHub to post governance status checks on pull requests.
              When a PR contains AI-authored commits, Origin links the relevant coding sessions,
              evaluates policies, and posts a pass/fail check that controls whether the PR can be merged.
            </P>

            {/* PR Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">GitHub Pull Request #42</span>
              </div>
              <div className="p-4">
                {/* PR header */}
                <div className="mb-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="px-1.5 py-0.5 bg-green-900/40 text-green-400 rounded text-[10px]">Open</span>
                    <span className="text-sm text-gray-200 font-medium">Add JWT authentication middleware</span>
                  </div>
                  <div className="text-[10px] text-gray-500">acme/backend &mdash; feature/auth &rarr; main</div>
                </div>
                {/* Status check */}
                <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 mb-3">
                  <div className="text-[10px] text-gray-500 uppercase mb-2">Status Checks</div>
                  <div className="flex items-center gap-2">
                    <span className="text-green-400 text-sm">&#10003;</span>
                    <span className="text-xs text-gray-300 font-medium">origin/ai-governance</span>
                    <span className="text-[10px] text-gray-500">&mdash; All 2 sessions approved</span>
                  </div>
                </div>
                {/* Summary comment */}
                <div className="bg-gray-800/30 border border-gray-700/50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-5 h-5 rounded-full bg-indigo-600/40 flex items-center justify-center text-[9px] text-indigo-300 font-bold">O</div>
                    <span className="text-xs text-gray-300 font-medium">Origin Bot</span>
                    <span className="text-[10px] text-gray-500">commented 2m ago</span>
                  </div>
                  <div className="text-[10px] text-gray-400 mb-2">2 sessions &middot; 5 agent turns &middot; 0 human corrections</div>
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-700/30">
                        <th className="text-left py-1 font-medium">Session</th>
                        <th className="text-left py-1 font-medium">Agent</th>
                        <th className="text-right py-1 font-medium">Cost</th>
                        <th className="text-right py-1 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-gray-700/20">
                        <td className="py-1 text-indigo-400">a3f8c21</td>
                        <td className="py-1 text-gray-400">claude-code</td>
                        <td className="py-1 text-gray-300 text-right">$1.87</td>
                        <td className="py-1 text-right"><span className="text-green-400">approved</span></td>
                      </tr>
                      <tr>
                        <td className="py-1 text-indigo-400">b7d2e10</td>
                        <td className="py-1 text-gray-400">claude-code</td>
                        <td className="py-1 text-gray-300 text-right">$0.42</td>
                        <td className="py-1 text-right"><span className="text-green-400">approved</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <H2>How It Works</H2>
            <div className="space-y-1 mb-4">
              <Step n={1} title="Developer pushes code">
                After coding with an AI agent, the developer pushes commits to a GitHub branch and opens a PR.
              </Step>
              <Step n={2} title="Origin receives the webhook">
                GitHub sends a <code className="text-indigo-400">push</code> and <code className="text-indigo-400">pull_request</code> event
                to Origin. Commits are matched to AI sessions by SHA.
              </Step>
              <Step n={3} title="Policy engine evaluates">
                Origin runs all active policies against the linked sessions: cost limits, file restrictions,
                model allowlists, and review requirements.
              </Step>
              <Step n={4} title="Status check posted">
                Origin posts an <code className="text-indigo-400">origin/ai-governance</code> commit status on the PR.
                A summary comment is also posted with a table of linked sessions, costs, and violations.
              </Step>
              <Step n={5} title="Merge gating">
                With GitHub branch protection enabled, the PR cannot be merged if the check fails.
                Admin reviews the flagged sessions in Origin, approves them, and the check updates to green.
              </Step>
            </div>

            <H2>Check Status Logic</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-green-400">Success</strong> &mdash; All linked sessions are approved (or no sessions linked)</Li>
              <Li><strong className="text-amber-400">Pending</strong> &mdash; Sessions exist but some are unreviewed</Li>
              <Li><strong className="text-red-400">Failure</strong> &mdash; Any session is rejected or flagged, or policy violations detected</Li>
            </ul>

            <H2>PR Summary Comment</H2>
            <P>
              Origin posts (or updates) a single comment on the PR with a session summary table:
            </P>
            <ul className="space-y-2 mb-4">
              <Li>Link to each session in Origin (View button)</Li>
              <Li>Agent name and model used</Li>
              <Li>Cost and token count per session</Li>
              <Li>Turn count &mdash; number of prompts/turns in each session</Li>
              <Li>Duration and files changed per session</Li>
              <Li>Review status (approved, flagged, pending)</Li>
              <Li>Total cost and lines added across all sessions</Li>
              <Li>Human corrections count &mdash; commits not linked to any AI session</Li>
              <Li>Policy violation details with fix hints</Li>
            </ul>
            <P>
              The comment header shows an aggregate summary:
              <code className="text-indigo-400 text-xs"> 3 sessions · 47 agent turns · 2 human corrections</code>.
              Below the table, a per-session breakdown shows prompt counts and line contributions.
            </P>

            <H2>Dashboard View</H2>
            <P>
              The Pull Requests page shows all PRs with filter tabs: All, Open, Passing, Failing, Pending.
              Each PR card shows the title, repo, author, branch, commit count, session count, and check status.
              Click &ldquo;Details&rdquo; to drill into linked sessions. Click &ldquo;Re-check&rdquo; to recompute the status.
            </P>

            <H2>API</H2>
            <CodeBlock title="Pull Requests API">{`# List all PRs with session analysis
GET /api/pull-requests

# Recheck a PR (recompute status after review changes)
POST /api/pull-requests/:id/recheck

# Analyze a PR by URL (used by origin review-pr CLI command)
GET /api/pull-requests/review?url=https://github.com/org/repo/pull/42`}</CodeBlock>

            <Callout type="warning">
              PR/MR checks require a GitHub or GitLab integration configured in Settings &rarr; Integrations
              with &ldquo;Post Checks&rdquo; and &ldquo;Post Comments&rdquo; enabled. Webhooks must be active on the repo.
            </Callout>
          </div>
    </>
  );
}
