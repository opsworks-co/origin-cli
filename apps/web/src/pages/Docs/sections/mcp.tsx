import { CodeBlock, H2, H3, P, Li, Callout } from '../shared/Markdown';

export default function McpSection() {
  return (
    <>
          <div>
            <h1 id="mcp" className="text-2xl font-bold mb-2">MCP Server</h1>
            <P>
              The Origin MCP (Model Context Protocol) server provides real-time policy
              enforcement for AI coding agents. It runs as a sidecar process alongside
              your AI tool.
            </P>

            <H2>How It Works</H2>
            <P>
              When configured as an MCP server in Claude Code or Cursor, Origin intercepts
              agent actions and checks them against your policies before they execute. If an
              action violates a policy, it can be blocked, warned, or flagged.
            </P>

            <H2>Configuration</H2>
            <P>Add Origin as an MCP server in your AI tool&apos;s configuration:</P>

            <CodeBlock title="Claude Code — ~/.claude/claude_desktop_config.json">{`{
  "mcpServers": {
    "origin": {
      "command": "origin",
      "args": ["mcp", "serve"],
      "env": {
        "ORIGIN_API_URL": "https://your-origin-instance.com"
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
        "ORIGIN_API_URL": "https://your-origin-instance.com"
      }
    }
  }
}`}</CodeBlock>

            <Callout type="info">
              Replace the URL with your Origin instance address. For local development, use <code className="text-indigo-400">http://localhost:4002</code>.
              For production, use your Fly.io URL (e.g. <code className="text-indigo-400">https://getorigin.io</code>).
            </Callout>

            <H3>Prerequisites</H3>
            <ul className="space-y-2 mb-4">
              <Li>Origin CLI installed globally (<code className="text-indigo-400">npm i -g ${window.location.origin}/cli/origin-cli-latest.tgz</code>)</Li>
              <Li>Authenticated via <code className="text-indigo-400">origin login</code></Li>
              <Li>Machine registered via <code className="text-indigo-400">origin init</code></Li>
            </ul>

            <H3>Resources</H3>
            <ul className="space-y-2 mb-4">
              <Li><code className="text-indigo-400">origin://policies</code> &mdash; Active governance policies</Li>
              <Li><code className="text-indigo-400">origin://session</code> &mdash; Current session state and metadata</Li>
            </ul>

            <H3>Tools (17 total)</H3>
            <ul className="space-y-2 mb-4">
              <Li><code className="text-indigo-400">check_file_access</code> &mdash; Check if a file path is allowed by policies</Li>
              <Li><code className="text-indigo-400">report_violation</code> &mdash; Report a policy violation</Li>
              <Li><code className="text-indigo-400">start_session</code> &mdash; Begin tracking a coding session</Li>
              <Li><code className="text-indigo-400">end_session</code> &mdash; End and finalize a session</Li>
              <Li><code className="text-indigo-400">log_tool_call</code> &mdash; Log a tool invocation during a session</Li>
              <Li><code className="text-indigo-400">list_sessions</code> &mdash; List sessions with filters (status, model)</Li>
              <Li><code className="text-indigo-400">get_session</code> &mdash; Get full session details including transcript and diff</Li>
              <Li><code className="text-indigo-400">review_session</code> &mdash; Approve, reject, or flag a session</Li>
              <Li><code className="text-indigo-400">list_agents</code> &mdash; List all registered agents</Li>
              <Li><code className="text-indigo-400">list_repos</code> &mdash; List connected repositories</Li>
              <Li><code className="text-indigo-400">get_stats</code> &mdash; Dashboard stats (sessions, costs, agents)</Li>
              <Li><code className="text-indigo-400">get_audit_log</code> &mdash; Audit log with filtering</Li>
              <Li><code className="text-indigo-400">get_policy_versions</code> &mdash; Policy version history</Li>
              <Li><code className="text-indigo-400">get_agent_versions</code> &mdash; Agent version history</Li>
              <Li><code className="text-indigo-400">list_notifications</code> &mdash; User notifications</Li>
              <Li><code className="text-indigo-400">list_users</code> &mdash; Team members with activity stats</Li>
            </ul>
          </div>
    </>
  );
}
