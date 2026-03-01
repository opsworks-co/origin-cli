import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const VALUE_PROPS = [
  {
    title: 'Full Session Replay',
    desc: 'See every prompt, response, and tool call your AI agents made. Complete transcripts with timestamps and token counts.',
    icon: '\u25B6',
  },
  {
    title: 'Policy Enforcement',
    desc: 'Set rules for file access, model usage, cost limits, and review requirements. Get alerted when agents step out of bounds.',
    icon: '\uD83D\uDEE1',
  },
  {
    title: 'Complete Audit Trail',
    desc: 'Every action logged. Every change tracked. Ready for compliance reviews, security audits, and SOC 2.',
    icon: '\uD83D\uDCDC',
  },
];

export default function Landing() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Nav */}
      <nav className="border-b border-gray-800/50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm">
              O
            </div>
            <span className="text-lg font-semibold">Origin</span>
          </div>
          <div className="flex items-center gap-4">
            {user ? (
              <Link to="/dashboard" className="btn-primary">
                Go to Dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className="text-sm text-gray-400 hover:text-gray-100 transition-colors">
                  Sign in
                </Link>
                <Link to="/register" className="btn-primary text-sm">
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Gradient orbs */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl" />
        <div className="absolute top-20 right-1/4 w-80 h-80 bg-purple-600/10 rounded-full blur-3xl" />

        <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 text-xs font-medium mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
            AI Agent Governance Platform
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-gray-100 leading-tight tracking-tight">
            Know exactly what your{' '}
            <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              AI agents
            </span>{' '}
            are writing.
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
        </div>
      </section>

      {/* Value Props */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="grid md:grid-cols-3 gap-6">
          {VALUE_PROPS.map((vp) => (
            <div
              key={vp.title}
              className="card hover:border-gray-700 transition-colors group"
            >
              <div className="w-10 h-10 rounded-lg bg-indigo-600/10 flex items-center justify-center text-indigo-400 text-xl mb-4 group-hover:bg-indigo-600/20 transition-colors">
                {vp.icon}
              </div>
              <h3 className="text-lg font-semibold text-gray-100">{vp.title}</h3>
              <p className="mt-2 text-sm text-gray-400 leading-relaxed">{vp.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800/50">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-xs text-gray-600">
          <span>&copy; {new Date().getFullYear()} Origin. All rights reserved.</span>
          <span>AI Agent Governance</span>
        </div>
      </footer>
    </div>
  );
}
