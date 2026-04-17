import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function AiBlameSection() {
  return (
    <>
          <div>
            <h1 id="ai-blame" className="text-2xl font-bold mb-2">AI Blame</h1>
            <P>
              AI Blame provides line-level attribution for AI-generated code. It tells you
              exactly which prompt (and which developer) caused each line of code to be written,
              similar to <code className="text-indigo-400">git blame</code> but for AI authorship.
            </P>

            {/* AI Blame Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">AI Blame &mdash; src/middleware/auth.ts</span>
              </div>
              <div className="p-4">
                {/* Legend */}
                <div className="flex gap-4 mb-3 text-[10px]">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded bg-purple-500/60" />
                    <span className="text-gray-400">Prompt 1: &quot;Add auth middleware&quot;</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded bg-blue-500/60" />
                    <span className="text-gray-400">Prompt 2: &quot;Add error handling&quot;</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded bg-green-500/60" />
                    <span className="text-gray-400">[HU] Human</span>
                  </div>
                </div>
                {/* Blame code view */}
                <div className="bg-gray-950 rounded border border-gray-700/50 font-mono text-[11px]">
                  {[
                    { line: 1,  color: 'green',  label: '[HU]', code: "import express from 'express';" },
                    { line: 2,  color: 'purple', label: 'P1',   code: "import { verify } from 'jsonwebtoken';" },
                    { line: 3,  color: 'purple', label: 'P1',   code: '' },
                    { line: 4,  color: 'purple', label: 'P1',   code: 'export function authMiddleware(req, res, next) {' },
                    { line: 5,  color: 'purple', label: 'P1',   code: '  const token = req.headers.authorization;' },
                    { line: 6,  color: 'blue',   label: 'P2',   code: '  if (!token) {' },
                    { line: 7,  color: 'blue',   label: 'P2',   code: "    return res.status(401).json({ error: 'No token' });" },
                    { line: 8,  color: 'blue',   label: 'P2',   code: '  }' },
                    { line: 9,  color: 'purple', label: 'P1',   code: '  const decoded = verify(token, process.env.JWT_SECRET);' },
                    { line: 10, color: 'purple', label: 'P1',   code: '  req.user = decoded;' },
                    { line: 11, color: 'purple', label: 'P1',   code: '  next();' },
                    { line: 12, color: 'purple', label: 'P1',   code: '}' },
                  ].map((l) => (
                    <div key={l.line} className="flex items-center hover:bg-gray-800/40 group">
                      <div className={`w-1 self-stretch ${
                        l.color === 'purple' ? 'bg-purple-500/60' :
                        l.color === 'blue' ? 'bg-blue-500/60' :
                        'bg-green-500/60'
                      }`} />
                      <span className="w-8 text-right pr-2 text-gray-600 select-none">{l.line}</span>
                      <span className={`w-8 text-center text-[9px] font-bold ${
                        l.color === 'purple' ? 'text-purple-400' :
                        l.color === 'blue' ? 'text-blue-400' :
                        'text-green-400'
                      }`}>{l.label}</span>
                      <span className="text-gray-300 pl-2">{l.code || '\u00A0'}</span>
                      <span className="ml-auto pr-2 text-[9px] text-indigo-400 opacity-0 group-hover:opacity-100 cursor-pointer">Ask</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <H2>How It Works</H2>
            <P>
              When Origin tracks a coding session, it records a mapping of each user prompt to
              the code changes it produced (via <strong className="text-gray-200">PromptChanges</strong> with unified diffs).
              AI Blame parses these diffs to build a line-by-line attribution map for every file.
            </P>
            <Callout type="info">
              Origin only attributes code written <em>after</em> installation. Lines that existed before{' '}
              <code className="text-indigo-400">origin init</code> will show as <code className="text-indigo-400">[HU]</code> (human),
              even if they were originally AI-generated.
            </Callout>
            <P>
              The algorithm walks through prompts in chronological order. For each prompt, it parses
              the unified diff to determine which lines were added. Later prompts override earlier ones
              for the same line numbers, giving you the final attribution.
            </P>

            <H2>Using AI Blame in the Dashboard</H2>
            <P>
              Open any session detail page and click the <strong className="text-gray-200">AI Blame</strong> tab.
              You will see:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">File Selector</strong> &mdash; Dropdown listing all files changed in the session. Select a file to view its blame.</Li>
              <Li><strong className="text-gray-200">Prompt Legend</strong> &mdash; Color-coded list of all prompts that touched the selected file, each with a unique color for visual identification.</Li>
              <Li><strong className="text-gray-200">Blame View</strong> &mdash; Line-by-line code display with colored left border indicating which prompt wrote each line. Hover over any line to see prompt details.</Li>
              <Li><strong className="text-gray-200">Ask Button</strong> &mdash; Each line has an &ldquo;Ask&rdquo; button that opens the Ask the Author panel pre-filled with context about that specific line.</Li>
            </ul>

            <H2>API Endpoint</H2>
            <CodeBlock title="GET /api/sessions/:id/blame">{`# Get blame for a specific file in a session
GET /api/sessions/:id/blame?file=src/components/App.tsx

# Response
{
  "sessionId": "abc-123",
  "file": "src/components/App.tsx",
  "lines": [
    {
      "lineNumber": 1,
      "content": "import React from 'react';",
      "promptIndex": 0,
      "promptText": "Create a new React component..."
    },
    ...
  ],
  "prompts": {
    "0": {
      "promptText": "Create a new React component...",
      "filesChanged": ["src/components/App.tsx"],
      "lineCount": 42
    }
  }
}`}</CodeBlock>

            <H2>How Attribution Is Calculated</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Unified diff parsing</strong> &mdash; Each prompt&apos;s diff is parsed to extract <code className="text-indigo-400">@@ -old,count +new,count @@</code> hunks</Li>
              <Li><strong className="text-gray-200">Line tracking</strong> &mdash; Only added lines (<code className="text-indigo-400">+</code> prefix) are tracked; removed lines are excluded</Li>
              <Li><strong className="text-gray-200">Last-write wins</strong> &mdash; If multiple prompts modify the same line, the last one is attributed</Li>
              <Li><strong className="text-gray-200">Full file coverage</strong> &mdash; Every added line across all prompts in the session is attributed</Li>
            </ul>

            <Callout type="tip">
              AI Blame is most useful for sessions with multiple prompts. For single-prompt sessions,
              all lines are attributed to that one prompt.
            </Callout>
          </div>
    </>
  );
}
