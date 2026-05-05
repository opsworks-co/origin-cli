import React from 'react';
import { Helmet } from 'react-helmet-async';
import { useParams, Link, Navigate } from 'react-router-dom';
import { blogPosts } from '../data/blogPosts';

/* ------------------------------------------------------------------ */
/*  Blog post content keyed by slug                                    */
/* ------------------------------------------------------------------ */

const postContent: Record<string, React.ReactNode> = {
  'spend-quality-roi-dashboard': (
    <>
      <p>
        Here&rsquo;s the question I keep getting from heads of engineering: &ldquo;Our AI bill is up 4&times; year-over-year. Is that a problem, or is the team shipping 4&times; the work?&rdquo;
      </p>
      <p>
        It&rsquo;s a fair question, and the cost dashboards we&rsquo;ve all been building &mdash; ours included &mdash; mostly fail to answer it. They&rsquo;re very good at telling you the bill. Per-model, per-engineer, per-day, sliced however you like. None of them tell you whether the bill bought working code or got rolled back the next day.
      </p>
      <p className="text-gray-100 font-medium">
        So this week we shipped <strong>Spend Quality</strong> &mdash; six lenses on the same dataset, all aimed at one question: <em>are we getting our money&rsquo;s worth?</em>
      </p>

      <h2>The bill answers the wrong question</h2>

      <p>
        Every cost dashboard out there is built on the same axis: dollars, broken down by some dimension. Origin shipped that 18 months ago. So did everyone else. It&rsquo;s the easy half of the problem.
      </p>

      {/* Cost vs Quality side-by-side card */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-6 shadow-2xl">
          <p className="text-[10px] uppercase tracking-[0.12em] text-gray-500 font-semibold mb-4">
            Two questions, two dashboards
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">Cost dashboard</div>
              <p className="text-sm text-gray-200 mb-3">&ldquo;How much did we spend?&rdquo;</p>
              <ul className="text-[11px] text-gray-500 space-y-1">
                <li>&middot; Total: <span className="text-gray-300 font-mono">$8,412</span></li>
                <li>&middot; By engineer, by model, by repo</li>
                <li>&middot; Daily / weekly / monthly</li>
                <li>&middot; Caps + alerts</li>
              </ul>
            </div>
            <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/[0.06] p-4">
              <div className="text-[10px] uppercase tracking-wider text-indigo-300 font-semibold mb-2">Spend Quality</div>
              <p className="text-sm text-gray-50 mb-3">&ldquo;What did we get for it?&rdquo;</p>
              <ul className="text-[11px] text-gray-300 space-y-1">
                <li>&middot; Rework rate per dev</li>
                <li>&middot; $ per merged PR</li>
                <li>&middot; Sessions that burned the most for the least</li>
                <li>&middot; Where Haiku would have done it</li>
                <li>&middot; When the spend actually happens</li>
                <li>&middot; Cache-hit ratio (sessions that pay 10&times; for nothing new)</li>
              </ul>
            </div>
          </div>
          <p className="mt-4 text-[11px] text-gray-500 text-center">
            One tells you the bill. The other tells you whether the bill paid for itself.
          </p>
        </div>
      </div>

      <p>
        Spend Quality lives at <Link to="/insights/spend-quality" className="text-indigo-400 hover:text-indigo-300"><code>/insights/spend-quality</code></Link>. Six sections. Date-range picker at the top &mdash; <code>7d</code> / <code>30d</code> / <code>90d</code> &mdash; serialised to the URL so a refresh or a Slack-share preserves state.
      </p>

      <h2>Section 1: who&rsquo;s burning budget without shipping?</h2>

      <p>
        The first row, full width, is a per-developer table. Same dollar column you&rsquo;ve seen everywhere &mdash; but to its right, four columns nobody else surfaces:
      </p>

      {/* Spend quality table mockup */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-semibold text-gray-100">Spend Quality</p>
              <p className="text-[11px] text-gray-500">per developer &middot; last 30 days</p>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-gray-500">8 devs</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
                  <th className="py-2 pr-4 font-normal">Dev</th>
                  <th className="py-2 pr-4 font-normal text-right">$ spent</th>
                  <th className="py-2 pr-4 font-normal text-right">AI %</th>
                  <th className="py-2 pr-4 font-normal text-right">Rework</th>
                  <th className="py-2 pr-4 font-normal text-right">$/PR</th>
                  <th className="py-2 font-normal text-right">Sessions</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: 'Sarah K.',   spend: 412.80, ai: 78, rework: 3.1,  costPr: 18.74, sess: 64,  reworkTone: 'text-emerald-400' },
                  { name: 'Marcus T.',  spend: 387.40, ai: 91, rework: 18.4, costPr: 96.85, sess: 52,  reworkTone: 'text-red-400'    },
                  { name: 'Priya S.',   spend: 286.50, ai: 64, rework: 4.7,  costPr: 22.04, sess: 41,  reworkTone: 'text-emerald-400' },
                  { name: 'Devon R.',   spend: 241.10, ai: 82, rework: 11.9, costPr: 80.37, sess: 38,  reworkTone: 'text-amber-400'  },
                  { name: 'Helena M.',  spend: 198.30, ai: 71, rework: 5.2,  costPr: 28.33, sess: 33,  reworkTone: 'text-emerald-400' },
                  { name: 'Ben C.',     spend: 167.90, ai: 88, rework: 6.8,  costPr: 33.58, sess: 28,  reworkTone: 'text-emerald-400' },
                ].map((r) => (
                  <tr key={r.name} className="border-b border-gray-800/60">
                    <td className="py-2.5 pr-4 text-gray-200">{r.name}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-gray-200">${r.spend.toFixed(2)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-gray-300">{r.ai}%</td>
                    <td className={`py-2.5 pr-4 text-right tabular-nums ${r.reworkTone}`}>{r.rework.toFixed(1)}%</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-gray-300">${r.costPr.toFixed(2)}</td>
                    <td className="py-2.5 text-right tabular-nums text-gray-400">{r.sess}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-gray-500">
            Click any column to sort. Rework &gt; 15% turns red, &gt; 7% amber. Marcus spent the same as Sarah and produced PRs at 5&times; the rebuild cost.
          </p>
        </div>
      </div>

      <p>
        The single most useful column on this table is <strong>rework rate</strong> &mdash; the percentage of files this developer&rsquo;s AI sessions touched that got rewritten within the next 14 days. High rework means the AI was &ldquo;productive&rdquo; on a Tuesday and someone (often the same dev) was undoing it on Thursday. <strong>$/merged-PR</strong> is the next one: total spend divided by PRs that actually shipped, which is the closest thing to a unit economics number for AI coding.
      </p>
      <p>
        Marcus in the table above &mdash; same monthly spend as Sarah, 6&times; the rework, 5&times; the cost per shipped PR. That&rsquo;s the conversation Spend Quality wants you to be able to have. With numbers, on the same screen.
      </p>

      <h2>Section 2: the outliers, before they show up on the invoice</h2>

      <p>
        Below the table is a ranked list of the most expensive sessions in the period &mdash; with two flag chips that catch the worst patterns:
      </p>

      {/* Top expensive sessions mockup */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-semibold text-gray-100">Top expensive sessions</p>
              <p className="text-[11px] text-gray-500">ranked by cost &middot; flags surface zero-output and outlier-cost runs</p>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-gray-500">show 10</span>
          </div>
          <ul className="divide-y divide-gray-800/60">
            {[
              { rank: 1, who: 'Marcus T.',  dur: '2h 14m', cost: 84.20, prompts: 41, branch: 'feature/checkout-v3', flags: ['cost-outlier'] },
              { rank: 2, who: 'Devon R.',   dur: '1h 38m', cost: 71.60, prompts: 22, branch: 'fix/audit-log',       flags: ['zero-commit'] },
              { rank: 3, who: 'Marcus T.',  dur: '1h 52m', cost: 64.10, prompts: 35, branch: 'feature/checkout-v3', flags: ['cost-outlier'] },
              { rank: 4, who: 'Sarah K.',   dur: '1h 04m', cost: 41.80, prompts: 18, branch: 'main',                 flags: [] },
              { rank: 5, who: 'Devon R.',   dur: '0h 47m', cost: 38.40, prompts: 12, branch: 'fix/audit-log',       flags: ['zero-commit'] },
              { rank: 6, who: 'Priya S.',   dur: '1h 12m', cost: 32.70, prompts: 24, branch: 'feature/sso',          flags: [] },
            ].map((s) => (
              <li key={s.rank} className="py-2.5 flex items-center gap-3">
                <span className="text-xs text-gray-500 w-8 tabular-nums">#{s.rank}</span>
                <span className="flex-1 text-sm text-gray-200 truncate">
                  {s.who} &middot; {s.dur} &middot; <span className="tabular-nums">${s.cost.toFixed(2)}</span> &middot; {s.prompts} prompts
                  <span className="text-gray-500"> &middot; {s.branch}</span>
                </span>
                {s.flags.includes('zero-commit') && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/40 text-red-300">&#9888; 0 commits</span>
                )}
                {s.flags.includes('cost-outlier') && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">&#9888; outlier</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-gray-500">
            <span className="text-red-300">0 commits</span> &mdash; session ended without producing a real commit. Money paid, nothing shipped.{' '}
            <span className="text-amber-300">outlier</span> &mdash; cost &gt; 2&times; this dev&rsquo;s typical session. Worth a conversation.
          </p>
        </div>
      </div>

      <p>
        The <code>zero-commit</code> flag is the one that pays for the whole feature on its own. A two-hour session that burned $71 and produced no commit is a session somebody is going to redo from scratch tomorrow &mdash; and now they have a chance to figure out what went sideways before they do.
      </p>

      <h2>Section 3: where Haiku would have done it</h2>

      <p>
        On the left of the next row, Spend Quality flags sessions where the model the engineer reached for was meaningfully overpowered for the work that actually happened. Two patterns trigger it:
      </p>
      <ul>
        <li><strong>Oversized for cheap task</strong> &mdash; flagship model, &lt; 4 prompts, no complex tool use. Haiku would have produced the same output at ~5% of the cost.</li>
        <li><strong>Undersized for long session</strong> &mdash; cheap model running 40+ prompts on what looks like architecture work. The engineer is fighting the model; a one-tier upgrade probably ends the session in half the prompts.</li>
      </ul>

      {/* Model-fit warnings mockup */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-semibold text-gray-100">Model-fit warnings</p>
              <p className="text-[11px] text-gray-500">suggested savings &middot; last 30 days</p>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-emerald-400 font-mono">~$184 / mo</span>
          </div>
          <ul className="divide-y divide-gray-800/60">
            {[
              { who: 'Marcus T.',  used: 'claude-opus-4-7',   suggest: 'claude-haiku-4-5',  reason: 'Haiku may have sufficed', save: 38.20 },
              { who: 'Sarah K.',   used: 'claude-opus-4-7',   suggest: 'claude-sonnet-4-6', reason: 'Haiku may have sufficed', save: 28.40 },
              { who: 'Devon R.',   used: 'claude-opus-4-7',   suggest: 'claude-haiku-4-5',  reason: 'Haiku may have sufficed', save: 24.10 },
              { who: 'Marcus T.',  used: 'claude-haiku-4-5',  suggest: 'claude-sonnet-4-6', reason: 'Consider scope reduction', save: 11.80 },
              { who: 'Priya S.',   used: 'claude-opus-4-7',   suggest: 'claude-haiku-4-5',  reason: 'Haiku may have sufficed', save: 8.60 },
            ].map((w, i) => (
              <li key={i} className="py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-300 truncate">
                    <span className="text-gray-400">{w.who}</span> &middot; <span className="font-mono">{w.used}</span>
                  </p>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {w.reason} &rarr; <span className="text-gray-300 font-mono">{w.suggest}</span>
                  </p>
                </div>
                <span className="text-xs tabular-nums text-emerald-400">~${w.save.toFixed(2)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-gray-500">
            Conservative pricing assumptions. The savings number is the floor, not the ceiling.
          </p>
        </div>
      </div>

      <p>
        The page surfaces the savings in dollars at the top right &mdash; <span className="text-emerald-400 font-mono">~$184/mo</span> in the example above. That&rsquo;s the <em>opportunity</em> cost, not a refund. But it&rsquo;s the kind of number that turns into a Tuesday standup conversation: &ldquo;hey team, we&rsquo;re leaving $180 a month on the table by reaching for Opus on tasks Sonnet would&rsquo;ve handled.&rdquo;
      </p>

      <h2>Section 4: spend has a clock</h2>

      <p>
        On the right of the same row is a 7&times;24 heatmap &mdash; cost summed by day-of-week and hour-of-day across the period:
      </p>

      {/* Heatmap mockup */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-semibold text-gray-100">Time-of-spend heatmap</p>
              <p className="text-[11px] text-gray-500">day &times; hour &middot; click any cell to filter sessions</p>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-gray-500">UTC</span>
          </div>
          <div className="overflow-x-auto">
            <table className="text-[10px] border-separate border-spacing-0.5">
              <thead>
                <tr>
                  <th className="w-8"></th>
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} className="text-gray-600 font-normal w-3.5 text-center">{h % 6 === 0 ? h : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { day: 'Sun', vals: [0,0,0.7,0.4,0,0,0,0,0,0.1,0.1,0.2,0.3,0.5,0.4,0.2,0.1,0,0,0,0.1,0.3,0.6,0.4] },
                  { day: 'Mon', vals: [0,0,0,0,0,0,0,0,0.5,0.8,0.9,0.95,1.0,0.7,0.85,0.9,0.6,0.5,0.2,0.1,0,0,0,0] },
                  { day: 'Tue', vals: [0,0,0,0,0,0,0,0,0.6,0.85,0.95,1.0,0.95,0.6,0.8,0.9,0.7,0.4,0.1,0,0,0,0,0] },
                  { day: 'Wed', vals: [0,0,0,0,0,0,0,0,0.5,0.8,0.85,0.95,0.9,0.65,0.85,0.95,0.65,0.5,0.2,0,0,0,0,0] },
                  { day: 'Thu', vals: [0,0,0,0,0,0,0,0,0.55,0.8,0.9,0.85,0.85,0.7,0.85,0.9,0.55,0.4,0.1,0,0,0,0,0] },
                  { day: 'Fri', vals: [0,0,0,0,0,0,0,0,0.45,0.7,0.75,0.8,0.7,0.5,0.6,0.4,0.2,0.1,0,0,0,0,0,0] },
                  { day: 'Sat', vals: [0,0,0,0,0,0,0,0,0.05,0.1,0.15,0.1,0.05,0,0.05,0.1,0,0,0,0,0,0,0,0] },
                ].map((row) => (
                  <tr key={row.day}>
                    <td className="text-gray-500 pr-2">{row.day}</td>
                    {row.vals.map((v, h) => (
                      <td key={h}>
                        <div
                          className="w-3.5 h-3.5 rounded-sm"
                          style={{ background: v > 0 ? `rgba(99,102,241,${0.1 + v * 0.7})` : 'rgba(75,85,99,0.15)' }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-gray-500">
            Working hours light up. The Sunday 02:00 cell is the sound of someone unblocking themselves at 2 AM &mdash; a Monday-morning conversation that didn&rsquo;t happen.
          </p>
        </div>
      </div>

      <p>
        Heatmaps look decorative until they aren&rsquo;t. The Sunday 2 AM cell that lights up every week is the one that tells you somebody&rsquo;s on-call duty has been quietly absorbed by Claude Code. The Friday afternoon dropoff at 14:00 instead of 17:00 is the team protecting deploy-Friday discipline. Click any cell &mdash; the page filters the rest of the data to that hour-of-week.
      </p>

      <h2>Section 5 + 6: the cache-hit ratio that nobody&rsquo;s watching</h2>

      <p>
        The bottom row pairs a <strong>wasted prompts</strong> panel (prompts that triggered a session-restore &mdash; in flight; lights up when the CLI ships the metric) with a token-mix breakdown:
      </p>

      {/* Token mix mockup */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-semibold text-gray-100">Token breakdown</p>
              <p className="text-[11px] text-gray-500">generated vs cache-read vs cache-write &middot; last 30 days</p>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-emerald-400 font-mono">cache hit 62%</span>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="rounded border border-gray-800 bg-gray-900/40 p-3">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Generated</p>
              <p className="text-lg font-mono text-gray-100">144M</p>
              <p className="text-[10px] text-gray-600">input + output (full price)</p>
            </div>
            <div className="rounded border border-cyan-500/30 bg-cyan-500/5 p-3">
              <p className="text-[10px] uppercase tracking-wider text-cyan-400 mb-1">Cache reads</p>
              <p className="text-lg font-mono text-cyan-300">238M</p>
              <p className="text-[10px] text-gray-600">~10% of input pricing</p>
            </div>
            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-[10px] uppercase tracking-wider text-amber-400 mb-1">Cache writes</p>
              <p className="text-lg font-mono text-amber-300">29M</p>
              <p className="text-[10px] text-gray-600">~125% of input pricing</p>
            </div>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden bg-gray-800">
            <div className="bg-indigo-500/80" style={{ width: '35%' }} />
            <div className="bg-cyan-500/70" style={{ width: '58%' }} />
            <div className="bg-amber-500/60" style={{ width: '7%' }} />
          </div>
          <p className="mt-3 text-[11px] text-gray-500">
            Cache-hit ratio under 30% is usually a misconfigured agent &mdash; the prompt prefix isn&rsquo;t stable session-to-session, so every turn re-reads the world. Sessions flagged as <span className="text-amber-300">cache outliers</span> in the breakdown almost always trace to one engineer&rsquo;s setup.
          </p>
        </div>
      </div>

      <p>
        The cache-hit ratio is the most under-watched number in AI coding cost. A team running at 60%+ cache reads is paying ~10% of list price for the bulk of their tokens. A team running at 15% is paying full freight, and almost nobody knows that&rsquo;s why their bill is 4&times; their peers&rsquo;. The token breakdown panel surfaces it on the same page as everything else &mdash; one fewer dashboard to context-switch into.
      </p>

      <h2>What you do with this</h2>

      <p>
        Spend Quality isn&rsquo;t a wall of metrics for its own sake. Each section is built around a specific intervention an engineering manager can make on a Tuesday:
      </p>

      <div className="not-prose my-8 rounded-xl border border-gray-800 bg-[#0a0b14] p-6 shadow-2xl space-y-3">
        {[
          { metric: 'Rework rate &gt; 15%', do: 'One-on-one with the dev. Their AI is confidently wrong and they\'re not catching it in review.' },
          { metric: '$/PR is a 3&times; outlier', do: 'Likely a model-fit problem. Suggest they try the next tier down for the same tasks.' },
          { metric: 'Top expensive session has 0 commits', do: 'Open it. Read the transcript. The session got stuck — figure out where.' },
          { metric: 'Model-fit warnings &gt; $100/mo', do: 'Set per-engineer Opus caps. Cheap models become first-choice within a week.' },
          { metric: 'Heatmap shows Saturday/Sunday spend', do: 'On-call has quietly become "AI coding on weekends." Investigate.' },
          { metric: 'Cache hit % &lt; 30%', do: 'The CLI prompt prefix is unstable. Check the agent\'s system prompt — usually one engineer\'s misconfig.' },
        ].map((row, i) => (
          <div key={i} className="flex items-start gap-3">
            <span className="text-[10px] text-indigo-400 font-mono mt-0.5">{String(i + 1).padStart(2, '0')}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-100" dangerouslySetInnerHTML={{ __html: row.metric }} />
              <p className="text-[11px] text-gray-500 mt-0.5">{row.do}</p>
            </div>
          </div>
        ))}
      </div>

      <h2>How to turn it on</h2>

      <p>
        Open <Link to="/insights/spend-quality" className="text-indigo-400 hover:text-indigo-300">Insights &rarr; Spend Quality</Link>. Defaults work for most teams &mdash; rework rate alarms at 7% / 15%, model-fit detection runs on the same data the budget enforcer already uses, no extra capture needed.
      </p>
      <p>
        Two things you&rsquo;ll probably want to tune:
      </p>
      <ul>
        <li><strong>Rework window.</strong> Default is 14 days. Teams that ship slower bump it to 30; teams that ship multiple times a day drop it to 7.</li>
        <li><strong>Model-fit thresholds.</strong> Default flags anything with &lt; 4 prompts on a flagship model. Adjustable per-org under <Link to="/settings" className="text-indigo-400 hover:text-indigo-300">Settings</Link>.</li>
      </ul>
      <p>
        Everything else is automatic. Sessions are already being captured at the prompt level by the CLI; Spend Quality is just six new ways of asking the dataset what it knows.
      </p>
      <p>
        For 18 months the answer to &ldquo;is the AI bill worth it?&rdquo; has been &ldquo;hard to say.&rdquo; That&rsquo;s the easy answer. It&rsquo;s the wrong answer to give a CFO. Spend Quality is the dashboard that lets you give the right one.
      </p>
    </>
  ),
  'per-model-budget-caps-team': (
    <>
      <p>
        Last Friday, a head of engineering at a 30-person startup pinged me a screenshot of their Anthropic invoice. <span className="text-gray-300">$8,400 for the month.</span> They had budgeted $2,000.
      </p>
      <p>
        I asked the questions you have to ask:
      </p>
      <ul>
        <li>Which model drove that?</li>
        <li>Which repo?</li>
        <li>Which engineer?</li>
        <li>What got shipped for $8,400?</li>
      </ul>
      <p>
        He couldn&rsquo;t answer any of them. Nobody on his team could. They had a single Anthropic API key, they used it across Claude Code, Cursor, internal scripts, and Slack bots, and the bill arrived once a month with one number on it.
      </p>
      <p className="text-gray-100 font-medium">
        That conversation, give or take, has happened on every customer call we&rsquo;ve had this quarter. So this week we shipped per-model budget caps for teams &mdash; the feature that lets you say &ldquo;Opus $300 per developer per month, Sonnet $100, Haiku unlimited&rdquo; and have it actually <em>enforced</em>, not just reported on.
      </p>

      <h2>Most teams have four models, not one</h2>

      <p>
        Talk to any engineering team that&rsquo;s been using AI for more than three months and you find the same pattern:
      </p>

      {/* Four-model spec card */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-6 shadow-2xl">
          <p className="text-[10px] uppercase tracking-[0.12em] text-gray-500 font-semibold mb-4">
            Models in active use, by job
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { name: 'Opus / GPT-5', job: 'Hard architecture work', share: 90, color: '#a78bfa' },
              { name: 'Sonnet / GPT-4o', job: 'Tests + refactors', share: 60, color: '#a78bfa' },
              { name: 'Codex / Cursor', job: 'Boilerplate + scaffolding', share: 75, color: '#34d399' },
              { name: 'Gemini / Haiku', job: 'That one weird case', share: 35, color: '#fbbf24' },
            ].map((m) => (
              <div key={m.name} className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
                <p className="text-sm font-mono text-gray-100 mb-1">{m.name}</p>
                <p className="text-[11px] text-gray-500 mb-3">{m.job}</p>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${m.share}%`, background: m.color }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[11px] text-gray-500 text-center">
            Same engineer, four bills. None of them attributable.
          </p>
        </div>
      </div>

      <p>
        And every model has a ten-fold cost spread between the high end and the low end. Opus runs at <code>$15/M input tokens, $75/M output tokens.</code> Haiku is <code>$0.80 in / $4 out</code> &mdash; literally 1/19th the per-token cost.
      </p>
      <p>
        Which means a developer who reaches for Opus when Haiku would&rsquo;ve done the job is silently burning your budget at 19&times; the rate they need to. And there&rsquo;s no signal coming back to tell them that.
      </p>

      <h2>The visibility gap is structural</h2>

      <p>
        Here&rsquo;s why nobody&rsquo;s solved this with a spreadsheet: the unit of cost (a token) and the unit of work (a session that produced a PR) live in completely different systems.
      </p>

      {/* Cost-attribution chain diagram */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-6 shadow-2xl">
          <div className="flex flex-col md:flex-row items-stretch gap-3">
            {[
              { label: 'Provider invoice', detail: 'Anthropic / OpenAI / Google bills you a single number', color: 'border-red-500/40 bg-red-500/5', accent: 'text-red-400' },
              { label: 'API key', detail: 'Maybe one per service. Maybe one per developer if you\'re organised.', color: 'border-amber-500/40 bg-amber-500/5', accent: 'text-amber-400' },
              { label: 'The actual work', detail: 'Engineer · repo · model · prompt · session · PR', color: 'border-emerald-500/40 bg-emerald-500/5', accent: 'text-emerald-400' },
            ].map((node, i) => (
              <React.Fragment key={node.label}>
                <div className={`flex-1 rounded-lg border ${node.color} px-4 py-3`}>
                  <div className={`text-[10px] uppercase tracking-wider ${node.accent} font-semibold mb-1`}>{node.label}</div>
                  <p className="text-xs text-gray-400 leading-snug">{node.detail}</p>
                </div>
                {i < 2 && (
                  <div className="self-center text-gray-700 px-1 hidden md:block">→</div>
                )}
              </React.Fragment>
            ))}
          </div>
          <p className="mt-4 text-[11px] text-gray-500 text-center">
            The provider gives you the top of this chain. The bottom is where the budget actually goes.
          </p>
        </div>
      </div>

      <p>
        FinOps tools handle invoice rollup. Provider dashboards show usage. Neither knows that <span className="text-gray-300">prompt #4 in session 9c2a1f, run by Sarah at 14:32 on Tuesday in the <code>billing</code> repo, used Opus to add 14 lines that became PR #2103.</span> Origin does &mdash; that&rsquo;s the unit we capture &mdash; but until this week it didn&rsquo;t enforce on it.
      </p>

      <h2>What we shipped</h2>

      <p>
        Four levels of budget cap, each with monthly USD and monthly token limits, plus per-session caps:
      </p>

      {/* Budget hierarchy diagram */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-6 shadow-2xl">
          <div className="space-y-2">
            {[
              { tier: '1', label: 'Org', detail: 'Monthly cap across the whole company', limit: '$10,000' },
              { tier: '2', label: 'Agent', detail: 'Claude Code · Cursor · Codex · Gemini', limit: '$3,000 / agent' },
              { tier: '3', label: 'Agent × Model', detail: 'Opus · Sonnet · Haiku, separately', limit: '$300 / model', highlight: true },
              { tier: '4', label: 'Engineer × Model', detail: 'A specific dev\'s Opus budget', limit: '$50 / dev' },
              { tier: '4', label: 'Repo × Model', detail: 'How much any model can spend in a repo', limit: '$200 / repo' },
            ].map((row, i) => (
              <div
                key={i}
                className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
                  row.highlight
                    ? 'border-indigo-500/50 bg-indigo-500/[0.06]'
                    : 'border-gray-800 bg-gray-900/40'
                }`}
                style={{ marginLeft: `${(Number(row.tier) - 1) * 24}px` }}
              >
                <span className={`text-[10px] uppercase tracking-wider font-semibold w-16 ${row.highlight ? 'text-indigo-300' : 'text-gray-500'}`}>
                  Tier {row.tier}
                </span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${row.highlight ? 'text-gray-50' : 'text-gray-200'}`}>{row.label}</p>
                  <p className="text-[11px] text-gray-500">{row.detail}</p>
                </div>
                <code className={`text-xs font-mono ${row.highlight ? 'text-indigo-300' : 'text-gray-400'}`}>
                  {row.limit}
                </code>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[11px] text-gray-500">
            The narrowest matching cap fires first. A too-loose tier above can&rsquo;t accidentally bypass a tighter one below.
          </p>
        </div>
      </div>

      <p>
        Tier 3 &mdash; <strong>per agent &times; model</strong> &mdash; is the one we built this release around. It&rsquo;s the one customers asked for by name. Tiers 1 and 2 already existed; tiers 4 are nice-to-have. Tier 3 is what flips &ldquo;we have an AI cost problem&rdquo; into &ldquo;we have an AI cost lever.&rdquo;
      </p>

      <h2>What it looks like in the dashboard</h2>

      <p>
        Open any agent &rarr; the new <strong>Models</strong> section shows every model that agent has run, with four editable cells per row:
      </p>

      {/* Per-model row mockup */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-semibold text-gray-100">Models</p>
              <p className="text-[11px] text-gray-500">Per-model budget overrides. Leave blank to inherit the agent default.</p>
            </div>
            <span className="text-xs text-indigo-400">+ Add model</span>
          </div>
          <div className="divide-y divide-gray-800">
            {[
              { model: 'claude-opus-4-7',    monthly: '300',   tokens: '50,000,000', perSess: '5.00', perSessTok: '200000',  spent: 182, limit: 300, tier: 'amber' },
              { model: 'claude-sonnet-4-6',  monthly: '100',   tokens: '',           perSess: '',     perSessTok: '',        spent: 24,  limit: 100, tier: 'green' },
              { model: 'claude-haiku-4-5',   monthly: '',      tokens: '',           perSess: '',     perSessTok: '',        spent: 4.30, limit: 0,  tier: 'none' },
            ].map((row) => (
              <div key={row.model} className="py-3">
                <div className="flex items-center justify-between mb-2">
                  <code className="text-sm text-gray-100 font-mono">{row.model}</code>
                  <span className="text-[11px] text-gray-500">Remove</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                  {[
                    { label: 'Monthly $', value: row.monthly },
                    { label: 'Monthly tokens', value: row.tokens },
                    { label: 'Max $/sess', value: row.perSess },
                    { label: 'Max tok/sess', value: row.perSessTok },
                  ].map((c, i) => (
                    <div key={i} className="rounded border border-gray-800 bg-gray-950 px-2.5 py-1.5">
                      <p className="text-[9px] uppercase tracking-wider text-gray-600">{c.label}</p>
                      <p className={`text-xs font-mono ${c.value ? 'text-gray-200' : 'text-gray-700 italic'}`}>
                        {c.value || 'inherit'}
                      </p>
                    </div>
                  ))}
                </div>
                {row.limit > 0 ? (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min((row.spent / row.limit) * 100, 100)}%`,
                          background: row.tier === 'amber' ? '#f59e0b' : row.tier === 'green' ? '#10b981' : '#6b7280',
                        }}
                      />
                    </div>
                    <span className="text-[11px] text-gray-500 tabular-nums w-32 text-right">
                      ${row.spent.toFixed(2)} / ${row.limit} this month
                    </span>
                  </div>
                ) : (
                  <p className="text-[11px] text-gray-600">No limit · ${typeof row.spent === 'number' ? row.spent.toFixed(2) : row.spent} spent this month</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <p>
        Three rows, three different policies. Opus is on a tight leash. Sonnet has a comfortable budget. Haiku is unlimited &mdash; the message to the team is &ldquo;reach for this one freely.&rdquo; The progress bars and the tier-colored gradients aren&rsquo;t decoration; they&rsquo;re a glance-test for &ldquo;is anyone close to a cap?&rdquo;
      </p>

      <h2>Hard stop, not a monthly surprise</h2>

      <p>
        The point isn&rsquo;t a chart at the end of the month. The point is to stop the session <em>before</em> it runs.
      </p>
      <p>
        When an engineer fires up Claude Code on Opus and the cap has been hit, Origin checks at session-start, in milliseconds, before the model is even invoked. The CLI returns:
      </p>
      <pre className="not-prose">
        <code className="block rounded-lg bg-gray-950 border border-gray-800 px-4 py-3 text-sm text-gray-300 font-mono whitespace-pre-wrap">
{`$ origin run --model claude-opus-4-7
[origin] Session blocked — agent model budget limit reached.
Claude Code · claude-opus-4-7 monthly model limit
exceeded ($302.10 / $300.00).

Try:
  origin run --model claude-sonnet-4-6   # $76 of $100 used this month
  origin run --model claude-haiku-4-5    # unlimited`}
        </code>
      </pre>
      <p>
        No mid-session billing surprise. No conversation that starts with &ldquo;your AI bill is up $4,000 this month.&rdquo; The engineer either picks a smaller model, asks for a higher cap, or pings the architect. All of those are productive conversations to have <em>before</em> the spend, not after.
      </p>

      <h2>The Opus burner problem, and how tier 4 handles it</h2>

      <p>
        Every team has one. The engineer running 4&times; the team&rsquo;s average AI spend, almost entirely on the most expensive model, often for tasks the cheaper models would&rsquo;ve handled at a third of the cost. They&rsquo;re not malicious &mdash; they just got into a habit of using the smartest model and the cost signal never reached them.
      </p>
      <p>
        Per-engineer model caps target that directly. Set Opus at $50/dev/mo across the team, with a one-off override for the principal architect. Everyone gets the same ceiling on the expensive stuff. The behaviour change happens within a week &mdash; engineers start feeling out where Sonnet works.
      </p>

      <h2>Behavioural shift: the cheap models become first-choice</h2>

      <p>
        Most teams have settled into &ldquo;use the smartest model.&rdquo; That&rsquo;s a defensible default when the cost signal is invisible. It becomes a bad default the moment the cost is on the same screen as the work.
      </p>
      <p>
        With per-model caps in place, three things shift in the team&rsquo;s daily conversation:
      </p>
      <ol>
        <li><strong>Reaching for Opus becomes deliberate.</strong> &ldquo;Why are you using Opus for boilerplate?&rdquo; goes from a sigh in standup to a hard stop at session-start.</li>
        <li><strong>Mid-tier models earn their seat.</strong> Sonnet for tests and refactors stops being the consolation prize and starts being the default.</li>
        <li><strong>Cheap models stop being &ldquo;backup&rdquo; and start being primary.</strong> Haiku for scaffolding, log parsing, doc generation &mdash; work that absolutely doesn&rsquo;t need flagship reasoning &mdash; gets routed to the model whose pricing matches.</li>
      </ol>

      <h2>What you actually see, day-to-day</h2>

      <p>
        The dashboard hero panel shows month-to-date spend with a gradient progress bar (green &rarr; amber &rarr; red), a faint &ldquo;projected&rdquo; ghost overlaid showing where the spend will land if the trend holds, and milestone markers at 50/80/100%. Click the Tokens KPI card to drill in by agent &mdash; cursor 21M tokens, claude-opus-4-6 19M, codex 5M. Same drill-down for cost.
      </p>
      <p>
        On the Insights page, <strong>Cost by model</strong> renders each bar in the model&rsquo;s brand color &mdash; Claude in lavender, Cursor in sky, Codex in emerald, Gemini in amber &mdash; so a fleet of models is scannable at a glance. The Efficiency tab flags any engineer running 2&times; over the team&rsquo;s tokens-per-line average. The Anomalies tab catches sessions that spent 10&times; more than the median.
      </p>
      <p>
        And every block, every alert, every CLI message tells you <em>which level fired</em>: <code>org</code>, <code>agent</code>, <code>model</code>, <code>user-model</code>, or <code>repo-model</code>. No guessing.
      </p>

      <h2>The conversation that just got possible</h2>

      <p>
        For 18 months, the standard answer to &ldquo;how much are we spending on AI?&rdquo; has been &ldquo;a lot, and we don&rsquo;t exactly know on what.&rdquo;
      </p>
      <p>
        That&rsquo;s ending. Not because someone shipped a heroic FinOps tool, but because the AI coding session finally has a place to live as a unit of work, with all its attribution attached. With per-model caps, the question gets concrete:
      </p>
      <div className="not-prose my-8 rounded-xl border border-gray-800 bg-[#0a0b14] p-6 shadow-2xl space-y-3">
        {[
          'We spent $4,200 on Opus, $1,100 on Sonnet, $90 on Haiku.',
          'Opus produced 41 PRs; 8 of them flagged for review.',
          'Three engineers account for 60% of the Opus spend.',
          'We capped Opus at $300/dev, kept Sonnet open at $100, told the team Haiku for boilerplate.',
          'Spend was down 38% the next month. Throughput was flat.',
        ].map((line, i) => (
          <div key={i} className="flex items-start gap-3">
            <span className="text-[10px] text-indigo-400 font-mono mt-0.5">{String(i + 1).padStart(2, '0')}</span>
            <p className="text-sm text-gray-200">{line}</p>
          </div>
        ))}
      </div>
      <p>
        That&rsquo;s a finance conversation an engineering manager can actually have. With numbers. With a knob.
      </p>

      <h2>How to turn it on</h2>

      <p>
        Open any agent in your team org. Scroll to <strong>Models</strong>. The first row was created by a backfill when the feature shipped &mdash; it&rsquo;s the agent&rsquo;s current default model, with no overrides. Click <em>Monthly $</em>, type a number. That&rsquo;s the cap. Save is automatic on blur.
      </p>
      <p>
        If a model arrives in production that you haven&rsquo;t configured yet, Origin auto-detects it and adds a row with an &ldquo;Auto-detected&rdquo; badge so admins see what&rsquo;s new. You decide whether to set a cap or ignore it.
      </p>
      <p>
        Per-engineer and per-repo caps live on the <Link to="/budget" className="text-indigo-400 hover:text-indigo-300">Budget</Link> page under their respective tabs. Same edit pattern: chevron expands the row, click any model to set a cap.
      </p>
      <p>
        The era of &ldquo;we&rsquo;re spending a lot on AI but I don&rsquo;t know where&rdquo; is ending. About time.
      </p>
    </>
  ),
  'nobody-in-the-chain-wrote-this-code': (
    <>
      <p>
        Most engineering managers I know haven&rsquo;t written production code in years.
      </p>
      <p>
        That used to be fine. They managed engineers who coded. Now those engineers manage AI agents that code.
      </p>
      <p>
        So you have a manager who can&rsquo;t code, overseeing a dev who doesn&rsquo;t really code anymore, shipping code written by a model nobody fully understands.
      </p>
      <p>
        And somehow we expect code reviews to catch problems in that chain.
      </p>
      <p className="text-gray-100 font-medium">
        The gap between what&rsquo;s happening in the codebase and what leadership thinks is happening has never been wider.
      </p>

      <h2>The three-layer gap</h2>

      {/* Chain-of-trust diagram */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] p-6 shadow-2xl">
          <div className="flex flex-col md:flex-row items-stretch gap-3">
            {[
              {
                label: 'Manager',
                role: 'Approves the roadmap',
                detail: 'Last shipped prod code: 4+ years ago',
                color: 'border-amber-500/40 bg-amber-500/5',
                accent: 'text-amber-400',
              },
              {
                label: 'Engineer',
                role: 'Writes the prompts',
                detail: 'Types ~20% of the lines · reviews the rest',
                color: 'border-indigo-500/40 bg-indigo-500/5',
                accent: 'text-indigo-400',
              },
              {
                label: 'Model',
                role: 'Writes the code',
                detail: 'claude-opus / gpt-5 / cursor-agent · 60–90% of diff',
                color: 'border-purple-500/40 bg-purple-500/5',
                accent: 'text-purple-400',
              },
            ].map((node, i) => (
              <React.Fragment key={node.label}>
                <div className={`flex-1 rounded-lg border ${node.color} px-4 py-3`}>
                  <div className={`text-[10px] uppercase tracking-wider ${node.accent} font-semibold`}>
                    Layer {i + 1}
                  </div>
                  <div className="text-sm font-semibold text-gray-100 mt-1">{node.label}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{node.role}</div>
                  <div className="text-[11px] text-gray-600 mt-2">{node.detail}</div>
                </div>
                {i < 2 && (
                  <div className="hidden md:flex items-center justify-center px-1 text-gray-700">
                    &rarr;
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-gray-800 text-[11px] text-gray-500">
            The person who approves the work can&rsquo;t read the diff.
            The person who &ldquo;wrote&rdquo; it didn&rsquo;t type most of it.
            The thing that did type it has no memory of why.
          </div>
        </div>
      </div>

      <p>
        Each layer used to have a reason to exist. Managers set direction. Engineers translated direction into code. Reviewers caught what the engineer missed. The chain worked because everyone in it could, in a pinch, do the job of the person next to them.
      </p>
      <p>
        That&rsquo;s gone now. The manager couldn&rsquo;t pass a tech screen at their own company. The engineer drives an autocomplete loop that produces 80% of the diff. The reviewer approves a PR written by a model they&rsquo;ve never used, in a style they didn&rsquo;t choose, doing things they didn&rsquo;t explicitly ask for.
      </p>

      <h2>Code review was the last line of defense. It&rsquo;s not holding.</h2>

      <p>
        Code review was designed for a world where a human spent four hours writing a thing and another human spent twenty minutes reading it. The reviewer&rsquo;s edge was patience &mdash; they had more of it than the author on the specific file in front of them.
      </p>

      <p>
        AI flipped that. Now the author spent four minutes generating the thing and the reviewer spends twenty minutes reading it. The author has no particular insight into why the code is the way it is &mdash; they didn&rsquo;t make the choices that produced it. Ask them why a function is recursive instead of iterative and the honest answer is &ldquo;that&rsquo;s what the model gave me and it worked.&rdquo;
      </p>

      <p>
        Reviewers can still catch obvious bugs. They can&rsquo;t catch:
      </p>
      <ul>
        <li><strong className="text-gray-100">Subtle API misuse the model hallucinated from a different library.</strong> Looks plausible. Compiles. Doesn&rsquo;t do what the signature suggests.</li>
        <li><strong className="text-gray-100">Regressions the model silently introduced while fixing something else.</strong> The diff shows the intended change; the unrelated change three files over goes unread.</li>
        <li><strong className="text-gray-100">Architecture drift.</strong> Every prompt picks the locally-best option. A hundred locally-best options produce a codebase nobody designed.</li>
        <li><strong className="text-gray-100">Silent cost blowouts.</strong> The PR looks small. The session behind it burned $120 in tokens and took 47 tool calls. That doesn&rsquo;t show in the diff.</li>
      </ul>

      <h2>What leadership thinks is happening vs. what&rsquo;s actually happening</h2>

      {/* Dashboard contrast mock */}
      <div className="not-prose my-10 grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-300">What the exec dashboard shows</span>
            <span className="text-[10px] text-emerald-400">on track</span>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-gray-500 uppercase tracking-wider">Velocity</span>
              <span className="text-lg font-semibold text-gray-100 tabular-nums">+34%</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-gray-500 uppercase tracking-wider">PRs merged</span>
              <span className="text-lg font-semibold text-gray-100 tabular-nums">127</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-gray-500 uppercase tracking-wider">Incidents</span>
              <span className="text-lg font-semibold text-gray-100 tabular-nums">0</span>
            </div>
            <div className="text-[11px] text-gray-600 pt-2 border-t border-gray-800">
              &ldquo;The team is shipping faster than ever.&rdquo;
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-amber-500/30 bg-[#0a0b14] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-amber-500/30 flex items-center justify-between">
            <span className="text-xs font-medium text-amber-300">What the codebase actually shows</span>
            <span className="text-[10px] text-amber-400">blind spots</span>
          </div>
          <div className="p-4 space-y-2 text-[11px] text-gray-400">
            <div className="flex items-start gap-2">
              <span className="text-amber-400 font-mono">·</span>
              <span>78% of lines in the last 30 days written by AI. No human typed them.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-amber-400 font-mono">·</span>
              <span>4 different models in rotation. No one chose which writes which service.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-amber-400 font-mono">·</span>
              <span>$18k/mo in inference, spread across 23 personal API keys.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-amber-400 font-mono">·</span>
              <span>Average PR reviewer reads 14% of lines &mdash; the rest is &ldquo;LGTM, trust the tests.&rdquo;</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-amber-400 font-mono">·</span>
              <span>No one can answer &ldquo;why is this here&rdquo; for 60%+ of the codebase.</span>
            </div>
          </div>
        </div>
      </div>

      <p>
        Both dashboards are telling the truth. They&rsquo;re just telling it about different things. The exec dashboard measures throughput. The codebase measures reality. In a world where a dev and an AI can ship a feature in an afternoon, throughput is easy. Reality is what bites you six months later when nobody remembers which prompt introduced the race condition.
      </p>

      <h2>What to do Monday morning</h2>

      <p>
        Don&rsquo;t ban AI coding. That ship sailed &mdash; your best engineers would quit, and your worst engineers would use it anyway. The question isn&rsquo;t whether AI writes your code. It&rsquo;s whether anyone can still answer basic questions about the code after it&rsquo;s written.
      </p>

      <p>
        Three things close the gap:
      </p>

      <ul>
        <li>
          <strong className="text-gray-100">Per-line attribution that survives the commit.</strong> Not &ldquo;Sarah committed this&rdquo; &mdash; <em>which prompt, which model, which session</em> produced this line. Without this, every review is guessing.
        </li>
        <li>
          <strong className="text-gray-100">Session replay on the PR.</strong> Reviewers shouldn&rsquo;t see just the final diff. They should see the prompt chain that produced it &mdash; what was asked, what the model tried, what got reverted. The journey is often more revealing than the destination.
        </li>
        <li>
          <strong className="text-gray-100">Governance that runs before the PR opens.</strong> Model allowlists, cost caps, forbidden paths, required reviews for AI-heavy changes. Enforced at commit time, not discovered in post-mortem.
        </li>
      </ul>

      {/* What Origin shows mock */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden shadow-2xl">
          <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-indigo-500" />
              <span className="text-xs font-medium text-gray-200">auth-service &middot; PR #1247</span>
            </div>
            <span className="text-[10px] text-indigo-400">96% AI &middot; claude-opus-4-7</span>
          </div>
          <div className="px-4 py-3 border-b border-gray-800/60">
            <p className="text-xs text-gray-300 mb-1">add rate limiting to auth endpoints</p>
            <div className="flex items-center gap-3 text-[10px] text-gray-500 font-mono">
              <span>12 prompts</span>
              <span>47 tool calls</span>
              <span>$4.82</span>
              <span>18m 22s</span>
              <span className="ml-auto text-gray-400">reviewer: @sarah</span>
            </div>
          </div>
          <div className="divide-y divide-gray-800/60 text-[11px]">
            {[
              { line: 'src/middleware/ratelimit.ts:42', prompt: 'use redis for distributed counters', note: 'author couldn\'t answer why redis vs memory' },
              { line: 'src/middleware/ratelimit.ts:87', prompt: 'handle the locked-account edge case', note: 'added a branch that swallows errors silently' },
              { line: 'src/middleware/ratelimit.ts:114', prompt: 'write tests for both paths', note: 'tests mock the thing they\'re meant to verify' },
            ].map((row, i) => (
              <div key={i} className="px-4 py-2.5 hover:bg-gray-900/40 transition-colors">
                <div className="flex items-start gap-3">
                  <span className="text-gray-600 font-mono text-[10px] flex-shrink-0 pt-0.5">{row.line}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-300">&ldquo;{row.prompt}&rdquo;</p>
                    <p className="text-amber-400/80 mt-0.5">⚠ {row.note}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p>
        That&rsquo;s what Origin shows on every PR. Not &ldquo;AI wrote this&rdquo; &mdash; everyone knows that. Which <em>prompt</em> wrote which <em>line</em>, what the model tried before landing there, and what the reviewer should actually pay attention to. Per-line attribution. Session replay on PR. Policies enforced before commit.
      </p>

      <p>
        We built it because we ran the chain ourselves and saw it break. The best engineers we know still ship great code with AI &mdash; but they can tell you exactly why every file looks the way it does. The teams that can&rsquo;t answer that question are accruing debt they won&rsquo;t see until it&rsquo;s already shipped.
      </p>

      <p>
        Code review isn&rsquo;t the last line of defense anymore. Visibility is.
      </p>

      <p className="text-gray-500 text-sm mt-8">
        Origin is git blame for AI. <Link to="/" className="text-indigo-400 hover:text-indigo-300">See it on your repo</Link> &mdash; free for solo developers, works with Claude Code, Cursor, Codex, Gemini, and Aider.
      </p>
    </>
  ),

  'snapshots-see-what-ai-changed-every-prompt': (
    <>
      <p>
        You ask Claude to &ldquo;add rate limiting.&rdquo; It edits three files. You ask it to &ldquo;also handle the edge case for locked accounts.&rdquo; It touches two more. Then you ask it to &ldquo;write tests for both paths&rdquo; and suddenly your build is broken.
      </p>
      <p>
        Which prompt broke it? You have no idea. The session is one long conversation. The git history shows a single commit at the end. Everything in between &mdash; every intermediate state, every file change per prompt &mdash; is gone.
      </p>
      <p>
        Not anymore. <strong className="text-gray-100">Origin Snapshots capture what changed after every single AI prompt.</strong> Files touched, lines added and removed, the exact diff, AI vs human attribution, commit SHA, and a link back to the session. Every prompt is a snapshot.
      </p>

      <h2>What a snapshot looks like</h2>
      <p>
        Every time your AI agent responds to a prompt and changes code, Origin records a snapshot. Here&rsquo;s what you see in the dashboard:
      </p>

      {/* Snapshot list mock */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden shadow-2xl">
          <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-xs font-medium text-gray-200">Snapshots</span>
              <span className="text-[10px] text-gray-600">api-server &middot; main</span>
            </div>
            <span className="text-[10px] text-gray-600">3 snapshots &middot; today</span>
          </div>
          <div className="divide-y divide-gray-800/60">
            {[
              { type: 'auto', typeColor: 'bg-blue-500', prompt: 'add rate limiting to prevent brute force attacks', files: 'src/auth.ts, src/middleware.ts, src/config.ts', added: 42, removed: 8, ai: 94, time: '14 min ago', model: 'claude-sonnet-4' },
              { type: 'auto', typeColor: 'bg-blue-500', prompt: 'handle the edge case where user account is already locked', files: 'src/auth.ts, src/errors.ts', added: 18, removed: 3, ai: 100, time: '11 min ago', model: 'claude-sonnet-4' },
              { type: 'auto', typeColor: 'bg-blue-500', prompt: 'write tests for both rate limiting and locked account paths', files: 'tests/auth.test.ts, tests/middleware.test.ts', added: 87, removed: 0, ai: 100, time: '8 min ago', model: 'claude-sonnet-4' },
            ].map((s, i) => (
              <div key={i} className="px-4 py-3 hover:bg-gray-900/40 transition-colors">
                <div className="flex items-start gap-3">
                  <div className={`w-1.5 h-1.5 rounded-full ${s.typeColor} mt-2 flex-shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-200 mb-1">&ldquo;{s.prompt}&rdquo;</p>
                    <div className="flex items-center gap-3 flex-wrap text-[10px] text-gray-500">
                      <span className="text-gray-400">{s.files}</span>
                      <span className="text-emerald-500">+{s.added}</span>
                      <span className="text-red-400">-{s.removed}</span>
                      <span className="text-blue-400">{s.ai}% AI</span>
                      <span className="font-mono text-gray-600">{s.model}</span>
                      <span className="ml-auto text-gray-600">{s.time}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p>
        Click any snapshot to see the full diff, file-by-file. Click through to the session to see the complete conversation that produced it.
      </p>

      <h2>The problem snapshots solve</h2>
      <p>
        AI coding sessions are long. A single session with Claude or Cursor might involve 10&ndash;20 prompts, touching dozens of files. But git only sees what you commit at the end. The intermediate states are invisible.
      </p>
      <p>
        This creates three problems:
      </p>
      <ul>
        <li><strong className="text-gray-100">You can&rsquo;t bisect within a session.</strong> If the build broke, you have to re-read the entire conversation to find the bad prompt. With snapshots, you see exactly which prompt changed which files.</li>
        <li><strong className="text-gray-100">Code review is blind.</strong> A PR shows the final diff but not the journey. Snapshots show the reviewer every step the AI took &mdash; what it tried, what it changed, what it reverted.</li>
        <li><strong className="text-gray-100">Attribution is session-level, not prompt-level.</strong> Without snapshots, you know &ldquo;Claude wrote auth.ts&rdquo; but not which of the 12 prompts did it. Snapshots give you prompt-level attribution.</li>
      </ul>

      <h2>How it works</h2>
      <p>
        Every time an AI agent finishes responding to a prompt, Origin&rsquo;s hooks capture:
      </p>

      {/* Data captured list */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-gradient-to-b from-gray-950 to-[#0a0b14] p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            {[
              { label: 'Prompt text', desc: 'The exact instruction given to the AI', icon: '💬' },
              { label: 'Files changed', desc: 'Which files were touched by this specific prompt', icon: '📁' },
              { label: 'Lines added / removed', desc: 'Exact line counts computed from the diff', icon: '📊' },
              { label: 'AI attribution %', desc: 'What percentage of changed lines are AI-written', icon: '🤖' },
              { label: 'Snapshot type', desc: 'auto, manual, session-start, or session-end', icon: '🏷️' },
              { label: 'Commit SHA', desc: 'If a commit happened, the exact SHA is linked', icon: '🔗' },
            ].map((item) => (
              <div key={item.label} className="flex items-start gap-3 p-3 rounded-lg bg-gray-900/40 border border-gray-800/50">
                <span className="text-base flex-shrink-0">{item.icon}</span>
                <div>
                  <div className="text-gray-200 font-medium">{item.label}</div>
                  <div className="text-gray-500 mt-0.5 text-[11px]">{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p>
        No extra setup. If you&rsquo;re running Origin, snapshots are already being captured. The data flows through the same hooks that power session tracking.
      </p>

      <h2>Snapshots in the CLI</h2>
      <p>
        Snapshots aren&rsquo;t just a dashboard feature. Two new CLI commands make them useful right in your terminal:
      </p>

      {/* origin log */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden shadow-2xl">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">Terminal</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin log</div>
            <div className="h-2" />
            <div className="text-gray-100">  <span className="text-yellow-400">599d8fc</span> Fix auth bug        <span className="text-gray-600">&mdash;</span> <span className="text-cyan-400">Claude Code</span> <span className="text-gray-600">&middot;</span> <span className="text-emerald-400">$0.12</span> <span className="text-gray-600">&middot;</span> <span className="text-gray-400">3 prompts</span> <span className="text-gray-600">&middot;</span> <span className="text-gray-600">Apr 14</span></div>
            <div className="text-gray-100">  <span className="text-yellow-400">def5678</span> Add rate limiting   <span className="text-gray-600">&mdash;</span> <span className="text-cyan-400">Cursor</span> <span className="text-gray-600">&middot;</span> <span className="text-emerald-400">$0.08</span> <span className="text-gray-600">&middot;</span> <span className="text-gray-400">1 prompt</span> <span className="text-gray-600">&middot;</span> <span className="text-gray-600">Apr 13</span></div>
            <div className="text-gray-100">  <span className="text-yellow-400">9ab1234</span> Update docs         <span className="text-gray-600">&mdash;</span> <span className="text-gray-500">(no session)</span> <span className="text-gray-600">&middot;</span> <span className="text-gray-600">Apr 12</span></div>
            <div className="h-2" />
            <div className="text-gray-500">  2/3 commits AI-generated (67%) &middot; <span className="text-emerald-400">$0.20</span> total cost</div>
          </div>
        </div>
      </div>

      <p>
        <code>origin log</code> is <code>git log</code> but with AI context. Every commit shows which agent wrote it, how much it cost, and how many prompts were involved. The footer gives you the AI ratio and total spend.
      </p>

      {/* origin show */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-emerald-700/50 bg-gradient-to-b from-emerald-950/30 to-[#0a0b14] overflow-hidden shadow-2xl shadow-emerald-900/10">
          <div className="px-4 py-2 border-b border-emerald-800/30 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">Terminal</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin show 599d8fc</div>
            <div className="h-2" />
            <div className="text-gray-100">  <span className="text-yellow-400">599d8fc</span> Fix auth bug</div>
            <div className="text-gray-500">  by Alex Kim on 4/14/2026</div>
            <div className="h-2" />
            <div className="text-white font-bold">  Session</div>
            <div className="text-gray-400">  ID:       <span className="text-cyan-400">02c18ce2</span></div>
            <div className="text-gray-400">  Agent:    <span className="text-cyan-400">Claude Code</span> / <span className="text-gray-500">claude-sonnet-4</span></div>
            <div className="text-gray-400">  Duration: <span className="text-gray-200">14 min</span></div>
            <div className="text-gray-400">  Cost:     <span className="text-emerald-400">$0.12</span></div>
            <div className="text-gray-400">  Prompts:  <span className="text-gray-200">3</span></div>
            <div className="text-gray-400">  Lines:    <span className="text-emerald-400">+42</span> <span className="text-red-400">-8</span></div>
            <div className="h-2" />
            <div className="text-white font-bold">  Prompt Details</div>
            <div className="text-gray-400">  1. <span className="text-gray-200">&quot;add rate limiting to prevent brute force&quot;</span></div>
            <div className="text-gray-400">  2. <span className="text-gray-200">&quot;handle locked account edge case&quot;</span></div>
            <div className="text-gray-400">  3. <span className="text-gray-200">&quot;write tests for both paths&quot;</span></div>
            <div className="h-2" />
            <div className="text-white font-bold">  Files</div>
            <div className="text-gray-400">  &middot; src/auth.ts <span className="text-emerald-400">+28</span> <span className="text-red-400">-6</span></div>
            <div className="text-gray-400">  &middot; src/middleware.ts <span className="text-emerald-400">+14</span> <span className="text-red-400">-2</span></div>
          </div>
        </div>
      </div>

      <p>
        <code>origin show</code> takes any commit SHA and shows the full session behind it: which agent, what model, how long it took, what it cost, every prompt in order, and every file changed. It&rsquo;s the bridge between <code>git log</code> and the AI session that produced the code.
      </p>

      <h2>Commit linking</h2>
      <p>
        Every commit made during an AI session now gets an automatic trailer:
      </p>

      {/* Commit message */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden shadow-2xl">
          <div className="px-4 py-2 border-b border-gray-800">
            <span className="text-xs text-gray-500 font-mono">git log -1</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-200">Fix rate limiting on login endpoint</div>
            <div className="h-2" />
            <div className="text-gray-200">Adds sliding window rate limiter to /auth/login.</div>
            <div className="text-gray-200">Blocks after 5 failed attempts in 15 minutes.</div>
            <div className="h-2" />
            <div className="text-indigo-400">Origin-Session: 02c18ce2a253 | Claude Code | 3 prompts</div>
          </div>
        </div>
      </div>

      <p>
        The trailer is added automatically by Origin&rsquo;s post-commit hook. It shows the session ID, the agent, and the prompt count. Anyone reading the git log can immediately see this was AI-generated and trace it back to the session. No extra commands, no workflow changes.
      </p>

      <h2>Dashboard: the Snapshots page</h2>
      <p>
        The web dashboard at <a href="https://getorigin.io" className="text-emerald-400 hover:text-emerald-300">getorigin.io</a> now has a dedicated Snapshots page. It shows every prompt-level snapshot across all your sessions:
      </p>
      <ul>
        <li><strong className="text-gray-100">Filter by type</strong> &mdash; see only auto, manual, session-start, or session-end snapshots</li>
        <li><strong className="text-gray-100">Filter by repo</strong> &mdash; narrow down to a specific project</li>
        <li><strong className="text-gray-100">Search prompts</strong> &mdash; find the exact prompt that introduced a change</li>
        <li><strong className="text-gray-100">Click through</strong> &mdash; every snapshot links to the full session detail with diffs</li>
      </ul>
      <p>
        Stats cards at the top give you totals: snapshot count, AI-authored turns, lines added and removed. It&rsquo;s the single view for &ldquo;what did AI do today.&rdquo;
      </p>

      <h2>What&rsquo;s next: restore from snapshot</h2>
      <p>
        Snapshots are read-only today. But the data is there to go further: click a snapshot in the dashboard, hit &ldquo;Restore,&rdquo; and roll your working tree back to that exact point. The CLI picks up the command via heartbeat and runs <code>git read-tree</code> to restore the state. No branch switching, no stashing. One click.
      </p>
      <p>
        We&rsquo;re building this now. If you want early access, grab Origin and start generating snapshots today &mdash; when restore ships, your history will already be there.
      </p>

      <h2>Try it</h2>

      {/* Install */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden shadow-2xl">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">Terminal</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-500"><span className="text-emerald-400">$</span> npm i -g https://getorigin.io/cli/origin-cli-latest.tgz</div>
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin init</div>
            <div className="text-emerald-400">  &#10003; Hooks installed. Snapshots are now active.</div>
            <div className="h-2" />
            <div className="text-gray-600"># Code with any AI agent. Snapshots happen automatically.</div>
            <div className="h-2" />
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin log                    <span className="text-gray-700"># see AI sessions in git log</span></div>
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin show abc1234            <span className="text-gray-700"># full session behind any commit</span></div>
          </div>
        </div>
      </div>

      <p>
        Free forever for solo developers. No limits on repos, sessions, or agents.
      </p>
      <p>
        <a href="/register?type=developer" className="text-emerald-400 hover:text-emerald-300 font-medium">Get your free account &rarr;</a>
      </p>
    </>
  ),
  'origin-issue-ai-native-issue-tracker': (
    <>
      <p>
        Jira knows your issues are open. Linear knows they&rsquo;re prioritized. GitHub Issues knows who&rsquo;s assigned. None of them know that fixing <em>AUTH-142</em> took three AI sessions, 47,000 tokens, and $4.80 in Claude API calls.
      </p>
      <p>
        We built <code>origin issue</code> to close that gap. It&rsquo;s an issue tracker designed from scratch for AI agent workflows &mdash; where every issue tracks exactly how much AI time and money went into resolving it.
      </p>

      <h2>The problem with current issue trackers</h2>
      <p>
        When an AI agent fixes a bug, three things happen that no existing tracker captures:
      </p>
      <ul>
        <li><strong>Cost is invisible.</strong> Your team &ldquo;fixed 23 issues this sprint.&rdquo; Great. But did those fixes cost $12 or $200 in AI API calls? Nobody knows.</li>
        <li><strong>Dependencies block agents.</strong> AI agents don&rsquo;t know what&rsquo;s ready to work on. They pick up an issue, hit a blocker that depends on something else, and waste tokens going in circles.</li>
        <li><strong>Session context is lost.</strong> The AI that fixed the bug had a full conversation &mdash; prompts, reasoning, tool calls. Once the PR merges, that context disappears. Three months later when the fix regresses, you start from zero.</li>
      </ul>

      <h2>How origin issue works</h2>
      <p>
        Issues are stored as JSON files in <code>.origin/issues/</code> inside your git repo. No external database, no SaaS dependency. They&rsquo;re git-tracked, so any <code>git clone</code> gets the full issue history.
      </p>

      {/* Create command */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden shadow-2xl">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">~/projects/api-server</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin issue create &quot;Fix rate limiting on login&quot; --type bug --priority 1 --label security</div>
            <div className="text-emerald-400">  &#10003; Created issue <span className="text-white font-bold">ori-a3f2</span>: Fix rate limiting on login</div>
            <div className="text-gray-500">    P1 critical  bug  <span className="text-cyan-400">#security</span></div>
            <div className="h-4" />
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin issue create &quot;Refactor auth middleware&quot; --priority 2 --dep ori-a3f2</div>
            <div className="text-emerald-400">  &#10003; Created issue <span className="text-white font-bold">ori-b1c4</span>: Refactor auth middleware</div>
            <div className="text-gray-500">    P2 high  task</div>
          </div>
        </div>
      </div>

      <p>
        Hash-based IDs (<code>ori-a3f2</code>) prevent collisions when multiple AI agents create issues concurrently. Dependencies are first-class &mdash; not labels, not linked issues, but actual dependency edges that block work.
      </p>

      <h2>The killer feature: <code>origin issue ready</code></h2>
      <p>
        This is the command that makes AI agents productive. Instead of picking a random open issue, the agent asks: <em>&ldquo;What can I actually work on right now?&rdquo;</em>
      </p>

      {/* Ready command */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-emerald-700/50 bg-gradient-to-b from-emerald-950/30 to-[#0a0b14] overflow-hidden shadow-2xl shadow-emerald-900/10">
          <div className="px-4 py-2 border-b border-emerald-800/30 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">Terminal</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin issue ready</div>
            <div className="h-2" />
            <div className="text-emerald-400 font-bold">  Ready to work (2)</div>
            <div className="h-2" />
            <div className="text-gray-100">  <span className="text-green-400">&#9675;</span> <span className="text-gray-500">ori-a3f2</span>  Fix rate limiting on login  <span className="text-red-400">P1 critical</span></div>
            <div className="text-gray-500">    <span className="text-cyan-400">#security</span></div>
            <div className="h-1" />
            <div className="text-gray-100">  <span className="text-green-400">&#9675;</span> <span className="text-gray-500">ori-d8e1</span>  Add caching to API responses  <span className="text-blue-400">P3 medium</span></div>
            <div className="h-4" />
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin issue ready --json  <span className="text-gray-700"># AI agents parse this</span></div>
          </div>
        </div>
      </div>

      <p>
        <code>origin issue ready</code> filters out everything with unresolved dependencies and returns only actionable issues, sorted by priority. The <code>--json</code> flag gives agents structured output they can parse programmatically. This closes the loop: agent calls <code>ready</code>, picks the top issue, works it, links the session, closes it, and the next blocked issue becomes ready.
      </p>

      <h2>Dependency trees</h2>
      <p>
        Real projects have complex dependency chains. <code>origin issue dep tree</code> visualizes the full graph:
      </p>

      {/* Dep tree */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">Terminal</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin issue dep tree ori-c7f3</div>
            <div className="h-2" />
            <div className="text-gray-500">  Dependency tree for <span className="text-white font-bold">ori-c7f3</span></div>
            <div className="h-2" />
            <div className="text-gray-100"><span className="text-yellow-400">&#9675;</span> ori-c7f3 Deploy auth v2 to production <span className="text-gray-600">[open]</span></div>
            <div className="text-gray-100">&ensp;&ensp;&#9492;&#9472;&#9472; <span className="text-yellow-400">&#9675;</span> ori-b1c4 Refactor auth middleware <span className="text-gray-600">[in-progress]</span></div>
            <div className="text-gray-100">&ensp;&ensp;&ensp;&ensp;&ensp;&ensp;&#9492;&#9472;&#9472; <span className="text-green-400">&#10003;</span> ori-a3f2 Fix rate limiting on login <span className="text-gray-600">[closed]</span></div>
          </div>
        </div>
      </div>

      <h2>Session linking &mdash; the cost story</h2>
      <p>
        When an AI agent finishes working on an issue, link the session:
      </p>

      {/* Link + show */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">Terminal</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin issue link ori-a3f2 a3f1e2d8</div>
            <div className="text-emerald-400">  &#10003; Linked session a3f1e2d8 to ori-a3f2</div>
            <div className="h-4" />
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin issue show ori-a3f2</div>
            <div className="h-2" />
            <div className="text-white font-bold">  ori-a3f2  Fix rate limiting on login</div>
            <div className="h-2" />
            <div className="text-gray-300">  Status:     <span className="text-gray-500">&#10003;</span> closed</div>
            <div className="text-gray-300">  Type:       bug</div>
            <div className="text-gray-300">  Priority:   <span className="text-red-400">P1 critical</span></div>
            <div className="text-gray-300">  Labels:     <span className="text-cyan-400">#security</span></div>
            <div className="text-gray-300">  Sessions:   <span className="text-gray-500">a3f1e2d8, b7c2d4e9</span></div>
            <div className="text-gray-300">  Created:    2026-04-13T09:00:00Z (4h ago)</div>
            <div className="text-gray-300">  Closed:     2026-04-13T13:14:22Z (15m ago)</div>
          </div>
        </div>
      </div>

      <p>
        Now go to the Origin dashboard. Open the repo. Click <strong className="text-gray-100">Issues</strong>. Every issue shows its linked sessions with full cost breakdown &mdash; tokens, duration, model, lines changed. The stats cards at the top aggregate everything: <em>&ldquo;Your team spent $47 on issues this sprint. Top issue: auth refactor ($18, 5 sessions).&rdquo;</em>
      </p>

      {/* Dashboard mock */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden shadow-xl">
          <div className="px-4 py-2 border-b border-gray-800">
            <span className="text-[10px] text-gray-600">getorigin.io/repos/api-server/issues</span>
          </div>
          <div className="p-5 space-y-4">
            {/* Stats row */}
            <div className="grid grid-cols-5 gap-3">
              {[
                { label: 'Open', value: '7', color: 'text-green-400' },
                { label: 'In Progress', value: '3', color: 'text-cyan-400' },
                { label: 'Blocked', value: '2', color: 'text-red-400' },
                { label: 'Closed', value: '14', color: 'text-gray-400' },
                { label: 'Total AI Cost', value: '$47.20', color: 'text-indigo-400' },
              ].map(({ label, value, color }) => (
                <div key={label} className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
                  <div className={`text-lg font-bold ${color}`}>{value}</div>
                  <div className="text-[9px] text-gray-600 uppercase tracking-wider">{label}</div>
                </div>
              ))}
            </div>
            {/* Top issues */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/30 p-3">
              <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-2">Top Issues by AI Cost</div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-gray-300"><span className="text-gray-600">ori-e2d1</span> Auth middleware refactor</span><span className="text-indigo-400">$18.40 &middot; 5 sessions</span></div>
                <div className="flex justify-between"><span className="text-gray-300"><span className="text-gray-600">ori-a3f2</span> Fix rate limiting on login</span><span className="text-indigo-400">$4.80 &middot; 2 sessions</span></div>
                <div className="flex justify-between"><span className="text-gray-300"><span className="text-gray-600">ori-f4a7</span> Add pagination to user list</span><span className="text-indigo-400">$3.12 &middot; 1 session</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <h2>All commands</h2>
      <p>The full CLI surface area:</p>

      {/* Commands table */}
      <div className="not-prose my-8 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left py-2 text-gray-500 font-medium">Command</th>
              <th className="text-left py-2 text-gray-500 font-medium">Description</th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            <tr className="border-b border-gray-800/50"><td className="py-2 font-mono text-indigo-400">origin issue create &lt;title&gt;</td><td className="py-2">Create with --type, --priority, --label, --dep</td></tr>
            <tr className="border-b border-gray-800/50"><td className="py-2 font-mono text-indigo-400">origin issue list</td><td className="py-2">Filter by --status, --priority, --label, --type</td></tr>
            <tr className="border-b border-gray-800/50"><td className="py-2 font-mono text-indigo-400">origin issue show &lt;id&gt;</td><td className="py-2">Full detail with deps and linked sessions</td></tr>
            <tr className="border-b border-gray-800/50"><td className="py-2 font-mono text-indigo-400">origin issue update &lt;id&gt;</td><td className="py-2">Change status, priority, title, labels</td></tr>
            <tr className="border-b border-gray-800/50"><td className="py-2 font-mono text-indigo-400">origin issue close &lt;id&gt;</td><td className="py-2">Close an issue (unblocks dependents)</td></tr>
            <tr className="border-b border-gray-800/50"><td className="py-2 font-mono text-emerald-400">origin issue ready</td><td className="py-2">Show only unblocked issues &mdash; <strong>the killer feature</strong></td></tr>
            <tr className="border-b border-gray-800/50"><td className="py-2 font-mono text-indigo-400">origin issue blocked</td><td className="py-2">Show issues waiting on dependencies</td></tr>
            <tr className="border-b border-gray-800/50"><td className="py-2 font-mono text-indigo-400">origin issue link &lt;id&gt; &lt;session&gt;</td><td className="py-2">Link an AI session to an issue</td></tr>
            <tr className="border-b border-gray-800/50"><td className="py-2 font-mono text-indigo-400">origin issue dep add/remove</td><td className="py-2">Manage dependencies</td></tr>
            <tr><td className="py-2 font-mono text-indigo-400">origin issue dep tree &lt;id&gt;</td><td className="py-2">Visualize the dependency graph</td></tr>
          </tbody>
        </table>
      </div>

      <p>
        Every command supports <code>--json</code> for programmatic use. AI agents parse it. Humans get colored terminal output. Same data, different presentations.
      </p>

      <h2>Why this matters</h2>
      <p>
        The issue tracker you use shapes how you work. Jira was built for human sprints. Linear was built for fast-moving teams. <code>origin issue</code> is built for a world where AI agents do most of the coding and the question isn&rsquo;t &ldquo;who&rsquo;s assigned?&rdquo; but &ldquo;how much did this cost and what should the agent work on next?&rdquo;
      </p>
      <p>
        Try it today:
      </p>

      {/* Install */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-indigo-700/50 bg-gradient-to-b from-indigo-950/30 to-[#0a0b14] overflow-hidden">
          <div className="p-5 font-mono text-sm">
            <div className="text-gray-300"><span className="text-indigo-400">$</span> npm i -g https://getorigin.io/cli/origin-cli-latest.tgz</div>
            <div className="text-gray-300"><span className="text-indigo-400">$</span> origin issue create &quot;My first issue&quot; --type feature --priority 2</div>
          </div>
        </div>
      </div>
    </>
  ),
  'repositories-sentry-for-ai-code': (
    <>
      <p>
        If you&rsquo;ve used Sentry, you know the pattern: connect your repos, and suddenly errors aren&rsquo;t just stack traces &mdash; they&rsquo;re linked to commits, releases, and the developers who wrote the code. Sentry turned &ldquo;something broke&rdquo; into &ldquo;this commit by this person in this PR broke this function.&rdquo;
      </p>
      <p>
        Origin does the same thing for AI-written code. Connect your repositories, and every commit gets tagged with <strong className="text-gray-100">who (or what) actually wrote it</strong> &mdash; which AI agent, which model, which session, which prompt, and how much it cost.
      </p>

      <h2>Why repositories matter</h2>
      <p>
        Without repo-level tracking, AI coding data is just floating sessions. You know <em>someone</em> used Claude for 47 minutes, but you don&rsquo;t know <em>what they built</em>. Repositories anchor everything to real code:
      </p>
      <ul>
        <li><strong>Every commit is classified</strong> &mdash; AI-authored, human-authored, or mixed. Not by heuristics &mdash; by actual session data from the agent that wrote it.</li>
        <li><strong>AI authorship percentage</strong> is tracked per-repo over time. You can see your codebase shifting from 20% AI to 60% AI across months.</li>
        <li><strong>Sessions link to commits</strong> &mdash; click any session and see exactly which commits it produced. Click any commit and see the full AI session behind it.</li>
        <li><strong>Cost maps to code</strong> &mdash; not just &ldquo;we spent $400 on Claude this month&rdquo; but &ldquo;the auth module cost $120 across 8 sessions in the api-server repo.&rdquo;</li>
      </ul>

      <h2>How it works</h2>

      {/* Step 1: Import */}
      <h3>1. Import from GitHub or GitLab</h3>
      <p>
        Connect your GitHub org or GitLab group, and Origin discovers all your repos. One click to import. Origin pulls your full commit history and starts classifying every commit as AI or human.
      </p>

      {/* GitHub import mock */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-700/50 bg-gray-900/80 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-300">Import from GitHub</span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-800/40">Connected</span>
          </div>
          <div className="divide-y divide-gray-800/50">
            {[
              { name: 'api-server', lang: 'TypeScript', commits: 1247, selected: true },
              { name: 'web-dashboard', lang: 'TypeScript', commits: 892, selected: true },
              { name: 'mobile-app', lang: 'Swift', commits: 634, selected: false },
              { name: 'ml-pipeline', lang: 'Python', commits: 2103, selected: true },
            ].map((repo) => (
              <div key={repo.name} className="px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-4 h-4 rounded border ${repo.selected ? 'bg-emerald-500 border-emerald-500' : 'border-gray-600'} flex items-center justify-center`}>
                    {repo.selected && <span className="text-[10px] text-white">&#10003;</span>}
                  </div>
                  <span className="text-sm text-gray-200 font-mono">{repo.name}</span>
                  <span className="text-[10px] text-gray-500">{repo.lang}</span>
                </div>
                <span className="text-xs text-gray-500">{repo.commits.toLocaleString()} commits</span>
              </div>
            ))}
          </div>
          <div className="px-4 py-3 border-t border-gray-800 flex justify-end">
            <span className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium">Import 3 repos</span>
          </div>
        </div>
      </div>

      <h3>2. Automatic commit sync</h3>
      <p>
        Once imported, Origin keeps your repos in sync. Every new commit is pulled automatically &mdash; no webhooks required (though you can add them for instant sync). Origin classifies each commit by checking:
      </p>
      <ul>
        <li>Was there an active Origin session when this commit was made?</li>
        <li>Does the commit message contain <code>Co-Authored-By</code> markers from AI agents?</li>
        <li>Does the author match a known AI bot pattern?</li>
      </ul>

      {/* Commit list mock */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-700/50 bg-gray-900/80 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-300">api-server</span>
              <span className="text-[10px] text-gray-500">main</span>
            </div>
            <div className="flex gap-2 text-[10px]">
              <span className="text-indigo-400">AI 43%</span>
              <span className="text-gray-500">&middot;</span>
              <span className="text-gray-400">Human 57%</span>
            </div>
          </div>
          <div className="divide-y divide-gray-800/30">
            {[
              { sha: 'a1b2c3d', msg: 'Add rate limiting to auth endpoints', add: 147, del: 12, author: 'claude', tag: 'AI' },
              { sha: 'e4f5g6h', msg: 'Fix password validation edge case', add: 8, del: 3, author: 'alex', tag: 'Human' },
              { sha: 'i7j8k9l', msg: 'Refactor database connection pool', add: 89, del: 45, author: 'claude', tag: 'AI' },
              { sha: 'm0n1o2p', msg: 'Update README with deployment docs', add: 34, del: 5, author: 'sarah', tag: 'Human' },
              { sha: 'q3r4s5t', msg: 'Add webhook retry queue with exponential backoff', add: 203, del: 0, author: 'cursor', tag: 'AI' },
            ].map((c) => (
              <div key={c.sha} className="px-4 py-2 flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-gray-500 w-16">{c.sha}</span>
                  <span className="text-gray-300 truncate max-w-[300px]">{c.msg}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-green-500">+{c.add}</span>
                  <span className="text-red-400">-{c.del}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${c.tag === 'AI' ? 'bg-indigo-900/40 text-indigo-300 border border-indigo-800/40' : 'bg-gray-800/60 text-gray-400 border border-gray-700/40'}`}>{c.tag}</span>
                  <span className="text-gray-500 w-14 text-right">{c.author}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <h3>3. AI authorship ratio</h3>
      <p>
        Every repo gets an AI authorship bar showing the split over time. This isn&rsquo;t a guess &mdash; it&rsquo;s calculated from actual session data. You can filter to see only AI-authored or human-authored commits, and drill into any commit to see the full session that produced it.
      </p>

      <h2>The API: build on top of Origin</h2>
      <p>
        Just like Sentry gives you an API to query errors programmatically, Origin exposes a full REST API for repositories. Everything you see in the dashboard is available via API.
      </p>

      {/* API endpoints mock */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-700/50 bg-gray-900/80 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <span className="text-sm font-medium text-gray-300">Repository API</span>
            <span className="text-[10px] text-gray-500 ml-2">api.getorigin.io/api/v1</span>
          </div>
          <div className="divide-y divide-gray-800/30 font-mono text-xs">
            {[
              { method: 'GET', path: '/repos', desc: 'List all repos in your org' },
              { method: 'POST', path: '/repos', desc: 'Register a new repo' },
              { method: 'GET', path: '/repos/:id', desc: 'Get repo details + AI stats' },
              { method: 'GET', path: '/repos/:id/commits', desc: 'List commits with AI/human tags' },
              { method: 'GET', path: '/repos/:id/commits/:sha', desc: 'Get commit detail + linked session' },
              { method: 'GET', path: '/repos/:id/commits/:sha/diff', desc: 'Get commit diff with AI line attribution' },
              { method: 'GET', path: '/repos/:id/branches', desc: 'List branches with commit counts' },
              { method: 'POST', path: '/repos/:id/sync', desc: 'Trigger manual sync from remote' },
              { method: 'GET', path: '/repos/:id/health', desc: 'Sync status, webhook health, last activity' },
              { method: 'POST', path: '/repos/github/import', desc: 'Bulk import from GitHub org' },
              { method: 'POST', path: '/repos/gitlab/import', desc: 'Bulk import from GitLab group' },
            ].map((ep) => (
              <div key={ep.path + ep.method} className="px-4 py-2 flex items-center gap-3">
                <span className={`w-12 text-center text-[10px] font-bold rounded px-1 py-0.5 ${ep.method === 'GET' ? 'bg-blue-900/40 text-blue-300' : 'bg-green-900/40 text-green-300'}`}>{ep.method}</span>
                <span className="text-gray-300 w-64">{ep.path}</span>
                <span className="text-gray-500">{ep.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <h3>Example: query AI authorship for a repo</h3>

      {/* API request/response mock */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-emerald-700/50 bg-gradient-to-b from-emerald-950/30 to-[#0a0b14] overflow-hidden">
          <div className="px-4 py-2 border-b border-emerald-800/30 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">curl</span>
          </div>
          <div className="p-4 font-mono text-xs">
            <div className="text-gray-400">
              <span className="text-emerald-400">$</span>{' '}
              <span className="text-gray-300">curl -H &quot;Authorization: Bearer $ORIGIN_API_KEY&quot; \</span>
            </div>
            <div className="text-gray-300 ml-4">https://getorigin.io/api/v1/repos/:id/commits?aiOnly=true</div>
            <div className="mt-3 text-gray-500"># Response:</div>
            <div className="text-gray-300">{'{'}</div>
            <div className="text-gray-300 ml-4">&quot;commits&quot;: [</div>
            <div className="text-gray-300 ml-8">{'{'}</div>
            <div className="text-gray-300 ml-12">&quot;sha&quot;: &quot;a1b2c3d&quot;,</div>
            <div className="text-gray-300 ml-12">&quot;message&quot;: &quot;Add rate limiting to auth endpoints&quot;,</div>
            <div className="text-indigo-300 ml-12">&quot;aiTool&quot;: &quot;claude-code&quot;,</div>
            <div className="text-indigo-300 ml-12">&quot;aiModel&quot;: &quot;claude-opus-4-6&quot;,</div>
            <div className="text-indigo-300 ml-12">&quot;sessionId&quot;: &quot;ses_abc123&quot;,</div>
            <div className="text-amber-300 ml-12">&quot;costUsd&quot;: 0.47,</div>
            <div className="text-amber-300 ml-12">&quot;tokensUsed&quot;: 84200,</div>
            <div className="text-gray-300 ml-12">&quot;filesChanged&quot;: [&quot;src/auth.ts&quot;, &quot;src/middleware/rate-limit.ts&quot;],</div>
            <div className="text-gray-300 ml-12">&quot;linesAdded&quot;: 147,</div>
            <div className="text-gray-300 ml-12">&quot;linesDeleted&quot;: 12</div>
            <div className="text-gray-300 ml-8">{'}'},</div>
            <div className="text-gray-500 ml-8">// ...</div>
            <div className="text-gray-300 ml-4">],</div>
            <div className="text-gray-300 ml-4">&quot;total&quot;: 537,</div>
            <div className="text-gray-300 ml-4">&quot;aiPercentage&quot;: 43</div>
            <div className="text-gray-300">{'}'}</div>
          </div>
        </div>
      </div>

      <h2>What you can build with the API</h2>
      <p>
        The repo API unlocks integrations that weren&rsquo;t possible before:
      </p>
      <ul>
        <li><strong>CI/CD gates</strong> &mdash; block deploys if AI authorship exceeds a threshold without human review</li>
        <li><strong>Slack/Teams alerts</strong> &mdash; &ldquo;api-server just crossed 50% AI authorship this sprint&rdquo;</li>
        <li><strong>Compliance reports</strong> &mdash; auto-generate per-repo AI usage reports for SOC 2 audits</li>
        <li><strong>Cost dashboards</strong> &mdash; pipe per-repo AI costs into your internal analytics</li>
        <li><strong>PR reviewers</strong> &mdash; annotate pull requests with which lines were AI-generated and the prompts behind them</li>
      </ul>

      <h2>The Sentry analogy</h2>
      <p>
        Before Sentry, errors were log lines. After Sentry, errors were <em>incidents</em> &mdash; linked to commits, releases, users, and teams. The data was always there; Sentry just made it structured and queryable.
      </p>
      <p>
        AI coding data is in the same state today. The sessions happen, the code gets committed, but nothing connects them. Origin is the layer that makes AI coding <em>observable</em> &mdash; structured, queryable, and actionable. Repositories are where that data meets your actual codebase.
      </p>

      <h2>Get started</h2>
      <p>
        Import your first repo in under 2 minutes. Connect GitHub or GitLab on the Integrations page, then import repos from Settings. Or use the CLI:
      </p>

      <div className="not-prose my-6">
        <div className="rounded-xl border border-gray-700/50 bg-gray-900/80 overflow-hidden">
          <div className="p-4 font-mono text-sm">
            <div className="text-gray-300"><span className="text-emerald-400">$</span> origin init</div>
            <div className="text-gray-500 mt-1">  Auto-detects repos, installs hooks, starts tracking.</div>
          </div>
        </div>
      </div>

      <p>
        <a href="/register?type=developer" className="text-emerald-400 hover:text-emerald-300 font-medium">Start tracking your repos &rarr;</a>
      </p>
    </>
  ),
  'origin-why-line-level-prompt-attribution': (
    <>
      <p>
        It&rsquo;s Monday morning. A production bug landed over the weekend. You open the file, jump to the broken line, and ask the question every developer asks a hundred times a week:
      </p>
      <p className="text-center text-xl text-gray-200 italic my-6">
        &ldquo;Why is this line here?&rdquo;
      </p>
      <p>
        You run <code>git blame</code>. It tells you <em>Alex committed this three weeks ago</em>. Cool. But Alex didn&rsquo;t <em>write</em> it. Claude did. In a session that lasted 47 minutes and cost $3.20 and had 8 prompts. And now Alex is on vacation and nobody on the team remembers why that line exists at all.
      </p>
      <p>
        This is the AI coding era&rsquo;s most annoying papercut. We can ship 5x faster, but we&rsquo;ve lost the ability to ask <em>why</em>. Today we&rsquo;re fixing it with one command:
      </p>

      {/* The hero command */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-emerald-700/50 bg-gradient-to-b from-emerald-950/30 to-[#0a0b14] overflow-hidden shadow-2xl shadow-emerald-900/10">
          <div className="px-4 py-2 border-b border-emerald-800/30 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">~/projects/api-server</span>
          </div>
          <div className="p-5 font-mono text-sm">
            <div className="text-gray-300">
              <span className="text-emerald-400">$</span> origin why <span className="text-indigo-300">src/auth.ts:42</span>
            </div>
          </div>
        </div>
      </div>

      <h2>What you actually see</h2>
      <p>
        Run <code>origin why</code> on any line in any file tracked by Origin. In under a second, you get the full story of that line &mdash; who wrote it, when, which AI session, which prompt, and why.
      </p>

      {/* Main output mock */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">Terminal</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin why src/auth.ts:42</div>
            <div className="h-2" />
            <div className="text-gray-100 font-bold">  Line 42 in src/auth.ts</div>
            <div className="text-gray-500">  if (!bcrypt.compareSync(password, user.passwordHash)) throw new AuthError(&apos;invalid&apos;);</div>
            <div className="h-2" />
            <div className="text-gray-200">  Written by <span className="text-cyan-400">claude-sonnet-4</span> &middot; Apr 7, 2026 &middot; Session <span className="text-cyan-400">a3f1e2d8</span></div>
            <div className="text-emerald-400">  Prompt: &ldquo;add user authentication with JWT and bcrypt, hash passwords on signup&rdquo;</div>
            <div className="text-gray-600">  Files: src/auth.ts, src/models/user.ts, src/routes/login.ts</div>
            <div className="h-2" />
            <div className="text-gray-600">  Session: 8 turns &middot; $3.24 &middot; 5 files &middot; 47m</div>
            <div className="text-gray-600">  Run <span className="text-cyan-400">origin explain a3f1e2d8</span> for full details</div>
          </div>
        </div>
      </div>

      <p>
        That&rsquo;s the whole mystery solved in one screen. You know the <strong className="text-gray-100">agent</strong> (Claude Sonnet 4), the <strong className="text-gray-100">prompt</strong> (&ldquo;add user authentication with JWT and bcrypt&rdquo;), the <strong className="text-gray-100">session</strong>, and what it <strong className="text-gray-100">cost</strong>. No Slack threads. No digging through PR comments. No asking Alex on vacation.
      </p>

      <h2>File-level mode</h2>
      <p>
        Drop the line number and you get a bird&rsquo;s-eye view of the whole file &mdash; how much of it is AI, how much is human, and which sessions contributed.
      </p>

      {/* File mode output */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            </div>
            <span className="text-[10px] text-gray-600 ml-2">Terminal</span>
          </div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1">
            <div className="text-gray-500"><span className="text-emerald-400">$</span> origin why src/auth.ts</div>
            <div className="h-2" />
            <div className="text-gray-100 font-bold">  src/auth.ts</div>
            <div className="text-gray-500">  184 lines &mdash; <span className="text-emerald-400">78% AI (143)</span> &middot; <span className="text-gray-200">22% human (41)</span></div>
            <div className="h-2" />
            <div>
              <span className="text-cyan-400">  claude-sonnet-4     </span>
              <span className="text-emerald-400"> 112 lines   61%</span>
              <span className="text-gray-600">  session a3f1e2d8</span>
            </div>
            <div>
              <span className="text-cyan-400">  cursor-composer     </span>
              <span className="text-emerald-400">  31 lines   17%</span>
              <span className="text-gray-600">  session 9b2c4e1a</span>
            </div>
            <div>
              <span className="text-gray-200">  Human               </span>
              <span>  41 lines   22%</span>
            </div>
            <div className="h-2" />
            <div className="text-gray-600">  Tip: <span className="text-cyan-400">origin why src/auth.ts:42</span> to see which prompt wrote a specific line</div>
          </div>
        </div>
      </div>

      <h2>How it works under the hood</h2>
      <p>
        <code>origin why</code> chains four boring-but-critical pieces of data together. None of them are magic &mdash; they&rsquo;ve been quietly building up in your repo since the day you installed Origin.
      </p>

      {/* How it works flow */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-gradient-to-b from-gray-950 to-[#0a0b14] p-6 sm:p-8">
          <p className="text-[11px] text-gray-500 font-medium uppercase tracking-widest text-center mb-6">From line number to prompt</p>
          <div className="space-y-3">
            {[
              { n: '1', title: 'git blame', sub: 'Find the commit SHA that last touched the line', color: 'border-gray-700 bg-gray-900/40' },
              { n: '2', title: 'git notes --ref=origin', sub: 'Pull Origin session metadata attached to that commit', color: 'border-indigo-700/60 bg-indigo-950/20' },
              { n: '3', title: 'Session API lookup', sub: 'Fetch all prompts, diffs and file changes for the session', color: 'border-indigo-700/60 bg-indigo-950/20' },
              { n: '4', title: 'Prompt match', sub: 'Walk prompts in reverse, match by file + diff hunk + content', color: 'border-emerald-600/60 bg-emerald-950/20' },
            ].map((step) => (
              <div key={step.n} className={`flex items-start gap-4 ${step.color} border rounded-lg px-4 py-3`}>
                <div className="w-7 h-7 rounded-full bg-gray-900 border border-gray-700 flex items-center justify-center text-xs text-gray-300 font-mono font-bold flex-shrink-0">{step.n}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-100 font-mono">{step.title}</div>
                  <div className="text-[11px] text-gray-500 mt-0.5">{step.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p>
        The clever bit is step 4. A single session can contain 10 prompts, each one editing the same file. To figure out which <em>specific prompt</em> wrote a given line, Origin walks the session&rsquo;s prompt history in reverse, checks which prompts touched that file, and matches the line content against the added lines in each prompt&rsquo;s diff. The most recent matching prompt wins.
      </p>

      <h2>Why this matters</h2>
      <p>
        Debugging AI-written code used to feel like archaeology. You&rsquo;d find a strange pattern, a questionable dependency, a weird comment, and have no way to reconstruct the reasoning. The developer didn&rsquo;t write it &mdash; they just accepted it. The AI that wrote it is long gone, its session buried in a log file somewhere.
      </p>

      {/* Before/after comparison */}
      <div className="not-prose my-8 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-red-900/40 bg-red-950/10 p-5">
          <div className="text-[10px] font-medium text-red-400 uppercase tracking-widest mb-3">Before</div>
          <div className="space-y-2 text-sm text-gray-400">
            <p>&ldquo;Alex, why is this bcrypt call using compareSync instead of compare?&rdquo;</p>
            <p className="text-gray-600 italic">&mdash; Alex is on vacation &mdash;</p>
            <p>&ldquo;I&rsquo;ll just rewrite it.&rdquo;</p>
          </div>
          <div className="mt-4 pt-3 border-t border-red-900/30 text-[11px] text-red-400/70">
            45 minutes lost &middot; potential bug reintroduced
          </div>
        </div>
        <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/10 p-5">
          <div className="text-[10px] font-medium text-emerald-400 uppercase tracking-widest mb-3">After</div>
          <div className="space-y-2 text-sm text-gray-300">
            <p className="font-mono text-xs text-emerald-300">$ origin why src/auth.ts:42</p>
            <p>&ldquo;Ah, Claude used compareSync because the prompt was &lsquo;make login synchronous for the test suite.&rsquo; Now I know what to fix.&rdquo;</p>
          </div>
          <div className="mt-4 pt-3 border-t border-emerald-900/30 text-[11px] text-emerald-400/70">
            30 seconds &middot; full context recovered
          </div>
        </div>
      </div>

      <p>
        <code>origin why</code> turns AI-generated code from a black box into a first-class artifact with full provenance. The prompt is the intent. The session is the reasoning. The diff is the execution. Now they&rsquo;re all one command away.
      </p>

      <h2>Code review just got weird (in a good way)</h2>
      <p>
        Once you start using it, you notice something: code review habits change. Instead of asking &ldquo;why did you write this?&rdquo; in a PR comment, reviewers run <code>origin why</code> on the suspicious line and see the original prompt. If the prompt was lazy (&ldquo;fix the auth&rdquo;), that&rsquo;s a signal. If the prompt was precise (&ldquo;refactor auth to use async bcrypt.compare with proper error handling&rdquo;), that&rsquo;s another signal.
      </p>
      <p>
        You&rsquo;re not just reviewing code anymore. You&rsquo;re reviewing the <em>prompt quality</em> of your team.
      </p>

      <h2>Try it</h2>
      <p>
        Upgrade the CLI and point it at any file in a repo that already has Origin sessions:
      </p>

      {/* Install / try block */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-[#0a0b14] overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 text-[10px] text-gray-600">Terminal</div>
          <div className="p-5 font-mono text-xs leading-relaxed space-y-1.5">
            <div><span className="text-gray-600"># upgrade</span></div>
            <div><span className="text-emerald-400">$</span> <span className="text-gray-200">npm i -g @origin/cli</span></div>
            <div className="h-2" />
            <div><span className="text-gray-600"># ask why a specific line exists</span></div>
            <div><span className="text-emerald-400">$</span> <span className="text-gray-200">origin why src/auth.ts:42</span></div>
            <div className="h-2" />
            <div><span className="text-gray-600"># file-level attribution summary</span></div>
            <div><span className="text-emerald-400">$</span> <span className="text-gray-200">origin why src/auth.ts</span></div>
          </div>
        </div>
      </div>

      <p>
        It works in connected mode (full prompt text from the platform) and local-only mode (session summary from git notes). If the line was committed before Origin was installed, you&rsquo;ll see the human author and a helpful note &mdash; no false attribution.
      </p>
      <p>
        This is the question every developer has been silently asking AI-generated code for the last two years. Finally, there&rsquo;s an answer.
      </p>
      <p>
        <a href="/register?type=developer" className="text-emerald-400 hover:text-emerald-300 font-medium">Start tracking your AI sessions &rarr;</a>
      </p>
    </>
  ),
  'new-era-source-code-management-ai': (
    <>
      <p>
        Something fundamental has changed in how software gets built. In the last twelve months, AI coding agents &mdash; Claude Code, Cursor, Gemini CLI, Codex &mdash; went from novelty to infrastructure. Teams that adopted them aren&rsquo;t writing 10% more code. They&rsquo;re writing 3&ndash;5x more. Entire features ship in hours instead of days.
      </p>
      <p>
        But here&rsquo;s the problem nobody talks about: <strong className="text-gray-100">git has no idea any of this happened.</strong>
      </p>
      <p>
        Every commit still shows a human author. Every <code>git blame</code> line points to the developer who hit Enter, not the AI that generated 200 lines of authentication middleware. The most important shift in software engineering history is invisible to the tools we rely on.
      </p>
      <p>
        That&rsquo;s why we built Origin.
      </p>

      <h2>The Five Blind Spots</h2>
      <p>
        Talk to any engineering leader running AI agents across their team, and you&rsquo;ll hear the same questions:
      </p>
      <ol>
        <li><strong className="text-gray-100">Who wrote this code?</strong> &mdash; A commit authored by dev@company.com could be 100% AI-generated. <code>Co-Authored-By</code> headers are unreliable. Most agents don&rsquo;t add them.</li>
        <li><strong className="text-gray-100">What are we spending?</strong> &mdash; Claude API bills hit $2K/month and nobody knows which developer or project is driving cost. Token usage is invisible at the team level.</li>
        <li><strong className="text-gray-100">What can AI touch?</strong> &mdash; Should AI agents be modifying production configs? Payment processing logic? There&rsquo;s no enforcement layer.</li>
        <li><strong className="text-gray-100">What context was lost?</strong> &mdash; A developer works with Claude for 3 hours, stops, and resumes the next day. The session context, prompts, and reasoning are gone.</li>
        <li><strong className="text-gray-100">Can we prove compliance?</strong> &mdash; SOC 2 auditors ask &ldquo;who reviewed this code?&rdquo; and the answer is &ldquo;an AI wrote it and the developer committed it without review.&rdquo;</li>
      </ol>
      <p>
        These aren&rsquo;t theoretical problems. They&rsquo;re happening today in every engineering org that adopted AI coding tools.
      </p>

      <h2>Why Git Isn&rsquo;t Enough</h2>
      <p>
        Git is brilliant at tracking <em>changes</em>. It was never designed to track <em>intent</em>. Here&rsquo;s what a standard <code>git blame</code> looks like on AI-authored code:
      </p>

      {/* Visual: git blame vs origin blame */}
      <div className="not-prose my-8 space-y-4">
        <div className="rounded-xl border border-gray-800 bg-[#0d0e1a] overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2">
            <span className="text-xs text-red-400 font-mono font-medium">$ git blame src/auth.ts</span>
            <span className="text-[10px] text-gray-600 ml-auto">Standard git</span>
          </div>
          <div className="px-4 py-3 font-mono text-xs space-y-0.5 text-gray-400 overflow-x-auto">
            <div>a3f1e2d (Alex Kim  2026-04-07) <span className="text-gray-500">import jwt from &apos;jsonwebtoken&apos;;</span></div>
            <div>a3f1e2d (Alex Kim  2026-04-07) <span className="text-gray-500">import bcrypt from &apos;bcryptjs&apos;;</span></div>
            <div>a3f1e2d (Alex Kim  2026-04-07) <span className="text-gray-500"></span></div>
            <div>a3f1e2d (Alex Kim  2026-04-07) <span className="text-gray-500">export async function authenticate(email, password) {'{'}</span></div>
            <div>a3f1e2d (Alex Kim  2026-04-07) <span className="text-gray-500">  const user = await db.user.findUnique({'{'} where: {'{'} email {'}'} {'}'});</span></div>
            <div>a3f1e2d (Alex Kim  2026-04-07) <span className="text-gray-500">  if (!user) throw new AuthError(&apos;not_found&apos;);</span></div>
            <div className="text-gray-600 mt-1">... every line shows &ldquo;Alex Kim&rdquo; &mdash; who actually wrote this?</div>
          </div>
        </div>
        <div className="rounded-xl border border-emerald-800/50 bg-[#0d0e1a] overflow-hidden">
          <div className="px-4 py-2 border-b border-emerald-800/30 flex items-center gap-2">
            <span className="text-xs text-emerald-400 font-mono font-medium">$ origin blame src/auth.ts</span>
            <span className="text-[10px] text-emerald-600 ml-auto">With Origin</span>
          </div>
          <div className="px-4 py-3 font-mono text-xs space-y-0.5 overflow-x-auto">
            <div><span className="text-indigo-400 font-bold">[AI]</span> <span className="text-gray-500">a3f1e2d</span> <span className="text-gray-400">import jwt from &apos;jsonwebtoken&apos;;</span></div>
            <div><span className="text-indigo-400 font-bold">[AI]</span> <span className="text-gray-500">a3f1e2d</span> <span className="text-gray-400">import bcrypt from &apos;bcryptjs&apos;;</span></div>
            <div><span className="text-indigo-400 font-bold">[AI]</span> <span className="text-gray-500">a3f1e2d</span> <span className="text-gray-400"></span></div>
            <div><span className="text-indigo-400 font-bold">[AI]</span> <span className="text-gray-500">a3f1e2d</span> <span className="text-gray-400">export async function authenticate(email, password) {'{'}</span></div>
            <div><span className="text-emerald-400 font-bold">[HU]</span> <span className="text-gray-500">b7c2d4e</span> <span className="text-gray-400">  const user = await db.user.findUnique({'{'} where: {'{'} email {'}'} {'}'});</span></div>
            <div><span className="text-indigo-400 font-bold">[AI]</span> <span className="text-gray-500">a3f1e2d</span> <span className="text-gray-400">  if (!user) throw new AuthError(&apos;not_found&apos;);</span></div>
            <div className="text-emerald-600 mt-1">Line-level attribution: AI vs human, per line</div>
          </div>
        </div>
      </div>

      <p>
        The first output tells you nothing useful. The second tells you exactly which lines the AI wrote and which the human edited. That&rsquo;s the difference between flying blind and having full visibility.
      </p>

      <h2>How Origin Works</h2>
      <p>
        Origin sits between your AI coding agent and git. It&rsquo;s not a new version control system &mdash; it&rsquo;s an <em>attribution layer</em> that makes git AI-aware.
      </p>

      {/* Architecture diagram */}
      <div className="not-prose my-10">
        <div className="rounded-xl border border-gray-800 bg-gradient-to-b from-gray-950 to-[#0a0b14] p-6 sm:p-8">
          <p className="text-[11px] text-gray-500 font-medium uppercase tracking-widest text-center mb-6">How Origin Works</p>
          {/* Desktop: horizontal flow */}
          <div className="hidden sm:flex items-stretch justify-center gap-0">
            {[
              { label: 'AI Agent', sub: 'Claude Code, Cursor,\nGemini, Codex', icon: '🤖', border: 'border-indigo-700/60', bg: 'bg-indigo-950/30', glow: 'shadow-indigo-900/20' },
              { label: 'Git Hook', sub: 'Pre-commit &\npost-commit fire', icon: '⚡', border: 'border-gray-700/60', bg: 'bg-gray-900/40', glow: '' },
              { label: 'Origin CLI', sub: 'Detects agent, captures\nsession & attribution', icon: '◈', border: 'border-emerald-600/60', bg: 'bg-emerald-950/30', glow: 'shadow-emerald-900/20' },
              { label: 'Git Notes + API', sub: 'refs/notes/origin\n+ getorigin.io/api', icon: '📦', border: 'border-gray-700/60', bg: 'bg-gray-900/40', glow: '' },
              { label: 'Dashboard', sub: 'Sessions, blame,\ncost & governance', icon: '📊', border: 'border-indigo-700/60', bg: 'bg-indigo-950/30', glow: 'shadow-indigo-900/20' },
            ].map((step, i) => (
              <React.Fragment key={step.label}>
                {i > 0 && (
                  <div className="flex items-center px-1">
                    <div className="w-8 h-[2px] bg-gradient-to-r from-gray-700 to-gray-600" />
                    <div className="w-0 h-0 border-t-[5px] border-t-transparent border-b-[5px] border-b-transparent border-l-[7px] border-l-gray-600" />
                  </div>
                )}
                <div className={`${step.border} ${step.bg} ${step.glow} border rounded-xl px-5 py-5 flex-1 text-center shadow-lg min-w-[140px] max-w-[180px]`}>
                  <div className="text-2xl mb-2">{step.icon}</div>
                  <div className="text-sm font-bold text-gray-100 tracking-tight">{step.label}</div>
                  <div className="text-[11px] text-gray-500 mt-1.5 leading-relaxed whitespace-pre-line">{step.sub}</div>
                </div>
              </React.Fragment>
            ))}
          </div>
          {/* Mobile: vertical flow */}
          <div className="flex sm:hidden flex-col items-center gap-0">
            {[
              { label: 'AI Agent', sub: 'Claude Code, Cursor, Gemini, Codex', icon: '🤖', border: 'border-indigo-700/60', bg: 'bg-indigo-950/30' },
              { label: 'Git Hook', sub: 'Pre-commit & post-commit fire', icon: '⚡', border: 'border-gray-700/60', bg: 'bg-gray-900/40' },
              { label: 'Origin CLI', sub: 'Detects agent, captures session & attribution', icon: '◈', border: 'border-emerald-600/60', bg: 'bg-emerald-950/30' },
              { label: 'Git Notes + API', sub: 'refs/notes/origin + getorigin.io/api', icon: '📦', border: 'border-gray-700/60', bg: 'bg-gray-900/40' },
              { label: 'Dashboard', sub: 'Sessions, blame, cost & governance', icon: '📊', border: 'border-indigo-700/60', bg: 'bg-indigo-950/30' },
            ].map((step, i) => (
              <React.Fragment key={step.label}>
                {i > 0 && (
                  <div className="flex flex-col items-center py-1">
                    <div className="w-[2px] h-6 bg-gradient-to-b from-gray-700 to-gray-600" />
                    <div className="w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[7px] border-t-gray-600" />
                  </div>
                )}
                <div className={`${step.border} ${step.bg} border rounded-xl px-5 py-4 w-full max-w-[280px] text-center`}>
                  <div className="text-xl mb-1">{step.icon}</div>
                  <div className="text-sm font-bold text-gray-100">{step.label}</div>
                  <div className="text-[11px] text-gray-500 mt-1">{step.sub}</div>
                </div>
              </React.Fragment>
            ))}
          </div>
          <p className="text-[11px] text-gray-600 text-center mt-6">Every AI coding session is captured, attributed, and stored &mdash; zero config required</p>
        </div>
      </div>

      <p>
        When a developer uses any AI coding agent, Origin&rsquo;s git hooks fire automatically. The CLI detects which agent is running, reads the session transcript, and writes metadata into git notes. No manual tagging, no workflow changes. It just works.
      </p>

      <h2>Session Replay: See Every Prompt and Decision</h2>
      <p>
        Every AI coding session is captured end-to-end: the prompts the developer gave, the files the AI touched, the exact diff per prompt, token usage, cost, and model. When something breaks in production, you don&rsquo;t just see <em>what</em> changed &mdash; you see <em>why</em> it changed.
      </p>

      {/* Session detail mock */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">Claude Code</span>
              <span className="text-xs text-gray-400">api-server</span>
              <span className="text-xs text-gray-600">main</span>
            </div>
            <div className="flex items-center gap-4 text-[10px] text-gray-500">
              <span>42m</span>
              <span>$4.40</span>
              <span>6.5M tokens</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-500">Done</span>
            </div>
          </div>
          <div className="p-4 space-y-2">
            <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Prompts</p>
            {[
              { prompt: 'add user authentication with JWT and bcrypt', files: 3, lines: '+87 / -12' },
              { prompt: 'write tests for the auth middleware', files: 2, lines: '+124 / -0' },
              { prompt: 'fix the token refresh logic and add rate limiting', files: 1, lines: '+15 / -8' },
            ].map((p, i) => (
              <div key={i} className="bg-gray-900/50 border border-gray-800/50 rounded-lg px-3 py-2 text-xs space-y-1">
                <p className="text-gray-200">&ldquo;{p.prompt}&rdquo;</p>
                <p className="text-[10px] text-gray-600">{p.files} files changed &middot; {p.lines}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <h2>Cost Visibility: Know Where Every Dollar Goes</h2>
      <p>
        When your team is running 5 different AI agents across 20 repos, API costs add up fast. Origin tracks cost per session, per model, per developer, per repo. No more surprise bills.
      </p>

      {/* Cost breakdown */}
      <div className="not-prose my-8">
        <div className="rounded-xl border border-gray-800 bg-gray-950 p-5 space-y-3">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Weekly Cost by Model</p>
          {[
            { model: 'claude-sonnet-4', cost: 142.50, pct: 58, color: 'bg-indigo-500' },
            { model: 'claude-opus-4', cost: 67.20, pct: 27, color: 'bg-purple-500' },
            { model: 'gpt-4o', cost: 23.80, pct: 10, color: 'bg-emerald-500' },
            { model: 'gemini-2.5-pro', cost: 12.30, pct: 5, color: 'bg-amber-500' },
          ].map((m) => (
            <div key={m.model} className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-gray-400 font-mono">{m.model}</span>
                <span className="text-gray-300">${m.cost.toFixed(2)}</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div className={`h-full ${m.color} rounded-full opacity-70`} style={{ width: `${m.pct}%` }} />
              </div>
            </div>
          ))}
          <div className="flex justify-between text-xs pt-2 border-t border-gray-800">
            <span className="text-gray-500">Total this week</span>
            <span className="text-gray-200 font-semibold">$245.80</span>
          </div>
        </div>
      </div>

      <h2>The New SCM Layer</h2>
      <p>
        Think about what GitHub did for git. Git existed. It was powerful. But it was a local tool. GitHub added the collaboration layer &mdash; pull requests, code review, issues, CI/CD &mdash; that made git useful for teams.
      </p>
      <p>
        Origin does the same thing for AI coding. Git exists. It&rsquo;s still the foundation. But it was built for a world where humans write code. Origin adds the <em>AI governance layer</em> &mdash; attribution, session tracking, cost visibility, policy enforcement, audit trails &mdash; that makes git useful for teams using AI agents.
      </p>
      <p>
        This is the new era of source code management. Not because git is broken, but because the way code gets written has fundamentally changed, and our tools need to catch up.
      </p>

      <h2>What&rsquo;s Next</h2>
      <p>
        We&rsquo;re building Origin in public, and the roadmap is driven by what engineering teams actually need:
      </p>
      <ul>
        <li><strong className="text-gray-100">Session chaining</strong> &mdash; automatically linking sessions that span across agent restarts and overnight breaks</li>
        <li><strong className="text-gray-100">Multi-agent orchestration</strong> &mdash; tracking when multiple AI agents work on the same codebase simultaneously</li>
        <li><strong className="text-gray-100">Real-time dashboards</strong> &mdash; live session streaming with token-by-token cost tracking</li>
        <li><strong className="text-gray-100">Compliance reports</strong> &mdash; one-click SOC 2 and ISO 27001 evidence generation</li>
      </ul>
      <p>
        Origin Solo is free forever for individual developers. No limits on repos, sessions, or agents. If you&rsquo;re using AI to write code, you should know what it&rsquo;s writing.
      </p>
      <p>
        <a href="/register?type=developer" className="text-emerald-400 hover:text-emerald-300 font-medium">Get your free account &rarr;</a>
      </p>
    </>
  ),
  'multi-repo-sessions': (
    <>
      <p>
        You&rsquo;re deep in a Claude Code session, building a feature that touches your API server,
        your CLI tool, and your VS Code extension. Three repos, one workspace, one task.
      </p>
      <p>
        Until today, Origin couldn&rsquo;t track that. If your working directory wasn&rsquo;t a git repo,
        the session simply didn&rsquo;t show up. You&rsquo;d open the dashboard and see&hellip; nothing.
      </p>
      <p>
        We fixed that. <strong>Origin now discovers all git repos under your working directory and tracks
        changes across all of them in a single session.</strong> No config. No flags. It just works.
      </p>

      <h2>The problem</h2>
      <p>
        Modern projects don&rsquo;t live in one repo. You might have a monorepo with <code className="text-indigo-400">apps/</code> and <code className="text-indigo-400">packages/</code>,
        or a workspace directory with related repos side by side:
      </p>

      {/* Directory tree mock */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-purple-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">~/my-project</div>
        </div>
        <div className="px-5 py-4 font-mono text-sm space-y-1">
          <div className="text-gray-300">~/my-project/</div>
          <div className="text-gray-500 pl-4">├── <span className="text-indigo-400">api/</span> <span className="text-gray-600">&larr; git repo (Express server)</span></div>
          <div className="text-gray-500 pl-4">├── <span className="text-indigo-400">web/</span> <span className="text-gray-600">&larr; git repo (React app)</span></div>
          <div className="text-gray-500 pl-4">├── <span className="text-indigo-400">cli/</span> <span className="text-gray-600">&larr; git repo (CLI tool)</span></div>
          <div className="text-gray-500 pl-4">└── <span className="text-gray-600">.claude/</span></div>
        </div>
      </div>

      <p>
        When you run <code className="text-indigo-400">claude</code> from <code className="text-indigo-400">~/my-project</code>,
        Claude Code reports that as your working directory. But <code className="text-indigo-400">~/my-project</code> itself
        isn&rsquo;t a git repo &mdash; the repos are inside it. Origin&rsquo;s hooks would bail out and skip tracking entirely.
      </p>

      <h2>How it works now</h2>
      <p>
        When Origin detects that your working directory isn&rsquo;t a git repo, it scans immediate subdirectories
        for <code className="text-indigo-400">.git</code> folders. If it finds multiple repos, it creates a single
        session that tracks all of them.
      </p>

      {/* Session dashboard mock */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-indigo-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">getorigin.io &mdash; Sessions</div>
        </div>
        <div className="px-1 py-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="px-3 py-2 text-left font-medium">Model</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Agent</th>
                <th className="px-3 py-2 text-left font-medium">Repo</th>
                <th className="px-3 py-2 text-left font-medium">Duration</th>
                <th className="px-3 py-2 text-left font-medium">Tokens</th>
                <th className="px-3 py-2 text-left font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {[
                { model: 'CLAUDE-OPUS-4-6', status: 'running', agent: 'Claude Code', repo: 'api, web, cli', dur: '14m', tokens: '89k', cost: '$0.34', age: 'now' },
                { model: 'CLAUDE', status: 'ended', agent: 'Claude Code', repo: 'api', dur: '8m', tokens: '45k', cost: '$0.12', age: '2h ago' },
              ].map((s, i) => (
                <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                  <td className="px-3 py-2.5">
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${i === 0 ? 'bg-indigo-500/20 text-indigo-400' : 'bg-gray-800 text-gray-400'}`}>{s.model}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center gap-1 text-xs ${s.status === 'running' ? 'text-green-400' : 'text-gray-500'}`}>
                      {s.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
                      {s.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-400">{s.agent}</td>
                  <td className="px-3 py-2.5 text-gray-400">{s.repo}</td>
                  <td className="px-3 py-2.5 text-gray-500">{s.dur}</td>
                  <td className="px-3 py-2.5 text-gray-500">{s.tokens}</td>
                  <td className="px-3 py-2.5 text-gray-300">{s.cost}</td>
                  <td className="px-3 py-2.5 text-gray-600 text-right">{s.age}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p>
        Notice the first row: the <strong>Repo</strong> column shows <code className="text-indigo-400">api, web, cli</code> &mdash;
        all three repos tracked in one session. File changes are prefixed with the repo name
        so you know exactly where each change lives.
      </p>

      <h2>What gets tracked per repo</h2>
      <p>
        Origin captures full git state for each repo independently:
      </p>
      <ul>
        <li><strong>HEAD SHA at session start</strong> &mdash; baseline for computing diffs</li>
        <li><strong>Per-prompt diffs</strong> &mdash; what changed in each repo after each prompt</li>
        <li><strong>Branch</strong> &mdash; tracked per repo (they can be on different branches)</li>
        <li><strong>Uncommitted changes</strong> &mdash; filtered to exclude pre-existing dirty files</li>
        <li><strong>File paths</strong> &mdash; prefixed with repo directory name (e.g. <code className="text-indigo-400">api/src/routes/mcp.ts</code>)</li>
      </ul>

      {/* File changes mock */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-purple-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">Session Detail &mdash; Files Changed</div>
        </div>
        <div className="px-5 py-4 space-y-1 font-mono text-xs">
          <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">5 files across 3 repos</div>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-900/50">
            <span className="text-indigo-400">api/</span><span className="text-gray-300">src/routes/mcp.ts</span>
            <span className="text-green-500 ml-auto">+42</span><span className="text-red-400">-8</span>
          </div>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-900/50">
            <span className="text-indigo-400">api/</span><span className="text-gray-300">prisma/schema.prisma</span>
            <span className="text-green-500 ml-auto">+12</span><span className="text-red-400">-0</span>
          </div>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-900/50">
            <span className="text-purple-400">cli/</span><span className="text-gray-300">src/session-state.ts</span>
            <span className="text-green-500 ml-auto">+56</span><span className="text-red-400">-0</span>
          </div>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-900/50">
            <span className="text-purple-400">cli/</span><span className="text-gray-300">src/commands/hooks.ts</span>
            <span className="text-green-500 ml-auto">+144</span><span className="text-red-400">-5</span>
          </div>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-900/50">
            <span className="text-yellow-400">web/</span><span className="text-gray-300">src/pages/Sessions.tsx</span>
            <span className="text-green-500 ml-auto">+3</span><span className="text-red-400">-1</span>
          </div>
        </div>
      </div>

      <h2>Zero configuration</h2>
      <p>
        If you already have Origin enabled (<code className="text-indigo-400">origin enable --agent claude-code</code>),
        multi-repo tracking works automatically. There&rsquo;s nothing to configure. Origin detects the workspace
        structure at session start and adapts.
      </p>
      <p>
        Single-repo sessions work exactly as before. The multi-repo behavior only activates when your working
        directory contains multiple git repos as immediate subdirectories.
      </p>

      <h2>Under the hood</h2>
      <p>
        Here&rsquo;s what happens when you start a session from a multi-repo workspace:
      </p>
      <ol>
        <li>The <code className="text-indigo-400">SessionStart</code> hook fires with your working directory</li>
        <li>Origin checks if the directory is a git repo. It&rsquo;s not.</li>
        <li>Origin scans subdirectories and finds 3 <code className="text-indigo-400">.git</code> folders</li>
        <li>A workspace-level session is created on the API, with a <code className="text-indigo-400">SessionRepo</code> link for each repo</li>
        <li>On each prompt completion, diffs are captured from all repos independently</li>
        <li>File paths are prefixed with the repo directory name so nothing collides</li>
      </ol>

      {/* Architecture diagram */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-indigo-500/5">
        <div className="px-6 py-5 space-y-4">
          <div className="text-center text-gray-500 text-[10px] uppercase tracking-wider">Session lifecycle</div>
          <div className="flex items-center justify-center gap-3 text-xs">
            <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-indigo-400 text-center">
              <div className="font-medium">SessionStart</div>
              <div className="text-[10px] text-indigo-400/60">detect repos</div>
            </div>
            <div className="text-gray-600">&rarr;</div>
            <div className="rounded-lg border border-purple-500/30 bg-purple-500/10 px-3 py-2 text-purple-400 text-center">
              <div className="font-medium">API</div>
              <div className="text-[10px] text-purple-400/60">create SessionRepo links</div>
            </div>
            <div className="text-gray-600">&rarr;</div>
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-green-400 text-center">
              <div className="font-medium">Stop</div>
              <div className="text-[10px] text-green-400/60">capture per-repo diffs</div>
            </div>
            <div className="text-gray-600">&rarr;</div>
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-yellow-400 text-center">
              <div className="font-medium">Dashboard</div>
              <div className="text-[10px] text-yellow-400/60">show all repos</div>
            </div>
          </div>
        </div>
      </div>

      <h2>Try it</h2>
      <p>
        If you work across multiple repos, this is the update you&rsquo;ve been waiting for.
        Install or update the Origin CLI, enable hooks, and launch your AI agent from the workspace root:
      </p>

      {/* Terminal mock */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-purple-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">Terminal</div>
        </div>
        <div className="px-5 py-4 font-mono text-sm space-y-1">
          <div><span className="text-green-400">$</span> <span className="text-gray-300">npm i -g @origin/cli</span></div>
          <div><span className="text-green-400">$</span> <span className="text-gray-300">origin login</span></div>
          <div><span className="text-green-400">$</span> <span className="text-gray-300">origin enable -g --agent claude-code</span></div>
          <div><span className="text-green-400">$</span> <span className="text-gray-300">cd ~/my-project</span> <span className="text-gray-600"># parent of multiple repos</span></div>
          <div><span className="text-green-400">$</span> <span className="text-gray-300">claude</span> <span className="text-gray-600"># session tracks all child repos</span></div>
        </div>
      </div>

      <p>
        Works with Claude Code, Cursor, Gemini, Windsurf, Codex, and Aider. Free with{' '}
        <a href="https://getorigin.io/register" className="text-indigo-400 hover:text-indigo-300">Origin Solo</a>.
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
        <a
          href="https://getorigin.io/docs"
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-medium transition-colors"
        >
          Read the docs
        </a>
      </div>
    </>
  ),
  'merge-sessions': (
    <>
      <p>
        Modern developers don&rsquo;t use one AI tool. They switch between Claude Code for deep refactors,
        Cursor for quick edits, Codex for prototyping. A single feature might span 3&ndash;5 sessions
        across different agents, sometimes with breaks in between.
      </p>
      <p>
        The result? Your dashboard shows five separate sessions for what was really one task.
        Costs are fragmented. Context is scattered. You can&rsquo;t see the full picture.
      </p>
      <p>
        Today we&rsquo;re shipping <strong>Merge Sessions</strong> &mdash; select any sessions
        from your dashboard, click Merge, and get a single unified view with combined transcripts,
        summed costs, and all code changes in one place.
      </p>

      <h2>How it works</h2>
      <p>
        In your Solo Dashboard, select the sessions you want to combine using the checkboxes.
        A purple <strong>Merge</strong> button appears next to Compare. Click it, and Origin creates
        a new merged session instantly.
      </p>

      {/* Screenshot mock: selection */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-purple-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">getorigin.io/me &mdash; Sessions</div>
        </div>
        <div className="px-5 py-4 space-y-2">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs text-gray-400">2 sessions selected</span>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">Compare 2/2</span>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-purple-500/15 text-purple-400 border border-purple-500/30">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              Merge 2
            </span>
          </div>
          {[
            { checked: true, agent: 'Claude Code', model: 'claude-opus-4', repo: 'my-app', cost: '$0.42', tokens: '89k', time: '12m ago' },
            { checked: true, agent: 'Cursor', model: 'claude-sonnet-4', repo: 'my-app', cost: '$0.08', tokens: '12k', time: '5m ago' },
            { checked: false, agent: 'Claude Code', model: 'claude-opus-4', repo: 'my-app', cost: '$0.31', tokens: '67k', time: '1h ago' },
          ].map((s, i) => (
            <div key={i} className={`flex items-center gap-4 px-3 py-2 rounded-lg border ${s.checked ? 'border-purple-500/30 bg-purple-500/5' : 'border-gray-800 bg-gray-900/30'}`}>
              <input type="checkbox" checked={s.checked} readOnly className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-purple-500" />
              <span className="text-xs font-medium text-purple-400 bg-purple-500/15 px-1.5 py-0.5 rounded">{s.agent}</span>
              <span className="text-xs text-gray-400 font-mono">{s.model}</span>
              <span className="text-xs text-gray-500">{s.repo}</span>
              <span className="text-xs text-gray-300 ml-auto">{s.cost}</span>
              <span className="text-xs text-gray-500">{s.tokens}</span>
              <span className="text-xs text-gray-600">{s.time}</span>
            </div>
          ))}
        </div>
      </div>

      <h2>What gets merged</h2>
      <p>The merged session combines everything from the originals:</p>
      <ul>
        <li><strong>Transcripts</strong> &mdash; all conversation turns from every session, sorted chronologically with session dividers</li>
        <li><strong>Costs &amp; tokens</strong> &mdash; summed across all sessions so you see the true cost of the feature</li>
        <li><strong>Code changes</strong> &mdash; unified diff combining all files modified across sessions</li>
        <li><strong>Prompts</strong> &mdash; every prompt from every session, re-indexed in order</li>
        <li><strong>Duration</strong> &mdash; total time spent across all sessions</li>
      </ul>

      {/* Screenshot mock: merged result */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-purple-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">Merged Session</div>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-purple-900/30 text-purple-400">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              Merged
            </span>
            <span className="text-xs text-gray-400">2 sessions combined</span>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Total Cost', value: '$0.50', color: 'text-green-400' },
              { label: 'Tokens', value: '101k', color: 'text-yellow-400' },
              { label: 'Duration', value: '8m 42s', color: 'text-indigo-400' },
              { label: 'Files Changed', value: '4', color: 'text-purple-400' },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2">
                <div className="text-[10px] text-gray-500">{c.label}</div>
                <div className={`text-lg font-bold ${c.color}`}>{c.value}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-gray-800 pt-3 space-y-2">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider">Combined Transcript</div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/30 px-3 py-2">
              <div className="text-[10px] text-purple-400 mb-1">&mdash; Session 1 (Claude Code) &mdash;</div>
              <div className="text-xs text-gray-400">Refactor the auth middleware to support JWT refresh tokens...</div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/30 px-3 py-2">
              <div className="text-[10px] text-purple-400 mb-1">&mdash; Session 2 (Cursor) &mdash;</div>
              <div className="text-xs text-gray-400">Fix the token expiry check and add unit tests...</div>
            </div>
          </div>
        </div>
      </div>

      <h2>Use cases</h2>
      <ul>
        <li><strong>Multi-agent features</strong> &mdash; Started in Claude Code, finished in Cursor? Merge them to see the full story.</li>
        <li><strong>Session breaks</strong> &mdash; Took a break and your session auto-closed? Merge the before and after.</li>
        <li><strong>Daily summaries</strong> &mdash; Merge all your short sessions into a single daily summary.</li>
        <li><strong>Cost tracking</strong> &mdash; See the true cost of a feature, not just individual sessions.</li>
      </ul>

      <h2>Rules and edge cases</h2>
      <p>We handle the tricky parts so you don&rsquo;t have to:</p>
      <ul>
        <li><strong>Same repo only</strong> &mdash; Sessions from different repositories can&rsquo;t be merged. This prevents accidental mixing of unrelated work.</li>
        <li><strong>Mixed agents allowed</strong> &mdash; Claude + Cursor + Codex in one merged session? Works fine. The model field shows all agents used.</li>
        <li><strong>Running sessions blocked</strong> &mdash; Can&rsquo;t merge a session that&rsquo;s still running. Wait for it to complete first.</li>
        <li><strong>Originals preserved</strong> &mdash; The original sessions are hidden from the list but not deleted. They&rsquo;re still accessible via direct link.</li>
      </ul>

      <h2>How to use it</h2>
      <ol>
        <li>Go to your <a href="https://getorigin.io/me" className="text-indigo-400 hover:text-indigo-300">Solo Dashboard</a></li>
        <li>In the Sessions tab, check the boxes next to the sessions you want to merge</li>
        <li>Click the purple <strong>Merge</strong> button</li>
        <li>You&rsquo;ll be redirected to the new merged session automatically</li>
      </ol>

      <hr className="border-gray-800 my-10" />

      <h2>Commits Tab: Your AI-Attributed Git History</h2>
      <p>
        Alongside Merge Sessions, we&rsquo;re shipping the <strong>Commits tab</strong> in the Solo Dashboard.
        Think of it as <code className="text-indigo-400">git log</code> meets AI attribution &mdash; every commit
        linked to the session that produced it, with full context on which agent wrote the code and what it cost.
      </p>

      <p>
        If you&rsquo;ve used Entire.io, this is our analog to their Snapshots feature. But Origin goes further:
      </p>
      <ul>
        <li><strong>Entire</strong>: commit &rarr; diff + snapshot</li>
        <li><strong>Origin</strong>: commit &rarr; diff + session + AI/human attribution + cost + which prompt wrote what</li>
      </ul>

      {/* Commits tab mock */}
      <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden my-8 shadow-2xl shadow-indigo-500/5">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800 bg-gray-900/80">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <div className="text-[11px] text-gray-500 font-mono ml-2">getorigin.io/me &mdash; Commits</div>
        </div>
        <div className="px-1 py-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="px-3 py-2 text-left font-medium"></th>
                <th className="px-3 py-2 text-left font-medium">SHA</th>
                <th className="px-3 py-2 text-left font-medium">Message</th>
                <th className="px-3 py-2 text-left font-medium">Agent</th>
                <th className="px-3 py-2 text-left font-medium">Cost</th>
                <th className="px-3 py-2 text-left font-medium">Changes</th>
                <th className="px-3 py-2 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {[
                { ai: true, sha: 'a3f8c21', msg: 'feat: add JWT refresh token rotation', agent: 'Claude Code', cost: '$0.42', changes: '+89 -12', time: '2h ago' },
                { ai: true, sha: 'b7e1d04', msg: 'fix: token expiry edge case in middleware', agent: 'Cursor', cost: '$0.08', changes: '+14 -3', time: '1h ago' },
                { ai: false, sha: 'c2a9f88', msg: 'docs: update API changelog', agent: null, cost: null, changes: '+22 -0', time: '45m ago' },
                { ai: true, sha: 'e5d3b17', msg: 'test: add refresh token integration tests', agent: 'Codex', cost: '$0.03', changes: '+156 -0', time: '30m ago' },
              ].map((c, i) => (
                <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${c.ai ? 'bg-indigo-500/15 text-indigo-400' : 'bg-gray-700/60 text-gray-400'}`}>
                      {c.ai ? 'AI' : 'HU'}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-400">{c.sha}</td>
                  <td className="px-3 py-2 text-gray-300">{c.msg}</td>
                  <td className="px-3 py-2">
                    {c.agent ? (
                      <span className="text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded text-[10px] font-medium">{c.agent}</span>
                    ) : (
                      <span className="text-gray-600">&mdash;</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-300">{c.cost || '&mdash;'}</td>
                  <td className="px-3 py-2">
                    <span className="text-green-500">{c.changes.split(' ')[0]}</span>
                    {' '}
                    <span className="text-red-400">{c.changes.split(' ')[1]}</span>
                  </td>
                  <td className="px-3 py-2 text-right text-gray-600">{c.time}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h2>What each commit shows</h2>
      <p>Every commit in the table includes:</p>
      <ul>
        <li><strong>[AI] or [HU] badge</strong> &mdash; instantly see whether a commit came from an AI session or was human-written</li>
        <li><strong>Short SHA + message</strong> &mdash; standard git info you&rsquo;re used to</li>
        <li><strong>Linked agent</strong> &mdash; which AI tool produced this commit (Claude Code, Cursor, Codex, Gemini, etc.)</li>
        <li><strong>Cost</strong> &mdash; how much the session that produced this commit cost in API tokens</li>
        <li><strong>Lines changed</strong> &mdash; file count and +/- line stats</li>
        <li><strong>Expandable details</strong> &mdash; click any row to see full SHA, author, detection method, branch, and all files changed</li>
        <li><strong>Session link</strong> &mdash; jump directly to the full session to see the transcript, prompts, and diffs</li>
      </ul>

      <h2>Sort and paginate</h2>
      <p>
        Commits can be sorted by <strong>date</strong> (newest first), <strong>repo</strong> (alphabetical),
        or <strong>cost</strong> (most expensive sessions first). Pagination handles repos with thousands of commits.
      </p>

      <h2>How it connects to git notes</h2>
      <p>
        Under the hood, Origin stores session linkage in <code className="text-indigo-400">git notes</code> on the
        <code className="text-indigo-400"> origin-sessions</code> ref. Every commit made during an AI session gets a note
        with the session ID. The Commits tab reads this linkage and enriches it with session data from the Origin API.
      </p>
      <p>
        This means your git history stays clean &mdash; no extra metadata in commit messages. The attribution
        lives in git notes, which are invisible to normal workflows but queryable by Origin.
      </p>

      <h2>Both features, available now</h2>
      <p>
        Merge Sessions and the Commits tab are live for all Origin Solo users. Free, no limits.
        Go to <a href="https://getorigin.io/me" className="text-indigo-400 hover:text-indigo-300">your dashboard</a> to try them.
      </p>
    </>
  ),
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
