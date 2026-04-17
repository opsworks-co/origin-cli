import { H2, H3, P, Li, Step, Callout } from '../shared/Markdown';

export default function IntegrationsSection() {
  return (
    <>
          <div>
            <h1 id="integrations" className="text-2xl font-bold mb-2">GitHub Integration</h1>
            <P>
              Connect GitHub to enable automatic repo discovery, one-click import with webhook setup,
              PR status checks, and AI governance comments on pull requests.
            </P>

            <H2 id="github-setup-guide">Setup Guide</H2>

            <Step n={1} title="Generate a GitHub Personal Access Token">
              <p className="mb-2">
                Go to <strong className="text-gray-200">GitHub &rarr; Settings &rarr; Developer settings &rarr;
                Personal access tokens &rarr; Tokens (classic)</strong> and click &ldquo;Generate new token (classic)&rdquo;.
              </p>
              <p className="mb-2">Required scopes:</p>
              <ul className="space-y-1 ml-4">
                <Li><code className="text-indigo-400">repo</code> &mdash; Full access to repositories (needed for private repos, status checks, PR comments)</Li>
                <Li><code className="text-indigo-400">admin:repo_hook</code> &mdash; Create and manage webhooks on your repos</Li>
              </ul>
            </Step>

            <Callout type="info">
              The <code className="text-indigo-400">repo</code> scope includes <code className="text-indigo-400">admin:repo_hook</code> as a sub-scope,
              so selecting <code className="text-indigo-400">repo</code> alone is sufficient. If you only want public repos, <code className="text-indigo-400">public_repo</code> + <code className="text-indigo-400">admin:repo_hook</code> is enough.
            </Callout>

            <Step n={2} title="Add the Token in Origin">
              <p className="mb-2">
                Navigate to <strong className="text-gray-200">Settings &rarr; Integrations</strong> in Origin.
                In the GitHub section:
              </p>
              <ul className="space-y-1 ml-4">
                <Li>Paste your token in the <strong className="text-gray-200">Personal Access Token</strong> field</Li>
                <Li>(Optional) Set the <strong className="text-gray-200">API Base URL</strong> for GitHub Enterprise (leave blank for github.com)</Li>
                <Li>Toggle the features you want: status checks, PR comments, update on review</Li>
                <Li>Click <strong className="text-gray-200">Connect GitHub</strong></Li>
              </ul>
            </Step>

            <Step n={3} title="Test the Connection">
              <p>
                Click <strong className="text-gray-200">Test Connection</strong>. If successful, you&apos;ll see your
                GitHub username confirming the token is valid.
              </p>
            </Step>

            <Step n={4} title="Import Repositories">
              <p className="mb-2">
                Go to <strong className="text-gray-200">Repositories</strong> and click <strong className="text-gray-200">Import from GitHub</strong>.
                Origin fetches all repos your token has access to (public and private), shows them in a list, and lets you
                select which to monitor. Click &ldquo;Import Selected&rdquo; and Origin will:
              </p>
              <ul className="space-y-1 ml-4">
                <Li>Create each repository in Origin</Li>
                <Li>Generate a webhook secret</Li>
                <Li>Automatically create a webhook on the GitHub repo (push + pull_request events)</Li>
              </ul>
              <p className="mt-2">No manual webhook configuration needed.</p>
            </Step>

            <H2>Features</H2>

            <H3>PR Status Checks</H3>
            <P>
              When enabled, Origin posts a commit status check (<code className="text-indigo-400">origin/ai-governance</code>)
              on every PR that contains AI-authored commits. The check reflects the review status:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><span className="text-green-400">Success</span> &mdash; All linked AI sessions are approved</Li>
              <Li><span className="text-amber-400">Pending</span> &mdash; Sessions awaiting human review</Li>
              <Li><span className="text-red-400">Failure</span> &mdash; One or more sessions rejected or flagged</Li>
            </ul>
            <Callout type="tip">
              You can require the <code className="text-indigo-400">origin/ai-governance</code> check to pass
              in GitHub branch protection rules. This creates a gate where PRs with AI code must be reviewed in Origin before merging.
            </Callout>

            <H3>PR Summary Comments</H3>
            <P>
              When enabled, Origin posts (or updates) a comment on each PR with an AI governance report
              showing all linked sessions, their models, costs, token usage, and review status.
            </P>

            <H3>Update on Review</H3>
            <P>
              When you review a session in Origin (approve/reject/flag), the PR&apos;s status check
              and comment are automatically updated to reflect the new status. This gives developers
              instant feedback in their PR without leaving GitHub.
            </P>

            <H2>Private Repositories</H2>
            <P>
              Private repos work exactly the same as public ones. As long as your GitHub token has
              the <code className="text-indigo-400">repo</code> scope, Origin can see and create webhooks on all repos
              the token owner has access to, including private ones and repos in organizations you belong to.
            </P>

            <H2>GitHub Enterprise</H2>
            <P>
              For GitHub Enterprise Server, set the <strong className="text-gray-200">API Base URL</strong> to your
              instance&apos;s API endpoint, e.g. <code className="text-indigo-400">https://github.yourcompany.com/api/v3</code>.
              Everything else works identically.
            </P>

            <H2>Disconnecting</H2>
            <P>
              Click <strong className="text-gray-200">Disconnect</strong> in Settings &rarr; Integrations to remove the
              GitHub token. Note: this does not remove webhooks already created on GitHub repos. To fully clean up,
              delete the imported repos in Origin first (this auto-removes the GitHub webhooks), then disconnect.
            </P>
          </div>
    </>
  );
}
