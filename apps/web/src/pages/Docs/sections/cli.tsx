import { CodeBlock, H3, P } from '../shared/Markdown';

export default function CliSection() {
  return (
    <>
          <div>
            <h1 id="cli" className="text-2xl font-bold mb-2">CLI Reference</h1>
            <P>
              The Origin CLI connects developer machines to the Origin platform.
            </P>

            <H3 id="cli-installation">Installation</H3>
            <CodeBlock>{`npm i -g ${window.location.origin}/cli/origin-cli-latest.tgz`}</CodeBlock>

            <H3 id="cli-commands">Commands</H3>

            <div className="space-y-4 mt-4">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin login</code>
                <P>Authenticate with your Origin account. Enter your email and password (or API key) to get credentials stored at <code className="text-indigo-400">~/.origin/config.json</code>.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin init</code>
                <P>Register the current machine with Origin. Auto-detects installed AI tools (Claude Code, Cursor, Copilot, Gemini, Aider, Windsurf, Cody, etc.) via CLI checks, IDE extension scanning, and MCP config inspection. Installs global hooks so all repos are tracked automatically. Tools are re-detected on every session start.</P>
                <P>Use <code className="text-indigo-400">origin init --standalone</code> to run without the Origin platform. Sessions are tracked locally via git notes and a local database &mdash; no API key or server needed. You can also switch anytime with <code className="text-indigo-400">origin config set mode standalone</code>. To reconnect later, run <code className="text-indigo-400">origin login</code> followed by <code className="text-indigo-400">origin init</code>.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin status</code>
                <P>Show current connection status, machine info, and server health.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin policies</code>
                <span className="ml-2 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">Team</span>
                <P>List all active governance policies from the server.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin sync</code>
                <P>Sync all repositories in the current directory. Discovers <code className="text-indigo-400">.entire/</code> checkpoints and uploads session data.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin sessions</code>
                <P>List and manage AI coding sessions.</P>
                <CodeBlock>{`origin sessions                  # list recent sessions
origin sessions --limit 20       # show more sessions
origin sessions --status running # filter by status
origin sessions end <sessionId>  # end a running session`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin whoami</code>
                <P>Show the currently authenticated user and organization.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin enable</code>
                <P>Install Origin hooks for a specific repo (optional &mdash; <code className="text-indigo-400">origin init</code> already installs global hooks). Useful for per-repo overrides or agent-specific configuration.</P>
                <CodeBlock>{`origin enable                    # all detected agents
origin enable --agent claude-code  # specific agent
origin enable --agent cursor
origin enable --agent gemini`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin disable</code>
                <P>Remove Origin hooks from an AI coding tool.</P>
                <CodeBlock>{`origin disable claude-code`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin link</code>
                <P>Connect a repo to a specific Origin agent. By default, Origin auto-detects the running agent via process detection. Use <code className="text-indigo-400">origin link &lt;slug&gt;</code> to manually link a repo (writes to <code className="text-indigo-400">.origin.json</code>). When linked, the CLI sends the agent slug on session start to receive that agent&apos;s system prompt and policies.</P>
                <CodeBlock>{`origin link claude-code    # Link this repo to "claude-code" agent
origin link --list         # Show current link
origin link --unlink       # Remove link`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin agents</code>
                <P>List and manage registered AI agents. Shows agent name, model, status, and session count.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin repos</code>
                <P>List connected repositories with session counts.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin review &lt;sessionId&gt;</code>
                <span className="ml-2 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">Team</span>
                <P>Review a coding session from the command line. Approve, reject, or flag sessions with an optional note.</P>
                <CodeBlock>{`origin review abc123 --approve
origin review abc123 --reject --note "Security concern"
origin review abc123 --flag`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin intent-review</code>
                <span className="ml-2 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">Team</span>
                <P>Structured intent-based code review. Shows WHY code was written (prompts, reasoning) not just WHAT changed. Includes risk assessment (HIGH/MEDIUM/LOW) based on files touched and test coverage.</P>
                <CodeBlock>{`origin intent-review               # Review current branch vs main
origin intent-review feature/auth  # Review specific branch
origin intent-review --format json --output review.json`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin stats</code>
                <P>Show organization-wide statistics: sessions this week, active agents, AI code percentage, costs, and tokens.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin audit</code>
                <span className="ml-2 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">Team</span>
                <P>Generate a compliance audit trail for SOC 2 / ISO 27001 reporting. Filter by date range, author, or agent.</P>
                <CodeBlock>{`origin audit
origin audit --from 2026-01-01 --format csv --output q1.csv
origin audit --author "Jane" --agent claude --to 2026-03-01`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin backfill</code>
                <P>Retroactively tag old commits as AI or human-authored. Scans session history, commit message patterns, and code style heuristics to identify AI-generated commits.</P>
                <CodeBlock>{`origin backfill                      # Dry-run — shows what it would tag
origin backfill --apply              # Actually write the tags
origin backfill --days 180           # Go back 6 months
origin backfill --min-confidence high # Only tag high-confidence matches`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin rework</code>
                <P>Detect AI-generated code that was subsequently reworked by humans. Useful for understanding how much AI code survives review.</P>
                <CodeBlock>{`origin rework                        # Show reworked AI code in the last 30 days
origin rework --days 90              # Extend the lookback window
origin rework --agent cursor         # Filter by agent`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin snapshot</code>
                <P>Save and restore working tree snapshots during long AI sessions. Snapshots are stored on shadow branches and don&apos;t create commits. Enable auto-snapshots before every file edit with <code className="text-indigo-400">origin config set auto-snapshot true</code>.</P>
                <CodeBlock>{`origin snapshot                    # Save snapshot of current working tree
origin snapshot list               # List all snapshots for current session
origin snapshot restore <id>       # Restore to a previous snapshot
origin snapshot clean              # Remove all shadow snapshots`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin report</code>
                <P>Generate sprint reports with cost breakdown, agent usage, model distribution, and daily activity trends.</P>
                <CodeBlock>{`origin report                                  # Default: last 7 days, markdown
origin report --range 14d --output sprint.md   # Last 14 days, save to file
origin report --range 30d --format json`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin search &lt;query&gt;</code>
                <P>Full-text search across prompts and session content. Find the prompt that introduced specific code or behavior.</P>
                <CodeBlock>{`origin search "auth"                            # Search all sessions
origin search "auth" --agent claude --from 7d   # Scoped search
origin search "database migration" --limit 5`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin mcp serve</code>
                <P>Start the MCP server for real-time policy enforcement. Usually configured as an MCP server in AI tools rather than run directly.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin upgrade</code>
                <P>Upgrade the Origin CLI to the latest version. Checks for updates and installs the newest release automatically.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin trail</code>
                <span className="ml-2 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">Team</span>
                <P>Manage work trails &mdash; units of work (features, bug fixes) that span multiple AI sessions. Trails are tied to git branches and automatically link sessions.</P>
                <CodeBlock>{`origin trail                     # show current trail for this branch
origin trail create <name>       # create a new trail
origin trail list                # list all trails
origin trail update --status review  # update trail status
origin trail assign <user>       # add a reviewer
origin trail label <label>       # add a label`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin review-pr &lt;pr-url&gt;</code>
                <span className="ml-2 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">Team</span>
                <P>Analyze all AI coding sessions behind a GitHub pull request. Shows a summary table with agent, model, cost, tokens, lines changed, and turn count for each session linked to the PR&apos;s commits.</P>
                <CodeBlock>{`origin review-pr https://github.com/org/repo/pull/42

# Output:
# PR #42: Add authentication middleware
# ┌──────────┬──────────┬────────┬────────┬───────┬───────┐
# │ Session  │ Agent    │ Model  │ Cost   │ Turns │ Lines │
# ├──────────┼──────────┼────────┼────────┼───────┼───────┤
# │ abc123   │ claude   │ opus   │ $1.23  │ 7     │ +342  │
# │ def456   │ cursor   │ sonnet │ $0.45  │ 3     │ +89   │
# └──────────┴──────────┴────────┴────────┴───────┴───────┘`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin share &lt;sessionId&gt;</code>
                <P>Create a shareable bundle from a session. By default copies a Markdown bundle to clipboard. With <code className="text-indigo-400">--public</code>, generates a public URL on the Origin platform that anyone can view.</P>
                <CodeBlock>{`# Copy session as markdown to clipboard
origin share abc123

# Share specific prompt only
origin share abc123 --prompt 3

# Write to file
origin share abc123 --output session-bundle.md

# Generate a public share link (requires platform connection)
origin share abc123 --public
# → https://getorigin.io/s/k7x9m2p4`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin rewind</code>
                <P>View and restore checkpoints (commits) from your current AI session. Lists commits with timestamps, files changed, and model info. Optionally rewind your working directory to a specific checkpoint.</P>
                <CodeBlock>{`origin rewind                    # list checkpoints interactively
origin rewind --to <sha>         # restore to a specific commit`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin doctor</code>
                <P>Diagnose issues with your Origin setup. Checks configuration, hooks, API connectivity, and agent integrations.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin config set checkpoint-repo</code>
                <P>Store session data in a separate git repository. Useful when your codebase is public but session data is private, or when centralizing sessions across multiple repos.</P>
                <CodeBlock>{`origin config set checkpoint-repo https://github.com/org/sessions-repo.git`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin config set mode</code>
                <P>Force the CLI operating mode. Values: <code className="text-indigo-400">auto</code> (default) or <code className="text-indigo-400">standalone</code>. Standalone skips all API calls &mdash; everything stays local.</P>
                <CodeBlock>{`origin config set mode standalone`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin web</code>
                <P>Launch a local web dashboard in the browser. Shows AI attribution, sessions, and prompts from local data.</P>
                <CodeBlock>{`origin web                # Launch on default port 3141
origin web --port 8080    # Custom port`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin explain [sessionId]</code>
                <P>AI-powered explanation of a session or the current working tree changes. Summarizes what happened, why, and what files were affected.</P>
                <CodeBlock>{`origin explain                  # Explain current changes
origin explain abc123           # Explain a specific session
origin explain --format json    # Machine-readable output`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin ask &lt;query&gt;</code>
                <P>Ask questions about your codebase using AI. Searches session history, prompts, and code changes to answer context-aware questions.</P>
                <CodeBlock>{`origin ask "why was the auth middleware added?"
origin ask "what changed in the last 3 sessions?"`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin chat</code>
                <P>Start an interactive AI chat session about your codebase. Maintains context across messages within the chat.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin prompts &lt;file&gt;</code>
                <P>Show the AI prompts that affected a specific file. Traces which prompts led to changes in the given file across all sessions.</P>
                <CodeBlock>{`origin prompts src/auth.ts`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin blame &lt;file&gt;</code>
                <P>Enhanced git blame that shows AI attribution. Identifies which lines were written by AI agents vs humans, with session IDs and prompt context.</P>
                <CodeBlock>{`origin blame src/auth.ts
origin blame --line 42 src/auth.ts`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin diff [range]</code>
                <P>Show diffs with AI attribution metadata. Annotates which changes came from AI sessions and which were human-authored.</P>
                <CodeBlock>{`origin diff                     # Current uncommitted changes
origin diff HEAD~3              # Last 3 commits
origin diff main..feature       # Branch comparison`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin verify</code>
                <P>Verify that AI-generated code passes policy checks. Runs all configured policies against the current session or working tree.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin analyze</code>
                <P>Deep analysis of AI coding patterns in the current repository. Shows AI vs human code ratio, model distribution, cost trends, and file-level attribution.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin compare &lt;arg1&gt; [arg2]</code>
                <P>Compare two sessions, branches, or time periods side by side. Shows differences in cost, tokens, lines changed, and model usage.</P>
                <CodeBlock>{`origin compare abc123 def456           # Compare two sessions
origin compare main feature/auth       # Compare branches`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin export</code>
                <P>Export session data in various formats for external analysis or reporting.</P>
                <CodeBlock>{`origin export --format csv --output sessions.csv
origin export --format json --from 2026-01-01`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin resume [branch]</code>
                <P>Resume a previous AI coding session. Loads context from the last session on the current or specified branch so the next AI interaction has full history.</P>
                <CodeBlock>{`origin resume                   # Resume on current branch
origin resume feature/auth      # Resume on specific branch`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin handoff</code>
                <P>Cross-agent context handoff. Transfer session context between different AI tools (e.g. from Claude Code to Cursor).</P>
                <CodeBlock>{`origin handoff create            # Create a handoff bundle
origin handoff apply <id>        # Apply a handoff from another agent`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin memory</code>
                <P>Session memory management &mdash; accumulated context across sessions. View, search, and manage persistent knowledge the AI has gathered about your codebase.</P>
                <CodeBlock>{`origin memory show               # Show current memory
origin memory search "auth"      # Search memory entries
origin memory clear              # Clear accumulated memory`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin todo</code>
                <P>AI-extracted TODO tracker across sessions. Automatically identifies and tracks TODOs, FIXMEs, and action items from AI coding sessions.</P>
                <CodeBlock>{`origin todo                      # List active TODOs
origin todo done <id>            # Mark a TODO as complete
origin todo clear                # Clear completed TODOs`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin ignore</code>
                <P>Manage file ignore patterns for Origin tracking. Similar to .gitignore but for AI session tracking.</P>
                <CodeBlock>{`origin ignore add "*.log"         # Ignore log files
origin ignore add "node_modules"  # Ignore directories
origin ignore list               # Show current ignore patterns
origin ignore remove "*.log"      # Remove a pattern`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin clean</code>
                <P>Remove orphaned branches, stale sessions, and temp files created by Origin.</P>
                <CodeBlock>{`origin clean                     # Show what would be cleaned
origin clean --force             # Clean without confirmation`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin ci</code>
                <P>CI/CD integration for AI attribution. Generate CI configs and run attribution checks in pipelines.</P>
                <CodeBlock>{`origin ci init                   # Generate CI config file
origin ci check                  # Run attribution check (for CI)
origin ci report                 # Generate CI attribution report`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin db</code>
                <P>Local prompt database management. Import, query, and maintain the local SQLite database of session data.</P>
                <CodeBlock>{`origin db import                 # Import from origin-sessions branch
origin db stats                  # Show database statistics`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin proxy</code>
                <P>Transparent git proxy for attribution tracking. Intercepts git operations to automatically capture AI session context.</P>
                <CodeBlock>{`origin proxy start               # Start the git proxy
origin proxy stop                # Stop the proxy
origin proxy status              # Check proxy status`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin plugin</code>
                <P>External agent plugin management. Install and manage plugins for additional AI tool integrations.</P>
                <CodeBlock>{`origin plugin list                # List installed plugins
origin plugin install <name>     # Install a plugin
origin plugin remove <name>      # Remove a plugin`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin session-compare &lt;id1&gt; &lt;id2&gt;</code>
                <P>Side-by-side comparison of two sessions. Shows differences in prompts, files changed, cost, tokens, and outcomes.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin reset</code>
                <P>Clear local session state for this repo. Use when a session gets stuck or state files become corrupted.</P>
                <CodeBlock>{`origin reset                     # Clear session state
origin reset --force             # Force clear even if session looks active`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin notifications</code>
                <P>View and manage notification preferences. Control which events trigger alerts (violations, reviews, budget thresholds).</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin team</code>
                <P>View team members, roles, and activity. Manage team composition from the command line.</P>
              </div>
            </div>
          </div>
    </>
  );
}
