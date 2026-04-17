import { CodeBlock, H3, P } from '../shared/Markdown';

export default function ApiSection() {
  return (
    <>
          <div>
            <h1 id="api" className="text-2xl font-bold mb-2">API Reference</h1>
            <P>
              Origin exposes a REST API at <code className="text-indigo-400">/api</code>.
              All authenticated endpoints require either a Bearer token (JWT) or an API key (<code className="text-indigo-400">X-API-Key</code> header).
            </P>

            <H3>Authentication</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/auth/login</code>
                </div>
                <P>Login with email and password. Returns JWT token and user object.</P>
                <CodeBlock>{`{ "email": "user@example.com", "password": "..." }`}</CodeBlock>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/auth/register</code>
                </div>
                <P>Create a new account with org. Returns JWT token and user object.</P>
                <CodeBlock>{`{ "email": "...", "password": "...", "name": "...", "orgName": "...", "orgSlug": "..." }`}</CodeBlock>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/auth/me</code>
                </div>
                <P>Get the current authenticated user profile.</P>
              </div>
            </div>

            <H3>Repositories</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/repos</code>
                </div>
                <P>List all repositories for the org. Includes commit counts.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/repos</code>
                </div>
                <P>Create a new repository. Body: <code className="text-indigo-400">{`{ name, path, provider? }`}</code></P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/repos/github/discover</code>
                </div>
                <P>List all GitHub repos accessible by the org&apos;s token. Returns repos with <code className="text-indigo-400">alreadyImported</code> flags. Requires MEMBER+.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/repos/github/import</code>
                </div>
                <P>Batch import GitHub repos with auto-webhook creation. Requires ADMIN+.</P>
                <CodeBlock>{`{ "repos": [{ "fullName": "owner/repo" }], "originBaseUrl": "https://..." }`}</CodeBlock>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/repos/:id/sync</code>
                </div>
                <P>Sync a repository. Returns <code className="text-indigo-400">{`{ synced, total }`}</code>.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/repos/:id/commits</code>
                </div>
                <P>List all commits for a repository, including session data.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/repos/:id/webhooks</code>
                </div>
                <P>Create a webhook for a repo (manual setup). Returns secret (shown once). Requires ADMIN+.</P>
              </div>
            </div>

            <H3>Sessions</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/sessions</code>
                </div>
                <P>List sessions. Query params: <code className="text-indigo-400">model, status, agentId, repoId, limit, offset</code>.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/sessions/:id</code>
                </div>
                <P>Get a single session with full transcript, review data, and linked pull requests.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/sessions/:id/review</code>
                </div>
                <P>Review a session. Body: <code className="text-indigo-400">{`{ status: "APPROVED"|"REJECTED"|"FLAGGED", note? }`}</code></P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/sessions/active</code>
                </div>
                <P>Get all currently running sessions (status = RUNNING). Returns <code className="text-indigo-400">{`{ sessions: Session[] }`}</code>.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/sessions/:id/blame</code>
                </div>
                <P>Get line-level AI attribution for a file. Query: <code className="text-indigo-400">file</code> (file path). Returns per-line prompt attribution.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/sessions/:id/ask</code>
                </div>
                <P>Ask a question about a session. Body: <code className="text-indigo-400">{`{ question, context?, history? }`}</code>. Requires <code className="text-indigo-400">ANTHROPIC_API_KEY</code>.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/sessions/:id/diff</code>
                </div>
                <P>Get the full unified diff for a session. Returns HEAD before/after, commit SHAs, and diff content.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/sessions/by-pr</code>
                </div>
                <P>Get sessions grouped by pull request with aggregated stats per PR.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/sessions/stream</code>
                </div>
                <P>SSE endpoint for real-time session events. Query: <code className="text-indigo-400">token</code> (JWT). Emits session:started, session:ended, session:updated, session:reviewed.</P>
              </div>
            </div>

            <H3>Agents</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/agents</code>
                </div>
                <P>List all agents for the org with session counts.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/agents</code>
                </div>
                <P>Create an agent. Body: <code className="text-indigo-400">{`{ name, slug, model, description? }`}</code></P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-amber text-xs">PUT</span>
                  <code className="text-sm text-gray-200">/api/agents/:id</code>
                </div>
                <P>Update agent name, description, model, or status.</P>
              </div>
            </div>

            <H3>Policies</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/policies</code>
                </div>
                <P>List all policies with their rules.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/policies</code>
                </div>
                <P>Create a policy. Body: <code className="text-indigo-400">{`{ name, type, description? }`}</code></P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/policies/:id/rules</code>
                </div>
                <P>Add a rule. Body: <code className="text-indigo-400">{`{ condition, action, severity?, agentId? }`}</code></P>
              </div>
            </div>

            <H3>Integrations</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/integrations</code>
                </div>
                <P>List org integrations. Tokens are never exposed (only <code className="text-indigo-400">hasToken: true</code>).</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/integrations</code>
                </div>
                <P>Create integration. Body: <code className="text-indigo-400">{`{ provider, token, baseUrl?, settings? }`}</code></P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/integrations/:id/test</code>
                </div>
                <P>Test connection. Returns <code className="text-indigo-400">{`{ success, login?, error? }`}</code>.</P>
              </div>
            </div>

            <H3>Webhooks</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/webhooks/github/:repoId</code>
                </div>
                <P>GitHub webhook receiver (public, HMAC-verified). Handles push, pull_request, and ping events.</P>
              </div>
            </div>

            <H3>Stats & Audit</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/stats</code>
                </div>
                <P>Comprehensive analytics: sessions, costs, model breakdown, trends, top agents/engineers.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/audit</code>
                </div>
                <P>Audit log entries. Query params: <code className="text-indigo-400">action, limit, offset</code>.</P>
              </div>
            </div>
          </div>
    </>
  );
}
