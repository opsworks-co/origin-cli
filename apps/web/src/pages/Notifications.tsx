import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';

export default function Notifications() {
  const [notifications, setNotifications] = useState<api.Notification[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.getNotifications({ unread: filter === 'unread', limit: 100 });
      setNotifications(res.notifications);
      setTotal(res.total);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, [filter]);

  const handleClick = async (n: api.Notification) => {
    if (!n.read) {
      await api.markNotificationRead(n.id).catch(() => {});
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
    }
    if (n.link) navigate(n.link);
  };

  const handleMarkAllRead = async () => {
    await api.markAllNotificationsRead().catch(() => {});
    setNotifications(prev => prev.map(x => ({ ...x, read: true })));
  };

  const typeIcons: Record<string, string> = {
    SESSION_FLAGGED: '\u26A0\uFE0F',
    POLICY_VIOLATION: '\uD83D\uDEE1',
    REVIEW_NEEDED: '\u25B6',
    REVIEW_COMPLETED: '\u2705',
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <div className="flex items-center gap-3">
          <select
            value={filter}
            onChange={e => setFilter(e.target.value as 'all' | 'unread')}
            className="input text-sm"
          >
            <option value="all">All</option>
            <option value="unread">Unread</option>
          </select>
          <button onClick={handleMarkAllRead} className="btn-secondary text-sm">
            Mark all read
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : notifications.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map(n => (
            <button
              key={n.id}
              onClick={() => handleClick(n)}
              className={`w-full text-left card hover:border-gray-700 transition-colors ${
                !n.read ? 'border-indigo-500/30 bg-indigo-600/5' : ''
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="text-lg mt-0.5">{typeIcons[n.type] || '\uD83D\uDD14'}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200">{n.title}</span>
                    {!n.read && <span className="w-2 h-2 rounded-full bg-indigo-400" />}
                  </div>
                  <p className="text-sm text-gray-400 mt-0.5">{n.message}</p>
                  <p className="text-xs text-gray-600 mt-1">{new Date(n.createdAt).toLocaleString()}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
