import React from 'react';
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
              {NAV_LINKS.map((link) => (
                <NavLink
                  key={link.to}
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
