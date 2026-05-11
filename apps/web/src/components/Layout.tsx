import React, { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { request } from '../api';
import NotificationBell from './NotificationBell';
import OrgSwitcher from './OrgSwitcher';
import { LogoMark } from './Logo';
// import ChatWidget from './ChatWidget'; // disabled — see <ChatWidget> block below
import {
  LayoutDashboard,
  GitFork,
  Bot,
  Shield,
  ShieldAlert,
  Play,
  GitPullRequest,
  Server,
  Key,
  DollarSign,
  Settings,
  Lightbulb,
  Menu,
  X,
  Sun,
  Moon,
  Sparkles,
} from 'lucide-react';
import ProductTour, { TEAM_TOUR } from './ProductTour';
import BudgetPill from './BudgetPill';

// Team navigation — same grouped-sidebar pattern as solo, team accent (indigo).
// Workspace    = daily work (what happened today)
// Governance   = team oversight (policies, reviews, spend)
// Account      = setup & access control
//
// Budget moved up into Workspace alongside the other "what's going on right
// now?" views — admins kept missing the per-(agent|user|model) controls
// when they were buried in Governance, and the live spend pill (rendered
// inline next to the nav item) is most useful at-a-glance from anywhere.
const NAV_GROUPS = [
  {
    label: 'Workspace',
    items: [
      { to: '/dashboard',  label: 'Dashboard',    icon: LayoutDashboard },
      { to: '/sessions',   label: 'Sessions',     icon: Play },
      { to: '/repos',      label: 'Repositories', icon: GitFork },
      { to: '/budget',     label: 'Budgets',      icon: DollarSign, showBudgetPill: true },
      { to: '/insights',   label: 'Insights',     icon: Lightbulb },
    ],
  },
  {
    label: 'Governance',
    items: [
      { to: '/agents',         label: 'Agents',         icon: Bot },
      { to: '/policies',       label: 'Policies',       icon: Shield },
      { to: '/pull-requests',  label: 'PR Checks',      icon: GitPullRequest },
      { to: '/infrastructure', label: 'Infrastructure', icon: Server },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/iam',      label: 'IAM',      icon: Key },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const ADMIN_NAV_ITEM = { to: '/admin', label: 'Admin', icon: ShieldAlert };

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  // Tour highlight: if the user hasn't run (or dismissed) the tour, the
  // sidebar Tour button glows. Same persistence key as the tour completion
  // flag so it self-clears once they finish or close the tour. URL
  // ?tour=1 param triggers an immediate launch — used by deep-links and
  // the post-redirect step from the welcome page.
  const [tourHighlight, setTourHighlight] = useState(() => {
    try {
      const completed = localStorage.getItem('origin:tour:team-tour-v1') === '1';
      return !completed;
    } catch { return true; }
  });
  // Hide the Tour button entirely once the team tour is completed.
  // ProductTour writes 'done' to localStorage[`origin:tour-${tourId}`]
  // when the user finishes or skips. Sidebar stays clean after first run.
  const [tourComplete, setTourComplete] = useState(() => {
    try { return localStorage.getItem('origin:tour-team-tour-v1') === 'done'; } catch { return false; }
  });

  useEffect(() => {
    request<{ isSuperAdmin: boolean }>('/api/admin/check')
      .then((res) => setIsSuperAdmin(res.isSuperAdmin))
      .catch(() => setIsSuperAdmin(false));
  }, [user?.id]);


  const linkClasses = ({ isActive }: { isActive: boolean }) =>
    `group relative flex items-center gap-3 px-3 py-[7px] rounded-lg text-[13px] font-medium transition-colors ${
      isActive
        ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300'
        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
    }`;

  const iconClasses = (isActive: boolean) =>
    `w-[17px] h-[17px] transition-colors ${
      isActive ? 'text-indigo-600 dark:text-indigo-300' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-700 dark:group-hover:text-gray-200'
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
          <LogoMark size={26} />
          <div className="flex-1 min-w-0">
            <span className="text-[14px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">Origin</span>
            <span className="text-[10px] ml-1.5 uppercase tracking-wider text-indigo-600/80 dark:text-indigo-400/80 font-medium">Team</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 lg:hidden"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav groups */}
        <nav data-tour="sidebar-nav" className="flex-1 overflow-y-auto px-2 py-4 space-y-5">
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
                    data-tour={`team-nav-${item.to.replace('/', '').replace(/\W/g, '-') || 'home'}`}
                    className={linkClasses}
                    onClick={() => setSidebarOpen(false)}
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-indigo-500 rounded-r-full" />
                        )}
                        <item.icon className={iconClasses(isActive)} />
                        <span>{item.label}</span>
                        {(item as { showBudgetPill?: boolean }).showBudgetPill && (
                          <BudgetPill className="ml-auto" />
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
          {isSuperAdmin && (
            <div>
              <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-red-500/70 dark:text-red-400/70">
                Admin
              </p>
              <NavLink
                to={ADMIN_NAV_ITEM.to}
                className={linkClasses}
                onClick={() => setSidebarOpen(false)}
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-red-500 rounded-r-full" />
                    )}
                    <ADMIN_NAV_ITEM.icon className={iconClasses(isActive)} />
                    <span>{ADMIN_NAV_ITEM.label}</span>
                  </>
                )}
              </NavLink>
            </div>
          )}
        </nav>

        {/* Account footer — single GitHub-style switcher (org + signed-in
            user collapsed into one button), with bell and theme toggle as
            sibling icon controls. Sign out lives inside the dropdown. */}
        <div className="border-t border-gray-200 dark:border-white/[0.05] px-2 py-3 space-y-2">
          <div className="flex items-center gap-1">
            <div className="flex-1 min-w-0">
              <OrgSwitcher />
            </div>
            <NotificationBell />
            <button
              onClick={toggleTheme}
              className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] rounded-md transition-colors"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
          {!tourComplete && (
            <button
              onClick={() => {
                // Tour acknowledged regardless of how it ends — clear the
                // sidebar glow now even if they cancel the tour itself.
                setTourHighlight(false);
                if (window.location.pathname === '/dashboard') {
                  window.dispatchEvent(new CustomEvent('origin:start-tour'));
                } else {
                  window.location.href = '/dashboard?tour=1';
                }
              }}
              className={
                tourHighlight
                  ? 'relative w-full flex items-center justify-center gap-1.5 text-[11px] font-semibold text-white px-2 py-1.5 rounded-md bg-gradient-to-r from-indigo-600 to-violet-600 shadow-[0_0_0_1px_rgba(139,92,246,0.5),0_0_18px_rgba(139,92,246,0.45)] hover:shadow-[0_0_0_1px_rgba(139,92,246,0.7),0_0_24px_rgba(139,92,246,0.6)] transition-all'
                  : 'w-full flex items-center justify-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] px-2 py-1.5 rounded-md transition-colors'
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
          )}
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
          <LogoMark size={22} />
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Origin</span>
          <span className="text-[10px] uppercase tracking-wider text-indigo-600/80 dark:text-indigo-400/80 font-medium">Team</span>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto w-full">
            {children}
          </div>
        </main>
      </div>

      {/* AI Assistant — disabled for now, re-enable when the feature is ready.
          To restore: uncomment this <ChatWidget> block and the import above. */}

      {/* Product tour — TEAM_TOUR walks new admins through Dashboard →
          Repos → Agents → IAM → Policies → Budget → Insights. Auto-fires
          on first ?tour=1 visit; re-runnable from the sidebar Tour button. */}
      <ProductTour
        steps={TEAM_TOUR}
        tourId="team-tour-v1"
        onComplete={() => {
          setTourHighlight(false);
          // Hide the sidebar Tour button immediately on the same load —
          // ProductTour also persists the 'done' flag so the next page
          // load sees it via the localStorage check above.
          setTourComplete(true);
        }}
        // Team tour's last step routes to /dashboard already, so this
        // is mostly a belt-and-braces guard if the final step ever
        // changes — the redirect short-circuits when we're already
        // on the target path.
        completeRedirect="/dashboard"
      />
    </div>
  );
}
