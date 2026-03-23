import React, { useEffect, useState } from 'react';
import { request } from '../api';
import { Shield, Building2, Users, Search, Loader2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminOrg {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  sessionCount: number;
  totalCost: number;
  createdAt: string;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  orgName: string;
  orgSlug: string;
  role: string;
  sessionCount: number;
  lastActive: string | null;
  createdAt: string;
}

type Tab = 'orgs' | 'users';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatRelative(iso: string | null) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

function formatCost(usd: number) {
  return `$${usd.toFixed(2)}`;
}

function roleBadge(role: string) {
  const colors: Record<string, string> = {
    OWNER: 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
    ADMIN: 'bg-indigo-500/10 text-indigo-400 ring-indigo-500/20',
    MEMBER: 'bg-gray-500/10 text-gray-400 ring-gray-500/20',
    VIEWER: 'bg-gray-500/10 text-gray-500 ring-gray-500/20',
  };
  return colors[role.toUpperCase()] ?? colors.MEMBER;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Admin() {
  const [tab, setTab] = useState<Tab>('orgs');
  const [search, setSearch] = useState('');
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const endpoint = tab === 'orgs' ? '/api/admin/orgs' : '/api/admin/users';
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    request<any>(`${endpoint}${params}`)
      .then((data) => {
        if (tab === 'orgs') setOrgs(data);
        else setUsers(data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tab, search]);

  const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: 'orgs', label: 'Organizations', icon: Building2 },
    { key: 'users', label: 'Users', icon: Users },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-red-500/10 ring-1 ring-red-500/20 flex items-center justify-center">
          <Shield className="w-5 h-5 text-red-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Super Admin</h1>
          <p className="text-sm text-gray-500">
            Platform-wide overview of all organizations and users
          </p>
        </div>
      </div>

      {/* Tabs + Search */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex gap-1 bg-gray-800/50 p-1 rounded-lg ring-1 ring-white/[0.06]">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setSearch(''); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                tab === t.key
                  ? 'bg-gray-700 text-gray-100 shadow-sm'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
              }`}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder={tab === 'orgs' ? 'Search organizations...' : 'Search users...'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-gray-800/50 border border-white/[0.06] rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40"
          />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
        </div>
      )}

      {/* Orgs Table */}
      {!loading && tab === 'orgs' && (
        <div className="rounded-xl bg-gray-900/60 ring-1 ring-white/[0.06] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="text-right py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Members
                  </th>
                  <th className="text-right py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Sessions
                  </th>
                  <th className="text-right py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Total Cost
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {orgs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-12 text-gray-500">
                      {search ? 'No organizations match your search' : 'No organizations found'}
                    </td>
                  </tr>
                ) : (
                  orgs.map((o) => (
                    <tr key={o.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3 px-4">
                        <div>
                          <p className="text-gray-200 font-medium">{o.name}</p>
                          <p className="text-xs text-gray-500">{o.slug}</p>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right text-gray-300 tabular-nums">
                        {o.memberCount}
                      </td>
                      <td className="py-3 px-4 text-right text-gray-300 tabular-nums">
                        {o.sessionCount.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-right text-gray-300 tabular-nums">
                        {formatCost(o.totalCost)}
                      </td>
                      <td className="py-3 px-4 text-gray-400">{formatDate(o.createdAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-white/[0.06] px-4 py-3 text-xs text-gray-500">
            {orgs.length} organization{orgs.length !== 1 ? 's' : ''} total
          </div>
        </div>
      )}

      {/* Users Table */}
      {!loading && tab === 'users' && (
        <div className="rounded-xl bg-gray-900/60 ring-1 ring-white/[0.06] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Organization
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="text-right py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Sessions
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Last Active
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-gray-500">
                      {search ? 'No users match your search' : 'No users found'}
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr key={u.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3 px-4 text-gray-200 font-medium">{u.name}</td>
                      <td className="py-3 px-4 text-gray-400">{u.email}</td>
                      <td className="py-3 px-4 text-gray-400">{u.orgName}</td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ring-1 ring-inset ${roleBadge(u.role)}`}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right text-gray-300 tabular-nums">
                        {u.sessionCount.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-gray-400">{formatRelative(u.lastActive)}</td>
                      <td className="py-3 px-4 text-gray-400">{formatDate(u.createdAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-white/[0.06] px-4 py-3 text-xs text-gray-500">
            {users.length} user{users.length !== 1 ? 's' : ''} total
          </div>
        </div>
      )}
    </div>
  );
}
