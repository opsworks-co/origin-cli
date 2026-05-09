import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function GitNotesSection() {
  return (
    <>
          <div>
            <h1 id="git-notes" className="text-2xl font-bold mb-2">Git Notes</h1>
            <P>
              Origin writes structured AI metadata as Git Notes on every commit produced by a coding
              session. Notes travel with the repo, work offline, and survive a clone — so anyone
              with the repository (and the notes ref pulled) can answer{' '}
              <em>&ldquo;which agent wrote this commit, what was the prompt, and did the human keep it?&rdquo;</em>{' '}
              without ever calling the Origin API.
            </P>

            <H2>What Are Git Notes?</H2>
            <P>
              Git Notes are a built-in Git feature that lets you attach extra information to a commit
              without rewriting the commit itself. Origin uses two custom namespaces so it never
              clobbers a user&apos;s own notes:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><code className="text-indigo-400">refs/notes/origin</code> &mdash; per-commit session metadata, written at session-end</Li>
              <Li><code className="text-indigo-400">refs/notes/origin-acceptance</code> &mdash; per-commit acceptance metrics, backfilled by the <em>next</em> session</Li>
              <Li><code className="text-indigo-400">refs/notes/origin-memory</code> &mdash; index of recent sessions (rolling window of last 20), anchored to the repo&apos;s root commit</Li>
            </ul>
            <Callout type="info">
              All three refs are pushable. Run{' '}
              <code className="text-indigo-400">git push origin refs/notes/origin*</code> once to share
              attribution with your team — every clone that fetches them gets the same{' '}
              <code className="text-indigo-400">origin blame</code> output.
            </Callout>

            <H2>Per-Commit Note (refs/notes/origin)</H2>
            <P>
              Every commit a session produces gets one note. Fields are additive — older readers
              ignore unknown keys, so notes written by older CLIs continue to work.
            </P>
            <h3 className="text-base font-semibold text-gray-200 mt-4 mb-2">Identity</h3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">sessionId</strong> &mdash; canonical Origin session ID; pointer to the full audit trail in the dashboard</Li>
              <Li><strong className="text-gray-200">model</strong> &mdash; provider model string (<code className="text-indigo-400">claude-sonnet-4-…</code>, <code className="text-indigo-400">gpt-5-codex</code>, <code className="text-indigo-400">gemini-2.5-pro</code>, …)</Li>
              <Li><strong className="text-gray-200">agent</strong> &mdash; agent slug (<code className="text-indigo-400">claude-code</code>, <code className="text-indigo-400">cursor</code>, <code className="text-indigo-400">codex</code>, <code className="text-indigo-400">gemini</code>, <code className="text-indigo-400">aider</code>, <code className="text-indigo-400">windsurf</code>, …) — set when the agent is known at write time</Li>
              <Li><strong className="text-gray-200">timestamp</strong> &mdash; ISO 8601 instant the note was written</Li>
              <Li><strong className="text-gray-200">originUrl</strong> &mdash; deep link to the session in the Origin dashboard</Li>
            </ul>
            <h3 className="text-base font-semibold text-gray-200 mt-4 mb-2">Prompt context</h3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">promptCount</strong> &mdash; total prompts in the session</Li>
              <Li><strong className="text-gray-200">promptSummary</strong> &mdash; redacted, truncated to 200 chars (legacy field; keep for compatibility)</Li>
              <Li>
                <strong className="text-gray-200">fullPrompt</strong>{' '}
                <span className="ml-1 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">new</span>
                {' '}— last user prompt run through the secret-redaction engine and capped at 8 KB
                (UTF-8 byte aware). Lets the next agent reading blame see the actual intent
                behind a commit, not just a teaser.
              </Li>
              <Li>
                <strong className="text-gray-200">previousSessionId</strong>{' '}
                <span className="ml-1 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">new</span>
                {' '}— pointer to the prior session in this repo, captured at session-start from{' '}
                <code className="text-indigo-400">refs/notes/origin-memory</code>. Walk this back-pointer
                across commits to reconstruct how a feature evolved across sessions.
              </Li>
              <Li>
                <strong className="text-gray-200">filesRead</strong>{' '}
                <span className="ml-1 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">new</span>
                {' '}— deduped, repo-relative paths the agent loaded into context (cap 100). Helps
                the next agent understand what the prior agent <em>looked at</em>, not just what
                it changed.
              </Li>
            </ul>
            <h3 className="text-base font-semibold text-gray-200 mt-4 mb-2">Usage &amp; cost</h3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">tokensUsed</strong> &mdash; fresh input + output tokens (cache reads/creations excluded)</Li>
              <Li><strong className="text-gray-200">costUsd</strong> &mdash; estimated USD cost using the active pricing table</Li>
              <Li><strong className="text-gray-200">durationMs</strong> &mdash; wall-clock session duration in milliseconds</Li>
            </ul>
            <h3 className="text-base font-semibold text-gray-200 mt-4 mb-2">Code change</h3>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">linesAdded / linesRemoved</strong> &mdash; aggregate diff size for this session</Li>
              <Li><strong className="text-gray-200">aiPercentage / humanPercentage / mixedPercentage</strong> &mdash; final attribution split for the lines this session touched</Li>
              <Li><strong className="text-gray-200">filesChanged</strong> &mdash; files modified (only set on snapshot notes from <code className="text-indigo-400">post-commit</code>)</Li>
            </ul>

            <H2>Acceptance Backfill (refs/notes/origin-acceptance)</H2>
            <P>
              Acceptance answers the harder question: <em>after the human reacted, did the AI&apos;s
              lines survive?</em> Origin computes this <strong>at the next session-end</strong> and
              writes a separate note on the prior session&apos;s commits. Splitting refs keeps the
              original session note immutable.
            </P>
            <CodeBlock title="git notes --ref=origin-acceptance show <sha>">{`{
  "version": 1,
  "sessionId": "ea74b665-…",
  "computedAt": "2026-05-09T00:31:54Z",
  "addedLines": 156,
  "survivingLines": 132,
  "acceptanceRate": 0.85
}`}</CodeBlock>
            <Callout type="info">
              Backfill is bounded — it scans at most 50 commits since the prior session&apos;s
              <code className="text-indigo-400"> startedAt</code> and skips entirely if that session
              produced more than 20 commits. No surprise hangs at agent shutdown on hot repos.
            </Callout>

            <H2>Reading Notes</H2>
            <CodeBlock title="View notes for a commit">{`# Session metadata
git notes --ref=origin show HEAD

# Acceptance (only present once a follow-up session has run)
git notes --ref=origin-acceptance show HEAD~1

# Show notes inline in git log
git log --notes=origin --notes=origin-acceptance

# List every commit with an Origin note
git notes --ref=origin list`}</CodeBlock>

            <H2>Sharing With Your Team</H2>
            <CodeBlock title="Push and fetch">{`# Push all Origin notes (one ref per push, or use a refspec)
git push origin refs/notes/origin
git push origin refs/notes/origin-acceptance
git push origin refs/notes/origin-memory

# Fetch on a fresh clone so blame works locally
git fetch origin 'refs/notes/origin*:refs/notes/origin*'

# Auto-fetch on every pull (.git/config)
[remote "origin"]
  fetch = +refs/notes/origin*:refs/notes/origin*`}</CodeBlock>

            <H2>Example Note</H2>
            <CodeBlock title="git notes --ref=origin show HEAD">{`{
  "origin": {
    "version": 1,
    "sessionId": "ea74b665-88ef-48a6-bcc1-833d8e5cfc87",
    "model": "claude-sonnet-4-6",
    "agent": "claude-code",
    "promptCount": 12,
    "promptSummary": "Implement user authentication with JWT tokens…",
    "fullPrompt": "Implement user authentication with JWT tokens. Use the existing User model in src/models/user.ts. Tokens should expire after 24h and refresh through /api/auth/refresh.",
    "previousSessionId": "8d3a91c4-ee27-4e10-9a82-b13fc9b8e7d2",
    "filesRead": [
      "src/models/user.ts",
      "src/routes/auth.ts",
      "src/middleware/auth.ts",
      "tests/auth.test.ts"
    ],
    "tokensUsed": 45230,
    "costUsd": 0.42,
    "durationMs": 342000,
    "linesAdded": 156,
    "linesRemoved": 23,
    "aiPercentage": 92,
    "humanPercentage": 5,
    "mixedPercentage": 3,
    "originUrl": "https://getorigin.io/sessions/ea74b665-…",
    "timestamp": "2026-05-09T00:23:11.482Z"
  }
}`}</CodeBlock>

            <H2>Privacy &amp; Redaction</H2>
            <P>
              Anything user-controlled that flows into a note (<code className="text-indigo-400">promptSummary</code>,{' '}
              <code className="text-indigo-400">fullPrompt</code>) goes through Origin&apos;s
              secret-redaction engine first — pattern matchers for AWS keys, GitHub tokens, Stripe
              keys, JWTs, private-key blocks, DB connection strings, plus entropy-based detection
              for high-entropy tokens near secret-context words. Anything that matches is replaced
              with <code className="text-indigo-400">[REDACTED]</code> before the note is written.
            </P>
            <Callout type="tip">
              Notes are non-destructive: they never modify your commits or history. If a write
              fails (no git, no permission, broken ref), it fails silently — sessions never block
              on notes.
            </Callout>
          </div>
    </>
  );
}
