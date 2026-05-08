import { CodeBlock, H2, P, Li } from '../shared/Markdown';

export default function CliLocalSection() {
  return (
    <>
          <div>
            <h1 id="cli-local" className="text-2xl font-bold mb-2">Local Mode</h1>
            <P>
              Origin can run entirely offline with no server connection. All session data stays in your git repo
              on the <code className="text-indigo-400">origin-sessions</code> orphan branch.
            </P>

            <H2>Setup</H2>
            <CodeBlock>{`# Initialize in standalone mode
origin enable --standalone

# Or switch an existing setup to standalone
origin config set mode standalone`}</CodeBlock>

            <H2>How Local Storage Works</H2>
            <P>
              Each session creates three files on the <code className="text-indigo-400">origin-sessions</code> orphan branch:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><code className="text-indigo-400">sessions/&lt;id&gt;/metadata.json</code> &mdash; Session metadata (model, cost, tokens, duration, files, git info)</Li>
              <Li><code className="text-indigo-400">sessions/&lt;id&gt;/prompts.md</code> &mdash; Human-readable prompt log</Li>
              <Li><code className="text-indigo-400">sessions/&lt;id&gt;/changes.json</code> &mdash; Per-prompt diffs and file changes</Li>
            </ul>
            <P>
              Files are written using git plumbing (hash-object, update-index, write-tree, commit-tree) so
              your working directory and current branch are never touched.
            </P>

            <H2>Viewing Local Sessions</H2>
            <CodeBlock>{`# List sessions from origin-sessions branch
origin sessions --local

# View session detail
origin sessions show abc12345

# Browse in the browser
origin web`}</CodeBlock>

            <H2>Local Web Dashboard</H2>
            <P>
              Run <code className="text-indigo-400">origin web</code> to launch a local web dashboard on port 3141.
              Shows AI attribution, session history, and prompt details from local data.
            </P>
            <CodeBlock>{`origin web                # Launch on default port 3141
origin web --port 8080    # Custom port`}</CodeBlock>

            <H2>Push Strategy</H2>
            <P>Control whether session data is pushed to remote:</P>
            <CodeBlock>{`# Auto-push (default in standalone mode)
origin config set push-strategy auto

# Never push
origin config set push-strategy false

# Manual push only
origin config set push-strategy prompt`}</CodeBlock>

            <H2>Migrating to Connected Mode</H2>
            <P>To switch from standalone to platform mode:</P>
            <CodeBlock>{`# Log in to get credentials
origin login

# Re-initialize
origin enable

# Backfill existing local sessions to platform
origin sync`}</CodeBlock>
          </div>
    </>
  );
}
