import React from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { blogPosts } from '../data/blogPosts';

/* ------------------------------------------------------------------ */
/*  Blog post content keyed by slug                                    */
/* ------------------------------------------------------------------ */

const postContent: Record<string, React.ReactNode> = {
  'cross-agent-handoff-session-memory': (
    <>
      <p>
        You&rsquo;re deep in a Claude Code session. You&rsquo;ve refactored three files, added a new
        API endpoint, and you&rsquo;re halfway through writing tests. Then you switch to Cursor to
        work on the frontend that calls that endpoint.
      </p>
      <p>
        Cursor has no idea what you just did. It doesn&rsquo;t know which files changed, what the
        endpoint looks like, or that you still need to handle error cases. You spend the first 5
        minutes re-explaining everything.
      </p>
      <p>
        <strong>That&rsquo;s over.</strong> We shipped three experimental features that give AI agents
        memory across sessions and across tools.
      </p>

      <h2>Cross-agent context handoff</h2>
      <p>
        When a session ends, Origin saves the context to <code>.git/origin-handoff.json</code> &mdash;
        last prompts, files in progress, open TODOs, and a session summary. When the next session starts
        (any agent, same repo), that context gets injected into the system prompt automatically.
      </p>
      <p>This is what the next agent sees:</p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-gray-500 mb-2">Injected by Origin on session-start:</div>
        <div className="text-gray-300 mt-2">Previous session context (claude-code, 12m ago):</div>
        <div className="text-gray-400">Summary: Refactored auth module, added /api/users endpoint</div>
        <div className="text-gray-400">Last prompt: &ldquo;add JWT refresh token logic&rdquo;</div>
        <div className="text-gray-400">Files in progress: src/auth.ts, src/routes/users.ts, src/middleware.ts</div>
        <div className="text-gray-400">Changes: +145 -23 lines</div>
        <div className="text-gray-400 mt-1">Open TODOs from previous session:</div>
        <div className="text-gray-400">&nbsp;&nbsp;- handle token expiry edge case</div>
        <div className="text-gray-400">&nbsp;&nbsp;- add rate limiting to /api/users</div>
      </div>
      <p>
        The handoff expires after 24 hours. You can preview it anytime:
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div><span className="text-gray-500">$</span> origin handoff show</div>
      </div>

      <h2>Session memory</h2>
      <p>
        Handoff covers the last session. But what about the bigger picture? Session memory stores a
        rolling log of your last 20 sessions per repo, kept in git notes (<code>refs/notes/origin-memory</code>).
      </p>
      <p>
        Every new session gets the last 3 summaries injected. Your agent knows what happened yesterday,
        which files were hot, and what&rsquo;s still unfinished &mdash; without you saying a word.
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-gray-500 mb-2">Injected by Origin on session-start:</div>
        <div className="text-gray-300">Session history for this repo:</div>
        <div className="text-gray-400">- [2h ago] claude-code/claude-opus-4-6: Refactored auth module, added JWT refresh</div>
        <div className="text-gray-400">&nbsp;&nbsp;Files: src/auth.ts, src/routes/users.ts, src/middleware.ts</div>
        <div className="text-gray-400">- [1d ago] cursor/gpt-4.1: Built user settings page, added dark mode toggle</div>
        <div className="text-gray-400">&nbsp;&nbsp;Files: src/pages/Settings.tsx, src/theme.ts</div>
        <div className="text-gray-400">- [2d ago] gemini/gemini-2.5-pro: Set up CI pipeline, added lint + test steps</div>
        <div className="text-gray-400">&nbsp;&nbsp;Files: .github/workflows/ci.yml, package.json</div>
      </div>
      <p>
        Memory travels with the repo (it&rsquo;s stored in git notes). Push it to your remote and
        teammates see the same history.
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div><span className="text-gray-500">$</span> origin memory show&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-gray-600"># see all stored summaries</span></div>
        <div><span className="text-gray-500">$</span> origin memory clear&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-gray-600"># reset memory for this repo</span></div>
      </div>

      <h2>AI TODO tracker</h2>
      <p>
        Half the TODOs in a codebase are born in AI conversations. &ldquo;We need to fix X later&rdquo;,
        &ldquo;TODO: handle the edge case&rdquo;, &ldquo;we should add rate limiting&rdquo; &mdash; they
        get said in a prompt, the agent moves on, and nobody tracks them.
      </p>
      <p>
        Origin now extracts these automatically. It catches <code>TODO</code>, <code>FIXME</code>,{' '}
        <code>NOTE</code>, and natural language patterns like &ldquo;need to fix&rdquo;,
        &ldquo;we should&rdquo;, and &ldquo;later&rdquo;. Every extracted TODO links back to the session
        and prompt where it originated.
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div><span className="text-gray-500">$</span> origin todo list</div>
        <div className="mt-2">
          <span className="text-yellow-400">#1</span>{' '}
          <span className="text-gray-300">handle token expiry edge case</span>{' '}
          <span className="text-gray-600">(claude-code, 2h ago)</span>
        </div>
        <div>
          <span className="text-yellow-400">#2</span>{' '}
          <span className="text-gray-300">add rate limiting to /api/users</span>{' '}
          <span className="text-gray-600">(claude-code, 2h ago)</span>
        </div>
        <div>
          <span className="text-yellow-400">#3</span>{' '}
          <span className="text-gray-300">add dark mode to settings page</span>{' '}
          <span className="text-gray-600">(cursor, 1d ago)</span>
        </div>
        <div className="mt-2">
          <div><span className="text-gray-500">$</span> origin todo done 1</div>
          <div><span className="text-gray-500">$</span> origin todo show 2&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-gray-600"># see originating session</span></div>
        </div>
      </div>

      <h2>AI-powered explain</h2>
      <p>
        <code>origin explain</code> already shows session metadata &mdash; prompts, files, tokens, cost.
        Now with <code>--summarize</code>, it calls Claude to generate a structured analysis:
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div><span className="text-gray-500">$</span> origin explain abc123 --summarize</div>
        <div className="mt-2">
          <div className="text-indigo-400">Intent:</div>
          <div className="text-gray-400">&nbsp;&nbsp;Refactor auth module to use JWT with refresh tokens</div>
          <div className="text-indigo-400 mt-1">Outcome:</div>
          <div className="text-gray-400">&nbsp;&nbsp;Added JWT validation, refresh endpoint, and token middleware.</div>
          <div className="text-gray-400">&nbsp;&nbsp;3 files changed, +145 -23 lines.</div>
          <div className="text-indigo-400 mt-1">Friction:</div>
          <div className="text-gray-400">&nbsp;&nbsp;Agent initially used jwt.decode instead of jwt.verify.</div>
          <div className="text-gray-400">&nbsp;&nbsp;Required follow-up prompt to fix security issue.</div>
          <div className="text-indigo-400 mt-1">Time saved:</div>
          <div className="text-gray-400">&nbsp;&nbsp;~45 minutes vs manual implementation</div>
        </div>
      </div>

      <h2>Why this matters</h2>
      <p>
        Every AI coding tool treats each session as a blank slate. That&rsquo;s fine for a single
        question, but real development happens across sessions, across tools, across days.
      </p>
      <p>
        Context handoff means you stop wasting the first 5 minutes of every session re-explaining
        what you&rsquo;re doing. Session memory means the agent understands your project&rsquo;s
        trajectory. TODO tracking means nothing falls through the cracks.
      </p>
      <p>
        These features are free, local-first, and open source. All data is stored in git &mdash; no
        cloud dependency, no vendor lock-in.
      </p>

      <h2>Get started</h2>
      <div className="bg-gray-900 border border-indigo-500/30 rounded-lg p-6 my-6">
        <div className="font-mono text-sm mb-2">
          <span className="text-gray-500">$</span> npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
        </div>
        <div className="font-mono text-sm mb-4">
          <span className="text-gray-500">$</span> origin init
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Handoff and memory kick in automatically after your first completed session.
        </p>
        <div className="flex flex-wrap gap-4">
          <a
            href="https://github.com/dolobanko/origin-cli"
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
        These features are experimental. We&rsquo;re iterating fast based on developer feedback.
        Try them, break them, <a href="https://github.com/dolobanko/origin-cli/issues" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">tell us what sucks</a>.
      </p>
    </>
  ),
  'ai-governance-policies-ci': (
    <>
      <p>
        Here&rsquo;s the problem with AI coding agents: they don&rsquo;t read the employee handbook.
        Claude doesn&rsquo;t know your team bans <code>.env</code> commits. Codex doesn&rsquo;t know
        you have a policy against touching <code>src/auth/</code>. Cursor doesn&rsquo;t care about
        your commit message format.
      </p>
      <p>
        Until now. We shipped three features that give engineering teams actual control over what AI
        agents can and can&rsquo;t do.
      </p>

      <h2>1. Cross-agent policy enforcement</h2>
      <p>
        Define policies once in the Origin dashboard. They&rsquo;re enforced across every agent your
        team uses &mdash; Claude Code, Cursor, Codex, and Gemini.
      </p>
      <p>
        Policies are injected into the agent&rsquo;s system prompt at session start. The agent sees
        them as rules it must follow. If it violates a policy (e.g., commits a diff containing a
        blocked pattern), Origin blocks the session.
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden my-6">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-green-500/80" />
          <span className="text-xs text-gray-500 ml-2 font-mono">Origin Dashboard &mdash; Policies</span>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between bg-gray-800/50 rounded-lg p-3">
            <div>
              <div className="text-sm font-medium text-gray-200">No sensitive files</div>
              <div className="text-xs text-gray-500">Restricted files: **/.env, src/auth/**</div>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">Blocks session</span>
          </div>
          <div className="flex items-center justify-between bg-gray-800/50 rounded-lg p-3">
            <div>
              <div className="text-sm font-medium text-gray-200">Block offensive language</div>
              <div className="text-xs text-gray-500">Block diff content matching pattern</div>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">Blocks session</span>
          </div>
          <div className="flex items-center justify-between bg-gray-800/50 rounded-lg p-3">
            <div>
              <div className="text-sm font-medium text-gray-200">Commit format required</div>
              <div className="text-xs text-gray-500">Commit messages must follow: type(scope): description</div>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">Warns</span>
          </div>
        </div>
      </div>
      <p>
        This is what the agent sees when a session starts:
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-gray-500 mb-2">System prompt injected by Origin:</div>
        <div className="text-gray-300">Active policies for this session:</div>
        <div className="text-gray-400">- No sensitive files: **/.env (Blocks session)</div>
        <div className="text-gray-400">- No sensitive files: src/auth/** (Blocks session)</div>
        <div className="text-gray-400">- Block offensive language (Blocks session)</div>
        <div className="text-gray-400">- Commit format required (Warns)</div>
      </div>

      <h2>2. Native rules injection for Cursor and Codex</h2>
      <p>
        Injecting policies via <code>systemMessage</code> works for Claude Code. But Cursor and Codex
        have their own rules systems &mdash; Cursor reads <code>~/.cursor/rules/</code> and Codex reads
        <code>AGENTS.md</code> in the project root.
      </p>
      <p>
        Origin now writes policies directly to these locations on every session start. No extra setup.
        The agent reads them natively, alongside its own built-in system prompt.
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-gray-500"># What happens on session-start:</div>
        <div className="mt-2">
          <span className="text-purple-400">Cursor</span>
          {'  '}
          <span className="text-gray-500">&rarr;</span>
          {'  '}
          <span className="text-gray-300">~/.cursor/rules/origin.md</span>
        </div>
        <div>
          <span className="text-green-400">Codex</span>
          {'   '}
          <span className="text-gray-500">&rarr;</span>
          {'  '}
          <span className="text-gray-300">./AGENTS.md</span>
          {'  '}
          <span className="text-gray-500">(project root)</span>
        </div>
        <div>
          <span className="text-blue-400">Claude</span>
          {'  '}
          <span className="text-gray-500">&rarr;</span>
          {'  '}
          <span className="text-gray-300">systemMessage in hook response</span>
        </div>
      </div>
      <p>
        The content is managed by an <code>{'<!-- origin-managed -->'}</code> marker, so existing
        <code>AGENTS.md</code> content isn&rsquo;t overwritten &mdash; Origin appends its section
        and updates it on each session.
      </p>

      <h2>3. CI/CD tamper detection</h2>
      <p>
        Every commit made through an Origin-tracked session gets a signed git note. The new
        <code>origin ci session-check</code> command verifies that every commit on a branch has one.
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-gray-500">$ origin ci session-check</div>
        <div className="mt-3 font-semibold text-gray-200">Origin Session Check &mdash; 26 commits</div>
        <div className="mt-2" />
        <div>{'  '}<span className="text-green-400">&#10003;</span> <span className="text-gray-500">3cc0eff</span> Update README <span className="text-gray-600">(cursor)</span></div>
        <div>{'  '}<span className="text-green-400">&#10003;</span> <span className="text-gray-500">7409d77</span> chore: append session note <span className="text-gray-600">(cursor)</span></div>
        <div>{'  '}<span className="text-green-400">&#10003;</span> <span className="text-gray-500">f5a1a68</span> chore: update hello.txt <span className="text-gray-600">(codex)</span></div>
        <div>{'  '}<span className="text-red-400">&#10007;</span> <span className="text-white">a8b3c2d</span> fix: quick patch <span className="text-red-400">&mdash; no Origin session</span></div>
        <div className="mt-3 text-gray-400">{'  '}1/4 commit(s) have no linked Origin session.</div>
        <div className="text-gray-600">{'  '}AI governance policy requires all commits to have a tracked session.</div>
      </div>
      <p>
        If any commit lacks a session, the check fails with exit code 1 &mdash; blocking the PR.
        Use <code>--warn-only</code> to make it non-blocking, or <code>--json</code> for machine-readable output.
      </p>

      <h2>Drop it into your CI pipeline</h2>
      <p>
        We ship ready-made templates for GitHub Actions and GitLab CI:
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-gray-500"># .github/workflows/origin-ci-check.yml</div>
        <div className="mt-2 text-blue-400">name: <span className="text-gray-300">Origin Session Check</span></div>
        <div className="text-blue-400">on:</div>
        <div className="text-gray-300 pl-4">pull_request:</div>
        <div className="text-gray-300 pl-8">branches: [main]</div>
        <div className="mt-2 text-blue-400">steps:</div>
        <div className="text-gray-300 pl-4">- run: npm i -g @anthropic/origin-cli</div>
        <div className="text-gray-300 pl-4">- run: origin ci session-check --since ${'{{'}base_sha{'}}'}</div>
      </div>
      <p>
        Every PR gets a check: did every commit come from a tracked, governed AI session?
        If someone bypasses Origin and commits directly, the check catches it.
      </p>

      <h2>What this means for teams</h2>
      <p>
        Before these features, AI governance was honor-system. You could write policies in a wiki
        and hope agents followed them. Now:
      </p>
      <ul>
        <li><strong>Policies are enforced at the agent level</strong> &mdash; not just documented</li>
        <li><strong>Every agent speaks the same rules</strong> &mdash; Cursor, Codex, Claude, Gemini</li>
        <li><strong>CI catches gaps</strong> &mdash; commits without sessions are flagged automatically</li>
        <li><strong>Zero developer friction</strong> &mdash; it&rsquo;s all automatic via hooks</li>
      </ul>

      <h2>Get started</h2>
      <div className="bg-gray-900 border border-indigo-500/30 rounded-lg p-6 my-6">
        <div className="font-mono text-sm mb-4">
          <div><span className="text-gray-500">$</span> npm i -g origin-cli</div>
          <div><span className="text-gray-500">$</span> origin init</div>
          <div><span className="text-gray-500">$</span> origin ci session-check <span className="text-gray-600">--warn-only</span></div>
        </div>
        <div className="flex flex-wrap gap-4">
          <a
            href="https://github.com/dolobanko/origin-cli"
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
    </>
  ),
  'ai-agent-rework-rates': (
    <>
      <p>
        We had a question nobody could answer: if your team uses Claude, Gemini, Cursor, and Codex
        on the same codebase, which agent writes code that actually survives?
      </p>
      <p>
        Not which one writes code fastest. Not which one feels nicest to use. Which one writes code
        that&rsquo;s still there a week later, untouched, doing its job.
      </p>
      <p>
        So we measured it.
      </p>

      <h2>The setup</h2>
      <p>
        We used Origin&rsquo;s <code>origin rework</code> command, which tracks AI-written code that gets
        modified within a given time window. If Claude writes a function on Monday and someone rewrites
        it on Thursday, that&rsquo;s rework. The function didn&rsquo;t stick.
      </p>
      <p>
        We ran four agents on the same repo over two weeks. Same types of tasks &mdash; feature work, bug
        fixes, refactors. Then we measured churn: what percentage of each agent&rsquo;s code got
        rewritten within 7 days.
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-gray-500">$ origin rework --days 14</div>
        <div className="mt-2" />
        <div><span className="text-purple-400">Claude</span>{'     '}18 commits{'   '}3 reworked{'   '}churn <span className="text-green-400">12%</span></div>
        <div><span className="text-blue-400">Cursor</span>{'     '}14 commits{'   '}4 reworked{'   '}churn <span className="text-yellow-400">22%</span></div>
        <div><span className="text-green-400">Codex</span>{'      '}21 commits{'   '}7 reworked{'   '}churn <span className="text-yellow-400">28%</span></div>
        <div><span className="text-amber-400">Gemini</span>{'     '}12 commits{'   '}5 reworked{'   '}churn <span className="text-red-400">38%</span></div>
      </div>

      <h2>What the numbers mean</h2>
      <p>
        <strong>Claude had a 12% rework rate.</strong> Out of 18 commits, only 3 needed changes within
        a week. The code it wrote was largely production-ready on the first pass.
      </p>
      <p>
        <strong>Cursor landed at 22%.</strong> Fast to iterate with, but about one in five changes needed
        a follow-up. Mostly small fixes &mdash; missed edge cases, incomplete error handling.
      </p>
      <p>
        <strong>Codex came in at 28%.</strong> It was prolific &mdash; the most commits of any agent. But
        volume came at a cost. The reworked code was often structural: wrong abstractions, functions that
        needed to be split or moved.
      </p>
      <p>
        <strong>Gemini had the highest churn at 38%.</strong> Nearly 4 in 10 pieces of code needed
        rework. The pattern was consistent: it would write something that looked correct but
        missed project conventions or made incorrect assumptions about the codebase.
      </p>

      <h2>Where it gets interesting</h2>
      <p>
        The headline numbers only tell part of the story. When we broke it down by task type:
      </p>
      <ul>
        <li><strong>Bug fixes</strong>: Claude and Cursor were nearly tied. Both under 15% churn.</li>
        <li><strong>New features</strong>: Claude pulled ahead. Its code needed fewer structural changes.</li>
        <li><strong>Refactors</strong>: This is where the gap widened. Claude 8% churn, Gemini 45%.</li>
        <li><strong>Tests</strong>: Codex was actually the best here. 10% churn vs Claude&rsquo;s 18%.</li>
      </ul>
      <p>
        No single agent won everything. The smart play isn&rsquo;t picking one agent &mdash;
        it&rsquo;s knowing which agent to use for which task, in which repo.
      </p>

      <h2>The cost angle</h2>
      <p>
        Rework isn&rsquo;t free. Every rewritten function means a developer spent time understanding
        what the AI did wrong and fixing it. If your team generates 200 AI commits per week and
        30% need rework, that&rsquo;s 60 commits someone has to revisit.
      </p>
      <p>
        At our measured averages, switching from Gemini to Claude on refactoring tasks alone would
        have saved roughly 15 developer-hours over two weeks. That&rsquo;s real money.
      </p>

      <h2>How to measure this yourself</h2>
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm my-6">
        <div className="text-green-400">$ npm i -g origin-cli</div>
        <div className="text-green-400">$ origin init</div>
        <div className="text-gray-500 mt-2"># Use your agents normally for a week, then:</div>
        <div className="text-green-400 mt-1">$ origin rework --days 7</div>
      </div>
      <p>
        Origin tracks which agent wrote every commit. <code>origin rework</code> calculates how much of
        that code got changed afterward. You get a per-agent, per-file breakdown of what stuck and
        what didn&rsquo;t.
      </p>
      <p>
        It&rsquo;s open source. Takes 30 seconds to set up. Works with Claude, Cursor, Gemini, and Codex.
      </p>
      <p>
        GitHub: <a href="https://github.com/dolobanko/origin-cli" className="text-indigo-400 hover:text-indigo-300">github.com/dolobanko/origin-cli</a>
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
