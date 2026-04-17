import { H2, H3, P, Li, Step, Callout } from '../shared/Markdown';

export default function GithubChecksSection() {
  return (
    <>
          <div>
            <h1 id="github-checks" className="text-2xl font-bold mb-2">How GitHub PR Checks Work in Origin</h1>
            <P>
              Origin adds a governance status check to every pull request in your connected repositories.
              This check tells you whether AI-authored code in the PR meets your organization&rsquo;s policies
              before it can be merged.
            </P>

            {/* Visual: check states */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">GitHub PR &mdash; Status Checks</span>
              </div>
              <div className="p-4 space-y-3">
                <div className="bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3">
                  <div className="text-[10px] text-gray-500 uppercase mb-2">Scenario 1 &mdash; No policies configured</div>
                  <div className="flex items-center gap-2">
                    <span className="text-green-400 text-sm">&#10003;</span>
                    <span className="text-xs text-gray-300 font-medium">origin/ai-governance</span>
                    <span className="text-[10px] text-gray-500">&mdash; 1 session detected &middot; No policies &middot; Informational only</span>
                  </div>
                </div>
                <div className="bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3">
                  <div className="text-[10px] text-gray-500 uppercase mb-2">Scenario 2 &mdash; REQUIRE_REVIEW policy active</div>
                  <div className="flex items-center gap-2">
                    <span className="text-amber-400 text-sm">&#9679;</span>
                    <span className="text-xs text-gray-300 font-medium">origin/ai-governance</span>
                    <span className="text-[10px] text-gray-500">&mdash; 1 session pending review &middot; Waiting for approval</span>
                  </div>
                </div>
                <div className="bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3">
                  <div className="text-[10px] text-gray-500 uppercase mb-2">Scenario 3 &mdash; COST_LIMIT policy violated</div>
                  <div className="flex items-center gap-2">
                    <span className="text-red-400 text-sm">&#10007;</span>
                    <span className="text-xs text-gray-300 font-medium">origin/ai-governance</span>
                    <span className="text-[10px] text-gray-500">&mdash; Session cost $14.20 exceeds limit $10.00</span>
                  </div>
                </div>
                <div className="bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3">
                  <div className="text-[10px] text-gray-500 uppercase mb-2">Scenario 4 &mdash; No AI sessions detected</div>
                  <div className="flex items-center gap-2">
                    <span className="text-green-400 text-sm">&#10003;</span>
                    <span className="text-xs text-gray-300 font-medium">origin/ai-governance</span>
                    <span className="text-[10px] text-gray-500">&mdash; 0 sessions detected &middot; Assumed human-authored</span>
                  </div>
                </div>
              </div>
            </div>

            <H2>1. Every PR Gets a Check</H2>
            <P>
              When a developer pushes commits or opens a PR against a connected repository, Origin automatically
              posts an <code className="text-indigo-400">origin/ai-governance</code> commit status check. This happens
              for every PR &mdash; not just ones with AI code. Origin matches commit SHAs against tracked coding sessions
              to determine which commits were AI-authored.
            </P>

            <H2>2. No Policies? Check Passes Automatically</H2>
            <P>
              If your organization has no active policies, every PR check passes with a green checkmark.
              Origin still detects and reports AI sessions in the PR comment (number of sessions, agent name,
              cost, files changed), but nothing blocks the merge. This is <strong className="text-gray-200">informational mode</strong> &mdash;
              useful when you first set up Origin and want visibility before enforcing rules.
            </P>
            <Callout type="tip">
              Start without policies to see how Origin tracks your AI usage, then gradually add policies as you learn what matters for your team.
            </Callout>

            <H2>3. REQUIRE_REVIEW Policy &mdash; Block Until Approved</H2>
            <P>
              The <code className="text-indigo-400">REQUIRE_REVIEW</code> policy requires that a designated reviewer
              (typically a tech lead or CTO) approves each AI coding session before the PR can merge.
            </P>
            <ul className="space-y-2 mb-4">
              <Li>PR check status is set to <strong className="text-amber-400">pending</strong> until all linked sessions are reviewed</Li>
              <Li>Reviewer opens the session in Origin&rsquo;s dashboard, inspects the prompts and diffs, then clicks <strong className="text-gray-200">Approve</strong> or <strong className="text-gray-200">Reject</strong></Li>
              <Li>Once all sessions are approved, Origin automatically updates the GitHub check to <strong className="text-green-400">success</strong></Li>
              <Li>If any session is rejected, the check moves to <strong className="text-red-400">failure</strong> with a reason</Li>
            </ul>

            <H3>Agent-Scoped vs. Organization-Wide</H3>
            <P>
              Policies can be applied at two levels:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Agent-scoped policy:</strong> Applies only to sessions from a specific agent. For example, you might require review only for a junior developer&rsquo;s Cursor agent but not for a senior&rsquo;s Claude Code sessions. Create these from Policies &rarr; New Policy and select a specific agent.</Li>
              <Li><strong className="text-gray-200">Organization-wide policy:</strong> Applies to all sessions across all agents. Use this when every AI-authored PR must be reviewed regardless of who wrote it. Create these by leaving the agent field blank (applies to &ldquo;All agents&rdquo;).</Li>
            </ul>
            <P>
              When both exist, the stricter policy wins. If an org-wide policy says &ldquo;pass&rdquo; but an agent-scoped policy says &ldquo;block,&rdquo; the PR is blocked.
            </P>

            <H2>4. COST_LIMIT Policy &mdash; Block on Overspend</H2>
            <P>
              The <code className="text-indigo-400">COST_LIMIT</code> policy sets a maximum allowed cost per session.
              If any AI session linked to the PR exceeds the threshold, the check fails immediately.
            </P>
            <ul className="space-y-2 mb-4">
              <Li>Set a dollar limit per session (e.g., $10.00)</Li>
              <Li>Origin checks the total API cost (input + output tokens) of each session</Li>
              <Li>If cost exceeds the limit, the PR check fails with the exact amount shown</Li>
              <Li>The developer can split work into smaller sessions or request a policy exception</Li>
            </ul>

            <H3>Agent-Scoped vs. Organization-Wide</H3>
            <P>
              Cost limits can also be scoped to specific agents or applied organization-wide:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Agent-scoped:</strong> Set different cost limits per agent. For example, $5 for quick-fix agents but $25 for architecture agents that need longer sessions.</Li>
              <Li><strong className="text-gray-200">Organization-wide:</strong> A blanket cost limit applied to all agents. Any session exceeding this amount blocks the PR.</Li>
            </ul>

            <H2>5. &ldquo;0 Sessions Detected&rdquo; &mdash; Passes by Default</H2>
            <P>
              When Origin cannot match any commits in a PR to a tracked AI coding session, it assumes the code
              is human-authored. The check passes with a green checkmark and the message &ldquo;0 sessions detected.&rdquo;
            </P>
            <ul className="space-y-2 mb-4">
              <Li>This covers PRs written entirely by hand without AI assistance</Li>
              <Li>It also covers AI-authored code where the developer didn&rsquo;t have the Origin CLI running (sessions weren&rsquo;t tracked)</Li>
              <Li>If you want to enforce that all AI coding must be tracked, combine this with a team policy requiring Origin CLI usage</Li>
            </ul>
            <Callout type="info">
              Origin identifies AI sessions by matching commit SHAs. If a developer uses an AI tool without Origin&rsquo;s CLI tracking the session, those commits appear as human-authored.
            </Callout>

            <H2>6. How to Create Your First Policy</H2>
            <P>
              Setting up PR checks takes two steps: connect GitHub and create a policy.
            </P>
            <div className="space-y-1 mb-4">
              <Step n={1} title="Connect the GitHub App">
                Go to <strong className="text-gray-200">Settings &rarr; Integrations</strong> and install the Origin GitHub App.
                This gives Origin permission to post status checks and comments on your PRs. Make sure &ldquo;Post Checks&rdquo;
                and &ldquo;Post Comments&rdquo; are enabled.
              </Step>
              <Step n={2} title="Import repositories">
                Go to <strong className="text-gray-200">Repositories</strong> and import the repos you want to monitor.
                Origin will only post checks on PRs in imported repos.
              </Step>
              <Step n={3} title="Create a policy">
                Go to <strong className="text-gray-200">Policies &rarr; New Policy</strong>. Choose a policy type:
                <ul className="mt-2 space-y-1">
                  <li className="flex items-start gap-2"><span className="text-indigo-400">&bull;</span><span><strong className="text-gray-200">REQUIRE_REVIEW</strong> &mdash; Block PRs until sessions are approved in Origin</span></li>
                  <li className="flex items-start gap-2"><span className="text-indigo-400">&bull;</span><span><strong className="text-gray-200">COST_LIMIT</strong> &mdash; Block PRs if session cost exceeds a threshold</span></li>
                  <li className="flex items-start gap-2"><span className="text-indigo-400">&bull;</span><span><strong className="text-gray-200">FILE_RESTRICTION</strong> &mdash; Block PRs if AI modified protected files</span></li>
                  <li className="flex items-start gap-2"><span className="text-indigo-400">&bull;</span><span><strong className="text-gray-200">MODEL_ALLOWLIST</strong> &mdash; Block PRs if an unapproved model was used</span></li>
                </ul>
              </Step>
              <Step n={4} title="Choose the scope">
                Select whether the policy applies to a <strong className="text-gray-200">specific agent</strong> or <strong className="text-gray-200">all agents</strong> (organization-wide).
                Agent-scoped policies let you enforce stricter rules on certain agents while being lenient on others.
              </Step>
              <Step n={5} title="Enable branch protection (recommended)">
                In GitHub, go to your repo&rsquo;s Settings &rarr; Branches &rarr; Branch protection rules. Add a rule for
                your main branch and enable &ldquo;Require status checks to pass&rdquo; with <code className="text-indigo-400">origin/ai-governance</code> as
                a required check. Now PRs cannot be merged until Origin&rsquo;s check passes.
              </Step>
            </div>

            <H2>Summary: Check Status Decision Tree</H2>
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 my-4 font-mono text-xs text-gray-400 space-y-1">
              <div>PR pushed &rarr; Origin receives webhook</div>
              <div className="pl-4">&darr;</div>
              <div className="pl-4">Match commits to sessions by SHA</div>
              <div className="pl-8">&darr;</div>
              <div className="pl-8"><span className="text-gray-300">0 sessions found?</span> &rarr; <span className="text-green-400">&#10003; Pass</span> (human code assumed)</div>
              <div className="pl-8"><span className="text-gray-300">Sessions found, no policies?</span> &rarr; <span className="text-green-400">&#10003; Pass</span> (informational only)</div>
              <div className="pl-8"><span className="text-gray-300">REQUIRE_REVIEW active?</span> &rarr; <span className="text-amber-400">&#9679; Pending</span> until reviewer approves in dashboard</div>
              <div className="pl-8"><span className="text-gray-300">COST_LIMIT exceeded?</span> &rarr; <span className="text-red-400">&#10007; Fail</span> with cost details</div>
              <div className="pl-8"><span className="text-gray-300">All policies pass?</span> &rarr; <span className="text-green-400">&#10003; Pass</span></div>
            </div>

            <Callout type="warning">
              PR checks require the Origin GitHub App installed and connected in Settings &rarr; Integrations.
              Repositories must be imported in Origin for checks to appear.
            </Callout>
          </div>
    </>
  );
}
