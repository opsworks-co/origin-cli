import { H2, P, Li, Step } from '../shared/Markdown';

type Props = { setActive: (key: any) => void };

export default function OverviewSection({ setActive }: Props) {
  return (
    <>
          <div>
            <h1 id="overview" className="text-2xl font-bold mb-2">Origin Documentation</h1>
            <P>
              Origin is the governance platform for AI-authored code. It gives engineering
              leaders full visibility into what AI agents are writing, enforces policies
              around agent behavior, and provides complete audit trails for compliance.
            </P>

            {/* Hero card — fast path for new admins. The full team setup
                walkthrough was buried under a sub-tab; surfacing it on the
                docs landing cuts time-to-first-success in half. */}
            <button
              type="button"
              onClick={() => setActive('quick-start')}
              className="group block w-full text-left my-6 rounded-xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 to-purple-500/5 px-6 py-5 hover:border-indigo-400/50 hover:from-indigo-500/15 transition-colors"
            >
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center group-hover:bg-indigo-500/30 transition-colors">
                  <svg className="w-5 h-5 text-indigo-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-base font-semibold text-gray-100 mb-1">
                    Set up Origin for your team in 10 minutes
                  </div>
                  <div className="text-sm text-gray-400 leading-relaxed">
                    Five-step walkthrough with screenshots: create your org, connect GitHub/GitLab, import repos, invite teammates, and install the CLI on each developer's machine.
                  </div>
                </div>
                <div className="flex-shrink-0 text-indigo-400 text-sm font-medium group-hover:text-indigo-300 transition-colors">
                  Start &rarr;
                </div>
              </div>
            </button>

            <H2 id="core-concepts">Core Concepts</H2>
            <ul className="space-y-2 mb-4">
              <Li>
                <strong className="text-gray-200">Repositories</strong> &mdash; Connect your Git repos
                (local or GitHub). Origin syncs commits and identifies which were AI-authored.
              </Li>
              <Li>
                <strong className="text-gray-200">Sessions</strong> &mdash; Each AI coding interaction
                is captured as a session: the prompt, model, transcript, files changed, tokens, and cost.
              </Li>
              <Li>
                <strong className="text-gray-200">Agents</strong> &mdash; Named AI coding tools (e.g.
                &ldquo;Claude Code&rdquo;, &ldquo;Cursor&rdquo;) that your team uses. Track usage per agent.
              </Li>
              <Li>
                <strong className="text-gray-200">Policies</strong> &mdash; Governance rules that
                control what agents can do: file restrictions, model allowlists, cost limits,
                review requirements.
              </Li>
              <Li>
                <strong className="text-gray-200">Integrations</strong> &mdash; Connect to GitHub or GitLab for auto-discovery
                of repos, automatic webhook setup, PR/MR status checks, and session summary comments.
              </Li>
              <Li>
                <strong className="text-gray-200">Reviews</strong> &mdash; Every AI session can be
                reviewed (approved, rejected, flagged) by a human. Unreviewed sessions are tracked.
              </Li>
            </ul>

            <H2 id="recommended-setup-order">Recommended Setup Order</H2>
            <div className="bg-indigo-600/10 border border-indigo-500/30 rounded-lg p-4 mb-4">
              <p className="text-sm text-indigo-300">
                New to Origin? Follow the{' '}
                <button onClick={() => { setActive('quick-start'); window.history.replaceState(null, '', '#quick-start'); }} className="underline underline-offset-2 font-semibold hover:text-indigo-200">
                  Quick Start Guide
                </button>{' '}
                for a detailed step-by-step walkthrough with visual examples.
              </p>
            </div>
            <P>Follow this order for the smoothest onboarding experience:</P>
            <div className="space-y-1 mb-4">
              <Step n={1} title="Connect GitHub or GitLab">
                Go to Settings &rarr; Integrations and connect via OAuth or Personal Access Token.
              </Step>
              <Step n={2} title="Import Repositories">
                Go to Repositories &rarr; &ldquo;Import from GitHub&rdquo; or &ldquo;Import from GitLab&rdquo; to auto-discover and import repos with one click.
              </Step>
              <Step n={3} title="Register Agents">
                Go to Agents and register the AI tools your team uses (Claude Code, Cursor, Copilot, etc.).
              </Step>
              <Step n={4} title="Create Policies">
                Go to Policies and set up governance rules (file restrictions, cost limits, review requirements).
              </Step>
              <Step n={5} title="Set Up CLI / MCP">
                Install the CLI on developer machines and configure the MCP server in AI tools for real-time enforcement.
              </Step>
            </div>
          </div>
    </>
  );
}
