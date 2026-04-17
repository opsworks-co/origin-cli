import { CodeBlock, H2, H3, P, Li, Step, Callout } from '../shared/Markdown';

export default function WorkflowSection() {
  return (
    <>
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
    </>
  );
}
