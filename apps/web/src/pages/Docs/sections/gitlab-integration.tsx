import { H2, H3, P, Li, Step } from '../shared/Markdown';

export default function GitlabIntegrationSection() {
  return (
    <>
          <div>
            <h1 id="gitlab-integration" className="text-2xl font-bold mb-2">GitLab Integration</h1>
            <P>
              Connect GitLab to enable automatic repo discovery, one-click import with webhook setup,
              MR commit statuses, and AI governance comments on merge requests.
              Origin supports both <strong className="text-gray-200">OAuth App</strong> (recommended) and
              <strong className="text-gray-200">Personal Access Token</strong> authentication.
            </P>

            <H2>Option A: Connect via OAuth (Recommended)</H2>
            <P>
              OAuth is the easiest way to connect &mdash; no token to copy, just authorize with one click.
              This requires the Origin server to have a GitLab OAuth Application configured.
            </P>

            <Step n={1} title="Click Connect with GitLab">
              <p>
                Navigate to <strong className="text-gray-200">Settings &rarr; Integrations &rarr; GitLab</strong>.
                If OAuth is available, you&apos;ll see a <strong className="text-gray-200">Connect with GitLab</strong> button.
                Click it to be redirected to GitLab.
              </p>
            </Step>

            <Step n={2} title="Authorize the Application">
              <p>
                On GitLab, review the permissions and click <strong className="text-gray-200">Authorize</strong>.
                Origin requests the <code className="text-indigo-400">api</code> scope for full access to the GitLab API.
              </p>
            </Step>

            <Step n={3} title="Done!">
              <p>
                You&apos;ll be redirected back to Origin with a success message.
                Your GitLab username will be displayed, and the access token is automatically managed
                (refreshed every 2 hours without any action from you).
              </p>
            </Step>

            <H2>Option B: Connect via Personal Access Token</H2>
            <P>
              Use this method for self-hosted GitLab instances or when OAuth is not configured.
            </P>

            <Step n={1} title="Generate a GitLab Personal Access Token">
              <p className="mb-2">
                Go to <strong className="text-gray-200">GitLab &rarr; User Settings &rarr; Access Tokens</strong> and
                click &ldquo;Add new token&rdquo;.
              </p>
              <p className="mb-2">Required scopes:</p>
              <ul className="space-y-1 ml-4">
                <Li><code className="text-indigo-400">api</code> &mdash; Full API access (needed for commit statuses, MR comments, webhooks, and repo listing)</Li>
              </ul>
              <p className="mt-2">Set an expiration date (or leave blank for no expiry on self-hosted instances).</p>
            </Step>

            <Step n={2} title="Add the Token in Origin">
              <p className="mb-2">
                Navigate to <strong className="text-gray-200">Settings &rarr; Integrations</strong> in Origin.
                In the GitLab section:
              </p>
              <ul className="space-y-1 ml-4">
                <Li>Paste your token in the <strong className="text-gray-200">Personal Access Token</strong> field</Li>
                <Li>(Optional) Set the <strong className="text-gray-200">API Base URL</strong> for self-hosted GitLab (e.g. <code className="text-indigo-400">https://gitlab.yourcompany.com/api/v4</code>)</Li>
                <Li>Toggle the features you want: commit statuses, MR comments, update on review</Li>
                <Li>Click <strong className="text-gray-200">Connect GitLab</strong></Li>
              </ul>
            </Step>

            <Step n={3} title="Test the Connection">
              <p>
                Click <strong className="text-gray-200">Test Connection</strong>. If successful, you&apos;ll see your
                GitLab username confirming the token is valid.
              </p>
            </Step>

            <Step n={4} title="Import Repositories">
              <p className="mb-2">
                Go to <strong className="text-gray-200">Repositories</strong> and click <strong className="text-gray-200">Import from GitLab</strong>.
                Origin fetches all projects your token has access to, shows them in a list, and lets you
                select which to monitor. Click &ldquo;Import Selected&rdquo; and Origin will:
              </p>
              <ul className="space-y-1 ml-4">
                <Li>Create each repository in Origin</Li>
                <Li>Generate a webhook secret</Li>
                <Li>Automatically create a webhook on the GitLab project (push + merge request events)</Li>
              </ul>
              <p className="mt-2">No manual webhook configuration needed.</p>
            </Step>

            <H2>Features</H2>

            <H3>MR Commit Statuses</H3>
            <P>
              When enabled, Origin posts a commit status (<code className="text-indigo-400">origin/ai-governance</code>)
              on every merge request that contains AI-authored commits. The status reflects the review state:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><span className="text-green-400">Success</span> &mdash; All linked AI sessions are approved</Li>
              <Li><span className="text-amber-400">Pending</span> &mdash; Sessions awaiting human review</Li>
              <Li><span className="text-red-400">Failed</span> &mdash; One or more sessions rejected or flagged</Li>
            </ul>

            <H3>MR Summary Comments</H3>
            <P>
              When enabled, Origin posts (or updates) an AI Attribution Report on each MR showing:
              AI commit percentage, models used, agents used, per-commit breakdown, and session costs.
            </P>

            <H3>Differences from GitHub</H3>
            <ul className="space-y-2 mb-4">
              <Li>
                <strong className="text-gray-200">No Check Runs</strong> &mdash; GitLab does not have a Check Runs
                equivalent. Origin posts AI attribution as a merge request note instead.
              </Li>
              <Li>
                <strong className="text-gray-200">Webhook Auth</strong> &mdash; GitLab uses a plain secret token
                (compared via <code className="text-indigo-400">X-Gitlab-Token</code> header) instead of HMAC signatures.
              </Li>
              <Li>
                <strong className="text-gray-200">Self-Hosted</strong> &mdash; Set the API Base URL to your instance&apos;s
                API endpoint, e.g. <code className="text-indigo-400">https://gitlab.yourcompany.com/api/v4</code>.
              </Li>
            </ul>

            <H2>Disconnecting</H2>
            <P>
              Click <strong className="text-gray-200">Disconnect</strong> in Settings &rarr; Integrations.
              For OAuth connections, Origin will also revoke the token on GitLab.
              Note: delete imported repos in Origin first to auto-remove GitLab webhooks.
            </P>
          </div>
    </>
  );
}
