import React, { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import NotificationBell from './NotificationBell';
// import ChatWidget from './ChatWidget'; // disabled — see comment below
import ProductTour, { DASHBOARD_TOUR } from './ProductTour';
import { LogoMark } from './Logo';
import {
  FolderGit2,
  Settings,
  Lightbulb,
  Play,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
  Sparkles,
} from 'lucide-react';

// Navigation is grouped by frequency of use.
// "Workspace" = things you interact with every session.
// "Account" = one-time setup & configuration.
const NAV_GROUPS = [
  {
    label: 'Workspace',
    items: [
      { to: '/repos',    label: 'Repositories', icon: FolderGit2 },
      { to: '/sessions', label: 'Sessions',     icon: Play },
      // Insights now absorbs the old solo Dashboard content — one landing page.
      { to: '/me',       label: 'Insights',     icon: Lightbulb },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/settings',     label: 'Settings',     icon: Settings },
    ],
  },
];

export default function DeveloperLayout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // One-time tour nudge: Register pages set `origin:tour-highlight = '1'`
  // so new accounts see a pulsing Tour button on their very first session.
  // Cleared on click or after the user has been on a page for 60s without
  // clicking — so it never lingers forever.
  const [tourHighlight, setTourHighlight] = useState(() => {
    try { return localStorage.getItem('origin:tour-highlight') === '1'; } catch { return false; }
  });

  useEffect(() => {
    if (!tourHighlight) return;
    const t = setTimeout(() => {
      try { localStorage.removeItem('origin:tour-highlight'); } catch { /* private mode */ }
      setTourHighlight(false);
    }, 60_000);
    return () => clearTimeout(t);
  }, [tourHighlight]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const linkClasses = ({ isActive }: { isActive: boolean }) =>
    `group relative flex items-center gap-3 px-3 py-[7px] rounded-lg text-[13px] font-medium transition-colors ${
      isActive
        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
    }`;

  const iconClasses = (isActive: boolean) =>
    `w-[17px] h-[17px] transition-colors ${
      isActive ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-700 dark:group-hover:text-gray-200'
    }`;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[240px] flex-col bg-white dark:bg-[#0a0b14] border-r border-gray-200 dark:border-white/[0.05] transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 h-[56px] border-b border-gray-200 dark:border-white/[0.05]">
          <LogoMark size={26} variant="solo" />
          <div className="flex-1 min-w-0">
            <span className="text-[14px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">Origin</span>
            <span className="text-[10px] ml-1.5 uppercase tracking-wider text-emerald-600/80 dark:text-emerald-400/80 font-medium">Solo</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 lg:hidden"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav groups */}
        <nav data-tour="sidebar-nav" className="flex-1 overflow-y-auto px-2 py-4 space-y-6">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-400 dark:text-gray-600">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    data-tour={`nav-${item.to.replace('/', '') || 'dashboard'}`}
                    className={linkClasses}
                    onClick={() => setSidebarOpen(false)}
                    end={item.to === '/me'}
                  >
                    {({ isActive }) => (
                      <>
                        {/* Active indicator bar */}
                        {isActive && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-emerald-500 rounded-r-full" />
                        )}
                        <item.icon className={iconClasses(isActive)} />
                        <span>{item.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-gray-200 dark:border-white/[0.05] px-2 py-3">
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500/25 to-emerald-600/15 ring-1 ring-emerald-500/25 flex items-center justify-center text-emerald-600 dark:text-emerald-300 text-[12px] font-semibold">
              {user?.name?.charAt(0).toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-gray-800 dark:text-gray-100 truncate leading-tight">{user?.name}</p>
              <p className="text-[10px] text-gray-500 dark:text-gray-500 truncate leading-tight">{user?.email}</p>
            </div>
            <NotificationBell />
            <button
              onClick={toggleTheme}
              className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 rounded-md transition-colors"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
          <div className="flex items-center gap-1 mt-1">
            <button
              onClick={() => {
                // Clear the one-time highlight flag — even if they click
                // from a different page, they've acknowledged the tour.
                try { localStorage.removeItem('origin:tour-highlight'); } catch { /* private mode */ }
                setTourHighlight(false);
                // If we're not on the dashboard, the ProductTour component is
                // unmounted — navigate there first, then dispatch on the next
                // tick once the component mounts and attaches its listener.
                const onDashboard = window.location.pathname === '/me';
                if (!onDashboard) {
                  window.location.href = '/me?tour=1';
                  return;
                }
                window.dispatchEvent(new CustomEvent('origin:start-tour'));
              }}
              className={
                tourHighlight
                  ? 'relative flex-1 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-white px-2 py-1.5 rounded-md bg-gradient-to-r from-indigo-600 to-violet-600 shadow-[0_0_0_1px_rgba(139,92,246,0.5),0_0_18px_rgba(139,92,246,0.45)] hover:shadow-[0_0_0_1px_rgba(139,92,246,0.7),0_0_24px_rgba(139,92,246,0.6)] transition-all'
                  : 'flex-1 flex items-center justify-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] px-2 py-1.5 rounded-md transition-colors'
              }
            >
              <Sparkles className={`w-3.5 h-3.5 ${tourHighlight ? 'animate-pulse' : ''}`} />
              Tour
              {tourHighlight && (
                <span className="absolute -top-1 -right-1 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-fuchsia-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-fuchsia-500" />
                </span>
              )}
            </button>
            <button
              onClick={handleLogout}
              className="flex-1 flex items-center justify-center gap-1.5 text-[11px] text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] px-2 py-1.5 rounded-md transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center gap-3 px-4 h-[52px] border-b border-gray-200 dark:border-white/[0.05] bg-white/80 dark:bg-[#0a0b14]/80 backdrop-blur-xl">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 rounded-lg hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <LogoMark size={22} variant="solo" />
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Origin</span>
          <span className="text-[10px] uppercase tracking-wider text-emerald-600/80 dark:text-emerald-400/80 font-medium">Solo</span>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto w-full">
            {children}
          </div>
        </main>
      </div>

      {/* AI Assistant — disabled for now, re-enable when the feature is ready.
          To restore: uncomment the <ChatWidget> block and the import above. */}

      {/* Product tour */}
      <ProductTour steps={DASHBOARD_TOUR} tourId="dashboard-v1" />
    </div>
  );
}
