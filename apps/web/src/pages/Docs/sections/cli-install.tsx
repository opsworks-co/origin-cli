import { CodeBlock, H2, P, Callout } from '../shared/Markdown';

export default function CliInstallSection() {
  return (
    <>
          <div>
            <h1 id="cli-install" className="text-2xl font-bold mb-2">CLI Installation</h1>
            <P>
              The Origin CLI is distributed as an npm package. Install it globally to get started.
            </P>

            <H2>Install from Origin Platform</H2>
            <CodeBlock title="npm">{`npm i -g ${window.location.origin}/cli/origin-cli-latest.tgz`}</CodeBlock>

            <H2>Verify Installation</H2>
            <CodeBlock>{`origin --version
origin doctor`}</CodeBlock>

            <H2>First-Time Setup</H2>
            <P>After installation, authenticate and initialize:</P>
            <CodeBlock>{`# 1. Log in to your Origin account
origin login

# 2. Initialize — detects AI tools, installs hooks
origin enable

# 3. Verify everything is working
origin status`}</CodeBlock>

            <Callout type="info">
              <code className="text-indigo-400">origin enable</code> auto-detects Claude Code, Cursor, Copilot, Gemini, Aider, Windsurf, Cody, and more.
              It installs global git hooks so all repos are tracked automatically.
            </Callout>

            <H2>Standalone Mode</H2>
            <P>Run without the Origin platform — all data stays local:</P>
            <CodeBlock>{`origin enable --standalone`}</CodeBlock>
            <P>
              In standalone mode, sessions are stored on the <code className="text-indigo-400">origin-sessions</code> git branch
              and in a local SQLite database. No API key or server needed.
            </P>
          </div>
    </>
  );
}
