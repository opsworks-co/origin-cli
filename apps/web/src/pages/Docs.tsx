import React, { useState, useEffect } from 'react';
import ChatWidget from '../components/ChatWidget';

type Section =
  | 'overview'
  | 'workflow'
  | 'integrations'
  | 'gitlab-integration'
  | 'session-tracking'
  | 'repos'
  | 'sessions'
  | 'agents'
  | 'policies'
  | 'settings'
  | 'dashboard'
  | 'cli'
  | 'mcp'
  | 'webhooks'
  | 'rbac'
  | 'api'
  | 'ai-review'
  | 'budget'
  | 'realtime'
  | 'secret-scanning'
  | 'compliance'
  | 'analytics'
  | 'ai-blame'
  | 'ask-author'
  | 'git-notes'
  | 'personal-insights'
  | 'leaderboard'
  | 'pull-requests'
  | 'trails'
  | 'prompts'
  | 'model-comparison'
  | 'machines';

const SECTIONS: { key: Section; label: string; group?: string }[] = [
  { key: 'overview', label: 'Overview', group: 'Getting Started' },
  { key: 'workflow', label: 'How It Works' },
  { key: 'session-tracking', label: 'Session Tracking', group: 'Setup Guides' },
  { key: 'integrations', label: 'GitHub Integration' },
  { key: 'gitlab-integration', label: 'GitLab Integration' },
  { key: 'repos', label: 'Repositories' },
  { key: 'agents', label: 'Agents' },
  { key: 'policies', label: 'Policies' },
  { key: 'settings', label: 'Settings & API Keys' },
  { key: 'rbac', label: 'Team & Roles' },
  { key: 'dashboard', label: 'Dashboard', group: 'Features' },
  { key: 'sessions', label: 'Sessions & Reviews' },
  { key: 'ai-blame', label: 'AI Blame' },
  { key: 'ask-author', label: 'Ask the Author' },
  { key: 'git-notes', label: 'Git Notes' },
  { key: 'ai-review', label: 'AI Auto-Review' },
  { key: 'budget', label: 'Budget & Cost Controls' },
  { key: 'realtime', label: 'Real-Time Streaming' },
  { key: 'secret-scanning', label: 'Secret & PII Scanning' },
  { key: 'compliance', label: 'Compliance Reports' },
  { key: 'analytics', label: 'Enhanced Analytics' },
  { key: 'leaderboard', label: 'Leaderboard' },
  { key: 'prompts', label: 'Prompt Library' },
  { key: 'model-comparison', label: 'Model Comparison' },
  { key: 'pull-requests', label: 'Pull Requests' },
  { key: 'trails', label: 'Trails' },
  { key: 'machines', label: 'Machines' },
  { key: 'personal-insights', label: 'Personal Insights' },
  { key: 'webhooks', label: 'Webhooks' },
  { key: 'cli', label: 'CLI Reference', group: 'Developer Tools' },
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

function H2({ children, id }: { children: React.ReactNode; id?: string }) {
  return <h2 id={id} className="text-xl font-bold text-gray-100 mt-8 mb-3">{children}</h2>;
}

function H3({ children, id }: { children: React.ReactNode; id?: string }) {
  return <h3 id={id} className="text-lg font-semibold text-gray-200 mt-6 mb-2">{children}</h3>;
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

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 mb-6">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center text-indigo-400 font-bold text-sm">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="font-semibold text-gray-200 mb-1">{title}</h4>
        <div className="text-sm text-gray-400 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function Callout({ type, children }: { type: 'info' | 'warning' | 'tip'; children: React.ReactNode }) {
  const styles = {
    info: 'bg-blue-900/20 border-blue-800 text-blue-300',
    warning: 'bg-amber-900/20 border-amber-800 text-amber-300',
    tip: 'bg-green-900/20 border-green-800 text-green-300',
  };
  const icons = { info: 'i', warning: '!', tip: '*' };
  return (
    <div className={`rounded-lg border px-4 py-3 my-4 text-sm ${styles[type]}`}>
      <span className="font-bold mr-2">{icons[type]}</span>
      {children}
    </div>
  );
}

export default function Docs() {
  const [active, setActive] = useState<Section>('overview');

  useEffect(() => {
    if (window.location.hash) {
      const hash = window.location.hash.slice(1);
      // Check if hash matches a section key for sidebar navigation
      const matchedSection = SECTIONS.find((s) => s.key === hash);
      if (matchedSection) {
        setActive(matchedSection.key);
      }
      // Scroll to the element after a short delay to allow render
      setTimeout(() => {
        const el = document.getElementById(hash);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }, []);

  let lastGroup = '';

  return (
    <>
    <div className="max-w-6xl mx-auto px-6 py-8">
    <div className="flex gap-8">
      {/* Sidebar TOC */}
      <nav className="hidden lg:block w-48 flex-shrink-0 sticky top-20 self-start">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Documentation
        </p>
        <div className="space-y-0.5">
          {SECTIONS.map((s) => {
            const showGroup = s.group && s.group !== lastGroup;
            if (s.group) lastGroup = s.group;
            return (
              <React.Fragment key={s.key}>
                {showGroup && (
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider pt-4 pb-1 px-3">
                    {s.group}
                  </p>
                )}
                <button
                  onClick={() => { setActive(s.key); window.history.replaceState(null, '', `#${s.key}`); }}
                  className={`block w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    active === s.key
                      ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                      : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                  }`}
                >
                  {s.label}
                </button>
              </React.Fragment>
            );
          })}
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

        {/* ─── OVERVIEW ────────────────────────────────────────── */}
        {active === 'overview' && (
          <div>
            <h1 id="overview" className="text-2xl font-bold mb-2">Origin Documentation</h1>
            <P>
              Origin is the governance platform for AI-authored code. It gives engineering
              leaders full visibility into what AI agents are writing, enforces policies
              around agent behavior, and provides complete audit trails for compliance.
            </P>

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
        )}

        {/* ─── HOW IT WORKS ────────────────────────────────────── */}
        {active === 'workflow' && (
          <div>
            <h1 id="workflow" className="text-2xl font-bold mb-2">How Origin Works</h1>
            <P>
              Developer codes with AI &rarr; Origin captures everything &rarr; Policies evaluate &rarr;
              Team reviews &rarr; PR gets approved or blocked.
            </P>

            <H2>1. Admin setup (one-time, in the web UI)</H2>
            <ul className="space-y-2 mb-4">
              <Li>Admin creates an org, connects GitHub or GitLab (PAT, GitHub App, or GitLab OAuth) in Settings &rarr; Integrations</Li>
              <Li>Import repos from GitHub or GitLab &mdash; auto-creates webhooks on each repo</Li>
              <Li><strong className="text-gray-200">Register agents</strong> &mdash; go to Agents page and create one agent per AI tool (Claude Code, Cursor, Codex, Gemini, etc.). Use the correct slug:</Li>
            </ul>
            <div className="ml-8 mb-4">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-gray-700"><th className="px-3 py-2 text-left text-gray-400">Tool</th><th className="px-3 py-2 text-left text-gray-400">Slug (must match exactly)</th></tr></thead>
                <tbody className="text-gray-300">
                  <tr className="border-b border-gray-800"><td className="px-3 py-2">Claude Code</td><td className="px-3 py-2"><code className="text-indigo-400">claude-code</code></td></tr>
                  <tr className="border-b border-gray-800"><td className="px-3 py-2">Cursor</td><td className="px-3 py-2"><code className="text-indigo-400">cursor</code></td></tr>
                  <tr className="border-b border-gray-800"><td className="px-3 py-2">OpenAI Codex CLI</td><td className="px-3 py-2"><code className="text-indigo-400">codex</code></td></tr>
                  <tr className="border-b border-gray-800"><td className="px-3 py-2">Gemini CLI</td><td className="px-3 py-2"><code className="text-indigo-400">gemini</code></td></tr>
                  <tr className="border-b border-gray-800"><td className="px-3 py-2">Windsurf</td><td className="px-3 py-2"><code className="text-indigo-400">windsurf</code></td></tr>
                  <tr className="border-b border-gray-800"><td className="px-3 py-2">Aider</td><td className="px-3 py-2"><code className="text-indigo-400">aider</code></td></tr>
                  <tr><td className="px-3 py-2">GitHub Copilot</td><td className="px-3 py-2"><code className="text-indigo-400">copilot</code></td></tr>
                </tbody>
              </table>
            </div>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Create API key &amp; assign agents</strong> &mdash; go to Settings &rarr; API Keys, create a key, and assign the agents it can use. Keys without agent assignments cannot start sessions.</Li>
              <Li>Create policies: block payments files, require review for infra, set cost limits, restrict models</Li>
            </ul>

            <H2>2. Developer installs CLI (one-time per machine)</H2>
            <CodeBlock title="Terminal">{`npm i -g ${window.location.origin}/cli/origin-cli-latest.tgz
origin login         # authenticate with your Origin server
origin init          # registers machine, detects tools, installs global hooks`}</CodeBlock>
            <P>
              That&apos;s it &mdash; two commands. <code className="text-indigo-400">origin init</code> auto-detects
              installed AI tools (Claude Code, Cursor, Copilot, Gemini, Aider, Windsurf, Codex, etc.), registers the machine,
              and installs global hooks. Tools are re-scanned on every session start, so new installations are picked up
              automatically without re-running init.
            </P>

            <Callout type="info">
              If you install a new AI tool after running <code className="text-indigo-400">origin init</code>, run <code className="text-indigo-400">origin enable --agent &lt;slug&gt; --global</code> to add hooks for it. For example: <code className="text-indigo-400">origin enable --agent cursor --global</code>.
            </Callout>

            <H3>Codex CLI setup</H3>
            <P>
              Running <code className="text-indigo-400">origin init</code> automatically enables the Codex hooks feature flag in <code className="text-indigo-400">~/.codex/config.toml</code> and installs hooks in <code className="text-indigo-400">~/.codex/hooks.json</code>.
            </P>
            <CodeBlock title="Terminal">{`# Install hooks + enable codex_hooks feature flag (one-time setup)
origin init`}</CodeBlock>
            <P>
              If you previously had to pass <code className="text-indigo-400">-c features.codex_hooks=true</code> each time, re-run <code className="text-indigo-400">origin init</code> to make it permanent.
              After setup, all Codex sessions will be tracked with prompts, code changes, and AI Blame attribution.
            </P>

            <H3>Cursor setup</H3>
            <P>
              <code className="text-indigo-400">origin init</code> auto-detects Cursor and installs hooks to <code className="text-indigo-400">~/.cursor/hooks.json</code>.
              If Cursor was installed after init, run:
            </P>
            <CodeBlock title="Terminal">{`origin enable --agent cursor --global`}</CodeBlock>
            <P>
              Restart Cursor after installing hooks. Make sure you have a <strong className="text-gray-200">Cursor</strong> agent (slug: <code className="text-indigo-400">cursor</code>) created in the web UI and assigned to your API key.
            </P>

            <H2>3. Daily workflow (automatic)</H2>
            <div className="space-y-1 mb-4">
              <Step n={1} title="Developer opens AI coding tool">
                Claude Code, Cursor, or any supported agent. The Origin CLI hook fires automatically and creates a session record on the server.
              </Step>
              <Step n={2} title="Every prompt is captured">
                Each user prompt is saved with a timestamp. The heartbeat sends live token count, cost, and transcript to the dashboard in real time.
              </Step>
              <Step n={3} title="Every tool call is logged">
                File edits, terminal commands, search queries &mdash; all tracked as part of the session.
              </Step>
              <Step n={4} title="On git commit">
                The git diff is captured, files changed are recorded, and session data is pushed to the server. AI blame attribution is computed.
              </Step>
              <Step n={5} title="Session ends">
                Full transcript, total cost, tokens used, duration, and all files changed are finalized. The secret scanner checks the diff for leaked API keys, passwords, and connection strings.
              </Step>
              <Step n={6} title="Policy engine evaluates">
                All active policies run against the session: file restrictions, model allowlist, cost limits, review requirements. Violations are logged to the audit trail.
              </Step>
            </div>

            <H2>4. GitHub PR flow</H2>
            <div className="space-y-1 mb-4">
              <Step n={1} title="Developer pushes and opens a PR">
                GitHub sends a webhook (push + pull_request) to Origin.
              </Step>
              <Step n={2} title="Origin links commits to sessions">
                Commits are matched to AI sessions by SHA. Origin knows which sessions contributed to this PR.
              </Step>
              <Step n={3} title="Status check posted">
                Origin posts an <code className="text-indigo-400">origin/ai-governance</code> commit status on the PR, plus a summary comment with a table of linked sessions, costs, and violations.
              </Step>
              <Step n={4} title="Merge gating">
                With GitHub branch protection enabled, the PR <strong className="text-gray-200">cannot be merged</strong> if the check fails. Flagged or rejected sessions block the merge.
              </Step>
            </div>

            <H2>5. Team review</H2>
            <ul className="space-y-2 mb-4">
              <Li>Admin or lead sees unreviewed sessions in the dashboard</Li>
              <Li>Opens session &rarr; reads transcript, views diff, checks AI blame (which prompt wrote which line)</Li>
              <Li>Approves, rejects, or flags the session with a note</Li>
              <Li>On approve &rarr; GitHub check turns green &rarr; PR can merge</Li>
            </ul>

            <H2>6. Ongoing governance</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Dashboard</strong> &mdash; Total sessions, cost trends, AI % of code, unreviewed count</Li>
              <Li><strong className="text-gray-200">Leaderboard</strong> &mdash; Who uses AI most, who has the best approval rate</Li>
              <Li><strong className="text-gray-200">Budget</strong> &mdash; Monthly cost limits with alerts at 50/80/90/100%</Li>
              <Li><strong className="text-gray-200">Compliance</strong> &mdash; 90-day reports with violation trends, secret findings, review coverage score</Li>
              <Li><strong className="text-gray-200">Audit log</strong> &mdash; Every action (review, policy change, repo sync) is recorded with timestamp and user</Li>
            </ul>

            <Callout type="tip">
              The developer&apos;s experience is simple: code normally with AI, push to GitHub. Everything else
              happens automatically behind the scenes.
            </Callout>
          </div>
        )}


        {/* ─── SESSION TRACKING ────────────────────────────────── */}
        {active === 'session-tracking' && (
          <div>
            <h1 id="session-tracking" className="text-2xl font-bold mb-2">Session Tracking</h1>
            <P>
              Origin automatically captures every AI coding session — prompts, files modified, token usage,
              cost, and full transcripts — by installing lightweight hooks into your AI coding agent. Works
              with <strong className="text-gray-200">Claude Code</strong>, <strong className="text-gray-200">Cursor</strong>,
              and <strong className="text-gray-200">Gemini CLI</strong>.
            </P>

            <Callout type="info">
              Session tracking is passive and non-blocking. It never interrupts your workflow — all data is
              captured in the background and sent to Origin for review.
            </Callout>

            <H2 id="prerequisites">Prerequisites</H2>
            <P>Before session tracking works, make sure you have:</P>
            <ul className="space-y-1 ml-4 mb-4">
              <Li>Installed the Origin CLI (see CLI Reference for install command)</Li>
              <Li>Logged in: <code className="text-indigo-400">origin login</code></Li>
              <Li>Initialized: <code className="text-indigo-400">origin init</code> (registers machine, detects tools, installs global hooks)</Li>
            </ul>

            <H2 id="quick-setup">Quick Setup</H2>
            <P>
              <code className="text-indigo-400">origin init</code> installs hooks globally, so all git repos are tracked automatically.
              No per-repo setup is needed. AI tools are auto-detected (Claude Code, Cursor, Copilot, Gemini, Aider, Windsurf, Cody, etc.)
              and re-scanned on every session start.
            </P>

            <H3>Per-Repo Override (Optional)</H3>
            <P>
              If you prefer per-repo hooks instead of global, or need to install hooks for a specific agent only:
            </P>
            <CodeBlock title="Terminal">{`origin enable                    # install hooks for this repo only
origin enable --agent claude-code  # specific agent
origin enable --agent cursor
origin enable --agent gemini`}</CodeBlock>

            <Callout type="tip">
              <code className="text-indigo-400">origin enable</code> installs hooks at the <strong className="text-gray-200">project level</strong>{' '}
              (e.g. <code className="text-indigo-400">.claude/settings.json</code> in your repo root). You can also install hooks at the{' '}
              <strong className="text-gray-200">user level</strong> (<code className="text-indigo-400">~/.claude/settings.json</code>) to
              track sessions across all your projects. Copy the hook config shown below into your global settings file.
            </Callout>

            <Callout type="info">
              <strong className="text-gray-200">Important:</strong> Origin only tracks code changes made <em>after</em> installation.
              Pre-existing code in your repository will appear as human-authored (<code className="text-indigo-400">[HU]</code>) in{' '}
              <code className="text-indigo-400">origin blame</code> and <code className="text-indigo-400">origin stats</code>,
              even if it was originally written by AI. Retroactive attribution is not possible because Origin
              needs to observe the session in real-time to link code to AI prompts.
            </Callout>

            <H2 id="supported-agents">Supported Agents</H2>

            <H3>Claude Code</H3>
            <P>
              Hooks are installed in <code className="text-indigo-400">.claude/settings.json</code> using
              Claude Code&rsquo;s native hooks API. Events captured:
            </P>
            <ul className="space-y-1 ml-4 mb-3">
              <Li><code className="text-indigo-400">SessionStart</code> — session created in Origin, tracking begins</Li>
              <Li><code className="text-indigo-400">UserPromptSubmit</code> — captures the actual user prompt</Li>
              <Li><code className="text-indigo-400">PreToolUse</code> — enforces FILE_RESTRICTION policies, blocks restricted file access in real-time</Li>
              <Li><code className="text-indigo-400">PostToolUse</code> — tracks branch changes mid-session</Li>
              <Li><code className="text-indigo-400">Stop</code> — parses transcript, extracts files &amp; tokens, sends incremental update</Li>
              <Li><code className="text-indigo-400">SessionEnd</code> — finalizes session with duration, cost estimate, and full transcript</Li>
            </ul>
            <CodeBlock title=".claude/settings.json">{`{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "origin hooks claude-code session-start" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "origin hooks claude-code pre-tool-use" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "origin hooks claude-code post-tool-use" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "origin hooks claude-code stop" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "origin hooks claude-code user-prompt-submit" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "origin hooks claude-code session-end" }] }
    ]
  }
}`}</CodeBlock>

            <H3>Cursor</H3>
            <P>
              Hooks are installed in <code className="text-indigo-400">.cursor/hooks.json</code> using
              Cursor&rsquo;s hooks system. Events captured:
            </P>
            <ul className="space-y-1 ml-4 mb-3">
              <Li><code className="text-indigo-400">sessionStart</code> — session created in Origin</Li>
              <Li><code className="text-indigo-400">beforeSubmitPrompt</code> — captures user prompt before submission</Li>
              <Li><code className="text-indigo-400">stop</code> — parses transcript, sends incremental data</Li>
              <Li><code className="text-indigo-400">sessionEnd</code> — finalizes with cost and duration</Li>
            </ul>
            <CodeBlock title=".cursor/hooks.json">{`{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "command": "origin hooks cursor session-start" }
    ],
    "stop": [
      { "command": "origin hooks cursor stop" }
    ],
    "beforeSubmitPrompt": [
      { "command": "origin hooks cursor user-prompt-submit" }
    ],
    "sessionEnd": [
      { "command": "origin hooks cursor session-end" }
    ]
  }
}`}</CodeBlock>

            <H3>Gemini CLI</H3>
            <P>
              Hooks are installed in <code className="text-indigo-400">.gemini/settings.json</code> using
              Gemini&rsquo;s hook system with matchers. Events captured:
            </P>
            <ul className="space-y-1 ml-4 mb-3">
              <Li><code className="text-indigo-400">SessionStart</code> — session created in Origin</Li>
              <Li><code className="text-indigo-400">BeforeAgent</code> — captures user prompt</Li>
              <Li><code className="text-indigo-400">AfterAgent</code> — parses transcript, sends incremental data</Li>
              <Li><code className="text-indigo-400">SessionEnd</code> — finalizes (fires on <code className="text-indigo-400">exit</code> and <code className="text-indigo-400">logout</code> matchers)</Li>
            </ul>
            <CodeBlock title=".gemini/settings.json">{`{
  "hooksConfig": { "enabled": true },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "name": "origin-session-start", "type": "command",
        "command": "origin hooks gemini session-start" }] }
    ],
    "BeforeAgent": [
      { "hooks": [{ "name": "origin-before-agent", "type": "command",
        "command": "origin hooks gemini user-prompt-submit" }] }
    ],
    "AfterAgent": [
      { "hooks": [{ "name": "origin-after-agent", "type": "command",
        "command": "origin hooks gemini stop" }] }
    ],
    "SessionEnd": [
      { "matcher": "exit", "hooks": [{ "name": "origin-session-end",
        "type": "command", "command": "origin hooks gemini session-end" }] }
    ]
  }
}`}</CodeBlock>

            <H2 id="what-gets-captured">What Gets Captured</H2>
            <P>
              For every AI coding session, Origin captures and stores the following metadata with each change.
              Every field listed below is persisted, auditable, and available in the session detail view and API.
            </P>

            <H3>Prompts &amp; Conversation</H3>
            <div className="rounded-lg border border-gray-700 overflow-hidden my-4">
              <table className="w-full text-sm">
                <thead className="bg-gray-800">
                  <tr>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Data</th>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Description</th>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  <tr><td className="px-4 py-2 text-gray-300">User Prompts</td><td className="px-4 py-2 text-gray-400">Every prompt sent to the AI agent, captured individually</td><td className="px-4 py-2 text-gray-500">UserPromptSubmit hook</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Full Transcript</td><td className="px-4 py-2 text-gray-400">Complete raw JSONL/JSON conversation transcript for audit</td><td className="px-4 py-2 text-gray-500">SessionEnd hook</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Prompt &rarr; Changes</td><td className="px-4 py-2 text-gray-400">Maps each user prompt to the specific files modified as a result</td><td className="px-4 py-2 text-gray-500">Transcript analysis</td></tr>
                </tbody>
              </table>
            </div>

            <H3>LLM Metadata</H3>
            <div className="rounded-lg border border-gray-700 overflow-hidden my-4">
              <table className="w-full text-sm">
                <thead className="bg-gray-800">
                  <tr>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Data</th>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Description</th>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  <tr><td className="px-4 py-2 text-gray-300">Model</td><td className="px-4 py-2 text-gray-400">Which AI model was used (e.g. claude-sonnet-4-20250514, gemini-2.5-pro)</td><td className="px-4 py-2 text-gray-500">SessionStart hook</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Total Tokens</td><td className="px-4 py-2 text-gray-400">Combined input + output token count for the session</td><td className="px-4 py-2 text-gray-500">Transcript parsing</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Input Tokens</td><td className="px-4 py-2 text-gray-400">Tokens sent to the model (prompts, context, tool results)</td><td className="px-4 py-2 text-gray-500">Transcript parsing</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Output Tokens</td><td className="px-4 py-2 text-gray-400">Tokens generated by the model (responses, tool calls)</td><td className="px-4 py-2 text-gray-500">Transcript parsing</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Tool Calls</td><td className="px-4 py-2 text-gray-400">Number of tool invocations the agent made (Read, Write, Bash, etc.)</td><td className="px-4 py-2 text-gray-500">Transcript parsing</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Cost Estimate</td><td className="px-4 py-2 text-gray-400">Estimated cost based on model-specific pricing (input/output rates)</td><td className="px-4 py-2 text-gray-500">Calculated from token counts</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Duration</td><td className="px-4 py-2 text-gray-400">Wall-clock time from session start to end</td><td className="px-4 py-2 text-gray-500">SessionStart &rarr; SessionEnd</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Agent System Prompt</td><td className="px-4 py-2 text-gray-400">Snapshot of the agent&rsquo;s system prompt that was active during this session</td><td className="px-4 py-2 text-gray-500">Agent config at session start</td></tr>
                </tbody>
              </table>
            </div>

            <H3>Code Changes</H3>
            <div className="rounded-lg border border-gray-700 overflow-hidden my-4">
              <table className="w-full text-sm">
                <thead className="bg-gray-800">
                  <tr>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Data</th>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Description</th>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  <tr><td className="px-4 py-2 text-gray-300">Files Modified</td><td className="px-4 py-2 text-gray-400">Files the agent wrote, edited, or created (Write, Edit, NotebookEdit)</td><td className="px-4 py-2 text-gray-500">Transcript parsing</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Git Diff</td><td className="px-4 py-2 text-gray-400">Full unified diff of all code changes (committed + uncommitted), capped at 500KB</td><td className="px-4 py-2 text-gray-500">git diff at session end</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Commit SHAs</td><td className="px-4 py-2 text-gray-400">Real git commit hashes created during the session</td><td className="px-4 py-2 text-gray-500">git log comparison</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">HEAD Range</td><td className="px-4 py-2 text-gray-400">HEAD SHA before and after session (shows exact commit range)</td><td className="px-4 py-2 text-gray-500">git rev-parse at start/end</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Lines Added/Removed</td><td className="px-4 py-2 text-gray-400">Net code change from the real git diff (not transcript estimate)</td><td className="px-4 py-2 text-gray-500">Diff line counting</td></tr>
                </tbody>
              </table>
            </div>

            <H3>Context &amp; Identity</H3>
            <div className="rounded-lg border border-gray-700 overflow-hidden my-4">
              <table className="w-full text-sm">
                <thead className="bg-gray-800">
                  <tr>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Data</th>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Description</th>
                    <th className="text-left px-4 py-2 text-gray-300 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  <tr><td className="px-4 py-2 text-gray-300">Agent</td><td className="px-4 py-2 text-gray-400">Which AI tool ran the session (Claude Code, Cursor, Gemini CLI)</td><td className="px-4 py-2 text-gray-500">Hook command slug</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">User</td><td className="px-4 py-2 text-gray-400">Developer who ran the session (name, email)</td><td className="px-4 py-2 text-gray-500">CLI auth config</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Machine</td><td className="px-4 py-2 text-gray-400">Which machine ran the session (hostname, machine ID)</td><td className="px-4 py-2 text-gray-500">origin init registration</td></tr>
                  <tr><td className="px-4 py-2 text-gray-300">Repository</td><td className="px-4 py-2 text-gray-400">Repo path and name where the session occurred</td><td className="px-4 py-2 text-gray-500">git repo detection</td></tr>
                </tbody>
              </table>
            </div>

            <Callout type="info">
              All data is stored per-session and linked to the git commit history. Each session preserves a snapshot of the agent&rsquo;s system prompt,
              so you can audit what instructions the AI was following at the time of each change &mdash; even if the agent config has since been updated.
            </Callout>

            <H2>How It Works</H2>
            <P>
              The lifecycle of a tracked session:
            </P>
            <Step n={1} title="Session starts">
              <p>When you launch an AI agent, the <code className="text-indigo-400">session-start</code> hook fires.
              Origin records the current HEAD commit SHA, creates a new session record, and saves
              state locally in <code className="text-indigo-400">.git/origin-session.json</code>.</p>
            </Step>
            <Step n={2} title="You type prompts">
              <p>Each prompt triggers the <code className="text-indigo-400">user-prompt-submit</code> hook.
              Origin captures the actual text you typed and accumulates it.</p>
            </Step>
            <Step n={3} title="Agent works, turn ends">
              <p>After each agent turn, the <code className="text-indigo-400">stop</code> hook fires.
              Origin reads the agent&rsquo;s transcript file, extracts files changed,
              token counts, and tool calls, then sends an incremental update to the API.</p>
            </Step>
            <Step n={4} title="Session ends &mdash; git capture">
              <p>When you exit the agent, <code className="text-indigo-400">session-end</code> fires.
              Origin finalizes the session with duration, cost, and the full transcript. It also
              captures the <strong className="text-gray-200">real git state</strong>:</p>
              <ul className="mt-2 space-y-1 ml-4">
                <Li>Detects new commits created since session start (real SHA hashes)</Li>
                <Li>Captures the full unified diff (<code className="text-indigo-400">git diff</code>) including uncommitted changes</Li>
                <Li>Maps each user prompt to the specific files it caused to change</Li>
                <Li>Sends everything to Origin for review, AI analysis, and governance</Li>
              </ul>
            </Step>

            <H2>Disabling Tracking</H2>
            <P>
              To remove Origin hooks from a repo:
            </P>
            <CodeBlock title="Terminal">{`origin disable`}</CodeBlock>
            <P>
              This removes Origin hooks from all agent configs (<code className="text-indigo-400">.claude/settings.json</code>,{' '}
              <code className="text-indigo-400">.cursor/hooks.json</code>,{' '}
              <code className="text-indigo-400">.gemini/settings.json</code>) and cleans up the local session state.
              Your agent settings and any other hooks remain untouched.
            </P>

            <H2>Viewing Sessions</H2>
            <P>
              After a tracked session completes, view it in the CLI or dashboard:
            </P>
            <CodeBlock title="Terminal">{`# List recent sessions
origin sessions

# View a specific session
origin session <session-id>

# Review a session
origin review <session-id> --approve --note "LGTM"

# Or open the dashboard
origin stats`}</CodeBlock>

            <H2>Troubleshooting</H2>

            <H3>Sessions not appearing?</H3>
            <ul className="space-y-1 ml-4 mb-3">
              <Li>Verify hooks are installed: check the agent config file for <code className="text-indigo-400">origin hooks</code> commands</Li>
              <Li>Make sure Origin CLI is in your PATH: <code className="text-indigo-400">which origin</code></Li>
              <Li>Check you&rsquo;re logged in: <code className="text-indigo-400">origin whoami</code></Li>
              <Li>Check status: <code className="text-indigo-400">origin status</code></Li>
            </ul>

            <H3>Token counts or cost showing zero?</H3>
            <P>
              This typically means the transcript file couldn&rsquo;t be parsed. Ensure your agent is writing
              transcripts in the expected location. For Claude Code, transcripts live
              at <code className="text-indigo-400">~/.claude/projects/&lt;path&gt;/sessions/&lt;id&gt;.jsonl</code>.
            </P>

            <Callout type="tip">
              Run <code className="text-indigo-400">origin status</code> to check your current setup — it shows
              whether hooks are installed, which agents are detected, and if there&rsquo;s an active session.
            </Callout>
          </div>
        )}

        {/* ─── GITHUB INTEGRATION ──────────────────────────────── */}
        {active === 'integrations' && (
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
        )}

        {/* ─── GITLAB INTEGRATION ────────────────────────────────────── */}
        {active === 'gitlab-integration' && (
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
        )}

        {/* ─── REPOSITORIES ────────────────────────────────────── */}
        {active === 'repos' && (
          <div>
            <h1 id="repos" className="text-2xl font-bold mb-2">Repositories</h1>
            <P>
              Repositories are the foundation of Origin. Each repo represents a Git
              repository where AI agents write code.
            </P>

            <H2>Importing from GitHub (Recommended)</H2>
            <P>
              If you&apos;ve connected GitHub in Settings &rarr; Integrations, you&apos;ll see an
              <strong className="text-gray-200"> Import from GitHub</strong> button on the Repositories page.
            </P>
            <Step n={1} title="Click 'Import from GitHub'">
              <p>Origin fetches all repos your GitHub token has access to. This includes private repos, org repos, and forks.</p>
            </Step>
            <Step n={2} title="Select repos to monitor">
              <p>Use the search filter to find repos. Check the ones you want to monitor. Repos already imported are shown with a green &ldquo;imported&rdquo; badge and can&apos;t be selected again.</p>
            </Step>
            <Step n={3} title="Click 'Import Selected'">
              <p>For each selected repo, Origin creates the repository record, generates a webhook secret, and creates a webhook on GitHub automatically. You&apos;ll see per-repo success/error results.</p>
            </Step>

            <Callout type="info">
              Auto-import creates webhooks that listen for <code className="text-indigo-400">push</code> and <code className="text-indigo-400">pull_request</code> events.
              When you delete an imported repo from Origin, the webhook is also removed from GitHub automatically.
            </Callout>

            <H2>Syncing</H2>
            <P>
              Click &ldquo;Sync Now&rdquo; on any repo to scan for new commits. Origin looks for
              <code className="text-indigo-400"> .entire/</code> checkpoint directories that AI tools
              create, then imports the session data (model, prompt, transcript, files changed, etc.).
            </P>

            <H2>AI Commit Detection</H2>
            <P>
              Origin automatically classifies commits as AI-authored or human-authored using
              multiple detection methods. This powers the AI/Human filters and the AI percentage metric.
            </P>
            <H3>Detection Methods (in priority order)</H3>
            <ul className="space-y-2 mb-4">
              <Li>
                <strong className="text-gray-200">Session-linked</strong> (blue badge) — Commits created
                during a tracked coding session. These have full prompt, transcript, and cost data.
              </Li>
              <Li>
                <strong className="text-gray-200">Co-Authored-By trailer</strong> (purple badge) — Detects{' '}
                <code className="text-indigo-400">Co-Authored-By:</code> trailers in commit messages from
                Claude Code, GitHub Copilot, Cursor, Aider, Gemini, and Windsurf/Codeium.
              </Li>
              <Li>
                <strong className="text-gray-200">Author pattern</strong> (purple badge) — Recognizes AI bot
                author names like &ldquo;Claude&rdquo;, &ldquo;copilot&rdquo;, or &ldquo;mcp-agent&rdquo;.
              </Li>
              <Li>
                <strong className="text-gray-200">Commit message pattern</strong> (purple badge) — Matches
                known AI signatures like &ldquo;Generated with Claude Code&rdquo; or &ldquo;[aider]&rdquo; prefixes.
              </Li>
            </ul>
            <P>
              Heuristically-detected commits show a purple dashed badge with the tool name and
              &ldquo;detected&rdquo; label. Session-linked commits show a solid blue badge with the model name.
              Undetected commits show a gray &ldquo;Human&rdquo; badge.
            </P>

            <Callout type="tip">
              To ensure your AI commits are correctly detected, make sure your AI tool adds a{' '}
              <code className="text-indigo-400">Co-Authored-By</code> trailer to commit messages.
              Claude Code does this by default. Click the <strong className="text-gray-200">Rescan AI</strong> button
              on any repo to re-analyze existing commits.
            </Callout>

            <H2>Repository Detail View</H2>
            <P>Click any repo card to see its detail page with:</P>
            <ul className="space-y-2 mb-4">
              <Li>Stats: total commits, AI-authored, human, unreviewed counts</Li>
              <Li>Filter tabs: All / AI Authored / Human / Unreviewed</Li>
              <Li>Full commit table with SHA, message, author, model, files, tokens, and review status</Li>
              <Li>Rescan AI button to re-analyze commits for AI authorship detection</Li>
              <Li>Webhook settings (for GitHub repos)</Li>
              <Li>Click any AI-authored commit to view its session detail and transcript</Li>
            </ul>

            <H2>Deleting a Repository</H2>
            <P>
              Deleting a repo is a cascade operation that removes all associated data: webhooks, pull requests,
              commits, sessions, and reviews. For GitHub-imported repos, the webhook on GitHub is also automatically
              deleted. This action cannot be undone. Requires ADMIN role or above.
            </P>
          </div>
        )}

        {/* ─── AGENTS ──────────────────────────────────────────── */}
        {active === 'agents' && (
          <div>
            <h1 id="agents" className="text-2xl font-bold mb-2">Agents</h1>
            <P>
              Agents represent the AI coding tools your team uses. Registering agents lets you
              track usage per tool, scope policies to specific agents, and understand which AI
              tools generate the most code and cost.
            </P>

            <H2>Setting Up Agents</H2>

            <Step n={1} title="Go to Agents page">
              <p>Navigate to <strong className="text-gray-200">Agents</strong> in the sidebar.</p>
            </Step>
            <Step n={2} title="Click 'Add Agent'">
              <p>Fill in the agent details:</p>
            </Step>

            <ul className="space-y-2 mb-4 ml-12">
              <Li><strong className="text-gray-200">Name</strong> &mdash; Human-readable name. Examples: &ldquo;Claude Code&rdquo;, &ldquo;Cursor AI&rdquo;, &ldquo;GitHub Copilot&rdquo;, &ldquo;Windsurf&rdquo;</Li>
              <Li><strong className="text-gray-200">Slug</strong> &mdash; Unique machine-readable identifier. Must match the tool name exactly: <code className="text-indigo-400">claude-code</code>, <code className="text-indigo-400">cursor</code>, <code className="text-indigo-400">codex</code>, <code className="text-indigo-400">gemini</code>, <code className="text-indigo-400">windsurf</code>, <code className="text-indigo-400">aider</code>, <code className="text-indigo-400">copilot</code>. Used in API calls and policy rules.</Li>
              <Li><strong className="text-gray-200">Model</strong> &mdash; The default AI model this agent uses. Examples: <code className="text-indigo-400">claude-sonnet-4-20250514</code>, <code className="text-indigo-400">gpt-4o</code>, <code className="text-indigo-400">claude-opus-4-20250514</code></Li>
              <Li><strong className="text-gray-200">Description</strong> (optional) &mdash; A brief description of the agent&apos;s purpose or team.</Li>
            </ul>

            <H2>Recommended Agent Setup</H2>
            <P>Create one agent per AI tool your team uses. Here are common configurations:</P>

            <CodeBlock title="Example: Claude Code">{`Name:        Claude Code
Slug:        claude-code
Model:       claude-sonnet-4-20250514
Description: Primary AI coding assistant for backend team`}</CodeBlock>

            <CodeBlock title="Example: Cursor">{`Name:        Cursor
Slug:        cursor
Model:       gpt-4o
Description: IDE-integrated coding assistant`}</CodeBlock>

            <CodeBlock title="Example: Windsurf">{`Name:        Windsurf
Slug:        windsurf
Model:       claude-sonnet-4-20250514
Description: Codeium's AI IDE agent`}</CodeBlock>

            <H2>Agent Status</H2>
            <P>
              Agents can be <code className="text-green-400">ACTIVE</code> or <code className="text-gray-400">INACTIVE</code>.
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Active</strong> &mdash; Agent is in use, counted in dashboard stats, policy rules can target it</Li>
              <Li><strong className="text-gray-200">Inactive</strong> &mdash; Agent is retired/paused. Sessions are preserved but the agent doesn&apos;t appear in active counts</Li>
            </ul>
            <P>
              Toggle status by clicking the agent card and using the status dropdown. Use this to
              decommission agents without losing historical data.
            </P>

            <H2>Scoping Policies to Agents</H2>
            <P>
              When creating policy rules, you can optionally select an agent. This lets you create
              rules like &ldquo;Copilot cannot edit files in <code className="text-indigo-400">src/auth/</code>&rdquo; while allowing Claude Code full access.
              See the <strong className="text-gray-200">Policies</strong> section for details.
            </P>

            <H2>Agent Metrics</H2>
            <P>
              Each agent card shows the total number of sessions linked to it. The Dashboard
              shows top agents by session count and cost for quick comparison.
            </P>
          </div>
        )}

        {/* ─── POLICIES ────────────────────────────────────────── */}
        {active === 'policies' && (
          <div>
            <h1 id="policies" className="text-2xl font-bold mb-2">Policies</h1>
            <P>
              Policies are governance rules that control what AI agents can and cannot do.
              They are enforced at two levels: <strong className="text-gray-200">server-side</strong> (at session start and end) and
              <strong className="text-gray-200"> client-side</strong> (via the MCP server during sessions).
              All violations are logged to the audit trail and can trigger notifications.
            </P>

            <Callout type="info">
              Policies are only enforced when <strong className="text-gray-200">Active</strong>.
              Toggle a policy on/off from the Policies page. Only active policies are loaded by the MCP server.
            </Callout>

            <H2>How Enforcement Works</H2>
            <P>Policies are enforced at multiple points:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Session start (server)</strong> &mdash; MODEL_ALLOWLIST policies are checked. If the model is not allowed and action is &ldquo;block&rdquo;, the session is rejected with HTTP 403. Active enforcement rules are sent to the CLI for client-side enforcement.</Li>
              <Li><strong className="text-gray-200">During session (CLI hooks)</strong> &mdash; FILE_RESTRICTION policies are enforced in real-time via the <code className="text-indigo-400">pre-tool-use</code> hook. When an agent tries to read, edit, or execute a command involving a restricted file, the CLI blocks the tool call before it executes. This works with all supported agents (Claude Code, Gemini CLI, Cursor).</Li>
              <Li><strong className="text-gray-200">During session (MCP server)</strong> &mdash; FILE_RESTRICTION policies are also checked when the agent calls <code className="text-indigo-400">check_file_access</code> via the MCP server.</Li>
              <Li><strong className="text-gray-200">Session end (server)</strong> &mdash; REQUIRE_REVIEW, COST_LIMIT, and FILE_RESTRICTION policies are evaluated against the session&apos;s final data. Violations auto-flag the session for review and notify admins.</Li>
            </ul>

            <H2>Quick Start: Create Your First Policy</H2>

            <Step n={1} title="Go to Policies page">
              <p>Navigate to <strong className="text-gray-200">Policies</strong> in the sidebar and click <strong className="text-gray-200">Add Policy</strong>.</p>
            </Step>
            <Step n={2} title="Choose a type and name">
              <p>Give it a name (e.g. &ldquo;No sensitive files&rdquo;) and select the type (e.g. FILE_RESTRICTION). The description below the type selector explains what each type does.</p>
            </Step>
            <Step n={3} title="Add rules with conditions">
              <p>Expand the policy and click <strong className="text-gray-200">Add Rule</strong>. Enter a JSON condition, choose an action, and set severity. Click the example conditions to auto-fill common patterns. Optionally scope the rule to a specific agent, machine, or repo using the scope dropdowns.</p>
            </Step>
            <Step n={4} title="Ensure the policy is active">
              <p>The toggle on the right activates/deactivates the policy. Active policies show a green pulse indicator.</p>
            </Step>

            <H2 id="policy-types">Policy Types</H2>

            <H3>FILE_RESTRICTION</H3>
            <P>
              Block or flag access to specific file patterns. Use glob patterns for matching.
              Enforced both client-side (MCP check_file_access) and server-side (at session end).
            </P>
            <CodeBlock title="Condition format: JSON with 'path' field (glob pattern)">{`{"path": "**/.env"}         — All .env files anywhere
{"path": "**/.env*"}        — .env, .env.local, .env.production
{"path": "src/auth/**"}     — All files in auth directory
{"path": "**/*.key"}        — All .key files
{"path": "**/secrets/**"}   — Anything in a secrets directory
{"path": "**/*.pem"}        — All certificate files`}</CodeBlock>

            <H3>REQUIRE_REVIEW</H3>
            <P>
              Auto-flag sessions for human review when conditions are met.
              Evaluated at session end against the session&apos;s actual data.
            </P>
            <CodeBlock title="Condition format: JSON with threshold fields">{`{"cost_above": 1.0}             — Flag if session cost > $1.00
{"tokens_above": 50000}         — Flag if tokens > 50k
{"files_above": 10}             — Flag if > 10 files changed
{"max_lines": 500}              — Flag if > 500 lines added
{"max_duration_minutes": 30}    — Flag if session > 30 minutes
{"path": "**/*.sql"}            — Flag if SQL files modified`}</CodeBlock>

            <H3>MODEL_ALLOWLIST</H3>
            <P>
              Restrict which AI models can be used. Checked server-side at session start.
              If the model is not in the allowed list and action is &ldquo;block&rdquo;,
              the session is rejected immediately.
            </P>
            <CodeBlock title="Condition format: JSON with 'models' array">{`{"models": ["claude-sonnet-4-20250514"]}
  — Only allow Claude Sonnet

{"models": ["claude-sonnet-4-20250514", "gpt-4o"]}
  — Allow Sonnet or GPT-4o

{"models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "gpt-4o"]}
  — Allow multiple specific models`}</CodeBlock>

            <H3>COST_LIMIT</H3>
            <P>
              Set per-session cost or token limits. Evaluated at session end.
              Violations are logged and can flag the session for review.
            </P>
            <CodeBlock title="Condition format: JSON with limit fields">{`{"max_cost": 5.0}       — Limit $5 per session
{"max_tokens": 100000}  — Limit 100k tokens per session`}</CodeBlock>

            <Callout type="tip">
              For organization-wide monthly spending limits, use the <strong className="text-gray-200">Budget</strong> feature
              in Settings instead. COST_LIMIT policies are for per-session thresholds.
            </Callout>

            <H2>Rule Actions</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-red-400">block</strong> &mdash; Prevent the action entirely. For MODEL_ALLOWLIST, the session is rejected (HTTP 403). For FILE_RESTRICTION, the MCP server returns <code className="text-indigo-400">allowed: false</code>.</Li>
              <Li><strong className="text-amber-400">warn</strong> &mdash; Allow but log the violation to the audit trail and flag the session for review.</Li>
              <Li><strong className="text-blue-400">require_review</strong> &mdash; Allow but auto-create a &ldquo;FLAGGED&rdquo; review on the session with a note explaining which policy triggered it.</Li>
              <Li><strong className="text-purple-400">notify</strong> &mdash; Allow and send a notification to all org admins about the violation.</Li>
            </ul>

            <H2>Rule Severity</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-red-400">HIGH</strong> &mdash; Critical rule. HIGH severity violations always trigger admin notifications.</Li>
              <Li><strong className="text-amber-400">MEDIUM</strong> &mdash; Important but not critical. Logged in audit trail.</Li>
              <Li><strong className="text-green-400">LOW</strong> &mdash; Advisory, for tracking purposes.</Li>
            </ul>

            <H2>What Happens When a Policy Is Violated</H2>
            <P>When the policy engine detects a violation at session end:</P>
            <ul className="space-y-2 mb-4">
              <Li>A <code className="text-indigo-400">POLICY_VIOLATION</code> entry is created in the audit log with full details</Li>
              <Li>If the action is <code className="text-indigo-400">require_review</code> (or policy type is REQUIRE_REVIEW), a &ldquo;FLAGGED&rdquo; review is auto-created on the session</Li>
              <Li>The auto-review includes a note listing which policies triggered and why</Li>
              <Li>For HIGH severity violations, all org admins receive a notification with a link to the session</Li>
            </ul>

            <H2>Scoped Rules</H2>
            <P>
              By default, policy rules apply to all sessions across your entire organization.
              You can narrow the scope of any rule by assigning it to a specific <strong>agent</strong>,
              <strong> machine</strong>, or <strong>repo</strong> using the scope dropdowns when
              adding a rule.
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong>Agent scope</strong> &mdash; Rule only applies to sessions from a specific AI agent (e.g. &ldquo;Claude Code&rdquo;, &ldquo;Cursor Agent&rdquo;)</Li>
              <Li><strong>Machine scope</strong> &mdash; Rule only applies to sessions from a specific registered machine (e.g. &ldquo;ci-runner-01&rdquo;, &ldquo;artem-mbp&rdquo;)</Li>
              <Li><strong>Repo scope</strong> &mdash; Rule only applies to sessions in a specific repository (e.g. &ldquo;origin&rdquo;, &ldquo;frontend-app&rdquo;)</Li>
              <Li><strong>No scope</strong> &mdash; Rule applies to all sessions (org-wide)</Li>
              <Li><strong>Multiple scopes</strong> &mdash; If a rule has both a machine and repo scope, <em>both must match</em> for the rule to apply (AND logic)</Li>
            </ul>

            <CodeBlock title="Scoped rule examples">{`# Block GPT-4 on CI machines
Policy: MODEL_ALLOWLIST
Rule: {"models": ["claude-sonnet-4-20250514"]} → block, HIGH
Scope: Machine → ci-runner-01

# Require review for production repo
Policy: REQUIRE_REVIEW
Rule: {"cost_above": 0.50} → require_review, MEDIUM
Scope: Repo → production-api

# Cost limit for Cursor agent only
Policy: COST_LIMIT
Rule: {"max_cost": 10.0} → warn, MEDIUM
Scope: Agent → Cursor Agent`}</CodeBlock>

            <H2>Policy Versioning</H2>
            <P>
              Every change to a policy (creation, update, rule added/removed, activation/deactivation)
              is versioned. You can see the version history in the policy detail view. This provides
              a full audit trail of governance changes.
            </P>

            <H2>Example: Setting Up Common Policies</H2>
            <P>Here&apos;s a recommended starter set of policies:</P>

            <CodeBlock title="1. Protect sensitive files (FILE_RESTRICTION)">{`Name: "No sensitive files"
Type: FILE_RESTRICTION
Rule 1: {"path": "**/.env*"}    → block, HIGH
Rule 2: {"path": "**/*.key"}    → block, HIGH
Rule 3: {"path": "**/*.pem"}    → block, HIGH`}</CodeBlock>

            <CodeBlock title="2. Review expensive sessions (REQUIRE_REVIEW)">{`Name: "Review expensive sessions"
Type: REQUIRE_REVIEW
Rule 1: {"cost_above": 2.0}         → require_review, MEDIUM
Rule 2: {"files_above": 15}         → require_review, MEDIUM
Rule 3: {"max_lines": 1000}         → require_review, HIGH`}</CodeBlock>

            <CodeBlock title="3. Allowed models only (MODEL_ALLOWLIST)">{`Name: "Approved models"
Type: MODEL_ALLOWLIST
Rule 1: {"models": ["claude-sonnet-4-20250514", "gpt-4o"]}
        → block, HIGH`}</CodeBlock>
          </div>
        )}

        {/* ─── SETTINGS & API KEYS ─────────────────────────────── */}
        {active === 'settings' && (
          <div>
            <h1 id="settings" className="text-2xl font-bold mb-2">Settings & API Keys</h1>
            <P>
              Manage your organization&apos;s API keys, integrations, and account settings.
            </P>

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
        )}

        {/* ─── TEAM & ROLES (RBAC) ─────────────────────────────── */}
        {active === 'rbac' && (
          <div>
            <h1 id="rbac" className="text-2xl font-bold mb-2">Team & Roles</h1>
            <P>
              Origin uses Role-Based Access Control (RBAC) to manage permissions. Each user has one role
              within their organization.
            </P>

            <H2 id="roles">Roles</H2>
            <div className="space-y-4 mt-4 mb-6">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <span className="badge badge-purple text-xs">OWNER</span>
                  <span className="text-gray-200 font-semibold">Organization Owner</span>
                </div>
                <P>Full access to everything. Can manage billing, delete the org, and manage all settings. One per org.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <span className="badge badge-red text-xs">ADMIN</span>
                  <span className="text-gray-200 font-semibold">Administrator</span>
                </div>
                <P>Can manage integrations, create/delete repos, manage webhooks, create policies, invite team members, and review sessions.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <span className="badge badge-blue text-xs">MEMBER</span>
                  <span className="text-gray-200 font-semibold">Team Member</span>
                </div>
                <P>Can create repos, review sessions, view all data, sync repos, and use the CLI/MCP. Cannot manage integrations or delete repos.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <div className="flex items-center gap-2 mb-2">
                  <span className="badge badge-gray text-xs">VIEWER</span>
                  <span className="text-gray-200 font-semibold">Read-Only Viewer</span>
                </div>
                <P>Can view dashboards, sessions, repos, policies, and audit logs. Cannot create, modify, or delete anything.</P>
              </div>
            </div>

            <H2>Permission Matrix</H2>
            <div className="overflow-x-auto mb-6">
              <table className="w-full text-sm border border-gray-700 rounded-lg overflow-hidden">
                <thead>
                  <tr className="bg-gray-800">
                    <th className="text-left px-3 py-2 text-gray-400 font-medium">Action</th>
                    <th className="text-center px-3 py-2 text-gray-400 font-medium">Owner</th>
                    <th className="text-center px-3 py-2 text-gray-400 font-medium">Admin</th>
                    <th className="text-center px-3 py-2 text-gray-400 font-medium">Member</th>
                    <th className="text-center px-3 py-2 text-gray-400 font-medium">Viewer</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {[
                    ['View dashboard & data', true, true, true, true],
                    ['Create repositories', true, true, true, false],
                    ['Import from GitHub', true, true, false, false],
                    ['Delete repositories', true, true, false, false],
                    ['Review sessions', true, true, true, false],
                    ['Manage agents', true, true, true, false],
                    ['Create/edit policies', true, true, false, false],
                    ['Manage integrations', true, true, false, false],
                    ['Create webhooks', true, true, false, false],
                    ['Manage API keys', true, true, false, false],
                    ['View audit logs', true, true, true, true],
                  ].map(([action, ...perms]) => (
                    <tr key={action as string} className="hover:bg-gray-800/30">
                      <td className="px-3 py-2 text-gray-300">{action as string}</td>
                      {(perms as boolean[]).map((allowed, i) => (
                        <td key={i} className="text-center px-3 py-2">
                          {allowed
                            ? <span className="text-green-400">&#10003;</span>
                            : <span className="text-gray-600">&mdash;</span>
                          }
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ─── DASHBOARD ───────────────────────────────────────── */}
        {active === 'dashboard' && (
          <div>
            <h1 id="dashboard" className="text-2xl font-bold mb-2">Dashboard</h1>
            <P>The dashboard provides a high-level governance overview of your organization&apos;s AI coding activity.</P>

            <H3>Active Sessions</H3>
            <P>
              When AI coding sessions are currently running, a purple card appears at the top of the
              dashboard with a pulsing indicator. Each active session shows the model, prompt, repo,
              agent name, and elapsed time. Click any session to view its detail page. The active
              sessions section polls every 10 seconds to stay up-to-date.
            </P>

            <H3>KPI Cards</H3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-purple-400">Active Now</strong> &mdash; Number of sessions currently running (purple when &gt; 0)</Li>
              <Li><strong className="text-gray-200">Sessions This Week</strong> &mdash; AI coding sessions in the past 7 days</Li>
              <Li><strong className="text-gray-200">Est. Cost This Month</strong> &mdash; Total API cost from all sessions this month</Li>
              <Li><strong className="text-gray-200">Unreviewed</strong> &mdash; Sessions awaiting human review</Li>
              <Li><strong className="text-gray-200">Compliance Score</strong> &mdash; Policy adherence rating (0-100)</Li>
            </ul>

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

        {/* ─── SESSIONS & REVIEWS ──────────────────────────────── */}
        {active === 'sessions' && (
          <div>
            <h1 id="sessions" className="text-2xl font-bold mb-2">Sessions & Reviews</h1>
            <P>
              Sessions represent individual AI coding interactions. Every time an agent
              writes code, Origin captures it as a session.
            </P>

            <H2 id="session-data">Session Data</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Model</strong> &mdash; Which AI model was used (e.g. claude-sonnet-4-20250514)</Li>
              <Li><strong className="text-gray-200">Prompt</strong> &mdash; What the developer asked the agent to do</Li>
              <Li><strong className="text-gray-200">Transcript</strong> &mdash; Full conversation between human and AI</Li>
              <Li><strong className="text-gray-200">Files Changed</strong> &mdash; List of files the agent modified</Li>
              <Li><strong className="text-gray-200">Git Diff</strong> &mdash; Full unified diff of all code changes (committed and uncommitted)</Li>
              <Li><strong className="text-gray-200">Commit SHAs</strong> &mdash; Real git commit hashes created during the session</Li>
              <Li><strong className="text-gray-200">Prompt &rarr; Changes</strong> &mdash; Maps each prompt to the files modified as a result</Li>
              <Li><strong className="text-gray-200">Tokens Used</strong> &mdash; Total input + output tokens</Li>
              <Li><strong className="text-gray-200">Cost</strong> &mdash; Estimated API cost in USD</Li>
              <Li><strong className="text-gray-200">Tool Calls</strong> &mdash; Number of tool invocations during the session</Li>
              <Li><strong className="text-gray-200">Duration</strong> &mdash; How long the session took</Li>
              <Li><strong className="text-gray-200">Lines Added/Removed</strong> &mdash; Net code changes from actual git diff</Li>
              <Li><strong className="text-gray-200">Pull Requests</strong> &mdash; Linked PRs (if GitHub integration is active)</Li>
            </ul>

            <H2>Session Status</H2>
            <P>
              Sessions have a status field that tracks their lifecycle:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-purple-400">RUNNING</strong> &mdash; Session is currently active (an AI agent is working). Shown with a purple pulsing badge.</Li>
              <Li><strong className="text-gray-200">COMPLETED</strong> &mdash; Session has ended. All data (transcript, diffs, costs) is finalized.</Li>
            </ul>
            <P>
              Running sessions appear in the Dashboard&apos;s active sessions section and in the Sessions
              list with a purple &ldquo;running&rdquo; badge. They transition to COMPLETED when
              the agent sends the session-end hook.
            </P>

            <H2>Session Detail View</H2>
            <P>
              Click any session to open the detail page. The right panel has four tabs:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Session</strong> &mdash; Full replay of the AI conversation with user prompts, agent responses, prompt-to-change timeline, and full diff view</Li>
              <Li><strong className="text-gray-200">AI Blame</strong> &mdash; Line-level attribution showing which prompt wrote each line of code (see <strong className="text-indigo-400">AI Blame</strong> docs)</Li>
              <Li><strong className="text-gray-200">Security</strong> &mdash; Secret and PII scan results for the session&apos;s code changes</Li>
            </ul>
            <P>
              The header also includes a purple <strong className="text-purple-400">Ask</strong> button
              that opens the Ask the Author panel for contextual Q&amp;A about the session
              (see <strong className="text-indigo-400">Ask the Author</strong> docs).
            </P>
            <P>
              The left panel shows commit info (real SHA hashes, HEAD range), linked PRs,
              agent/model info, session stats, and any existing review.
            </P>

            <H2>Filtering Sessions</H2>
            <P>
              Use the filter bar at the top of the Sessions page to filter by model, status
              (reviewed/unreviewed/flagged), agent, and repository.
            </P>

            <H2 id="reviewing-sessions">Reviewing Sessions</H2>
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
              in the audit trail and, if GitHub integration is active, update PR status checks in real-time.
            </P>

            <Callout type="tip">
              Set up a REQUIRE_REVIEW policy to automatically flag sessions that meet certain criteria
              (e.g. large changes, high cost, sensitive files) for mandatory human review.
            </Callout>

            <H2>Session Analytics</H2>
            <P>
              The sessions list includes an inline analytics summary bar showing key metrics
              for the current page of sessions: total cost, average cost, total tokens,
              average duration, tool call count, review rate, and approval rate.
            </P>

            <H2>PR-Grouped View</H2>
            <P>
              Toggle the &ldquo;By PR&rdquo; view to see sessions grouped by pull request.
              Each PR card shows:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">PR metadata</strong> &mdash; Number, title, state (open/merged/closed), branch info, author</Li>
              <Li><strong className="text-gray-200">Check status</strong> &mdash; CI/CD check results (success/failure/pending)</Li>
              <Li><strong className="text-gray-200">Aggregated stats</strong> &mdash; Total sessions, cost, tokens, and lines changed across all sessions in that PR</Li>
              <Li><strong className="text-gray-200">Review status</strong> &mdash; Overall review state (all approved, has rejections, has flags, pending)</Li>
            </ul>
            <P>
              Click any session within a PR group to view its full detail page.
            </P>

            <H2>Real-Time Updates</H2>
            <P>
              The sessions list has a live indicator in the top-right corner. When connected
              (green pulsing dot), new sessions and session updates are automatically
              reflected in the list without requiring a page refresh.
            </P>

            <H2>Bulk Review</H2>
            <P>
              Select multiple unreviewed sessions using checkboxes, then use the bulk action bar
              to approve, reject, or flag all selected sessions at once. The select-all checkbox
              applies only to sessions that haven&apos;t been reviewed yet.
            </P>

            <H2>Archiving Sessions</H2>
            <P>
              Sessions can be archived to declutter your active session list without permanently
              deleting data. Archived sessions are hidden from the default view but remain fully
              accessible.
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Archive</strong> &mdash; Click the archive icon on any session row, or select multiple sessions and use the bulk archive button. Admin role required.</Li>
              <Li><strong className="text-gray-200">View Archived</strong> &mdash; Toggle the &ldquo;Show Archived&rdquo; button in the session list header to switch between active and archived sessions.</Li>
              <Li><strong className="text-gray-200">Restore</strong> &mdash; From the archived view, select sessions and use the bulk restore button to move them back to the active list.</Li>
            </ul>
            <CodeBlock title="API">{`# Archive a session
PATCH /api/sessions/:id/archive  { "archived": true }

# Restore a session
PATCH /api/sessions/:id/archive  { "archived": false }

# Bulk archive/restore
PATCH /api/sessions/bulk/archive  { "sessionIds": [...], "archived": true }`}</CodeBlock>

            <H2 id="sharing-sessions">Sharing Sessions</H2>
            <P>
              Generate public share links for any session. Shared sessions are accessible without
              authentication &mdash; anyone with the link can view the full session replay, review status,
              diffs, and prompt timeline. Like CodePen, but for agent sessions.
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Create Share Link</strong> &mdash; Click the share icon on a session detail page. Origin generates a unique short URL.</Li>
              <Li><strong className="text-gray-200">Expiry</strong> &mdash; Share links can optionally expire. By default, links have no expiry.</Li>
              <Li><strong className="text-gray-200">Public Page</strong> &mdash; Shared sessions live at <code className="text-indigo-400">/s/:slug</code> and show the full session including metadata, transcript, diffs, prompt timeline, and review status.</Li>
            </ul>
            <CodeBlock title="API">{`# Create a share link
POST /api/sessions/:id/share
# Returns: { slug, url, expiresAt }

# View shared session (public, no auth)
GET /api/share/:slug`}</CodeBlock>
            <Callout type="tip">
              Use <code className="text-indigo-400">origin share &lt;sessionId&gt; --public</code> from the CLI
              to generate a public share link directly from the terminal.
            </Callout>
          </div>
        )}

        {/* ─── AI BLAME ─────────────────────────────────────────── */}
        {active === 'ai-blame' && (
          <div>
            <h1 id="ai-blame" className="text-2xl font-bold mb-2">AI Blame</h1>
            <P>
              AI Blame provides line-level attribution for AI-generated code. It tells you
              exactly which prompt (and which developer) caused each line of code to be written,
              similar to <code className="text-indigo-400">git blame</code> but for AI authorship.
            </P>

            <H2>How It Works</H2>
            <P>
              When Origin tracks a coding session, it records a mapping of each user prompt to
              the code changes it produced (via <strong className="text-gray-200">PromptChanges</strong> with unified diffs).
              AI Blame parses these diffs to build a line-by-line attribution map for every file.
            </P>
            <Callout type="info">
              Origin only attributes code written <em>after</em> installation. Lines that existed before{' '}
              <code className="text-indigo-400">origin init</code> will show as <code className="text-indigo-400">[HU]</code> (human),
              even if they were originally AI-generated.
            </Callout>
            <P>
              The algorithm walks through prompts in chronological order. For each prompt, it parses
              the unified diff to determine which lines were added. Later prompts override earlier ones
              for the same line numbers, giving you the final attribution.
            </P>

            <H2>Using AI Blame in the Dashboard</H2>
            <P>
              Open any session detail page and click the <strong className="text-gray-200">AI Blame</strong> tab.
              You will see:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">File Selector</strong> &mdash; Dropdown listing all files changed in the session. Select a file to view its blame.</Li>
              <Li><strong className="text-gray-200">Prompt Legend</strong> &mdash; Color-coded list of all prompts that touched the selected file, each with a unique color for visual identification.</Li>
              <Li><strong className="text-gray-200">Blame View</strong> &mdash; Line-by-line code display with colored left border indicating which prompt wrote each line. Hover over any line to see prompt details.</Li>
              <Li><strong className="text-gray-200">Ask Button</strong> &mdash; Each line has an &ldquo;Ask&rdquo; button that opens the Ask the Author panel pre-filled with context about that specific line.</Li>
            </ul>

            <H2>API Endpoint</H2>
            <CodeBlock title="GET /api/sessions/:id/blame">{`# Get blame for a specific file in a session
GET /api/sessions/:id/blame?file=src/components/App.tsx

# Response
{
  "sessionId": "abc-123",
  "file": "src/components/App.tsx",
  "lines": [
    {
      "lineNumber": 1,
      "content": "import React from 'react';",
      "promptIndex": 0,
      "promptText": "Create a new React component..."
    },
    ...
  ],
  "prompts": {
    "0": {
      "promptText": "Create a new React component...",
      "filesChanged": ["src/components/App.tsx"],
      "lineCount": 42
    }
  }
}`}</CodeBlock>

            <H2>How Attribution Is Calculated</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Unified diff parsing</strong> &mdash; Each prompt&apos;s diff is parsed to extract <code className="text-indigo-400">@@ -old,count +new,count @@</code> hunks</Li>
              <Li><strong className="text-gray-200">Line tracking</strong> &mdash; Only added lines (<code className="text-indigo-400">+</code> prefix) are tracked; removed lines are excluded</Li>
              <Li><strong className="text-gray-200">Last-write wins</strong> &mdash; If multiple prompts modify the same line, the last one is attributed</Li>
              <Li><strong className="text-gray-200">Full file coverage</strong> &mdash; Every added line across all prompts in the session is attributed</Li>
            </ul>

            <Callout type="tip">
              AI Blame is most useful for sessions with multiple prompts. For single-prompt sessions,
              all lines are attributed to that one prompt.
            </Callout>
          </div>
        )}

        {/* ─── ASK THE AUTHOR ──────────────────────────────────── */}
        {active === 'ask-author' && (
          <div>
            <h1 id="ask-author" className="text-2xl font-bold mb-2">Ask the Author</h1>
            <P>
              Ask the Author lets you ask questions about any coding session and get answers
              grounded in the actual conversation transcript and code changes. It&apos;s like
              having the AI agent explain why it wrote the code it did.
            </P>

            <H2>How It Works</H2>
            <P>
              When you ask a question, Origin loads the session&apos;s full transcript (the conversation
              between the developer and AI) along with all code diffs, and sends them to Claude
              as context. Claude then answers your question by referencing specific parts of the
              conversation and code changes.
            </P>

            <H2>Using Ask the Author</H2>
            <P>
              There are two ways to open the Ask panel:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Ask button in header</strong> &mdash; Click the purple &ldquo;Ask&rdquo; button in the session detail header to open a general Q&amp;A panel</Li>
              <Li><strong className="text-gray-200">Ask from AI Blame</strong> &mdash; Click the &ldquo;Ask&rdquo; button on any line in the AI Blame view. The question is pre-filled with context about that specific line, file, and prompt.</Li>
            </ul>

            <H2>Features</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Multi-turn conversations</strong> &mdash; Ask follow-up questions; the full conversation history is maintained</Li>
              <Li><strong className="text-gray-200">Suggestion chips</strong> &mdash; Quick-start questions like &ldquo;Why was this approach chosen?&rdquo; and &ldquo;What alternatives were considered?&rdquo;</Li>
              <Li><strong className="text-gray-200">Contextual answers</strong> &mdash; When opened from AI Blame, the AI knows which file, line, and prompt you&apos;re asking about</Li>
              <Li><strong className="text-gray-200">Transcript grounding</strong> &mdash; Answers reference specific prompts from the conversation that led to the code</Li>
            </ul>

            <H2>API Endpoint</H2>
            <CodeBlock title="POST /api/sessions/:id/ask">{`# Ask a question about a session
POST /api/sessions/:id/ask
Content-Type: application/json

{
  "question": "Why did the agent use a Map instead of a plain object here?",
  "context": {
    "file": "src/utils/cache.ts",
    "lineNumber": 42,
    "lineContent": "const cache = new Map<string, CacheEntry>();"
  },
  "history": []  // Previous Q&A turns for multi-turn conversation
}

# Response
{
  "answer": "Looking at the transcript, in prompt #3 the developer asked for...",
  "model": "claude-sonnet-4-20250514"
}`}</CodeBlock>

            <H2>Setup</H2>
            <P>
              Ask the Author requires the <code className="text-indigo-400">ANTHROPIC_API_KEY</code> environment
              variable to be set on the Origin server. Without it, the endpoint returns a 503 error.
            </P>
            <CodeBlock title="Environment variable">{`ANTHROPIC_API_KEY=sk-ant-api03-...`}</CodeBlock>

            <Callout type="info">
              The AI receives a truncated version of the transcript (up to 30,000 characters) and
              diffs (up to 15,000 characters) to stay within token limits. For very long sessions,
              the most recent parts of the conversation are prioritized.
            </Callout>
          </div>
        )}

        {/* ─── GIT NOTES ──────────────────────────────────────── */}
        {active === 'git-notes' && (
          <div>
            <h1 id="git-notes" className="text-2xl font-bold mb-2">Git Notes</h1>
            <P>
              Origin writes structured AI metadata as Git Notes on every commit created during
              a coding session. This makes AI authorship information portable and accessible
              from any Git client without cluttering commit history.
            </P>

            <H2>What Are Git Notes?</H2>
            <P>
              Git Notes are a built-in Git feature that lets you attach extra information to commits
              without modifying the commit itself. Origin uses a custom namespace
              (<code className="text-indigo-400">refs/notes/origin</code>) to avoid conflicts with
              other tools.
            </P>

            <H2>What Gets Written</H2>
            <P>Each Git Note contains a JSON object with the following fields:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">sessionId</strong> &mdash; The Origin session ID for the full audit trail</Li>
              <Li><strong className="text-gray-200">model</strong> &mdash; Which AI model was used (e.g. claude-sonnet-4-20250514)</Li>
              <Li><strong className="text-gray-200">promptCount</strong> &mdash; How many prompts were in the session</Li>
              <Li><strong className="text-gray-200">promptSummary</strong> &mdash; First 200 characters of the initial prompt</Li>
              <Li><strong className="text-gray-200">tokensUsed</strong> &mdash; Total tokens consumed</Li>
              <Li><strong className="text-gray-200">costUsd</strong> &mdash; Estimated cost in USD</Li>
              <Li><strong className="text-gray-200">toolCalls</strong> &mdash; Number of tool invocations</Li>
              <Li><strong className="text-gray-200">durationMs</strong> &mdash; Session duration in milliseconds</Li>
              <Li><strong className="text-gray-200">linesAdded / linesRemoved</strong> &mdash; Code change metrics</Li>
              <Li><strong className="text-gray-200">filesChanged</strong> &mdash; List of files modified</Li>
              <Li><strong className="text-gray-200">originUrl</strong> &mdash; Direct link to the session in the Origin dashboard</Li>
            </ul>

            <H2>When Notes Are Written</H2>
            <P>
              Notes are written automatically at the end of every coding session, right after the session
              data is uploaded to Origin. If a session produced multiple commits, each commit gets
              its own note with the same session metadata.
            </P>

            <H2>Reading Git Notes</H2>
            <CodeBlock title="View AI metadata for a commit">{`# Show Origin notes for a specific commit
git notes --ref=origin show HEAD

# Show notes for any commit SHA
git notes --ref=origin show abc1234

# List all commits that have Origin notes
git notes --ref=origin list

# Include notes in git log output
git log --notes=origin`}</CodeBlock>

            <H2>Sharing Notes</H2>
            <P>
              Git Notes are stored locally by default. To share them with your team, push and fetch
              the notes ref:
            </P>
            <CodeBlock title="Push and fetch Origin notes">{`# Push notes to remote
git push origin refs/notes/origin

# Fetch notes from remote
git fetch origin refs/notes/origin:refs/notes/origin

# Auto-fetch notes (add to .git/config)
[remote "origin"]
  fetch = +refs/notes/origin:refs/notes/origin`}</CodeBlock>

            <H2>Example Note</H2>
            <CodeBlock title="git notes --ref=origin show HEAD">{`{
  "origin": true,
  "sessionId": "ea74b665-88ef-48a6-bcc1-833d8e5cfc87",
  "model": "claude-sonnet-4-20250514",
  "promptCount": 12,
  "promptSummary": "Implement user authentication with JWT tokens...",
  "tokensUsed": 45230,
  "costUsd": 0.42,
  "toolCalls": 87,
  "durationMs": 342000,
  "linesAdded": 156,
  "linesRemoved": 23,
  "filesChanged": ["src/auth.ts", "src/middleware.ts", "src/routes/login.ts"],
  "originUrl": "https://getorigin.io/sessions/ea74b665..."
}`}</CodeBlock>

            <Callout type="tip">
              Git Notes are non-destructive &mdash; they never modify your commits or history.
              If a note fails to write (e.g. git is not available), it fails silently and never
              blocks the session from completing.
            </Callout>
          </div>
        )}

        {/* ─── AI AUTO-REVIEW ──────────────────────────────────── */}
        {active === 'ai-review' && (
          <div>
            <h1 id="ai-review" className="text-2xl font-bold mb-2">AI Auto-Review</h1>
            <P>
              Origin can automatically review AI coding sessions using Claude, providing
              instant risk assessments and flagging sessions that need human attention.
            </P>

            <H2>How It Works</H2>
            <P>
              When a coding session ends, Origin sends session data to Claude for analysis, including
              the actual code diff, prompt-to-change mappings, transcript, and session metrics.
              The AI reviewer evaluates security risks, scope risks, cost risks, code quality,
              policy compliance, and <strong className="text-gray-200">prompt-change alignment</strong> (whether
              the code changes match what was requested). Results appear as a purple-badged review on the session detail page.
            </P>

            <H2>Setup</H2>
            <P>
              Set the <code className="text-indigo-400">ANTHROPIC_API_KEY</code> environment
              variable on your Origin server. When this key is present, AI auto-review
              is enabled automatically for all organizations.
            </P>
            <CodeBlock title="Environment variable">{`ANTHROPIC_API_KEY=sk-ant-api03-...`}</CodeBlock>

            <H2>Review Statuses</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-green-400">APPROVED</strong> &mdash; Low risk, routine changes, appears safe</Li>
              <Li><strong className="text-amber-400">FLAGGED</strong> &mdash; Medium risk, needs human review (security files, high cost, many changes)</Li>
              <Li><strong className="text-red-400">REJECTED</strong> &mdash; High risk, potentially dangerous (auth/secrets, production data)</Li>
            </ul>

            <H2>Risk Levels</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Low</strong> &mdash; Standard development work</Li>
              <Li><strong className="text-gray-200">Medium</strong> &mdash; Some concerns worth noting</Li>
              <Li><strong className="text-gray-200">High</strong> &mdash; Significant risks identified</Li>
              <Li><strong className="text-gray-200">Critical</strong> &mdash; Immediate attention required</Li>
            </ul>

            <H2>What the AI Reviewer Checks</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Security risks</strong> &mdash; Checks the actual code diff for hardcoded secrets, backdoors, or suspicious additions</Li>
              <Li><strong className="text-gray-200">Scope risks</strong> &mdash; Detects when the diff contains changes beyond what was requested in the prompt</Li>
              <Li><strong className="text-gray-200">Cost risks</strong> &mdash; Flags abnormally high token/cost usage relative to the task</Li>
              <Li><strong className="text-gray-200">Code quality</strong> &mdash; Identifies poor patterns, errors, retries, and workarounds in the diff and transcript</Li>
              <Li><strong className="text-gray-200">Policy compliance</strong> &mdash; Verifies changes follow standard development practices</Li>
              <Li><strong className="text-gray-200">Prompt-change alignment</strong> &mdash; Compares each prompt to its resulting file changes to detect unexpected modifications</Li>
            </ul>

            <H2>Overriding AI Reviews</H2>
            <P>
              AI reviews can always be overridden by humans. When a session has an AI review,
              the review bar shows &ldquo;Override AI Review&rdquo; instead of &ldquo;Review This Session&rdquo;.
              The human review replaces the AI review.
            </P>

            <H2>Notifications</H2>
            <P>
              When the AI reviewer flags or rejects a session, org admins are automatically
              notified. Approved sessions do not generate notifications.
            </P>

            <Callout type="info">
              AI auto-review runs in the background and does not block the session end response.
              Reviews typically appear within a few seconds of the session ending.
            </Callout>
          </div>
        )}

        {/* ─── BUDGET & COST CONTROLS ──────────────────────────── */}
        {active === 'budget' && (
          <div>
            <h1 id="budget" className="text-2xl font-bold mb-2">Budget & Cost Controls</h1>
            <P>
              Origin provides budget management to help organizations control AI coding costs
              with monthly limits, spend alerts, and optional hard blocks.
            </P>

            <H2>Configuration</H2>
            <P>
              Navigate to <strong className="text-gray-200">Settings &rarr; Budget</strong> to configure:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Monthly Limit</strong> &mdash; Maximum USD spend per calendar month (0 = unlimited)</Li>
              <Li><strong className="text-gray-200">Block on Exceed</strong> &mdash; When enabled, new sessions are blocked once the limit is reached. Returns HTTP 429 to the CLI.</Li>
              <Li><strong className="text-gray-200">Alert Thresholds</strong> &mdash; Percentage thresholds (default: 50%, 80%, 90%, 100%) that trigger admin notifications</Li>
            </ul>

            <H2>Spend Dashboard</H2>
            <P>The budget tab shows:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Progress bar</strong> &mdash; Visual indicator of current spend vs limit</Li>
              <Li><strong className="text-gray-200">Spend by model</strong> &mdash; Cost breakdown by AI model</Li>
              <Li><strong className="text-gray-200">Spend by user</strong> &mdash; Cost breakdown by team member</Li>
              <Li><strong className="text-gray-200">Daily trend</strong> &mdash; Mini chart showing daily spend over the last 30 days</Li>
            </ul>

            <H2>How Blocking Works</H2>
            <P>
              When &ldquo;Block on Exceed&rdquo; is enabled and the monthly limit is reached,
              the <code className="text-indigo-400">POST /api/mcp/session/start</code> endpoint
              returns a 429 status code with a message explaining the budget has been exceeded.
              The CLI will display this message to the developer.
            </P>

            <H2>Alert Notifications</H2>
            <P>
              When spend crosses a threshold (e.g. 80% of limit), all org admins receive a
              notification. Each threshold only fires once per month &mdash; alerts reset
              when the budget configuration is updated.
            </P>

            <Callout type="warning">
              Budget limits apply per organization per calendar month. Costs are tracked in
              real-time as sessions end. Setting a limit to 0 disables budget enforcement.
            </Callout>
          </div>
        )}

        {/* ─── REAL-TIME STREAMING ─────────────────────────────── */}
        {active === 'realtime' && (
          <div>
            <h1 id="realtime" className="text-2xl font-bold mb-2">Real-Time Streaming</h1>
            <P>
              Origin supports real-time session event streaming using Server-Sent Events (SSE).
              The sessions page automatically connects to the stream and updates live.
            </P>

            <H2>How It Works</H2>
            <P>
              The sessions list page establishes an SSE connection to
              <code className="text-indigo-400"> GET /api/sessions/stream</code>. When sessions
              are created, updated, or ended, events are pushed to all connected clients
              for that organization.
            </P>

            <H2>Event Types</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">session:started</strong> &mdash; A new coding session has begun</Li>
              <Li><strong className="text-gray-200">session:updated</strong> &mdash; A session received incremental data (e.g. new tool calls)</Li>
              <Li><strong className="text-gray-200">session:ended</strong> &mdash; A session has completed</Li>
              <Li><strong className="text-gray-200">session:reviewed</strong> &mdash; A session was reviewed (approved/rejected/flagged)</Li>
            </ul>

            <H2>Connection Status</H2>
            <P>
              The green pulsing dot in the top-right of the Sessions page indicates the SSE
              connection is active. If the connection drops, it shows as a gray dot with
              &ldquo;Connecting...&rdquo;. The browser automatically reconnects.
            </P>

            <H2>API Usage</H2>
            <P>
              To consume the stream programmatically, connect to the SSE endpoint with
              your authentication token:
            </P>
            <CodeBlock title="SSE endpoint">{`GET /api/sessions/stream?token=YOUR_JWT_TOKEN

# Response: Server-Sent Events
data: {"type":"connected"}

data: {"type":"session:started","sessionId":"abc-123","orgId":"org-1","timestamp":"2025-01-01T00:00:00.000Z"}

data: {"type":"session:ended","sessionId":"abc-123","orgId":"org-1","data":{"costUsd":0.42},"timestamp":"2025-01-01T00:05:00.000Z"}`}</CodeBlock>

            <H2>Heartbeat</H2>
            <P>
              The server sends a heartbeat comment every 30 seconds to keep the connection
              alive through proxies and load balancers. These are SSE comments (lines starting
              with <code className="text-indigo-400">:</code>) and are ignored by EventSource clients.
            </P>

            <Callout type="tip">
              Events are scoped to your organization. You will only receive events for sessions
              belonging to repos in your org.
            </Callout>
          </div>
        )}

        {/* ─── SECRET & PII SCANNING ─────────────────────────── */}
        {active === 'secret-scanning' && (
          <div>
            <h1 id="secret-scanning" className="text-2xl font-bold mb-2">Secret & PII Scanning</h1>
            <P>
              Origin automatically scans code diffs at the end of every coding session for
              hardcoded secrets, API keys, credentials, and personally identifiable information (PII).
              Findings are displayed in the session detail and trigger notifications for critical issues.
            </P>

            <H2 id="detection-types">Detection Types</H2>
            <P>The scanner checks for the following patterns in added lines:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">AWS_SECRET</strong> &mdash; AWS access keys and secret keys (AKIA... pattern)</Li>
              <Li><strong className="text-gray-200">API_KEY</strong> &mdash; Generic API key assignments, GitHub tokens (ghp_...), Slack tokens (xox...)</Li>
              <Li><strong className="text-gray-200">PRIVATE_KEY</strong> &mdash; Private keys (-----BEGIN PRIVATE KEY-----)</Li>
              <Li><strong className="text-gray-200">CONNECTION_STRING</strong> &mdash; Database connection strings (mongodb://, postgres://)</Li>
              <Li><strong className="text-gray-200">JWT_TOKEN</strong> &mdash; Hardcoded JSON Web Tokens (eyJ...)</Li>
              <Li><strong className="text-gray-200">PASSWORD</strong> &mdash; Hardcoded passwords in code assignments</Li>
              <Li><strong className="text-gray-200">PII_EMAIL</strong> &mdash; Hardcoded email addresses in string literals</Li>
              <Li><strong className="text-gray-200">GENERIC_SECRET</strong> &mdash; Secret/token/auth key assignments with long values</Li>
            </ul>

            <H2>How It Works</H2>
            <P>
              When a session ends with a git diff, the scanner parses the unified diff to extract
              only <strong className="text-gray-200">added lines</strong> (lines starting with +).
              It skips comments and empty lines, then runs each detection regex against the content.
              Matched values are automatically redacted (first 4 characters + ****) before storage.
            </P>

            <H2>Severity Levels</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-red-400">Critical</strong> &mdash; AWS keys, private keys, connection strings</Li>
              <Li><strong className="text-orange-400">High</strong> &mdash; API keys, JWT tokens, hardcoded passwords</Li>
              <Li><strong className="text-amber-400">Medium</strong> &mdash; Generic secrets and tokens</Li>
              <Li><strong className="text-gray-400">Low</strong> &mdash; Hardcoded email addresses</Li>
            </ul>

            <H2>Viewing Findings</H2>
            <P>
              Open any session and click the <strong className="text-gray-200">Security</strong> tab
              to view findings. Each finding shows the detection type, severity, file path, line number,
              and redacted match. A green checkmark appears when no secrets are detected.
            </P>
            <P>
              Aggregate finding statistics are shown on the Insights page in the
              &ldquo;Secret Detections by Type&rdquo; chart and on the Dashboard as a stat card.
            </P>

            <H2>Notifications</H2>
            <P>
              When high or critical severity findings are detected, all organization admins receive
              a notification with a link to the session. The notification type
              is <code className="text-indigo-400">SECRET_DETECTED</code>.
            </P>

            <Callout type="tip">
              The scanner only analyzes added lines in diffs, not removed lines or existing code.
              This means it only catches secrets being introduced, not those being removed.
            </Callout>
          </div>
        )}

        {/* ─── COMPLIANCE REPORTS ─────────────────────────────── */}
        {active === 'compliance' && (
          <div>
            <h1 id="compliance" className="text-2xl font-bold mb-2">Compliance Reports</h1>
            <P>
              Generate comprehensive compliance reports covering session activity, policy violations,
              review coverage, and security findings. Reports can be filtered by date range and
              exported as JSON.
            </P>

            <H2 id="compliance-score">Compliance Score</H2>
            <P>
              The compliance score is a 0-100 metric calculated from four weighted factors:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Review Coverage (40%)</strong> &mdash; Percentage of sessions that have been reviewed</Li>
              <Li><strong className="text-gray-200">Violation Rate (30%)</strong> &mdash; Ratio of policy violations to total sessions (lower is better)</Li>
              <Li><strong className="text-gray-200">Secret Detection Rate (20%)</strong> &mdash; Ratio of secret findings to sessions (lower is better)</Li>
              <Li><strong className="text-gray-200">Base Score (10%)</strong> &mdash; Awarded for having the governance platform active</Li>
            </ul>
            <P>
              Score interpretation: <strong className="text-green-400">80+</strong> is excellent,{' '}
              <strong className="text-amber-400">60-79</strong> needs improvement,{' '}
              <strong className="text-red-400">below 60</strong> requires attention.
            </P>

            <H2>Generating Reports</H2>
            <P>
              Navigate to <strong className="text-gray-200">Reports</strong> in the sidebar. Select a date
              range using the date pickers or preset buttons (7 days, 30 days, Quarter, Year),
              then click &ldquo;Generate Report&rdquo;.
            </P>

            <H2>Report Sections</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Executive Summary</strong> &mdash; Total sessions, cost, violations, review rate, and secret findings</Li>
              <Li><strong className="text-gray-200">Policy Violations</strong> &mdash; Breakdown by policy type with visual chart</Li>
              <Li><strong className="text-gray-200">Review Coverage</strong> &mdash; Pie chart showing reviewed vs unreviewed sessions</Li>
              <Li><strong className="text-gray-200">Security Findings</strong> &mdash; Secret/PII detections by type</Li>
              <Li><strong className="text-gray-200">Model Usage</strong> &mdash; Sessions and cost per AI model</Li>
            </ul>

            <H2>Export</H2>
            <P>
              Click &ldquo;Download JSON&rdquo; to export the full report as a JSON file. The export includes
              all metrics, daily session activity, violation breakdowns, and model usage data.
            </P>

            <H2>API Access</H2>
            <CodeBlock title="Compliance Report API">{`# Generate report for date range
GET /api/reports/compliance?from=2025-01-01&to=2025-01-31

# Quick compliance score (last 30 days)
GET /api/reports/compliance/summary
# Response: { "score": 85 }`}</CodeBlock>

            <Callout type="info">
              The compliance score on the Dashboard is refreshed automatically and reflects the
              last 30 days of activity.
            </Callout>
          </div>
        )}

        {/* ─── ENHANCED ANALYTICS ─────────────────────────────── */}
        {active === 'analytics' && (
          <div>
            <h1 id="analytics" className="text-2xl font-bold mb-2">Enhanced Analytics</h1>
            <P>
              The Insights page provides comprehensive analytics across all AI coding operations
              with customizable date range filtering and multiple chart types.
            </P>

            <H2>Date Range Filtering</H2>
            <P>
              Use the date range controls at the top of the Insights page to filter all charts:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Preset buttons</strong> &mdash; Quick filters: 7d, 30d, 90d, Year</Li>
              <Li><strong className="text-gray-200">Custom range</strong> &mdash; Pick exact start and end dates</Li>
            </ul>
            <P>
              All charts update simultaneously when the date range changes.
              The stats API accepts <code className="text-indigo-400">from</code> and{' '}
              <code className="text-indigo-400">to</code> query parameters.
            </P>

            <H2>Available Charts</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">AI Authorship % Over Time</strong> &mdash; Percentage of commits authored by AI agents per day</Li>
              <Li><strong className="text-gray-200">Cost by Model</strong> &mdash; Total spend broken down by AI model</Li>
              <Li><strong className="text-gray-200">Cost Over Time</strong> &mdash; Daily cost trend chart</Li>
              <Li><strong className="text-gray-200">Lines Changed Over Time</strong> &mdash; Stacked area chart showing lines added (green) and removed (red) per day</Li>
              <Li><strong className="text-gray-200">Sessions by Repository</strong> &mdash; Session count per repo</Li>
              <Li><strong className="text-gray-200">Cost by Repository</strong> &mdash; Spend breakdown per repository</Li>
              <Li><strong className="text-gray-200">Top Engineers</strong> &mdash; Developers with most AI-assisted sessions</Li>
              <Li><strong className="text-gray-200">Activity by Hour</strong> &mdash; Session distribution across hours (0-23), useful for understanding work patterns</Li>
              <Li><strong className="text-gray-200">Session Quality</strong> &mdash; Donut chart of approved/rejected/flagged/pending reviews</Li>
              <Li><strong className="text-gray-200">Secret Detections</strong> &mdash; Findings by detection type</Li>
              <Li><strong className="text-gray-200">Policy Violations</strong> &mdash; Violations by policy type</Li>
              <Li><strong className="text-gray-200">Cost by User</strong> &mdash; Individual developer spend</Li>
              <Li><strong className="text-gray-200">Tokens Over Time</strong> &mdash; Daily token consumption trend</Li>
              <Li><strong className="text-gray-200">Duration Distribution</strong> &mdash; Session duration buckets (&lt;1m, 1-5m, 5-15m, 15m+)</Li>
            </ul>

            <H2>Dashboard Integration</H2>
            <P>
              Key metrics are surfaced directly on the Dashboard:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Compliance Score</strong> &mdash; Overall governance health (0-100)</Li>
              <Li><strong className="text-gray-200">Secrets Found</strong> &mdash; Total secret/PII findings across scanned diffs</Li>
              <Li>Standard KPIs: active agents, sessions this week, unreviewed count, estimated monthly cost</Li>
            </ul>

            <H2>API Access</H2>
            <CodeBlock title="Stats API with date filtering">{`# Default: last 30 days
GET /api/stats

# Custom date range
GET /api/stats?from=2025-01-01&to=2025-03-31

# Response includes all chart data:
# sessionsByDay, costByDay, tokensByDay, linesByDay,
# costByModel, costByRepo, sessionsByHour,
# secretsByType, violationsByType, qualityMetrics, etc.`}</CodeBlock>

            <Callout type="tip">
              Combine Insights with Compliance Reports for a complete governance picture.
              The Reports page generates exportable compliance snapshots while Insights provides
              interactive, drill-down analytics.
            </Callout>
          </div>
        )}

        {/* ─── LEADERBOARD ──────────────────────────────────── */}
        {active === 'leaderboard' && (
          <div>
            <h1 id="leaderboard" className="text-2xl font-bold mb-2">Leaderboard</h1>
            <P>
              The Leaderboard ranks team members by AI coding activity across your organization.
              Use it to identify power users, recognize high-quality contributors, and understand
              adoption patterns across your engineering team.
            </P>

            <H2>How It Works</H2>
            <P>
              Origin aggregates data from all coding sessions and reviews to compute rankings.
              The leaderboard queries session counts, lines of code changed, total cost,
              approval rates, and quality scores per user for a given time period.
            </P>

            <H2>Ranking Metrics</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Sessions</strong> &mdash; Total number of AI coding sessions completed. Higher counts indicate more active AI adoption.</Li>
              <Li><strong className="text-gray-200">Lines Changed</strong> &mdash; Combined lines added and removed across all sessions. Measures raw output volume.</Li>
              <Li><strong className="text-gray-200">Total Cost</strong> &mdash; Cumulative API cost across all sessions. Helps identify expensive usage patterns.</Li>
              <Li><strong className="text-gray-200">Approval Rate</strong> &mdash; Percentage of reviewed sessions that were approved. Indicates code quality and policy compliance.</Li>
              <Li><strong className="text-gray-200">Quality Score</strong> &mdash; Composite score combining approval rate, review coverage, and policy violation count.</Li>
            </ul>

            <H2>Time Periods</H2>
            <P>
              Filter rankings by time period: <strong className="text-gray-200">7 days</strong>, <strong className="text-gray-200">30 days</strong>,
              or <strong className="text-gray-200">all time</strong>. Use shorter periods to track recent activity and longer periods for overall contribution.
            </P>

            <H2>API</H2>
            <CodeBlock title="Leaderboard API">{`GET /api/leaderboard?period=30d&sort=sessions
# Query params: period (7d, 30d, all), sort (sessions, lines, cost, approvalRate, quality)`}</CodeBlock>

            <Callout type="tip">
              The Leaderboard is a great way to gamify AI adoption and recognize developers
              who produce high-quality AI-assisted code with strong approval rates.
            </Callout>
          </div>
        )}

        {/* ─── PROMPT LIBRARY ──────────────────────────────────── */}
        {active === 'prompts' && (
          <div>
            <h1 id="prompts" className="text-2xl font-bold mb-2">Prompt Library</h1>
            <P>
              The Prompt Library captures every prompt-to-code-change mapping across your organization.
              Search through prompts, see what files they changed, and analyze patterns in how your
              team uses AI coding tools.
            </P>

            <H2>How It Works</H2>
            <P>
              When a coding session ends, Origin creates <code className="text-indigo-400">PromptChange</code> records
              that link individual prompts to the files they modified and the diffs they produced.
              This gives you a searchable database of every AI interaction and its outcome.
            </P>

            <H2>Search View</H2>
            <P>The default view lets you search and filter prompts:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Text Search</strong> &mdash; Search prompt text across all sessions</Li>
              <Li><strong className="text-gray-200">Model Filter</strong> &mdash; Filter by AI model (Claude Sonnet, Opus, GPT-4o, Gemini)</Li>
              <Li><strong className="text-gray-200">Repository Filter</strong> &mdash; Narrow results to a specific repo</Li>
            </ul>
            <P>
              Each result shows the prompt text (truncated to 200 chars), model used, review status,
              repo name, author, files changed count, cost, and timestamp. Click a prompt to view the
              full session detail.
            </P>

            <H2>Pattern Analysis View</H2>
            <P>
              Switch to the &ldquo;Patterns&rdquo; tab to see aggregate analysis. Origin categorizes
              prompts into types using keyword matching:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Bug Fix</strong> &mdash; Prompts containing fix, bug, error, issue, broken</Li>
              <Li><strong className="text-gray-200">New Feature</strong> &mdash; Prompts with add, create, implement, build, new</Li>
              <Li><strong className="text-gray-200">Refactoring</strong> &mdash; Prompts with refactor, clean, restructure, reorganize</Li>
              <Li><strong className="text-gray-200">Testing</strong> &mdash; Prompts with test, spec, coverage, assert</Li>
              <Li><strong className="text-gray-200">Documentation</strong> &mdash; Prompts with document, readme, comment, explain</Li>
            </ul>
            <P>
              For each category, you see the count and <strong className="text-gray-200">approval rate</strong> &mdash;
              the percentage of prompts in that category whose sessions were approved. This helps identify
              which types of AI tasks produce the best outcomes.
            </P>

            <H2>API</H2>
            <CodeBlock title="Prompts API">{`# Search prompts
GET /api/prompts?q=authentication&model=claude-code&repoId=...&limit=20&offset=0

# Get pattern analysis
GET /api/prompts/patterns`}</CodeBlock>

            <Callout type="info">
              The Prompt Library is powered by PromptChange records created when sessions end.
              If the library is empty, make sure session tracking is configured via the CLI or MCP server.
            </Callout>
          </div>
        )}

        {/* ─── MODEL COMPARISON ────────────────────────────────── */}
        {active === 'model-comparison' && (
          <div>
            <h1 id="model-comparison" className="text-2xl font-bold mb-2">Model Comparison</h1>
            <P>
              Compare AI model performance across your organization. See which models
              are most cost-effective, produce the highest-quality code, and best fit
              different task types.
            </P>

            <H2>How It Works</H2>
            <P>
              Origin aggregates session data by model to compute comparative statistics.
              Every session records the model used (e.g. <code className="text-indigo-400">claude-code</code>,
              <code className="text-indigo-400">cursor</code>, <code className="text-indigo-400">copilot</code>),
              along with cost, duration, token usage, and review outcomes. The comparison page
              queries these aggregations side by side.
            </P>

            <H2>Comparison Metrics</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Total Sessions</strong> &mdash; How many sessions used each model</Li>
              <Li><strong className="text-gray-200">Average Cost</strong> &mdash; Mean cost per session for the model</Li>
              <Li><strong className="text-gray-200">Average Duration</strong> &mdash; Mean session duration (how long it takes to complete tasks)</Li>
              <Li><strong className="text-gray-200">Token Usage</strong> &mdash; Average input and output tokens per session</Li>
              <Li><strong className="text-gray-200">Approval Rate</strong> &mdash; Percentage of reviewed sessions approved for each model</Li>
              <Li><strong className="text-gray-200">Lines Changed</strong> &mdash; Average code output per session</Li>
            </ul>

            <H2>Trend Analysis</H2>
            <P>
              The comparison includes a timeline chart showing model usage trends over time.
              Track adoption shifts as your team experiments with different models, and correlate
              model switches with changes in cost or quality metrics.
            </P>

            <H2>API</H2>
            <CodeBlock title="Model Comparison API">{`GET /api/models/comparison
# Returns: per-model stats (sessions, avgCost, avgDuration, avgTokens, approvalRate)
#          and daily trend data for charts`}</CodeBlock>

            <Callout type="tip">
              Use Model Comparison to inform your MODEL_ALLOWLIST policy. If a model consistently
              produces low-quality output (low approval rate), consider restricting it.
            </Callout>
          </div>
        )}

        {/* ─── PULL REQUESTS ──────────────────────────────────── */}
        {active === 'pull-requests' && (
          <div>
            <h1 id="pull-requests" className="text-2xl font-bold mb-2">Pull Request Checks</h1>
            <P>
              Origin integrates with GitHub to post governance status checks on pull requests.
              When a PR contains AI-authored commits, Origin links the relevant coding sessions,
              evaluates policies, and posts a pass/fail check that controls whether the PR can be merged.
            </P>

            <H2>How It Works</H2>
            <div className="space-y-1 mb-4">
              <Step n={1} title="Developer pushes code">
                After coding with an AI agent, the developer pushes commits to a GitHub branch and opens a PR.
              </Step>
              <Step n={2} title="Origin receives the webhook">
                GitHub sends a <code className="text-indigo-400">push</code> and <code className="text-indigo-400">pull_request</code> event
                to Origin. Commits are matched to AI sessions by SHA.
              </Step>
              <Step n={3} title="Policy engine evaluates">
                Origin runs all active policies against the linked sessions: cost limits, file restrictions,
                model allowlists, and review requirements.
              </Step>
              <Step n={4} title="Status check posted">
                Origin posts an <code className="text-indigo-400">origin/ai-governance</code> commit status on the PR.
                A summary comment is also posted with a table of linked sessions, costs, and violations.
              </Step>
              <Step n={5} title="Merge gating">
                With GitHub branch protection enabled, the PR cannot be merged if the check fails.
                Admin reviews the flagged sessions in Origin, approves them, and the check updates to green.
              </Step>
            </div>

            <H2>Check Status Logic</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-green-400">Success</strong> &mdash; All linked sessions are approved (or no sessions linked)</Li>
              <Li><strong className="text-amber-400">Pending</strong> &mdash; Sessions exist but some are unreviewed</Li>
              <Li><strong className="text-red-400">Failure</strong> &mdash; Any session is rejected or flagged, or policy violations detected</Li>
            </ul>

            <H2>PR Summary Comment</H2>
            <P>
              Origin posts (or updates) a single comment on the PR with a session summary table:
            </P>
            <ul className="space-y-2 mb-4">
              <Li>Link to each session in Origin (View button)</Li>
              <Li>Agent name and model used</Li>
              <Li>Cost and token count per session</Li>
              <Li>Turn count &mdash; number of prompts/turns in each session</Li>
              <Li>Duration and files changed per session</Li>
              <Li>Review status (approved, flagged, pending)</Li>
              <Li>Total cost and lines added across all sessions</Li>
              <Li>Human corrections count &mdash; commits not linked to any AI session</Li>
              <Li>Policy violation details with fix hints</Li>
            </ul>
            <P>
              The comment header shows an aggregate summary:
              <code className="text-indigo-400 text-xs"> 3 sessions · 47 agent turns · 2 human corrections</code>.
              Below the table, a per-session breakdown shows prompt counts and line contributions.
            </P>

            <H2>Dashboard View</H2>
            <P>
              The Pull Requests page shows all PRs with filter tabs: All, Open, Passing, Failing, Pending.
              Each PR card shows the title, repo, author, branch, commit count, session count, and check status.
              Click &ldquo;Details&rdquo; to drill into linked sessions. Click &ldquo;Re-check&rdquo; to recompute the status.
            </P>

            <H2>API</H2>
            <CodeBlock title="Pull Requests API">{`# List all PRs with session analysis
GET /api/pull-requests

# Recheck a PR (recompute status after review changes)
POST /api/pull-requests/:id/recheck

# Analyze a PR by URL (used by origin review-pr CLI command)
GET /api/pull-requests/review?url=https://github.com/org/repo/pull/42`}</CodeBlock>

            <Callout type="warning">
              PR/MR checks require a GitHub or GitLab integration configured in Settings &rarr; Integrations
              with &ldquo;Post Checks&rdquo; and &ldquo;Post Comments&rdquo; enabled. Webhooks must be active on the repo.
            </Callout>
          </div>
        )}

        {/* ─── TRAILS ─────────────────────────────────────────── */}
        {active === 'trails' && (
          <div>
            <h1 id="trails" className="text-2xl font-bold mb-2">Trails</h1>
            <P>
              Trails let you group coding sessions by feature, project, or initiative.
              Track the total cost, effort, and progress of AI-assisted work at the feature level
              rather than individual session level.
            </P>

            <H2>How It Works</H2>
            <P>
              A Trail is a named container with a status lifecycle (active, review, done, paused),
              priority level, and labels. You add coding sessions to a trail, and Origin aggregates
              the cost, tokens, lines changed, and time spent across all sessions in that trail.
            </P>

            <H2>Trail Properties</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Name & Description</strong> &mdash; Human-readable identifier for the feature or initiative</Li>
              <Li><strong className="text-gray-200">Status</strong> &mdash; Lifecycle state: <code className="text-indigo-400">active</code>, <code className="text-indigo-400">review</code>, <code className="text-indigo-400">done</code>, <code className="text-indigo-400">paused</code></Li>
              <Li><strong className="text-gray-200">Priority</strong> &mdash; Urgency level for sorting and filtering</Li>
              <Li><strong className="text-gray-200">Labels</strong> &mdash; Tags for categorization (e.g. &ldquo;frontend&rdquo;, &ldquo;security&rdquo;, &ldquo;tech-debt&rdquo;)</Li>
              <Li><strong className="text-gray-200">Sessions</strong> &mdash; Linked coding sessions with aggregated metrics</Li>
            </ul>

            <H2>Use Cases</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Feature cost tracking</strong> &mdash; How much did AI assistance cost to build the auth system?</Li>
              <Li><strong className="text-gray-200">Sprint planning</strong> &mdash; Group sessions by sprint to measure AI contribution per cycle</Li>
              <Li><strong className="text-gray-200">Incident response</strong> &mdash; Track all AI sessions related to a production incident fix</Li>
            </ul>

            <H2>API</H2>
            <CodeBlock title="Trails API">{`# List trails
GET /api/trails?status=active&label=frontend

# Create a trail
POST /api/trails
{ "name": "User Auth System", "description": "JWT auth + RBAC", "priority": "high", "labels": ["backend", "security"] }

# Add sessions to trail
POST /api/trails/:id/sessions
{ "sessionIds": ["session-uuid-1", "session-uuid-2"] }`}</CodeBlock>

            <Callout type="info">
              Trails are accessible from Settings &rarr; Trails tab. You can also manage trails via
              the CLI with <code className="text-indigo-400">origin trail</code> commands.
            </Callout>
          </div>
        )}

        {/* ─── MACHINES ───────────────────────────────────────── */}
        {active === 'machines' && (
          <div>
            <h1 id="machines" className="text-2xl font-bold mb-2">Machines</h1>
            <P>
              The Machines page shows all client devices registered with Origin.
              Track which developer machines are running AI coding tools, what software
              is installed, and enforce machine-level policies.
            </P>

            <H2>How It Works</H2>
            <P>
              When a developer runs <code className="text-indigo-400">origin init</code> on their machine,
              the CLI detects installed tools (git, node, python, docker, etc.) and registers the machine
              with Origin. The machine record includes a unique machine ID, hostname, and tool inventory.
              Machines are updated on each CLI interaction and show a &ldquo;last seen&rdquo; timestamp.
            </P>

            <H2>Machine Data</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Hostname</strong> &mdash; The machine&apos;s network hostname (e.g. &ldquo;artem-mbp.local&rdquo;)</Li>
              <Li><strong className="text-gray-200">Machine ID</strong> &mdash; Unique identifier generated at registration</Li>
              <Li><strong className="text-gray-200">Detected Tools</strong> &mdash; Software found on the machine (git, node, python, docker, kubectl, etc.)</Li>
              <Li><strong className="text-gray-200">Last Seen</strong> &mdash; Timestamp of the most recent CLI interaction from this machine</Li>
            </ul>

            <H2>Machine-Scoped Policies</H2>
            <P>
              Policy rules can be scoped to specific machines using the <code className="text-indigo-400">machineId</code> scope.
              This lets you enforce different rules on CI runners vs developer laptops. For example:
            </P>
            <ul className="space-y-2 mb-4">
              <Li>Block GPT-4 usage on CI machines while allowing it on dev workstations</Li>
              <Li>Require review for all sessions from a shared CI runner</Li>
              <Li>Set lower cost limits on production-access machines</Li>
            </ul>

            <H2>API</H2>
            <CodeBlock title="Machines API">{`# List machines
GET /api/machines

# Get machine detail with policy rules
GET /api/machines/:id`}</CodeBlock>
          </div>
        )}

        {/* ─── PERSONAL INSIGHTS ─────────────────────────────── */}
        {active === 'personal-insights' && (
          <div>
            <h1 id="personal-insights" className="text-2xl font-bold mb-2">Personal Insights</h1>
            <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-lg p-4 mb-6">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-indigo-400 text-lg">🚧</span>
                <span className="text-sm font-semibold text-indigo-300">Coming Soon</span>
              </div>
              <P>
                Personal Insights is an upcoming feature that provides per-developer analytics
                and AI-usage patterns. Track your personal coding efficiency, AI collaboration
                habits, and improvement over time.
              </P>
            </div>

            <H2>Planned Features</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Developer Dashboard</strong> &mdash; Personal view of your AI-assisted sessions, costs, and productivity metrics</Li>
              <Li><strong className="text-gray-200">Prompt Effectiveness</strong> &mdash; Analysis of which prompts lead to successful outcomes vs. repeated iterations</Li>
              <Li><strong className="text-gray-200">Code Acceptance Rate</strong> &mdash; Percentage of AI-generated code that passes review without modification</Li>
              <Li><strong className="text-gray-200">Model Preferences</strong> &mdash; Which AI models you use most and their effectiveness by task type</Li>
              <Li><strong className="text-gray-200">Time Savings Estimate</strong> &mdash; Estimated hours saved through AI-assisted development</Li>
              <Li><strong className="text-gray-200">Weekly Digest</strong> &mdash; Automated summary of your AI coding activity sent via email or Slack</Li>
            </ul>

            <H2>Skill Analysis</H2>
            <P>
              Personal Insights will categorize your AI usage patterns to help you improve your
              AI-assisted development workflow:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Prompt Engineering</strong> &mdash; Track how your prompts improve over time based on session outcomes</Li>
              <Li><strong className="text-gray-200">Domain Expertise</strong> &mdash; Identify areas where you leverage AI most (frontend, backend, testing, DevOps)</Li>
              <Li><strong className="text-gray-200">Collaboration Patterns</strong> &mdash; Multi-turn vs single-prompt sessions, tool usage frequency</Li>
              <Li><strong className="text-gray-200">Security Awareness</strong> &mdash; Track secret detection hits and policy compliance over time</Li>
            </ul>

            <H2>API Access (Planned)</H2>
            <CodeBlock title="Personal Insights API (coming soon)">{`# Get your personal insights
GET /api/insights/me

# Get insights for a specific developer (admin only)
GET /api/insights/users/:userId

# Get prompt effectiveness analysis
GET /api/insights/me/prompts?from=2025-01-01&to=2025-03-31`}</CodeBlock>

            <Callout type="info">
              Personal Insights will be available for all team members. Organization admins
              will have access to aggregated team-level insights while individual data
              remains private to each developer.
            </Callout>
          </div>
        )}

        {/* ─── WEBHOOKS ────────────────────────────────────────── */}
        {active === 'webhooks' && (
          <div>
            <h1 id="webhooks" className="text-2xl font-bold mb-2">Webhooks</h1>
            <P>
              Webhooks allow GitHub to push events (commits, pull requests) to Origin in real-time.
              When you import repos via &ldquo;Import from GitHub&rdquo;, webhooks are created automatically.
              This section covers manual webhook setup for advanced use cases.
            </P>

            <H2>How Webhooks Work</H2>
            <P>
              Each webhook has a unique URL and a shared secret for HMAC-SHA256 signature verification.
              When GitHub sends an event, Origin verifies the signature before processing.
            </P>

            <H2>Automatic Setup (Recommended)</H2>
            <P>
              Use <strong className="text-gray-200">Repositories &rarr; Import from GitHub</strong>. Origin creates webhooks
              on GitHub automatically using the GitHub API. No manual configuration needed.
            </P>

            <H2>Manual Setup</H2>
            <P>For repos that can&apos;t use auto-import (e.g. self-hosted Git, fine-grained permissions):</P>

            <Step n={1} title="Create webhook in Origin">
              <p>Go to the repo detail page and scroll to &ldquo;GitHub Webhooks&rdquo;. Click &ldquo;Create Webhook&rdquo;. Copy the webhook URL and secret (shown only once).</p>
            </Step>
            <Step n={2} title="Add webhook on GitHub">
              <p>In your GitHub repo, go to <strong className="text-gray-200">Settings &rarr; Webhooks &rarr; Add webhook</strong>:</p>
              <ul className="space-y-1 mt-2 ml-4">
                <Li><strong className="text-gray-200">Payload URL</strong>: Paste the webhook URL from Origin</Li>
                <Li><strong className="text-gray-200">Content type</strong>: <code className="text-indigo-400">application/json</code></Li>
                <Li><strong className="text-gray-200">Secret</strong>: Paste the secret from Origin</Li>
                <Li><strong className="text-gray-200">Events</strong>: Select &ldquo;Let me select individual events&rdquo; &rarr; check <code className="text-indigo-400">Pushes</code> and <code className="text-indigo-400">Pull requests</code></Li>
              </ul>
            </Step>

            <H2>Supported Events</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">push</strong> &mdash; Creates commit records in Origin. Duplicate SHAs are automatically skipped.</Li>
              <Li><strong className="text-gray-200">pull_request</strong> &mdash; Creates/updates PR records. Triggers status checks and comment posting (if integration configured).</Li>
              <Li><strong className="text-gray-200">ping</strong> &mdash; GitHub sends this on webhook creation. Origin responds with &ldquo;pong&rdquo;.</Li>
            </ul>

            <H2>Webhook URL Format</H2>
            <CodeBlock>{`https://your-origin-instance.com/api/webhooks/github/{repoId}`}</CodeBlock>
            <P>
              The <code className="text-indigo-400">repoId</code> is the Origin repository ID. Each repo has its own
              webhook endpoint with its own secret.
            </P>

            <H2>Security</H2>
            <ul className="space-y-2 mb-4">
              <Li>Webhook secrets are 256-bit random hex strings</Li>
              <Li>Signatures are verified using <code className="text-indigo-400">HMAC-SHA256</code> with <code className="text-indigo-400">timingSafeEqual</code> (constant-time comparison to prevent timing attacks)</Li>
              <Li>Requests without valid signatures are rejected with 401</Li>
              <Li>Webhook endpoints do not require Bearer token auth &mdash; they use HMAC verification instead</Li>
            </ul>
          </div>
        )}

        {/* ─── CLI ─────────────────────────────────────────────── */}
        {active === 'cli' && (
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
                <P>Review a coding session from the command line. Approve, reject, or flag sessions with an optional note.</P>
                <CodeBlock>{`origin review abc123 --approve
origin review abc123 --reject --note "Security concern"
origin review abc123 --flag`}</CodeBlock>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin intent-review</code>
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
            </div>
          </div>
        )}

        {/* ─── MCP SERVER ──────────────────────────────────────── */}
        {active === 'mcp' && (
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
        )}

        {/* ─── API REFERENCE ───────────────────────────────────── */}
        {active === 'api' && (
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
        )}

      </div>
    </div>
    </div>
    <ChatWidget
      endpoint="/api/chat/docs"
      title="Docs Assistant"
      placeholder="Ask about Origin setup, policies, CLI..."
      welcomeMessage="Hi! I can help answer questions about the Origin platform. What would you like to know?"
    />
    </>
  );
}
