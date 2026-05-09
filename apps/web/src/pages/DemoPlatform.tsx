import React, { useState, useEffect, useCallback } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';

/* ------------------------------------------------------------------ */
/*  Types & data                                                       */
/* ------------------------------------------------------------------ */

interface Step {
  title: string;
  caption: string;
  browserTitle: string;
  content: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Shared presentational helpers                                      */
/* ------------------------------------------------------------------ */

function BrowserChrome({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden w-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
        <div className="w-3 h-3 rounded-full bg-red-500/80" />
        <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
        <div className="w-3 h-3 rounded-full bg-green-500/80" />
        <span className="text-xs text-gray-500 ml-2 font-mono truncate">{title}</span>
      </div>
      <div className="p-5 min-h-[360px]">{children}</div>
    </div>
  );
}

function MockButton({ children, variant = 'primary', className = '' }: { children: React.ReactNode; variant?: 'primary' | 'secondary' | 'danger'; className?: string }) {
  const base = 'rounded-lg px-4 py-2 text-sm font-medium text-center cursor-default select-none';
  const styles = {
    primary: 'bg-indigo-600 text-white',
    secondary: 'bg-gray-700 text-gray-300 border border-gray-600',
    danger: 'bg-red-600/20 text-red-400 border border-red-500/30',
  };
  return <div className={`${base} ${styles[variant]} ${className}`}>{children}</div>;
}

function Badge({ children, color = 'indigo' }: { children: React.ReactNode; color?: 'indigo' | 'green' | 'yellow' | 'red' | 'gray' | 'purple' | 'blue' | 'amber' }) {
  const colors = {
    indigo: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
    green: 'bg-green-500/20 text-green-400 border-green-500/30',
    yellow: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    red: 'bg-red-500/20 text-red-400 border-red-500/30',
    amber: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    gray: 'bg-gray-700 text-gray-400 border-gray-600',
    purple: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    blue: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${colors[color]}`}>
      {children}
    </span>
  );
}

function SidebarItem({ icon, label, active = false }: { icon: string; label: string; active?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs ${active ? 'bg-indigo-600/20 text-indigo-400' : 'text-gray-500'}`}>
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function TeamSidebar({ active }: { active: string }) {
  return (
    <div className="hidden sm:block w-44 border-r border-gray-800 pr-3 space-y-0.5 shrink-0">
      <div className="flex items-center gap-2 px-3 py-2 mb-3">
        <div className="w-5 h-5 rounded-md bg-indigo-500/20 ring-1 ring-indigo-500/30 flex items-center justify-center text-[10px] text-indigo-400 font-bold">A</div>
        <span className="text-xs font-semibold text-gray-300">acme-corp</span>
      </div>
      <SidebarItem icon="📊" label="Dashboard" active={active === 'dashboard'} />
      <SidebarItem icon="🔴" label="Live Sessions" active={active === 'sessions'} />
      <SidebarItem icon="✨" label="AI Reviews" active={active === 'review'} />
      <SidebarItem icon="📦" label="Repositories" active={active === 'repos'} />
      <SidebarItem icon="🛡️" label="Policies" active={active === 'policies'} />
      <SidebarItem icon="💰" label="Budgets" active={active === 'budgets'} />
      <SidebarItem icon="👥" label="Team" active={active === 'team'} />
      <SidebarItem icon="📝" label="Audit Log" active={active === 'audit'} />
    </div>
  );
}

function Avatar({ initials, color = 'indigo' }: { initials: string; color?: 'indigo' | 'purple' | 'amber' | 'blue' | 'green' | 'red' }) {
  const colors: Record<string, string> = {
    indigo: 'bg-indigo-500/20 text-indigo-300 ring-indigo-500/30',
    purple: 'bg-purple-500/20 text-purple-300 ring-purple-500/30',
    amber: 'bg-amber-500/20 text-amber-300 ring-amber-500/30',
    blue: 'bg-blue-500/20 text-blue-300 ring-blue-500/30',
    green: 'bg-green-500/20 text-green-300 ring-green-500/30',
    red: 'bg-red-500/20 text-red-300 ring-red-500/30',
  };
  return (
    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold ring-1 ${colors[color]}`}>
      {initials}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step content renderers                                             */
/* ------------------------------------------------------------------ */

function StepDashboard() {
  const stats = [
    { label: 'Devs using AI', value: '24', sub: 'of 28' },
    { label: 'Active sessions', value: '7', sub: 'right now', live: true },
    { label: 'This month spend', value: '$1,240', sub: '62% of budget' },
    { label: 'Policy hits', value: '12', sub: '2 blocking', warn: true },
  ];
  const team = [
    { name: 'Alice Chen', initials: 'AC', color: 'indigo' as const, sessions: 38, cost: '$184', agent: 'Claude Code' },
    { name: 'Bob Rivera', initials: 'BR', color: 'purple' as const, sessions: 31, cost: '$162', agent: 'Cursor' },
    { name: 'Devi Patel', initials: 'DP', color: 'amber' as const, sessions: 24, cost: '$98', agent: 'Claude Code' },
    { name: 'Marko Ilić', initials: 'MI', color: 'blue' as const, sessions: 19, cost: '$74', agent: 'Codex' },
  ];
  return (
    <div className="flex gap-4">
      <TeamSidebar active="dashboard" />
      <div className="flex-1 space-y-4 min-w-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Team Dashboard</h3>
            <p className="text-[10px] text-gray-500">acme-corp · org-wide AI coding activity</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge color="green">live</Badge>
            <Badge color="gray">last 7d</Badge>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {stats.map((s) => (
            <div key={s.label} className="bg-gray-800/50 rounded-lg p-2.5">
              <p className="text-[10px] text-gray-500">{s.label}</p>
              <p className="text-sm font-semibold text-gray-200 mt-0.5 flex items-center gap-1.5">
                {s.value}
                {s.live && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
              </p>
              <p className={`text-[9px] mt-0.5 ${s.warn ? 'text-amber-400' : 'text-gray-500'}`}>{s.sub}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-gray-800/40 rounded-lg p-3 space-y-2">
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Top contributors</p>
            <div className="space-y-1">
              {team.map((m) => (
                <div key={m.name} className="flex items-center gap-2 text-xs">
                  <Avatar initials={m.initials} color={m.color} />
                  <span className="text-gray-300 flex-1 truncate">{m.name}</span>
                  <span className="text-gray-500 text-[10px]">{m.sessions} sess</span>
                  <span className="text-gray-300 text-[10px] w-10 text-right">{m.cost}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-gray-800/40 rounded-lg p-3 space-y-2">
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Spend by agent</p>
            <div className="space-y-1.5">
              {[
                { agent: 'Claude Code', cost: 612, pct: 49, color: 'indigo' as const },
                { agent: 'Cursor', cost: 388, pct: 31, color: 'purple' as const },
                { agent: 'Codex CLI', cost: 162, pct: 13, color: 'blue' as const },
                { agent: 'Gemini CLI', cost: 78, pct: 7, color: 'amber' as const },
              ].map((a) => (
                <div key={a.agent} className="space-y-0.5">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-gray-400">{a.agent}</span>
                    <span className="text-gray-300">${a.cost}</span>
                  </div>
                  <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        a.color === 'indigo' ? 'bg-indigo-500/70' :
                        a.color === 'purple' ? 'bg-purple-500/70' :
                        a.color === 'blue' ? 'bg-blue-500/70' :
                        'bg-amber-500/70'
                      }`}
                      style={{ width: `${a.pct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepLiveSessions() {
  const rows = [
    { dev: 'Alice Chen', initials: 'AC', color: 'indigo' as const, agent: 'Claude Code', repo: 'acme/backend', branch: 'feat/jwt-refresh', dur: '12m', cost: '$0.34', status: 'active' },
    { dev: 'Bob Rivera', initials: 'BR', color: 'purple' as const, agent: 'Cursor', repo: 'acme/frontend', branch: 'fix/cart-checkout', dur: '8m', cost: '$0.21', status: 'active' },
    { dev: 'Devi Patel', initials: 'DP', color: 'amber' as const, agent: 'Claude Code', repo: 'acme/api-gateway', branch: 'chore/logging', dur: '4m', cost: '$0.09', status: 'review' },
    { dev: 'Marko Ilić', initials: 'MI', color: 'blue' as const, agent: 'Codex CLI', repo: 'acme/infra', branch: 'main', dur: '21m', cost: '$0.62', status: 'flagged' },
  ];
  return (
    <div className="flex gap-4">
      <TeamSidebar active="sessions" />
      <div className="flex-1 space-y-4 min-w-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Live Sessions</h3>
            <p className="text-[10px] text-gray-500">Every AI coding session across the team — in real time</p>
          </div>
          <Badge color="green">4 live</Badge>
        </div>
        <div className="border border-gray-700/60 rounded-lg overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-800/40 text-gray-400">
                <th className="text-left px-3 py-2 font-medium">Developer</th>
                <th className="text-left px-3 py-2 font-medium">Agent</th>
                <th className="text-left px-3 py-2 font-medium">Repo / branch</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-right px-3 py-2 font-medium">Duration</th>
                <th className="text-right px-3 py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={`border-b border-gray-800/60 ${i === 0 ? 'bg-indigo-950/20' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Avatar initials={r.initials} color={r.color} />
                      <span className="text-gray-300">{r.dev}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-gray-400">{r.agent}</td>
                  <td className="px-3 py-2 text-gray-400">
                    <div className="font-mono text-[10px]">{r.repo}</div>
                    <div className="font-mono text-[10px] text-gray-600">{r.branch}</div>
                  </td>
                  <td className="px-3 py-2">
                    {r.status === 'active' ? (
                      <span className="flex items-center gap-1 text-green-400 text-[11px]">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />active
                      </span>
                    ) : r.status === 'review' ? (
                      <Badge color="yellow">in review</Badge>
                    ) : (
                      <Badge color="red">flagged</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-400">{r.dur}</td>
                  <td className="px-3 py-2 text-right text-gray-300">{r.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border border-indigo-500/30 rounded-lg p-3 space-y-2 bg-indigo-950/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Avatar initials="AC" color="indigo" />
              <span className="text-xs text-gray-200 font-medium">Alice — Claude Code · acme/backend</span>
            </div>
            <Badge color="green">live</Badge>
          </div>
          <div className="bg-gray-900 rounded border border-gray-800 p-2.5 font-mono text-[10px] leading-relaxed">
            <div className="text-gray-500"># prompt</div>
            <div className="text-gray-300">add token expiry + audit logging to /auth/jwt</div>
            <div className="text-gray-500 mt-1.5">— src/services/auth.ts</div>
            <div className="text-red-400">- const token = jwt.sign(payload, SECRET);</div>
            <div className="text-green-400">+ const token = jwt.sign(payload, SECRET, {'{ expiresIn: \'1h\' }'});</div>
            <div className="text-green-400">+ logger.info('token.issued', {'{ userId }'});</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepAutoReview() {
  return (
    <div className="flex gap-4">
      <TeamSidebar active="review" />
      <div className="flex-1 space-y-4 min-w-0">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">AI Auto-Review</h3>
          <p className="text-[10px] text-gray-500 mt-0.5">Every AI-authored session gets scored for risk before a human even opens it.</p>
        </div>
        {/* Score header */}
        <div className="bg-gradient-to-br from-indigo-950/40 to-gray-900/40 border border-indigo-500/30 rounded-lg p-4 flex items-center gap-4">
          <div className="relative w-16 h-16 shrink-0">
            <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90">
              <circle cx="18" cy="18" r="15" fill="none" stroke="rgb(55 65 81)" strokeWidth="3" />
              <circle cx="18" cy="18" r="15" fill="none" stroke="rgb(245 158 11)" strokeWidth="3" strokeDasharray={`${(72 / 100) * 94.25} 94.25`} strokeLinecap="round" />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-base font-bold text-amber-300">72</span>
              <span className="text-[8px] text-gray-500 -mt-0.5">/ 100</span>
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-200">acme/backend · session 7f3a2c</span>
              <Badge color="amber">medium risk</Badge>
            </div>
            <p className="text-[11px] text-gray-400 mt-0.5">Reviewed 2 minutes ago by claude-opus-4-7. 3 files · 87 lines · $0.34.</p>
          </div>
          <div className="flex flex-col gap-1.5 shrink-0">
            <MockButton className="text-xs px-3 py-1.5">Approve</MockButton>
            <MockButton variant="secondary" className="text-xs px-3 py-1.5">Request changes</MockButton>
          </div>
        </div>
        {/* Findings */}
        <div className="space-y-1.5">
          <div className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/30 rounded p-2.5">
            <span className="text-amber-400 mt-0.5">▲</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-amber-200 font-medium">JWT secret read from process.env without validation</p>
              <p className="text-[10px] text-gray-500 mt-0.5 font-mono">src/services/auth.ts:14 · suggest using zod env schema</p>
            </div>
            <Badge color="amber">warn</Badge>
          </div>
          <div className="flex items-start gap-2 bg-blue-500/5 border border-blue-500/30 rounded p-2.5">
            <span className="text-blue-400 mt-0.5">ⓘ</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-blue-200 font-medium">No tests added for new token-expiry branch</p>
              <p className="text-[10px] text-gray-500 mt-0.5 font-mono">coverage dropped 1.2% on src/services/auth.ts</p>
            </div>
            <Badge color="blue">info</Badge>
          </div>
          <div className="flex items-start gap-2 bg-green-500/5 border border-green-500/30 rounded p-2.5">
            <span className="text-green-400 mt-0.5">✓</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-green-200 font-medium">No secrets, no restricted files, no model-allowlist violations</p>
              <p className="text-[10px] text-gray-500 mt-0.5">All policy checks passed</p>
            </div>
            <Badge color="green">pass</Badge>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepBlame() {
  const lines = [
    { n: 12, code: "import { z } from 'zod';", author: 'human', by: 'alice', age: '3d ago' },
    { n: 13, code: '', author: null },
    { n: 14, code: 'const registerSchema = z.object({', author: 'ai', model: 'claude-opus-4-7', by: 'bob', age: '2m ago' },
    { n: 15, code: '  email: z.string().email(),', author: 'ai', model: 'claude-opus-4-7', by: 'bob', age: '2m ago' },
    { n: 16, code: '  passcode: z.string().min(8),', author: 'ai', model: 'claude-opus-4-7', by: 'bob', age: '2m ago' },
    { n: 17, code: '  name: z.string().min(1),', author: 'ai', model: 'claude-opus-4-7', by: 'bob', age: '2m ago' },
    { n: 18, code: '});', author: 'ai', model: 'claude-opus-4-7', by: 'bob', age: '2m ago' },
    { n: 19, code: '', author: null },
    { n: 20, code: "router.post('/register', async (req) => {", author: 'human', by: 'alice', age: '3d ago' },
  ];
  return (
    <div className="flex gap-4">
      <TeamSidebar active="repos" />
      <div className="flex-1 space-y-4 min-w-0">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">AI Blame for code review</h3>
          <p className="text-[10px] text-gray-500 mt-0.5">See exactly which lines came from which AI, which developer, and which prompt — before you approve a PR.</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-800/60 rounded-t-lg border border-gray-700 text-[11px]">
          <span className="text-gray-300 font-mono">acme/backend · src/routes/auth.ts</span>
          <span className="ml-auto text-gray-500">AI 56% · Human 44% · 2 contributors</span>
        </div>
        <div className="bg-gray-900/50 rounded-b-lg overflow-hidden border-x border-b border-gray-700 -mt-4">
          <div className="font-mono text-[10px]">
            {lines.map((l) => (
              <div
                key={l.n}
                className={`flex items-center gap-2 px-2 py-0.5 ${
                  l.author === 'ai' ? 'bg-indigo-500/10 border-l-2 border-indigo-500/60' :
                  l.author === 'human' ? 'bg-transparent border-l-2 border-gray-700' :
                  'bg-transparent border-l-2 border-transparent'
                }`}
              >
                <span className="text-gray-600 w-6 text-right">{l.n}</span>
                <span className={`flex-1 truncate ${l.author === 'ai' ? 'text-indigo-200' : 'text-gray-300'}`}>{l.code || ' '}</span>
                {l.author === 'ai' && (
                  <>
                    <span className="text-[9px] px-1 py-0 rounded bg-indigo-500/25 text-indigo-300">AI</span>
                    <span className="text-gray-500 w-24 truncate">{l.model}</span>
                    <span className="text-gray-600 w-10">{l.by}</span>
                  </>
                )}
                {l.author === 'human' && (
                  <>
                    <span className="text-[9px] px-1 py-0 rounded bg-gray-700/60 text-gray-400">HU</span>
                    <span className="text-gray-500 w-24" />
                    <span className="text-gray-600 w-10">{l.by}</span>
                  </>
                )}
                {l.age && <span className="text-gray-600 w-14 text-right">{l.age}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepPolicies() {
  const policies = [
    { name: 'No secrets in env files', type: 'FILE_RESTRICTION', target: '*.env, secrets/*', action: 'BLOCK', hits: 3 },
    { name: 'Approved models only', type: 'MODEL_ALLOWLIST', target: 'claude-*, gpt-4*', action: 'BLOCK', hits: 1 },
    { name: 'Cost cap per session', type: 'COST_LIMIT', target: '$5.00', action: 'WARN', hits: 8 },
    { name: 'Human review on prod', type: 'HUMAN_REVIEW', target: 'main, release/*', action: 'BLOCK', hits: 0 },
    { name: 'Block AI on migrations', type: 'PATH_GUARD', target: 'db/migrations/**', action: 'BLOCK', hits: 0 },
  ];
  return (
    <div className="flex gap-4">
      <TeamSidebar active="policies" />
      <div className="flex-1 space-y-4 min-w-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Governance Policies</h3>
            <p className="text-[10px] text-gray-500">Enforce rules on AI-authored code across every repo</p>
          </div>
          <MockButton className="text-xs px-3 py-1.5">+ New Policy</MockButton>
        </div>
        <div className="border border-gray-700/60 rounded-lg overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-800/40 text-gray-400">
                <th className="text-left px-3 py-2 font-medium">Policy</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-left px-3 py-2 font-medium">Target</th>
                <th className="text-left px-3 py-2 font-medium">Action</th>
                <th className="text-right px-3 py-2 font-medium">Hits 7d</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.name} className="border-b border-gray-800/60">
                  <td className="px-3 py-2 text-gray-200">{p.name}</td>
                  <td className="px-3 py-2 text-gray-500 font-mono text-[10px]">{p.type}</td>
                  <td className="px-3 py-2 text-gray-400 font-mono text-[10px]">{p.target}</td>
                  <td className="px-3 py-2">
                    <Badge color={p.action === 'BLOCK' ? 'red' : 'yellow'}>{p.action}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className={p.hits > 0 ? 'text-amber-400' : 'text-gray-600'}>{p.hits}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Recent violation */}
        <div className="border border-red-500/30 bg-red-500/5 rounded-lg p-3 flex items-start gap-2">
          <span className="text-red-400 mt-0.5">⛔</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-red-200 font-medium">Blocked: Marko / Cursor tried to edit <span className="font-mono">db/migrations/005_users.sql</span></p>
            <p className="text-[10px] text-gray-500 mt-0.5">Policy: "Block AI on migrations" · 4 minutes ago · session paused, dev notified in Slack</p>
          </div>
          <Badge color="red">BLOCKED</Badge>
        </div>
      </div>
    </div>
  );
}

function StepPRChecks() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 pb-3 border-b border-gray-800">
        <svg className="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
        <div>
          <div className="text-sm font-medium text-gray-200">feat: add token expiry to auth service <span className="text-gray-500 font-normal">#247</span></div>
          <div className="text-xs text-gray-500">acme/backend · opened 3 minutes ago by Alice via Claude Code</div>
        </div>
        <span className="ml-auto"><Badge color="green">Open</Badge></span>
      </div>
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        <div className="bg-gray-800/50 px-4 py-2 text-xs font-medium text-gray-300 border-b border-gray-800">Origin · Status Checks</div>
        <div className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center mt-0.5">
              <svg className="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            </div>
            <div className="flex-1">
              <div className="text-sm text-gray-200 font-medium">origin/governance — All checks passed</div>
              <div className="text-xs text-gray-500 mt-0.5">3 files by <strong className="text-gray-400">Claude Code</strong> · 0 violations · Cost $0.34 / $5.00</div>
            </div>
            <Badge color="green">Passed</Badge>
          </div>
          <div className="space-y-1.5 text-xs pl-8">
            <div className="flex items-center gap-2">
              <span className="text-green-400">✓</span>
              <span className="text-gray-400">File restrictions — no restricted paths touched</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-400">✓</span>
              <span className="text-gray-400">Secret scanning — no secrets in diff</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-400">✓</span>
              <span className="text-gray-400">Model allowlist — claude-opus-4-7 approved</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-amber-400">▲</span>
              <span className="text-gray-400">AI Auto-Review — score 72/100 (medium risk)</span>
              <Badge color="amber">human required</Badge>
            </div>
          </div>
          <div className="border-t border-gray-800" />
          <div className="flex items-start gap-3">
            <div className="w-5 h-5 rounded-full bg-red-500/20 flex items-center justify-center mt-0.5">
              <span className="text-red-400 text-xs">✕</span>
            </div>
            <div className="flex-1">
              <div className="text-sm text-gray-300">origin/policies — 1 blocking issue on <span className="font-mono text-red-300">#251</span></div>
              <div className="text-xs text-gray-500 mt-0.5">Cursor session edited <span className="font-mono">.env.production</span> — merge blocked</div>
            </div>
            <Badge color="red">Blocked</Badge>
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <MockButton>Merge pull request</MockButton>
        <MockButton variant="secondary">Request changes</MockButton>
      </div>
    </div>
  );
}

function StepBudgets() {
  const teams = [
    { team: 'Backend', spent: 412, cap: 600, devs: 7 },
    { team: 'Frontend', spent: 318, cap: 500, devs: 6 },
    { team: 'Platform', spent: 287, cap: 300, devs: 4 },
    { team: 'Mobile', spent: 89, cap: 250, devs: 3 },
  ];
  return (
    <div className="flex gap-4">
      <TeamSidebar active="budgets" />
      <div className="flex-1 space-y-4 min-w-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Budgets &amp; Cost Controls</h3>
            <p className="text-[10px] text-gray-500">Per-team and per-developer caps. Hard stops when limits hit.</p>
          </div>
          <Badge color="gray">May 2026</Badge>
        </div>
        {/* Org budget header */}
        <div className="bg-gradient-to-br from-indigo-950/30 to-gray-900/30 border border-indigo-500/30 rounded-lg p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-gray-400">Org budget</span>
            <span className="text-xs text-gray-300"><span className="text-indigo-300 font-semibold">$1,106</span> / $1,650</span>
          </div>
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500" style={{ width: '67%' }} />
          </div>
          <p className="text-[10px] text-gray-500 mt-1.5">On track — projected $1,520 by month end (92% of cap)</p>
        </div>
        {/* Per-team rows */}
        <div className="space-y-1.5">
          {teams.map((t) => {
            const pct = Math.round((t.spent / t.cap) * 100);
            const over = pct >= 95;
            return (
              <div key={t.team} className="bg-gray-800/40 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-200 font-medium">{t.team}</span>
                    <span className="text-gray-500 text-[10px]">· {t.devs} devs</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={over ? 'text-amber-300' : 'text-gray-300'}>${t.spent}</span>
                    <span className="text-gray-500">/ ${t.cap}</span>
                    {over && <Badge color="amber">{pct}%</Badge>}
                  </div>
                </div>
                <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${over ? 'bg-amber-500' : 'bg-indigo-500/70'}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="bg-amber-500/5 border border-amber-500/30 rounded-lg p-2.5 flex items-start gap-2">
          <span className="text-amber-400">▲</span>
          <p className="text-[11px] text-amber-200">
            <strong>Platform team at 95%</strong> of monthly cap — Slack alert sent to #eng-leads. Sessions will auto-pause at 100%.
          </p>
        </div>
      </div>
    </div>
  );
}

function StepAuditLog() {
  const entries = [
    { time: '14:02:11', actor: 'Alice (Claude Code)', event: 'session.started', target: 'acme/backend · main', kind: 'session' },
    { time: '14:01:58', actor: 'Marko (Cursor)', event: 'policy.blocked', target: 'db/migrations/005_users.sql', kind: 'block' },
    { time: '13:58:42', actor: 'Bob (Cursor)', event: 'pr.review.requested', target: 'acme/frontend#412', kind: 'review' },
    { time: '13:55:17', actor: 'Alice', event: 'apikey.created', target: 'alice-dev-key (acme/backend)', kind: 'iam' },
    { time: '13:42:03', actor: 'admin@acme', event: 'policy.updated', target: 'Cost cap per session $5 → $3', kind: 'policy' },
    { time: '13:31:55', actor: 'Devi (Claude Code)', event: 'session.completed', target: 'acme/api-gateway · 4 files · $0.09', kind: 'session' },
  ];
  const colorFor = (kind: string) => kind === 'block' ? 'red' : kind === 'review' ? 'yellow' : kind === 'iam' ? 'blue' : kind === 'policy' ? 'purple' : 'gray';
  return (
    <div className="flex gap-4">
      <TeamSidebar active="audit" />
      <div className="flex-1 space-y-4 min-w-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Audit Log</h3>
            <p className="text-[10px] text-gray-500">Every prompt, every policy hit, every IAM change. Exportable for SOC 2 / ISO.</p>
          </div>
          <div className="flex gap-1.5">
            <MockButton variant="secondary" className="text-[10px] px-2 py-1">Filter</MockButton>
            <MockButton variant="secondary" className="text-[10px] px-2 py-1">Export CSV</MockButton>
          </div>
        </div>
        <div className="border border-gray-700/60 rounded-lg overflow-hidden">
          <div className="font-mono text-[10px] divide-y divide-gray-800/60">
            {entries.map((e, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-800/30">
                <span className="text-gray-600 w-16">{e.time}</span>
                <Badge color={colorFor(e.kind) as any}>{e.event}</Badge>
                <span className="text-gray-400 w-44 truncate">{e.actor}</span>
                <span className="text-gray-500 flex-1 truncate">{e.target}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-800/40 rounded-lg p-2.5">
            <p className="text-[10px] text-gray-500">Events / day</p>
            <p className="text-sm font-semibold text-gray-200 mt-0.5">3,142</p>
          </div>
          <div className="bg-gray-800/40 rounded-lg p-2.5">
            <p className="text-[10px] text-gray-500">Retention</p>
            <p className="text-sm font-semibold text-gray-200 mt-0.5">7 years</p>
          </div>
          <div className="bg-gray-800/40 rounded-lg p-2.5">
            <p className="text-[10px] text-gray-500">SIEM stream</p>
            <p className="text-sm font-semibold text-green-400 mt-0.5 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> Datadog
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Steps data                                                         */
/* ------------------------------------------------------------------ */

const STEPS: Step[] = [
  {
    title: 'Org-wide AI coding dashboard',
    caption: 'See every developer, every agent, every dollar — at a glance. Live activity, top contributors, and spend by agent across the team.',
    browserTitle: 'getorigin.io/dashboard',
    content: <StepDashboard />,
  },
  {
    title: 'Watch every session live',
    caption: 'See AI coding sessions across the team in real time. Drill in to view the prompt, the diff, and the cost as it happens.',
    browserTitle: 'getorigin.io/sessions',
    content: <StepLiveSessions />,
  },
  {
    title: 'AI Auto-Review every session',
    caption: 'A second AI reviews every AI-authored session for risk, secrets, missing tests, and policy fit — before a human ever opens the PR.',
    browserTitle: 'getorigin.io/sessions/7f3a2c/review',
    content: <StepAutoReview />,
  },
  {
    title: 'AI Blame for code review',
    caption: 'Line-by-line attribution across every file. Before approving a PR, see which AI wrote which line, and which developer ran it.',
    browserTitle: 'getorigin.io/repos/acme-backend/blame/src/routes/auth.ts',
    content: <StepBlame />,
  },
  {
    title: 'Governance policies, enforced',
    caption: 'File restrictions, model allowlists, cost caps, path guards. Block what you must, warn on the rest, log everything.',
    browserTitle: 'getorigin.io/policies',
    content: <StepPolicies />,
  },
  {
    title: 'PR checks that block bad merges',
    caption: 'GitHub & GitLab status checks gate every merge. Policy violations and risky AI sessions get blocked or routed to a human.',
    browserTitle: 'github.com/acme/backend/pull/247',
    content: <StepPRChecks />,
  },
  {
    title: 'Budgets & cost controls',
    caption: 'Per-team and per-developer caps. Slack alerts at 80%, hard stop at 100% — so AI spend never gets surprising.',
    browserTitle: 'getorigin.io/budgets',
    content: <StepBudgets />,
  },
  {
    title: 'Compliance-grade audit log',
    caption: 'Every prompt, every policy hit, every IAM change — searchable, exportable, SIEM-streamable. Built for SOC 2 and ISO 27001.',
    browserTitle: 'getorigin.io/audit',
    content: <StepAuditLog />,
  },
];

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function PlatformTour({ embedded = false }: { embedded?: boolean }) {
  const [current, setCurrent] = useState(0);
  const [autoPlay, setAutoPlay] = useState(true);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [transitioning, setTransitioning] = useState(false);

  const goTo = useCallback(
    (idx: number, dir?: 'next' | 'prev') => {
      if (idx < 0 || idx >= STEPS.length || idx === current) return;
      setDirection(dir ?? (idx > current ? 'next' : 'prev'));
      setTransitioning(true);
      setTimeout(() => {
        setCurrent(idx);
        setTransitioning(false);
      }, 200);
    },
    [current],
  );

  const next = useCallback(() => goTo((current + 1) % STEPS.length, 'next'), [current, goTo]);
  const prev = useCallback(() => goTo((current - 1 + STEPS.length) % STEPS.length, 'prev'), [current, goTo]);

  useEffect(() => {
    if (!autoPlay) return;
    const id = setInterval(next, 5000);
    return () => clearInterval(id);
  }, [autoPlay, next]);

  const step = STEPS[current];

  return (
    <>
      {!embedded && (
        <Helmet>
          <title>Origin Team Demo — AI Code Governance for Engineering Teams</title>
          <meta
            name="description"
            content="Tour Origin Team: org-wide AI dashboard, live sessions, AI Auto-Review, governance policies, PR checks, budgets, and audit log."
          />
          <link rel="canonical" href="https://getorigin.io/demo" />
        </Helmet>
      )}

      <div className={embedded ? 'text-gray-100' : 'min-h-screen bg-[#0a0b14] text-gray-100'}>
        <div className={embedded ? '' : 'max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-20'}>
          {!embedded && (
            <div className="text-center mb-12">
              <h1 className="text-3xl sm:text-4xl font-bold mb-3">Origin Team in action</h1>
              <p className="text-gray-400 max-w-2xl mx-auto text-sm sm:text-base">
                The features your team actually uses every day — dashboard, live sessions, AI Auto-Review, policies, PR checks, budgets, audit.
              </p>
            </div>
          )}

          {/* ── Step indicators ────────────────────────────── */}
          <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
            {STEPS.map((s, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`h-2 rounded-full transition-all duration-300 ${
                  i === current
                    ? 'w-8 bg-indigo-500'
                    : 'w-2 bg-gray-700 hover:bg-gray-600'
                }`}
                aria-label={`Step ${i + 1}: ${s.title}`}
              />
            ))}
          </div>

          {/* ── Step title + number ───────────────────────── */}
          <div className="text-center mb-6">
            <span className="text-xs text-indigo-400 font-medium tracking-wider uppercase">
              Step {current + 1} of {STEPS.length}
            </span>
            <h2 className="text-xl sm:text-2xl font-semibold mt-1">{step.title}</h2>
          </div>

          {/* ── Browser mockup ────────────────────────────── */}
          <div
            className="transition-all duration-200 ease-in-out"
            style={{
              opacity: transitioning ? 0 : 1,
              transform: transitioning
                ? `translateX(${direction === 'next' ? '24px' : '-24px'})`
                : 'translateX(0)',
            }}
          >
            <BrowserChrome title={step.browserTitle}>{step.content}</BrowserChrome>
          </div>

          {/* ── Caption ───────────────────────────────────── */}
          <p
            className="text-center text-sm text-gray-400 mt-6 max-w-2xl mx-auto transition-opacity duration-200"
            style={{ opacity: transitioning ? 0 : 1 }}
          >
            {step.caption}
          </p>

          {/* ── Controls ──────────────────────────────────── */}
          <div className="flex items-center justify-center gap-4 mt-8">
            <button
              onClick={prev}
              className="p-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
              aria-label="Previous step"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>

            <button
              onClick={() => setAutoPlay(!autoPlay)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                autoPlay
                  ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-400'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
              }`}
            >
              {autoPlay ? (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6" /></svg>
                  Pause
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  Auto-play
                </>
              )}
            </button>

            <button
              onClick={next}
              className="p-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
              aria-label="Next step"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>

          {/* ── CTA ───────────────────────────────────────── */}
          {!embedded && (
          <div className="mt-20 text-center border border-gray-800 rounded-2xl p-8 sm:p-12 bg-gradient-to-b from-gray-900/50 to-transparent">
            <h2 className="text-2xl sm:text-3xl font-bold mb-3">Ready to get started?</h2>
            <p className="text-gray-400 mb-8 max-w-lg mx-auto text-sm sm:text-base">
              Set up AI code governance for your team in under 5 minutes. 14-day free trial, no credit card required.
            </p>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <Link
                to="/register?type=org"
                className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 py-3 rounded-lg transition-colors"
              >
                Start team trial
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
              </Link>
              <Link
                to="/docs"
                className="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium px-6 py-3 rounded-lg border border-gray-700 transition-colors"
              >
                View documentation
              </Link>
            </div>
          </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function DemoPlatformPage() {
  return <PlatformTour />;
}
