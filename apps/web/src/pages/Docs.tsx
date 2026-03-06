import React, { useState } from 'react';
import ChatWidget from '../components/ChatWidget';

type Section =
  | 'overview'
  | 'quickstart'
  | 'integrations'
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
  | 'analytics';

const SECTIONS: { key: Section; label: string; group?: string }[] = [
  { key: 'overview', label: 'Overview', group: 'Getting Started' },
  { key: 'quickstart', label: 'Quick Start' },
  { key: 'session-tracking', label: 'Session Tracking', group: 'Setup Guides' },
  { key: 'integrations', label: 'GitHub Integration' },
  { key: 'repos', label: 'Repositories' },
  { key: 'agents', label: 'Agents' },
  { key: 'policies', label: 'Policies' },
  { key: 'settings', label: 'Settings & API Keys' },
  { key: 'rbac', label: 'Team & Roles' },
  { key: 'dashboard', label: 'Dashboard', group: 'Features' },
  { key: 'sessions', label: 'Sessions & Reviews' },
  { key: 'ai-review', label: 'AI Auto-Review' },
  { key: 'budget', label: 'Budget & Cost Controls' },
  { key: 'realtime', label: 'Real-Time Streaming' },
  { key: 'secret-scanning', label: 'Secret & PII Scanning' },
  { key: 'compliance', label: 'Compliance Reports' },
  { key: 'analytics', label: 'Enhanced Analytics' },
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
                  onClick={() => setActive(s.key)}
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
                <strong className="text-gray-200">Integrations</strong> &mdash; Connect to GitHub for auto-discovery
                of repos, automatic webhook setup, PR status checks, and session summary comments.
              </Li>
              <Li>
                <strong className="text-gray-200">Reviews</strong> &mdash; Every AI session can be
                reviewed (approved, rejected, flagged) by a human. Unreviewed sessions are tracked.
              </Li>
            </ul>

            <H2>Architecture</H2>
            <P>Origin is a monorepo with four packages:</P>
            <ul className="space-y-2 mb-4">
              <Li><code className="text-indigo-400">apps/api</code> &mdash; Express + Prisma backend (REST API, SQLite)</Li>
              <Li><code className="text-indigo-400">apps/web</code> &mdash; React + Vite + Tailwind dashboard</Li>
              <Li><code className="text-indigo-400">packages/cli</code> &mdash; Command-line tool for developers</Li>
              <Li><code className="text-indigo-400">packages/mcp-server</code> &mdash; MCP server for real-time policy enforcement in Claude Code / Cursor</Li>
            </ul>

            <H2>Recommended Setup Order</H2>
            <P>Follow this order for the smoothest onboarding experience:</P>
            <div className="space-y-1 mb-4">
              <Step n={1} title="Connect GitHub Integration">
                Go to Settings &rarr; Integrations and add your GitHub Personal Access Token.
              </Step>
              <Step n={2} title="Import Repositories">
                Go to Repositories &rarr; &ldquo;Import from GitHub&rdquo; to auto-discover and import repos with one click.
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

        {/* ─── QUICK START ─────────────────────────────────────── */}
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
            <CodeBlock>{`git clone https://github.com/dolobanko/origin-v2.git
cd origin-v2
pnpm install`}</CodeBlock>

            <H3>2. Set up the database</H3>
            <CodeBlock>{`cd apps/api
cp .env.example .env
npx prisma db push
npx tsx prisma/seed.ts`}</CodeBlock>
            <P>
              This creates an SQLite database with demo data including a sample organization,
              users, repositories, sessions, and policies.
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
            <P>Other demo users:</P>
            <CodeBlock>{`sarah@origin.dev   (ADMIN)
marcus@origin.dev  (MEMBER)
elena@origin.dev   (MEMBER)
david@origin.dev   (VIEWER)
All passwords: password123`}</CodeBlock>

            <H3>5. Connect GitHub (Recommended)</H3>
            <P>
              Go to <strong className="text-gray-200">Settings &rarr; Integrations</strong> and add a GitHub
              Personal Access Token. Then go to <strong className="text-gray-200">Repositories &rarr; Import from GitHub</strong> to
              auto-import repos with webhooks. See the <strong className="text-gray-200">GitHub Integration</strong> guide for full details.
            </P>

            <H3>6. Enable Session Tracking (Recommended)</H3>
            <P>
              To capture AI coding sessions (prompts, transcripts, diffs, cost), install the Origin CLI and
              enable hooks for your AI agent:
            </P>
            <CodeBlock>{`npm i -g @anthropic/origin-cli
origin login
origin init
cd your-project && origin enable`}</CodeBlock>
            <P>
              This installs lightweight hooks into your agent (Claude Code, Cursor, or Gemini CLI) that
              automatically track every session. See the <strong className="text-gray-200">Session Tracking</strong> guide
              for full details and manual configuration.
            </P>

            <H3>Production Deployment</H3>
            <P>
              Origin ships with a Dockerfile and Fly.io configuration. To deploy:
            </P>
            <CodeBlock>{`# Install flyctl and authenticate
fly auth login

# Deploy (first time: fly launch)
fly deploy`}</CodeBlock>
            <P>
              The deployment runs <code className="text-indigo-400">prisma db push</code> automatically
              before starting the server. SQLite data is persisted on a Fly volume at <code className="text-indigo-400">/data</code>.
            </P>
          </div>
        )}

        {/* ─── SESSION TRACKING ────────────────────────────────── */}
        {active === 'session-tracking' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Session Tracking</h1>
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

            <H2>Prerequisites</H2>
            <P>Before enabling session tracking, make sure you have:</P>
            <ul className="space-y-1 ml-4 mb-4">
              <Li>Installed the Origin CLI: <code className="text-indigo-400">npm i -g @anthropic/origin-cli</code></Li>
              <Li>Logged in: <code className="text-indigo-400">origin login</code></Li>
              <Li>Registered your machine: <code className="text-indigo-400">origin init</code></Li>
            </ul>

            <H2>Quick Setup</H2>
            <P>
              From inside your project directory (a git repo), run:
            </P>
            <CodeBlock title="Terminal">{`cd your-project
origin enable`}</CodeBlock>
            <P>
              That&rsquo;s it. Origin auto-detects which agents are configured in this repo and installs
              hooks for all of them. If no agent config is found, it defaults to Claude Code.
            </P>

            <H3>Specify a Single Agent</H3>
            <P>
              To install hooks for only one agent:
            </P>
            <CodeBlock title="Terminal">{`origin enable --agent claude-code
origin enable --agent cursor
origin enable --agent gemini`}</CodeBlock>

            <Callout type="tip">
              <code className="text-indigo-400">origin enable</code> installs hooks at the <strong className="text-gray-200">project level</strong>{' '}
              (e.g. <code className="text-indigo-400">.claude/settings.json</code> in your repo root). You can also install hooks at the{' '}
              <strong className="text-gray-200">user level</strong> (<code className="text-indigo-400">~/.claude/settings.json</code>) to
              track sessions across all your projects. Copy the hook config shown below into your global settings file.
            </Callout>

            <H2>Supported Agents</H2>

            <H3>Claude Code</H3>
            <P>
              Hooks are installed in <code className="text-indigo-400">.claude/settings.json</code> using
              Claude Code&rsquo;s native hooks API. Events captured:
            </P>
            <ul className="space-y-1 ml-4 mb-3">
              <Li><code className="text-indigo-400">SessionStart</code> — session created in Origin, tracking begins</Li>
              <Li><code className="text-indigo-400">UserPromptSubmit</code> — captures the actual user prompt</Li>
              <Li><code className="text-indigo-400">Stop</code> — parses transcript, extracts files &amp; tokens, sends incremental update</Li>
              <Li><code className="text-indigo-400">SessionEnd</code> — finalizes session with duration, cost estimate, and full transcript</Li>
            </ul>
            <CodeBlock title=".claude/settings.json">{`{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "origin hooks claude-code session-start" }] }
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

            <H2>What Gets Captured</H2>
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
            <h1 className="text-2xl font-bold mb-2">GitHub Integration</h1>
            <P>
              Connect GitHub to enable automatic repo discovery, one-click import with webhook setup,
              PR status checks, and AI governance comments on pull requests.
            </P>

            <H2>Setup Guide</H2>

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

        {/* ─── REPOSITORIES ────────────────────────────────────── */}
        {active === 'repos' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Repositories</h1>
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

            <H2>Adding a Repository Manually</H2>
            <P>Click &ldquo;Add Repository&rdquo; and fill in:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Name</strong> &mdash; A display name for the repo</Li>
              <Li><strong className="text-gray-200">Path</strong> &mdash; Local filesystem path (e.g. <code className="text-indigo-400">/home/user/my-project</code>) or GitHub URL (e.g. <code className="text-indigo-400">github.com/org/repo</code>)</Li>
              <Li><strong className="text-gray-200">Provider</strong> &mdash; &ldquo;Local&rdquo; for filesystem repos, &ldquo;GitHub&rdquo; for remote</Li>
            </ul>
            <P>
              Manual repos require you to set up webhooks separately if you want push/PR event tracking.
              See the <strong className="text-gray-200">Webhooks</strong> section for details.
            </P>

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
            <h1 className="text-2xl font-bold mb-2">Agents</h1>
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
              <Li><strong className="text-gray-200">Slug</strong> &mdash; Unique machine-readable identifier. Examples: <code className="text-indigo-400">claude-code</code>, <code className="text-indigo-400">cursor-ai</code>, <code className="text-indigo-400">copilot</code>. This is used in API calls and policy rules.</Li>
              <Li><strong className="text-gray-200">Model</strong> &mdash; The default AI model this agent uses. Examples: <code className="text-indigo-400">claude-sonnet-4-20250514</code>, <code className="text-indigo-400">gpt-4o</code>, <code className="text-indigo-400">claude-opus-4-20250514</code></Li>
              <Li><strong className="text-gray-200">Description</strong> (optional) &mdash; A brief description of the agent&apos;s purpose or team.</Li>
            </ul>

            <H2>Recommended Agent Setup</H2>
            <P>Create one agent per AI tool your team uses. Here are common configurations:</P>

            <CodeBlock title="Example: Claude Code">{`Name:        Claude Code
Slug:        claude-code
Model:       claude-sonnet-4-20250514
Description: Primary AI coding assistant for backend team`}</CodeBlock>

            <CodeBlock title="Example: Cursor">{`Name:        Cursor AI
Slug:        cursor-ai
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
            <h1 className="text-2xl font-bold mb-2">Policies</h1>
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
              <Li><strong className="text-gray-200">Session start (server)</strong> &mdash; MODEL_ALLOWLIST policies are checked. If the model is not allowed and action is &ldquo;block&rdquo;, the session is rejected with HTTP 403.</Li>
              <Li><strong className="text-gray-200">During session (MCP client)</strong> &mdash; FILE_RESTRICTION policies are checked when the agent calls <code className="text-indigo-400">check_file_access</code>. Blocked files return <code className="text-indigo-400">allowed: false</code>.</Li>
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

            <H2>Policy Types</H2>

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
              <Li><strong>Repo scope</strong> &mdash; Rule only applies to sessions in a specific repository (e.g. &ldquo;origin-v2&rdquo;, &ldquo;frontend-app&rdquo;)</Li>
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
            <h1 className="text-2xl font-bold mb-2">Settings & API Keys</h1>
            <P>
              Manage your organization&apos;s API keys, integrations, and account settings.
            </P>

            <H2>API Keys</H2>
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

            <Callout type="warning">
              API keys provide full access to your org&apos;s data. Treat them like passwords. Rotate keys regularly and delete unused ones.
            </Callout>

            <H2>Integrations</H2>
            <P>
              The Integrations tab manages connections to external services. Currently supports GitHub
              (GitLab coming soon). See the <strong className="text-gray-200">GitHub Integration</strong> guide for setup details.
            </P>

            <H3>Integration Features</H3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Post status checks on PRs</strong> &mdash; Shows pass/fail badges on PRs based on AI session review status</Li>
              <Li><strong className="text-gray-200">Post session summary comments</strong> &mdash; Adds a detailed AI governance report as a PR comment</Li>
              <Li><strong className="text-gray-200">Update checks on review</strong> &mdash; Auto-refreshes PR status when sessions are reviewed in Origin</Li>
            </ul>

            <H2>Agent Setup Tab</H2>
            <P>
              The Agent Setup tab provides copy-paste configuration for integrating Origin with AI tools.
              It shows the MCP server config for Claude Code and Cursor, plus CLI installation commands.
            </P>

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
            <h1 className="text-2xl font-bold mb-2">Team & Roles</h1>
            <P>
              Origin uses Role-Based Access Control (RBAC) to manage permissions. Each user has one role
              within their organization.
            </P>

            <H2>Roles</H2>
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

        {/* ─── SESSIONS & REVIEWS ──────────────────────────────── */}
        {active === 'sessions' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Sessions & Reviews</h1>
            <P>
              Sessions represent individual AI coding interactions. Every time an agent
              writes code, Origin captures it as a session.
            </P>

            <H2>Session Data</H2>
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

            <H2>Session Detail View</H2>
            <P>
              Click any session to open the detail page. The right panel has three tabs:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Transcript</strong> &mdash; Full replay of the AI conversation with user prompts and agent responses</Li>
              <Li><strong className="text-gray-200">Changes</strong> &mdash; A timeline showing each user prompt and the files it caused the agent to modify. This is the core governance audit trail: &ldquo;User asked X &rarr; Agent changed Y&rdquo;</Li>
              <Li><strong className="text-gray-200">Full Diff</strong> &mdash; The complete unified diff with syntax-colored additions (green) and deletions (red), organized by file with collapsible sections</Li>
            </ul>
            <P>
              The left panel shows commit info (real SHA hashes, HEAD range), linked PRs,
              agent/model info, session stats, and any existing review.
            </P>

            <H2>Filtering Sessions</H2>
            <P>
              Use the filter bar at the top of the Sessions page to filter by model, status
              (reviewed/unreviewed/flagged), agent, and repository.
            </P>

            <H2>Reviewing Sessions</H2>
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
          </div>
        )}

        {/* ─── AI AUTO-REVIEW ──────────────────────────────────── */}
        {active === 'ai-review' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">AI Auto-Review</h1>
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
            <h1 className="text-2xl font-bold mb-2">Budget & Cost Controls</h1>
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
            <h1 className="text-2xl font-bold mb-2">Real-Time Streaming</h1>
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
            <h1 className="text-2xl font-bold mb-2">Secret & PII Scanning</h1>
            <P>
              Origin automatically scans code diffs at the end of every coding session for
              hardcoded secrets, API keys, credentials, and personally identifiable information (PII).
              Findings are displayed in the session detail and trigger notifications for critical issues.
            </P>

            <H2>Detection Types</H2>
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
            <h1 className="text-2xl font-bold mb-2">Compliance Reports</h1>
            <P>
              Generate comprehensive compliance reports covering session activity, policy violations,
              review coverage, and security findings. Reports can be filtered by date range and
              exported as JSON.
            </P>

            <H2>Compliance Score</H2>
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
            <h1 className="text-2xl font-bold mb-2">Enhanced Analytics</h1>
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

        {/* ─── WEBHOOKS ────────────────────────────────────────── */}
        {active === 'webhooks' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Webhooks</h1>
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
                <P>Authenticate with your Origin account. Enter your email and password (or API key) to get credentials stored at <code className="text-indigo-400">~/.origin/config.json</code>.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin init</code>
                <P>Register the current machine with Origin. Detects installed tools (git, node, python, etc.) and reports them to the server. Shows up in Dashboard &rarr; Registered Machines.</P>
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
                <P>List recent AI coding sessions from the server.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin whoami</code>
                <P>Show the currently authenticated user and organization.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin mcp serve</code>
                <P>Start the MCP server for real-time policy enforcement. Usually configured as an MCP server in AI tools rather than run directly.</P>
              </div>
            </div>
          </div>
        )}

        {/* ─── MCP SERVER ──────────────────────────────────────── */}
        {active === 'mcp' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">MCP Server</h1>
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
              For production, use your Fly.io URL (e.g. <code className="text-indigo-400">https://origin-platform.fly.dev</code>).
            </Callout>

            <H3>Prerequisites</H3>
            <ul className="space-y-2 mb-4">
              <Li>Origin CLI installed globally (<code className="text-indigo-400">npm install -g @origin/cli</code>)</Li>
              <Li>Authenticated via <code className="text-indigo-400">origin login</code></Li>
              <Li>Machine registered via <code className="text-indigo-400">origin init</code></Li>
            </ul>

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

        {/* ─── API REFERENCE ───────────────────────────────────── */}
        {active === 'api' && (
          <div>
            <h1 className="text-2xl font-bold mb-2">API Reference</h1>
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
