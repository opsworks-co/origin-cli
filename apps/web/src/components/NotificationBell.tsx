import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';

export default function NotificationBell() {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<api.Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Poll unread count every 30s
  useEffect(() => {
    const fetchCount = () => {
      api.getUnreadCount().then(r => setCount(r.count)).catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30000);
    return () => clearInterval(interval);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleOpen = async () => {
    setOpen(!open);
    if (!open) {
      setLoading(true);
      try {
        const res = await api.getNotifications({ limit: 10 });
        setNotifications(res.notifications);
      } catch { /* ignore */ }
      setLoading(false);
    }
  };

  const handleClick = async (n: api.Notification) => {
    if (!n.read) {
      await api.markNotificationRead(n.id).catch(() => {});
      setCount(c => Math.max(0, c - 1));
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
    }
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const handleMarkAllRead = async () => {
    await api.markAllNotificationsRead().catch(() => {});
    setCount(0);
    setNotifications(prev => prev.map(x => ({ ...x, read: true })));
  };

  const timeAgo = (date: string) => {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleOpen}
        className="relative p-2 text-gray-400 hover:text-gray-100 transition-colors rounded-lg hover:bg-gray-800/50"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4.5 h-4.5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center min-w-[18px] px-1">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <span className="text-sm font-semibold text-gray-100">Notifications</span>
            {count > 0 && (
              <button onClick={handleMarkAllRead} className="text-xs text-indigo-400 hover:text-indigo-300">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {loading ? (
              <p className="text-center text-gray-500 text-sm py-6">Loading...</p>
            ) : notifications.length === 0 ? (
              <p className="text-center text-gray-500 text-sm py-6">No notifications</p>
            ) : (
              notifications.map(n => (
                <button
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-800/50 hover:bg-gray-800/50 transition-colors ${
                    !n.read ? 'bg-indigo-600/5' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!n.read && <span className="w-2 h-2 rounded-full bg-indigo-400 mt-1.5 flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-200 truncate">{n.title}</p>
                      <p className="text-xs text-gray-400 truncate">{n.message}</p>
                      <p className="text-xs text-gray-600 mt-1">{timeAgo(n.createdAt)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
          <button
            onClick={() => { setOpen(false); navigate('/notifications'); }}
            className="w-full text-center text-xs text-indigo-400 hover:text-indigo-300 py-2.5 border-t border-gray-800"
          >
            View all notifications
          </button>
        </div>
      )}
    </div>
  );
}
