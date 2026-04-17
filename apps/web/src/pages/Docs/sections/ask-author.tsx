import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function AskAuthorSection() {
  return (
    <>
          <div>
            <h1 id="ask-author" className="text-2xl font-bold mb-2">Ask the Author</h1>
            <P>
              Ask the Author lets you ask questions about any coding session and get answers
              grounded in the actual conversation transcript and code changes. It&apos;s like
              having the AI agent explain why it wrote the code it did.
            </P>

            {/* Ask the Author Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Ask the Author &mdash; Session a3f8c21</span>
              </div>
              <div className="p-4">
                {/* Chat messages */}
                <div className="space-y-3 mb-3">
                  {/* User question */}
                  <div className="flex gap-2">
                    <div className="w-5 h-5 rounded-full bg-gray-600 flex items-center justify-center text-[9px] text-gray-300 font-bold flex-shrink-0">Y</div>
                    <div className="bg-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-300 max-w-[80%]">
                      Why did you use a Map instead of a plain object for the cache?
                    </div>
                  </div>
                  {/* AI answer */}
                  <div className="flex gap-2">
                    <div className="w-5 h-5 rounded-full bg-purple-600/40 flex items-center justify-center text-[9px] text-purple-300 font-bold flex-shrink-0">AI</div>
                    <div className="bg-purple-900/20 border border-purple-800/30 rounded-lg px-3 py-2 text-xs text-gray-300 max-w-[80%]">
                      <p className="mb-1.5">In <strong className="text-purple-300">Prompt #2</strong>, the developer asked to optimize cache lookups. A Map was chosen because:</p>
                      <ul className="space-y-1 ml-3 text-gray-400">
                        <li className="flex items-start gap-1"><span className="text-purple-400">*</span>Maps have O(1) lookup and preserve insertion order</li>
                        <li className="flex items-start gap-1"><span className="text-purple-400">*</span>Keys can be any type, not just strings</li>
                        <li className="flex items-start gap-1"><span className="text-purple-400">*</span>Better performance for frequent add/delete operations</li>
                      </ul>
                    </div>
                  </div>
                </div>
                {/* Suggestion chips */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {['Why this approach?', 'What alternatives?', 'Any risks?'].map((q, i) => (
                    <div key={i} className="px-2 py-1 bg-gray-800 border border-gray-700 rounded-full text-[10px] text-gray-400 cursor-pointer hover:border-purple-500/50 hover:text-purple-300">{q}</div>
                  ))}
                </div>
                {/* Input */}
                <div className="flex gap-2">
                  <div className="flex-1 bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-500">Ask a question about this session...</div>
                  <div className="px-3 py-2 bg-purple-600/30 border border-purple-500/40 rounded-lg text-xs text-purple-300 cursor-pointer">Ask</div>
                </div>
              </div>
            </div>

            <H2>How It Works</H2>
            <P>
              When you ask a question, Origin loads the session&apos;s full transcript (the conversation
              between the developer and AI) along with all code diffs, and sends them to Claude
              as context. Claude then answers your question by referencing specific parts of the
              conversation and code changes.
            </P>

            <H2>Using Ask the Author</H2>
            <P>
              There are two ways to open the Ask panel:
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Ask button in header</strong> &mdash; Click the purple &ldquo;Ask&rdquo; button in the session detail header to open a general Q&amp;A panel</Li>
              <Li><strong className="text-gray-200">Ask from AI Blame</strong> &mdash; Click the &ldquo;Ask&rdquo; button on any line in the AI Blame view. The question is pre-filled with context about that specific line, file, and prompt.</Li>
            </ul>

            <H2>Features</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Multi-turn conversations</strong> &mdash; Ask follow-up questions; the full conversation history is maintained</Li>
              <Li><strong className="text-gray-200">Suggestion chips</strong> &mdash; Quick-start questions like &ldquo;Why was this approach chosen?&rdquo; and &ldquo;What alternatives were considered?&rdquo;</Li>
              <Li><strong className="text-gray-200">Contextual answers</strong> &mdash; When opened from AI Blame, the AI knows which file, line, and prompt you&apos;re asking about</Li>
              <Li><strong className="text-gray-200">Transcript grounding</strong> &mdash; Answers reference specific prompts from the conversation that led to the code</Li>
            </ul>

            <H2>API Endpoint</H2>
            <CodeBlock title="POST /api/sessions/:id/ask">{`# Ask a question about a session
POST /api/sessions/:id/ask
Content-Type: application/json

{
  "question": "Why did the agent use a Map instead of a plain object here?",
  "context": {
    "file": "src/utils/cache.ts",
    "lineNumber": 42,
    "lineContent": "const cache = new Map<string, CacheEntry>();"
  },
  "history": []  // Previous Q&A turns for multi-turn conversation
}

# Response
{
  "answer": "Looking at the transcript, in prompt #3 the developer asked for...",
  "model": "claude-sonnet-4-20250514"
}`}</CodeBlock>

            <H2>Setup</H2>
            <P>
              Ask the Author requires the <code className="text-indigo-400">ANTHROPIC_API_KEY</code> environment
              variable to be set on the Origin server. Without it, the endpoint returns a 503 error.
            </P>
            <CodeBlock title="Environment variable">{`ANTHROPIC_API_KEY=sk-ant-api03-...`}</CodeBlock>

            <Callout type="info">
              The AI receives a truncated version of the transcript (up to 30,000 characters) and
              diffs (up to 15,000 characters) to stay within token limits. For very long sessions,
              the most recent parts of the conversation are prioritized.
            </Callout>
          </div>
    </>
  );
}
