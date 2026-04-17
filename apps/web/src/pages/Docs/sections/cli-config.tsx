import { CodeBlock, H2, P } from '../shared/Markdown';

export default function CliConfigSection() {
  return (
    <>
          <div>
            <h1 id="cli-config" className="text-2xl font-bold mb-2">CLI Configuration</h1>
            <P>
              Configuration is stored at <code className="text-indigo-400">~/.origin/config.json</code>.
              Use <code className="text-indigo-400">origin config</code> commands to manage settings.
            </P>

            <H2>Config Commands</H2>
            <div className="space-y-4 mt-4">
              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin config set apiKey &lt;key&gt;</code>
                <P>Set your API key for authenticating with the Origin platform. Prefer <code className="text-indigo-400">origin login</code> which handles this automatically.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin config set api-url &lt;url&gt;</code>
                <P>Set custom API URL. Default: <code className="text-indigo-400">https://getorigin.io</code></P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin config set mode &lt;auto|standalone&gt;</code>
                <P>Force operating mode. <code className="text-indigo-400">auto</code> uses the platform when credentials exist, <code className="text-indigo-400">standalone</code> keeps everything local.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin config set snapshot-repo &lt;url&gt;</code>
                <P>Store session data in a separate private git repo instead of the main codebase.</P>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
                <code className="text-indigo-400 font-mono text-sm font-bold">origin config set auto-snapshot true</code>
                <P>Automatically save working tree snapshots before every AI file edit.</P>
              </div>
            </div>

            <H2>Config File</H2>
            <CodeBlock title="~/.origin/config.json">{`{
  "apiKey": "org_...",
  "apiUrl": "https://getorigin.io",
  "mode": "auto",
  "pushStrategy": "auto",
  "snapshotRepo": null,
  "autoSnapshot": false
}`}</CodeBlock>

            <H2>Per-Repo Config</H2>
            <P>
              Create a <code className="text-indigo-400">.origin.json</code> in any repo root to override settings:
            </P>
            <CodeBlock title=".origin.json">{`{
  "agent": "claude-code",
  "autoSnapshot": true,
  "pushStrategy": "prompt"
}`}</CodeBlock>
          </div>
    </>
  );
}
