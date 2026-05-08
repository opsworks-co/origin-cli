import React, { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Reusable doc primitives — matches Entire.io manual style                 */
/* ────────────────────────────────────────────────────────────────────────── */

function Code({ children, title }: { children: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg overflow-hidden border border-gray-700/60 my-4 group relative">
      {title && (
        <div className="bg-gray-800/80 px-4 py-2 text-xs text-gray-500 border-b border-gray-700/60 font-mono">
          {title}
        </div>
      )}
      <pre className="bg-[#0d1117] px-4 py-3.5 text-[13px] font-mono text-gray-300 overflow-x-auto leading-relaxed">
        {children}
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(children.trim());
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-xs text-gray-500 hover:text-gray-300 bg-gray-800 border border-gray-700 rounded px-2 py-1"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-blue-800/50 bg-blue-950/20 px-4 py-3 my-4 text-sm text-blue-300/90 flex gap-2.5">
      <span className="text-blue-400 font-bold flex-shrink-0 mt-px">ℹ</span>
      <div>{children}</div>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-4 py-3 my-4 text-sm text-amber-300/90 flex gap-2.5">
      <span className="text-amber-400 font-bold flex-shrink-0 mt-px">!</span>
      <div>{children}</div>
    </div>
  );
}

function FlagTable({ flags }: { flags: { flag: string; description: string }[] }) {
  return (
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm border border-gray-700/60 rounded-lg overflow-hidden">
        <thead>
          <tr className="bg-gray-800/60">
            <th className="text-left px-4 py-2.5 text-gray-400 font-medium border-b border-gray-700/60 w-1/3">Flag</th>
            <th className="text-left px-4 py-2.5 text-gray-400 font-medium border-b border-gray-700/60">Description</th>
          </tr>
        </thead>
        <tbody>
          {flags.map((f, i) => (
            <tr key={i} className={i % 2 === 0 ? 'bg-gray-900/30' : 'bg-gray-800/20'}>
              <td className="px-4 py-2 font-mono text-indigo-400 text-[13px] border-b border-gray-800/40">{f.flag}</td>
              <td className="px-4 py-2 text-gray-400 border-b border-gray-800/40">{f.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Sidebar TOC data                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

interface CmdEntry {
  id: string;
  name: string;
  group: string;
}

const TOC: CmdEntry[] = [
  // Setup
  { id: 'login', name: 'login', group: 'Setup' },
  { id: 'init', name: 'init', group: 'Setup' },
  { id: 'enable', name: 'enable', group: 'Setup' },
  { id: 'disable', name: 'disable', group: 'Setup' },
  { id: 'link', name: 'link', group: 'Setup' },
  { id: 'upgrade', name: 'upgrade', group: 'Setup' },
  { id: 'doctor', name: 'doctor', group: 'Setup' },
  // Sessions
  { id: 'status', name: 'status', group: 'Sessions' },
  { id: 'sessions', name: 'sessions', group: 'Sessions' },
  { id: 'resume', name: 'resume', group: 'Sessions' },
  { id: 'handoff', name: 'handoff', group: 'Sessions' },
  { id: 'snapshot', name: 'snapshot', group: 'Sessions' },
  { id: 'rewind', name: 'rewind', group: 'Sessions' },
  { id: 'reset', name: 'reset', group: 'Sessions' },
  // Attribution & Analysis
  { id: 'blame', name: 'blame', group: 'Attribution & Analysis' },
  { id: 'diff', name: 'diff', group: 'Attribution & Analysis' },
  { id: 'analyze', name: 'analyze', group: 'Attribution & Analysis' },
  { id: 'search', name: 'search', group: 'Attribution & Analysis' },
  { id: 'explain', name: 'explain', group: 'Attribution & Analysis' },
  { id: 'ask', name: 'ask', group: 'Attribution & Analysis' },
  { id: 'prompts', name: 'prompts', group: 'Attribution & Analysis' },
  { id: 'compare', name: 'compare', group: 'Attribution & Analysis' },
  { id: 'backfill', name: 'backfill', group: 'Attribution & Analysis' },
  { id: 'rework', name: 'rework', group: 'Attribution & Analysis' },
  // Reporting
  { id: 'stats', name: 'stats', group: 'Reporting' },
  { id: 'report', name: 'report', group: 'Reporting' },
  { id: 'audit', name: 'audit', group: 'Reporting' },
  { id: 'export', name: 'export', group: 'Reporting' },
  // Review & Governance
  { id: 'review', name: 'review', group: 'Review & Governance' },
  { id: 'review-pr', name: 'review-pr', group: 'Review & Governance' },
  { id: 'intent-review', name: 'intent-review', group: 'Review & Governance' },
  { id: 'verify', name: 'verify', group: 'Review & Governance' },
  { id: 'policies', name: 'policies', group: 'Review & Governance' },
  { id: 'trail', name: 'trail', group: 'Review & Governance' },
  // Utilities
  { id: 'share', name: 'share', group: 'Utilities' },
  { id: 'chat', name: 'chat', group: 'Utilities' },
  { id: 'memory', name: 'memory', group: 'Utilities' },
  { id: 'todo', name: 'todo', group: 'Utilities' },
  { id: 'ignore', name: 'ignore', group: 'Utilities' },
  { id: 'clean', name: 'clean', group: 'Utilities' },
  { id: 'web', name: 'web', group: 'Utilities' },
  { id: 'whoami', name: 'whoami', group: 'Utilities' },
  // Advanced
  { id: 'config', name: 'config', group: 'Advanced' },
  { id: 'sync', name: 'sync', group: 'Advanced' },
  { id: 'mcp', name: 'mcp', group: 'Advanced' },
  { id: 'ci', name: 'ci', group: 'Advanced' },
  { id: 'proxy', name: 'proxy', group: 'Advanced' },
  { id: 'plugin', name: 'plugin', group: 'Advanced' },
  { id: 'db', name: 'db', group: 'Advanced' },
];

/* ────────────────────────────────────────────────────────────────────────── */
/*  Page component                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

export default function CLICommands() {
  const [activeCmd, setActiveCmd] = useState('');

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) setActiveCmd(hash);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setActiveCmd(e.target.id);
            break;
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    );

    TOC.forEach((c) => {
      const el = document.getElementById(c.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const groups = [...new Set(TOC.map((c) => c.group))];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <Helmet>
        <title>CLI Commands | Origin</title>
        <meta name="description" content="Complete reference for all Origin CLI commands." />
      </Helmet>

      <div className="max-w-7xl mx-auto flex">
        {/* ── Sidebar ─────────────────────────────────────────────────── */}
        <nav className="hidden lg:block w-56 flex-shrink-0 sticky top-0 h-screen overflow-y-auto py-10 pr-6 border-r border-gray-800/60">
          <a href="/docs#cli" className="text-xs text-gray-500 hover:text-gray-300 mb-4 block">&larr; Back to Docs</a>
          <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-3">Commands</h3>
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-1.5 px-2">{g}</div>
              {TOC.filter((c) => c.group === g).map((c) => (
                <a
                  key={c.id}
                  href={`#${c.id}`}
                  onClick={() => setActiveCmd(c.id)}
                  className={`block px-2 py-1 text-[13px] font-mono rounded transition-colors ${
                    activeCmd === c.id
                      ? 'text-indigo-400 bg-indigo-500/10'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {c.name}
                </a>
              ))}
            </div>
          ))}
        </nav>

        {/* ── Main content ────────────────────────────────────────────── */}
        <main className="flex-1 min-w-0 px-6 lg:px-12 py-10 max-w-3xl">
          <h1 className="text-3xl font-bold mb-2">Commands</h1>
          <p className="text-gray-500 text-sm mb-10">Complete CLI reference for Origin. Install with{' '}
            <code className="text-indigo-400 text-xs bg-gray-800/60 px-1.5 py-0.5 rounded">npm i -g {typeof window !== 'undefined' ? window.location.origin : 'https://getorigin.io'}/cli/origin-cli-latest.tgz</code>
          </p>

          {/* ── Global flags ───────────── */}
          <div className="mb-12 pb-8 border-b border-gray-800/60">
            <h2 className="text-lg font-semibold text-gray-200 mb-2">Global flags</h2>
            <p className="text-sm text-gray-500 mb-3">These flags work with every command.</p>
            <FlagTable flags={[
              { flag: '--help, -h', description: 'Show help for the command' },
              { flag: '--verbose', description: 'Enable verbose output for debugging' },
              { flag: '--json', description: 'Output results as JSON (where supported)' },
              { flag: '--no-color', description: 'Disable colored output' },
            ]} />
          </div>

          {/* ═══════════════════════════════════════════════════════════ */}
          {/*  SETUP                                                     */}
          {/* ═══════════════════════════════════════════════════════════ */}
          <SectionHeading>Setup</SectionHeading>

          {/* login */}
          <CommandBlock id="login" name="origin login">
            <p className="text-sm text-gray-400 mb-3">
              Authenticate with your Origin account. Credentials are stored at <code className="text-indigo-400">~/.origin/config.json</code>.
            </p>
            <Code>{`origin login`}</Code>
            <FlagTable flags={[
              { flag: '--api-key <key>', description: 'Authenticate with an API key instead of email/password' },
              { flag: '--api-url <url>', description: 'Use a custom Origin server URL' },
            ]} />
          </CommandBlock>

          {/* init */}
          <CommandBlock id="init" name="origin enable">
            <p className="text-sm text-gray-400 mb-3">
              Register the current machine with Origin. Auto-detects installed AI tools (Claude Code, Cursor, Copilot, Gemini, Aider, Windsurf, Cody, etc.) via CLI checks, IDE extension scanning, and MCP config inspection. Installs global hooks so all repos are tracked automatically.
            </p>
            <Code>{`origin enable`}</Code>
            <FlagTable flags={[
              { flag: '--standalone', description: 'Run without the Origin platform. Sessions stay local via git notes and SQLite.' },
              { flag: '--force', description: 'Overwrite existing hooks and re-initialize' },
            ]} />
            <Note>Tools are re-detected on every session start, so newly installed AI tools are picked up automatically.</Note>
          </CommandBlock>

          {/* enable */}
          <CommandBlock id="enable" name="origin enable">
            <p className="text-sm text-gray-400 mb-3">
              Install Origin hooks for a specific repo. Optional if you already ran <code className="text-indigo-400">origin enable</code> (which installs global hooks). Useful for per-repo overrides or agent-specific configuration.
            </p>
            <Code>{`origin enable                     # all detected agents
origin enable --agent claude-code  # specific agent
origin enable --agent cursor
origin enable --agent gemini`}</Code>
            <FlagTable flags={[
              { flag: '--agent <slug>', description: 'Install hooks for a specific AI agent only' },
            ]} />
          </CommandBlock>

          {/* disable */}
          <CommandBlock id="disable" name="origin disable">
            <p className="text-sm text-gray-400 mb-3">
              Remove Origin hooks from an AI coding tool.
            </p>
            <Code>{`origin disable claude-code`}</Code>
            <Warning>This stops session tracking for the specified agent. Existing session data is preserved.</Warning>
          </CommandBlock>

          {/* link */}
          <CommandBlock id="link" name="origin link">
            <p className="text-sm text-gray-400 mb-3">
              Connect a repo to a specific Origin agent. By default, Origin auto-detects the running agent via process detection. Use <code className="text-indigo-400">origin link</code> to manually override. Writes to <code className="text-indigo-400">.origin.json</code>. When linked, the CLI sends the agent slug on session start to receive that agent's system prompt and policies.
            </p>
            <Code>{`origin link claude-code     # Link this repo to "claude-code"
origin link --list          # Show current link
origin link --unlink        # Remove link`}</Code>
            <FlagTable flags={[
              { flag: '--list', description: 'Show the current agent link for this repo' },
              { flag: '--unlink', description: 'Remove the agent link' },
            ]} />
          </CommandBlock>

          {/* upgrade */}
          <CommandBlock id="upgrade" name="origin upgrade">
            <p className="text-sm text-gray-400 mb-3">
              Upgrade the Origin CLI to the latest version. Checks for updates and installs the newest release automatically.
            </p>
            <Code>{`origin upgrade`}</Code>
          </CommandBlock>

          {/* doctor */}
          <CommandBlock id="doctor" name="origin doctor">
            <p className="text-sm text-gray-400 mb-3">
              Diagnose issues with your Origin setup. Checks configuration, hooks, API connectivity, and agent integrations.
            </p>
            <Code>{`origin doctor`}</Code>
            <Note>Run this first when something isn't working. It will identify misconfigured hooks, expired credentials, and missing dependencies.</Note>
          </CommandBlock>

          {/* ═══════════════════════════════════════════════════════════ */}
          {/*  SESSIONS                                                  */}
          {/* ═══════════════════════════════════════════════════════════ */}
          <SectionHeading>Sessions</SectionHeading>

          {/* status */}
          <CommandBlock id="status" name="origin status">
            <p className="text-sm text-gray-400 mb-3">
              Show current connection status, machine info, active session, and server health.
            </p>
            <Code>{`origin status`}</Code>
          </CommandBlock>

          {/* sessions */}
          <CommandBlock id="sessions" name="origin sessions">
            <p className="text-sm text-gray-400 mb-3">
              List and manage AI coding sessions.
            </p>
            <Code>{`origin sessions                   # list recent sessions
origin sessions --limit 20        # show more sessions
origin sessions --status running  # filter by status
origin sessions end <sessionId>   # end a running session`}</Code>
            <FlagTable flags={[
              { flag: '--limit <n>', description: 'Number of sessions to show (default: 10)' },
              { flag: '--status <s>', description: 'Filter by status: running, idle, completed, ended' },
              { flag: '--agent <slug>', description: 'Filter by agent' },
            ]} />
          </CommandBlock>

          {/* resume */}
          <CommandBlock id="resume" name="origin resume">
            <p className="text-sm text-gray-400 mb-3">
              Resume a previous AI coding session. Loads context from the last session on the current or specified branch so the next AI interaction has full history.
            </p>
            <Code>{`origin resume                    # Resume on current branch
origin resume feature/auth       # Resume on specific branch`}</Code>
          </CommandBlock>

          {/* handoff */}
          <CommandBlock id="handoff" name="origin handoff">
            <p className="text-sm text-gray-400 mb-3">
              Cross-agent context handoff. Transfer session context between different AI tools (e.g. from Claude Code to Cursor).
            </p>
            <Code>{`origin handoff create             # Create a handoff bundle
origin handoff apply <id>         # Apply a handoff from another agent`}</Code>
          </CommandBlock>

          {/* snapshot */}
          <CommandBlock id="snapshot" name="origin snapshot">
            <p className="text-sm text-gray-400 mb-3">
              Save and restore working tree snapshots during long AI sessions. Snapshots are stored on shadow branches and don't create commits.
            </p>
            <Code>{`origin snapshot                   # Save snapshot of current working tree
origin snapshot list              # List all snapshots for current session
origin snapshot restore <id>      # Restore to a previous snapshot
origin snapshot clean             # Remove all shadow snapshots`}</Code>
            <FlagTable flags={[
              { flag: 'list', description: 'List all snapshots for the current session' },
              { flag: 'restore <id>', description: 'Restore working tree to a specific snapshot' },
              { flag: 'clean', description: 'Remove all shadow snapshot branches' },
            ]} />
            <Note>Enable auto-snapshots before every file edit with <code className="text-indigo-400">origin config set auto-snapshot true</code>.</Note>
          </CommandBlock>

          {/* rewind */}
          <CommandBlock id="rewind" name="origin rewind">
            <p className="text-sm text-gray-400 mb-3">
              View and restore snapshots (commits) from your current AI session. Lists commits with timestamps, files changed, and model info.
            </p>
            <Code>{`origin rewind                     # list snapshots
origin rewind --to <sha>          # restore to a specific commit`}</Code>
            <FlagTable flags={[
              { flag: '--to <sha>', description: 'Restore working directory to a specific snapshot' },
            ]} />
            <Warning>Rewinding modifies your working directory. Uncommitted changes will be stashed automatically.</Warning>
          </CommandBlock>

          {/* reset */}
          <CommandBlock id="reset" name="origin reset">
            <p className="text-sm text-gray-400 mb-3">
              Clear local session state for this repo. Use when a session gets stuck or state files become corrupted.
            </p>
            <Code>{`origin reset                      # Clear session state
origin reset --force              # Force clear even if session looks active`}</Code>
            <FlagTable flags={[
              { flag: '--force', description: 'Force clear even if a session appears to be running' },
            ]} />
            <Warning>This deletes local session state. Session data already synced to the platform is not affected.</Warning>
          </CommandBlock>

          {/* ═══════════════════════════════════════════════════════════ */}
          {/*  ATTRIBUTION & ANALYSIS                                    */}
          {/* ═══════════════════════════════════════════════════════════ */}
          <SectionHeading>Attribution & Analysis</SectionHeading>

          {/* blame */}
          <CommandBlock id="blame" name="origin blame">
            <p className="text-sm text-gray-400 mb-3">
              Enhanced git blame that shows AI attribution. Identifies which lines were written by AI agents vs humans, with session IDs and prompt context.
            </p>
            <Code>{`origin blame src/auth.ts
origin blame --line 42 src/auth.ts`}</Code>
            <FlagTable flags={[
              { flag: '--line <n>', description: 'Show attribution for a specific line number' },
              { flag: '--format json', description: 'Output as JSON for tooling integration' },
            ]} />
          </CommandBlock>

          {/* diff */}
          <CommandBlock id="diff" name="origin diff">
            <p className="text-sm text-gray-400 mb-3">
              Show diffs with AI attribution metadata. Annotates which changes came from AI sessions and which were human-authored.
            </p>
            <Code>{`origin diff                      # Current uncommitted changes
origin diff HEAD~3               # Last 3 commits
origin diff main..feature        # Branch comparison`}</Code>
          </CommandBlock>

          {/* analyze */}
          <CommandBlock id="analyze" name="origin analyze">
            <p className="text-sm text-gray-400 mb-3">
              Deep analysis of AI coding patterns in the current repository. Shows AI vs human code ratio, model distribution, cost trends, and file-level attribution.
            </p>
            <Code>{`origin analyze`}</Code>
          </CommandBlock>

          {/* search */}
          <CommandBlock id="search" name="origin search">
            <p className="text-sm text-gray-400 mb-3">
              Full-text search across prompts and session content. Find the prompt that introduced specific code or behavior.
            </p>
            <Code>{`origin search "auth"                             # Search all sessions
origin search "auth" --agent claude --from 7d    # Scoped search
origin search "database migration" --limit 5`}</Code>
            <FlagTable flags={[
              { flag: '--agent <slug>', description: 'Filter results to a specific agent' },
              { flag: '--from <duration>', description: 'Look back period (e.g. 7d, 30d, 6m)' },
              { flag: '--limit <n>', description: 'Maximum number of results' },
            ]} />
          </CommandBlock>

          {/* explain */}
          <CommandBlock id="explain" name="origin explain">
            <p className="text-sm text-gray-400 mb-3">
              AI-powered explanation of a session or the current working tree changes. Summarizes what happened, why, and what files were affected.
            </p>
            <Code>{`origin explain                   # Explain current changes
origin explain abc123            # Explain a specific session
origin explain --format json     # Machine-readable output`}</Code>
            <FlagTable flags={[
              { flag: '--format <fmt>', description: 'Output format: text (default), json, markdown' },
            ]} />
          </CommandBlock>

          {/* ask */}
          <CommandBlock id="ask" name="origin ask">
            <p className="text-sm text-gray-400 mb-3">
              Ask questions about your codebase using AI. Searches session history, prompts, and code changes to answer context-aware questions.
            </p>
            <Code>{`origin ask "why was the auth middleware added?"
origin ask "what changed in the last 3 sessions?"`}</Code>
          </CommandBlock>

          {/* prompts */}
          <CommandBlock id="prompts" name="origin prompts">
            <p className="text-sm text-gray-400 mb-3">
              Show the AI prompts that affected a specific file. Traces which prompts led to changes in the given file across all sessions.
            </p>
            <Code>{`origin prompts src/auth.ts`}</Code>
          </CommandBlock>

          {/* compare */}
          <CommandBlock id="compare" name="origin compare">
            <p className="text-sm text-gray-400 mb-3">
              Compare two sessions, branches, or time periods side by side. Shows differences in cost, tokens, lines changed, and model usage.
            </p>
            <Code>{`origin compare abc123 def456            # Compare two sessions
origin compare main feature/auth        # Compare branches`}</Code>
          </CommandBlock>

          {/* backfill */}
          <CommandBlock id="backfill" name="origin backfill">
            <p className="text-sm text-gray-400 mb-3">
              Retroactively tag old commits as AI or human-authored. Scans session history, commit message patterns, and code style heuristics to identify AI-generated commits.
            </p>
            <Code>{`origin backfill                       # Dry-run — shows what it would tag
origin backfill --apply               # Actually write the tags
origin backfill --days 180            # Go back 6 months
origin backfill --min-confidence high # Only tag high-confidence matches`}</Code>
            <FlagTable flags={[
              { flag: '--apply', description: 'Write attribution tags (default is dry-run)' },
              { flag: '--days <n>', description: 'How far back to scan (default: 90)' },
              { flag: '--min-confidence <level>', description: 'Minimum confidence threshold: low, medium, high' },
            ]} />
            <Note>Runs as a dry-run by default. Use <code className="text-indigo-400">--apply</code> to actually write tags.</Note>
          </CommandBlock>

          {/* rework */}
          <CommandBlock id="rework" name="origin rework">
            <p className="text-sm text-gray-400 mb-3">
              Detect AI-generated code that was subsequently reworked by humans. Useful for understanding how much AI code survives review.
            </p>
            <Code>{`origin rework                         # Last 30 days
origin rework --days 90               # Extend the lookback window
origin rework --agent cursor          # Filter by agent`}</Code>
            <FlagTable flags={[
              { flag: '--days <n>', description: 'Lookback window in days (default: 30)' },
              { flag: '--agent <slug>', description: 'Filter by agent' },
            ]} />
          </CommandBlock>

          {/* ═══════════════════════════════════════════════════════════ */}
          {/*  REPORTING                                                 */}
          {/* ═══════════════════════════════════════════════════════════ */}
          <SectionHeading>Reporting</SectionHeading>

          {/* stats */}
          <CommandBlock id="stats" name="origin stats">
            <p className="text-sm text-gray-400 mb-3">
              Show organization-wide statistics: sessions this week, active agents, AI code percentage, costs, and tokens.
            </p>
            <Code>{`origin stats`}</Code>
          </CommandBlock>

          {/* report */}
          <CommandBlock id="report" name="origin report">
            <p className="text-sm text-gray-400 mb-3">
              Generate sprint reports with cost breakdown, agent usage, model distribution, and daily activity trends.
            </p>
            <Code>{`origin report                                   # Default: last 7 days
origin report --range 14d --output sprint.md    # Last 14 days, save to file
origin report --range 30d --format json`}</Code>
            <FlagTable flags={[
              { flag: '--range <duration>', description: 'Time range: 7d, 14d, 30d, 90d (default: 7d)' },
              { flag: '--format <fmt>', description: 'Output format: markdown (default), json, csv' },
              { flag: '--output <path>', description: 'Write to file instead of stdout' },
            ]} />
          </CommandBlock>

          {/* audit */}
          <CommandBlock id="audit" name="origin audit" badge="Team">
            <p className="text-sm text-gray-400 mb-3">
              Generate a compliance audit trail for SOC 2 / ISO 27001 reporting. Filter by date range, author, or agent.
            </p>
            <Code>{`origin audit
origin audit --from 2026-01-01 --format csv --output q1.csv
origin audit --author "Jane" --agent claude --to 2026-03-01`}</Code>
            <FlagTable flags={[
              { flag: '--from <date>', description: 'Start date (ISO 8601)' },
              { flag: '--to <date>', description: 'End date (ISO 8601)' },
              { flag: '--author <name>', description: 'Filter by developer name' },
              { flag: '--agent <slug>', description: 'Filter by agent' },
              { flag: '--format <fmt>', description: 'Output format: text, csv, json' },
              { flag: '--output <path>', description: 'Write to file' },
            ]} />
          </CommandBlock>

          {/* export */}
          <CommandBlock id="export" name="origin export">
            <p className="text-sm text-gray-400 mb-3">
              Export session data in various formats for external analysis or reporting.
            </p>
            <Code>{`origin export --format csv --output sessions.csv
origin export --format json --from 2026-01-01`}</Code>
            <FlagTable flags={[
              { flag: '--format <fmt>', description: 'Output format: json, csv' },
              { flag: '--from <date>', description: 'Export sessions after this date' },
              { flag: '--output <path>', description: 'Write to file' },
            ]} />
          </CommandBlock>

          {/* ═══════════════════════════════════════════════════════════ */}
          {/*  REVIEW & GOVERNANCE                                       */}
          {/* ═══════════════════════════════════════════════════════════ */}
          <SectionHeading>Review & Governance</SectionHeading>

          {/* review */}
          <CommandBlock id="review" name="origin review" badge="Team">
            <p className="text-sm text-gray-400 mb-3">
              Review a coding session from the command line. Approve, reject, or flag sessions with an optional note.
            </p>
            <Code>{`origin review abc123 --approve
origin review abc123 --reject --note "Security concern"
origin review abc123 --flag`}</Code>
            <FlagTable flags={[
              { flag: '--approve', description: 'Approve the session' },
              { flag: '--reject', description: 'Reject the session' },
              { flag: '--flag', description: 'Flag the session for further review' },
              { flag: '--note <text>', description: 'Add a review note' },
            ]} />
          </CommandBlock>

          {/* review-pr */}
          <CommandBlock id="review-pr" name="origin review-pr" badge="Team">
            <p className="text-sm text-gray-400 mb-3">
              Analyze all AI coding sessions behind a GitHub pull request. Shows a summary table with agent, model, cost, tokens, lines changed, and turn count for each session linked to the PR's commits.
            </p>
            <Code>{`origin review-pr https://github.com/org/repo/pull/42

# Output:
# PR #42: Add authentication middleware
# ┌──────────┬──────────┬────────┬────────┬───────┬───────┐
# │ Session  │ Agent    │ Model  │ Cost   │ Turns │ Lines │
# ├──────────┼──────────┼────────┼────────┼───────┼───────┤
# │ abc123   │ claude   │ opus   │ $1.23  │ 7     │ +342  │
# │ def456   │ cursor   │ sonnet │ $0.45  │ 3     │ +89   │
# └──────────┴──────────┴────────┴────────┴───────┴───────┘`}</Code>
          </CommandBlock>

          {/* intent-review */}
          <CommandBlock id="intent-review" name="origin intent-review" badge="Team">
            <p className="text-sm text-gray-400 mb-3">
              Structured intent-based code review. Shows WHY code was written (prompts, reasoning) not just WHAT changed. Includes risk assessment (HIGH/MEDIUM/LOW) based on files touched and test coverage.
            </p>
            <Code>{`origin intent-review                # Review current branch vs main
origin intent-review feature/auth   # Review specific branch
origin intent-review --format json --output review.json`}</Code>
            <FlagTable flags={[
              { flag: '--format <fmt>', description: 'Output format: text, json' },
              { flag: '--output <path>', description: 'Write to file' },
            ]} />
          </CommandBlock>

          {/* verify */}
          <CommandBlock id="verify" name="origin verify">
            <p className="text-sm text-gray-400 mb-3">
              Verify that AI-generated code passes policy checks. Runs all configured policies against the current session or working tree.
            </p>
            <Code>{`origin verify`}</Code>
          </CommandBlock>

          {/* policies */}
          <CommandBlock id="policies" name="origin policies" badge="Team">
            <p className="text-sm text-gray-400 mb-3">
              List all active governance policies from the server.
            </p>
            <Code>{`origin policies`}</Code>
          </CommandBlock>

          {/* trail */}
          <CommandBlock id="trail" name="origin trail" badge="Team">
            <p className="text-sm text-gray-400 mb-3">
              Manage work trails — units of work (features, bug fixes) that span multiple AI sessions. Trails are tied to git branches and automatically link sessions.
            </p>
            <Code>{`origin trail                      # show current trail for this branch
origin trail create <name>        # create a new trail
origin trail list                 # list all trails
origin trail update --status review
origin trail assign <user>        # add a reviewer
origin trail label <label>        # add a label`}</Code>
            <FlagTable flags={[
              { flag: 'create <name>', description: 'Create a new trail' },
              { flag: 'list', description: 'List all trails' },
              { flag: 'update --status <s>', description: 'Update trail status: active, review, done' },
              { flag: 'assign <user>', description: 'Assign a reviewer' },
              { flag: 'label <label>', description: 'Add a label to the trail' },
            ]} />
          </CommandBlock>

          {/* ═══════════════════════════════════════════════════════════ */}
          {/*  UTILITIES                                                 */}
          {/* ═══════════════════════════════════════════════════════════ */}
          <SectionHeading>Utilities</SectionHeading>

          {/* share */}
          <CommandBlock id="share" name="origin share">
            <p className="text-sm text-gray-400 mb-3">
              Create a shareable bundle from a session. Copies a Markdown bundle to clipboard by default. With <code className="text-indigo-400">--public</code>, generates a public URL.
            </p>
            <Code>{`origin share abc123                # Copy as markdown to clipboard
origin share abc123 --prompt 3     # Share specific prompt only
origin share abc123 --output session-bundle.md
origin share abc123 --public       # Generate a public share link`}</Code>
            <FlagTable flags={[
              { flag: '--prompt <n>', description: 'Share a specific prompt by index' },
              { flag: '--output <path>', description: 'Write to file instead of clipboard' },
              { flag: '--public', description: 'Generate a public share link (requires platform connection)' },
            ]} />
          </CommandBlock>

          {/* chat */}
          <CommandBlock id="chat" name="origin chat">
            <p className="text-sm text-gray-400 mb-3">
              Start an interactive AI chat session about your codebase. Maintains context across messages within the chat.
            </p>
            <Code>{`origin chat`}</Code>
          </CommandBlock>

          {/* memory */}
          <CommandBlock id="memory" name="origin memory">
            <p className="text-sm text-gray-400 mb-3">
              Session memory management — accumulated context across sessions. View, search, and manage persistent knowledge the AI has gathered about your codebase.
            </p>
            <Code>{`origin memory show                # Show current memory
origin memory search "auth"       # Search memory entries
origin memory clear               # Clear accumulated memory`}</Code>
            <FlagTable flags={[
              { flag: 'show', description: 'Display current accumulated memory' },
              { flag: 'search <query>', description: 'Search memory entries' },
              { flag: 'clear', description: 'Clear all accumulated memory' },
            ]} />
          </CommandBlock>

          {/* todo */}
          <CommandBlock id="todo" name="origin todo">
            <p className="text-sm text-gray-400 mb-3">
              AI-extracted TODO tracker across sessions. Automatically identifies and tracks TODOs, FIXMEs, and action items from AI coding sessions.
            </p>
            <Code>{`origin todo                       # List active TODOs
origin todo done <id>             # Mark a TODO as complete
origin todo clear                 # Clear completed TODOs`}</Code>
          </CommandBlock>

          {/* ignore */}
          <CommandBlock id="ignore" name="origin ignore">
            <p className="text-sm text-gray-400 mb-3">
              Manage file ignore patterns for Origin tracking. Similar to .gitignore but for AI session tracking.
            </p>
            <Code>{`origin ignore add "*.log"          # Ignore log files
origin ignore add "node_modules"   # Ignore directories
origin ignore list                # Show current ignore patterns
origin ignore remove "*.log"       # Remove a pattern`}</Code>
          </CommandBlock>

          {/* clean */}
          <CommandBlock id="clean" name="origin clean">
            <p className="text-sm text-gray-400 mb-3">
              Remove orphaned branches, stale sessions, and temp files created by Origin.
            </p>
            <Code>{`origin clean                      # Show what would be cleaned
origin clean --force              # Clean without confirmation`}</Code>
            <FlagTable flags={[
              { flag: '--force', description: 'Skip confirmation prompt' },
            ]} />
            <Warning>This deletes session data and shadow branches. Data already synced to the platform is not affected.</Warning>
          </CommandBlock>

          {/* web */}
          <CommandBlock id="web" name="origin web">
            <p className="text-sm text-gray-400 mb-3">
              Launch a local web dashboard in the browser. Shows AI attribution, sessions, and prompts from local data.
            </p>
            <Code>{`origin web                        # Launch on default port 3141
origin web --port 8080            # Custom port`}</Code>
            <FlagTable flags={[
              { flag: '--port <n>', description: 'Port to run the local dashboard on (default: 3141)' },
            ]} />
          </CommandBlock>

          {/* whoami */}
          <CommandBlock id="whoami" name="origin whoami">
            <p className="text-sm text-gray-400 mb-3">
              Show the currently authenticated user and organization.
            </p>
            <Code>{`origin whoami`}</Code>
          </CommandBlock>

          {/* ═══════════════════════════════════════════════════════════ */}
          {/*  ADVANCED                                                  */}
          {/* ═══════════════════════════════════════════════════════════ */}
          <SectionHeading>Advanced</SectionHeading>

          {/* config */}
          <CommandBlock id="config" name="origin config">
            <p className="text-sm text-gray-400 mb-3">
              Manage CLI configuration. Settings are stored at <code className="text-indigo-400">~/.origin/config.json</code>.
            </p>
            <Code>{`origin config set apiKey <key>
origin config set api-url <url>
origin config set mode <auto|standalone>
origin config set snapshot-repo <url>
origin config set auto-snapshot true`}</Code>
            <FlagTable flags={[
              { flag: 'set <key> <value>', description: 'Set a configuration value' },
              { flag: 'get <key>', description: 'Get a configuration value' },
              { flag: 'list', description: 'Show all configuration values' },
              { flag: '--local', description: 'Write settings to .origin/settings.local.json (per-repo)' },
            ]} />
          </CommandBlock>

          {/* sync */}
          <CommandBlock id="sync" name="origin sync">
            <p className="text-sm text-gray-400 mb-3">
              Sync all repositories in the current directory. Discovers snapshots and uploads session data.
            </p>
            <Code>{`origin sync`}</Code>
          </CommandBlock>

          {/* mcp */}
          <CommandBlock id="mcp" name="origin mcp serve">
            <p className="text-sm text-gray-400 mb-3">
              Start the MCP server for real-time policy enforcement. Usually configured as an MCP server in AI tools rather than run directly.
            </p>
            <Code>{`origin mcp serve`}</Code>
            <Note>
              Most users configure this in their AI tool's MCP settings (e.g. Claude Code's <code className="text-indigo-400">claude_desktop_config.json</code>) rather than running it manually.
            </Note>
          </CommandBlock>

          {/* ci */}
          <CommandBlock id="ci" name="origin ci">
            <p className="text-sm text-gray-400 mb-3">
              CI/CD integration for AI attribution. Generate CI configs and run attribution checks in pipelines.
            </p>
            <Code>{`origin ci init                    # Generate CI config file
origin ci check                   # Run attribution check (for CI)
origin ci report                  # Generate CI attribution report`}</Code>
            <FlagTable flags={[
              { flag: 'init', description: 'Generate a CI config file (.github/workflows/origin.yml)' },
              { flag: 'check', description: 'Run attribution check (exit 1 on policy violations)' },
              { flag: 'report', description: 'Generate an attribution report for CI artifacts' },
            ]} />
          </CommandBlock>

          {/* proxy */}
          <CommandBlock id="proxy" name="origin proxy">
            <p className="text-sm text-gray-400 mb-3">
              Transparent git proxy for attribution tracking. Intercepts git operations to automatically capture AI session context.
            </p>
            <Code>{`origin proxy start                # Start the git proxy
origin proxy stop                 # Stop the proxy
origin proxy status               # Check proxy status`}</Code>
          </CommandBlock>

          {/* plugin */}
          <CommandBlock id="plugin" name="origin plugin">
            <p className="text-sm text-gray-400 mb-3">
              External agent plugin management. Install and manage plugins for additional AI tool integrations.
            </p>
            <Code>{`origin plugin list                 # List installed plugins
origin plugin install <name>      # Install a plugin
origin plugin remove <name>       # Remove a plugin`}</Code>
          </CommandBlock>

          {/* db */}
          <CommandBlock id="db" name="origin db">
            <p className="text-sm text-gray-400 mb-3">
              Local prompt database management. Import, query, and maintain the local SQLite database of session data.
            </p>
            <Code>{`origin db import                  # Import from origin-sessions branch
origin db stats                   # Show database statistics`}</Code>
            <FlagTable flags={[
              { flag: 'import', description: 'Import session data from the origin-sessions git branch' },
              { flag: 'stats', description: 'Show database size and record counts' },
            ]} />
          </CommandBlock>

          <div className="h-24" />
        </main>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Sub-components                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xl font-bold text-gray-100 mt-14 mb-6 pb-2 border-b border-gray-800/60">
      {children}
    </h2>
  );
}

function CommandBlock({
  id,
  name,
  badge,
  children,
}: {
  id: string;
  name: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-10 scroll-mt-20">
      <div className="flex items-center gap-3 mb-2">
        <h3 className="text-lg font-semibold font-mono text-gray-100">{name}</h3>
        {badge && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            {badge}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}
