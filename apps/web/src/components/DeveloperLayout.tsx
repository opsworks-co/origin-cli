import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import NotificationBell from './NotificationBell';
import ChatWidget from './ChatWidget';
import { LogoMark } from './Logo';
import {
  LayoutDashboard,
  Play,
  FolderGit2,
  Settings,
  Lightbulb,
  Plug,
  KeyRound,
  User,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
} from 'lucide-react';

const DEV_NAV_ITEMS = [
  { to: '/me', label: 'My Dashboard', icon: LayoutDashboard },
  { to: '/repos', label: 'Repositories', icon: FolderGit2 },
  { to: '/sessions', label: 'My Sessions', icon: Play },
  { to: '/insights', label: 'Insights', icon: Lightbulb },
  { to: '/integrations', label: 'Integrations', icon: Plug },
  { to: '/api-keys', label: 'API Keys', icon: KeyRound },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function DeveloperLayout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const linkClasses = ({ isActive }: { isActive: boolean }) =>
    `group flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150 ${
      isActive
        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shadow-sm shadow-emerald-500/5'
        : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
    }`;

  const iconClasses = (isActive: boolean) =>
    `w-[18px] h-[18px] transition-colors duration-150 ${
      isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300'
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
          <LogoMark size={32} variant="solo" />
          <div>
            <span className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">Origin Solo</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="ml-auto p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 lg:hidden"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav links */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {DEV_NAV_ITEMS.map((item) => (
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

        </nav>

        {/* User footer */}
        <div className="border-t border-gray-200 dark:border-white/[0.06] px-3 py-3">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500/20 to-emerald-600/20 ring-1 ring-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400 text-sm font-medium">
              {user?.name?.charAt(0).toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{user?.name}</p>
              <p className="text-[11px] text-emerald-600/70 dark:text-emerald-500/70 truncate">Solo</p>
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
          <LogoMark size={24} variant="solo" />
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Origin</span>
          <span className="text-xs text-emerald-600/80 dark:text-emerald-500/80">Solo</span>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">{children}</main>
      </div>

      {/* AI Assistant */}
      <ChatWidget
        endpoint="/api/chat/assistant"
        title="Origin Assistant"
        placeholder="Ask about your sessions, stats, costs..."
        requireAuth
        welcomeMessage="Hi! I'm your Origin AI assistant. I can help with your sessions, stats, and more."
      />
    </div>
  );
}
