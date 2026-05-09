import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function CliSessionsSection() {
  return (
    <>
          <div>
            <h1 id="cli-sessions" className="text-2xl font-bold mb-2">CLI Session Tracking</h1>
            <P>
              Origin automatically tracks AI coding sessions via agent hooks (Claude Code,
              Cursor, Codex, Gemini, Aider, Windsurf, Copilot, …). Each session captures the
              model, prompts, files changed, files <em>read</em>, cost, tokens, and duration —
              and writes a portable summary to git notes so attribution survives a clone.
            </P>

            <H2>List Sessions</H2>
            <CodeBlock>{`# Recent sessions for the current repo (default limit 20)
origin sessions

# Show more sessions
origin sessions --limit 50

# Filter by review status
origin sessions --status unreviewed
origin sessions --status approved
origin sessions --status rejected
origin sessions --status flagged

# Filter by model (substring match)
origin sessions --model sonnet
origin sessions --model gpt-5

# Show only sessions stored locally (not synced to Origin platform)
origin sessions --local

# Add a "source" column showing local vs origin per row
origin sessions --source

# All repos on this machine (global view)
origin sessions --all`}</CodeBlock>
            <Callout type="info">
              Status filters work across both connected and standalone modes. Solo / standalone
              users see review status applied client-side; team users see the server-authoritative
              status.
            </Callout>

            <H2>Show a Session</H2>
            <CodeBlock>{`# By full or short ID (first 8 chars)
origin sessions show ea74b665
origin sessions show ea74b665-88ef-48a6-bcc1-833d8e5cfc87`}</CodeBlock>
            <P>
              Shows model, agent, cost, tokens, duration, lines changed, files touched, branch,
              the commits the session produced, and the full prompt history (redacted).
            </P>
            <P>
              For a line-by-line view of who wrote what, use{' '}
              <code className="text-indigo-400">origin blame</code> — it cross-references git
              blame with the per-commit notes Origin wrote during this and other sessions.
            </P>

            <H2>Manage Running Sessions</H2>
            <CodeBlock>{`# End a running session manually
origin sessions end ea74b665

# Diagnose stuck/orphaned sessions on this machine
origin doctor
origin doctor --fix          # auto-resolve

# Clear local state for the current repo (does not touch git history)
origin reset

# Remove orphaned branches, stale state files, and dead session refs
origin clean
origin clean --dry-run       # preview without deleting`}</CodeBlock>

            <H2>Where Session Data Lives</H2>
            <P>The same session writes to multiple places, by design:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Git notes</strong> &mdash; <code className="text-indigo-400">refs/notes/origin</code> per commit (sessionId, model, agent, fullPrompt, previousSessionId, filesRead, cost, …). Pushable, portable, offline-readable.</Li>
              <Li><strong className="text-gray-200">Acceptance notes</strong> &mdash; <code className="text-indigo-400">refs/notes/origin-acceptance</code> backfilled by the next session (addedLines / survivingLines / acceptanceRate).</Li>
              <Li><strong className="text-gray-200">Memory ref</strong> &mdash; <code className="text-indigo-400">refs/notes/origin-memory</code> rolling index of the last 20 sessions (anchored to the repo&apos;s root commit).</Li>
              <Li><strong className="text-gray-200"><code className="text-indigo-400">origin-sessions</code> orphan branch</strong> &mdash; full per-session directory: <code className="text-indigo-400">metadata.json</code>, <code className="text-indigo-400">prompts.md</code>, <code className="text-indigo-400">changes.json</code>. Standalone mode&apos;s primary store.</Li>
              <Li><strong className="text-gray-200">Origin platform</strong> &mdash; full prompts, transcripts, tool-call timeline (connected mode only).</Li>
              <Li><strong className="text-gray-200">Local SQLite</strong> &mdash; <code className="text-indigo-400">~/.origin/db.sqlite</code> for fast queries (search, recap, stats).</Li>
              <Li><strong className="text-gray-200">In-flight state</strong> &mdash; <code className="text-indigo-400">~/.origin/sessions/&lt;tag&gt;.json</code> while a session is running.</Li>
            </ul>

            <H2>Search &amp; Recap</H2>
            <P>Beyond <code className="text-indigo-400">origin sessions</code>, daily-use commands:</P>
            <CodeBlock>{`# Full-text search across prompts + transcripts
origin search "JWT auth"

# What did I do today / this week
origin recap                     # today
origin recap --since 7d
origin recap --since 2026-04-01

# Compare two sessions
origin session-compare <id1> <id2>

# Why does this line exist?
origin why src/auth.ts:42`}</CodeBlock>
          </div>
    </>
  );
}
