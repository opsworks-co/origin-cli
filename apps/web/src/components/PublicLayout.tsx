import React, { useState, useRef, useEffect } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from './Logo';

const NAV_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/demo', label: 'Demo' },
  { to: '/docs', label: 'Docs' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/blog', label: 'Blog' },
];

const USE_CASES_SOLO = [
  { title: 'Undo a Bad AI Turn', desc: 'Snapshots every prompt. Restore, branch, or rewind without losing work.', hash: 'snapshots' },
  { title: 'Blame Every Line', desc: "Which agent wrote which line, with the prompt and the model.", hash: 'blame' },
  { title: 'Track Every Agent', desc: 'Claude, Cursor, Gemini, Codex, Copilot — one CLI, one history.', hash: 'multi-agent' },
  { title: 'Know Your AI Costs', desc: 'Spend per agent, model, and repo — rolled up across all projects.', hash: 'costs' },
];

const USE_CASES_TEAMS = [
  { title: 'AI Code Governance', desc: 'Policies, cost limits, content filters evaluated before merge.', hash: 'governance' },
  { title: 'Live Session Feed', desc: "See every developer's agents in real time. Stop runaway spend.", hash: 'visibility' },
  { title: 'Prove AI ROI', desc: 'Show leadership the business case for AI tooling spend with real numbers.', hash: 'roi' },
  { title: 'Audit Trail', desc: 'SOC 2 / ISO 27001 evidence: every prompt, diff, and model, forever.', hash: 'audit' },
];

function UseCasesDropdown({ scrollTop }: { scrollTop: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleEnter = () => {
    clearTimeout(timeoutRef.current);
    setOpen(true);
  };

  const handleLeave = () => {
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <div ref={ref} className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button
        className={`flex items-center gap-1 transition-colors ${open ? 'text-gray-100' : 'text-gray-400 hover:text-gray-100'}`}
        onClick={() => setOpen(!open)}
      >
        Use Cases
        <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 pt-3 z-50">
          <div className="w-[340px] rounded-xl border border-white/[0.08] bg-gray-900 shadow-2xl shadow-black/40 overflow-hidden">
            {/* Solo section */}
            <div className="px-4 pt-4 pb-1">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2">For Solo Developers</p>
              {USE_CASES_SOLO.map((item) => (
                <Link
                  key={item.title}
                  to={`/use-cases#${item.hash}`}
                  onClick={() => { setOpen(false); }}
                  className="block px-3 py-2.5 -mx-1 rounded-lg hover:bg-white/[0.04] transition-colors group"
                >
                  <p className="text-sm font-medium text-gray-200 group-hover:text-white transition-colors">{item.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.desc}</p>
                </Link>
              ))}
            </div>

            {/* Divider */}
            <div className="mx-4 border-t border-white/[0.06]" />

            {/* Teams section */}
            <div className="px-4 pt-3 pb-3">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2">For Teams</p>
              {USE_CASES_TEAMS.map((item) => (
                <Link
                  key={item.title}
                  to={`/use-cases#${item.hash}`}
                  onClick={() => { setOpen(false); }}
                  className="block px-3 py-2.5 -mx-1 rounded-lg hover:bg-white/[0.04] transition-colors group"
                >
                  <p className="text-sm font-medium text-gray-200 group-hover:text-white transition-colors">{item.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.desc}</p>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  // Always scroll to the top of the page on logo / nav clicks, even when the
  // user is already on the same route (normal <Link> clicks are no-ops in that case).
  // Fires after the router's own click handler via rAF so it isn't undone by
  // the navigation flow, and targets both window + root element for safety.
  const scrollTop = () => {
    const doScroll = () => {
      try { window.scrollTo({ top: 0, left: 0, behavior: 'smooth' }); } catch { window.scrollTo(0, 0); }
      if (document.documentElement) document.documentElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
    };
    doScroll();
    requestAnimationFrame(doScroll);
  };

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Nav */}
      <nav className="border-b border-gray-800/50 sticky top-0 bg-gray-950/90 backdrop-blur-sm z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link to="/" onClick={scrollTop} className="flex items-center gap-2">
              <LogoMark size={32} />
              <span className="text-lg font-semibold">Origin</span>
            </Link>
            <div className="hidden sm:flex items-center gap-6 text-sm">
              {NAV_LINKS.map((link, i) => (
                <React.Fragment key={link.to}>
                  <NavLink
                    to={link.to}
                    end={link.to === '/'}
                    onClick={scrollTop}
                    className={({ isActive }) =>
                      `transition-colors ${
                        isActive ? 'text-gray-100 font-medium' : 'text-gray-400 hover:text-gray-100'
                      }`
                    }
                  >
                    {link.label}
                  </NavLink>
                  {/* Insert Use Cases dropdown after Docs */}
                  {link.to === '/docs' && <UseCasesDropdown scrollTop={scrollTop} />}
                </React.Fragment>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3">
                {user.accountType === 'developer' ? (
                  <Link to="/me" className="btn-primary text-sm bg-emerald-600 hover:bg-emerald-500">
                    My Dashboard
                  </Link>
                ) : (
                  <Link to="/dashboard" className="btn-primary text-sm">
                    Dashboard
                  </Link>
                )}
              </div>
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

      {/* Page content */}
      <main className="flex-1 animate-fade-in">{children}</main>

      {/* Footer */}
      <footer className="border-t border-gray-800/50">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <LogoMark size={24} />
              <span className="font-semibold text-sm">Origin</span>
            </div>
            <div className="flex items-center gap-6 text-xs text-gray-600">
              <Link to="/demo" className="hover:text-gray-400 transition-colors">Demo</Link>
              <Link to="/docs" className="hover:text-gray-400 transition-colors">Documentation</Link>
              <Link to="/docs#cli" className="hover:text-gray-400 transition-colors">CLI</Link>
              <Link to="/pricing" className="hover:text-gray-400 transition-colors">Pricing</Link>
              <span>&copy; {new Date().getFullYear()} Origin</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
