import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { CLITour } from './DemoCLI';
import { PlatformTour } from './DemoPlatform';

const TABS = [
  { id: 'cli', label: 'Origin CLI', icon: '⌨️' },
  { id: 'solo', label: 'Origin Solo', icon: '👤' },
  { id: 'platform', label: 'Origin Team', icon: '🖥️' },
] as const;

type Tab = (typeof TABS)[number]['id'];

export default function Demo() {
  const [tab, setTab] = useState<Tab>('cli');

  return (
    <>
      <Helmet>
        <title>Demo — Origin | See AI Code Governance in Action</title>
        <meta
          name="description"
          content="Interactive walkthrough of Origin's CLI and platform. See how to track, review, and enforce policies on AI-authored code."
        />
        <link rel="canonical" href="https://getorigin.io/demo" />
      </Helmet>

      <div className="min-h-screen bg-[#0a0b14] text-gray-100">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-20">
          {/* ── Header ──────────────────────────────────────── */}
          <div className="text-center mb-10">
            <h1 className="text-3xl sm:text-4xl font-bold mb-3">See Origin in action</h1>
            <p className="text-gray-400 max-w-2xl mx-auto text-sm sm:text-base">
              Interactive walkthroughs of the Origin CLI and platform. Click through or sit back and watch.
            </p>
          </div>

          {/* ── Tab switcher ────────────────────────────────── */}
          <div className="flex items-center justify-center gap-2 mb-10">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all border ${
                  tab === t.id
                    ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                    : 'bg-gray-800/50 border-gray-700/50 text-gray-400 hover:text-gray-200 hover:border-gray-600'
                }`}
              >
                <span>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Tour content ────────────────────────────────── */}
          {tab === 'cli' && <CLITour embedded />}
          {tab === 'solo' && (
            <div className="text-center py-16 space-y-4">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-3xl">👤</div>
              <h3 className="text-xl font-semibold">Origin Solo Demo</h3>
              <p className="text-gray-400 max-w-md mx-auto text-sm">
                Your personal AI coding dashboard — track sessions, view costs, and replay prompts across all your AI agents. Free forever.
              </p>
              <Link to="/register?type=developer" className="inline-block mt-4 px-6 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors">
                Get free account &rarr;
              </Link>
            </div>
          )}
          {tab === 'platform' && <PlatformTour embedded />}

          {/* ── CTA ─────────────────────────────────────────── */}
          <div className="mt-16 text-center border border-gray-800 rounded-2xl p-8 sm:p-12 bg-gradient-to-b from-gray-900/50 to-transparent">
            <h2 className="text-2xl sm:text-3xl font-bold mb-3">Ready to get started?</h2>
            <p className="text-gray-400 mb-8 max-w-lg mx-auto text-sm sm:text-base">
              Set up AI code governance for your team in under 5 minutes. Free for individuals, no credit card required.
            </p>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <Link
                to="/register"
                className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 py-3 rounded-lg transition-colors"
              >
                Create free account
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </Link>
              <Link
                to="/docs"
                className="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium px-6 py-3 rounded-lg border border-gray-700 transition-colors"
              >
                View documentation
              </Link>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
