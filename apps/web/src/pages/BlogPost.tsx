import React from 'react';
import { Helmet } from 'react-helmet-async';
import { useParams, Link, Navigate } from 'react-router-dom';
import { blogPosts } from '../data/blogPosts';

/* ------------------------------------------------------------------ */
/*  Blog post content keyed by slug                                    */
/* ------------------------------------------------------------------ */

const postContent: Record<string, React.ReactNode> = {
  'origin-solo-free-ai-coding-analytics': (
    <>
      <p>
        If you&rsquo;re a developer using AI coding tools in 2026, your workflow probably looks
        something like this: Claude Code for deep refactors, Cursor for quick edits, maybe Gemini
        CLI for exploration, Codex when you want a second opinion. You switch between them constantly.
      </p>
      <p>
        But here&rsquo;s what you don&rsquo;t know: how much you&rsquo;re spending across all of them,
        which agent actually writes code that sticks, how many tokens you burn per session, or whether
        that 45-minute Claude session was more productive than the 20-minute Cursor one.
      </p>
      <p>
        That&rsquo;s why we built <strong>Origin Solo</strong> &mdash; a free, personal analytics
        layer for developers who use AI coding tools. No team required. No credit card. No catch.
      </p>

      {/* ── Dashboard mock ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-indigo-500/5">
        {/* Title bar */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">getorigin.io/me</div>
        </div>
        {/* Stat cards */}
        <div className="px-5 pt-5 pb-2">
          <div className="text-sm font-semibold text-gray-300 mb-3">My Dashboard</div>
          <div className="grid grid-cols-4 gap-3">
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2.5">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Sessions</div>
              <div className="text-xl font-bold text-gray-100 mt-0.5">247</div>
              <div className="text-[10px] text-green-400 mt-0.5">+12% vs last week</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2.5">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Tokens</div>
              <div className="text-xl font-bold text-gray-100 mt-0.5">4.2M</div>
              <div className="text-[10px] text-green-400 mt-0.5">+8% vs last week</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2.5">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Cost</div>
              <div className="text-xl font-bold text-gray-100 mt-0.5">$31.40</div>
              <div className="text-[10px] text-red-400 mt-0.5">+23% vs last week</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2.5">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider">Lines Written</div>
              <div className="text-xl font-bold text-gray-100 mt-0.5">8.1k</div>
              <div className="text-[10px] text-gray-500 mt-0.5">
                <span className="text-green-400">+8,142</span> / <span className="text-red-400">-3,201</span>
              </div>
            </div>
          </div>
        </div>
        {/* Agent cards */}
        <div className="px-5 py-3">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Agents</div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-[10px] text-purple-400">C</div>
                <span className="text-xs font-medium text-gray-200">Claude Code</span>
                <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400">active</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 text-[10px]">
                <div><span className="text-gray-500">Sessions</span> <span className="text-gray-300 ml-1">142</span></div>
                <div><span className="text-gray-500">Cost</span> <span className="text-gray-300 ml-1">$22.80</span></div>
              </div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-[10px] text-blue-400">Cu</div>
                <span className="text-xs font-medium text-gray-200">Cursor</span>
                <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400">active</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 text-[10px]">
                <div><span className="text-gray-500">Sessions</span> <span className="text-gray-300 ml-1">78</span></div>
                <div><span className="text-gray-500">Cost</span> <span className="text-gray-300 ml-1">$6.30</span></div>
              </div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded bg-yellow-500/15 border border-yellow-500/30 flex items-center justify-center text-[10px] text-yellow-400">G</div>
                <span className="text-xs font-medium text-gray-200">Gemini</span>
                <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">inactive</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 text-[10px]">
                <div><span className="text-gray-500">Sessions</span> <span className="text-gray-300 ml-1">27</span></div>
                <div><span className="text-gray-500">Cost</span> <span className="text-gray-300 ml-1">$2.30</span></div>
              </div>
            </div>
          </div>
        </div>
        {/* Heatmap mock */}
        <div className="px-5 pb-5 pt-1">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Activity</div>
          <div className="flex gap-[2px]">
            {Array.from({ length: 52 }).map((_, w) => (
              <div key={w} className="flex flex-col gap-[2px]">
                {Array.from({ length: 7 }).map((_, d) => {
                  const r = Math.random();
                  const c = r < 0.3 ? 'bg-gray-800/50' : r < 0.5 ? 'bg-indigo-900/60' : r < 0.7 ? 'bg-indigo-700/70' : r < 0.85 ? 'bg-indigo-600/80' : 'bg-indigo-500';
                  return <div key={d} className={`w-[8px] h-[8px] rounded-[1px] ${c}`} />;
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <h2>What Origin Solo tracks</h2>
      <p>
        Once you install the CLI and run <code>origin init</code>, every AI coding session is
        automatically recorded. No workflow changes, no manual logging. It hooks into the tools you
        already use:
      </p>
      <ul>
        <li><strong>Claude Code</strong> &mdash; full session tracking via hooks</li>
        <li><strong>Cursor</strong> &mdash; via rules injection</li>
        <li><strong>Gemini CLI</strong> &mdash; via hooks</li>
        <li><strong>Codex</strong> &mdash; via hooks</li>
        <li><strong>Copilot, Windsurf, Aider</strong> &mdash; coming soon</li>
      </ul>

      {/* ── Session tracking mock ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-indigo-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">getorigin.io/sessions</div>
        </div>
        <div className="p-4">
          <div className="text-sm font-semibold text-gray-300 mb-3">Recent Sessions</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="text-left pb-2 font-medium">Model</th>
                <th className="text-left pb-2 font-medium">Agent</th>
                <th className="text-left pb-2 font-medium">Repo</th>
                <th className="text-left pb-2 font-medium">Branch</th>
                <th className="text-right pb-2 font-medium">Duration</th>
                <th className="text-right pb-2 font-medium">Tokens</th>
                <th className="text-right pb-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              <tr>
                <td className="py-2"><span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 text-[10px]">claude-sonnet-4</span></td>
                <td className="py-2 text-gray-400">Claude Code</td>
                <td className="py-2 text-gray-400">origin-v2</td>
                <td className="py-2 text-gray-400 font-mono text-[10px]">feat/solo-mode</td>
                <td className="py-2 text-right text-gray-400">32m</td>
                <td className="py-2 text-right text-gray-400">142.3k</td>
                <td className="py-2 text-right text-gray-300">$1.82</td>
              </tr>
              <tr>
                <td className="py-2"><span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 text-[10px]">gemini-2.5-pro</span></td>
                <td className="py-2 text-gray-400">Gemini CLI</td>
                <td className="py-2 text-gray-400">my-app</td>
                <td className="py-2 text-gray-400 font-mono text-[10px]">fix/auth-bug</td>
                <td className="py-2 text-right text-gray-400">8m</td>
                <td className="py-2 text-right text-gray-400">34.1k</td>
                <td className="py-2 text-right text-gray-300">$0.12</td>
              </tr>
              <tr>
                <td className="py-2"><span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 text-[10px]">claude-sonnet-4</span></td>
                <td className="py-2 text-gray-400">Cursor</td>
                <td className="py-2 text-gray-400">origin-v2</td>
                <td className="py-2 text-gray-400 font-mono text-[10px]">main</td>
                <td className="py-2 text-right text-gray-400">15m</td>
                <td className="py-2 text-right text-gray-400">67.8k</td>
                <td className="py-2 text-right text-gray-300">$0.94</td>
              </tr>
              <tr>
                <td className="py-2"><span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 text-[10px]">gpt-4o</span></td>
                <td className="py-2 text-gray-400">Codex</td>
                <td className="py-2 text-gray-400">api-server</td>
                <td className="py-2 text-gray-400 font-mono text-[10px]">refactor/db</td>
                <td className="py-2 text-right text-gray-400">22m</td>
                <td className="py-2 text-right text-gray-400">89.2k</td>
                <td className="py-2 text-right text-gray-300">$0.67</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <h2>Your personal dashboard</h2>
      <p>
        The Solo dashboard is designed for one person: you. No team overhead, no admin panels, no
        approval workflows. Just your data.
      </p>
      <p>Here&rsquo;s what you get:</p>
      <ul>
        <li>
          <strong>Activity heatmap</strong> &mdash; GitHub-style contribution grid showing your AI
          coding activity over the past year
        </li>
        <li>
          <strong>Agent breakdown</strong> &mdash; see which AI tools you use most, with cost and
          session counts per agent
        </li>
        <li>
          <strong>Cost tracking</strong> &mdash; total spend across all models, broken down by model
          and repository
        </li>
        <li>
          <strong>Coding patterns</strong> &mdash; peak hours, average session duration, tokens per
          session
        </li>
        <li>
          <strong>Efficiency metrics</strong> &mdash; tokens per line of code, cost per commit, tool
          call breakdown
        </li>
        <li>
          <strong>Session timeline</strong> &mdash; visual timeline showing agent switches and
          cross-agent workflows
        </li>
        <li>
          <strong>Prompt explorer</strong> &mdash; search across all your prompts with full context
        </li>
      </ul>

      <h2>Insights that actually matter</h2>
      <p>
        The Insights page gives you charts you can act on &mdash; stripped of the team governance
        stuff you don&rsquo;t need:
      </p>

      {/* ── Insights mock ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-indigo-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">getorigin.io/insights</div>
        </div>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-sm font-semibold text-gray-300">Insights</div>
              <div className="text-[10px] text-gray-500">Your personal AI coding analytics</div>
            </div>
            <div className="flex gap-1">
              {['7d', '30d', '90d', 'Year'].map((l, i) => (
                <span key={l} className={`px-2 py-0.5 text-[10px] rounded ${i === 1 ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-500'}`}>{l}</span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {/* Cost by Model chart mock */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/30 p-3">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Cost by Model</div>
              <div className="space-y-2">
                {[
                  { model: 'claude-sonnet-4', cost: 22.80, pct: 72 },
                  { model: 'gpt-4o', cost: 4.20, pct: 13 },
                  { model: 'gemini-2.5-pro', cost: 3.10, pct: 10 },
                  { model: 'claude-haiku', cost: 1.30, pct: 5 },
                ].map((m) => (
                  <div key={m.model}>
                    <div className="flex items-center justify-between text-[10px] mb-0.5">
                      <span className="text-gray-400">{m.model}</span>
                      <span className="text-gray-300">${m.cost.toFixed(2)}</span>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-1.5">
                      <div className="h-1.5 rounded-full bg-purple-500/70" style={{ width: `${m.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* Sessions by Repo chart mock */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/30 p-3">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Sessions by Repository</div>
              <div className="space-y-2">
                {[
                  { repo: 'origin-v2', count: 98, pct: 85 },
                  { repo: 'my-app', count: 42, pct: 37 },
                  { repo: 'api-server', count: 31, pct: 27 },
                  { repo: 'dotfiles', count: 8, pct: 7 },
                ].map((r) => (
                  <div key={r.repo}>
                    <div className="flex items-center justify-between text-[10px] mb-0.5">
                      <span className="text-gray-400">{r.repo}</span>
                      <span className="text-gray-300">{r.count} sessions</span>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-1.5">
                      <div className="h-1.5 rounded-full bg-cyan-500/70" style={{ width: `${r.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* AI Authorship mock */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/30 p-3">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">AI Authorship % Over Time</div>
              <div className="flex items-end gap-[3px] h-16">
                {[32, 38, 41, 35, 44, 48, 52, 47, 55, 58, 54, 61, 63, 59, 65, 68, 64, 71, 67, 73, 70, 74, 72, 76].map((v, i) => (
                  <div key={i} className="flex-1 rounded-t bg-indigo-500/60" style={{ height: `${v}%` }} />
                ))}
              </div>
              <div className="flex justify-between text-[9px] text-gray-600 mt-1">
                <span>30d ago</span>
                <span>today</span>
              </div>
            </div>
            {/* Activity by Hour mock */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/30 p-3">
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Activity by Hour</div>
              <div className="flex items-end gap-[3px] h-16">
                {[2, 1, 0, 0, 1, 3, 8, 15, 24, 38, 45, 42, 28, 35, 48, 52, 44, 38, 22, 18, 12, 8, 5, 3].map((v, i) => (
                  <div key={i} className="flex-1 rounded-t bg-purple-500/60" style={{ height: `${(v / 52) * 100}%` }} />
                ))}
              </div>
              <div className="flex justify-between text-[9px] text-gray-600 mt-1">
                <span>12am</span>
                <span>12pm</span>
                <span>11pm</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <p>
        We intentionally removed team-only charts like &ldquo;Top Engineers,&rdquo; &ldquo;Cost by
        User,&rdquo; policy violations, and review status distributions. Solo developers don&rsquo;t
        need governance noise &mdash; they need signal.
      </p>

      <h2>CLI tools that work offline</h2>
      <p>
        Origin Solo isn&rsquo;t just a dashboard. The CLI gives you powerful local tools:
      </p>

      {/* ── Terminal mock: blame ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-indigo-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">Terminal &mdash; origin blame</div>
        </div>
        <div className="p-4 font-mono text-xs leading-relaxed overflow-x-auto">
          <div className="text-gray-500">$ origin blame src/auth.ts</div>
          <div className="mt-2 text-gray-400">
            <div><span className="text-purple-400">Claude Code</span> <span className="text-gray-600">│</span> <span className="text-gray-600">1</span>  <span className="text-blue-300">import</span> {'{'}jwt{'}'} <span className="text-blue-300">from</span> <span className="text-green-400">&apos;jsonwebtoken&apos;</span>;</div>
            <div><span className="text-purple-400">Claude Code</span> <span className="text-gray-600">│</span> <span className="text-gray-600">2</span>  <span className="text-blue-300">import</span> {'{'}hash{'}'} <span className="text-blue-300">from</span> <span className="text-green-400">&apos;bcrypt&apos;</span>;</div>
            <div><span className="text-gray-600">Human       </span> <span className="text-gray-600">│</span> <span className="text-gray-600">3</span></div>
            <div><span className="text-yellow-400">Cursor     </span> <span className="text-gray-600">│</span> <span className="text-gray-600">4</span>  <span className="text-blue-300">export async function</span> <span className="text-amber-300">verify</span>(token: string) {'{'}</div>
            <div><span className="text-yellow-400">Cursor     </span> <span className="text-gray-600">│</span> <span className="text-gray-600">5</span>    <span className="text-blue-300">const</span> decoded = jwt.verify(token, SECRET);</div>
            <div><span className="text-yellow-400">Cursor     </span> <span className="text-gray-600">│</span> <span className="text-gray-600">6</span>    <span className="text-blue-300">return</span> decoded;</div>
            <div><span className="text-yellow-400">Cursor     </span> <span className="text-gray-600">│</span> <span className="text-gray-600">7</span>  {'}'}</div>
            <div><span className="text-gray-600">Human       </span> <span className="text-gray-600">│</span> <span className="text-gray-600">8</span></div>
            <div><span className="text-purple-400">Claude Code</span> <span className="text-gray-600">│</span> <span className="text-gray-600">9</span>  <span className="text-blue-300">export async function</span> <span className="text-amber-300">login</span>(email, pass) {'{'}</div>
            <div><span className="text-purple-400">Claude Code</span> <span className="text-gray-600">│</span> <span className="text-gray-600">10</span>   <span className="text-blue-300">const</span> user = <span className="text-blue-300">await</span> db.findUser(email);</div>
            <div><span className="text-purple-400">Claude Code</span> <span className="text-gray-600">│</span> <span className="text-gray-600">11</span>   <span className="text-blue-300">if</span> (!user || !<span className="text-blue-300">await</span> hash.compare(pass, user.hash))</div>
            <div><span className="text-purple-400">Claude Code</span> <span className="text-gray-600">│</span> <span className="text-gray-600">12</span>     <span className="text-blue-300">throw new</span> <span className="text-amber-300">Error</span>(<span className="text-green-400">&apos;Invalid&apos;</span>);</div>
          </div>
          <div className="mt-3 text-gray-500 border-t border-gray-800 pt-2">
            AI authored: <span className="text-indigo-400">83%</span> &middot; Claude Code: <span className="text-purple-400">58%</span> &middot; Cursor: <span className="text-yellow-400">25%</span> &middot; Human: <span className="text-gray-400">17%</span>
          </div>
        </div>
      </div>

      {/* ── Terminal mock: rework ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-indigo-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">Terminal &mdash; origin rework</div>
        </div>
        <div className="p-4 font-mono text-xs leading-relaxed overflow-x-auto">
          <div className="text-gray-500">$ origin rework --days 7</div>
          <div className="mt-2">
            <div className="text-amber-400 mb-1">AI Churn Report (last 7 days)</div>
            <div className="text-gray-500 mb-2">Files where AI-generated code was rewritten:</div>
            <table className="w-full text-left">
              <thead>
                <tr className="text-gray-500">
                  <th className="pr-4 pb-1">File</th>
                  <th className="pr-4 pb-1 text-right">Reworks</th>
                  <th className="pr-4 pb-1 text-right">Churn</th>
                  <th className="pb-1">Agent</th>
                </tr>
              </thead>
              <tbody className="text-gray-400">
                <tr>
                  <td className="pr-4 py-0.5">src/api/routes.ts</td>
                  <td className="pr-4 py-0.5 text-right text-red-400">5</td>
                  <td className="pr-4 py-0.5 text-right text-red-400">42%</td>
                  <td className="py-0.5 text-purple-400">Claude Code</td>
                </tr>
                <tr>
                  <td className="pr-4 py-0.5">src/utils/parse.ts</td>
                  <td className="pr-4 py-0.5 text-right text-amber-400">3</td>
                  <td className="pr-4 py-0.5 text-right text-amber-400">28%</td>
                  <td className="py-0.5 text-yellow-400">Cursor</td>
                </tr>
                <tr>
                  <td className="pr-4 py-0.5">src/db/migrate.ts</td>
                  <td className="pr-4 py-0.5 text-right text-green-400">1</td>
                  <td className="pr-4 py-0.5 text-right text-green-400">8%</td>
                  <td className="py-0.5 text-purple-400">Claude Code</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <h2>Session bookmarks and search</h2>
      <p>
        Had a great debugging session with Claude that solved a gnarly race condition? Bookmark it.
        Tag it. Come back to it later when you hit a similar problem.
      </p>
      <p>
        Origin lets you bookmark any session, add custom tags, and filter your session history by
        agent, repo, branch, or status. Combined with prompt search, you can find that one prompt
        from three weeks ago that produced exactly the code pattern you need now.
      </p>

      <h2>Model comparison</h2>
      <p>
        One of the most useful features for solo developers: compare the actual cost and output of
        different AI models side by side. Not benchmarks &mdash; your real data.
      </p>

      {/* ── Model comparison mock ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-indigo-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">getorigin.io/settings?tab=models</div>
        </div>
        <div className="p-5">
          <div className="text-sm font-semibold text-gray-300 mb-3">Model Comparison</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="text-left pb-2 font-medium">Model</th>
                <th className="text-right pb-2 font-medium">Sessions</th>
                <th className="text-right pb-2 font-medium">Avg Cost</th>
                <th className="text-right pb-2 font-medium">Avg Tokens</th>
                <th className="text-right pb-2 font-medium">Avg Duration</th>
                <th className="text-right pb-2 font-medium">Lines/Session</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              <tr>
                <td className="py-2.5 text-gray-200 font-medium">claude-sonnet-4</td>
                <td className="py-2.5 text-right text-gray-400">142</td>
                <td className="py-2.5 text-right text-gray-300">$0.16</td>
                <td className="py-2.5 text-right text-gray-400">18.2k</td>
                <td className="py-2.5 text-right text-gray-400">28m</td>
                <td className="py-2.5 text-right"><span className="text-green-400">+84</span> / <span className="text-red-400">-32</span></td>
              </tr>
              <tr>
                <td className="py-2.5 text-gray-200 font-medium">gpt-4o</td>
                <td className="py-2.5 text-right text-gray-400">38</td>
                <td className="py-2.5 text-right text-gray-300">$0.11</td>
                <td className="py-2.5 text-right text-gray-400">12.4k</td>
                <td className="py-2.5 text-right text-gray-400">18m</td>
                <td className="py-2.5 text-right"><span className="text-green-400">+52</span> / <span className="text-red-400">-21</span></td>
              </tr>
              <tr>
                <td className="py-2.5 text-gray-200 font-medium">gemini-2.5-pro</td>
                <td className="py-2.5 text-right text-gray-400">27</td>
                <td className="py-2.5 text-right text-gray-300">$0.04</td>
                <td className="py-2.5 text-right text-gray-400">22.8k</td>
                <td className="py-2.5 text-right text-gray-400">12m</td>
                <td className="py-2.5 text-right"><span className="text-green-400">+61</span> / <span className="text-red-400">-18</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <h2>AI Review &mdash; score your own sessions</h2>
      <p>
        Solo doesn&rsquo;t include team review workflows (no Approve/Reject/Flag buttons &mdash;
        you don&rsquo;t need to approve your own code). But it does include <strong>AI Review</strong>:
        one-click automated scoring of any session.
      </p>

      {/* ── AI Review score mock ── */}
      <div className="rounded-xl border border-green-800/30 bg-green-900/10 overflow-hidden my-8">
        <div className="px-5 py-4 flex items-start gap-5">
          <div className="text-center flex-shrink-0">
            <div className="text-4xl font-bold text-green-400">87</div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">AI Score</div>
          </div>
          <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-2 min-w-0">
            {[
              { cat: 'Security', val: 92 },
              { cat: 'Scope', val: 85 },
              { cat: 'Quality', val: 88 },
              { cat: 'Cost', val: 83 },
            ].map((c) => (
              <div key={c.cat}>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs text-gray-400">{c.cat}</span>
                  <span className={`text-xs font-medium ${c.val >= 80 ? 'text-green-400' : 'text-amber-400'}`}>{c.val}</span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-1.5">
                  <div className={`h-1.5 rounded-full ${c.val >= 80 ? 'bg-green-500/70' : 'bg-amber-500/70'}`} style={{ width: `${c.val}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Suggestions</p>
            <ul className="space-y-0.5 text-xs text-gray-400">
              <li className="flex items-start gap-1.5"><span className="text-indigo-400 mt-0.5 flex-shrink-0">&rsaquo;</span> Consider adding input validation for user-provided tokens</li>
              <li className="flex items-start gap-1.5"><span className="text-indigo-400 mt-0.5 flex-shrink-0">&rsaquo;</span> Database query could use parameterized statements</li>
            </ul>
          </div>
        </div>
      </div>

      <p>
        Think of it as a second pair of eyes when you&rsquo;re working alone.
      </p>

      <h2>Multi-account: Solo + Team</h2>
      <p>
        If you work on personal projects <em>and</em> contribute to a team that uses Origin, you can
        connect both accounts. Your personal repos go to your Solo dashboard. Team repos get
        duplicated to the team dashboard automatically.
      </p>
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 my-6 space-y-2">
        <code className="text-emerald-400 block">origin login --profile dev</code>
        <code className="text-emerald-400 block">origin login --profile team</code>
        <code className="text-emerald-400 block">origin profiles</code>
        <div className="text-gray-400 text-sm mt-2">
          Sessions from team-scoped repos appear in both dashboards. Personal repos stay in Solo only.
        </div>
      </div>

      <h2>Setup in 30 seconds</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 my-6 space-y-2">
        <code className="text-emerald-400 block">npm i -g origin-cli</code>
        <code className="text-emerald-400 block">origin login</code>
        <code className="text-emerald-400 block">origin init</code>
        <div className="text-gray-400 text-sm mt-2">
          That&rsquo;s it. <code>origin init</code> auto-detects your AI tools and configures hooks.
          Start a coding session with any supported agent and it shows up in your dashboard.
        </div>
      </div>

      <h2>Free forever. No limits.</h2>
      <p>
        Origin Solo is free. Not &ldquo;free trial&rdquo; or &ldquo;free with limits.&rdquo; Free
        forever. Unlimited repos, unlimited sessions, unlimited agents. We make money from
        Origin Team ($29/user/month) which adds governance, policies, PR checks, and team
        management.
      </p>
      <p>
        Solo developers shouldn&rsquo;t have to pay to understand their own AI usage. The data is
        yours. The insights are yours. The cost savings you discover are yours.
      </p>

      <h2>What&rsquo;s next</h2>
      <p>
        We&rsquo;re working on a few things specifically for Solo users:
      </p>
      <ul>
        <li>Cost optimization suggestions &mdash; recommending cheaper models when quality is equivalent</li>
        <li>Prompt templates &mdash; save and reuse effective prompts across sessions</li>
        <li>More agent integrations &mdash; Windsurf, Aider, Copilot</li>
      </ul>
      <p>
        If you use AI coding tools every day, Origin Solo gives you the visibility you&rsquo;ve been
        missing. Install it, forget about it, and check your dashboard in a week. You&rsquo;ll be
        surprised by what you find.
      </p>
      <div className="bg-gray-900 border border-emerald-500/30 rounded-lg p-6 my-8 text-center">
        <div className="text-lg font-semibold text-gray-200 mb-2">Get started with Origin Solo</div>
        <code className="text-emerald-400 text-lg">npm i -g origin-cli && origin login</code>
        <div className="text-gray-500 text-sm mt-3">
          Free forever &middot; No credit card &middot; Works with Claude, Cursor, Gemini, Codex
        </div>
      </div>
    </>
  ),

  'shadow-ai-engineering-blind-spot': (
    <>
      <p>
        Here&rsquo;s a question most engineering leaders can&rsquo;t answer: how many of your
        developers are using AI coding tools right now, and which ones?
      </p>
      <p>
        If you don&rsquo;t know, you&rsquo;re not alone. According to GitHub&rsquo;s 2025 developer
        survey, 92% of developers use AI coding tools at work. But in most organizations, fewer than
        half of those tools have been formally approved by IT or security. The rest? That&rsquo;s
        shadow AI.
      </p>

      <h2>What shadow AI actually looks like</h2>
      <p>
        Shadow AI isn&rsquo;t developers acting maliciously. It&rsquo;s a senior engineer installing
        Claude Code on their laptop because it makes them 3x faster. It&rsquo;s a contractor using
        Cursor on a client project without telling anyone. It&rsquo;s a junior dev pasting proprietary
        code into ChatGPT to debug a tricky issue.
      </p>
      <p>
        The tools themselves are powerful and legitimate. The problem is that nobody in the
        organization knows they&rsquo;re being used, what data they&rsquo;re accessing, or what code
        they&rsquo;re producing.
      </p>
      <p>This creates three categories of risk:</p>

      <h2>1. Security risk: data you can&rsquo;t see leaving</h2>
      <p>
        AI coding agents read your codebase to generate useful output. That means they see
        environment variables, API keys, database connection strings, and internal business logic.
        Some tools send this context to cloud APIs. Some cache it locally. Some do both.
      </p>
      <p>
        Without visibility into which tools are running and what files they access, you have no way
        to know if secrets or PII are being exposed. A developer might accidentally paste a
        production database URL into a prompt. An AI agent might read <code>.env</code> files to
        understand configuration. You&rsquo;d never know.
      </p>
      <div className="bg-gray-900 border border-red-500/30 rounded-lg p-4 my-6">
        <div className="text-red-400 font-medium text-sm mb-2">Real-world scenario</div>
        <div className="text-gray-400 text-sm">
          Developer uses an unapproved AI tool to refactor an auth module. The tool reads
          <code className="mx-1">src/config/secrets.ts</code> for context. The file contains
          hardcoded API keys from a third-party vendor. Those keys are now in the tool&rsquo;s
          context window &mdash; and potentially in its training data, depending on the provider&rsquo;s
          data retention policy.
        </div>
      </div>

      <h2>2. Compliance risk: audit gaps you can&rsquo;t explain</h2>
      <p>
        SOC 2 Type II requires you to demonstrate that you control access to systems that process
        customer data. If an AI coding tool accesses your codebase and you don&rsquo;t have a record
        of it, that&rsquo;s a gap. Your auditor will ask who approved it, what data it accessed, and
        what controls are in place. If the answer is &ldquo;we didn&rsquo;t know it was being
        used,&rdquo; that&rsquo;s a finding.
      </p>
      <p>
        The same applies to GDPR, HIPAA, and any framework that requires data processing records.
        AI tools that touch code containing PII or health data need to be documented and governed.
        Shadow AI makes that impossible.
      </p>

      <h2>3. Quality risk: code nobody reviewed properly</h2>
      <p>
        AI-generated code looks correct. It passes linting. It often passes tests. But it can
        contain subtle bugs, security vulnerabilities, and patterns that don&rsquo;t match your
        team&rsquo;s architecture. When AI-generated code enters your codebase without anyone knowing
        it was AI-generated, reviewers apply the wrong level of scrutiny.
      </p>
      <p>
        A human-written function gets a quick review. An AI-generated function that looks
        human-written gets the same quick review &mdash; but it should get a closer look, because
        AI models hallucinate edge cases, use deprecated APIs, and sometimes introduce security
        flaws that a human wouldn&rsquo;t.
      </p>

      <h2>Why banning AI tools doesn&rsquo;t work</h2>
      <p>
        Some organizations respond to shadow AI by banning AI coding tools outright. This doesn&rsquo;t
        work for two reasons.
      </p>
      <p>
        First, developers will use them anyway. The productivity gain is too significant to ignore.
        A developer who can write a feature in 2 hours instead of 8 isn&rsquo;t going to stop because
        of a policy document they saw once during onboarding.
      </p>
      <p>
        Second, banning AI tools puts your organization at a competitive disadvantage. Teams that
        use AI effectively ship faster. If your competitors let their developers use these tools
        (with proper governance), they&rsquo;ll outpace you.
      </p>
      <p>
        The answer isn&rsquo;t prohibition. It&rsquo;s visibility and control.
      </p>

      <h2>What visibility actually requires</h2>
      <p>
        To govern AI coding tools, you need four things:
      </p>
      <div className="space-y-4 my-6">
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-sm font-medium text-indigo-400">1</div>
          <div>
            <div className="font-medium text-gray-200">Detection</div>
            <div className="text-sm text-gray-400">Know which AI tools are being used, by whom, and on which repositories.</div>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-sm font-medium text-indigo-400">2</div>
          <div>
            <div className="font-medium text-gray-200">Attribution</div>
            <div className="text-sm text-gray-400">Know which lines of code were AI-generated, which model wrote them, and what prompt produced them.</div>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-sm font-medium text-indigo-400">3</div>
          <div>
            <div className="font-medium text-gray-200">Policy enforcement</div>
            <div className="text-sm text-gray-400">Define rules about which files AI can access, which patterns are blocked, and what requires human review.</div>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-sm font-medium text-indigo-400">4</div>
          <div>
            <div className="font-medium text-gray-200">Audit trail</div>
            <div className="text-sm text-gray-400">Maintain a complete record of every AI session for compliance reporting and incident investigation.</div>
          </div>
        </div>
      </div>

      <h2>How Origin solves this</h2>
      <p>
        Origin is an open-source CLI that sits between AI coding tools and your codebase. It works
        with Claude Code, Cursor, Codex, and Gemini &mdash; no changes to developer workflows
        required. Developers keep using the tools they prefer. Origin records everything.
      </p>
      <p>
        Every AI session is logged: which tool, which model, what files were read, what code was
        generated, what prompts were used. This data feeds into the Origin dashboard, where
        engineering leads and security teams get a complete picture of AI activity across the
        organization.
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden my-6">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-green-500/80" />
          <span className="text-xs text-gray-500 ml-2 font-mono">Origin Dashboard &mdash; AI Activity</span>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between bg-gray-800/50 rounded-lg p-3">
            <div>
              <div className="text-sm font-medium text-gray-200">Active AI tools detected</div>
              <div className="text-xs text-gray-500">Claude Code, Cursor, Copilot</div>
            </div>
            <span className="text-lg font-mono text-indigo-400">3</span>
          </div>
          <div className="flex items-center justify-between bg-gray-800/50 rounded-lg p-3">
            <div>
              <div className="text-sm font-medium text-gray-200">AI sessions this week</div>
              <div className="text-xs text-gray-500">Across 12 developers, 8 repositories</div>
            </div>
            <span className="text-lg font-mono text-indigo-400">247</span>
          </div>
          <div className="flex items-center justify-between bg-gray-800/50 rounded-lg p-3">
            <div>
              <div className="text-sm font-medium text-gray-200">Policy violations caught</div>
              <div className="text-xs text-gray-500">2 secret exposures, 1 restricted file access</div>
            </div>
            <span className="text-lg font-mono text-red-400">3</span>
          </div>
        </div>
      </div>
      <p>
        Policies let you define guardrails without blocking productivity. Restrict AI access to
        sensitive directories. Block commits containing secrets patterns. Require human review on
        AI-generated changes to critical files. Policies are enforced at the agent level &mdash; the
        AI tool itself respects the rules.
      </p>

      <h2>5 steps to take this week</h2>
      <p>
        Whether you use Origin or not, here&rsquo;s what you should do to address shadow AI risk:
      </p>
      <div className="space-y-3 my-6">
        <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
          <div className="font-medium text-gray-200 text-sm">1. Survey your team</div>
          <div className="text-sm text-gray-400 mt-1">
            Ask every developer what AI tools they use. Don&rsquo;t make it punitive &mdash; make it
            a census. You&rsquo;ll be surprised by the results.
          </div>
        </div>
        <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
          <div className="font-medium text-gray-200 text-sm">2. Create an approved tools list</div>
          <div className="text-sm text-gray-400 mt-1">
            Evaluate the tools your team is already using. Approve the ones that meet your security
            requirements. Give developers a clear list of what&rsquo;s allowed.
          </div>
        </div>
        <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
          <div className="font-medium text-gray-200 text-sm">3. Define sensitive boundaries</div>
          <div className="text-sm text-gray-400 mt-1">
            Identify which files, directories, and data types should never be exposed to AI tools.
            At minimum: <code>.env</code> files, secrets, PII, and auth modules.
          </div>
        </div>
        <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
          <div className="font-medium text-gray-200 text-sm">4. Add AI attribution to code review</div>
          <div className="text-sm text-gray-400 mt-1">
            Require developers to flag AI-generated code in PRs. Better yet, use tooling that does
            this automatically so the process isn&rsquo;t dependent on self-reporting.
          </div>
        </div>
        <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
          <div className="font-medium text-gray-200 text-sm">5. Instrument and monitor</div>
          <div className="text-sm text-gray-400 mt-1">
            Deploy tooling that gives you continuous visibility into AI tool usage. Surveys are a
            starting point, but automated detection is the only way to stay current.
          </div>
        </div>
      </div>

      <h2>The bottom line</h2>
      <p>
        Shadow AI isn&rsquo;t going away. The tools are too useful, and developers will keep
        adopting them whether you approve them or not. The question isn&rsquo;t whether your team
        uses AI coding tools &mdash; it&rsquo;s whether you have visibility into how they&rsquo;re
        being used.
      </p>
      <p>
        Organizations that get this right will ship faster and more securely. Organizations that
        ignore it will discover the problem during an audit, a security incident, or a production
        outage caused by code nobody understood.
      </p>

      <h2>Get started with Origin</h2>
      <div className="bg-gray-900 border border-indigo-500/30 rounded-lg p-6 my-6">
        <div className="font-mono text-sm mb-2">
          <span className="text-gray-500">$</span> npm i -g https://getorigin.io/cli/origin-cli-latest.tgz
        </div>
        <div className="font-mono text-sm mb-4">
          <span className="text-gray-500">$</span> origin init
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Origin starts recording AI sessions immediately. Connect the dashboard to see activity
          across your team.
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
    </>
  ),
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
      <Helmet>
        <title>{post.title} — Origin Blog</title>
        <meta name="description" content={post.excerpt} />
        <link rel="canonical" href={`https://getorigin.io/blog/${slug}`} />
        <meta property="og:title" content={`${post.title} — Origin Blog`} />
        <meta property="og:description" content={post.excerpt} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={`https://getorigin.io/blog/${slug}`} />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: post.title,
            description: post.excerpt,
            author: { '@type': 'Person', name: post.author },
            datePublished: post.date,
            publisher: { '@type': 'Organization', name: 'Origin' },
          })}
        </script>
      </Helmet>
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
