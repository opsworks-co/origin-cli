import { CodeBlock, H2, P, Li } from '../shared/Markdown';

export default function CliHooksSection() {
  return (
    <>
          <div>
            <h1 id="cli-hooks" className="text-2xl font-bold mb-2">Git Hooks</h1>
            <P>
              Origin uses git hooks to automatically capture session data. Hooks are installed globally
              by <code className="text-indigo-400">origin init</code> or per-repo by <code className="text-indigo-400">origin enable</code>.
            </P>

            <H2>How Hooks Work</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">post-commit</strong> &mdash; Captures commit SHA, files changed, and links it to the active AI session</Li>
              <Li><strong className="text-gray-200">Session start detection</strong> &mdash; Detects when an AI tool begins a coding session via process monitoring</Li>
              <Li><strong className="text-gray-200">Session end</strong> &mdash; Finalizes session data, writes to <code className="text-indigo-400">origin-sessions</code> branch, syncs to platform</Li>
            </ul>

            <H2>Managing Hooks</H2>
            <CodeBlock>{`# Install hooks for specific agent
origin enable --agent claude-code

# Remove hooks
origin disable claude-code

# Check hook status
origin doctor`}</CodeBlock>

            <H2>Supported AI Tools</H2>
            <P>Origin auto-detects and installs hooks for:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Claude Code</strong> &mdash; via MCP server config and CLI hooks</Li>
              <Li><strong className="text-gray-200">Cursor</strong> &mdash; via workspace rules and git hooks</Li>
              <Li><strong className="text-gray-200">Codex CLI</strong> &mdash; via process detection and hooks</Li>
              <Li><strong className="text-gray-200">Gemini CLI</strong> &mdash; via CLI detection</Li>
              <Li><strong className="text-gray-200">Windsurf</strong> &mdash; via workspace detection</Li>
            </ul>
            <p className="text-gray-500 text-sm mt-2">Coming soon: GitHub Copilot, Aider, Cody, Continue, Codeium, Cline</p>
          </div>
    </>
  );
}
