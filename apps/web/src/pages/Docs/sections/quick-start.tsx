import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function QuickStartSection() {
  return (
    <>
          <div>
            <h1 id="quick-start" className="text-2xl font-bold mb-2">Quick Start Guide</h1>
            <P>
              Get Origin fully configured in under 10 minutes. This guide walks you through every step
              with visual examples &mdash; from creating your account to seeing your first AI session on the dashboard.
            </P>

            <Callout type="tip">
              You can do steps 1&ndash;4 entirely in the browser. Step 5 (CLI install) happens on each developer&rsquo;s machine and takes 30 seconds.
            </Callout>

            {/* ── STEP 1 ─────────────────────────────────────────── */}
            <H2 id="qs-step1">Step 1: Create Your Account</H2>
            <P>
              Go to <a href="https://getorigin.io" className="text-indigo-400 hover:underline" target="_blank" rel="noopener noreferrer">getorigin.io</a> and
              click <strong className="text-gray-200">Get Started</strong>. Sign up with your email. You&rsquo;ll be asked to create an organization &mdash;
              this is your team&rsquo;s workspace where all repos, agents, and policies live.
            </P>

            {/* visual mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">getorigin.io</span>
              </div>
              <div className="p-8 flex flex-col items-center gap-4">
                <div className="text-lg font-bold text-gray-100">Create your organization</div>
                <div className="w-full max-w-sm space-y-3">
                  <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-400">Your Company Name</div>
                  <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-400">admin@yourcompany.com</div>
                  <div className="bg-indigo-600 rounded-lg px-4 py-2.5 text-sm font-medium text-center">Create Organization</div>
                </div>
              </div>
            </div>

            {/* ── STEP 2 ─────────────────────────────────────────── */}
            <H2 id="qs-step2">Step 2: Connect GitHub or GitLab</H2>
            <P>
              Navigate to <strong className="text-gray-200">Settings &rarr; Integrations</strong> in the left sidebar.
              Click the GitHub or GitLab card and connect via OAuth or Personal Access Token. This lets Origin
              auto-discover your repos, set up webhooks, and post PR/MR status checks.
            </P>

            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Origin &mdash; Settings &rarr; Integrations</span>
              </div>
              <div className="p-6 space-y-4">
                <div className="flex items-center gap-4 bg-gray-800/50 border border-gray-700 rounded-lg p-4">
                  <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
                    <svg className="w-6 h-6 text-gray-300" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" /></svg>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-200">GitHub</div>
                    <div className="text-xs text-gray-500">Connect via OAuth or Personal Access Token</div>
                  </div>
                  <div className="px-3 py-1.5 bg-indigo-600 rounded-lg text-xs font-medium">Connect</div>
                </div>
                <div className="flex items-center gap-4 bg-gray-800/50 border border-gray-700 rounded-lg p-4">
                  <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
                    <svg className="w-6 h-6 text-orange-400" viewBox="0 0 24 24" fill="currentColor"><path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/></svg>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-200">GitLab</div>
                    <div className="text-xs text-gray-500">Connect via Personal Access Token</div>
                  </div>
                  <div className="px-3 py-1.5 bg-gray-700 rounded-lg text-xs font-medium text-gray-300">Connect</div>
                </div>
              </div>
            </div>

            <Callout type="info">
              <strong>GitHub OAuth</strong> is the easiest option &mdash; click Connect, authorize Origin, and you&rsquo;re done.
              For GitHub Enterprise or GitLab, use a Personal Access Token with <code className="text-xs">repo</code> scope.
            </Callout>

            {/* ── STEP 3 ─────────────────────────────────────────── */}
            <H2 id="qs-step3">Step 3: Import Repositories</H2>
            <P>
              Go to <strong className="text-gray-200">Repositories</strong> in the left sidebar. If you connected GitHub/GitLab,
              click <strong className="text-gray-200">Import from GitHub</strong> (or GitLab). Origin auto-discovers all your repos.
              Select the ones you want to track and click Import.
            </P>

            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Origin &mdash; Repositories &rarr; Import</span>
              </div>
              <div className="p-6 space-y-3">
                <div className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked readOnly className="rounded border-gray-600 bg-gray-800 text-indigo-500" />
                    <div>
                      <div className="text-sm font-medium text-gray-200">yourcompany/backend-api</div>
                      <div className="text-xs text-gray-500">TypeScript &middot; Updated 2h ago</div>
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30">Public</span>
                </div>
                <div className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked readOnly className="rounded border-gray-600 bg-gray-800 text-indigo-500" />
                    <div>
                      <div className="text-sm font-medium text-gray-200">yourcompany/frontend-web</div>
                      <div className="text-xs text-gray-500">React &middot; Updated 5h ago</div>
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400 border border-gray-500/30">Private</span>
                </div>
                <div className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" readOnly className="rounded border-gray-600 bg-gray-800" />
                    <div>
                      <div className="text-sm font-medium text-gray-200">yourcompany/docs</div>
                      <div className="text-xs text-gray-500">Markdown &middot; Updated 3d ago</div>
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400 border border-gray-500/30">Private</span>
                </div>
                <div className="pt-2">
                  <div className="bg-indigo-600 rounded-lg px-4 py-2 text-sm font-medium text-center w-48">Import 2 Repositories</div>
                </div>
              </div>
            </div>

            <P>
              You can also add repos manually by clicking <strong className="text-gray-200">Add Repository</strong> and entering the repo name and path.
              The CLI will match sessions to repos by the git remote URL or local path.
            </P>

            {/* ── STEP 4 ─────────────────────────────────────────── */}
            <H2 id="qs-step4">Step 4: Register Your Agents</H2>
            <P>
              Go to <strong className="text-gray-200">Agents</strong> in the left sidebar and click <strong className="text-gray-200">Create Agent</strong>.
              An agent represents an AI coding tool your team uses. Give it a name, a slug (used by the CLI to match sessions),
              and select the provider (Anthropic, OpenAI, Google, etc.).
            </P>

            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Origin &mdash; Agents &rarr; Create</span>
              </div>
              <div className="p-6 space-y-4 max-w-md">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">Agent Name</label>
                  <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-200">Claude Code</div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">Slug <span className="text-gray-600">(used by CLI to match sessions)</span></label>
                  <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-400 font-mono">claude-code</div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">Provider</label>
                  <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-200 flex items-center justify-between">
                    <span>Anthropic</span>
                    <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                  </div>
                </div>
                <div className="pt-2">
                  <div className="bg-indigo-600 rounded-lg px-4 py-2.5 text-sm font-medium text-center">Create Agent</div>
                </div>
              </div>
            </div>

            <Callout type="tip">
              Common agent slugs: <code className="text-xs">claude-code</code>, <code className="text-xs">cursor</code>, <code className="text-xs">codex</code>, <code className="text-xs">gemini</code>, <code className="text-xs">windsurf</code>, <code className="text-xs">aider</code>.
              The slug must match what the CLI sends &mdash; these are the defaults used by <code className="text-xs">origin enable</code>.
            </Callout>

            {/* ── STEP 5 ─────────────────────────────────────────── */}
            <H2 id="qs-step5">Step 5: Set Up the Anthropic API Key</H2>
            <P>
              Go to <strong className="text-gray-200">Settings &rarr; General</strong> and scroll to the <strong className="text-gray-200">LLM Configuration</strong> section.
              Enter your Anthropic API key. This is used for AI-powered features like &ldquo;Ask the Author&rdquo; chat, AI auto-review, and session summarization.
            </P>

            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Origin &mdash; Settings &rarr; General</span>
              </div>
              <div className="p-6 space-y-4 max-w-lg">
                <div className="text-sm font-semibold text-gray-200">LLM Configuration</div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">Anthropic API Key</label>
                  <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-500 font-mono">sk-ant-api03-&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">Model <span className="text-gray-600">(optional)</span></label>
                  <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-200 flex items-center justify-between">
                    <span>claude-sonnet-4-20250514</span>
                    <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                  </div>
                </div>
                <div className="bg-indigo-600 rounded-lg px-4 py-2 text-sm font-medium text-center w-24">Save</div>
              </div>
            </div>

            {/* ── STEP 6 ─────────────────────────────────────────── */}
            <H2 id="qs-step6">Step 6: Install the CLI on Developer Machines</H2>
            <P>
              Each developer runs these commands on their machine. It takes about 30 seconds.
            </P>

            <CodeBlock title="Terminal">{`# Install the CLI
npm i -g https://getorigin.io/cli/origin-cli-latest.tgz

# Login to your Origin account
origin login

# Initialize and install hooks (auto-detects all AI agents)
origin enable`}</CodeBlock>

            <P>
              <code>origin enable</code> auto-detects installed AI agents (Claude Code, Cursor, Codex, Gemini, etc.)
              and installs tracking hooks for each one. After this, every AI coding session in any repo is
              automatically tracked.
            </P>

            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Terminal</span>
              </div>
              <div className="p-4 font-mono text-sm space-y-1">
                <div><span className="text-gray-500">$</span> <span className="text-gray-300">origin enable</span></div>
                <div className="text-gray-500 mt-2">Detecting AI coding agents...</div>
                <div className="mt-1">
                  <span className="text-green-400">✓</span> <span className="text-gray-300">Claude Code</span> <span className="text-gray-600">— hooks installed</span>
                </div>
                <div>
                  <span className="text-green-400">✓</span> <span className="text-gray-300">Cursor</span> <span className="text-gray-600">— hooks installed</span>
                </div>
                <div>
                  <span className="text-green-400">✓</span> <span className="text-gray-300">Codex CLI</span> <span className="text-gray-600">— hooks installed</span>
                </div>
                <div className="mt-2 text-green-400">Done. Origin is tracking AI sessions globally.</div>
                <div className="text-gray-600">Sessions will appear on your dashboard automatically.</div>
              </div>
            </div>

            <Callout type="info">
              <strong>Global vs per-repo:</strong> By default, <code className="text-xs">origin enable</code> installs hooks globally
              so ALL repos are tracked. To install per-repo only, run <code className="text-xs">origin enable</code> inside a specific repo.
            </Callout>

            {/* ── STEP 7 ─────────────────────────────────────────── */}
            <H2 id="qs-step7">Step 7: Create Your First Policy <span className="text-gray-600 text-sm font-normal">(optional)</span></H2>
            <P>
              Go to <strong className="text-gray-200">Policies</strong> and click <strong className="text-gray-200">Create Policy</strong>.
              Policies control what AI agents can do. Start with something simple like blocking commits to sensitive files:
            </P>

            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Origin &mdash; Policies &rarr; Create</span>
              </div>
              <div className="p-6 space-y-3">
                <div className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center text-red-400 text-sm font-bold">!</div>
                    <div>
                      <div className="text-sm font-medium text-gray-200">Restricted Files</div>
                      <div className="text-xs text-gray-500">Block AI from modifying specific files or directories</div>
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">Blocks</span>
                </div>
                <div className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-yellow-500/20 flex items-center justify-center text-yellow-400 text-sm font-bold">$</div>
                    <div>
                      <div className="text-sm font-medium text-gray-200">Cost Limit</div>
                      <div className="text-xs text-gray-500">Cap per-session spend (e.g. $5 max per session)</div>
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">Warns</span>
                </div>
                <div className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center text-blue-400 text-sm font-bold">R</div>
                    <div>
                      <div className="text-sm font-medium text-gray-200">Review Required</div>
                      <div className="text-xs text-gray-500">Require human review before AI session is approved</div>
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">Review</span>
                </div>
              </div>
            </div>

            {/* ── STEP 8 ─────────────────────────────────────────── */}
            <H2 id="qs-step8">Step 8: Verify Everything Works</H2>
            <P>
              Start an AI coding session in any tracked repo. Open Claude Code, Cursor, or Codex and send a prompt.
              Then check the dashboard &mdash; you should see a live session:
            </P>

            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Origin &mdash; Dashboard</span>
              </div>
              <div className="p-6">
                <div className="text-sm font-semibold text-gray-200 mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  Active Sessions (1)
                </div>
                <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-700 text-xs text-gray-500">
                        <th className="px-4 py-2 text-left">MODEL</th>
                        <th className="px-4 py-2 text-left">AGENT</th>
                        <th className="px-4 py-2 text-left">USER</th>
                        <th className="px-4 py-2 text-left">REPO</th>
                        <th className="px-4 py-2 text-left">DURATION</th>
                        <th className="px-4 py-2 text-left">TOKENS</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="px-4 py-2">
                          <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">CLAUDE-OPUS-4-6</span>
                        </td>
                        <td className="px-4 py-2 text-gray-300">Claude Code</td>
                        <td className="px-4 py-2 text-gray-400">You</td>
                        <td className="px-4 py-2 text-gray-400">backend-api</td>
                        <td className="px-4 py-2 text-gray-400">2m 15s</td>
                        <td className="px-4 py-2 text-gray-400">45.2k</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <P>
              You can also verify from the terminal:
            </P>
            <CodeBlock title="Terminal">{`$ origin status
  Session active: abc12345
  Agent: claude-code (claude-opus-4-6)
  Duration: 2m 15s
  Prompts: 3
  Files: src/api.ts, src/routes/users.ts`}</CodeBlock>

            <Callout type="tip">
              If sessions don&rsquo;t appear, run <code className="text-xs">origin doctor</code> to diagnose issues.
              Common fixes: re-run <code className="text-xs">origin enable</code> or check that hooks are installed with <code className="text-xs">origin verify</code>.
            </Callout>

            {/* ── WHAT'S NEXT ────────────────────────────────────── */}
            <H2 id="qs-next">What&rsquo;s Next</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Invite your team</strong> &mdash; Go to IAM to add team members and assign roles (Admin, Developer, Viewer)</Li>
              <Li><strong className="text-gray-200">Set up budget controls</strong> &mdash; Go to Budget to set daily/weekly/monthly spend limits with alerts</Li>
              <Li><strong className="text-gray-200">Enable AI auto-review</strong> &mdash; Sessions get automatically reviewed by AI for security issues and code quality</Li>
              <Li><strong className="text-gray-200">Configure Slack/webhooks</strong> &mdash; Get notified when sessions complete, policies are violated, or budgets are exceeded</Li>
              <Li><strong className="text-gray-200">Try the CLI locally</strong> &mdash; Run <code className="text-xs">origin blame &lt;file&gt;</code>, <code className="text-xs">origin stats</code>, or <code className="text-xs">origin sessions</code></Li>
            </ul>
          </div>
    </>
  );
}
