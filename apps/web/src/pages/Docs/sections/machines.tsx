import { CodeBlock, H2, P, Li } from '../shared/Markdown';

export default function MachinesSection() {
  return (
    <>
          <div>
            <h1 id="machines" className="text-2xl font-bold mb-2">Machines</h1>
            <P>
              The Machines page shows all client devices registered with Origin.
              Track which developer machines are running AI coding tools, what software
              is installed, and enforce machine-level policies.
            </P>

            {/* Machines Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Machines</span>
              </div>
              <div className="p-4 space-y-2">
                {[
                  { hostname: 'sarah-mbp.local', id: 'mc_a3f8c2', tools: ['git', 'node', 'docker', 'python'], lastSeen: '2m ago' },
                  { hostname: 'mike-desktop', id: 'mc_b7d2e1', tools: ['git', 'node', 'kubectl'], lastSeen: '1h ago' },
                  { hostname: 'ci-runner-01', id: 'mc_c9e4f3', tools: ['git', 'node', 'docker'], lastSeen: '5m ago' },
                ].map((m, i) => (
                  <div key={i} className="flex items-center gap-3 bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3">
                    <div className="w-7 h-7 rounded bg-gray-700/50 flex items-center justify-center text-[11px] text-gray-400">&#9000;</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-200 font-medium">{m.hostname}</div>
                      <div className="text-[10px] text-gray-500 font-mono">{m.id}</div>
                    </div>
                    <div className="flex gap-1">
                      {m.tools.map((t, j) => (
                        <span key={j} className="px-1.5 py-0.5 bg-gray-700/50 rounded text-[9px] text-gray-400">{t}</span>
                      ))}
                    </div>
                    <div className="text-[10px] text-gray-500 w-14 text-right">{m.lastSeen}</div>
                  </div>
                ))}
              </div>
            </div>

            <H2>How It Works</H2>
            <P>
              When a developer runs <code className="text-indigo-400">origin init</code> on their machine,
              the CLI detects installed tools (git, node, python, docker, etc.) and registers the machine
              with Origin. The machine record includes a unique machine ID, hostname, and tool inventory.
              Machines are updated on each CLI interaction and show a &ldquo;last seen&rdquo; timestamp.
            </P>

            <H2>Machine Data</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">Hostname</strong> &mdash; The machine&apos;s network hostname (e.g. &ldquo;artem-mbp.local&rdquo;)</Li>
              <Li><strong className="text-gray-200">Machine ID</strong> &mdash; Unique identifier generated at registration</Li>
              <Li><strong className="text-gray-200">Detected Tools</strong> &mdash; Software found on the machine (git, node, python, docker, kubectl, etc.)</Li>
              <Li><strong className="text-gray-200">Last Seen</strong> &mdash; Timestamp of the most recent CLI interaction from this machine</Li>
            </ul>

            <H2>Machine-Scoped Policies</H2>
            <P>
              Policy rules can be scoped to specific machines using the <code className="text-indigo-400">machineId</code> scope.
              This lets you enforce different rules on CI runners vs developer laptops. For example:
            </P>
            <ul className="space-y-2 mb-4">
              <Li>Block GPT-4 usage on CI machines while allowing it on dev workstations</Li>
              <Li>Require review for all sessions from a shared CI runner</Li>
              <Li>Set lower cost limits on production-access machines</Li>
            </ul>

            <H2>API</H2>
            <CodeBlock title="Machines API">{`# List machines
GET /api/machines

# Get machine detail with policy rules
GET /api/machines/:id`}</CodeBlock>
          </div>
    </>
  );
}
