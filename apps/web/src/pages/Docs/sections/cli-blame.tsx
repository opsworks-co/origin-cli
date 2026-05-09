import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function CliBlameSection() {
  return (
    <>
          <div>
            <h1 id="cli-blame" className="text-2xl font-bold mb-2">origin blame</h1>
            <P>
              Line-level AI attribution from the command line. Cross-references{' '}
              <code className="text-indigo-400">git blame</code> with Origin&apos;s git notes to
              tell you, for every line in a file: which agent wrote it, which model, and (with{' '}
              <code className="text-indigo-400">--json</code>) the prompt and acceptance metrics
              behind the change.
            </P>
            <P>
              Works offline. Just needs the repo + the <code className="text-indigo-400">refs/notes/origin*</code> refs
              fetched.
            </P>

            <H2>Usage</H2>
            <CodeBlock>{`origin blame <file> [--line <range>] [--json]`}</CodeBlock>

            <H2>Examples</H2>
            <CodeBlock title="Pretty output (default)">{`# Whole file
origin blame src/auth.ts

# Just lines 10-20
origin blame src/auth.ts --line 10-20

# Single line
origin blame src/auth.ts --line 42`}</CodeBlock>
            <P>Each line is tagged with one of:</P>
            <ul className="space-y-2 mb-4">
              <Li><code className="text-emerald-400 font-bold">[AI]</code> &mdash; written by an AI agent (matched via origin note or commit-trailer fallback)</Li>
              <Li><code className="text-gray-200 font-bold">[HU]</code> &mdash; human-authored</Li>
              <Li><code className="text-yellow-400 font-bold">[MX]</code> &mdash; mixed (line touched by both)</Li>
            </ul>

            <H2>JSON Output</H2>
            <P>
              <code className="text-indigo-400">--json</code> emits per-line attribution alongside a
              per-session context map — so consumers can answer{' '}
              <em>&ldquo;what was the prompt behind this line, and did the human keep it?&rdquo;</em> with one call.
            </P>
            <CodeBlock title="origin blame src/auth.ts --line 5-15 --json">{`{
  "file": "src/auth.ts",
  "lines": [
    {
      "lineNumber": 5,
      "authorship": "ai",
      "sessionId": "ea74b665-…",
      "model": "claude-sonnet-4-6",
      "tool": "claude-code",
      "author": "Artem Dolobanko",
      "commitSha": "9a1f2b3c4d…",
      "content": "import { verify } from 'jsonwebtoken';"
    }
    /* …more lines… */
  ],
  "sessions": {
    "ea74b665-…": {
      "sessionId": "ea74b665-…",
      "model": "claude-sonnet-4-6",
      "agent": "claude-code",
      "fullPrompt": "Implement user authentication with JWT tokens…",
      "promptSummary": "Implement user authentication with JWT tokens…",
      "previousSessionId": "8d3a91c4-…",
      "filesRead": [
        "src/models/user.ts",
        "src/routes/auth.ts"
      ],
      "acceptanceRate": 0.85,
      "acceptanceComputedAt": "2026-05-09T00:31:54Z",
      "originUrl": "https://getorigin.io/sessions/ea74b665-…"
    }
  }
}`}</CodeBlock>

            <H2>Per-Session Context</H2>
            <P>
              Every unique session referenced by the lines in your filter shows up once in the{' '}
              <code className="text-indigo-400">sessions</code> map. The fields:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">fullPrompt</strong> &mdash; redacted, untruncated prompt (≤ 8 KB) from <code className="text-indigo-400">refs/notes/origin</code></Li>
              <Li><strong className="text-gray-200">previousSessionId</strong> &mdash; pointer to the session before this one in the same repo; chase it back to reconstruct an evolution chain</Li>
              <Li><strong className="text-gray-200">filesRead</strong> &mdash; what the agent loaded into context (read-style tools), not just what it changed</Li>
              <Li><strong className="text-gray-200">acceptanceRate</strong> &mdash; fraction (0–1) of the session&apos;s added lines still present on HEAD; populated by the <em>next</em> session&apos;s end-of-run backfill (so the most recent session won&apos;t have one yet)</Li>
              <Li><strong className="text-gray-200">originUrl</strong> &mdash; deep link to the full session in the dashboard (transcript, tool calls, diffs)</Li>
            </ul>
            <Callout type="info">
              <code className="text-indigo-400">acceptanceRate</code> only appears once a follow-up
              session has ended. Until then the session&apos;s lines are still &ldquo;in flight&rdquo;
              and there&apos;s no human reaction to measure.
            </Callout>

            <H2>How Attribution Is Decided</H2>
            <P>For each line, Origin checks in order:</P>
            <ol className="space-y-2 mb-4 list-decimal pl-6 text-gray-300">
              <li><strong className="text-gray-200">Origin git note</strong> on the commit (<code className="text-indigo-400">refs/notes/origin</code>) — authoritative when present</li>
              <li><strong className="text-gray-200">Commit message trailers</strong> — <code className="text-indigo-400">Origin-Session:</code>, <code className="text-indigo-400">Co-Authored-By: claude/codex/copilot/…</code></li>
              <li><strong className="text-gray-200">Active session range</strong> — if a session is still running and the commit falls inside its <code className="text-indigo-400">headBefore..HEAD</code> window, the line is AI</li>
              <li><strong className="text-gray-200">Author pattern</strong> — falls through to git author for the human/AI split</li>
            </ol>
            <P>
              That layered fallback is what makes attribution work even on commits authored by
              other agents (Copilot, Cursor, Aider, …) that Origin didn&apos;t directly track —
              the trailer-based detection still picks them up.
            </P>

            <H2>Common Workflows</H2>
            <CodeBlock title="What was the prompt behind this bug?">{`# 1. Find which line broke
git blame src/auth.ts | grep "buggy code"

# 2. Get the prompt + session for that line
origin blame src/auth.ts --line 42 --json | jq '.sessions'`}</CodeBlock>
            <CodeBlock title="Audit which lines a teammate's session produced">{`# Filter blame to a session you care about
origin blame src/auth.ts --json \\
  | jq '.lines[] | select(.sessionId == "ea74b665-…")'`}</CodeBlock>
            <CodeBlock title="Find low-acceptance sessions (lines humans rejected)">{`origin blame src/auth.ts --json \\
  | jq '.sessions | to_entries[] | select(.value.acceptanceRate < 0.5)'`}</CodeBlock>
          </div>
    </>
  );
}
