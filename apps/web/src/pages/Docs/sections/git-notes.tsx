import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function GitNotesSection() {
  return (
    <>
          <div>
            <h1 id="git-notes" className="text-2xl font-bold mb-2">Git Notes</h1>
            <P>
              Origin writes structured AI metadata as Git Notes on every commit created during
              a coding session. This makes AI authorship information portable and accessible
              from any Git client without cluttering commit history.
            </P>

            <H2>What Are Git Notes?</H2>
            <P>
              Git Notes are a built-in Git feature that lets you attach extra information to commits
              without modifying the commit itself. Origin uses a custom namespace
              (<code className="text-indigo-400">refs/notes/origin</code>) to avoid conflicts with
              other tools.
            </P>

            <H2>What Gets Written</H2>
            <P>Each Git Note contains a JSON object with the following fields:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">sessionId</strong> &mdash; The Origin session ID for the full audit trail</Li>
              <Li><strong className="text-gray-200">model</strong> &mdash; Which AI model was used (e.g. claude-sonnet-4-20250514)</Li>
              <Li><strong className="text-gray-200">promptCount</strong> &mdash; How many prompts were in the session</Li>
              <Li><strong className="text-gray-200">promptSummary</strong> &mdash; First 200 characters of the initial prompt</Li>
              <Li><strong className="text-gray-200">tokensUsed</strong> &mdash; Total tokens consumed</Li>
              <Li><strong className="text-gray-200">costUsd</strong> &mdash; Estimated cost in USD</Li>
              <Li><strong className="text-gray-200">toolCalls</strong> &mdash; Number of tool invocations</Li>
              <Li><strong className="text-gray-200">durationMs</strong> &mdash; Session duration in milliseconds</Li>
              <Li><strong className="text-gray-200">linesAdded / linesRemoved</strong> &mdash; Code change metrics</Li>
              <Li><strong className="text-gray-200">filesChanged</strong> &mdash; List of files modified</Li>
              <Li><strong className="text-gray-200">originUrl</strong> &mdash; Direct link to the session in the Origin dashboard</Li>
            </ul>

            <H2>When Notes Are Written</H2>
            <P>
              Notes are written automatically at the end of every coding session, right after the session
              data is uploaded to Origin. If a session produced multiple commits, each commit gets
              its own note with the same session metadata.
            </P>

            <H2>Reading Git Notes</H2>
            <CodeBlock title="View AI metadata for a commit">{`# Show Origin notes for a specific commit
git notes --ref=origin show HEAD

# Show notes for any commit SHA
git notes --ref=origin show abc1234

# List all commits that have Origin notes
git notes --ref=origin list

# Include notes in git log output
git log --notes=origin`}</CodeBlock>

            <H2>Sharing Notes</H2>
            <P>
              Git Notes are stored locally by default. To share them with your team, push and fetch
              the notes ref:
            </P>
            <CodeBlock title="Push and fetch Origin notes">{`# Push notes to remote
git push origin refs/notes/origin

# Fetch notes from remote
git fetch origin refs/notes/origin:refs/notes/origin

# Auto-fetch notes (add to .git/config)
[remote "origin"]
  fetch = +refs/notes/origin:refs/notes/origin`}</CodeBlock>

            <H2>Example Note</H2>
            <CodeBlock title="git notes --ref=origin show HEAD">{`{
  "origin": true,
  "sessionId": "ea74b665-88ef-48a6-bcc1-833d8e5cfc87",
  "model": "claude-sonnet-4-20250514",
  "promptCount": 12,
  "promptSummary": "Implement user authentication with JWT tokens...",
  "tokensUsed": 45230,
  "costUsd": 0.42,
  "toolCalls": 87,
  "durationMs": 342000,
  "linesAdded": 156,
  "linesRemoved": 23,
  "filesChanged": ["src/auth.ts", "src/middleware.ts", "src/routes/login.ts"],
  "originUrl": "https://getorigin.io/sessions/ea74b665..."
}`}</CodeBlock>

            <Callout type="tip">
              Git Notes are non-destructive &mdash; they never modify your commits or history.
              If a note fails to write (e.g. git is not available), it fails silently and never
              blocks the session from completing.
            </Callout>
          </div>
    </>
  );
}
