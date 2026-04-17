import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function PromptsSection() {
  return (
    <>
          <div>
            <h1 id="prompts" className="text-2xl font-bold mb-2">Prompt Library</h1>
            <P>
              The Prompt Library captures every prompt-to-code-change mapping across your organization.
              Search through prompts, see what files they changed, and analyze patterns in how your
              team uses AI coding tools.
            </P>

            {/* Prompts Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Prompt Library</span>
              </div>
              <div className="p-4">
                {/* Search bar */}
                <div className="flex gap-2 mb-3">
                  <div className="flex-1 bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-400">Search prompts...</div>
                  <div className="px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-[10px] text-gray-400">All Models ▾</div>
                  <div className="px-2 py-2 bg-gray-800 border border-gray-700 rounded-lg text-[10px] text-gray-400">All Repos ▾</div>
                </div>
                {/* Results */}
                <div className="space-y-2">
                  {[
                    { prompt: 'Add JWT authentication middleware with token validation and refresh logic', model: 'sonnet-4', repo: 'acme/backend', files: 3, cost: '$1.87', status: 'approved' },
                    { prompt: 'Refactor the dashboard layout to use CSS Grid and fix responsive breakpoints', model: 'opus-4', repo: 'acme/frontend', files: 5, cost: '$2.14', status: 'unreviewed' },
                    { prompt: 'Fix rate limiter bug where requests were counted twice on retry', model: 'sonnet-4', repo: 'acme/api', files: 2, cost: '$0.42', status: 'approved' },
                  ].map((p, i) => (
                    <div key={i} className="bg-gray-800/40 border border-gray-700/50 rounded-lg px-3 py-2.5 hover:bg-gray-800/60 cursor-pointer">
                      <div className="text-xs text-gray-200 mb-1 truncate">{p.prompt}</div>
                      <div className="flex items-center gap-3 text-[10px]">
                        <span className="text-gray-500 font-mono">{p.model}</span>
                        <span className="text-gray-500">{p.repo}</span>
                        <span className="text-gray-500">{p.files} files</span>
                        <span className="text-gray-400">{p.cost}</span>
                        <span className={`ml-auto px-1.5 py-0.5 rounded ${p.status === 'approved' ? 'bg-green-900/40 text-green-400' : 'bg-gray-700/40 text-gray-400'}`}>{p.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <H2>How It Works</H2>
            <P>
              When a coding session ends, Origin creates <code className="text-indigo-400">PromptChange</code> records
              that link individual prompts to the files they modified and the diffs they produced.
              This gives you a searchable database of every AI interaction and its outcome.
            </P>

            <H2>Search View</H2>
            <P>The default view lets you search and filter prompts:</P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Text Search</strong> &mdash; Search prompt text across all sessions</Li>
              <Li><strong className="text-gray-200">Model Filter</strong> &mdash; Filter by AI model (Claude Sonnet, Opus, GPT-4o, Gemini)</Li>
              <Li><strong className="text-gray-200">Repository Filter</strong> &mdash; Narrow results to a specific repo</Li>
            </ul>
            <P>
              Each result shows the prompt text (truncated to 200 chars), model used, review status,
              repo name, author, files changed count, cost, and timestamp. Click a prompt to view the
              full session detail.
            </P>

            <H2>Pattern Analysis View</H2>
            <P>
              Switch to the &ldquo;Patterns&rdquo; tab to see aggregate analysis. Origin categorizes
              prompts into types using keyword matching:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Bug Fix</strong> &mdash; Prompts containing fix, bug, error, issue, broken</Li>
              <Li><strong className="text-gray-200">New Feature</strong> &mdash; Prompts with add, create, implement, build, new</Li>
              <Li><strong className="text-gray-200">Refactoring</strong> &mdash; Prompts with refactor, clean, restructure, reorganize</Li>
              <Li><strong className="text-gray-200">Testing</strong> &mdash; Prompts with test, spec, coverage, assert</Li>
              <Li><strong className="text-gray-200">Documentation</strong> &mdash; Prompts with document, readme, comment, explain</Li>
            </ul>
            <P>
              For each category, you see the count and <strong className="text-gray-200">approval rate</strong> &mdash;
              the percentage of prompts in that category whose sessions were approved. This helps identify
              which types of AI tasks produce the best outcomes.
            </P>

            <H2>API</H2>
            <CodeBlock title="Prompts API">{`# Search prompts
GET /api/prompts?q=authentication&model=claude-code&repoId=...&limit=20&offset=0

# Get pattern analysis
GET /api/prompts/patterns`}</CodeBlock>

            <Callout type="info">
              The Prompt Library is powered by PromptChange records created when sessions end.
              If the library is empty, make sure session tracking is configured via the CLI or MCP server.
            </Callout>
          </div>
    </>
  );
}
