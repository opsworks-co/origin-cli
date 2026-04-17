import { CodeBlock, H2, P, Li } from '../shared/Markdown';

export default function CliSessionsSection() {
  return (
    <>
          <div>
            <h1 id="cli-sessions" className="text-2xl font-bold mb-2">CLI Session Tracking</h1>
            <P>
              Origin automatically tracks AI coding sessions via git hooks. Each session captures
              the model, prompts, files changed, cost, tokens, and duration.
            </P>

            <H2>Viewing Sessions</H2>
            <CodeBlock>{`# List recent sessions for current repo
origin sessions

# Show more sessions
origin sessions --limit 50

# Filter by status
origin sessions --status running

# Show only local sessions (not synced to platform)
origin sessions --local

# Show source column (local vs origin)
origin sessions --source

# All repos (global view)
origin sessions --all`}</CodeBlock>

            <H2>Session Details</H2>
            <CodeBlock>{`# View full session detail by ID (first 8 chars)
origin sessions show abc12345`}</CodeBlock>
            <P>
              Shows model, cost, tokens, duration, lines changed, files, branch, commits, and full prompt history.
            </P>

            <H2>Managing Sessions</H2>
            <CodeBlock>{`# End a running session manually
origin sessions end abc12345

# Clean up all stale running sessions
origin sessions clean

# Clean across all repos
origin sessions clean --all`}</CodeBlock>

            <H2>Session Data Storage</H2>
            <P>Sessions are stored in multiple locations depending on mode:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Connected mode</strong> &mdash; Sent to Origin platform via API + stored locally on <code className="text-indigo-400">origin-sessions</code> git branch</Li>
              <Li><strong className="text-gray-200">Standalone mode</strong> &mdash; Stored on <code className="text-indigo-400">origin-sessions</code> git branch + local SQLite DB</Li>
              <Li><strong className="text-gray-200">Active sessions</strong> &mdash; State files in <code className="text-indigo-400">~/.origin/sessions/</code> and <code className="text-indigo-400">.git/origin-session-*</code></Li>
            </ul>
          </div>
    </>
  );
}
