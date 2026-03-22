import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';
import ChatWidget from './ChatWidget';
import {
  LayoutDashboard,
  GitFork,
  Bot,
  Shield,
  Play,
  GitPullRequest,
  Server,
  Key,
  Settings,
  LogOut,
  Menu,
  X,
} from 'lucide-react';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/repos', label: 'Repositories', icon: GitFork },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/policies', label: 'Policies', icon: Shield },
  { to: '/sessions', label: 'Sessions', icon: Play },
  { to: '/pull-requests', label: 'PR Checks', icon: GitPullRequest },
  { to: '/infrastructure', label: 'Infrastructure', icon: Server },
  { to: '/api-keys', label: 'API Keys', icon: Key },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const linkClasses = ({ isActive }: { isActive: boolean }) =>
    `group flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150 ${
      isActive
        ? 'bg-indigo-500/15 text-indigo-400 shadow-sm shadow-indigo-500/5'
        : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]'
    }`;

  const iconClasses = (isActive: boolean) =>
    `w-[18px] h-[18px] transition-colors duration-150 ${
      isActive ? 'text-indigo-400' : 'text-gray-500 group-hover:text-gray-300'
    }`;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col bg-gray-900/80 backdrop-blur-xl border-r border-white/[0.06] transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 h-[60px] border-b border-white/[0.06]">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm shadow-lg shadow-indigo-500/25">
            O
          </div>
          <div>
            <span className="text-[15px] font-semibold text-gray-100 tracking-tight">Origin</span>
            <p className="text-[10px] text-gray-500 leading-tight -mt-0.5">AI coding agents orchestrator</p>
          </div>
          {/* Mobile close */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="ml-auto p-1 text-gray-500 hover:text-gray-300 lg:hidden"
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
        </nav>

        {/* User footer */}
        <div className="border-t border-white/[0.06] px-3 py-3">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500/20 to-indigo-600/20 ring-1 ring-indigo-500/20 flex items-center justify-center text-indigo-400 text-sm font-medium">
              {user?.name?.charAt(0).toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-200 truncate">{user?.name}</p>
              <p className="text-[11px] text-gray-500 truncate">{user?.orgName}</p>
            </div>
            <NotificationBell />
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 text-[13px] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] px-3 py-2 rounded-lg transition-all duration-150 mt-1"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center gap-3 px-4 h-[52px] border-b border-white/[0.06] bg-gray-900/80 backdrop-blur-xl">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 text-gray-400 hover:text-gray-100 rounded-lg hover:bg-white/[0.06] transition-colors"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center text-white font-bold text-[10px]">
            O
          </div>
          <span className="text-sm font-semibold text-gray-200">Origin</span>
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
