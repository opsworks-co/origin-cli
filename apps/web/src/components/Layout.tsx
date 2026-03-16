import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';
import ChatWidget from './ChatWidget';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: '\u25A3' },
  { to: '/repos', label: 'Repositories', icon: '\uD83D\uDCC1' },
  { to: '/agents', label: 'Agents', icon: '\uD83E\uDD16' },
  { to: '/policies', label: 'Policies', icon: '\uD83D\uDEE1' },
  { to: '/sessions', label: 'Sessions', icon: '\u25B6' },
  { to: '/pull-requests', label: 'PR Checks', icon: '\uD83D\uDD00' },
  { to: '/infrastructure', label: 'Infrastructure', icon: '\uD83D\uDDA5' },
  { to: '/api-keys', label: 'API Keys', icon: '\uD83D\uDD11' },
  { to: '/settings', label: 'Settings', icon: '\u2699' },
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
    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? 'bg-indigo-600/20 text-indigo-400'
        : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800/50'
    }`;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-gray-900 border-r border-gray-800 transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-5 py-5 border-b border-gray-800">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm">
            O
          </div>
          <span className="text-lg font-semibold text-gray-100">Origin</span>
          <span className="text-[10px] text-gray-600 ml-1 leading-tight">AI coding agents<br/>orchestrator</span>
        </div>

        {/* Nav links */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={linkClasses}
              onClick={() => setSidebarOpen(false)}
            >
              <span className="text-base w-5 text-center">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-gray-800 px-4 py-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-400 text-sm font-medium">
              {user?.name?.charAt(0).toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-100 truncate">{user?.name}</p>
              <p className="text-xs text-gray-500 truncate">{user?.orgName}</p>
            </div>
            <NotificationBell />
          </div>
          <button
            onClick={handleLogout}
            className="w-full text-sm text-gray-400 hover:text-gray-100 hover:bg-gray-800 px-3 py-2 rounded-lg transition-colors text-left"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 text-gray-400 hover:text-gray-100"
            aria-label="Open menu"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-lg font-semibold">Origin</span>
          <span className="text-[10px] text-gray-500">AI coding agents orchestrator</span>
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
