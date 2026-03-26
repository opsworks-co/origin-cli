import React from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { blogPosts } from '../data/blogPosts';

/* ------------------------------------------------------------------ */
/*  Blog post content keyed by slug                                    */
/* ------------------------------------------------------------------ */

const postContent: Record<string, React.ReactNode> = {
  'ai-agents-need-a-manager': (
    <>
      <p>
        Here&rsquo;s the situation at most engineering teams right now: developers are using 3-4 different
        AI coding agents. Claude for complex architecture. Cursor for fast iteration. Gemini for
        broad codebase work. Codex for automation. Maybe Copilot too.
      </p>
      <p>
        And nobody has any idea what&rsquo;s happening.
      </p>

      <h2>The visibility problem</h2>
      <p>
        Your CTO asks: &ldquo;How much are we spending on AI coding tools?&rdquo; Nobody knows.
        &ldquo;Which agent produces the most reliable code?&rdquo; Nobody can tell. &ldquo;Did any AI
        agent touch the auth module this week?&rdquo; You&rsquo;d have to ask every developer individually.
      </p>
      <p>
        This is the state of AI coding in 2026. Powerful tools with zero accountability. Every agent
        operates in its own silo. The code ships, but the context disappears.
      </p>

      <h2>What we built</h2>
      <p>
        Origin is an open-source CLI that installs in 30 seconds and tracks every AI coding session
        across every agent. One command:
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-green-400">$ npm i -g origin-cli</div>
        <div className="text-green-400">$ origin init</div>
        <div className="text-gray-500 mt-2"># Detected: Claude Code, Cursor, Codex</div>
        <div className="text-gray-500"># Hooks installed. Tracking active.</div>
      </div>
      <p>
        From that moment, every AI session is recorded. Every prompt. Every file changed. Every token
        spent. Every model used. All stored locally in git notes &mdash; no server required.
      </p>

      <h2>Attribution that actually works</h2>
      <p>
        Run <code>origin blame</code> on any file and you see which AI agent wrote each line,
        when, and from which prompt. Not just &ldquo;John committed this&rdquo; &mdash; but
        &ldquo;Claude wrote this 3 hours ago in response to: refactor auth with JWT validation.&rdquo;
      </p>
      <p>
        Run <code>origin rework</code> and you see which AI-written code got changed within a week.
        If Gemini&rsquo;s code has a 40% churn rate in your repo, maybe stop using Gemini for that repo.
      </p>

      <h2>Governance for teams</h2>
      <p>
        The CLI works standalone, but teams need more. Connect to the Origin platform and you get:
      </p>
      <ul>
        <li><strong>Policy enforcement</strong> &mdash; block commits containing secrets, restrict which models can be used, require human review for security-sensitive files</li>
        <li><strong>Budget controls</strong> &mdash; set per-agent and per-developer spending limits. Get alerts at 80%. Block new sessions at 100%.</li>
        <li><strong>PR merge gating</strong> &mdash; require AI session review before merge. GitHub and GitLab status checks built in.</li>
        <li><strong>Compliance audit trail</strong> &mdash; one command generates a SOC 2 / ISO 27001 report of all AI activity</li>
        <li><strong>IAM</strong> &mdash; per-developer API keys with agent and repo scoping. Zero-trust by default.</li>
      </ul>

      <h2>What makes this different</h2>
      <p>
        We looked at every tool in this space. Entire (backed by the former GitHub CEO with $60M)
        does session recording. git-ai does line-level attribution. Both are good at what they do.
      </p>
      <p>
        But neither does governance. No policy enforcement. No secret scanning. No budget controls.
        No PR gating. No compliance. No system prompt injection that tells agents what other agents did.
      </p>
      <p>
        Origin does all of it. Open source CLI, self-hosted option, and a platform for teams
        that need dashboards and controls.
      </p>

      <h2>Try it</h2>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-green-400">$ npm i -g origin-cli</div>
        <div className="text-green-400">$ origin init</div>
        <div className="text-green-400">$ origin blame src/api.ts</div>
      </div>
      <p>
        GitHub: <a href="https://github.com/dolobanko/origin-cli" className="text-indigo-400 hover:text-indigo-300">github.com/dolobanko/origin-cli</a>
        <br />
        Platform: <a href="https://getorigin.io" className="text-indigo-400 hover:text-indigo-300">getorigin.io</a>
      </p>
    </>
  ),
  'why-git-blame-is-broken': (
    <>
      <p>
        Every developer has done it. Something breaks in production, you run{' '}
        <code>git blame</code>, find the line, find the author, and start a conversation. It&rsquo;s
        the most basic form of code accountability &mdash; and it&rsquo;s been reliable for decades.
      </p>
      <p>
        But here&rsquo;s the problem: <strong>when 60%+ of your code is AI-generated, git blame
        shows the wrong person.</strong>
      </p>

      <h2>The gap in git blame</h2>
      <p>
        Git blame tells you who committed a line. In the age of AI coding, that means it shows
        you the developer who <em>ran the prompt</em> &mdash; not which AI wrote the code, what
        prompt was used, what model generated it, or what it cost.
      </p>
      <p>
        You lose all the context that actually matters for debugging. There&rsquo;s no way to
        know if the code came from Claude, Gemini, Cursor, or Codex. No way to see the instruction
        that produced it. No way to understand <em>why</em> the AI made a particular decision.
      </p>

      <h2>A real scenario</h2>
      <p>
        Production goes down. Auth is broken &mdash; tokens are being accepted that shouldn&rsquo;t be.
        You run <code>git blame</code> on the auth module:
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm overflow-x-auto my-6">
        <div className="text-gray-500 mb-2">$ git blame src/auth/validate.ts</div>
        <div>
          <span className="text-yellow-400">a1b2c3d4</span>{' '}
          <span className="text-gray-500">(John Smith 2026-03-23)</span>{' '}
          <span className="text-gray-300">function validateToken(token: string) {'{'}</span>
        </div>
        <div>
          <span className="text-yellow-400">a1b2c3d4</span>{' '}
          <span className="text-gray-500">(John Smith 2026-03-23)</span>{' '}
          <span className="text-gray-300">  const decoded = jwt.decode(token);</span>
        </div>
        <div>
          <span className="text-yellow-400">a1b2c3d4</span>{' '}
          <span className="text-gray-500">(John Smith 2026-03-23)</span>{' '}
          <span className="text-gray-300">  return decoded !== null;</span>
        </div>
        <div>
          <span className="text-yellow-400">a1b2c3d4</span>{' '}
          <span className="text-gray-500">(John Smith 2026-03-23)</span>{' '}
          <span className="text-gray-300">{'}'}</span>
        </div>
      </div>
      <p>
        Looks like John wrote a broken token validator 3 days ago &mdash; it uses <code>jwt.decode</code>{' '}
        instead of <code>jwt.verify</code>, accepting any well-formed token without checking the
        signature.
      </p>
      <p>
        But John didn&rsquo;t write this. John prompted Claude to{' '}
        <em>&ldquo;refactor auth to use JWT&rdquo;</em>. Claude hallucinated a weak validation
        function. Git blame can&rsquo;t show you any of this.
      </p>

      <h2>The fix: origin blame</h2>
      <p>
        We built <code>origin blame</code> to solve this. It shows the AI agent, model, prompt,
        and session behind every line of AI-generated code:
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden my-6">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-green-500/80" />
          <span className="text-xs text-gray-500 ml-2 font-mono">terminal</span>
        </div>
        <div className="p-4 font-mono text-sm overflow-x-auto">
          <div className="text-gray-500 mb-3">$ origin blame src/auth/validate.ts</div>
          <div className="mb-1">
            <span className="text-purple-400">Claude 3.5</span>{' '}
            <span className="text-gray-600">|</span>{' '}
            <span className="text-gray-500">John Smith</span>{' '}
            <span className="text-gray-600">|</span>{' '}
            <span className="text-indigo-400">&ldquo;refactor auth to use JWT&rdquo;</span>{' '}
            <span className="text-gray-600">|</span>{' '}
            <span className="text-gray-500">3 days ago</span>
          </div>
          <div className="border-l-2 border-purple-500/40 pl-3 mt-2 space-y-0.5">
            <div><span className="text-gray-500">1</span> <span className="text-gray-300">function validateToken(token: string) {'{'}</span></div>
            <div><span className="text-gray-500">2</span> <span className="text-red-400">  const decoded = jwt.decode(token);</span> <span className="text-red-400/60 text-xs ml-2">// no signature verification</span></div>
            <div><span className="text-gray-500">3</span> <span className="text-red-400">  return decoded !== null;</span></div>
            <div><span className="text-gray-500">4</span> <span className="text-gray-300">{'}'}</span></div>
          </div>
          <div className="mt-3 text-xs text-gray-600">
            Session: ses_8f3k2m &middot; Model: claude-3.5-sonnet &middot; Cost: $0.003 &middot; Tokens: 1,847
          </div>
        </div>
      </div>
      <p>
        Now you can see the full picture: Claude generated this code, the prompt was a vague
        refactoring instruction, and the model hallucinated an insecure implementation. You know
        exactly what went wrong and why.
      </p>

      <h2>How it works</h2>
      <p>
        Origin sits between your AI coding tools and your codebase. It records every AI session
        &mdash; prompts, responses, tool calls, file changes &mdash; and links them to specific
        lines of code via git. When you run <code>origin blame</code>, it cross-references git
        history with session data to show the AI context behind every line.
      </p>
      <p>It takes 30 seconds to set up:</p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div><span className="text-gray-500">$</span> npm i -g https://getorigin.io/cli/origin-cli-latest.tgz</div>
        <div><span className="text-gray-500">$</span> origin init</div>
        <div className="text-green-400 mt-1">Done. Origin is tracking AI sessions in this repo.</div>
      </div>

      <h2>Open source, works with everything</h2>
      <p>
        Origin is open source and works with the tools you already use: <strong>Claude Code</strong>,{' '}
        <strong>Cursor</strong>, <strong>Gemini CLI</strong>, and <strong>Codex</strong>. No vendor
        lock-in, no proprietary formats.
      </p>
      <p>
        The CLI is free. The dashboard (session replay, team analytics, policy enforcement) is
        available on <Link to="/pricing" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">paid plans</Link>.
      </p>

      <h2>Try it now</h2>
      <div className="bg-gray-900 border border-indigo-500/30 rounded-lg p-6 my-6">
        <div className="font-mono text-sm mb-4">
          <span className="text-gray-500">$</span> npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
        </div>
        <div className="flex flex-wrap gap-4">
          <a
            href="https://github.com/anthropics/origin"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" /></svg>
            GitHub
          </a>
          <Link
            to="/docs"
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-medium transition-colors"
          >
            Read the docs
          </Link>
        </div>
      </div>
      <p className="text-gray-400 text-sm">
        Git blame was built for a world where humans wrote all the code. That world is gone.
        It&rsquo;s time for tooling that understands how code is actually written today.
      </p>
    </>
  ),
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const post = blogPosts.find((p) => p.slug === slug);

  if (!post || !slug || !postContent[slug]) {
    return <Navigate to="/blog" replace />;
  }

  const shareUrl = encodeURIComponent(`https://getorigin.io/blog/${slug}`);
  const shareTitle = encodeURIComponent(post.title);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Back */}
        <Link
          to="/blog"
          className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-100 transition-colors mb-8"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Back to blog
        </Link>

        {/* Header */}
        <div className="mb-10">
          <div className="flex flex-wrap gap-2 mb-4">
            {post.tags.map((tag) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 rounded-full bg-indigo-600/20 text-indigo-400 border border-indigo-500/30"
              >
                {tag}
              </span>
            ))}
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-4">{post.title}</h1>
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span>{post.author}</span>
            <span>&middot;</span>
            <time dateTime={post.date}>
              {new Date(post.date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </time>
          </div>
        </div>

        {/* Content */}
        <article className="prose prose-invert prose-indigo max-w-none [&>p]:text-gray-300 [&>p]:leading-relaxed [&>p]:mb-5 [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:mt-10 [&>h2]:mb-4 [&>h2]:text-gray-100 [&_code]:bg-gray-800 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-indigo-300 [&_code]:text-sm [&_a]:text-indigo-400 [&_a]:underline [&_a]:underline-offset-2 [&>ul]:list-disc [&>ul]:pl-5 [&>ul]:text-gray-300 [&>ul]:space-y-2 [&>ul]:mb-5">
          {postContent[slug]}
        </article>

        {/* Share */}
        <div className="mt-12 pt-8 border-t border-gray-800">
          <p className="text-sm text-gray-500 mb-3">Share this post</p>
          <div className="flex gap-3">
            <a
              href={`https://twitter.com/intent/tweet?url=${shareUrl}&text=${shareTitle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 hover:bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
              Twitter
            </a>
            <a
              href={`https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 hover:bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" /></svg>
              LinkedIn
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
