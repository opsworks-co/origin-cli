import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';
import type { TeamMember } from '../api';

function roleBadge(role: string) {
  const map: Record<string, string> = {
    OWNER: 'badge-purple',
    ADMIN: 'badge-amber',
    MEMBER: 'badge-blue',
    VIEWER: 'badge-gray',
  };
  return <span className={map[role] ?? 'badge-gray'}>{role}</span>;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export default function Team() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getUsers()
      .then((data) => setMembers(data.users))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Team</h1>
        <p className="text-sm text-gray-500 mt-1">Members of your organization</p>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Member</th>
                <th className="px-6 py-3 font-medium">Role</th>
                <th className="px-6 py-3 font-medium text-right">Sessions</th>
                <th className="px-6 py-3 font-medium text-right">Reviews</th>
                <th className="px-6 py-3 font-medium text-right">Cost</th>
                <th className="px-6 py-3 font-medium text-right">Lines</th>
                <th className="px-6 py-3 font-medium text-right">Last Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500 mx-auto" />
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                    No team members found
                  </td>
                </tr>
              ) : (
                members.map((m) => (
                  <tr key={m.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-6 py-3">
                      <Link to={`/team/${m.id}`} className="flex items-center gap-3 group">
                        <div className="w-8 h-8 rounded-full bg-indigo-600/30 flex items-center justify-center text-indigo-400 text-sm font-medium flex-shrink-0">
                          {m.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-100 group-hover:text-indigo-400 transition-colors truncate">
                            {m.name}
                          </p>
                          <p className="text-xs text-gray-500 truncate">{m.email}</p>
                        </div>
                      </Link>
                    </td>
                    <td className="px-6 py-3">{roleBadge(m.role)}</td>
                    <td className="px-6 py-3 text-right text-gray-400">{m.sessions}</td>
                    <td className="px-6 py-3 text-right text-gray-400">{m.reviews}</td>
                    <td className="px-6 py-3 text-right text-gray-300">${m.totalCost.toFixed(2)}</td>
                    <td className="px-6 py-3 text-right text-gray-400">
                      {m.linesAdded > 0 ? `+${m.linesAdded.toLocaleString()}` : '0'}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-500">{timeAgo(m.lastActive)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
