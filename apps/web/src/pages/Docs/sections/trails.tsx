import { CodeBlock, H2, P, Li, Callout } from '../shared/Markdown';

export default function TrailsSection() {
  return (
    <>
          <div>
            <h1 id="trails" className="text-2xl font-bold mb-2">Trails</h1>
            <P>
              Trails let you group coding sessions by feature, project, or initiative.
              Track the total cost, effort, and progress of AI-assisted work at the feature level
              rather than individual session level.
            </P>

            {/* Trails Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Trails</span>
              </div>
              <div className="p-4 space-y-2">
                {[
                  { name: 'User Auth System', status: 'active', sessions: 8, cost: '$42', labels: ['backend', 'security'], priority: 'high' },
                  { name: 'Dashboard Redesign', status: 'review', sessions: 5, cost: '$28', labels: ['frontend'], priority: 'medium' },
                  { name: 'CI Pipeline Fix', status: 'done', sessions: 3, cost: '$12', labels: ['devops'], priority: 'low' },
                ].map((t, i) => (
                  <div key={i} className="bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                        t.status === 'active' ? 'bg-green-900/40 text-green-400' :
                        t.status === 'review' ? 'bg-amber-900/40 text-amber-400' :
                        'bg-gray-700/40 text-gray-400'
                      }`}>{t.status}</span>
                      <span className="text-xs text-gray-200 font-medium">{t.name}</span>
                      <span className={`ml-auto text-[9px] ${
                        t.priority === 'high' ? 'text-red-400' :
                        t.priority === 'medium' ? 'text-amber-400' :
                        'text-gray-500'
                      }`}>{t.priority}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px]">
                      <span className="text-gray-500">{t.sessions} sessions</span>
                      <span className="text-gray-400">{t.cost}</span>
                      <div className="flex gap-1 ml-auto">
                        {t.labels.map((l, j) => (
                          <span key={j} className="px-1.5 py-0.5 bg-indigo-900/30 border border-indigo-700/30 rounded text-[9px] text-indigo-400">{l}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <H2>How It Works</H2>
            <P>
              A Trail is a named container with a status lifecycle (active, review, done, paused),
              priority level, and labels. You add coding sessions to a trail, and Origin aggregates
              the cost, tokens, lines changed, and time spent across all sessions in that trail.
            </P>

            <H2>Trail Properties</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Name & Description</strong> &mdash; Human-readable identifier for the feature or initiative</Li>
              <Li><strong className="text-gray-200">Status</strong> &mdash; Lifecycle state: <code className="text-indigo-400">active</code>, <code className="text-indigo-400">review</code>, <code className="text-indigo-400">done</code>, <code className="text-indigo-400">paused</code></Li>
              <Li><strong className="text-gray-200">Priority</strong> &mdash; Urgency level for sorting and filtering</Li>
              <Li><strong className="text-gray-200">Labels</strong> &mdash; Tags for categorization (e.g. &ldquo;frontend&rdquo;, &ldquo;security&rdquo;, &ldquo;tech-debt&rdquo;)</Li>
              <Li><strong className="text-gray-200">Sessions</strong> &mdash; Linked coding sessions with aggregated metrics</Li>
            </ul>

            <H2>Use Cases</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Feature cost tracking</strong> &mdash; How much did AI assistance cost to build the auth system?</Li>
              <Li><strong className="text-gray-200">Sprint planning</strong> &mdash; Group sessions by sprint to measure AI contribution per cycle</Li>
              <Li><strong className="text-gray-200">Incident response</strong> &mdash; Track all AI sessions related to a production incident fix</Li>
            </ul>

            <H2>API</H2>
            <CodeBlock title="Trails API">{`# List trails
GET /api/trails?status=active&label=frontend

# Create a trail
POST /api/trails
{ "name": "User Auth System", "description": "JWT auth + RBAC", "priority": "high", "labels": ["backend", "security"] }

# Add sessions to trail
POST /api/trails/:id/sessions
{ "sessionIds": ["session-uuid-1", "session-uuid-2"] }`}</CodeBlock>

            <Callout type="info">
              Trails are accessible from Settings &rarr; Trails tab. You can also manage trails via
              the CLI with <code className="text-indigo-400">origin trail</code> commands.
            </Callout>
          </div>
    </>
  );
}
