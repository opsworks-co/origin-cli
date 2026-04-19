import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
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
      <div className="p-5 min-h-[340px]">{children}</div>
    </div>
  );
}

function Badge({ children, color = 'emerald' }: { children: React.ReactNode; color?: 'emerald' | 'green' | 'amber' | 'red' | 'gray' | 'indigo' | 'purple' }) {
  const colors: Record<string, string> = {
    emerald: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    green: 'bg-green-500/20 text-green-400 border-green-500/30',
    amber: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    red: 'bg-red-500/20 text-red-400 border-red-500/30',
    gray: 'bg-gray-700 text-gray-400 border-gray-600',
    indigo: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
    purple: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${colors[color]}`}>
      {children}
    </span>
  );
}

function SidebarItem({ icon, label, active = false }: { icon: string; label: string; active?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs ${active ? 'bg-emerald-600/15 text-emerald-400' : 'text-gray-500'}`}>
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function SoloSidebar({ active }: { active: string }) {
  return (
    <div className="hidden sm:block w-40 border-r border-gray-800 pr-3 space-y-0.5 shrink-0">
      <div className="flex items-center gap-2 px-3 py-2 mb-3">
        <div className="w-5 h-5 rounded-full bg-emerald-500/20 ring-1 ring-emerald-500/30 flex items-center justify-center text-[10px] text-emerald-400 font-bold">O</div>
        <span className="text-xs font-semibold text-gray-300">Origin Solo</span>
      </div>
      <SidebarItem icon="📊" label="My Dashboard" active={active === 'dashboard'} />
      <SidebarItem icon="📁" label="Repositories" active={active === 'repos'} />
      <SidebarItem icon="▶" label="My Sessions" active={active === 'sessions'} />
      <SidebarItem icon="💡" label="Insights" active={active === 'insights'} />
      <SidebarItem icon="🔑" label="API Keys" active={active === 'keys'} />
      <SidebarItem icon="⚙" label="Settings" active={active === 'settings'} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step content renderers                                             */
/* ------------------------------------------------------------------ */

function StepDashboard() {
  return (
    <div className="flex gap-4">
      <SoloSidebar active="dashboard" />
      <div className="flex-1 space-y-4 min-w-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">My Dashboard</h3>
            <p className="text-[10px] text-gray-500">Personal coding activity</p>
          </div>
          <Badge color="emerald">2 day streak</Badge>
        </div>
        {/* Stat cards */}
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'Sessions', value: '12', change: '+3 this week' },
            { label: 'Tokens', value: '45.2M', change: '+12M' },
            { label: 'Cost', value: '$18.40', change: '+$6.20' },
            { label: 'Lines', value: '847', change: '+312 / -89' },
          ].map((s) => (
            <div key={s.label} className="bg-gray-800/50 rounded-lg p-2.5">
              <p className="text-[10px] text-gray-500">{s.label}</p>
              <p className="text-sm font-semibold text-gray-200">{s.value}</p>
              <p className="text-[9px] text-emerald-400">{s.change}</p>
            </div>
          ))}
        </div>
        {/* Session rows */}
        <div className="space-y-1">
          <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Recent Sessions</div>
          {[
            { agent: 'Claude Code', repo: 'my-app', cost: '$4.40', tokens: '6.5M', status: 'Running', time: '2m ago' },
            { agent: 'Claude Code', repo: 'origin-cli', cost: '$1.94', tokens: '2.7M', status: 'Done', time: '1h ago' },
            { agent: 'Cursor', repo: 'website', cost: '$0.85', tokens: '1.2M', status: 'Done', time: '3h ago' },
          ].map((s, i) => (
            <div key={i} className="flex items-center justify-between bg-gray-800/30 rounded px-3 py-2 text-xs">
              <div className="flex items-center gap-3">
                <Badge color={s.agent === 'Claude Code' ? 'indigo' : 'purple'}>{s.agent}</Badge>
                <span className="text-gray-400">{s.repo}</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-gray-500">{s.tokens}</span>
                <span className="text-gray-300">{s.cost}</span>
                {s.status === 'Running' ? (
                  <span className="flex items-center gap-1 text-green-400"><span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />{s.status}</span>
                ) : (
                  <Badge color="gray">{s.status}</Badge>
                )}
                <span className="text-gray-600 w-12 text-right">{s.time}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepSessions() {
  return (
    <div className="flex gap-4">
      <SoloSidebar active="sessions" />
      <div className="flex-1 space-y-4 min-w-0">
        <h3 className="text-sm font-semibold text-gray-200">Session Detail</h3>
        {/* Session header */}
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge color="indigo">Claude Code</Badge>
              <span className="text-xs text-gray-400">my-app</span>
              <span className="text-xs text-gray-600">main</span>
            </div>
            <Badge color="gray">Done</Badge>
          </div>
          <div className="flex gap-6 text-[10px] text-gray-500">
            <span>Duration: <span className="text-gray-300">42m</span></span>
            <span>Cost: <span className="text-gray-300">$4.40</span></span>
            <span>Tokens: <span className="text-gray-300">6.5M</span></span>
            <span>Model: <span className="text-gray-300">claude-sonnet-4</span></span>
          </div>
        </div>
        {/* Prompts */}
        <div className="space-y-2">
          <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Prompts</p>
          {[
            { prompt: 'add user authentication with JWT', files: 3, lines: '+87 / -12' },
            { prompt: 'write tests for the auth middleware', files: 2, lines: '+124 / -0' },
            { prompt: 'fix the token refresh logic', files: 1, lines: '+15 / -8' },
          ].map((p, i) => (
            <div key={i} className="bg-gray-800/30 rounded px-3 py-2 text-xs space-y-1">
              <p className="text-gray-200">{p.prompt}</p>
              <p className="text-[10px] text-gray-600">{p.files} files changed &middot; {p.lines}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepRepos() {
  return (
    <div className="flex gap-4">
      <SoloSidebar active="repos" />
      <div className="flex-1 space-y-4 min-w-0">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-200">Repositories</h3>
          <Badge color="gray">4 repos</Badge>
        </div>
        <div className="space-y-1.5">
          {[
            { name: 'my-app', commits: 24, sessions: 8, synced: '5m ago' },
            { name: 'origin-cli', commits: 12, sessions: 4, synced: '1h ago' },
            { name: 'website', commits: 6, sessions: 2, synced: '3h ago' },
            { name: 'api-server', commits: 3, sessions: 1, synced: '1d ago' },
          ].map((r) => (
            <div key={r.name} className="flex items-center justify-between bg-gray-800/30 rounded-lg px-4 py-2.5">
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-200 font-medium">{r.name}</span>
              </div>
              <div className="flex items-center gap-4 text-[10px] text-gray-500">
                <span>{r.commits} commits</span>
                <span>{r.sessions} sessions</span>
                <span>{r.synced}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-gray-600">Repos are auto-detected when the CLI runs. No manual setup needed.</p>
      </div>
    </div>
  );
}

function StepInsights() {
  return (
    <div className="flex gap-4">
      <SoloSidebar active="insights" />
      <div className="flex-1 space-y-4 min-w-0">
        <h3 className="text-sm font-semibold text-gray-200">Insights</h3>
        {/* Cost by model */}
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-2">
          <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Cost by Model (this week)</p>
          <div className="space-y-1.5">
            {[
              { model: 'claude-sonnet-4', cost: 12.40, pct: 67 },
              { model: 'claude-opus-4', cost: 4.20, pct: 23 },
              { model: 'cursor-small', cost: 1.80, pct: 10 },
            ].map((m) => (
              <div key={m.model} className="space-y-0.5">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">{m.model}</span>
                  <span className="text-gray-300">${m.cost.toFixed(2)}</span>
                </div>
                <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500/60 rounded-full" style={{ width: `${m.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Activity heatmap placeholder */}
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-2">
          <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Coding Activity</p>
          <div className="flex gap-0.5 flex-wrap">
            {Array.from({ length: 28 }, (_, i) => {
              const intensity = Math.random();
              const bg = intensity > 0.7 ? 'bg-emerald-500' : intensity > 0.4 ? 'bg-emerald-500/40' : intensity > 0.15 ? 'bg-emerald-500/15' : 'bg-gray-800';
              return <div key={i} className={`w-3 h-3 rounded-sm ${bg}`} />;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepSnapshots() {
  const snaps = [
    { id: 'a1b2c3d', prompt: 'Add JWT refresh endpoint', files: 1, when: '2m ago', tag: 'current', active: true },
    { id: '5f8e9a0', prompt: 'Fix broken token edge case', files: 1, when: '8m ago' },
    { id: 'd2c4b6a', prompt: 'Refactor auth middleware', files: 3, when: '14m ago' },
    { id: '7e1f3a2', prompt: 'Add rate limiting', files: 2, when: '22m ago', tag: 'before break' },
    { id: '9b4c8d1', prompt: 'Initial /auth endpoint', files: 1, when: '38m ago' },
  ];
  return (
    <div className="flex gap-4">
      <SoloSidebar active="sessions" />
      <div className="flex-1 space-y-4 min-w-0">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">Undo a bad AI turn</h3>
          <p className="text-[10px] text-gray-500 mt-0.5">Every prompt auto-saves a snapshot. Restore, branch, or rewind without losing work.</p>
        </div>
        {/* Snapshot list */}
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-1.5">
          <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Session · 5 snapshots</p>
          <div className="space-y-1 font-mono text-[10px]">
            {snaps.map((s) => (
              <div key={s.id} className={`flex items-center gap-2 px-2 py-1.5 rounded ${s.active ? 'bg-emerald-500/10 border border-emerald-500/30' : s.tag === 'before break' ? 'bg-amber-500/10 border border-amber-500/30' : 'bg-gray-800/60 border border-transparent'}`}>
                <span className={s.active ? 'text-emerald-300' : s.tag === 'before break' ? 'text-amber-300' : 'text-gray-500'}>{s.id}</span>
                <span className={`flex-1 truncate ${s.active ? 'text-emerald-100' : 'text-gray-300'}`}>{s.prompt}</span>
                <span className="text-gray-600">{s.files} file{s.files === 1 ? '' : 's'}</span>
                <span className="text-gray-600">{s.when}</span>
                {s.tag && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded ${s.active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>{s.tag}</span>
                )}
              </div>
            ))}
          </div>
        </div>
        {/* Actions */}
        <div className="bg-gray-800/30 rounded-lg p-3 space-y-1.5">
          <p className="text-[10px] text-gray-400 font-medium">From the CLI</p>
          <div className="font-mono text-[10px] text-emerald-400 space-y-0.5">
            <p>$ origin snapshot restore 7e1f3a2</p>
            <p className="text-gray-500">  Stashed uncommitted · Restored 2 files · No commits modified</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepBlame() {
  const lines = [
    { n: 12, code: "import { z } from 'zod';", author: 'human', age: '3d ago' },
    { n: 13, code: '', author: null },
    { n: 14, code: 'const registerSchema = z.object({', author: 'ai', model: 'claude-opus-4-7', age: '2m ago' },
    { n: 15, code: '  email: z.string().email(),', author: 'ai', model: 'claude-opus-4-7', age: '2m ago' },
    { n: 16, code: '  passcode: z.string().min(8),', author: 'ai', model: 'claude-opus-4-7', age: '2m ago' },
    { n: 17, code: '  name: z.string().min(1),', author: 'ai', model: 'claude-opus-4-7', age: '2m ago' },
    { n: 18, code: '});', author: 'ai', model: 'claude-opus-4-7', age: '2m ago' },
    { n: 19, code: '', author: null },
    { n: 20, code: "router.post('/register', async (req) => {", author: 'human', age: '3d ago' },
  ];
  return (
    <div className="flex gap-4">
      <SoloSidebar active="repos" />
      <div className="flex-1 space-y-4 min-w-0">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">AI blame — see which AI wrote which line</h3>
          <p className="text-[10px] text-gray-500 mt-0.5">Line-by-line attribution with the prompt + model that produced it. Survives rebase, amend, cherry-pick.</p>
        </div>
        {/* File header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-800/60 rounded-t-lg border-b border-gray-700 text-[11px]">
          <span className="text-gray-300 font-mono">src/routes/auth.ts</span>
          <span className="ml-auto text-gray-500">AI 56% · Human 44%</span>
        </div>
        {/* Blame rows */}
        <div className="bg-gray-900/50 rounded-b-lg overflow-hidden -mt-4">
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
                    <span className="text-gray-500 w-28 truncate">{l.model}</span>
                  </>
                )}
                {l.author === 'human' && <span className="text-[9px] px-1 py-0 rounded bg-gray-700/60 text-gray-400">HU</span>}
                {l.age && <span className="text-gray-600 w-16 text-right">{l.age}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Steps                                                              */
/* ------------------------------------------------------------------ */

const STEPS: Step[] = [
  {
    title: 'Your personal AI coding dashboard',
    caption: 'See all your AI coding sessions at a glance — cost, tokens, lines written, and a coding streak counter.',
    browserTitle: 'getorigin.io/me',
    content: <StepDashboard />,
  },
  {
    title: 'Full session replay with prompts',
    caption: 'Click any session to see every prompt you gave, which files changed, and the full diff per prompt.',
    browserTitle: 'getorigin.io/sessions/a3f1e2',
    content: <StepSessions />,
  },
  {
    title: 'Auto-detected repositories',
    caption: 'Repos appear automatically when the CLI hooks into your git workflow. No manual configuration needed.',
    browserTitle: 'getorigin.io/repos',
    content: <StepRepos />,
  },
  {
    title: 'Cost and model insights',
    caption: 'Track spending per model, see activity patterns, and understand where your AI budget goes.',
    browserTitle: 'getorigin.io/insights',
    content: <StepInsights />,
  },
  {
    title: 'Undo any AI turn with snapshots',
    caption: 'Every prompt auto-saves a working-tree snapshot. Restore, branch off, or rewind — no commits polluted, stored on orphan git branches.',
    browserTitle: 'getorigin.io/snapshots',
    content: <StepSnapshots />,
  },
  {
    title: 'See which AI wrote each line',
    caption: 'Line-by-line AI attribution with the prompt and model that produced it. `origin blame auth.ts` — like git blame, but for AI.',
    browserTitle: 'getorigin.io/repos/acme-backend/blame/src/routes/auth.ts',
    content: <StepBlame />,
  },
];

/* ------------------------------------------------------------------ */
/*  Tour component                                                     */
/* ------------------------------------------------------------------ */

export function SoloTour({ embedded = false }: { embedded?: boolean }) {
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
    <div className={embedded ? 'text-gray-100' : 'min-h-screen bg-[#0a0b14] text-gray-100'}>
      <div className={embedded ? '' : 'max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-20'}>
        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
          {STEPS.map((s, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              className={`h-2 rounded-full transition-all duration-300 ${
                i === current ? 'w-8 bg-emerald-500' : 'w-2 bg-gray-700 hover:bg-gray-600'
              }`}
              aria-label={`Step ${i + 1}: ${s.title}`}
            />
          ))}
        </div>

        {/* Step title */}
        <div className="text-center mb-6">
          <span className="text-xs text-emerald-400 font-medium tracking-wider uppercase">
            Step {current + 1} of {STEPS.length}
          </span>
          <h2 className="text-xl sm:text-2xl font-semibold mt-1">{step.title}</h2>
        </div>

        {/* Browser mockup */}
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

        {/* Caption */}
        <p
          className="text-center text-sm text-gray-400 mt-6 max-w-2xl mx-auto transition-opacity duration-200"
          style={{ opacity: transitioning ? 0 : 1 }}
        >
          {step.caption}
        </p>

        {/* Controls */}
        <div className="flex items-center justify-center gap-4 mt-8">
          <button onClick={prev} className="p-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors" aria-label="Previous">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
          </button>
          <button
            onClick={() => setAutoPlay(!autoPlay)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
              autoPlay ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
            }`}
          >
            {autoPlay ? (
              <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6" /></svg>Pause</>
            ) : (
              <><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>Auto-play</>
            )}
          </button>
          <button onClick={next} className="p-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors" aria-label="Next">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
