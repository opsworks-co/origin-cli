import { CodeBlock, H2, P, Li, Step } from '../shared/Markdown';

export default function AgentsSection() {
  return (
    <>
          <div>
            <h1 id="agents" className="text-2xl font-bold mb-2">Agents</h1>
            <P>
              Agents represent the AI coding tools your team uses. Registering agents lets you
              track usage per tool, scope policies to specific agents, and understand which AI
              tools generate the most code and cost.
            </P>

            {/* Agents Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Agents</span>
              </div>
              <div className="p-4">
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { name: 'Claude Code', slug: 'claude-code', model: 'sonnet-4', sessions: 89, status: 'active' },
                    { name: 'Cursor', slug: 'cursor', model: 'gpt-4o', sessions: 34, status: 'active' },
                    { name: 'Windsurf', slug: 'windsurf', model: 'sonnet-4', sessions: 12, status: 'inactive' },
                  ].map((a, i) => (
                    <div key={i} className={`bg-gray-800/40 border rounded-lg p-3 ${a.status === 'active' ? 'border-gray-700/50' : 'border-gray-700/30 opacity-60'}`}>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-7 h-7 rounded-lg bg-indigo-600/30 flex items-center justify-center text-[10px] text-indigo-300 font-bold">{a.name[0]}</div>
                        <div>
                          <div className="text-xs text-gray-200 font-medium">{a.name}</div>
                          <div className="text-[10px] text-gray-500 font-mono">{a.slug}</div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-gray-500">Model: <span className="text-gray-400">{a.model}</span></span>
                        <span className="text-gray-500">{a.sessions} sessions</span>
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        {a.status === 'active' ? (
                          <><div className="w-1.5 h-1.5 rounded-full bg-green-500" /><span className="text-[10px] text-green-400">Active</span></>
                        ) : (
                          <><div className="w-1.5 h-1.5 rounded-full bg-gray-600" /><span className="text-[10px] text-gray-500">Inactive</span></>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <H2>Setting Up Agents</H2>

            <Step n={1} title="Go to Agents page">
              <p>Navigate to <strong className="text-gray-200">Agents</strong> in the sidebar.</p>
            </Step>
            <Step n={2} title="Click 'Add Agent'">
              <p>Fill in the agent details:</p>
            </Step>

            <ul className="space-y-2 mb-4 ml-12">
              <Li><strong className="text-gray-200">Name</strong> &mdash; Human-readable name. Examples: &ldquo;Claude Code&rdquo;, &ldquo;Cursor AI&rdquo;, &ldquo;GitHub Copilot&rdquo;, &ldquo;Windsurf&rdquo;</Li>
              <Li><strong className="text-gray-200">Slug</strong> &mdash; Unique machine-readable identifier. Must match the tool name exactly: <code className="text-indigo-400">claude-code</code>, <code className="text-indigo-400">cursor</code>, <code className="text-indigo-400">codex</code>, <code className="text-indigo-400">gemini</code>, <code className="text-indigo-400">windsurf</code>, <code className="text-indigo-400">aider</code>, <code className="text-indigo-400">copilot</code>. Used in API calls and policy rules.</Li>
              <Li><strong className="text-gray-200">Model</strong> &mdash; The default AI model this agent uses. Examples: <code className="text-indigo-400">claude-sonnet-4-20250514</code>, <code className="text-indigo-400">gpt-4o</code>, <code className="text-indigo-400">claude-opus-4-20250514</code></Li>
              <Li><strong className="text-gray-200">Description</strong> (optional) &mdash; A brief description of the agent&apos;s purpose or team.</Li>
            </ul>

            <H2>Recommended Agent Setup</H2>
            <P>Create one agent per AI tool your team uses. Here are common configurations:</P>

            <CodeBlock title="Example: Claude Code">{`Name:        Claude Code
Slug:        claude-code
Model:       claude-sonnet-4-20250514
Description: Primary AI coding assistant for backend team`}</CodeBlock>

            <CodeBlock title="Example: Cursor">{`Name:        Cursor
Slug:        cursor
Model:       gpt-4o
Description: IDE-integrated coding assistant`}</CodeBlock>

            <CodeBlock title="Example: Windsurf">{`Name:        Windsurf
Slug:        windsurf
Model:       claude-sonnet-4-20250514
Description: Codeium's AI IDE agent`}</CodeBlock>

            <H2>Agent Status</H2>
            <P>
              Agents can be <code className="text-green-400">ACTIVE</code> or <code className="text-gray-400">INACTIVE</code>.
            </P>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Active</strong> &mdash; Agent is in use, counted in dashboard stats, policy rules can target it</Li>
              <Li><strong className="text-gray-200">Inactive</strong> &mdash; Agent is retired/paused. Sessions are preserved but the agent doesn&apos;t appear in active counts</Li>
            </ul>
            <P>
              Toggle status by clicking the agent card and using the status dropdown. Use this to
              decommission agents without losing historical data.
            </P>

            <H2>Scoping Policies to Agents</H2>
            <P>
              When creating policy rules, you can optionally select an agent. This lets you create
              rules like &ldquo;Copilot cannot edit files in <code className="text-indigo-400">src/auth/</code>&rdquo; while allowing Claude Code full access.
              See the <strong className="text-gray-200">Policies</strong> section for details.
            </P>

            <H2>Agent Metrics</H2>
            <P>
              Each agent card shows the total number of sessions linked to it. The Dashboard
              shows top agents by session count and cost for quick comparison.
            </P>
          </div>
    </>
  );
}
