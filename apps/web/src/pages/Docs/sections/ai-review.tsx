import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function AiReviewSection() {
  return (
    <>
          <div>
            <h1 id="ai-review" className="text-2xl font-bold mb-2">AI Auto-Review</h1>
            <P>
              Origin can automatically review AI coding sessions using Claude, providing
              instant risk assessments and flagging sessions that need human attention.
            </P>

            {/* AI Review Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">AI Auto-Review</span>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="px-2 py-0.5 bg-amber-900/40 text-amber-400 rounded text-xs font-medium">FLAGGED</span>
                  <span className="text-xs text-gray-500">Reviewed by AI &mdash; 3s ago</span>
                  <span className="ml-auto text-[10px] text-gray-500">Risk: <span className="text-amber-400 font-medium">Medium</span></span>
                </div>
                <div className="space-y-2">
                  {[
                    { icon: '!', color: 'red', label: 'Security Risk', desc: 'Hardcoded JWT secret found in auth middleware' },
                    { icon: '~', color: 'amber', label: 'Scope Risk', desc: 'Modified 3 files outside the requested scope' },
                    { icon: '*', color: 'green', label: 'Code Quality', desc: 'Clean implementation with proper error handling' },
                    { icon: '~', color: 'amber', label: 'Prompt Alignment', desc: '2 of 3 file changes match the prompt intent' },
                  ].map((f, i) => (
                    <div key={i} className={`flex items-start gap-2 px-3 py-2 rounded-lg border ${
                      f.color === 'red' ? 'bg-red-900/10 border-red-800/30' :
                      f.color === 'amber' ? 'bg-amber-900/10 border-amber-800/30' :
                      'bg-green-900/10 border-green-800/30'
                    }`}>
                      <span className={`text-xs font-bold mt-0.5 ${
                        f.color === 'red' ? 'text-red-400' :
                        f.color === 'amber' ? 'text-amber-400' :
                        'text-green-400'
                      }`}>{f.icon}</span>
                      <div>
                        <div className="text-xs text-gray-200 font-medium">{f.label}</div>
                        <div className="text-[11px] text-gray-400">{f.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <div className="px-3 py-1.5 bg-gray-800 border border-gray-600 rounded text-xs text-gray-300 cursor-pointer">Override AI Review</div>
                </div>
              </div>
            </div>

            <H2>How It Works</H2>
            <P>
              When a coding session ends, Origin sends session data to Claude for analysis, including
              the actual code diff, prompt-to-change mappings, transcript, and session metrics.
              The AI reviewer evaluates security risks, scope risks, cost risks, code quality,
              policy compliance, and <strong className="text-gray-200">prompt-change alignment</strong> (whether
              the code changes match what was requested). Results appear as a purple-badged review on the session detail page.
            </P>

            <H2>Setup</H2>
            <P>
              Set the <code className="text-indigo-400">ANTHROPIC_API_KEY</code> environment
              variable on your Origin server. When this key is present, AI auto-review
              is enabled automatically for all organizations.
            </P>
            <CodeBlock title="Environment variable">{`ANTHROPIC_API_KEY=sk-ant-api03-...`}</CodeBlock>

            <H2>Review Statuses</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-green-400">APPROVED</strong> &mdash; Low risk, routine changes, appears safe</Li>
              <Li><strong className="text-amber-400">FLAGGED</strong> &mdash; Medium risk, needs human review (security files, high cost, many changes)</Li>
              <Li><strong className="text-red-400">REJECTED</strong> &mdash; High risk, potentially dangerous (auth/secrets, production data)</Li>
            </ul>

            <H2>Risk Levels</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Low</strong> &mdash; Standard development work</Li>
              <Li><strong className="text-gray-200">Medium</strong> &mdash; Some concerns worth noting</Li>
              <Li><strong className="text-gray-200">High</strong> &mdash; Significant risks identified</Li>
              <Li><strong className="text-gray-200">Critical</strong> &mdash; Immediate attention required</Li>
            </ul>

            <H2>What the AI Reviewer Checks</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Security risks</strong> &mdash; Checks the actual code diff for hardcoded secrets, backdoors, or suspicious additions</Li>
              <Li><strong className="text-gray-200">Scope risks</strong> &mdash; Detects when the diff contains changes beyond what was requested in the prompt</Li>
              <Li><strong className="text-gray-200">Cost risks</strong> &mdash; Flags abnormally high token/cost usage relative to the task</Li>
              <Li><strong className="text-gray-200">Code quality</strong> &mdash; Identifies poor patterns, errors, retries, and workarounds in the diff and transcript</Li>
              <Li><strong className="text-gray-200">Policy compliance</strong> &mdash; Verifies changes follow standard development practices</Li>
              <Li><strong className="text-gray-200">Prompt-change alignment</strong> &mdash; Compares each prompt to its resulting file changes to detect unexpected modifications</Li>
            </ul>

            <H2>Overriding AI Reviews</H2>
            <P>
              AI reviews can always be overridden by humans. When a session has an AI review,
              the review bar shows &ldquo;Override AI Review&rdquo; instead of &ldquo;Review This Session&rdquo;.
              The human review replaces the AI review.
            </P>

            <H2>Notifications</H2>
            <P>
              When the AI reviewer flags or rejects a session, org admins are automatically
              notified. Approved sessions do not generate notifications.
            </P>

            <Callout type="info">
              AI auto-review runs in the background and does not block the session end response.
              Reviews typically appear within a few seconds of the session ending.
            </Callout>
          </div>
    </>
  );
}
