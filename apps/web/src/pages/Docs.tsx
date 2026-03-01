import React, { useState } from 'react';

type Section = 'overview' | 'quickstart' | 'dashboard' | 'repos' | 'sessions' | 'agents' | 'policies' | 'cli' | 'mcp' | 'api';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'quickstart', label: 'Quick Start' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'repos', label: 'Repositories' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'agents', label: 'Agents' },
  { key: 'policies', label: 'Policies' },
  { key: 'cli', label: 'CLI' },
  { key: 'mcp', label: 'MCP Server' },
  { key: 'api', label: 'API Reference' },
];

function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="rounded-lg overflow-hidden border border-gray-700 my-3">
      {title && (
        <div className="bg-gray-800 px-4 py-2 text-xs text-gray-400 border-b border-gray-700 font-mono">
          {title}
        </div>
      )}
      <pre className="bg-gray-900 px-4 py-3 text-sm font-mono text-gray-200 overflow-x-auto">
        {children}
      </pre>
    </div>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xl font-bold text-gray-100 mt-8 mb-3">{children}</h2>;
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400 leading-relaxed mb-3">{children}</p>;
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="text-sm text-gray-400 leading-relaxed flex items-start gap-2">
      <span className="text-indigo-400 mt-1 flex-shrink-0">&bull;</span>
      <span>{children}</span>
    </li>
  );
}

export default function Docs() {
  const [active, setActive] = useState<Section>('overview');

  return (
    <div className="flex gap-8">
      {/* Sidebar TOC */}
      <nav className="hidden lg:block w-48 flex-shrink-0 sticky top-0 self-start">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Documentation
        </p>
        <div className="space-y-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setActive(s.key)}
              className={`block w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                active === s.key
                  ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Mobile dropdown */}
      <div className="lg:hidden mb-4">
        <select
          value={active}
          onChange={(e) => setActive(e.target.value as Section)}
          className="select w-full text-sm"
        >
          {SECTIONS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 max-w-3xl">
        {active === 'overview' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Origin Documentation</h1>
            <P>
              Origin is the governance platform for AI-authored code. It gives engineering
              leaders full visibility into what AI agents are writing, enforces policies
              around agent behavior, and provides complete audit trails for compliance.
            </P>

            <H2>Core Concepts</H2>
            <ul className="space-y-2 mb-4">
              <Li>
                <strong className="text-gray-200">Repositories</strong> &mdash; Connect your Git repos
                (local or GitHub). Origin syncs commits and identifies which ones were AI-authored.
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
                <strong className="text-gray-200">Reviews</strong> &mdash; Every AI session can be
                reviewed (approved, rejected, flagged) by a human. Unreviewed sessions are tracked.
              </Li>
            </ul>

            <H2>Architecture</H2>
            <P>
              Origin is a monorepo with four packages:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><code className="text-indigo-400">apps/api</code> &mdash; Express + Prisma backend (REST API)</Li>
              <Li><code className="text-indigo-400">apps/web</code> &mdash; React + Vite + Tailwind dashboard</Li>
              <Li><code className="text-indigo-400">packages/cli</code> &mdash; Command-line tool for developers</Li>
              <Li><code className="text-indigo-400">packages/mcp-server</code> &mdash; MCP server for real-time policy enforcement in Claude Code / Cursor</Li>
            </ul>
          </div>
        )}

        {active === 'quickstart' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Quick Start</h1>
            <P>Get Origin running locally in under 5 minutes.</P>

            <H3>Prerequisites</H3>
            <ul className="space-y-2 mb-4">
              <Li>Node.js 18+</Li>
              <Li>pnpm 8+</Li>
              <Li>Git</Li>
            </ul>

            <H3>1. Clone and install</H3>
            <CodeBlock>{`git clone https://github.com/your-org/origin-v2.git
cd origin-v2
pnpm install`}</CodeBlock>

            <H3>2. Set up the database</H3>
            <CodeBlock>{`cd apps/api
cp .env.example .env
npx prisma migrate dev --name init
npx prisma db seed`}</CodeBlock>
            <P>
              This creates an SQLite database with demo data including a sample organization,
              user, repositories, sessions, and policies.
            </P>

            <H3>3. Start the dev servers</H3>
            <CodeBlock>{`# Terminal 1 — API server (port 4002)
cd apps/api && npm run dev

# Terminal 2 — Web dashboard (port 5176)
cd apps/web && npm run dev`}</CodeBlock>

            <H3>4. Sign in</H3>
            <P>
              Open <code className="text-indigo-400">http://localhost:5176</code> and sign in
              with the demo credentials:
            </P>
            <CodeBlock>{`Email:    artem@origin.dev
Password: password123`}</CodeBlock>

            <H3>5. Connect a repository</H3>
            <P>
              Navigate to <strong className="text-gray-200">Repositories</strong> in the sidebar and click
              &ldquo;Add Repository&rdquo;. Enter the path to a local Git repo or a GitHub URL.
              Then click &ldquo;Sync Now&rdquo; to import commits.
            </P>
          </div>
        )}

        {active === 'dashboard' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Dashboard</h1>
            <P>The dashboard provides a high-level governance overview of your organization&apos;s AI coding activity.</P>

            <H3>KPI Cards</H3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Active Agents</strong> &mdash; Number of agents with status &ldquo;ACTIVE&rdquo;</Li>
              <Li><strong className="text-gray-200">Sessions This Week</strong> &mdash; AI coding sessions in the past 7 days</Li>
              <Li><strong className="text-gray-200">Unreviewed</strong> &mdash; Sessions awaiting human review</Li>
              <Li><strong className="text-gray-200">Est. Cost This Month</strong> &mdash; Total API cost from all sessions this month</Li>
            </ul>

            <H3>Engineering ROI</H3>
            <P>
              Shows lines of code written by AI this month and estimated engineering hours saved
              (calculated at ~50 lines per hour).
            </P>

            <H3>Recent Sessions</H3>
            <P>
              The last 10 sessions across all repos with model, repo, commit message, status, and age.
              Click &ldquo;View all&rdquo; to go to the full Sessions page.
            </P>

            <H3>Registered Machines</H3>
            <P>
              Machines connected via the CLI (<code className="text-indigo-400">origin init</code>).
              Shows hostname, detected tools, last seen time, and machine ID.
            </P>
          </div>
        )}

        {active === 'repos' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Repositories</h1>
            <P>
              Repositories are the foundation of Origin. Each repo represents a Git
              repository where AI agents write code.
            </P>

            <H3>Connecting a Repository</H3>
            <P>Click &ldquo;Add Repository&rdquo; and fill in:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Name</strong> &mdash; A display name for the repo</Li>
              <Li><strong className="text-gray-200">Path</strong> &mdash; Local filesystem path or GitHub URL</Li>
              <Li><strong className="text-gray-200">Provider</strong> &mdash; &ldquo;Local&rdquo; for local repos, &ldquo;GitHub&rdquo; for remote</Li>
            </ul>

            <H3>Syncing</H3>
            <P>
              Click &ldquo;Sync Now&rdquo; on any repo to scan for new commits. Origin looks for
              <code className="text-indigo-400">.entire/</code> checkpoint directories that AI tools
              create, then imports the session data (model, prompt, transcript, files changed, etc.).
            </P>

            <H3>Repository Detail View</H3>
            <P>Click any repo card to see its detail page with:</P>
            <ul className="space-y-2 mb-4">
              <Li>Stats: total commits, AI-authored, human, unreviewed counts</Li>
              <Li>Filter tabs: All / AI Authored / Human / Unreviewed</Li>
              <Li>Full commit table with SHA, message, author, model, files, tokens, and review status</Li>
              <Li>Click any AI-authored commit to view its session detail and transcript</Li>
            </ul>
          </div>
        )}

        {active === 'sessions' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Sessions</h1>
            <P>
              Sessions represent individual AI coding interactions. Every time an agent
              writes code, Origin captures it as a session.
            </P>

            <H3>Session Data</H3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Model</strong> &mdash; Which AI model was used (e.g. claude-sonnet-4-20250514)</Li>
              <Li><strong className="text-gray-200">Prompt</strong> &mdash; What the developer asked the agent to do</Li>
              <Li><strong className="text-gray-200">Transcript</strong> &mdash; Full conversation between human and AI</Li>
              <Li><strong className="text-gray-200">Files Changed</strong> &mdash; List of files the agent modified</Li>
              <Li><strong className="text-gray-200">Tokens Used</strong> &mdash; Total input + output tokens</Li>
              <Li><strong className="text-gray-200">Cost</strong> &mdash; Estimated API cost in USD</Li>
              <Li><strong className="text-gray-200">Tool Calls</strong> &mdash; Number of tool invocations during the session</Li>
              <Li><strong className="text-gray-200">Duration</strong> &mdash; How long the session took</Li>
              <Li><strong className="text-gray-200">Lines Added/Removed</strong> &mdash; Net code changes</Li>
            </ul>

            <H3>Filtering Sessions</H3>
            <P>
              Use the filter bar at the top of the Sessions page to filter by model, status
              (reviewed/unreviewed/flagged), and repository.
            </P>

            <H3>Reviewing Sessions</H3>
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
              in the audit trail.
            </P>
          </div>
        )}

        {active === 'agents' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Agents</h1>
            <P>
              Agents represent the AI coding tools your team uses. Each agent has a name,
              model identifier, and status.
            </P>

            <H3>Creating an Agent</H3>
            <P>Click &ldquo;Add Agent&rdquo; and fill in:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Name</strong> &mdash; Display name (e.g. &ldquo;Production Claude&rdquo;)</Li>
              <Li><strong className="text-gray-200">Slug</strong> &mdash; Unique identifier (e.g. &ldquo;prod-claude&rdquo;)</Li>
              <Li><strong className="text-gray-200">Model</strong> &mdash; The model used (e.g. &ldquo;claude-sonnet-4-20250514&rdquo;)</Li>
            </ul>

            <H3>Agent Status</H3>
            <P>
              Agents can be <code className="text-green-400">ACTIVE</code> or <code className="text-gray-400">INACTIVE</code>.
              Only active agents are counted in dashboard stats.
            </P>

            <H3>Agent Metrics</H3>
            <P>
              Each agent card shows the total number of sessions and creation date.
              Policies can be scoped to specific agents.
            </P>
          </div>
        )}

        {active === 'policies' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Policies</h1>
            <P>
              Policies are governance rules that control what AI agents can and cannot do.
              They are enforced in real-time via the MCP server.
            </P>

            <H3>Policy Types</H3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-red-400">FILE_RESTRICTION</strong> &mdash; Block or warn when agents access certain files (e.g. .env, secrets/)</Li>
              <Li><strong className="text-amber-400">REQUIRE_REVIEW</strong> &mdash; Require human review for certain operations</Li>
              <Li><strong className="text-blue-400">MODEL_ALLOWLIST</strong> &mdash; Only allow specific models to be used</Li>
              <Li><strong className="text-purple-400">COST_LIMIT</strong> &mdash; Set cost thresholds per session or agent</Li>
            </ul>

            <H3>Rules</H3>
            <P>
              Each policy contains one or more rules. A rule has:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Condition</strong> &mdash; When this rule applies (e.g. JSON glob pattern for file paths)</Li>
              <Li><strong className="text-gray-200">Action</strong> &mdash; What happens: block, warn, require_review, or notify</Li>
              <Li><strong className="text-gray-200">Severity</strong> &mdash; low, medium, or high</Li>
              <Li><strong className="text-gray-200">Agent</strong> &mdash; Optionally scope to a specific agent</Li>
            </ul>

            <H3>Enforcement</H3>
            <P>
              When a policy is toggled active, it shows &ldquo;Enforced via MCP&rdquo;. The MCP server
              checks policies in real-time when agents attempt file access or other operations.
              Violations are logged in the audit trail.
            </P>
          </div>
        )}

        {active === 'cli' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">CLI Reference</h1>
            <P>
              The Origin CLI connects developer machines to the Origin platform.
            </P>

            <H3>Installation</H3>
            <CodeBlock>{`npm install -g @origin/cli`}</CodeBlock>

            <H3>Commands</H3>

            <div className="space-y-4 mt-4">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin login</code>
                <P>Authenticate with your Origin account. Enter your email and password to get an API key stored at <code className="text-indigo-400">~/.origin/config.json</code>.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin init</code>
                <P>Register the current machine with Origin. Detects installed tools (git, node, python, etc.) and reports them to the server.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin status</code>
                <P>Show current connection status, machine info, and server health.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin policies</code>
                <P>List all active governance policies from the server.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin sync</code>
                <P>Sync all repositories in the current directory. Discovers <code className="text-indigo-400">.entire/</code> checkpoints and uploads session data.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin whoami</code>
                <P>Show the currently authenticated user and organization.</P>
              </div>
            </div>
          </div>
        )}

        {active === 'mcp' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">MCP Server</h1>
            <P>
              The Origin MCP (Model Context Protocol) server provides real-time policy
              enforcement for AI coding agents. It runs as a sidecar process alongside
              your AI tool.
            </P>

            <H3>How It Works</H3>
            <P>
              When configured as an MCP server in Claude Code or Cursor, Origin intercepts
              agent actions and checks them against your policies before they execute. If an
              action violates a policy, it can be blocked, warned, or flagged.
            </P>

            <H3>Configuration</H3>
            <P>Add Origin as an MCP server in your AI tool&apos;s configuration:</P>

            <CodeBlock title="Claude Code — ~/.claude/claude_desktop_config.json">{`{
  "mcpServers": {
    "origin": {
      "command": "origin",
      "args": ["mcp", "serve"],
      "env": {
        "ORIGIN_API_URL": "http://localhost:4002"
      }
    }
  }
}`}</CodeBlock>

            <CodeBlock title="Cursor — .cursor/mcp.json">{`{
  "mcpServers": {
    "origin": {
      "command": "origin",
      "args": ["mcp", "serve"],
      "env": {
        "ORIGIN_API_URL": "http://localhost:4002"
      }
    }
  }
}`}</CodeBlock>

            <H3>Resources</H3>
            <ul className="space-y-2 mb-4">
              <Li><code className="text-indigo-400">origin://policies</code> &mdash; Active governance policies</Li>
              <Li><code className="text-indigo-400">origin://session</code> &mdash; Current session state and metadata</Li>
            </ul>

            <H3>Tools</H3>
            <ul className="space-y-2 mb-4">
              <Li><code className="text-indigo-400">check_file_access</code> &mdash; Check if a file path is allowed by policies</Li>
              <Li><code className="text-indigo-400">report_violation</code> &mdash; Report a policy violation</Li>
              <Li><code className="text-indigo-400">start_session</code> &mdash; Begin tracking a coding session</Li>
              <Li><code className="text-indigo-400">end_session</code> &mdash; End and finalize a session</Li>
              <Li><code className="text-indigo-400">log_tool_call</code> &mdash; Log a tool invocation during a session</Li>
            </ul>
          </div>
        )}

        {active === 'api' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">API Reference</h1>
            <P>
              Origin exposes a REST API at <code className="text-indigo-400">/api</code>.
              All authenticated endpoints require a Bearer token.
            </P>

            <H3>Authentication</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/auth/login</code>
                </div>
                <P>Login with email and password. Returns JWT token and user object.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/auth/register</code>
                </div>
                <P>Create a new account with org. Returns JWT token and user object.</P>
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
            </div>

            <H3>Sessions</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/sessions</code>
                </div>
                <P>List sessions. Query params: model, status, agentId, repoId, limit, offset.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/sessions/:id</code>
                </div>
                <P>Get a single session with full transcript and review data.</P>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-green text-xs">POST</span>
                  <code className="text-sm text-gray-200">/api/sessions/:id/review</code>
                </div>
                <P>Review a session. Body: <code className="text-indigo-400">{`{ status, note? }`}</code></P>
              </div>
            </div>

            <H3>Agents</H3>
            <div className="space-y-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex gap-2 items-center mb-2">
                  <span className="badge-blue text-xs">GET</span>
                  <code className="text-sm text-gray-200">/api/agents</code>
                </div>
                <P>List all agents for the org.</P>
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
                <P>Add a rule to a policy. Body: <code className="text-indigo-400">{`{ condition, action, severity?, agentId? }`}</code></P>
              </div>
            </div>

            <H3>Stats &amp; Audit</H3>
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
                <P>Audit log entries. Query params: action, limit, offset.</P>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
