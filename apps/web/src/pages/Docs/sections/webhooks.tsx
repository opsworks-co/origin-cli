import { CodeBlock, H2, P, Li, Step } from '../shared/Markdown';

export default function WebhooksSection() {
  return (
    <>
          <div>
            <h1 id="webhooks" className="text-2xl font-bold mb-2">Webhooks</h1>
            <P>
              Webhooks allow GitHub to push events (commits, pull requests) to Origin in real-time.
              When you import repos via &ldquo;Import from GitHub&rdquo;, webhooks are created automatically.
              This section covers manual webhook setup for advanced use cases.
            </P>

            {/* Webhooks Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Webhook Configuration</span>
              </div>
              <div className="p-4">
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] text-gray-500 uppercase block mb-1">Payload URL</label>
                    <div className="bg-gray-800/50 border border-gray-700 rounded px-3 py-2 text-xs text-indigo-400 font-mono">https://api.getorigin.io/webhooks/gh/wh_a3f8c21e</div>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-500 uppercase block mb-1">Secret</label>
                    <div className="bg-gray-800/50 border border-gray-700 rounded px-3 py-2 text-xs text-gray-500 font-mono">whsec_****************************</div>
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-500 uppercase block mb-1">Events</label>
                    <div className="flex gap-2">
                      <span className="px-2 py-1 bg-indigo-900/30 border border-indigo-700/30 rounded text-[10px] text-indigo-400">push</span>
                      <span className="px-2 py-1 bg-indigo-900/30 border border-indigo-700/30 rounded text-[10px] text-indigo-400">pull_request</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    <span className="text-[10px] text-green-400">Active</span>
                    <span className="text-[10px] text-gray-500 ml-2">Last delivery: 2m ago (200 OK)</span>
                  </div>
                </div>
              </div>
            </div>

            <H2>How Webhooks Work</H2>
            <P>
              Each webhook has a unique URL and a shared secret for HMAC-SHA256 signature verification.
              When GitHub sends an event, Origin verifies the signature before processing.
            </P>

            <H2>Automatic Setup (Recommended)</H2>
            <P>
              Use <strong className="text-gray-200">Repositories &rarr; Import from GitHub</strong>. Origin creates webhooks
              on GitHub automatically using the GitHub API. No manual configuration needed.
            </P>

            <H2>Manual Setup</H2>
            <P>For repos that can&apos;t use auto-import (e.g. self-hosted Git, fine-grained permissions):</P>

            <Step n={1} title="Create webhook in Origin">
              <p>Go to the repo detail page and scroll to &ldquo;GitHub Webhooks&rdquo;. Click &ldquo;Create Webhook&rdquo;. Copy the webhook URL and secret (shown only once).</p>
            </Step>
            <Step n={2} title="Add webhook on GitHub">
              <p>In your GitHub repo, go to <strong className="text-gray-200">Settings &rarr; Webhooks &rarr; Add webhook</strong>:</p>
              <ul className="space-y-1 mt-2 ml-4">
                <Li><strong className="text-gray-200">Payload URL</strong>: Paste the webhook URL from Origin</Li>
                <Li><strong className="text-gray-200">Content type</strong>: <code className="text-indigo-400">application/json</code></Li>
                <Li><strong className="text-gray-200">Secret</strong>: Paste the secret from Origin</Li>
                <Li><strong className="text-gray-200">Events</strong>: Select &ldquo;Let me select individual events&rdquo; &rarr; check <code className="text-indigo-400">Pushes</code> and <code className="text-indigo-400">Pull requests</code></Li>
              </ul>
            </Step>

            <H2>Supported Events</H2>
            <ul className="space-y-2 mb-4">
              <Li><strong className="text-gray-200">push</strong> &mdash; Creates commit records in Origin. Duplicate SHAs are automatically skipped.</Li>
              <Li><strong className="text-gray-200">pull_request</strong> &mdash; Creates/updates PR records. Triggers status checks and comment posting (if integration configured).</Li>
              <Li><strong className="text-gray-200">ping</strong> &mdash; GitHub sends this on webhook creation. Origin responds with &ldquo;pong&rdquo;.</Li>
            </ul>

            <H2>Webhook URL Format</H2>
            <CodeBlock>{`https://your-origin-instance.com/api/webhooks/github/{repoId}`}</CodeBlock>
            <P>
              The <code className="text-indigo-400">repoId</code> is the Origin repository ID. Each repo has its own
              webhook endpoint with its own secret.
            </P>

            <H2>Security</H2>
            <ul className="space-y-2 mb-4">
              <Li>Webhook secrets are 256-bit random hex strings</Li>
              <Li>Signatures are verified using <code className="text-indigo-400">HMAC-SHA256</code> with <code className="text-indigo-400">timingSafeEqual</code> (constant-time comparison to prevent timing attacks)</Li>
              <Li>Requests without valid signatures are rejected with 401</Li>
              <Li>Webhook endpoints do not require Bearer token auth &mdash; they use HMAC verification instead</Li>
            </ul>
          </div>
    </>
  );
}
