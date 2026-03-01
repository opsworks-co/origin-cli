import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { Repo } from '../api';

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never synced';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function Repos() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add form state
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formPath, setFormPath] = useState('');
  const [formProvider, setFormProvider] = useState('local');
  const [submitting, setSubmitting] = useState(false);

  // Sync states
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [syncResult, setSyncResult] = useState<Record<string, string>>({});

  // Delete state
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  const fetchRepos = useCallback(() => {
    setLoading(true);
    api
      .getRepos()
      .then(setRepos)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.createRepo({ name: formName, path: formPath, provider: formProvider });
      setFormName('');
      setFormPath('');
      setFormProvider('local');
      setShowForm(false);
      fetchRepos();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete ${name}? This will remove all commits and sessions.`)) return;
    setDeleting((prev) => ({ ...prev, [id]: true }));
    try {
      await api.deleteRepo(id);
      fetchRepos();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeleting((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handleSync = async (id: string) => {
    setSyncing((prev) => ({ ...prev, [id]: true }));
    setSyncResult((prev) => ({ ...prev, [id]: '' }));
    try {
      const result = await api.syncRepo(id);
      setSyncResult((prev) => ({
        ...prev,
        [id]: `Synced ${result.synced} new sessions (${result.total} total)`,
      }));
      fetchRepos();
    } catch (err: any) {
      setSyncResult((prev) => ({ ...prev, [id]: `Sync failed: ${err.message}` }));
    } finally {
      setSyncing((prev) => ({ ...prev, [id]: false }));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Repositories</h1>
          <p className="text-sm text-gray-500 mt-1">
            Connect and sync your code repositories
          </p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary text-sm">
          {showForm ? 'Cancel' : 'Add Repository'}
        </button>
      </div>

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      {/* Add Repo Form */}
      {showForm && (
        <form onSubmit={handleCreate} className="card space-y-4">
          <h3 className="font-semibold">Connect Repository</h3>
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name</label>
              <input
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="input"
                placeholder="my-project"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Path or URL</label>
              <input
                required
                value={formPath}
                onChange={(e) => setFormPath(e.target.value)}
                className="input"
                placeholder="/home/user/project or github.com/org/repo"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Provider</label>
              <select
                value={formProvider}
                onChange={(e) => setFormProvider(e.target.value)}
                className="select w-full"
              >
                <option value="local">Local</option>
                <option value="github">GitHub</option>
              </select>
            </div>
          </div>
          <button type="submit" disabled={submitting} className="btn-primary text-sm">
            {submitting ? 'Connecting...' : 'Connect Repository'}
          </button>
        </form>
      )}

      {/* Repos Grid */}
      {repos.length === 0 ? (
        <div className="card text-center py-16 text-gray-500">
          <div className="text-4xl mb-3">📦</div>
          <p className="text-lg mb-1">No repositories connected</p>
          <p className="text-sm">
            Connect your first repository to start tracking AI coding sessions.
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {repos.map((repo) => (
            <div
              key={repo.id}
              className="card hover:border-gray-700 transition-colors cursor-pointer group"
              onClick={() => navigate(`/repos/${repo.id}`)}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-gray-100 truncate group-hover:text-indigo-400 transition-colors">
                    {repo.name}
                  </h3>
                  <p className="text-xs text-gray-500 truncate mt-0.5">{repo.path}</p>
                </div>
                <span
                  className={`badge ${
                    repo.provider === 'github' ? 'badge-purple' : 'badge-gray'
                  } text-xs ml-2 flex-shrink-0`}
                >
                  {repo.provider}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm mb-4">
                <div>
                  <p className="text-gray-500">Commits</p>
                  <p className="text-gray-200 font-medium">{repo._count?.commits ?? 0}</p>
                </div>
                <div>
                  <p className="text-gray-500">Last Synced</p>
                  <p className="text-gray-200 font-medium">{timeAgo(repo.syncedAt)}</p>
                </div>
              </div>

              {/* Sync button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleSync(repo.id);
                }}
                disabled={syncing[repo.id]}
                className="btn-secondary text-xs py-1.5 w-full"
              >
                {syncing[repo.id] ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-indigo-400" />
                    Syncing...
                  </span>
                ) : (
                  'Sync Now'
                )}
              </button>

              {/* Delete button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(repo.id, repo.name);
                }}
                disabled={deleting[repo.id]}
                className="btn-danger text-xs py-1.5 w-full mt-2"
              >
                {deleting[repo.id] ? 'Deleting...' : 'Delete'}
              </button>

              {/* Sync result */}
              {syncResult[repo.id] && (
                <p
                  className={`text-xs mt-2 ${
                    syncResult[repo.id].startsWith('Sync failed')
                      ? 'text-red-400'
                      : 'text-green-400'
                  }`}
                >
                  {syncResult[repo.id]}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
