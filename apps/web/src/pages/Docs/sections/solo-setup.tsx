import { CodeBlock, H2, H3, P, Li, Step, Callout } from '../shared/Markdown';

export default function SoloSetupSection() {
  return (
    <>
          <div>
            <h1 id="solo-setup" className="text-2xl font-bold mb-2">Origin Solo Setup Guide</h1>
            <P>
              Origin Solo is a free personal dashboard for individual developers who use AI coding tools.
              Track every session, see costs across agents, and get line-level attribution &mdash; no team or organization required.
            </P>

            <Callout type="tip">
              Origin Solo is <strong className="text-green-200">completely free</strong> &mdash; unlimited repos, unlimited sessions, all agents supported. No credit card needed.
            </Callout>

            <H2 id="solo-create-account">Step 1: Create Your Solo Account</H2>
            <P>
              Go to <a href="https://getorigin.io/register/developer" className="text-emerald-400 hover:text-emerald-300 underline">getorigin.io/register</a> and create a Solo account.
              You can sign up with email/password or use GitHub, GitLab, or Google OAuth.
            </P>
            <Step n={1} title="Register">
              <span>Visit the <a href="https://getorigin.io/register/developer" className="text-emerald-400 hover:text-emerald-300 underline">registration page</a> and choose <strong className="text-emerald-400">Solo</strong> account. Enter your name, email, and password &mdash; or click a social login button.</span>
            </Step>
            <Step n={2} title="Verify & Sign In">
              <span>After registration you&rsquo;re automatically signed in and redirected to your personal dashboard at <a href="https://getorigin.io/me" className="text-emerald-400 hover:text-emerald-300 underline">/me</a>.</span>
            </Step>

            <H2 id="solo-install-cli">Step 2: Install the Origin CLI</H2>
            <P>
              The CLI is how sessions get tracked. It installs git hooks that automatically capture every AI coding session.
            </P>
            <CodeBlock title="Terminal">{`npm i -g https://getorigin.io/cli/origin-cli-latest.tgz`}</CodeBlock>
            <P>
              Verify the installation:
            </P>
            <CodeBlock>{`origin --version`}</CodeBlock>

            <H2 id="solo-login">Step 3: Log In from the CLI</H2>
            <P>
              Authenticate the CLI with your Solo account using an API key:
            </P>
            <ul className="space-y-1 mb-3">
              <Li>Go to <a href="https://getorigin.io/me" className="text-emerald-400 hover:text-emerald-300 underline">getorigin.io/me</a> &rarr; Settings &rarr; API Keys tab</Li>
              <Li>Create a new API key and copy it (it&rsquo;s only shown once)</Li>
              <Li>Run the login command with your key:</Li>
            </ul>
            <CodeBlock title="Terminal">{`origin login --key YOUR_API_KEY`}</CodeBlock>
            <P>
              Your credentials are stored locally at <code className="text-indigo-400">~/.origin/config.json</code>.
            </P>

            <H2 id="solo-init">Step 4: Initialize Your Repository</H2>
            <P>
              Navigate to any Git repository and run:
            </P>
            <CodeBlock title="Terminal">{`cd ~/your-project
origin enable`}</CodeBlock>
            <P>
              This auto-detects installed AI tools (Claude Code, Cursor, Copilot, Gemini, Windsurf, Aider, Codex, etc.),
              installs git hooks, and starts tracking sessions. You&rsquo;ll see output like:
            </P>
            <CodeBlock>{`Detecting AI agents...
✓ Claude Code (claude-code)
✓ Cursor (cursor)
Installing git hooks...
✓ post-commit hook installed
✓ Origin initialized in 2.1s`}</CodeBlock>
            <P>
              Repos and agents are auto-created in your dashboard &mdash; no manual configuration needed.
            </P>

            <H2 id="solo-start-coding">Step 5: Start Coding with AI</H2>
            <P>
              That&rsquo;s it! Now whenever you use an AI coding tool in this repo, Origin automatically captures:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Session metadata</strong> &mdash; model, agent, duration, token count, cost</Li>
              <Li><strong className="text-gray-200">Prompts &amp; responses</strong> &mdash; what you asked, what the agent did, which files changed per prompt</Li>
              <Li><strong className="text-gray-200">Diffs</strong> &mdash; line-by-line changes attributed to each session and prompt</Li>
              <Li><strong className="text-gray-200">Commit linkage</strong> &mdash; each commit is linked back to the session that produced it</Li>
            </ul>

            <H2 id="solo-verify">Verify It&rsquo;s Working</H2>
            <P>
              After your first AI-assisted commit, check that everything is tracking:
            </P>
            <CodeBlock title="Terminal">{`# View recent sessions
origin sessions

# See AI attribution for a file
origin blame src/index.ts

# Check your stats
origin stats`}</CodeBlock>
            <P>
              You can also visit your dashboard at <a href="https://getorigin.io/me" className="text-emerald-400 hover:text-emerald-300 underline">getorigin.io/me</a> to see sessions, cost breakdowns, and streaks.
            </P>

            <H2 id="solo-nav-walkthrough">Navigating Your Solo Workspace</H2>
            <P>
              Once you&rsquo;re logged in, the left sidebar is your home base. Each chapter below
              explains what the section is for, when to use it, and how to set it up.
            </P>

            {/* ── My Dashboard ─────────────────────────────────────── */}
            <H3 id="solo-nav-dashboard">1. My Dashboard</H3>
            <P>
              <strong className="text-gray-200">Purpose.</strong> Your daily snapshot &mdash; today&rsquo;s
              activity, week-over-week trends, current streak, and the four headline metrics
              (sessions, tokens, cost, lines written).
            </P>
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-4">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">/me &mdash; My Dashboard</span>
              </div>
              <div className="p-4 space-y-3">
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { l: 'Sessions', v: '142', c: 'text-indigo-400' },
                    { l: 'Tokens', v: '3.2M', c: 'text-yellow-400' },
                    { l: 'Cost', v: '$47.20', c: 'text-green-400' },
                    { l: 'Lines', v: '18.4k', c: 'text-emerald-400' },
                  ].map((c) => (
                    <div key={c.l} className="bg-gray-800/50 rounded p-2 border border-gray-700/50">
                      <div className="text-[9px] text-gray-500">{c.l}</div>
                      <div className={`text-base font-bold ${c.c}`}>{c.v}</div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-orange-400">
                  <span>&#128293;</span><span>5 day streak</span>
                </div>
              </div>
            </div>
            <P>
              <strong className="text-gray-200">How to set it up.</strong> Nothing &mdash; the dashboard
              populates itself the moment your first AI session is captured by the CLI. If it looks
              empty, re-run <code className="text-indigo-400">origin enable</code> inside a repo and do
              an AI-assisted edit.
            </P>

            {/* ── Repositories ─────────────────────────────────────── */}
            <H3 id="solo-nav-repos">2. Repositories</H3>
            <P>
              <strong className="text-gray-200">Purpose.</strong> The list of Git repos Origin is
              tracking for you. Each card shows health, total commits, AI vs. human split, and the
              last sync time. Click any repo to drill into its commit history.
            </P>
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-4">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">/repos</span>
              </div>
              <div className="p-4 space-y-2">
                {[
                  { name: 'org/api', ai: 62, total: 184 },
                  { name: 'org/web', ai: 41, total: 127 },
                  { name: 'personal/scripts', ai: 9, total: 22 },
                ].map((r) => (
                  <div key={r.name} className="flex items-center justify-between bg-gray-800/40 rounded px-3 py-2 border border-gray-700/40 text-xs">
                    <span className="text-gray-200">{r.name}</span>
                    <div className="flex items-center gap-4 text-[11px] text-gray-400">
                      <span>Total <span className="text-gray-200 font-semibold">{r.total}</span></span>
                      <span>AI <span className="text-indigo-400 font-semibold">{r.ai}</span></span>
                      <span>Human <span className="text-gray-200 font-semibold">{r.total - r.ai}</span></span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <P>
              <strong className="text-gray-200">How to set it up.</strong> Three options:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Automatic</strong> &mdash; run <code className="text-indigo-400">origin enable</code> in a repo and it gets registered on first commit. Easiest path.</Li>
              <Li><strong className="text-gray-200">Connect GitHub / GitLab</strong> &mdash; click <em>Connect GitHub</em> or <em>Connect GitLab</em> to bulk-import repos via OAuth. Commits auto-sync right after import.</Li>
              <Li><strong className="text-gray-200">Add Manually</strong> &mdash; paste a repo path or URL. Use this for standalone repos you want to surface without OAuth.</Li>
            </ul>

            {/* ── My Sessions ──────────────────────────────────────── */}
            <H3 id="solo-nav-sessions">3. My Sessions</H3>
            <P>
              <strong className="text-gray-200">Purpose.</strong> Every AI coding session Origin has
              captured, searchable and filterable by agent, repo, status, or tag. Click any row to
              see the full transcript, the exact diff attributed to each prompt, and the commit it
              produced.
            </P>
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-4">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">/sessions</span>
              </div>
              <div className="p-4">
                <div className="flex gap-2 mb-2">
                  <div className="flex-1 bg-gray-800/50 border border-gray-700 rounded px-3 py-1 text-[11px] text-gray-500">Search...</div>
                  <div className="bg-gray-800/50 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-400">All agents</div>
                </div>
                {[
                  { a: 'claude-code', r: 'org/api', d: '12m', c: '$0.84' },
                  { a: 'cursor', r: 'org/web', d: '8m', c: '$0.32' },
                  { a: 'claude-code', r: 'org/api', d: '45m', c: '$3.10' },
                ].map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px] py-1.5 border-b border-gray-800/50 last:border-0">
                    <span className="text-indigo-400">{s.a}</span>
                    <span className="text-gray-400">{s.r}</span>
                    <span className="text-gray-500">{s.d}</span>
                    <span className="text-gray-300">{s.c}</span>
                  </div>
                ))}
              </div>
            </div>
            <P>
              <strong className="text-gray-200">How to set it up.</strong> No setup &mdash; sessions
              are written automatically by the CLI whenever you start an AI tool inside a tracked
              repo. You can star &#9733; sessions you want to revisit and add tags (e.g.
              &ldquo;bugfix&rdquo;, &ldquo;refactor&rdquo;) for later filtering.
            </P>

            {/* ── Insights ─────────────────────────────────────────── */}
            <H3 id="solo-nav-insights">4. Insights</H3>
            <P>
              <strong className="text-gray-200">Purpose.</strong> Trend charts over time &mdash;
              daily/weekly session count, tokens by agent, cost by repo, and efficiency
              (lines-per-dollar / lines-per-minute). Use this when you want to see how your AI
              usage is shifting, not just what happened today.
            </P>
            <P>
              <strong className="text-gray-200">How to set it up.</strong> Nothing to configure.
              Insights populate after about a week of captured sessions &mdash; the trend lines
              need at least a few days of data to be meaningful.
            </P>

            {/* ── Integrations ─────────────────────────────────────── */}
            <H3 id="solo-nav-integrations">5. Integrations</H3>
            <P>
              <strong className="text-gray-200">Purpose.</strong> Connect external services so
              Origin can enrich your sessions and deliver notifications:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">GitHub / GitLab</strong> &mdash; OAuth link that enables bulk repo import, webhook-based commit sync, and PR-linked session views.</Li>
              <Li><strong className="text-gray-200">Slack / Discord</strong> (optional) &mdash; get pinged when a long session completes or a cost threshold is crossed.</Li>
              <Li><strong className="text-gray-200">AI Chat key</strong> &mdash; plug in your own Anthropic or OpenAI key to power &ldquo;Ask the Author&rdquo; over your own session history.</Li>
            </ul>
            <P>
              <strong className="text-gray-200">How to set it up.</strong> Click the integration
              card, follow the provider&rsquo;s OAuth prompt (or paste a token where asked), then
              return to Origin &mdash; the status flips to <em>Connected</em> when it worked.
            </P>

            {/* ── API Keys ─────────────────────────────────────────── */}
            <H3 id="solo-nav-apikeys">6. API Keys</H3>
            <P>
              <strong className="text-gray-200">Purpose.</strong> Personal access tokens for the
              CLI, MCP server, or custom scripts that talk to the Origin API on your behalf. You
              can create multiple keys, name them by machine (e.g. &ldquo;laptop&rdquo;,
              &ldquo;work-desktop&rdquo;), and revoke any individually.
            </P>
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-4">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">/api-keys</span>
              </div>
              <div className="p-4 space-y-2">
                {[
                  { n: 'laptop', k: 'orgn_•••••••••••••8f2a', last: 'today' },
                  { n: 'ci-runner', k: 'orgn_•••••••••••••b19c', last: '3d ago' },
                ].map((k) => (
                  <div key={k.n} className="flex items-center justify-between bg-gray-800/40 rounded px-3 py-2 border border-gray-700/40 text-xs">
                    <span className="text-gray-200">{k.n}</span>
                    <span className="text-gray-500 font-mono text-[10px]">{k.k}</span>
                    <span className="text-gray-500 text-[10px]">Last used {k.last}</span>
                  </div>
                ))}
              </div>
            </div>
            <P>
              <strong className="text-gray-200">How to set it up.</strong> Click <em>+ New Key</em>,
              give it a name, copy the token <strong className="text-amber-300">once</strong> (it
              isn&rsquo;t shown again), then run:
            </P>
            <CodeBlock>{`origin login --key YOUR_TOKEN`}</CodeBlock>

            {/* ── Settings ─────────────────────────────────────────── */}
            <H3 id="solo-nav-settings">7. Settings</H3>
            <P>
              <strong className="text-gray-200">Purpose.</strong> Account preferences &mdash; name
              and avatar, email &amp; password, weekly digest email, notification toggles, and the
              danger-zone account-delete action. Nothing here is required for tracking to work;
              it&rsquo;s purely personal preference.
            </P>
            <P>
              <strong className="text-gray-200">How to set it up.</strong> Open the tab, flip the
              toggles you care about, hit <em>Save</em>. The weekly digest (off by default) sends a
              Monday summary of your previous week&rsquo;s sessions, costs, and streak.
            </P>

            <Callout type="tip">
              Everything above is optional except <strong className="text-emerald-300">Repositories</strong>
              and the CLI login. Origin works out of the box; the other sections are there when
              you want to go deeper.
            </Callout>

            <H2 id="solo-multiple-repos">Adding More Repositories</H2>
            <P>
              Just run <code className="text-indigo-400">origin enable</code> in any additional Git repo. Each repo is auto-registered in your dashboard.
              There&rsquo;s no limit on the number of repos you can track.
            </P>

            <H2 id="solo-optional">Optional: Standalone Mode</H2>
            <P>
              If you prefer fully local tracking with no server connection, use standalone mode:
            </P>
            <CodeBlock>{`origin enable --standalone`}</CodeBlock>
            <P>
              Sessions are stored locally via git notes and a local SQLite database. You can switch to connected mode later by running
              <code className="text-indigo-400"> origin login</code> followed by <code className="text-indigo-400">origin enable</code>.
            </P>

            <H2 id="solo-next-steps">Next Steps</H2>
            <ul className="space-y-2 mb-4">
              <Li>Explore your <button onClick={() => { window.history.replaceState(null, '', '#developer-dashboard'); window.location.reload(); }} className="text-indigo-400 hover:text-indigo-300 underline">Solo Dashboard</button> to see session analytics and streaks</Li>
              <Li>Use <button onClick={() => { window.history.replaceState(null, '', '#ai-blame'); window.location.reload(); }} className="text-indigo-400 hover:text-indigo-300 underline">AI Blame</button> to see which agent wrote each line of your code</Li>
              <Li>Try <code className="text-indigo-400">origin stats</code> to view cost &amp; usage breakdowns from the terminal</Li>
              <Li>Join a team later via invite link &mdash; your Solo account stays active alongside the org</Li>
            </ul>
          </div>
    </>
  );
}
