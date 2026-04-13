import React, { useRef, useState, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useLocation } from 'react-router-dom';

// ── Scroll-triggered fade in ────────────────────────────────────────────────
function FadeIn({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} className={`transition-all duration-700 ease-out ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

// ── Anchor scroll on load ───────────────────────────────────────────────────
function useAnchorScroll() {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) {
      setTimeout(() => {
        const el = document.getElementById(hash.slice(1));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [hash]);
}

// ── Mock terminal ───────────────────────────────────────────────────────────
function Terminal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-gray-950 overflow-hidden shadow-2xl shadow-black/40">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-900/80 border-b border-white/[0.06]">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
        </div>
        <span className="text-[11px] text-gray-500 font-mono ml-2">{title}</span>
      </div>
      <div className="p-4 font-mono text-xs leading-relaxed overflow-x-auto">{children}</div>
    </div>
  );
}

// ── Mock dashboard card ─────────────────────────────────────────────────────
function DashCard({ label, value, color = 'text-indigo-400', sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-gray-900/60 p-4">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-[11px] text-gray-500 uppercase tracking-wide mt-1">{label}</p>
      {sub && <p className="text-[10px] text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Flow diagram ────────────────────────────────────────────────────────────
function FlowDiagram({ steps }: { steps: { icon: string; label: string; color: string }[] }) {
  return (
    <div className="flex items-center justify-center gap-2 flex-wrap">
      {steps.map((s, i) => (
        <React.Fragment key={i}>
          <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border border-white/[0.08] bg-gray-900/60`}>
            <span className="text-lg">{s.icon}</span>
            <span className={`text-sm font-medium ${s.color}`}>{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <svg className="w-5 h-5 text-gray-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ── Bar chart mock ──────────────────────────────────────────────────────────
function BarChart({ data }: { data: { label: string; value: number; color: string }[] }) {
  const max = Math.max(...data.map(d => d.value));
  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3">
          <span className="text-xs text-gray-400 w-24 text-right shrink-0">{d.label}</span>
          <div className="flex-1 h-7 bg-gray-900/60 rounded-md overflow-hidden border border-white/[0.04]">
            <div
              className={`h-full rounded-md ${d.color} flex items-center justify-end px-2 transition-all duration-1000`}
              style={{ width: `${(d.value / max) * 100}%` }}
            >
              <span className="text-[10px] font-bold text-white/90">${d.value.toFixed(2)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Pie chart mock ──────────────────────────────────────────────────────────
function PieChart({ slices }: { slices: { label: string; pct: number; color: string; dotColor: string }[] }) {
  // Build conic gradient
  let offset = 0;
  const stops = slices.map(s => {
    const start = offset;
    offset += s.pct;
    return `${s.color} ${start}% ${offset}%`;
  }).join(', ');

  return (
    <div className="flex items-center gap-6">
      <div
        className="w-32 h-32 rounded-full shrink-0 border-2 border-white/[0.06]"
        style={{ background: `conic-gradient(${stops})` }}
      />
      <div className="space-y-2">
        {slices.map(s => (
          <div key={s.label} className="flex items-center gap-2 text-sm">
            <span className={`w-2.5 h-2.5 rounded-full ${s.dotColor}`} />
            <span className="text-gray-300">{s.label}</span>
            <span className="text-gray-500">{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Timeline mock ───────────────────────────────────────────────────────────
function Timeline({ events }: { events: { time: string; agent: string; agentColor: string; action: string }[] }) {
  return (
    <div className="relative pl-6 space-y-4 border-l border-white/[0.08]">
      {events.map((e, i) => (
        <div key={i} className="relative">
          <div className={`absolute -left-[25px] w-3 h-3 rounded-full border-2 border-gray-950 ${e.agentColor}`} />
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] text-gray-600 font-mono w-12 shrink-0">{e.time}</span>
            <span className={`text-xs font-semibold ${e.agentColor}`}>{e.agent}</span>
            <span className="text-xs text-gray-400">{e.action}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Section wrapper ─────────────────────────────────────────────────────────
function Section({ id, badge, badgeColor, title, subtitle, children, className = '' }: {
  id: string; badge: string; badgeColor: string; title: string; subtitle: string;
  children: React.ReactNode; className?: string;
}) {
  return (
    <section id={id} className={`py-20 scroll-mt-24 ${className}`}>
      <div className="max-w-5xl mx-auto px-6">
        <FadeIn>
          <div className="text-center mb-12">
            <span className={`inline-block text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border mb-4 ${badgeColor}`}>
              {badge}
            </span>
            <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight">{title}</h2>
            <p className="mt-3 text-gray-400 max-w-2xl mx-auto leading-relaxed">{subtitle}</p>
          </div>
        </FadeIn>
        {children}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
export default function UseCases() {
  useAnchorScroll();

  return (
    <>
      <Helmet>
        <title>Use Cases - Origin</title>
        <meta name="description" content="See how Origin helps solo developers track AI costs and teams govern AI-written code." />
      </Helmet>

      {/* ─── HERO ──────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-indigo-600/[0.07] via-transparent to-transparent pointer-events-none" />
        <div className="max-w-5xl mx-auto px-6 pt-20 pb-10 text-center relative">
          <FadeIn>
            <h1 className="text-4xl md:text-5xl font-bold text-white tracking-tight">
              Built for how AI code <span className="text-indigo-400">actually ships</span>
            </h1>
            <p className="mt-4 text-lg text-gray-400 max-w-2xl mx-auto">
              Whether you're a solo developer tracking your own AI spend or a CTO governing 50 engineers' agents, Origin gives you the visibility you need.
            </p>
          </FadeIn>

          {/* Section jump links */}
          <FadeIn delay={200}>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <span className="text-[10px] uppercase tracking-widest text-gray-600 self-center mr-2">Jump to:</span>
              {[
                { href: '#costs', label: 'AI Costs', color: 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10' },
                { href: '#understand', label: 'Code Understanding', color: 'border-purple-500/30 text-purple-400 hover:bg-purple-500/10' },
                { href: '#history', label: 'Agent History', color: 'border-blue-500/30 text-blue-400 hover:bg-blue-500/10' },
                { href: '#governance', label: 'Governance', color: 'border-red-500/30 text-red-400 hover:bg-red-500/10' },
                { href: '#visibility', label: 'Team Visibility', color: 'border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10' },
                { href: '#roi', label: 'AI ROI', color: 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10' },
                { href: '#audit', label: 'Audit Trail', color: 'border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10' },
              ].map(l => (
                <a key={l.href} href={l.href} className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${l.color}`}>
                  {l.label}
                </a>
              ))}
            </div>
          </FadeIn>
        </div>
      </div>

      {/* ─── SOLO: KNOW YOUR AI COSTS ─────────────────────────────────────── */}
      <Section
        id="costs"
        badge="For Solo Developers"
        badgeColor="border-emerald-500/30 text-emerald-400"
        title="Know Your AI Costs"
        subtitle="Track spend on Claude, Codex, Gemini across all projects. See exactly where your money goes before the bill shocks you."
      >
        <div className="grid md:grid-cols-2 gap-8">
          <FadeIn>
            <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-6 space-y-4">
              <h3 className="text-sm font-semibold text-gray-300">Cost by Model — Last 30 Days</h3>
              <BarChart data={[
                { label: 'Claude Opus', value: 18.42, color: 'bg-purple-500' },
                { label: 'Claude Sonnet', value: 12.87, color: 'bg-purple-400' },
                { label: 'GPT-4o', value: 8.15, color: 'bg-green-500' },
                { label: 'Gemini Pro', value: 4.33, color: 'bg-amber-500' },
                { label: 'Codex', value: 2.10, color: 'bg-blue-500' },
              ]} />
              <div className="flex items-center justify-between pt-3 border-t border-white/[0.06] text-sm">
                <span className="text-gray-500">Total this month</span>
                <span className="text-xl font-bold text-white">$45.87</span>
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={150}>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <DashCard label="Sessions" value="147" color="text-indigo-400" sub="across 12 repos" />
                <DashCard label="Tokens" value="2.1M" color="text-cyan-400" sub="input + output" />
                <DashCard label="Avg / Session" value="$0.31" color="text-emerald-400" sub="down 18% from last month" />
                <DashCard label="Most Expensive" value="$4.12" color="text-red-400" sub="refactor auth module" />
              </div>
              <Terminal title="origin recap --days 7">
                <div className="space-y-1 text-gray-300">
                  <p><span className="text-gray-500">Week summary:</span></p>
                  <p>  Sessions: <span className="text-indigo-400">34</span>  Cost: <span className="text-emerald-400">$11.23</span>  Tokens: <span className="text-cyan-400">487K</span></p>
                  <p>  <span className="text-gray-500">Top repo:</span> <span className="text-amber-400">origin-v2</span> — 18 sessions, $6.40</p>
                  <p>  <span className="text-gray-500">Top model:</span> <span className="text-purple-400">claude-opus-4-6</span> — $7.18 (64%)</p>
                </div>
              </Terminal>
            </div>
          </FadeIn>
        </div>
      </Section>

      {/* Divider */}
      <div className="max-w-5xl mx-auto px-6"><div className="border-t border-white/[0.04]" /></div>

      {/* ─── SOLO: UNDERSTAND YOUR CODE ───────────────────────────────────── */}
      <Section
        id="understand"
        badge="For Solo Developers"
        badgeColor="border-purple-500/30 text-purple-400"
        title="Understand Your Code"
        subtitle="See which prompt wrote which line, months later. Never lose context on why code was written."
      >
        <div className="space-y-8">
          <FadeIn>
            <div className="grid md:grid-cols-2 gap-6">
              {/* Git blame vs Origin blame */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500" /> Before Origin — <code className="text-gray-400">git blame</code>
                </p>
                <Terminal title="git blame src/auth.ts">
                  <div className="space-y-0.5 text-gray-400">
                    <p><span className="text-gray-600">a3f8c21</span> (dev@co.com 2026-03-15) <span className="text-gray-300">import jwt from 'jsonwebtoken';</span></p>
                    <p><span className="text-gray-600">a3f8c21</span> (dev@co.com 2026-03-15) <span className="text-gray-300">import bcrypt from 'bcryptjs';</span></p>
                    <p><span className="text-gray-600">a3f8c21</span> (dev@co.com 2026-03-15) <span className="text-gray-300">{'// Validate and refresh token'}</span></p>
                    <p><span className="text-gray-600">a3f8c21</span> (dev@co.com 2026-03-15) <span className="text-gray-300">{'export async function verify(tok) {'}</span></p>
                    <p className="text-gray-600 mt-2 text-[10px]">Who actually wrote this? The dev? Claude? Cursor? No way to tell.</p>
                  </div>
                </Terminal>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" /> After Origin — <code className="text-gray-400">origin blame</code>
                </p>
                <Terminal title="origin blame src/auth.ts">
                  <div className="space-y-0.5">
                    <p><span className="text-purple-400 w-16 inline-block">Claude</span>  <span className="text-gray-600">3h ago</span>  <span className="text-gray-300">import jwt from 'jsonwebtoken';</span></p>
                    <p><span className="text-purple-400 w-16 inline-block">Claude</span>  <span className="text-gray-600">3h ago</span>  <span className="text-gray-300">import bcrypt from 'bcryptjs';</span></p>
                    <p><span className="text-yellow-400 w-16 inline-block">Human</span>   <span className="text-gray-600">2d ago</span>  <span className="text-gray-300">{'// Validate and refresh token'}</span></p>
                    <p><span className="text-amber-400 w-16 inline-block">Gemini</span>  <span className="text-gray-600">1h ago</span>  <span className="text-gray-300">{'export async function verify(tok) {'}</span></p>
                    <p className="text-gray-600 mt-2 border-t border-white/[0.06] pt-2">
                      <span className="text-purple-400">Claude: 50%</span> · <span className="text-amber-400">Gemini: 25%</span> · <span className="text-yellow-400">Human: 25%</span>
                    </p>
                  </div>
                </Terminal>
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={100}>
            <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-6">
              <h3 className="text-sm font-semibold text-gray-300 mb-4">Replay the exact prompt that wrote any line</h3>
              <Terminal title="origin why src/auth.ts:4">
                <div className="space-y-2 text-gray-300">
                  <p><span className="text-gray-500">Line 4 of src/auth.ts was written by</span> <span className="text-amber-400">gemini-cli</span> <span className="text-gray-500">(gemini-2.5-pro)</span></p>
                  <p><span className="text-gray-500">Session:</span> <span className="text-indigo-400">s_a8f3c21d</span> <span className="text-gray-500">· 1h ago · $0.18 · 12,400 tokens</span></p>
                  <p className="border-t border-white/[0.06] pt-2 mt-2"><span className="text-gray-500">Prompt:</span></p>
                  <p className="text-cyan-300 bg-cyan-500/5 rounded px-2 py-1">"Refactor the auth module to use async/await and add token refresh logic"</p>
                  <p className="text-gray-500 mt-1">Response wrote 47 lines across 2 files (src/auth.ts, src/middleware.ts)</p>
                </div>
              </Terminal>
            </div>
          </FadeIn>
        </div>
      </Section>

      <div className="max-w-5xl mx-auto px-6"><div className="border-t border-white/[0.04]" /></div>

      {/* ─── SOLO: CROSS-AGENT HISTORY ────────────────────────────────────── */}
      <Section
        id="history"
        badge="For Solo Developers"
        badgeColor="border-blue-500/30 text-blue-400"
        title="Cross-Agent History"
        subtitle="One place for all agent sessions, forever. Switch between Claude, Cursor, Gemini — Origin remembers everything."
      >
        <div className="grid md:grid-cols-2 gap-8">
          <FadeIn>
            <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-6">
              <h3 className="text-sm font-semibold text-gray-300 mb-4">Session timeline — all agents, one view</h3>
              <Timeline events={[
                { time: '9:15am', agent: 'Claude Code', agentColor: 'text-purple-400 bg-purple-400', action: 'Started auth refactor — 3 files changed' },
                { time: '9:48am', agent: 'Claude Code', agentColor: 'text-purple-400 bg-purple-400', action: 'Session ended — $0.42, 18K tokens' },
                { time: '10:02am', agent: 'Cursor', agentColor: 'text-blue-400 bg-blue-400', action: 'Picked up context from Claude session' },
                { time: '10:15am', agent: 'Cursor', agentColor: 'text-blue-400 bg-blue-400', action: 'Added unit tests for auth module' },
                { time: '10:31am', agent: 'Cursor', agentColor: 'text-blue-400 bg-blue-400', action: 'Session ended — $0.28, 11K tokens' },
                { time: '2:10pm', agent: 'Gemini CLI', agentColor: 'text-amber-400 bg-amber-400', action: 'Fixed edge case in token refresh' },
                { time: '2:22pm', agent: 'Gemini CLI', agentColor: 'text-amber-400 bg-amber-400', action: 'Session ended — $0.15, 6K tokens' },
              ]} />
            </div>
          </FadeIn>

          <FadeIn delay={150}>
            <div className="space-y-4">
              <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-6">
                <h3 className="text-sm font-semibold text-gray-300 mb-3">Automatic context handoff</h3>
                <FlowDiagram steps={[
                  { icon: '🟣', label: 'Claude ends', color: 'text-purple-400' },
                  { icon: '💾', label: 'Origin saves', color: 'text-gray-300' },
                  { icon: '🔵', label: 'Cursor starts', color: 'text-blue-400' },
                  { icon: '📋', label: 'Context injected', color: 'text-emerald-400' },
                ]} />
                <p className="text-xs text-gray-500 mt-4 leading-relaxed">
                  When you switch agents, Origin automatically passes what the previous agent was working on, which files were changed, and what's still open. No copy-pasting, no re-explaining.
                </p>
              </div>

              <Terminal title="origin handoff show">
                <div className="space-y-1 text-gray-300">
                  <p><span className="text-gray-500">Last session:</span> <span className="text-purple-400">claude-code</span> <span className="text-gray-600">· 12 min ago</span></p>
                  <p><span className="text-gray-500">Working on:</span> Auth module refactor</p>
                  <p><span className="text-gray-500">Files changed:</span> src/auth.ts, src/middleware.ts</p>
                  <p><span className="text-gray-500">Status:</span> <span className="text-amber-400">Tests passing, but token refresh edge case needs fix</span></p>
                  <p className="text-gray-600 mt-2 text-[10px]">This context will be injected into the next agent session automatically.</p>
                </div>
              </Terminal>
            </div>
          </FadeIn>
        </div>
      </Section>

      <div className="max-w-5xl mx-auto px-6"><div className="border-t border-white/[0.04]" /></div>

      {/* ─── TEAMS: AI CODE GOVERNANCE ─────────────────────────────────────── */}
      <Section
        id="governance"
        badge="For Teams"
        badgeColor="border-red-500/30 text-red-400"
        title="AI Code Governance"
        subtitle="Policies, cost limits, content filters — enforced before code ever reaches main. Not guidelines. Rules."
      >
        <div className="space-y-8">
          <FadeIn>
            <div className="grid md:grid-cols-3 gap-4">
              {/* Policy cards */}
              {[
                { name: 'REQUIRE_REVIEW', desc: 'Block merges until a human approves the AI session', icon: '👁', status: 'Enforced', statusColor: 'text-emerald-400', violations: 3 },
                { name: 'COST_LIMIT', desc: 'Block sessions exceeding $5.00 per session', icon: '💰', status: 'Enforced', statusColor: 'text-emerald-400', violations: 1 },
                { name: 'FILE_RESTRICTION', desc: 'Block AI from modifying .env, secrets.*, prisma/migrations', icon: '🔒', status: 'Enforced', statusColor: 'text-emerald-400', violations: 7 },
              ].map(p => (
                <div key={p.name} className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-2xl">{p.icon}</span>
                    <span className={`text-[10px] font-semibold ${p.statusColor} px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20`}>{p.status}</span>
                  </div>
                  <p className="text-sm font-bold text-gray-200 font-mono">{p.name}</p>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">{p.desc}</p>
                  <p className="text-[10px] text-red-400 mt-3">{p.violations} violations blocked this month</p>
                </div>
              ))}
            </div>
          </FadeIn>

          <FadeIn delay={100}>
            <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-6">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">How policy enforcement works</h3>
              <FlowDiagram steps={[
                { icon: '🤖', label: 'AI writes code', color: 'text-purple-400' },
                { icon: '🪝', label: 'Git hook fires', color: 'text-gray-300' },
                { icon: '🛡', label: 'Policies checked', color: 'text-red-400' },
                { icon: '✅', label: 'Commit allowed', color: 'text-emerald-400' },
              ]} />
              <div className="mt-4 grid md:grid-cols-2 gap-4">
                <Terminal title="Commit blocked by policy">
                  <div className="text-red-400 space-y-1">
                    <p>{'  '}POLICY VIOLATION: FILE_RESTRICTION</p>
                    <p>{'  '}AI session modified restricted file:</p>
                    <p>{'    '}<span className="text-gray-300">prisma/migrations/001_init.sql</span></p>
                    <p className="text-gray-600 mt-2">{'  '}Commit blocked. Remove file from staging or</p>
                    <p className="text-gray-600">{'  '}request an exception from your admin.</p>
                  </div>
                </Terminal>
                <Terminal title="PR check on GitHub">
                  <div className="space-y-1.5 text-gray-300">
                    <p><span className="text-emerald-400">{'✓'}</span> origin/attribution — 73% AI-generated</p>
                    <p><span className="text-emerald-400">{'✓'}</span> origin/cost-limit — $2.14 (under $5.00)</p>
                    <p><span className="text-red-400">{'✗'}</span> origin/review — AI session not reviewed</p>
                    <p className="text-gray-600 text-[10px] mt-2">Merge blocked until all checks pass</p>
                  </div>
                </Terminal>
              </div>
            </div>
          </FadeIn>
        </div>
      </Section>

      <div className="max-w-5xl mx-auto px-6"><div className="border-t border-white/[0.04]" /></div>

      {/* ─── TEAMS: VISIBILITY ────────────────────────────────────────────── */}
      <Section
        id="visibility"
        badge="For Teams"
        badgeColor="border-cyan-500/30 text-cyan-400"
        title="Team AI Visibility"
        subtitle="See what every developer's agents are doing in real time. One dashboard for the whole team."
      >
        <FadeIn>
          <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 overflow-hidden">
            {/* Mock dashboard header */}
            <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-xs font-bold">O</div>
                <span className="font-semibold text-gray-200">Origin Dashboard</span>
                <span className="text-xs text-gray-600">Acme Corp</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-gray-500">3 active sessions</span>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-5 divide-x divide-white/[0.06]">
              {[
                { label: 'Active Sessions', value: '3', color: 'text-emerald-400' },
                { label: 'Today\'s Cost', value: '$23.41', color: 'text-indigo-400' },
                { label: 'Developers', value: '8', color: 'text-cyan-400' },
                { label: 'AI Lines Today', value: '1,247', color: 'text-purple-400' },
                { label: 'Policy Violations', value: '0', color: 'text-emerald-400' },
              ].map(s => (
                <div key={s.label} className="px-4 py-3 text-center">
                  <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-[10px] text-gray-600">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Live sessions table */}
            <div className="border-t border-white/[0.06]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-gray-600 border-b border-white/[0.04]">
                    <th className="text-left px-4 py-2 font-medium">Developer</th>
                    <th className="text-left px-4 py-2 font-medium">Agent</th>
                    <th className="text-left px-4 py-2 font-medium">Repo</th>
                    <th className="text-left px-4 py-2 font-medium">Model</th>
                    <th className="text-right px-4 py-2 font-medium">Cost</th>
                    <th className="text-right px-4 py-2 font-medium">Duration</th>
                    <th className="text-right px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  {[
                    { dev: 'Sarah Chen', agent: 'Claude Code', agentColor: 'text-purple-400', repo: 'api-service', model: 'opus-4-6', cost: '$1.24', dur: '23m', status: 'active' },
                    { dev: 'Alex Kim', agent: 'Cursor', agentColor: 'text-blue-400', repo: 'web-app', model: 'sonnet-4', cost: '$0.42', dur: '11m', status: 'active' },
                    { dev: 'Jordan Lee', agent: 'Gemini CLI', agentColor: 'text-amber-400', repo: 'ml-pipeline', model: 'gemini-2.5-pro', cost: '$0.88', dur: '18m', status: 'active' },
                    { dev: 'Mike Torres', agent: 'Claude Code', agentColor: 'text-purple-400', repo: 'api-service', model: 'opus-4-6', cost: '$2.10', dur: '45m', status: 'ended' },
                    { dev: 'Priya Patel', agent: 'Codex', agentColor: 'text-green-400', repo: 'infra', model: 'codex-mini', cost: '$0.15', dur: '8m', status: 'ended' },
                  ].map((r, i) => (
                    <tr key={i} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                      <td className="px-4 py-2.5 font-medium">{r.dev}</td>
                      <td className={`px-4 py-2.5 ${r.agentColor}`}>{r.agent}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-400">{r.repo}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">{r.model}</td>
                      <td className="px-4 py-2.5 text-right text-indigo-400">{r.cost}</td>
                      <td className="px-4 py-2.5 text-right text-gray-500">{r.dur}</td>
                      <td className="px-4 py-2.5 text-right">
                        {r.status === 'active' ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live</span>
                        ) : (
                          <span className="text-xs text-gray-600">Ended</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </FadeIn>
      </Section>

      <div className="max-w-5xl mx-auto px-6"><div className="border-t border-white/[0.04]" /></div>

      {/* ─── TEAMS: PROVE AI ROI ──────────────────────────────────────────── */}
      <Section
        id="roi"
        badge="For Teams"
        badgeColor="border-amber-500/30 text-amber-400"
        title="Prove AI ROI"
        subtitle="Show leadership the business case for AI tooling spend with real numbers, not vibes."
      >
        <div className="grid md:grid-cols-2 gap-8">
          <FadeIn>
            <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-6 space-y-4">
              <h3 className="text-sm font-semibold text-gray-300">AI Output — This Sprint</h3>
              <div className="grid grid-cols-2 gap-3">
                <DashCard label="Lines by AI" value="8,432" color="text-purple-400" sub="across 23 PRs" />
                <DashCard label="AI Cost" value="$127" color="text-indigo-400" sub="vs ~$4,200 dev hours" />
                <DashCard label="Time Saved" value="~62hrs" color="text-emerald-400" sub="estimated at $150/hr" />
                <DashCard label="ROI" value="73x" color="text-amber-400" sub="$127 spend → $9,300 value" />
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={150}>
            <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-6 space-y-4">
              <h3 className="text-sm font-semibold text-gray-300">AI Authorship Breakdown</h3>
              <PieChart slices={[
                { label: 'Claude Code', pct: 42, color: '#a855f7', dotColor: 'bg-purple-500' },
                { label: 'Cursor', pct: 28, color: '#3b82f6', dotColor: 'bg-blue-500' },
                { label: 'Human', pct: 18, color: '#6b7280', dotColor: 'bg-gray-500' },
                { label: 'Gemini CLI', pct: 8, color: '#f59e0b', dotColor: 'bg-amber-500' },
                { label: 'Codex', pct: 4, color: '#10b981', dotColor: 'bg-emerald-500' },
              ]} />
              <p className="text-xs text-gray-500 leading-relaxed">
                82% of code this sprint was AI-generated. Origin tracks every line so you can report this to leadership with confidence.
              </p>
            </div>
          </FadeIn>
        </div>

        <FadeIn delay={200}>
          <div className="mt-8 rounded-xl border border-white/[0.08] bg-gray-900/40 p-6">
            <h3 className="text-sm font-semibold text-gray-300 mb-4">Sprint Report — Export Ready</h3>
            <Terminal title="origin report --range 14d --format md">
              <div className="space-y-1 text-gray-300">
                <p className="text-white font-semibold">Sprint Report: Mar 28 — Apr 11, 2026</p>
                <p>&nbsp;</p>
                <p><span className="text-gray-500">Team:</span> 8 developers  <span className="text-gray-500">Sessions:</span> 147  <span className="text-gray-500">Total cost:</span> <span className="text-indigo-400">$127.41</span></p>
                <p><span className="text-gray-500">AI lines:</span> 8,432  <span className="text-gray-500">Human lines:</span> 1,891  <span className="text-gray-500">AI ratio:</span> <span className="text-purple-400">81.7%</span></p>
                <p>&nbsp;</p>
                <p><span className="text-gray-500">Top contributor:</span> Sarah Chen — 42 sessions, $38.20, 2,847 AI lines</p>
                <p><span className="text-gray-500">Most efficient:</span> Priya Patel — $0.08/AI line (team avg: $0.15)</p>
                <p><span className="text-gray-500">Est. time saved:</span> <span className="text-emerald-400">62 hours</span> <span className="text-gray-500">Est. value:</span> <span className="text-emerald-400">$9,300</span></p>
              </div>
            </Terminal>
          </div>
        </FadeIn>
      </Section>

      <div className="max-w-5xl mx-auto px-6"><div className="border-t border-white/[0.04]" /></div>

      {/* ─── TEAMS: AUDIT TRAIL ───────────────────────────────────────────── */}
      <Section
        id="audit"
        badge="For Teams"
        badgeColor="border-indigo-500/30 text-indigo-400"
        title="Audit Trail"
        subtitle="Full history of every AI session for SOC 2, ISO 27001, and internal compliance. Every prompt, every change, timestamped and immutable."
      >
        <div className="grid md:grid-cols-2 gap-8">
          <FadeIn>
            <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-6">
              <h3 className="text-sm font-semibold text-gray-300 mb-4">Audit log entries</h3>
              <div className="space-y-3">
                {[
                  { time: '2026-04-11 14:23:01', event: 'SESSION_START', user: 'sarah@acme.com', detail: 'claude-code / opus-4-6 / api-service', color: 'text-emerald-400' },
                  { time: '2026-04-11 14:23:44', event: 'FILE_MODIFIED', user: 'sarah@acme.com', detail: 'src/routes/auth.ts (+42 -8)', color: 'text-cyan-400' },
                  { time: '2026-04-11 14:24:12', event: 'SECRET_BLOCKED', user: 'sarah@acme.com', detail: 'AWS key detected in config.ts:7', color: 'text-red-400' },
                  { time: '2026-04-11 14:25:01', event: 'SESSION_END', user: 'sarah@acme.com', detail: '$1.24 / 18,420 tokens / 2m', color: 'text-gray-400' },
                  { time: '2026-04-11 14:26:30', event: 'REVIEW_APPROVED', user: 'mike@acme.com', detail: 'Session s_a8f3c approved', color: 'text-emerald-400' },
                ].map((entry, i) => (
                  <div key={i} className="flex items-start gap-3 text-xs">
                    <span className="text-gray-600 font-mono shrink-0 w-36">{entry.time}</span>
                    <span className={`font-mono font-bold shrink-0 w-32 ${entry.color}`}>{entry.event}</span>
                    <div className="min-w-0">
                      <span className="text-gray-500">{entry.user}</span>
                      <span className="text-gray-600"> — </span>
                      <span className="text-gray-400">{entry.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={150}>
            <div className="space-y-4">
              <Terminal title="origin audit --from 2026-01-01 --to 2026-03-31 --format json">
                <div className="space-y-1 text-gray-300">
                  <p><span className="text-gray-500">Generating compliance report...</span></p>
                  <p>&nbsp;</p>
                  <p>  Sessions: <span className="text-indigo-400">1,247</span></p>
                  <p>  Reviewed: <span className="text-emerald-400">1,198</span> (96%)</p>
                  <p>  Secrets blocked: <span className="text-red-400">23</span></p>
                  <p>  Policy violations: <span className="text-amber-400">41</span> (all resolved)</p>
                  <p>  Total AI cost: <span className="text-indigo-400">$892.33</span></p>
                  <p>&nbsp;</p>
                  <p>  <span className="text-emerald-400">{'✓'}</span> Report written to audit-q1-2026.json</p>
                </div>
              </Terminal>

              <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-5">
                <h3 className="text-sm font-semibold text-gray-300 mb-3">What gets recorded</h3>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    'Every prompt sent to AI',
                    'Every file modified',
                    'Model + version used',
                    'Token count + cost',
                    'Session duration',
                    'Secrets detected',
                    'Policy checks run',
                    'Review decisions',
                    'Developer identity',
                    'Git commit SHA',
                  ].map(item => (
                    <div key={item} className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="text-emerald-500">{'✓'}</span> {item}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </FadeIn>
        </div>
      </Section>

      {/* ─── CTA ──────────────────────────────────────────────────────────── */}
      <section className="py-20">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <FadeIn>
            <h2 className="text-3xl font-bold text-white">Ready to see what your AI agents are writing?</h2>
            <p className="mt-3 text-gray-400">Free for solo developers. No credit card required.</p>
            <div className="mt-8 flex items-center justify-center gap-4">
              <Link
                to="/register?type=developer"
                className="group relative px-7 py-3 text-sm font-medium rounded-lg bg-indigo-600 text-white overflow-hidden transition-all hover:shadow-lg hover:shadow-indigo-500/25"
              >
                <span className="relative z-10">Get started free &rarr;</span>
                <div className="absolute inset-0 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
              <Link to="/demo" className="px-7 py-3 text-sm font-medium rounded-lg text-gray-300 border border-white/[0.1] hover:bg-white/[0.05] transition-all">
                See the demo
              </Link>
            </div>
          </FadeIn>
        </div>
      </section>
    </>
  );
}
