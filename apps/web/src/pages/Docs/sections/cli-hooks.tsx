import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function CliHooksSection() {
  return (
    <>
          <div>
            <h1 id="cli-hooks" className="text-2xl font-bold mb-2">Git &amp; Agent Hooks</h1>
            <P>
              Origin captures session data via two layers of hooks:
              <strong className="text-gray-200"> agent-side hooks</strong> (fired by Claude Code,
              Cursor, Codex, etc. as the AI runs), and <strong className="text-gray-200">git
              hooks</strong> (fired when commits land). Both are installed by{' '}
              <code className="text-indigo-400">origin enable</code>.
            </P>

            <H2>Agent Hook Events</H2>
            <P>Each agent that fires hooks calls <code className="text-indigo-400">origin hooks &lt;event&gt;</code>. The five events:</P>

            <div className="space-y-3 mt-3">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">session-start</code>
                <P>
                  Fired when an AI tool begins a coding session. Origin: assigns a session ID, captures
                  the repo, branch, machine, and model; writes the agent-specific rules file
                  (<code className="text-indigo-400">CLAUDE.md</code>, <code className="text-indigo-400">AGENTS.md</code>,{' '}
                  <code className="text-indigo-400">~/.cursor/rules/origin.md</code>, <code className="text-indigo-400">.windsurfrules</code>,{' '}
                  <code className="text-indigo-400">GEMINI.md</code>); reads the most recent session from{' '}
                  <code className="text-indigo-400">refs/notes/origin-memory</code> to record a{' '}
                  <code className="text-indigo-400">previousSessionId</code> back-pointer.
                </P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">user-prompt-submit</code>
                <P>
                  Fired when the user types a prompt. Origin appends it to the session&apos;s prompt
                  history (after stripping IDE/system envelopes — <code className="text-indigo-400">&lt;system-reminder&gt;</code>,{' '}
                  <code className="text-indigo-400">&lt;INSTRUCTIONS&gt;</code>, our own{' '}
                  <code className="text-indigo-400">&lt;!-- origin-managed --&gt;</code> blocks), captures
                  per-prompt git state for diff attribution, and refreshes the active branch.
                </P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">pre-tool-use</code>
                <P>
                  Fired before every tool call. Origin: enforces file-restriction policies (can block
                  the tool with exit code 2), takes an auto-snapshot before file-modifying tools (so
                  you can rewind), injects per-file attribution context (so the agent sees who wrote
                  the lines it&apos;s about to edit), and tracks <code className="text-indigo-400">filesRead</code>{' '}
                  for read-style tools — that list ships in the next git note.
                </P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">post-tool-use</code>
                <P>
                  Fired after every tool call. Origin records the result, refreshes the branch,
                  emits real-time tool events to the platform (when connected), and updates the
                  in-flight state file.
                </P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">session-end</code>
                <P>
                  Fired when the session finishes. Origin parses the transcript (Claude JSONL, Codex
                  rollout, Gemini chats, Cursor SQLite, Aider logs), computes cost, writes session
                  files to the <code className="text-indigo-400">origin-sessions</code> branch, writes
                  per-commit notes to <code className="text-indigo-400">refs/notes/origin</code>, and
                  triggers an acceptance backfill against the previous session&apos;s commits — the
                  result lands in <code className="text-indigo-400">refs/notes/origin-acceptance</code>.
                </P>
              </div>
            </div>

            <H2>Git Hook Events</H2>
            <P>Origin installs four git hooks via <code className="text-indigo-400">origin enable</code>:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">post-commit</strong> &mdash; if a commit landed during an active session, links it to the session and writes a commit-level git note. If no session is active, runs an AI-detection heuristic on the commit (process check, message pattern) and writes a snapshot note when the commit looks AI-authored.</Li>
              <Li><strong className="text-gray-200">prepare-commit-msg</strong> &mdash; appends an <code className="text-indigo-400">Origin-Session: &lt;id&gt;</code> trailer so the session ID is recoverable from the commit message even if notes get lost.</Li>
              <Li><strong className="text-gray-200">pre-commit</strong> &mdash; runs the secret scanner against staged content; can block on findings (configurable via policy).</Li>
              <Li><strong className="text-gray-200">pre-push</strong> &mdash; on push to a remote, ensures the pushed commits have valid Origin notes and (in team mode) checks against governance policies.</Li>
            </ul>
            <Callout type="info">
              All four hooks are <em>idempotent</em> — re-running <code className="text-indigo-400">origin enable</code>{' '}
              on a repo with corrupted hook files (empty, wrong mode, partial install) detects and
              repairs them. Verified by 17 dedicated regression tests.
            </Callout>

            <H2>Managing Hooks</H2>
            <CodeBlock>{`# Install / refresh hooks for all detected agents
origin enable

# Install for one specific agent
origin enable --agent claude-code
origin enable --agent cursor
origin enable --agent codex
origin enable --agent gemini

# Skip writing the agent rules file (CLAUDE.md / AGENTS.md / etc.)
origin enable --no-rules

# Standalone (no platform), still installs hooks
origin enable --standalone

# Remove hooks for an agent
origin disable claude-code

# Health-check hook installation + suggest fixes
origin doctor
origin doctor --fix

# Verify hooks fire end-to-end (synthetic event injection)
origin verify`}</CodeBlock>

            <H2>Supported AI Tools</H2>
            <P>Origin auto-detects and integrates with:</P>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-gray-300 text-sm mb-4">
              <Li>Claude Code &mdash; native hook events</Li>
              <Li>Cursor &mdash; hook events + SQLite scrape for full transcript</Li>
              <Li>Codex CLI &mdash; rollout JSONL + native hooks</Li>
              <Li>Gemini CLI &mdash; chats/checkpoints + native hooks</Li>
              <Li>Windsurf &mdash; workspace integration</Li>
              <Li>Aider &mdash; log scraping + commit detection</Li>
              <Li>GitHub Copilot &mdash; commit-trailer detection</Li>
              <Li>Cody &mdash; commit-trailer detection</Li>
              <Li>Continue &mdash; commit-trailer detection</Li>
              <Li>Cline &mdash; commit-trailer detection</Li>
              <Li>Codeium &mdash; commit-trailer detection</Li>
              <Li>Amp / Junie / Rovo / Droid &mdash; commit-trailer detection</Li>
            </div>
            <p className="text-gray-500 text-sm mb-4">
              For tools without first-class hooks, Origin still attributes commits via{' '}
              <code className="text-indigo-400">Co-Authored-By:</code> trailers and author patterns —
              detection runs at <code className="text-indigo-400">post-commit</code> time and during{' '}
              <code className="text-indigo-400">origin backfill</code>.
            </p>
          </div>
    </>
  );
}
