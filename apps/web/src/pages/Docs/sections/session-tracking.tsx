import { CodeBlock, H2, H3, P, Li, Step, Callout } from '../shared/Markdown';

export default function SessionTrackingSection() {
  return (
    <>
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
    </>
  );
}
