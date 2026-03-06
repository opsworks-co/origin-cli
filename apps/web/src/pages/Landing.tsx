import React from 'react';
import { Link } from 'react-router-dom';

const FEATURES = [
  {
    title: 'Full Session Replay',
    desc: 'See every prompt, response, and tool call your AI agents made. Complete transcripts with timestamps, token counts, and cost breakdowns.',
    icon: '\u25B6',
  },
  {
    title: 'Policy Enforcement',
    desc: 'Set rules for file access, model usage, cost limits, and review requirements. Enforce them in real-time via MCP.',
    icon: '\uD83D\uDEE1',
  },
  {
    title: 'Complete Audit Trail',
    desc: 'Every action logged. Every change tracked. Ready for compliance reviews, security audits, and SOC 2.',
    icon: '\uD83D\uDCDC',
  },
  {
    title: 'Repository Integration',
    desc: 'Connect local or GitHub repos. Auto-sync commits, identify AI-authored code, and track authorship percentages.',
    icon: '\uD83D\uDCC1',
  },
  {
    title: 'Agent Management',
    desc: 'Register and monitor your AI coding agents. Track sessions, costs, and model usage per agent across your org.',
    icon: '\uD83E\uDD16',
  },
  {
    title: 'Engineering Insights',
    desc: 'Visualize AI adoption trends, cost by model, top contributors, and sessions by repository with interactive charts.',
    icon: '\uD83D\uDCCA',
  },
];

const CAPABILITIES = [
  {
    category: 'For CTOs',
    items: [
      'See what AI agents are writing across every repo',
      'Track engineering ROI and hours saved by AI',
      'Monitor model usage, costs, and token spend',
      'Identify top AI power users on your team',
    ],
  },
  {
    category: 'For CSOs',
    items: [
      'Enforce file access policies in real-time',
      'Block agents from touching sensitive files',
      'Require human review for all AI code',
      'Complete audit trail for SOC 2 and compliance',
    ],
  },
  {
    category: 'For Developers',
    items: [
      'CLI with 15 commands \u2014 sessions, agents, repos, policies, stats',
      'MCP server with 12 tools for Claude Code and Cursor',
      'Automatic session tracking with zero config',
      'Review, approve, or flag AI sessions from CLI or dashboard',
    ],
  },
];

const TOOLS = [
  { name: 'Claude Code', badge: 'badge-purple' },
  { name: 'Cursor', badge: 'badge-blue' },
  { name: 'GitHub Copilot', badge: 'badge-gray' },
  { name: 'Gemini CLI', badge: 'badge-amber' },
  { name: 'Aider', badge: 'badge-green' },
];

export default function Landing() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Gradient orbs */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl" />
        <div className="absolute top-20 right-1/4 w-80 h-80 bg-purple-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-1/2 w-64 h-64 bg-cyan-600/5 rounded-full blur-3xl" />

        <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 text-xs font-medium mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
            AI Agent Governance Platform
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-gray-100 leading-tight tracking-tight">
            Your AI agents build fast.
            <br />
            <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              Origin keeps them in check.
            </span>
          </h1>
          <p className="mt-6 text-lg md:text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
            Origin gives CTOs and CSOs full visibility into every AI coding session
            &mdash; what was prompted, what was built, and whether it followed the rules.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/register"
              className="btn-primary px-8 py-3 text-base font-semibold rounded-xl shadow-lg shadow-indigo-600/20"
            >
              Get started free
            </Link>
            <Link
              to="/login"
              className="text-sm text-gray-400 hover:text-gray-100 transition-colors"
            >
              Already have an account? Sign in &rarr;
            </Link>
          </div>

          {/* Trust bar */}
          <div className="mt-16 flex flex-wrap items-center justify-center gap-3">
            {TOOLS.map((tool) => (
              <span key={tool.name} className={`${tool.badge} text-xs`}>
                {tool.name}
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-600 mt-2">Works with every AI coding tool</p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-6xl mx-auto px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold">Everything you need for AI governance</h2>
          <p className="text-gray-400 mt-3 max-w-xl mx-auto">
            From session replay to real-time policy enforcement, Origin covers every aspect of
            managing AI-authored code at scale.
          </p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="card hover:border-gray-700 transition-colors group"
            >
              <div className="w-10 h-10 rounded-lg bg-indigo-600/10 flex items-center justify-center text-indigo-400 text-xl mb-4 group-hover:bg-indigo-600/20 transition-colors">
                {f.icon}
              </div>
              <h3 className="text-lg font-semibold text-gray-100">{f.title}</h3>
              <p className="mt-2 text-sm text-gray-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Use Cases */}
      <section id="use-cases" className="bg-gray-900/30 border-y border-gray-800/50">
        <div className="max-w-6xl mx-auto px-6 py-24">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold">Built for every stakeholder</h2>
            <p className="text-gray-400 mt-3 max-w-xl mx-auto">
              Whether you&apos;re responsible for engineering velocity, security compliance,
              or developer experience, Origin has you covered.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {CAPABILITIES.map((cap) => (
              <div key={cap.category} className="card">
                <h3 className="text-lg font-semibold text-indigo-400 mb-4">{cap.category}</h3>
                <ul className="space-y-3">
                  {cap.items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-400">
                      <span className="text-green-400 mt-0.5 flex-shrink-0">&#10003;</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section id="integrations" className="max-w-6xl mx-auto px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold">Works with your stack</h2>
          <p className="text-gray-400 mt-3 max-w-xl mx-auto">
            Origin integrates with AI coding tools through the Model Context Protocol (MCP)
            and supports any Git repository.
          </p>
        </div>
        <div className="grid md:grid-cols-2 gap-8">
          <div className="card">
            <h3 className="text-lg font-semibold mb-3">MCP Server &mdash; 12 Tools</h3>
            <p className="text-sm text-gray-400 mb-4">
              Full platform access from inside Claude Code and Cursor. Policy enforcement,
              session tracking, reviews, stats, and audit &mdash; all via MCP tools.
            </p>
            <pre className="bg-gray-800 rounded-lg px-4 py-3 text-xs font-mono text-gray-300 overflow-x-auto leading-relaxed">
{`check_file_access   \u2192 enforce policies
start/end_session   \u2192 track sessions
report_violation    \u2192 compliance logging
list_sessions       \u2192 browse sessions
review_session      \u2192 approve/reject/flag
get_stats           \u2192 dashboard stats
list_agents/repos   \u2192 view platform data
get_audit_log       \u2192 audit trail`}
            </pre>
          </div>
          <div className="card">
            <h3 className="text-lg font-semibold mb-3">CLI &mdash; 15 Commands</h3>
            <p className="text-sm text-gray-400 mb-4">
              Full command-line management. Sessions, agents, repos, policies,
              reviews, stats, and audit &mdash; all from your terminal.
            </p>
            <pre className="bg-gray-800 rounded-lg px-4 py-3 text-xs font-mono text-gray-300 overflow-x-auto leading-relaxed">
{`$ origin login && origin init
$ origin sessions --status unreviewed
$ origin review abc123 --approve
$ origin agents && origin repos
$ origin stats && origin audit`}
            </pre>
          </div>
        </div>
      </section>

      {/* Setup / CTA */}
      <section id="setup" className="bg-gradient-to-b from-gray-950 to-indigo-950/20 border-t border-gray-800/50">
        <div className="max-w-4xl mx-auto px-6 py-24 text-center">
          <h2 className="text-3xl font-bold mb-4">
            Get started in under 5 minutes
          </h2>
          <p className="text-gray-400 mb-10 max-w-xl mx-auto">
            Create an account, connect your repos, and start tracking AI-authored code
            across your organization.
          </p>
          <div className="grid sm:grid-cols-4 gap-4 mb-12">
            {[
              { step: '1', title: 'Create account', desc: 'Sign up with your email' },
              { step: '2', title: 'Connect repos', desc: 'Add local or GitHub repos' },
              { step: '3', title: 'Set policies', desc: 'Define governance rules' },
              { step: '4', title: 'Start coding', desc: 'Sessions tracked automatically' },
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
          <Link
            to="/register"
            className="btn-primary px-10 py-3 text-base font-semibold rounded-xl shadow-lg shadow-indigo-600/20"
          >
            Start for free &rarr;
          </Link>
        </div>
      </section>
    </>
  );
}
