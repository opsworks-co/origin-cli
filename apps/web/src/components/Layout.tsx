import React, { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { request } from '../api';
import NotificationBell from './NotificationBell';
import { LogoMark } from './Logo';
import ChatWidget from './ChatWidget';
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
  Camera,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
} from 'lucide-react';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/repos', label: 'Repositories', icon: GitFork },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/policies', label: 'Policies', icon: Shield },
  { to: '/sessions', label: 'Sessions', icon: Play },
  { to: '/snapshots', label: 'Snapshots', icon: Camera },
  { to: '/pull-requests', label: 'PR Checks', icon: GitPullRequest },
  { to: '/infrastructure', label: 'Infrastructure', icon: Server },
  { to: '/iam', label: 'IAM', icon: Key },
  { to: '/budget', label: 'Budget', icon: DollarSign },
  { to: '/insights', label: 'Insights', icon: Lightbulb },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const ADMIN_NAV_ITEM = { to: '/admin', label: 'Admin', icon: ShieldAlert };

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    request<{ isSuperAdmin: boolean }>('/api/admin/check')
      .then((res) => setIsSuperAdmin(res.isSuperAdmin))
      .catch(() => setIsSuperAdmin(false));
  }, [user?.id]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const linkClasses = ({ isActive }: { isActive: boolean }) =>
    `group flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150 ${
      isActive
        ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 shadow-sm shadow-indigo-500/5'
        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
    }`;

  const iconClasses = (isActive: boolean) =>
    `w-[18px] h-[18px] transition-colors duration-150 ${
      isActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300'
    }`;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-100 dark:bg-gray-950">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col bg-white dark:bg-gray-900/80 backdrop-blur-xl border-r border-gray-200 dark:border-white/[0.06] shadow-sm dark:shadow-none transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 h-[60px] border-b border-gray-200 dark:border-white/[0.06]">
          <LogoMark size={32} />
          <div>
            <span className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">Origin</span>
            <p className="text-[10px] text-gray-500 leading-tight -mt-0.5">AI coding agents orchestrator</p>
          </div>
          {/* Mobile close */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="ml-auto p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 lg:hidden"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav links */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={linkClasses}
              onClick={() => setSidebarOpen(false)}
            >
              {({ isActive }) => (
                <>
                  <item.icon className={iconClasses(isActive)} />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
          {isSuperAdmin && (
            <>
              <div className="border-t border-gray-200 dark:border-white/[0.06] my-2" />
              <NavLink
                to={ADMIN_NAV_ITEM.to}
                className={linkClasses}
                onClick={() => setSidebarOpen(false)}
              >
                {({ isActive }) => (
                  <>
                    <ADMIN_NAV_ITEM.icon className={iconClasses(isActive)} />
                    {ADMIN_NAV_ITEM.label}
                  </>
                )}
              </NavLink>
            </>
          )}
        </nav>

        {/* User footer */}
        <div className="border-t border-gray-200 dark:border-white/[0.06] px-3 py-3">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500/20 to-indigo-600/20 ring-1 ring-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-sm font-medium">
              {user?.name?.charAt(0).toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{user?.name}</p>
              <p className="text-[11px] text-gray-500 truncate">{user?.orgName}</p>
            </div>
            <NotificationBell />
            <button
              onClick={toggleTheme}
              className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-black/[0.06] dark:hover:bg-white/[0.06] rounded-lg transition-colors"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 text-[13px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] px-3 py-2 rounded-lg transition-all duration-150 mt-1"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center gap-3 px-4 h-[52px] border-b border-gray-200 dark:border-white/[0.06] bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 rounded-lg hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <LogoMark size={24} />
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Origin</span>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">{children}</main>
      </div>

      {/* AI Assistant */}
      <ChatWidget
        endpoint="/api/chat/assistant"
        title="Origin Assistant"
        placeholder="Ask about your sessions, policies, costs..."
        requireAuth
        welcomeMessage="Hi! I'm your Origin AI assistant. I can help with policies, sessions, cost analysis, and more. What would you like to know?"
      />
    </div>
  );
}
