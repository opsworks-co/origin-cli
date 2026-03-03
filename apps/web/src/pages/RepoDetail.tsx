import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import type { Repo } from '../api';
import WebhookSettings from '../components/WebhookSettings';

interface Commit {
  id: string;
  repoId: string;
  sha: string;
  message: string;
  author: string;
  committedAt: string;
  createdAt: string;
  session: {
    id: string;
    model: string;
    filesChanged: string;
    tokensUsed: number;
    toolCalls: number;
    durationMs: number;
    linesAdded: number;
    linesRemoved: number;
    costUsd: number;
    reviewed?: boolean;
    review?: { status: string } | null;
  } | null;
}

type Filter = 'all' | 'ai' | 'human' | 'unreviewed';

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusBadge(status: string | null | undefined) {
  if (!status) return <span className="badge-gray">pending</span>;
  const map: Record<string, string> = {
    APPROVED: 'badge-green',
    approved: 'badge-green',
    REJECTED: 'badge-red',
    rejected: 'badge-red',
    FLAGGED: 'badge-amber',
    flagged: 'badge-amber',
    pending: 'badge-gray',
  };
  return <span className={map[status] ?? 'badge-gray'}>{status.toLowerCase()}</span>;
}

export default function RepoDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [repo, setRepo] = useState<Repo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  // Sync states
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const fetchData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [repos, commitData] = await Promise.all([
        api.getRepos(),
        api.getRepoCommits(id),
      ]);
      const found = repos.find((r) => r.id === id) || null;
      setRepo(found);
      setCommits(commitData as Commit[]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSync = async () => {
    if (!id) return;
    setSyncing(true);
    setSyncMsg('');
    try {
      const result = await api.syncRepo(id);
      setSyncMsg(`Synced ${result.synced} new sessions (${result.total} total)`);
      fetchData();
    } catch (err: any) {
      setSyncMsg(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const filteredCommits = commits.filter((c) => {
    switch (filter) {
      case 'ai':
        return c.session !== null;
      case 'human':
        return c.session === null;
      case 'unreviewed':
        return c.session !== null && !c.session.review;
      default:
        return true;
    }
  });

  const aiCount = commits.filter((c) => c.session !== null).length;
  const humanCount = commits.filter((c) => c.session === null).length;
  const unreviewedCount = commits.filter(
    (c) => c.session !== null && !c.session.review
  ).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error || !repo) {
    return (
      <div className="card text-center py-12">
        <p className="text-red-400 mb-2">Failed to load repository</p>
        <p className="text-sm text-gray-500">{error}</p>
        <button onClick={() => navigate('/repos')} className="btn-secondary mt-4 text-sm">
          Back to Repos
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <button
              onClick={() => navigate('/repos')}
              className="text-gray-500 hover:text-gray-300 transition-colors text-sm"
            >
              &larr; Repos
            </button>
            <h1 className="text-2xl font-bold">{repo.name}</h1>
            <span
              className={`badge ${
                repo.provider === 'github' ? 'badge-purple' : 'badge-gray'
              } text-xs`}
            >
              {repo.provider}
            </span>
          </div>
          <p className="text-sm text-gray-500">{repo.path}</p>
          {repo.syncedAt && (
            <p className="text-xs text-gray-600 mt-1">
              Last synced {timeAgo(repo.syncedAt)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {syncMsg && (
            <span
              className={`text-xs ${
                syncMsg.startsWith('Sync failed') ? 'text-red-400' : 'text-green-400'
              }`}
            >
              {syncMsg}
            </span>
          )}
          <button onClick={handleSync} disabled={syncing} className="btn-primary text-sm">
            {syncing ? (
              <span className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
                Syncing...
              </span>
            ) : (
              'Sync Now'
            )}
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="card py-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Total Commits</p>
          <p className="text-2xl font-bold mt-1">{commits.length}</p>
        </div>
        <div className="card py-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider">AI Authored</p>
          <p className="text-2xl font-bold mt-1 text-indigo-400">{aiCount}</p>
        </div>
        <div className="card py-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Human</p>
          <p className="text-2xl font-bold mt-1">{humanCount}</p>
        </div>
        <div className="card py-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Unreviewed</p>
          <p className={`text-2xl font-bold mt-1 ${unreviewedCount > 0 ? 'text-amber-400' : 'text-green-400'}`}>
            {unreviewedCount}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {(
          [
            { key: 'all', label: 'All', count: commits.length },
            { key: 'ai', label: 'AI Authored', count: aiCount },
            { key: 'human', label: 'Human', count: humanCount },
            { key: 'unreviewed', label: 'Unreviewed', count: unreviewedCount },
          ] as { key: Filter; label: string; count: number }[]
        ).map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === key
                ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                : 'bg-gray-800 text-gray-400 border border-gray-700 hover:text-gray-200'
            }`}
          >
            {label}{' '}
            <span className="text-xs opacity-60">({count})</span>
          </button>
        ))}
      </div>

      {/* Webhooks Section */}
      {repo.provider === 'github' && (
        <div className="card">
          <WebhookSettings repoId={id!} />
        </div>
      )}

      {/* Commits List */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">SHA</th>
                <th className="px-6 py-3 font-medium">Message</th>
                <th className="px-6 py-3 font-medium">Author</th>
                <th className="px-6 py-3 font-medium text-right">Files</th>
                <th className="px-6 py-3 font-medium text-right">Tokens</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium text-right">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {filteredCommits.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                    No commits match this filter
                  </td>
                </tr>
              ) : (
                filteredCommits.map((commit) => {
                  let filesCount = 0;
                  try {
                    filesCount = commit.session
                      ? JSON.parse(commit.session.filesChanged).length
                      : 0;
                  } catch {
                    // ignore parse errors
                  }

                  return (
                    <tr
                      key={commit.id}
                      onClick={() => {
                        if (commit.session) {
                          navigate(`/sessions/${commit.session.id}`);
                        }
                      }}
                      className={`hover:bg-gray-800/30 transition-colors ${
                        commit.session ? 'cursor-pointer' : ''
                      }`}
                    >
                      <td className="px-6 py-3">
                        {commit.session ? (
                          <span className="badge-blue text-xs">{commit.session.model}</span>
                        ) : (
                          <span className="badge-gray text-xs">Human</span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <code className="text-xs text-indigo-400 bg-indigo-950/30 px-1.5 py-0.5 rounded">
                          {commit.sha.slice(0, 7)}
                        </code>
                      </td>
                      <td className="px-6 py-3 text-gray-300 max-w-[300px] truncate">
                        {commit.message}
                      </td>
                      <td className="px-6 py-3 text-gray-400">{commit.author}</td>
                      <td className="px-6 py-3 text-right text-gray-400">
                        {commit.session ? filesCount : '\u2014'}
                      </td>
                      <td className="px-6 py-3 text-right text-gray-400">
                        {commit.session
                          ? `${(commit.session.tokensUsed / 1000).toFixed(1)}k`
                          : '\u2014'}
                      </td>
                      <td className="px-6 py-3">
                        {commit.session
                          ? statusBadge(commit.session.review?.status ?? null)
                          : <span className="text-gray-600 text-xs">\u2014</span>}
                      </td>
                      <td className="px-6 py-3 text-right text-gray-500">
                        {timeAgo(commit.committedAt)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
