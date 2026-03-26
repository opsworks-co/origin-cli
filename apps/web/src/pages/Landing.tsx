import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

// ── Animated grid background for hero ──────────────────────────────────────
function GridBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Animated dot grid */}
      <div className="absolute inset-0" style={{
        backgroundImage: 'radial-gradient(circle, rgba(99,102,241,0.15) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
        maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 70%)',
        WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 70%)',
      }} />
      {/* Animated glow pulse */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full animate-pulse"
        style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)' }} />
    </div>
  );
}

// ── Fade-in on scroll hook ─────────────────────────────────────────────────
function useFadeIn() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, className: `transition-all duration-700 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}` };
}

function FadeIn({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const fade = useFadeIn();
  return (
    <div ref={fade.ref} className={fade.className} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

const FEATURES = [
  {
    title: 'AI Blame — Line-Level Attribution',
    desc: 'Run origin blame on any file. See exactly which AI agent wrote each line, what prompt generated it, the model used, and the full session it came from.',
    icon: '🔍',
    tag: 'NEW',
  },
  {
    title: 'Per-File Attribution Context',
    desc: 'When an agent opens a file, Origin injects line-level authorship context into the system prompt — so every AI knows what other AIs changed before it.',
    icon: '📄',
    tag: 'NEW',
  },
  {
    title: 'Live Session Dashboard',
    desc: 'Watch AI sessions in real-time across your org. See active agents, tokens burned, cost per session, and kill runaway sessions instantly.',
    icon: '⚡',
    tag: 'NEW',
  },
  {
    title: 'Full Session Replay',
    desc: 'Every prompt, response, tool call, and file change — recorded with timestamps, token counts, and cost breakdowns. Replay any session from CLI or dashboard.',
    icon: '▶',
  },
  {
    title: 'Policy Enforcement',
    desc: 'Block secrets, enforce file restrictions, set cost limits, require human review. Policies evaluate in real-time and block PRs with violations.',
    icon: '🛡',
  },
  {
    title: 'Cost & Token Tracking',
    desc: 'Track spend per agent, model, repo, and developer. Set budget limits. See which models deliver the best ROI across your engineering org.',
    icon: '💰',
    tag: 'NEW',
  },
];

const CAPABILITIES = [
  {
    category: 'For CTOs',
    icon: '📊',
    items: [
      'See what AI agents are writing across every repo',
      'Track engineering ROI — cost per session, tokens per commit',
      'Compare model performance: Claude vs Gemini vs GPT',
      'Identify top AI power users and adoption trends',
    ],
  },
  {
    category: 'For Security Leads',
    icon: '🔒',
    items: [
      'Enforce file access policies in real-time',
      'Secret scanner catches leaked credentials before merge',
      'Content filter blocks sensitive data in AI outputs',
      'Complete audit trail for SOC 2 and compliance',
    ],
  },
  {
    category: 'For Developers',
    icon: '⌨️',
    items: [
      'origin init — 30 seconds to set up, zero config after that',
      'origin blame — see which AI wrote any line of code',
      'origin explain — replay the conversation behind any commit',
      'Works with Claude Code, Cursor, Gemini CLI, and Codex',
    ],
  },
];

const AGENTS = [
  { name: 'Claude Code', status: 'Supported', badge: 'bg-purple-600/20 text-purple-400 border-purple-500/30' },
  { name: 'Cursor', status: 'Supported', badge: 'bg-blue-600/20 text-blue-400 border-blue-500/30' },
  { name: 'Gemini CLI', status: 'Supported', badge: 'bg-amber-600/20 text-amber-400 border-amber-500/30' },
  { name: 'Codex', status: 'Supported', badge: 'bg-green-600/20 text-green-400 border-green-500/30' },
  { name: 'Copilot', status: 'Coming soon', badge: 'bg-gray-800/50 text-gray-500 border-gray-700/50' },
  { name: 'Windsurf', status: 'Coming soon', badge: 'bg-gray-800/50 text-gray-500 border-gray-700/50' },
  { name: 'Aider', status: 'Coming soon', badge: 'bg-gray-800/50 text-gray-500 border-gray-700/50' },
];

const INSTALL_CMD = 'npm i -g https://getorigin.io/cli/origin-cli-latest.tgz';

function InstallCommand() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-10 max-w-xl mx-auto">
      <button
        onClick={handleCopy}
        className="w-full group relative bg-gray-900 border border-gray-700 hover:border-indigo-500/50 rounded-xl px-5 py-4 text-left transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <span className="text-green-400 text-sm font-mono shrink-0">$</span>
          <code className="text-sm font-mono text-gray-200 flex-1 whitespace-nowrap">
            {INSTALL_CMD}
          </code>
          <span className="text-xs text-gray-500 group-hover:text-indigo-400 transition-colors shrink-0">
            {copied ? 'Copied!' : 'Click to copy'}
          </span>
        </div>
      </button>
      <p className="text-xs text-gray-600 mt-2">Requires Node.js 18+</p>
    </div>
  );
}

function TerminalDemo() {
  return (
    <div className="mt-16 max-w-3xl mx-auto">
      <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden shadow-2xl shadow-indigo-900/10">
        {/* Terminal header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-green-500/80" />
          <span className="ml-2 text-xs text-gray-500 font-mono">origin blame src/api.ts</span>
        </div>
        {/* Terminal content */}
        <div className="px-5 py-4 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre text-left">
<span className="text-gray-500">{'  1 │ '}</span><span className="text-purple-400">Claude    </span><span className="text-gray-600">│ 3h ago  │ </span><span className="text-gray-300">{"import express from 'express';"}</span>{'\n'}
<span className="text-gray-500">{'  2 │ '}</span><span className="text-purple-400">Claude    </span><span className="text-gray-600">│ 3h ago  │ </span><span className="text-gray-300">{"import { prisma } from './db';"}</span>{'\n'}
<span className="text-gray-500">{'  3 │ '}</span><span className="text-gray-400">Human     </span><span className="text-gray-600">│ 2d ago  │ </span>{'\n'}
<span className="text-gray-500">{'  4 │ '}</span><span className="text-amber-400">Gemini    </span><span className="text-gray-600">│ 1h ago  │ </span><span className="text-gray-300">{'export async function getUsers() {'}</span>{'\n'}
<span className="text-gray-500">{'  5 │ '}</span><span className="text-amber-400">Gemini    </span><span className="text-gray-600">│ 1h ago  │ </span><span className="text-gray-300">{'  const users = await prisma.user.findMany();'}</span>{'\n'}
<span className="text-gray-500">{'  6 │ '}</span><span className="text-blue-400">Cursor    </span><span className="text-gray-600">│ 30m ago │ </span><span className="text-gray-300">{'  return users.filter(u => u.active);'}</span>{'\n'}
<span className="text-gray-500">{'  7 │ '}</span><span className="text-amber-400">Gemini    </span><span className="text-gray-600">│ 1h ago  │ </span><span className="text-gray-300">{'}'}</span>{'\n'}
<span className="text-gray-500">{'  8 │ '}</span><span className="text-gray-400">Human     </span><span className="text-gray-600">│ 2d ago  │ </span>{'\n'}
<span className="text-gray-500">{'  9 │ '}</span><span className="text-purple-400">Claude    </span><span className="text-gray-600">│ 3h ago  │ </span><span className="text-gray-300">{'// retry with exponential backoff'}</span>{'\n'}
<span className="text-gray-500">{' 10 │ '}</span><span className="text-purple-400">Claude    </span><span className="text-gray-600">│ 3h ago  │ </span><span className="text-gray-300">{'export async function fetchWithRetry(url: string) {'}</span>
        </div>
        <div className="px-5 py-3 border-t border-gray-800 flex items-center gap-4">
          <span className="text-xs text-gray-500">10 lines</span>
          <span className="text-xs"><span className="text-purple-400">●</span> Claude: 40%</span>
          <span className="text-xs"><span className="text-amber-400">●</span> Gemini: 30%</span>
          <span className="text-xs"><span className="text-blue-400">●</span> Cursor: 10%</span>
          <span className="text-xs"><span className="text-gray-400">●</span> Human: 20%</span>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <GridBackground />
        {/* Gradient orbs */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl animate-[pulse_4s_ease-in-out_infinite]" />
        <div className="absolute top-20 right-1/4 w-80 h-80 bg-purple-600/10 rounded-full blur-3xl animate-[pulse_5s_ease-in-out_infinite_1s]" />
        <div className="absolute bottom-0 left-1/2 w-64 h-64 bg-cyan-600/5 rounded-full blur-3xl animate-[pulse_6s_ease-in-out_infinite_2s]" />

        <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 text-xs font-medium mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
            AI Code Attribution &amp; Governance
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-gray-100 leading-tight tracking-tight">
            Your AI agents build fast.
            <br />
            <span className="bg-gradient-to-r from-indigo-400 via-purple-400 to-indigo-400 bg-clip-text text-transparent bg-[length:200%_auto] animate-[shimmer_3s_linear_infinite]">
              Origin keeps them in check.
            </span>
          </h1>
          <p className="mt-6 text-lg md:text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
            Your team uses Claude, Cursor, Gemini, Codex &mdash; but nobody tracks which AI wrote what.
            Origin records every AI session, attributes every line, and enforces your policies before merge.
          </p>

          {/* Top 5 commands — Hero callout */}
          <div className="mt-10 max-w-2xl mx-auto">
            <div className="grid grid-cols-5 gap-2">
              {[
                { cmd: 'init', desc: 'Setup in 30s' },
                { cmd: 'blame', desc: 'AI attribution' },
                { cmd: 'sessions', desc: 'Track sessions' },
                { cmd: 'stats', desc: 'Cost & usage' },
                { cmd: 'explain', desc: 'Session replay' },
              ].map((c) => (
                <div key={c.cmd} className="bg-gray-900/80 border border-gray-800 rounded-lg px-2 py-2 text-center">
                  <code className="text-xs font-mono text-indigo-400 whitespace-nowrap">origin {c.cmd}</code>
                  <p className="text-[10px] text-gray-500 mt-0.5">{c.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Video demo */}
          <div className="mt-10 max-w-3xl mx-auto rounded-xl overflow-hidden border border-gray-800 shadow-2xl shadow-indigo-900/10">
            <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0 }}>
              <iframe
                src="https://www.loom.com/embed/9916f9b26b5142b399f8e6822bc2ca02?sid=auto&hide_owner=true&hide_share=true&hide_title=true&hideEmbedTopBar=true"
                frameBorder="0"
                allowFullScreen
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
              />
            </div>
          </div>

          {/* Terminal demo removed — video is enough */}

          {/* Install one-liner */}
          <InstallCommand />

          <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/register"
              className="btn-primary px-8 py-3 text-base font-semibold rounded-xl shadow-lg shadow-indigo-600/20"
            >
              Get started free
            </Link>
            <a
              href="https://github.com/dolobanko/origin-cli"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-400 hover:text-gray-100 transition-colors"
            >
              Open Source on GitHub &rarr;
            </a>
          </div>

          {/* Agent badges */}
          <div className="mt-16 flex flex-wrap items-center justify-center gap-3">
            {AGENTS.map((agent) => (
              <span
                key={agent.name}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium ${agent.badge}`}
              >
                {agent.name}
                {agent.status === 'Coming soon' && (
                  <span className="text-[10px] opacity-60">soon</span>
                )}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* What's New */}
      <section className="bg-indigo-950/20 border-y border-indigo-500/10">
        <div className="max-w-4xl mx-auto px-6 py-12">
          <div className="flex items-center gap-2 mb-6">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-sm font-semibold text-green-400">What&apos;s New</span>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { title: 'Per-File Attribution', desc: 'Agents see line-level authorship when reading files' },
              { title: 'System Prompt Injection', desc: 'AI agents get context about what other AIs changed' },
              { title: 'Secret Scanner', desc: 'Block credentials from leaking into AI-generated code' },
              { title: 'Live Sessions', desc: 'Watch your team\'s AI sessions in real-time' },
            ].map((item) => (
              <div key={item.title} className="bg-gray-900/60 border border-gray-800 rounded-lg px-4 py-3">
                <h4 className="text-sm font-semibold text-gray-200">{item.title}</h4>
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <FadeIn>
      <section id="features" className="max-w-6xl mx-auto px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold">Know exactly which AI wrote every line</h2>
          <p className="text-gray-400 mt-3 max-w-xl mx-auto">
            From line-level attribution to real-time policy enforcement &mdash;
            Origin gives you complete visibility into AI-authored code.
          </p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="card hover:border-indigo-500/30 transition-all duration-300 group relative hover:shadow-lg hover:shadow-indigo-500/5 hover:-translate-y-1"
            >
              {f.tag && (
                <span className="absolute top-3 right-3 px-2 py-0.5 rounded-full bg-green-600/20 text-green-400 text-[10px] font-semibold border border-green-500/30">
                  {f.tag}
                </span>
              )}
              <div className="w-10 h-10 rounded-lg bg-indigo-600/10 flex items-center justify-center text-indigo-400 text-xl mb-4 group-hover:bg-indigo-600/20 transition-colors">
                {f.icon}
              </div>
              <h3 className="text-lg font-semibold text-gray-100">{f.title}</h3>
              <p className="mt-2 text-sm text-gray-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>
      </FadeIn>

      {/* Two-Part Value Prop */}
      <section className="bg-gray-900/30 border-y border-gray-800/50">
        <div className="max-w-5xl mx-auto px-6 py-24">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold">Free CLI + Team Platform</h2>
            <p className="text-gray-400 mt-3 max-w-xl mx-auto">
              Start standalone &mdash; no account needed. Add team features when you&apos;re ready.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-8">
            <div className="card border-green-500/20">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-green-400 font-mono text-sm">$</span>
                <span className="text-lg font-semibold text-gray-200">Origin CLI</span>
                <span className="px-2 py-0.5 rounded-full bg-green-600/20 text-green-400 text-[10px] font-semibold border border-green-500/30">Free &amp; Open Source</span>
              </div>
              <ul className="space-y-2.5 text-sm text-gray-400">
                <li className="flex items-start gap-2"><span className="text-green-400 mt-0.5">✓</span> Zero config — <code className="text-indigo-400 text-xs">origin init</code> and you&apos;re done</li>
                <li className="flex items-start gap-2"><span className="text-green-400 mt-0.5">✓</span> AI blame, session replay, stats — all local via git notes</li>
                <li className="flex items-start gap-2"><span className="text-green-400 mt-0.5">✓</span> Works offline — no server, no account, no telemetry</li>
                <li className="flex items-start gap-2"><span className="text-green-400 mt-0.5">✓</span> Claude Code, Cursor, Gemini CLI, Codex supported</li>
              </ul>
              <pre className="mt-4 bg-gray-800 rounded-lg px-4 py-3 text-xs font-mono text-gray-300 overflow-x-auto">
{`$ origin init           # detect agents, install hooks
$ origin blame app.ts   # see who wrote what
$ origin sessions       # list AI sessions
$ origin explain abc123 # replay a session`}
              </pre>
            </div>
            <div className="card border-indigo-500/20">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-indigo-400 text-sm">◆</span>
                <span className="text-lg font-semibold text-gray-200">Origin Platform</span>
                <span className="px-2 py-0.5 rounded-full bg-indigo-600/20 text-indigo-400 text-[10px] font-semibold border border-indigo-500/30">Teams</span>
              </div>
              <ul className="space-y-2.5 text-sm text-gray-400">
                <li className="flex items-start gap-2"><span className="text-green-400 mt-0.5">✓</span> Live dashboard — sessions, costs, agents, repos</li>
                <li className="flex items-start gap-2"><span className="text-green-400 mt-0.5">✓</span> Policy enforcement — block secrets, restrict files, set budgets</li>
                <li className="flex items-start gap-2"><span className="text-green-400 mt-0.5">✓</span> PR merge gating — GitHub &amp; GitLab status checks</li>
                <li className="flex items-start gap-2"><span className="text-green-400 mt-0.5">✓</span> Compliance reports — SOC 2 ready audit trail</li>
              </ul>
              <div className="mt-4 bg-gray-800 rounded-lg px-4 py-3">
                <p className="text-xs text-gray-400">
                  <span className="text-indigo-400 font-semibold">getorigin.io</span> — dashboard, policies, PR compliance.
                </p>
                <Link to="/register" className="inline-block mt-2 text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium">
                  Start free trial &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="max-w-5xl mx-auto px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold">How Origin works</h2>
          <p className="text-gray-400 mt-3 max-w-xl mx-auto">
            From code to merge &mdash; Origin tracks every AI coding session and enforces your policies automatically.
          </p>
        </div>
        <div className="relative">
          <div className="absolute left-6 top-0 bottom-0 w-px bg-gray-800 hidden md:block" />
          <div className="space-y-12">
            {[
              {
                step: '1',
                title: 'Developer codes with AI',
                desc: 'A developer uses Claude Code, Cursor, Gemini, or Codex. Origin\'s hooks silently track the session — prompts, files changed, model, cost, and token usage.',
                accent: 'bg-indigo-600',
              },
              {
                step: '2',
                title: 'Origin captures & attributes',
                desc: 'Every prompt-to-code-change is recorded. Per-file attribution tags each line with its author. Policies evaluate in real-time — file restrictions, model allowlists, cost limits, secret scanning.',
                accent: 'bg-purple-600',
              },
              {
                step: '3',
                title: 'AI agents get context',
                desc: 'When an agent opens a file, Origin injects attribution context — which lines were AI-generated, by which agent, from which prompt. Agents make better decisions with full history.',
                accent: 'bg-cyan-600',
              },
              {
                step: '4',
                title: 'PR gets a governance check',
                desc: 'Origin posts an AI governance status check on the pull request — sessions linked, total cost, policy violations. If policies are violated, the PR is blocked from merging.',
                accent: 'bg-amber-500',
              },
              {
                step: '5',
                title: 'Team reviews and ships',
                desc: 'Flagged sessions are reviewed in the dashboard or CLI. Once approved, the status check goes green and the PR can be merged. Full audit trail preserved.',
                accent: 'bg-green-500',
              },
            ].map((s) => (
              <div key={s.step} className="flex items-start gap-6 relative">
                <div className={`${s.accent} w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-lg shrink-0 z-10 shadow-lg`}>
                  {s.step}
                </div>
                <div className="pt-1">
                  <h3 className="text-lg font-semibold text-gray-100">{s.title}</h3>
                  <p className="mt-1.5 text-sm text-gray-400 leading-relaxed max-w-2xl">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Use Cases */}
      <section id="use-cases" className="bg-gray-950/50 border-y border-gray-800/50">
        <div className="max-w-6xl mx-auto px-6 py-24">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold">Built for every stakeholder</h2>
            <p className="text-gray-400 mt-3 max-w-xl mx-auto">
              Whether you&apos;re responsible for engineering velocity, security compliance,
              or developer experience &mdash; Origin has you covered.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {CAPABILITIES.map((cap) => (
              <div key={cap.category} className="card">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-xl">{cap.icon}</span>
                  <h3 className="text-lg font-semibold text-indigo-400">{cap.category}</h3>
                </div>
                <ul className="space-y-3">
                  {cap.items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-400">
                      <span className="text-green-400 mt-0.5 flex-shrink-0">✓</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section id="comparison" className="max-w-6xl mx-auto px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold">How Origin compares</h2>
          <p className="text-gray-400 mt-3 max-w-xl mx-auto">
            Origin is the most complete AI coding governance platform. Here&apos;s how it stacks up.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-800 rounded-xl overflow-hidden">
            <thead>
              <tr className="bg-gray-800/60">
                <th className="text-left px-5 py-3 text-gray-400 font-medium w-1/4">Capability</th>
                <th className="text-center px-5 py-3 text-indigo-400 font-semibold">Origin</th>
                <th className="text-center px-5 py-3 text-gray-400 font-medium">Entire</th>
                <th className="text-center px-5 py-3 text-gray-400 font-medium">git-ai</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {[
                ['Session recording & replay', true, true, false],
                ['Prompt & transcript capture', true, true, true],
                ['AI blame (line-level attribution)', true, false, true],
                ['Per-file attribution context injection', true, false, false],
                ['System prompt injection (cross-agent)', true, false, false],
                ['Policy enforcement (file, model, cost)', true, false, false],
                ['Secret & credential scanning', true, false, false],
                ['PR/MR merge gating', true, false, false],
                ['Live session dashboard', true, false, false],
                ['Cost & token tracking', true, false, false],
                ['Budget controls', true, false, false],
                ['Multi-agent support (4+ agents)', true, false, false],
                ['MCP server (real-time enforcement)', true, false, false],
                ['Self-hosted / open-source CLI', true, false, true],
                ['GitHub & GitLab integration', true, false, false],
              ].map(([feature, origin, entire, gitai], i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-gray-900/30' : ''}>
                  <td className="px-5 py-2.5 text-gray-300">{feature as string}</td>
                  <td className="px-5 py-2.5 text-center">{origin ? <span className="text-green-400">✓</span> : <span className="text-gray-600">&mdash;</span>}</td>
                  <td className="px-5 py-2.5 text-center">{entire ? <span className="text-green-400">✓</span> : <span className="text-gray-600">&mdash;</span>}</td>
                  <td className="px-5 py-2.5 text-center">{gitai ? <span className="text-green-400">✓</span> : <span className="text-gray-600">&mdash;</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Install / CTA */}
      <section id="setup" className="bg-gradient-to-b from-gray-950 to-indigo-950/20 border-t border-gray-800/50">
        <div className="max-w-4xl mx-auto px-6 py-24 text-center">
          <h2 className="text-3xl font-bold mb-4">
            Get started in 30 seconds
          </h2>
          <p className="text-gray-400 mb-10 max-w-xl mx-auto">
            Install the CLI and run <code className="text-indigo-400">origin init</code>. Works standalone — no server, no account.
            Add <code className="text-indigo-400">origin login</code> later for team dashboard and policies.
          </p>

          <div className="max-w-2xl mx-auto mb-12">
            <InstallCommand />

            <div className="grid sm:grid-cols-3 gap-6 mt-10">
              {[
                { step: '1', title: 'Install CLI', desc: 'One npm command' },
                { step: '2', title: 'origin init', desc: 'Detects agents & installs hooks' },
                { step: '3', title: 'Code with AI', desc: 'Everything tracked automatically' },
              ].map((s) => (
                <div key={s.step} className="text-center">
                  <div className="w-10 h-10 rounded-full bg-indigo-600 text-white font-bold text-sm flex items-center justify-center mx-auto mb-3">
                    {s.step}
                  </div>
                  <p className="font-semibold text-gray-200 text-sm">{s.title}</p>
                  <p className="text-xs text-gray-500 mt-1">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/register"
              className="btn-primary px-10 py-3 text-base font-semibold rounded-xl shadow-lg shadow-indigo-600/20"
            >
              Create your account &rarr;
            </Link>
            <a
              href="https://github.com/dolobanko/origin-cli"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-400 hover:text-gray-100 transition-colors"
            >
              Star on GitHub &rarr;
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
