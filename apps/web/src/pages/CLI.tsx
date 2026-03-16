import React, { useState } from 'react';
import { Link } from 'react-router-dom';

const INSTALL_CMD = 'npm i -g https://getorigin.io/cli/origin-cli-latest.tgz';
const GITHUB_URL = 'https://github.com/dolobanko/origin-cli';

function CopyBlock({ cmd, label }: { cmd: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="w-full group relative bg-gray-900 border border-gray-700 hover:border-indigo-500/50 rounded-xl px-5 py-4 text-left transition-colors cursor-pointer"
    >
      {label && <p className="text-xs text-gray-500 mb-2">{label}</p>}
      <div className="flex items-center gap-3">
        <span className="text-green-400 text-sm font-mono shrink-0">$</span>
        <code className="text-sm font-mono text-gray-200 truncate flex-1">{cmd}</code>
        <span className="text-xs text-gray-500 group-hover:text-indigo-400 transition-colors shrink-0">
          {copied ? 'Copied!' : 'Click to copy'}
        </span>
      </div>
    </button>
  );
}

function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="rounded-lg overflow-hidden border border-gray-700 my-3">
      {title && (
        <div className="bg-gray-800 px-4 py-2 text-xs text-gray-400 border-b border-gray-700 font-mono">
          {title}
        </div>
      )}
      <pre className="bg-gray-900 px-4 py-3 text-sm font-mono text-gray-200 overflow-x-auto leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

type Section =
  | 'overview'
  | 'installation'
  | 'quick-start'
  | 'standalone-mode'
  | 'comparison'
  | 'auth-setup'
  | 'hook-management'
  | 'session-tracking'
  | 'attribution'
  | 'search-analysis'
  | 'time-travel'
  | 'trails'
  | 'configuration'
  | 'local-db'
  | 'ci-cd'
  | 'plugins'
  | 'git-proxy'
  | 'maintenance'
  | 'hook-architecture'
  | 'data-storage'
  | 'supported-agents'
  | 'troubleshooting';

const SECTIONS: { key: Section; label: string; group?: string }[] = [
  { key: 'overview', label: 'Overview', group: 'Getting Started' },
  { key: 'installation', label: 'Installation' },
  { key: 'quick-start', label: 'Quick Start' },
  { key: 'standalone-mode', label: 'Standalone vs Connected' },
  { key: 'comparison', label: 'Origin vs Entire vs git-ai' },
  { key: 'auth-setup', label: 'Authentication & Setup', group: 'Commands' },
  { key: 'hook-management', label: 'Hook Management' },
  { key: 'session-tracking', label: 'Session Tracking' },
  { key: 'attribution', label: 'Attribution & Blame' },
  { key: 'search-analysis', label: 'Search & Analysis' },
  { key: 'time-travel', label: 'Time Travel & Resume' },
  { key: 'trails', label: 'Trail System' },
  { key: 'configuration', label: 'Configuration' },
  { key: 'local-db', label: 'Local Database' },
  { key: 'ci-cd', label: 'CI/CD Integration', group: 'Advanced' },
  { key: 'plugins', label: 'Plugin System' },
  { key: 'git-proxy', label: 'Git Proxy' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'hook-architecture', label: 'Hook Architecture', group: 'Reference' },
  { key: 'data-storage', label: 'Data Storage' },
  { key: 'supported-agents', label: 'Supported Agents' },
  { key: 'troubleshooting', label: 'Troubleshooting' },
];

function renderSection(section: Section) {
  switch (section) {
    case 'overview':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Origin CLI</h2>
          <p className="text-gray-400 leading-relaxed mb-4">
            Origin CLI is an open-source tool for tracking, attributing, and governing
            AI-assisted code. It hooks into AI coding agents (Claude Code, Cursor, Gemini, Windsurf, Aider)
            to capture session data, provide attribution analytics, and optionally enforce policies.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
            <div className="card bg-gray-800/30 border-gray-700 p-4">
              <h4 className="text-sm font-semibold text-green-400 mb-1">Standalone Mode</h4>
              <p className="text-xs text-gray-400">Works without any server. Session tracking, attribution, blame, search, and analysis — all stored locally in git.</p>
            </div>
            <div className="card bg-gray-800/30 border-gray-700 p-4">
              <h4 className="text-sm font-semibold text-indigo-400 mb-1">Connected Mode</h4>
              <p className="text-xs text-gray-400">Connect to Origin platform for policy enforcement, dashboards, team reviews, compliance, and PR gating.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mb-6">
            {['Claude Code', 'Gemini CLI', 'Cursor', 'Aider', 'GitHub Copilot', 'Windsurf'].map((t) => (
              <span key={t} className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300">{t}</span>
            ))}
          </div>
          <div className="flex gap-3">
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 hover:border-gray-600 transition-colors">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
              View on GitHub
            </a>
            <span className="px-3 py-2 rounded-lg bg-indigo-600/10 border border-indigo-500/20 text-xs text-indigo-400 font-medium flex items-center">MIT License</span>
          </div>
        </div>
      );

    case 'installation':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Installation</h2>
          <CopyBlock cmd={INSTALL_CMD} />
          <p className="text-xs text-gray-600 mt-2 mb-4">Requires Node.js 18+</p>
          <p className="text-gray-400 text-sm mb-2">Verify installation:</p>
          <CodeBlock>{'origin --version'}</CodeBlock>
        </div>
      );

    case 'quick-start':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Quick Start</h2>
          <h3 className="text-lg font-semibold text-green-400 mb-2">Standalone (no server needed)</h3>
          <CodeBlock>{`# 1. Initialize (auto-detects installed AI tools)
origin init

# 2. Enable hooks globally (all repos, all agents)
origin enable --global

# 3. Start coding — Origin tracks everything in git automatically

# 4. View sessions, attribution, blame
origin sessions
origin blame src/app.ts
origin stats --local`}</CodeBlock>

          <h3 className="text-lg font-semibold text-indigo-400 mt-6 mb-2">Connected (Origin platform)</h3>
          <CodeBlock>{`# 1. Login to your Origin instance
origin login

# 2. Initialize + register machine
origin init

# 3. Enable hooks — policies are enforced automatically
origin enable`}</CodeBlock>

          <div className="mt-6 card bg-gray-800/30 border-gray-700">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Example output</p>
            <pre className="text-sm font-mono text-gray-300 overflow-x-auto leading-relaxed">
{`$ origin init
  ✓ Detected: claude-code, gemini-cli
  ✓ Hooks installed for 2 agents
  ✓ Initialized in standalone mode
  Tip: Run 'origin login' to connect to Origin platform`}</pre>
          </div>
        </div>
      );

    case 'standalone-mode':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Standalone vs Connected</h2>
          <p className="text-gray-400 text-sm mb-4">
            Origin CLI works in two modes. No server or API key is needed for standalone mode.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-700 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-800">
                  <th className="text-left px-4 py-3 text-gray-300 font-medium">Feature</th>
                  <th className="text-left px-4 py-3 text-green-400 font-medium">Standalone</th>
                  <th className="text-left px-4 py-3 text-indigo-400 font-medium">Connected</th>
                </tr>
              </thead>
              <tbody className="text-gray-400">
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">Session tracking</td><td className="px-4 py-2 text-green-400">✓ Git-based</td><td className="px-4 py-2 text-green-400">✓ API + Git</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">AI attribution & blame</td><td className="px-4 py-2 text-green-400">✓ Git notes</td><td className="px-4 py-2 text-green-400">✓ Git notes</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">Code search & analysis</td><td className="px-4 py-2 text-green-400">✓ Local</td><td className="px-4 py-2 text-green-400">✓ Local</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">Stats & analytics</td><td className="px-4 py-2 text-green-400">✓ Local</td><td className="px-4 py-2 text-green-400">✓ Local + Dashboard</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">Time travel & resume</td><td className="px-4 py-2 text-green-400">✓</td><td className="px-4 py-2 text-green-400">✓</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">Trail system</td><td className="px-4 py-2 text-green-400">✓</td><td className="px-4 py-2 text-green-400">✓</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">Policy enforcement</td><td className="px-4 py-2 text-gray-600">—</td><td className="px-4 py-2 text-green-400">✓ Pre-tool-use blocking</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">Team dashboards</td><td className="px-4 py-2 text-gray-600">—</td><td className="px-4 py-2 text-green-400">✓</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">Session reviews</td><td className="px-4 py-2 text-gray-600">—</td><td className="px-4 py-2 text-green-400">✓</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">Audit logs</td><td className="px-4 py-2 text-gray-600">—</td><td className="px-4 py-2 text-green-400">✓</td></tr>
                <tr className="border-t border-gray-700/50"><td className="px-4 py-2">PR gating</td><td className="px-4 py-2 text-gray-600">—</td><td className="px-4 py-2 text-green-400">✓</td></tr>
              </tbody>
            </table>
          </div>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2">Switching modes</h3>
          <p className="text-gray-400 text-sm mb-2">
            Standalone mode is the default. Run <code className="text-indigo-400">origin login</code> to switch to connected mode at any time.
            All local data (sessions, attribution, notes) is preserved and continues to work.
          </p>
          <CodeBlock>{`# Start standalone — no API key needed
origin init
origin enable --global

# Later, connect to Origin platform
origin login
# All local features keep working + platform features unlock

# Already connected but want standalone mode?
origin init --standalone
# API credentials are kept — switch back anytime:
origin config set mode auto`}</CodeBlock>
        </div>
      );

    case 'comparison':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Origin vs Entire vs git-ai</h2>
          <p className="text-gray-400 text-sm mb-6">
            How Origin compares to <a href="https://entire.io" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">Entire</a> and <a href="https://usegitai.com" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">git-ai</a> — the two other tools in the AI code tracking space.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-700 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-800">
                  <th className="text-left px-4 py-3 text-gray-400 font-medium min-w-[160px]"></th>
                  <th className="text-left px-4 py-3 text-indigo-400 font-medium">Origin CLI</th>
                  <th className="text-left px-4 py-3 text-gray-300 font-medium">Entire</th>
                  <th className="text-left px-4 py-3 text-gray-300 font-medium">git-ai</th>
                </tr>
              </thead>
              <tbody className="text-gray-400">
                {([
                  ['Core approach', 'Session lifecycle hooks', 'Git hooks + shadow branches', 'Checkpoint + Git notes'],
                  ['What it captures', 'Full session: prompts, responses, tool calls, costs', 'Session transcripts + checkpoints', 'Code attribution only (line → agent)'],
                  ['', '', '', ''],
                  ['SESSION & TRACKING', '', '', ''],
                  ['Session capture', '✓ Full lifecycle (6 events)', '✓ Transcripts on push', '—'],
                  ['Session history', '✓ origin sessions', '✓ Web dashboard', '—'],
                  ['Session explain', '✓ origin explain --summarize', '✓ entire explain', '—'],
                  ['Ask about code', '✓ origin ask (file/session/query)', '—', '✓ /ask (query author)'],
                  ['Session sharing', '✓ origin share (bundle/clipboard)', '—', '—'],
                  ['Session resume', '✓ origin resume (restore context)', '—', '—'],
                  ['', '', '', ''],
                  ['ATTRIBUTION & BLAME', '', '', ''],
                  ['AI blame', '✓ origin blame (line-level)', '—', '✓ git-ai blame'],
                  ['Attributed diffs', '✓ origin diff (AI/human annotations)', '—', '—'],
                  ['Time travel / rewind', '✓ origin rewind (interactive)', '✓ entire rewind', '—'],
                  ['', '', '', ''],
                  ['SEARCH & ANALYSIS', '', '', ''],
                  ['Code search', '✓ origin search (across all prompts)', '—', '—'],
                  ['Analytics', '✓ origin stats (tokens, costs, models)', '—', '✓ git-ai stats'],
                  ['Pattern analysis', '✓ origin analyze (trends, patterns)', '—', '—'],
                  ['', '', '', ''],
                  ['GOVERNANCE', '', '', ''],
                  ['Policy enforcement', '✓ Real-time blocking (pre-tool-use)', '—', '—'],
                  ['Session reviews', '✓ Approve/reject/flag', '—', '—'],
                  ['Audit log', '✓ SOC 2 ready', '—', '—'],
                  ['PR gating', '✓ Block unreviewed PRs', '—', '—'],
                  ['Team dashboards', '✓ Connected mode', '✓ Web dashboard', '✓ Enterprise'],
                  ['', '', '', ''],
                  ['DEVOPS & WORKFLOW', '', '', ''],
                  ['CI/CD integration', '✓ origin ci (check, squash-merge, GH Actions)', '—', '—'],
                  ['Trail system', '✓ origin trail (branch work tracking)', '—', '—'],
                  ['Plugin system', '✓ origin plugin (custom commands)', '—', '—'],
                  ['Git proxy', '✓ origin proxy (transparent attribution)', '—', '—'],
                  ['Local database', '✓ origin db (import, stats)', '—', '—'],
                  ['Diagnostics', '✓ origin doctor + origin clean', '—', '—'],
                  ['', '', '', ''],
                  ['PLATFORM', '', '', ''],
                  ['IDE integration', '—', '—', '✓ VS Code gutter'],
                  ['Works offline', '✓', '✓', '✓'],
                  ['Zero config', '✓ origin init', '✓ entire enable', '✓ Auto'],
                  ['Agents supported', '6 agents', '5 agents', '12+ agents'],
                  ['License', 'MIT', 'Proprietary', 'Apache 2.0'],
                  ['', '', '', ''],
                  ['TOTAL', '35+ commands', '~5 commands', '~6 commands'],
                ] as [string, string, string, string][]).map(([feature, origin, entire, gitai], i) => {
                  // Section headers
                  if (feature === feature.toUpperCase() && feature.length > 0 && origin === '' && entire === '' && gitai === '') {
                    return (
                      <tr key={`header-${i}`} className="border-t border-gray-700/50 bg-gray-800/50">
                        <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">{feature}</td>
                      </tr>
                    );
                  }
                  // Spacer rows
                  if (feature === '' && origin === '') return null;
                  // Total row
                  if (feature === 'TOTAL') {
                    return (
                      <tr key="total" className="border-t-2 border-indigo-500/30 bg-indigo-500/5">
                        <td className="px-4 py-3 text-indigo-300 font-bold">{feature}</td>
                        <td className="px-4 py-3 text-indigo-400 font-bold">{origin}</td>
                        <td className="px-4 py-3 text-gray-500 font-medium">{entire}</td>
                        <td className="px-4 py-3 text-gray-500 font-medium">{gitai}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={feature} className={`border-t border-gray-700/50 ${i < 2 ? 'bg-gray-800/30' : ''}`}>
                      <td className="px-4 py-2 text-gray-300 font-medium">{feature}</td>
                      <td className={`px-4 py-2 ${origin.startsWith('✓') ? 'text-green-400' : origin === '—' ? 'text-gray-600' : 'text-gray-400'}`}>{origin}</td>
                      <td className={`px-4 py-2 ${entire.startsWith('✓') ? 'text-green-400' : entire === '—' ? 'text-gray-600' : 'text-gray-400'}`}>{entire}</td>
                      <td className={`px-4 py-2 ${gitai.startsWith('✓') ? 'text-green-400' : gitai === '—' ? 'text-gray-600' : 'text-gray-400'}`}>{gitai}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-8 space-y-6">
            <div className="card bg-indigo-500/5 border-indigo-500/20 p-5">
              <h3 className="text-sm font-semibold text-indigo-400 mb-2">Why Origin</h3>
              <p className="text-gray-400 text-sm">
                <strong className="text-gray-200">35+ commands vs 5-6.</strong> Origin isn't just a tracker — it's a full governance platform. Session lifecycle, attribution, search, analysis, trails, CI/CD, plugins, diagnostics. Entire and git-ai solve one problem each; Origin solves the whole workflow.
              </p>
              <p className="text-gray-400 text-sm mt-2">
                <strong className="text-gray-200">Session governance, not just tracking.</strong> Origin captures the complete session lifecycle and lets you enforce policies <em>during</em> the session — blocking restricted file access, enforcing cost limits, requiring reviews before merge. Entire and git-ai track what happened; Origin controls what's allowed to happen.
              </p>
              <p className="text-gray-400 text-sm mt-2">
                <strong className="text-gray-200">Standalone-first.</strong> Works fully offline with zero setup. Add the platform later for team features — nothing breaks, nothing migrates.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="card bg-gray-800/30 border-gray-700 p-4">
                <h4 className="text-sm font-semibold text-gray-300 mb-2">When to use Entire</h4>
                <p className="text-xs text-gray-400">
                  Visual dashboard for browsing AI coding sessions and checkpoints. AI-powered session summaries via <code className="text-gray-300">entire explain</code>. Checkpoint rewind support. No policy enforcement or attribution features.
                </p>
              </div>
              <div className="card bg-gray-800/30 border-gray-700 p-4">
                <h4 className="text-sm font-semibold text-gray-300 mb-2">When to use git-ai</h4>
                <p className="text-xs text-gray-400">
                  Best for line-level attribution — knowing which AI agent wrote each line. Broadest agent support (12+), VS Code gutter annotations, and <code className="text-gray-300">/ask</code> to query the original AI about its code. No session tracking or governance.
                </p>
              </div>
            </div>
          </div>
        </div>
      );

    case 'auth-setup':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Authentication & Setup</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin login</code></h3>
          <p className="text-gray-400 text-sm mb-2">Authenticate with your Origin server.</p>
          <CodeBlock>{`origin login
# Prompts for:
#   API URL (default: https://getorigin.io)
#   API Key (from your Origin dashboard)`}</CodeBlock>
          <p className="text-gray-500 text-xs">Config saved to <code className="text-indigo-400">~/.origin/config.json</code></p>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin init</code></h3>
          <p className="text-gray-400 text-sm mb-2">Register this machine as an agent host. Auto-detects installed AI tools.</p>
          <CodeBlock>{`origin init
# Detects: claude, cursor, aider, gemini, windsurf
# Registers machine with Origin API
# Saves to ~/.origin/agent.json`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin whoami</code></h3>
          <p className="text-gray-400 text-sm mb-2">Show current authentication status.</p>
          <CodeBlock>{`origin whoami
# Output: API URL, Org ID, user email/name/role, machine info`}</CodeBlock>
        </div>
      );

    case 'hook-management':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Hook Management</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin enable</code></h3>
          <p className="text-gray-400 text-sm mb-2">Install Origin hooks for session tracking. Hooks capture AI prompts, file changes, token usage, and costs.</p>
          <CodeBlock>{`# Auto-detect and install for all found agents
origin enable

# Install for a specific agent
origin enable --agent claude-code
origin enable --agent cursor
origin enable --agent gemini
origin enable --agent windsurf
origin enable --agent aider

# Install globally (all repos tracked automatically)
origin enable --global

# Install and link to a specific Origin agent
origin enable --link my-agent-slug

# Replace existing hooks instead of chaining
origin enable --no-chain`}</CodeBlock>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">What gets installed</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-800 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-800/60">
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Agent</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Config File</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Events</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                <tr><td className="px-4 py-2 text-gray-300">Claude Code</td><td className="px-4 py-2 text-gray-400 font-mono text-xs">~/.claude/settings.json</td><td className="px-4 py-2 text-gray-400 text-xs">SessionStart, Stop, UserPromptSubmit, SessionEnd, PreToolUse, PostToolUse</td></tr>
                <tr className="bg-gray-900/30"><td className="px-4 py-2 text-gray-300">Cursor</td><td className="px-4 py-2 text-gray-400 font-mono text-xs">~/.cursor/hooks.json</td><td className="px-4 py-2 text-gray-400 text-xs">sessionStart, stop, beforeSubmitPrompt, sessionEnd</td></tr>
                <tr><td className="px-4 py-2 text-gray-300">Gemini CLI</td><td className="px-4 py-2 text-gray-400 font-mono text-xs">~/.gemini/settings.json</td><td className="px-4 py-2 text-gray-400 text-xs">SessionStart, SessionEnd, BeforeAgent, AfterAgent</td></tr>
                <tr className="bg-gray-900/30"><td className="px-4 py-2 text-gray-300">Windsurf</td><td className="px-4 py-2 text-gray-400 font-mono text-xs">~/.windsurf/hooks.json</td><td className="px-4 py-2 text-gray-400 text-xs">sessionStart, stop, beforeSubmitPrompt, sessionEnd</td></tr>
                <tr><td className="px-4 py-2 text-gray-300">Aider</td><td className="px-4 py-2 text-gray-400 font-mono text-xs">~/.aider.conf.yml</td><td className="px-4 py-2 text-gray-400 text-xs">git-commit-verify, notifications-command</td></tr>
                <tr className="bg-gray-900/30"><td className="px-4 py-2 text-gray-300">Git (post-commit)</td><td className="px-4 py-2 text-gray-400 font-mono text-xs">.git/hooks/post-commit</td><td className="px-4 py-2 text-gray-400 text-xs">post-commit (commit attribution)</td></tr>
                <tr><td className="px-4 py-2 text-gray-300">Git (pre-push)</td><td className="px-4 py-2 text-gray-400 font-mono text-xs">.git/hooks/pre-push</td><td className="px-4 py-2 text-gray-400 text-xs">pre-push (auto-push session data)</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-gray-500 text-xs mt-3"><strong>Hook chaining:</strong> By default, Origin preserves existing hooks and chains them. Use <code className="text-indigo-400">--no-chain</code> to replace instead.</p>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin disable</code></h3>
          <p className="text-gray-400 text-sm mb-2">Remove all Origin hooks.</p>
          <CodeBlock>{`origin disable           # Remove from current repo
origin disable --global  # Remove global hooks`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin link</code></h3>
          <p className="text-gray-400 text-sm mb-2">Link a repo to a specific Origin agent for session attribution.</p>
          <CodeBlock>{`origin link my-agent     # Link to agent "my-agent" (writes .origin.json)
origin link              # Show current mapping
origin link --clear      # Remove mapping`}</CodeBlock>
        </div>
      );

    case 'session-tracking':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Session Tracking</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin status</code></h3>
          <p className="text-gray-400 text-sm mb-2">Show current session status, repo info, and connection health.</p>
          <CodeBlock>{`origin status
# Shows: Login status, active session (ID, model, duration, branch, HEAD),
#        repository info, policy count, API health`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin sessions</code></h3>
          <p className="text-gray-400 text-sm mb-2">List coding sessions with filters.</p>
          <CodeBlock>{`origin sessions                          # List recent sessions
origin sessions --status unreviewed      # Only unreviewed
origin sessions --model claude-sonnet-4  # Filter by model
origin sessions --limit 50              # Show more results`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin session &lt;id&gt;</code></h3>
          <p className="text-gray-400 text-sm mb-2">View full details of a session.</p>
          <CodeBlock>{`origin session abc123
# Shows: model, repo, commits, author, tokens, cost, duration,
#        files changed, review status`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin explain</code></h3>
          <p className="text-gray-400 text-sm mb-2">Explain a coding session with prompts, file changes, cost, and review status.</p>
          <CodeBlock>{`# Explain active session
origin explain

# Explain by session ID
origin explain abc123

# Look up by commit SHA
origin explain --commit a1b2c3d

# Short output (skip prompt mappings)
origin explain --short

# AI-powered summary
origin explain --summarize

# JSON output
origin explain --json`}</CodeBlock>
          <p className="text-gray-500 text-xs mt-2">The <code className="text-indigo-400">--summarize</code> flag generates a structured AI summary with: intent, outcome, learnings, friction points, and open items.</p>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin ask &lt;query&gt;</code></h3>
          <p className="text-gray-400 text-sm mb-2">Ask about AI-generated code — find the session and prompts behind any file or change.</p>
          <CodeBlock>{`# Ask about a specific file
origin ask "auth" --file src/auth.ts

# Ask about a specific line
origin ask "middleware" --file src/server.ts --line 42

# Ask within a specific session
origin ask "refactor" --session abc123

# Search all prompts
origin ask "database migration"`}</CodeBlock>
          <p className="text-gray-500 text-xs mt-2">Uses git notes, origin-sessions branch, and local prompt database to find context. Works in standalone mode.</p>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin review &lt;sessionId&gt;</code></h3>
          <p className="text-gray-400 text-sm mb-2">Review and approve/reject/flag a session.</p>
          <CodeBlock>{`origin review abc123 --approve
origin review abc123 --reject --note "Introduces security vulnerability"
origin review abc123 --flag --note "Needs team review"`}</CodeBlock>
        </div>
      );

    case 'attribution':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Attribution & Blame</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin blame &lt;file&gt;</code></h3>
          <p className="text-gray-400 text-sm mb-2">Show AI vs human attribution per line, like <code className="text-gray-300">git blame</code> but for AI authorship.</p>
          <CodeBlock>{`origin blame src/index.ts
# Output:
#   Line  Tag   Author/Model      Content
#   ───────────────────────────────────────
#     1  [HU]  John Doe          #!/usr/bin/env node
#     2  [AI]  claude-sonnet-4   import express from 'express';
#     3  [MX]  claude-sonnet-4   const port = 8080;

# Show specific line range
origin blame src/index.ts --line 10-20

# JSON output (for IDE integration)
origin blame src/index.ts --json`}</CodeBlock>
          <div className="mt-3 flex gap-4 text-xs">
            <span className="text-green-400">[AI] — Written by AI agent</span>
            <span className="text-gray-300">[HU] — Written by human</span>
            <span className="text-yellow-400">[MX] — AI wrote, human modified</span>
          </div>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin diff</code></h3>
          <p className="text-gray-400 text-sm mb-2">Show diff with AI/human attribution annotations.</p>
          <CodeBlock>{`origin diff                    # Diff of current changes
origin diff HEAD~5..HEAD       # Diff over last 5 commits
origin diff --ai-only          # Only AI-authored changes
origin diff --human-only       # Only human-authored changes
origin diff --json             # JSON output`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin stats</code></h3>
          <p className="text-gray-400 text-sm mb-2">View dashboard statistics with attribution breakdown.</p>
          <CodeBlock>{`# API stats (sessions, costs, agents)
origin stats

# Local git-based stats with attribution
origin stats --local
# Shows:
#   Total commits (AI vs human)
#   Lines added by AI vs human
#   Per-tool breakdown with bar graph:
#     claude-code  ████████████████████░░░░  82%  (340 lines)
#     cursor       ██████░░░░░░░░░░░░░░░░░░  25%  (45 lines)
#   Acceptance rate (AI lines humans kept vs edited)

# Custom commit range
origin stats --local --range HEAD~100..HEAD`}</CodeBlock>
        </div>
      );

    case 'search-analysis':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Search & Analysis</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin search &lt;query&gt;</code></h3>
          <p className="text-gray-400 text-sm mb-2">Search across all AI prompt history.</p>
          <CodeBlock>{`origin search "authentication"              # Search all prompts
origin search "refactor" --model claude     # Filter by model
origin search "database" --limit 50         # More results
origin search "API" --repo /path/to/repo    # Filter by repo`}</CodeBlock>
          <p className="text-gray-500 text-xs mt-2">Searches the local prompt database. Run <code className="text-indigo-400">origin db import</code> first to populate from the origin-sessions branch.</p>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin analyze</code></h3>
          <p className="text-gray-400 text-sm mb-2">Analyze AI prompting patterns and metrics.</p>
          <CodeBlock>{`origin analyze                    # Analyze last 30 days
origin analyze --days 90          # Custom date range
origin analyze --model claude     # Filter by model
origin analyze --export report.md # Export to file
origin analyze --json             # JSON output`}</CodeBlock>
          <p className="text-gray-400 text-sm mt-3">Shows: total prompts, average/median length, prompt-to-file-change ratio, model breakdown, common patterns (questions, commands, fixes, refactors), time distribution, and top changed files.</p>
        </div>
      );

    case 'time-travel':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Time Travel & Resume</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin rewind</code></h3>
          <p className="text-gray-400 text-sm mb-2">Rewind to a previous AI checkpoint (time travel). Restore your code to any previous AI session state.</p>
          <CodeBlock>{`# Interactive checkpoint browser
origin rewind --interactive
# Shows:
#   Checkpoints for session abc12345:
#     1. [14:30] feat: add auth middleware      +45 -3  (claude-sonnet-4)
#     2. [14:25] fix: route handler types       +12 -8  (claude-sonnet-4)
#     3. [14:20] refactor: extract validators   +89 -34 (claude-sonnet-4)
#   Select checkpoint (1-3):

# Rewind to specific commit
origin rewind --to a1b2c3d

# List checkpoints without rewinding
origin rewind --list`}</CodeBlock>
          <p className="text-gray-500 text-xs mt-2"><strong>Safety:</strong> Always stashes current changes before rewinding. Requires confirmation.</p>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin resume</code></h3>
          <p className="text-gray-400 text-sm mb-2">Resume an AI session from a previous branch. Builds context from the origin-sessions branch data.</p>
          <CodeBlock>{`# Resume from current branch
origin resume

# Resume from specific branch
origin resume feature/auth

# Auto-launch the AI agent with context
origin resume --launch

# Get context as JSON (for piping)
origin resume --json`}</CodeBlock>
          <p className="text-gray-400 text-sm mt-3">With <code className="text-indigo-400">--launch</code>, Origin detects the installed agent and launches it with session context (Claude Code: pipes to <code className="text-gray-300">claude --resume</code>, Cursor/Gemini: writes context file).</p>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin share &lt;sessionId&gt;</code></h3>
          <p className="text-gray-400 text-sm mb-2">Create a shareable prompt bundle from a session.</p>
          <CodeBlock>{`# Share entire session (copies to clipboard)
origin share abc123

# Share specific prompt
origin share abc123 --prompt 3

# Write to file
origin share abc123 --output session-bundle.md`}</CodeBlock>
        </div>
      );

    case 'trails':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Trail System</h2>
          <p className="text-gray-400 text-sm mb-4">Branch-centric work tracking. Trails describe the "why" and "what" of work while sessions capture the "how" and "when."</p>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin trail</code></h3>
          <p className="text-gray-400 text-sm mb-2">Show the trail for the current branch.</p>
          <CodeBlock>{`origin trail
# Shows: Trail ID, name, branch, status, priority, labels,
#        reviewers, associated sessions`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin trail list</code></h3>
          <CodeBlock>{`origin trail list                    # All trails
origin trail list --status active    # Filter by status`}</CodeBlock>
          <p className="text-gray-500 text-xs mt-1">Statuses: <code className="text-gray-400">active</code>, <code className="text-gray-400">review</code>, <code className="text-gray-400">done</code>, <code className="text-gray-400">paused</code></p>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin trail create &lt;name&gt;</code></h3>
          <CodeBlock>{`origin trail create "Add user authentication"
origin trail create "Bug fix: login loop" --priority high
origin trail create "Refactor API" --priority critical --label backend --label api`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin trail update</code></h3>
          <CodeBlock>{`origin trail update --status review
origin trail update --priority high
origin trail update --title "Updated: Add OAuth2 authentication"`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin trail assign / label</code></h3>
          <CodeBlock>{`origin trail assign john@example.com
origin trail label frontend security`}</CodeBlock>
        </div>
      );

    case 'configuration':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Configuration</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin config</code></h3>
          <CodeBlock>{`# List all config values with descriptions
origin config list

# Get a specific value
origin config get pushStrategy

# Set a value
origin config set commitLinking always
origin config set pushStrategy auto
origin config set secretRedaction true
origin config set telemetry true`}</CodeBlock>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Available Config Keys</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-800 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-800/60">
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Key</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Values</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Default</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {[
                  ['apiUrl', 'URL', 'https://getorigin.io', 'Origin API URL'],
                  ['apiKey', 'string', '—', 'API key (use origin login)'],
                  ['commitLinking', 'always | prompt | never', 'always', 'Add Origin-Session trailers to commits'],
                  ['pushStrategy', 'auto | prompt | false', 'auto', 'When to push origin-sessions branch'],
                  ['telemetry', 'true | false', 'false', 'Enable anonymous telemetry (opt-in)'],
                  ['autoUpdate', 'true | false', 'true', 'Check for CLI updates'],
                  ['secretRedaction', 'true | false', 'true', 'Redact secrets before sending to API'],
                  ['hookChaining', 'true | false', 'true', 'Chain existing hooks when installing'],
                ].map(([key, values, def, desc], i) => (
                  <tr key={key} className={i % 2 === 0 ? 'bg-gray-900/30' : ''}>
                    <td className="px-4 py-2 text-indigo-400 font-mono text-xs">{key}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{values}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs font-mono">{def}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Per-Repo Config (<code className="text-indigo-400">.origin.json</code>)</h4>
          <CodeBlock title=".origin.json">{`{
  "agent": "my-agent-slug",
  "ignorePatterns": ["*.generated.ts", "dist/**"],
  "trackTabCompletions": true
}`}</CodeBlock>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Environment Variables</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-800 rounded-lg overflow-hidden">
              <thead><tr className="bg-gray-800/60"><th className="text-left px-4 py-2 text-gray-400 font-medium">Variable</th><th className="text-left px-4 py-2 text-gray-400 font-medium">Purpose</th></tr></thead>
              <tbody className="divide-y divide-gray-800">
                <tr><td className="px-4 py-2 text-indigo-400 font-mono text-xs">ORIGIN_API_URL</td><td className="px-4 py-2 text-gray-400 text-xs">Override API endpoint</td></tr>
                <tr className="bg-gray-900/30"><td className="px-4 py-2 text-indigo-400 font-mono text-xs">ORIGIN_API_KEY</td><td className="px-4 py-2 text-gray-400 text-xs">Override API key</td></tr>
                <tr><td className="px-4 py-2 text-indigo-400 font-mono text-xs">ORIGIN_DEBUG</td><td className="px-4 py-2 text-gray-400 text-xs">Enable debug logging (set to 1)</td></tr>
                <tr className="bg-gray-900/30"><td className="px-4 py-2 text-indigo-400 font-mono text-xs">ORIGIN_ORG_ID</td><td className="px-4 py-2 text-gray-400 text-xs">Override organization ID</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      );

    case 'local-db':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Local Database</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin db import</code></h3>
          <p className="text-gray-400 text-sm mb-2">Import prompts from the origin-sessions branch into the local prompt database for search and analysis.</p>
          <CodeBlock>{`origin db import
# Walks origin-sessions branch, extracts prompts, stores in ~/.origin/db/`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin db stats</code></h3>
          <p className="text-gray-400 text-sm mb-2">Show local database statistics.</p>
          <CodeBlock>{`origin db stats
# Shows: Total prompts, stored blobs, blob storage size`}</CodeBlock>
        </div>
      );

    case 'ci-cd':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">CI/CD Integration</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin ci check</code></h3>
          <p className="text-gray-400 text-sm mb-2">Report AI attribution stats in CI. Designed to run in GitHub Actions or similar CI systems.</p>
          <CodeBlock>{`origin ci check
origin ci check --range origin/main..HEAD`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin ci squash-merge &lt;baseBranch&gt;</code></h3>
          <p className="text-gray-400 text-sm mb-2">Preserve AI attribution data through squash merges.</p>
          <CodeBlock>{`origin ci squash-merge main`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin ci generate-workflow</code></h3>
          <p className="text-gray-400 text-sm mb-2">Generate a GitHub Actions workflow file for automated attribution checking.</p>
          <CodeBlock>{`origin ci generate-workflow
# Outputs a complete .github/workflows/origin-attribution.yml`}</CodeBlock>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Example GitHub Actions Workflow</h4>
          <CodeBlock title=".github/workflows/origin-attribution.yml">{`name: Origin Attribution
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  attribution:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install Origin CLI
        run: npm install -g @origin/cli

      - name: Attribution Check
        run: |
          echo "## Attribution Report" >> $GITHUB_STEP_SUMMARY
          origin ci check --range "\${{ github.event.pull_request.base.sha }}..\${{ github.sha }}" >> $GITHUB_STEP_SUMMARY`}</CodeBlock>
          <p className="text-gray-500 text-xs mt-2">Required secrets: <code className="text-indigo-400">ORIGIN_API_KEY</code></p>
        </div>
      );

    case 'plugins':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Plugin System</h2>
          <p className="text-gray-400 text-sm mb-4">Extend Origin with external agent plugins.</p>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin plugin list / install / remove</code></h3>
          <CodeBlock>{`# List installed plugins
origin plugin list

# Register an external agent plugin
origin plugin install my-agent /usr/local/bin/my-agent-hook

# Remove a plugin
origin plugin remove my-agent`}</CodeBlock>
          <p className="text-gray-400 text-sm mt-3">Plugins communicate via JSON-over-stdio. Origin writes event JSON to plugin stdin, plugin responds with status on stdout.</p>
          <p className="text-gray-500 text-xs mt-1">Plugin registry stored at <code className="text-indigo-400">~/.origin/plugins.json</code></p>
        </div>
      );

    case 'git-proxy':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Git Proxy</h2>
          <p className="text-gray-400 text-sm mb-4">Transparent git proxy that intercepts git commands for automatic attribution tracking.</p>

          <CodeBlock>{`# Install the git proxy wrapper
origin proxy install
# Adds ~/.origin/bin to PATH

# Check status
origin proxy status

# Remove the proxy
origin proxy uninstall`}</CodeBlock>
          <p className="text-gray-400 text-sm mt-3"><strong>What it intercepts:</strong> <code className="text-gray-300">git commit</code>, <code className="text-gray-300">git push</code>, <code className="text-gray-300">git rebase</code>, <code className="text-gray-300">git cherry-pick</code>, <code className="text-gray-300">git stash</code></p>
          <div className="mt-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
            <strong>Warning:</strong> The git proxy modifies your PATH. It's opt-in only. If anything goes wrong, remove <code>~/.origin/bin</code> from your PATH or run <code>origin proxy uninstall</code>.
          </div>
        </div>
      );

    case 'maintenance':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Maintenance</h2>

          <h3 className="text-lg font-semibold text-gray-200 mt-6 mb-2"><code className="text-indigo-400">origin doctor</code></h3>
          <p className="text-gray-400 text-sm mb-2">Scan for and fix stuck or orphaned sessions.</p>
          <CodeBlock>{`origin doctor            # Scan only
origin doctor --fix      # Auto-fix issues found
origin doctor --verbose  # Detailed output`}</CodeBlock>
          <p className="text-gray-400 text-sm mt-2">Checks for: stuck sessions (&gt;1hr), stale state files, orphaned session files, hook errors, oversized logs, API connection health.</p>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin clean</code></h3>
          <p className="text-gray-400 text-sm mb-2">Remove orphaned data and temp files.</p>
          <CodeBlock>{`origin clean             # Preview what would be cleaned
origin clean --dry-run   # Same as above
origin clean --force     # Clean without confirmation`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin reset</code></h3>
          <p className="text-gray-400 text-sm mb-2">Clear local session state for the current repo.</p>
          <CodeBlock>{`origin reset             # Warns if session <1h old
origin reset --force     # Force clear`}</CodeBlock>

          <h3 className="text-lg font-semibold text-gray-200 mt-8 mb-2"><code className="text-indigo-400">origin upgrade</code></h3>
          <p className="text-gray-400 text-sm mb-2">Upgrade CLI to the latest version.</p>
          <CodeBlock>{`origin upgrade                    # Upgrade to latest stable
origin upgrade --channel beta     # Beta channel
origin upgrade --channel canary   # Canary channel
origin upgrade --check            # Only check, don't install`}</CodeBlock>
        </div>
      );

    case 'hook-architecture':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Hook Architecture</h2>
          <p className="text-gray-400 text-sm mb-4">Origin uses a multi-layer hook system:</p>

          <h4 className="text-sm font-semibold text-gray-300 mt-4 mb-3">Agent Hook Events</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-800 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-800/60">
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Event</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Trigger</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Data Captured</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {[
                  ['session-start', 'AI agent process begins', 'Session ID, model, branch, HEAD'],
                  ['user-prompt-submit', 'User sends prompt', 'Prompt text'],
                  ['pre-tool-use', 'AI about to use a tool', 'Tool name, input — policies enforced here'],
                  ['post-tool-use', 'AI finished using a tool', 'Tool result, branch tracking, subagent tracking'],
                  ['stop', 'AI finishes a turn', 'Tokens, files changed, cost'],
                  ['session-end', 'AI process terminates', 'Full transcript, git state, final metrics'],
                  ['git-post-commit', 'After every git commit', 'Commit SHA, message, files, diff'],
                  ['git-pre-push', 'Before git push', 'Pushes origin-sessions branch alongside'],
                ].map(([event, trigger, data], i) => (
                  <tr key={event} className={i % 2 === 0 ? 'bg-gray-900/30' : ''}>
                    <td className="px-4 py-2 text-amber-400 font-mono text-xs">{event}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{trigger}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{data}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Data Flow</h4>
          <CodeBlock>{`AI Agent → Agent Hook → Origin CLI → Origin API
                    ↓
            .git/origin-session.json (local state)
                    ↓
            origin-sessions branch (git plumbing)
                    ↓
            refs/notes/origin (git notes per commit)`}</CodeBlock>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Policy Enforcement Flow</h4>
          <div className="card bg-gray-800/30 border-gray-700">
            <pre className="text-xs font-mono text-gray-400 overflow-x-auto leading-relaxed">
{`Agent tries to read .env
  → pre-tool-use hook fires
  → CLI checks active policies (FILE_RESTRICTION: **/.env → block)
  → Returns { "decision": "block", "reason": "File restricted by policy" }
  → Agent receives block and skips the tool call`}</pre>
          </div>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Secret Redaction</h4>
          <p className="text-gray-400 text-sm mb-2">When enabled (default: true), Origin automatically redacts:</p>
          <div className="grid sm:grid-cols-2 gap-1 text-xs text-gray-400">
            {[
              'AWS keys (AKIA...)',
              'GitHub tokens (ghp_, gho_, ghu_, ghs_)',
              'OpenAI keys (sk-...)',
              'Anthropic keys (sk-ant-...)',
              'Stripe keys (sk_live_, sk_test_)',
              'Slack tokens (xoxb-, xoxp-)',
              'Private keys (-----BEGIN...)',
              'JWTs (eyJ...)',
              'Database connection strings',
              'High-entropy secrets (Shannon > 4.5)',
            ].map((s) => (
              <div key={s} className="flex items-center gap-2 py-1">
                <span className="text-green-400">✓</span> {s}
              </div>
            ))}
          </div>
        </div>
      );

    case 'data-storage':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Data Storage</h2>

          <h4 className="text-sm font-semibold text-gray-300 mt-4 mb-3">Local Files</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-800 rounded-lg overflow-hidden">
              <thead><tr className="bg-gray-800/60"><th className="text-left px-4 py-2 text-gray-400 font-medium">Path</th><th className="text-left px-4 py-2 text-gray-400 font-medium">Purpose</th></tr></thead>
              <tbody className="divide-y divide-gray-800">
                {[
                  ['~/.origin/config.json', 'API URL, key, org/user IDs, feature flags'],
                  ['~/.origin/agent.json', 'Machine registration (hostname, detected tools)'],
                  ['~/.origin/hooks.log', 'Debug log for all hook invocations'],
                  ['~/.origin/db/prompts.json', 'Local prompt database'],
                  ['~/.origin/blobs/<hash>', 'Content-addressable blob storage'],
                  ['~/.origin/plugins.json', 'Plugin registry'],
                  ['.git/origin-session.json', 'Active session state'],
                  ['.git/origin-session-<tag>.json', 'Concurrent session state (multi-agent)'],
                  ['.origin.json', 'Per-repo config (agent slug, ignore patterns)'],
                ].map(([path, purpose], i) => (
                  <tr key={path} className={i % 2 === 0 ? 'bg-gray-900/30' : ''}>
                    <td className="px-4 py-2 text-indigo-400 font-mono text-xs whitespace-nowrap">{path}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Git Refs</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-800 rounded-lg overflow-hidden">
              <thead><tr className="bg-gray-800/60"><th className="text-left px-4 py-2 text-gray-400 font-medium">Ref</th><th className="text-left px-4 py-2 text-gray-400 font-medium">Purpose</th></tr></thead>
              <tbody className="divide-y divide-gray-800">
                <tr className="bg-gray-900/30"><td className="px-4 py-2 text-indigo-400 font-mono text-xs">origin-sessions</td><td className="px-4 py-2 text-gray-400 text-xs">Orphan branch storing session data (metadata, prompts, changes per session)</td></tr>
                <tr><td className="px-4 py-2 text-indigo-400 font-mono text-xs">refs/notes/origin</td><td className="px-4 py-2 text-gray-400 text-xs">Git notes with AI attribution metadata per commit</td></tr>
                <tr className="bg-gray-900/30"><td className="px-4 py-2 text-indigo-400 font-mono text-xs">trails/</td><td className="px-4 py-2 text-gray-400 text-xs">Trail metadata (on origin-sessions branch)</td></tr>
              </tbody>
            </table>
          </div>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Origin-Sessions Branch Structure</h4>
          <CodeBlock>{`sessions/
  <sessionId>/
    metadata.json    # Session metrics, tokens, cost, git state
    prompts.md       # Human-readable markdown with all prompts
    changes.json     # Prompt-to-file mappings with diffs
trails/
  <trailId>.json     # Trail metadata`}</CodeBlock>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Git Notes Format</h4>
          <p className="text-gray-400 text-sm mb-2">Each AI-assisted commit gets a note under <code className="text-indigo-400">refs/notes/origin</code>:</p>
          <CodeBlock>{`{
  "sessionId": "abc-123",
  "model": "claude-sonnet-4",
  "promptCount": 5,
  "promptSummary": "Add authentication middleware...",
  "tokensUsed": 15000,
  "costUsd": 0.45,
  "durationMs": 120000,
  "linesAdded": 89,
  "linesRemoved": 12,
  "originUrl": "https://getorigin.io/sessions/abc-123"
}`}</CodeBlock>
          <CodeBlock>{`# View notes
git notes --ref=origin show <commit-sha>

# Push notes
git push origin refs/notes/origin`}</CodeBlock>
        </div>
      );

    case 'supported-agents':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Supported Agents</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-800 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-gray-800/60">
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Agent</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Transcript Format</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Hook System</th>
                  <th className="text-left px-4 py-2 text-gray-400 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {[
                  ['Claude Code', 'JSONL', 'Claude Code hooks API', 'Stable', 'text-green-400'],
                  ['Gemini CLI', 'JSON', 'Gemini lifecycle hooks', 'Stable', 'text-green-400'],
                  ['Cursor', 'JSONL', 'Cursor hooks API', 'Stable', 'text-green-400'],
                  ['Windsurf', 'JSONL', 'Windsurf hooks API', 'Preview', 'text-amber-400'],
                  ['Aider', 'Git-based', 'aider.conf.yml', 'Preview', 'text-amber-400'],
                ].map(([agent, format, hook, status, color], i) => (
                  <tr key={agent} className={i % 2 === 0 ? 'bg-gray-900/30' : ''}>
                    <td className="px-4 py-2 text-gray-200 font-medium">{agent}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs font-mono">{format}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{hook}</td>
                    <td className={`px-4 py-2 text-xs font-medium ${color}`}>{status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">Cost Estimation</h4>
          <p className="text-gray-400 text-sm">Origin estimates costs for: Claude Sonnet 4 / Opus 4 / Haiku, Gemini Pro / Ultra, GPT-4 / GPT-4o / o1 / o3, and custom models (configurable).</p>

          <h4 className="text-sm font-semibold text-gray-300 mt-6 mb-3">File Ignore Patterns</h4>
          <p className="text-gray-400 text-sm mb-2">Origin automatically ignores in attribution tracking:</p>
          <div className="text-xs text-gray-400 space-y-1">
            <p><strong className="text-gray-300">Lock files:</strong> package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock, go.sum</p>
            <p><strong className="text-gray-300">Generated:</strong> *.generated.*, *.min.js, *.min.css, *.map</p>
            <p><strong className="text-gray-300">Directories:</strong> node_modules/, vendor/, dist/, .next/, build/, __snapshots__/</p>
          </div>
          <p className="text-gray-500 text-xs mt-2">Override in <code className="text-indigo-400">.origin.json</code> with <code className="text-gray-400">ignorePatterns</code>.</p>
        </div>
      );

    case 'troubleshooting':
      return (
        <div>
          <h2 className="text-2xl font-bold mb-4">Troubleshooting</h2>

          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Hooks not firing</h3>
              <CodeBlock>{`origin doctor --verbose    # Check for issues
origin enable              # Reinstall hooks`}</CodeBlock>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Stale sessions</h3>
              <CodeBlock>{`origin clean --force       # Remove stale data
origin reset --force       # Clear current session`}</CodeBlock>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">View hook logs</h3>
              <CodeBlock>{`tail -100 ~/.origin/hooks.log`}</CodeBlock>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Check connection</h3>
              <CodeBlock>{`origin whoami              # Verify auth
origin status              # Check API health`}</CodeBlock>
            </div>
          </div>
        </div>
      );

    default:
      return null;
  }
}

export default function CLI() {
  const [activeSection, setActiveSection] = useState<Section>('overview');

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="flex gap-8">
        {/* Sidebar */}
        <aside className="hidden lg:block w-56 shrink-0">
          <div className="sticky top-24 space-y-1 max-h-[calc(100vh-8rem)] overflow-y-auto">
            {SECTIONS.map((s) => (
              <React.Fragment key={s.key}>
                {s.group && (
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest pt-4 pb-1 first:pt-0">
                    {s.group}
                  </p>
                )}
                <button
                  onClick={() => setActiveSection(s.key)}
                  className={`block w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    activeSection === s.key
                      ? 'bg-indigo-600/10 text-indigo-400 font-medium'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  {s.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        </aside>

        {/* Mobile nav */}
        <div className="lg:hidden fixed bottom-4 left-4 right-4 z-50">
          <select
            value={activeSection}
            onChange={(e) => setActiveSection(e.target.value as Section)}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-200 appearance-none"
          >
            {SECTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.group ? `${s.group} — ` : ''}{s.label}
              </option>
            ))}
          </select>
        </div>

        {/* Content */}
        <main className="flex-1 min-w-0">
          {renderSection(activeSection)}
        </main>
      </div>
    </div>
  );
}
