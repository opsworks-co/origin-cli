import { H2, H3, P, Li, Step, Callout } from '../shared/Markdown';

export default function SettingsSection() {
  return (
    <>
          <div>
            <h1 id="settings" className="text-2xl font-bold mb-2">Settings & API Keys</h1>
            <P>
              Manage your organization&apos;s API keys, integrations, and account settings.
            </P>

            {/* Settings Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Settings &mdash; API Keys</span>
              </div>
              <div className="p-4">
                {/* Tabs */}
                <div className="flex gap-4 border-b border-gray-700/50 mb-4">
                  <span className="text-xs text-indigo-400 border-b-2 border-indigo-400 pb-1.5 font-medium">General</span>
                  <span className="text-xs text-gray-500 pb-1.5">Integrations</span>
                  <span className="text-xs text-gray-500 pb-1.5">Budget</span>
                  <span className="text-xs text-gray-500 pb-1.5">Team</span>
                </div>
                {/* API Keys list */}
                <div className="space-y-2">
                  {[
                    { name: 'Production CLI', prefix: 'org_sk_prod_a3f8...', created: 'Jan 15', agents: 2 },
                    { name: 'CI/CD Runner', prefix: 'org_sk_ci_b7d2...', created: 'Feb 3', agents: 1 },
                  ].map((k, i) => (
                    <div key={i} className="flex items-center gap-3 bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-200 font-medium">{k.name}</div>
                        <div className="text-[10px] text-gray-500 font-mono">{k.prefix}</div>
                      </div>
                      <span className="text-[10px] text-gray-500">{k.agents} agents</span>
                      <span className="text-[10px] text-gray-500">Created {k.created}</span>
                      <span className="text-[10px] text-red-400 cursor-pointer">Revoke</span>
                    </div>
                  ))}
                  <div className="flex justify-center pt-1">
                    <div className="px-3 py-1.5 bg-indigo-600/20 border border-indigo-500/30 rounded-lg text-xs text-indigo-400 cursor-pointer">+ Create New Key</div>
                  </div>
                </div>
              </div>
            </div>

            <H2 id="api-keys">API Keys</H2>
            <P>
              API keys authenticate the CLI tool and MCP server. They are tied to your organization
              and work alongside Bearer token auth.
            </P>

            <Step n={1} title="Create an API Key">
              <p>Go to <strong className="text-gray-200">Settings &rarr; General</strong> and scroll to the API Keys section. Click <strong className="text-gray-200">Create New</strong> and optionally name the key.</p>
            </Step>
            <Step n={2} title="Copy the Secret">
              <p>The full API key is shown <strong className="text-gray-200">only once</strong> in an amber card. Copy it immediately. After dismissing, only the key prefix is visible.</p>
            </Step>
            <Step n={3} title="Use the Key">
              <p>Pass the key via the <code className="text-indigo-400">X-API-Key</code> header in API requests, or configure it in the CLI / MCP server.</p>
            </Step>

            <H3>API Key Scoping</H3>
            <P>
              Each API key can be scoped to specific <strong className="text-gray-200">agents</strong> and <strong className="text-gray-200">repositories</strong>.
              This controls which agents the key can create sessions for and which repos it can access. Keys without any agent
              assignments cannot start sessions. Assign agents and repos when creating or editing an API key.
            </P>

            <Callout type="warning">
              API keys authenticate CLI and MCP connections. Treat them like passwords. Rotate keys regularly and delete unused ones.
            </Callout>

            <H2>Integrations</H2>
            <P>
              The Integrations tab manages connections to external services. Supports GitHub
              (PAT or GitHub App) and GitLab (PAT or OAuth). See the <strong className="text-gray-200">GitHub Integration</strong> and <strong className="text-gray-200">GitLab Integration</strong> guides for setup details.
            </P>

            <H3>Integration Features</H3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Post status checks on PRs</strong> &mdash; Shows pass/fail badges on PRs based on AI session review status</Li>
              <Li><strong className="text-gray-200">Post session summary comments</strong> &mdash; Adds a detailed AI governance report as a PR comment</Li>
              <Li><strong className="text-gray-200">Update checks on review</strong> &mdash; Auto-refreshes PR status when sessions are reviewed in Origin</Li>
            </ul>

            <H2>Organization Info</H2>
            <P>
              View your org name, slug, your role, and email in the General tab. Organization settings
              are read-only in the current version.
            </P>
          </div>
    </>
  );
}
