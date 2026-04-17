import { H2, H3, P, Li, Step, Callout } from '../shared/Markdown';

export default function ReposSection() {
  return (
    <>
          <div>
            <h1 id="repos" className="text-2xl font-bold mb-2">Repositories</h1>
            <P>
              Repositories are the foundation of Origin. Each repo represents a Git
              repository where AI agents write code.
            </P>

            {/* Repos Mockup */}
            <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden my-6">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <div className="w-3 h-3 rounded-full bg-green-500/80" />
                <span className="text-xs text-gray-500 ml-2 font-mono">Repositories</span>
              </div>
              <div className="p-4 space-y-2">
                {[
                  { name: 'acme/backend', synced: true, lastActivity: '2h ago', ai: 34, commits: 156 },
                  { name: 'acme/frontend', synced: true, lastActivity: '5h ago', ai: 28, commits: 210 },
                  { name: 'acme/api', synced: false, lastActivity: '1d ago', ai: 42, commits: 89 },
                ].map((r, i) => (
                  <div key={i} className="flex items-center gap-3 bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3 hover:bg-gray-800/60 cursor-pointer">
                    <div className="w-7 h-7 rounded bg-gray-700/50 flex items-center justify-center text-[10px] text-gray-400 font-mono">{'{}'}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-200 font-medium">{r.name}</div>
                      <div className="text-[10px] text-gray-500">{r.commits} commits &middot; last activity {r.lastActivity}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {r.synced ? (
                        <><div className="w-1.5 h-1.5 rounded-full bg-green-500" /><span className="text-[10px] text-green-400">Synced</span></>
                      ) : (
                        <><div className="w-1.5 h-1.5 rounded-full bg-amber-500" /><span className="text-[10px] text-amber-400">Pending</span></>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-indigo-400 font-medium">{r.ai}%</div>
                      <div className="text-[9px] text-gray-500">AI-authored</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <H2>Importing from GitHub (Recommended)</H2>
            <P>
              If you&apos;ve connected GitHub in Settings &rarr; Integrations, you&apos;ll see an
              <strong className="text-gray-200"> Import from GitHub</strong> button on the Repositories page.
            </P>
            <Step n={1} title="Click 'Import from GitHub'">
              <p>Origin fetches all repos your GitHub token has access to. This includes private repos, org repos, and forks.</p>
            </Step>
            <Step n={2} title="Select repos to monitor">
              <p>Use the search filter to find repos. Check the ones you want to monitor. Repos already imported are shown with a green &ldquo;imported&rdquo; badge and can&apos;t be selected again.</p>
            </Step>
            <Step n={3} title="Click 'Import Selected'">
              <p>For each selected repo, Origin creates the repository record, generates a webhook secret, and creates a webhook on GitHub automatically. You&apos;ll see per-repo success/error results.</p>
            </Step>

            <Callout type="info">
              Auto-import creates webhooks that listen for <code className="text-indigo-400">push</code> and <code className="text-indigo-400">pull_request</code> events.
              When you delete an imported repo from Origin, the webhook is also removed from GitHub automatically.
            </Callout>

            <H2>Syncing</H2>
            <P>
              Click &ldquo;Sync Now&rdquo; on any repo to scan for new commits. Origin looks for
              <code className="text-indigo-400"> .entire/</code> checkpoint directories that AI tools
              create, then imports the session data (model, prompt, transcript, files changed, etc.).
            </P>

            <H2>AI Commit Detection</H2>
            <P>
              Origin automatically classifies commits as AI-authored or human-authored using
              multiple detection methods. This powers the AI/Human filters and the AI percentage metric.
            </P>
            <H3>Detection Methods (in priority order)</H3>
            <ul className="space-y-2 mb-4">
              <Li>
                <strong className="text-gray-200">Session-linked</strong> (blue badge) — Commits created
                during a tracked coding session. These have full prompt, transcript, and cost data.
              </Li>
              <Li>
                <strong className="text-gray-200">Co-Authored-By trailer</strong> (purple badge) — Detects{' '}
                <code className="text-indigo-400">Co-Authored-By:</code> trailers in commit messages from
                Claude Code, GitHub Copilot, Cursor, Aider, Gemini, and Windsurf/Codeium.
              </Li>
              <Li>
                <strong className="text-gray-200">Author pattern</strong> (purple badge) — Recognizes AI bot
                author names like &ldquo;Claude&rdquo;, &ldquo;copilot&rdquo;, or &ldquo;mcp-agent&rdquo;.
              </Li>
              <Li>
                <strong className="text-gray-200">Commit message pattern</strong> (purple badge) — Matches
                known AI signatures like &ldquo;Generated with Claude Code&rdquo; or &ldquo;[aider]&rdquo; prefixes.
              </Li>
            </ul>
            <P>
              Heuristically-detected commits show a purple dashed badge with the tool name and
              &ldquo;detected&rdquo; label. Session-linked commits show a solid blue badge with the model name.
              Undetected commits show a gray &ldquo;Human&rdquo; badge.
            </P>

            <Callout type="tip">
              To ensure your AI commits are correctly detected, make sure your AI tool adds a{' '}
              <code className="text-indigo-400">Co-Authored-By</code> trailer to commit messages.
              Claude Code does this by default. Click the <strong className="text-gray-200">Rescan AI</strong> button
              on any repo to re-analyze existing commits.
            </Callout>

            <H2>Repository Detail View</H2>
            <P>Click any repo card to see its detail page with:</P>
            <ul className="space-y-2 mb-4">
              <Li>Stats: total commits, AI-authored, human, unreviewed counts</Li>
              <Li>Filter tabs: All / AI Authored / Human / Unreviewed</Li>
              <Li>Full commit table with SHA, message, author, model, files, tokens, and review status</Li>
              <Li>Rescan AI button to re-analyze commits for AI authorship detection</Li>
              <Li>Webhook settings (for GitHub repos)</Li>
              <Li>Click any AI-authored commit to view its session detail and transcript</Li>
            </ul>

            <H2>Deleting a Repository</H2>
            <P>
              Deleting a repo is a cascade operation that removes all associated data: webhooks, pull requests,
              commits, sessions, and reviews. For GitHub-imported repos, the webhook on GitHub is also automatically
              deleted. This action cannot be undone. Requires ADMIN role or above.
            </P>
          </div>
    </>
  );
}
