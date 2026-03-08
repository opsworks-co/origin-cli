import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';

type PRFilter = 'all' | 'open' | 'passing' | 'failing' | 'pending';

function CheckBadge({ status }: { status: string }) {
  switch (status) {
    case 'success':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/30 text-green-400 border border-green-800/50">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          Passed
        </span>
      );
    case 'failure':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/30 text-red-400 border border-red-800/50">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          Failed
        </span>
      );
    case 'pending':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-900/30 text-yellow-400 border border-yellow-800/50">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
          Pending
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-400 border border-gray-700">
          —
        </span>
      );
  }
}

function StateBadge({ state }: { state: string }) {
  switch (state) {
    case 'open':
      return <span className="text-xs text-green-400">Open</span>;
    case 'merged':
      return <span className="text-xs text-purple-400">Merged</span>;
    case 'closed':
      return <span className="text-xs text-gray-500">Closed</span>;
    default:
      return <span className="text-xs text-gray-500">{state}</span>;
  }
}

export default function PullRequests() {
  const { user } = useAuth();
  const [prs, setPrs] = useState<api.PullRequestInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<PRFilter>('all');
  const [recheckingId, setRecheckingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const isAdmin = user?.role === 'ADMIN' || user?.role === 'OWNER';

  const fetchPRs = useCallback(async () => {
    try {
      const data = await api.getPullRequests();
      setPrs(data);
    } catch (err) {
      console.error('Failed to load PRs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPRs();
  }, [fetchPRs]);

  const handleRecheck = async (id: string) => {
    setRecheckingId(id);
    try {
      const result = await api.recheckPR(id);
      // Update the PR in the list
      setPrs((prev) =>
        prev.map((pr) =>
          pr.id === id ? { ...pr, checkStatus: result.checkStatus, checkDescription: result.checkDescription } : pr,
        ),
      );
    } catch (err) {
      console.error('Recheck failed:', err);
    } finally {
      setRecheckingId(null);
    }
  };

  const filtered = prs.filter((pr) => {
    switch (filter) {
      case 'open':
        return pr.state === 'open';
      case 'passing':
        return pr.checkStatus === 'success';
      case 'failing':
        return pr.checkStatus === 'failure';
      case 'pending':
        return pr.checkStatus === 'pending';
      default:
        return true;
    }
  });

  const counts = {
    all: prs.length,
    open: prs.filter((p) => p.state === 'open').length,
    passing: prs.filter((p) => p.checkStatus === 'success').length,
    failing: prs.filter((p) => p.checkStatus === 'failure').length,
    pending: prs.filter((p) => p.checkStatus === 'pending').length,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Pull Request Checks</h1>
        <p className="text-sm text-gray-400 mt-1">
          Origin policy enforcement status for GitHub pull requests
        </p>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 bg-gray-900 rounded-lg p-1 w-fit">
        {(['all', 'open', 'passing', 'failing', 'pending'] as PRFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === f
                ? 'bg-gray-700 text-gray-100'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            <span className="ml-1 text-gray-500">({counts[f]})</span>
          </button>
        ))}
      </div>

      {/* PR list */}
      {filtered.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-4xl mb-3">🔀</div>
          <h2 className="text-lg font-semibold text-gray-200">No pull requests</h2>
          <p className="text-sm text-gray-500 mt-1">
            {prs.length === 0
              ? 'Pull requests will appear here when GitHub webhooks are configured and PRs are opened.'
              : 'No pull requests match the current filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((pr) => (
            <div key={pr.id} className="card hover:border-gray-700 transition-colors">
              <div className="flex items-center gap-4">
                {/* Check status */}
                <div className="flex-shrink-0">
                  <CheckBadge status={pr.checkStatus} />
                </div>

                {/* PR info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-gray-100 hover:text-indigo-400 truncate"
                    >
                      {pr.title}
                    </a>
                    <span className="text-xs text-gray-500 flex-shrink-0">#{pr.number}</span>
                    <StateBadge state={pr.state} />
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                    <span>{pr.repoName}</span>
                    <span>·</span>
                    <span>{pr.author}</span>
                    <span>·</span>
                    <span>
                      {pr.headBranch} → {pr.baseBranch}
                    </span>
                    <span>·</span>
                    <span>{pr.commitCount} commits</span>
                  </div>
                </div>

                {/* Session summary */}
                <div className="flex items-center gap-3 flex-shrink-0">
                  {pr.sessionsCount > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      {pr.sessionsApproved > 0 && (
                        <span className="text-green-400" title="Approved">
                          ✅ {pr.sessionsApproved}
                        </span>
                      )}
                      {pr.sessionsFlagged > 0 && (
                        <span className="text-yellow-400" title="Flagged">
                          ⚠️ {pr.sessionsFlagged}
                        </span>
                      )}
                      {pr.sessionsRejected > 0 && (
                        <span className="text-red-400" title="Rejected">
                          ❌ {pr.sessionsRejected}
                        </span>
                      )}
                      {pr.sessionsPending > 0 && (
                        <span className="text-gray-400" title="Pending">
                          ⏳ {pr.sessionsPending}
                        </span>
                      )}
                    </div>
                  )}
                  <span className="text-xs text-gray-500">
                    {pr.sessionsCount} session{pr.sessionsCount !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => setExpandedId(expandedId === pr.id ? null : pr.id)}
                    className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800"
                  >
                    {expandedId === pr.id ? 'Collapse' : 'Details'}
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => handleRecheck(pr.id)}
                      disabled={recheckingId === pr.id}
                      className="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1 rounded hover:bg-indigo-900/20 disabled:opacity-50"
                      title="Re-run policy check and update GitHub"
                    >
                      {recheckingId === pr.id ? 'Checking...' : 'Re-check'}
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded details */}
              {expandedId === pr.id && (
                <div className="mt-4 pt-4 border-t border-gray-800 space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-gray-500">Status:</span>
                    <span className="text-gray-300">{pr.checkDescription}</span>
                  </div>

                  {pr.sessionsCount > 0 ? (
                    <div className="text-xs text-gray-500">
                      <div className="grid grid-cols-4 gap-3">
                        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                          <div className="text-lg font-bold text-gray-200">{pr.sessionsCount}</div>
                          <div>Total Sessions</div>
                        </div>
                        <div className="bg-green-900/20 rounded-lg p-3 text-center border border-green-800/30">
                          <div className="text-lg font-bold text-green-400">{pr.sessionsApproved}</div>
                          <div className="text-green-500">Approved</div>
                        </div>
                        <div className="bg-yellow-900/20 rounded-lg p-3 text-center border border-yellow-800/30">
                          <div className="text-lg font-bold text-yellow-400">{pr.sessionsFlagged + pr.sessionsRejected}</div>
                          <div className="text-yellow-500">Violations</div>
                        </div>
                        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                          <div className="text-lg font-bold text-gray-300">{pr.sessionsPending}</div>
                          <div>Pending Review</div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500">
                      No AI coding sessions are linked to the commits in this pull request.
                    </div>
                  )}

                  <div className="flex items-center gap-3 text-xs">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-400 hover:text-indigo-300"
                    >
                      View on GitHub →
                    </a>
                    <a
                      href={`/sessions?repoId=${pr.repoId}`}
                      className="text-indigo-400 hover:text-indigo-300"
                    >
                      View Sessions →
                    </a>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* How it works */}
      <div className="card bg-gray-900/50 border-gray-800">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">How PR Blocking Works</h3>
        <div className="text-xs text-gray-500 space-y-1">
          <p>1. Developer codes with an AI agent and pushes to GitHub</p>
          <p>2. Origin receives the webhook and links commits to AI sessions</p>
          <p>3. Policy engine evaluates the session (cost, files, model, review requirements)</p>
          <p>
            4. Origin posts a <code className="text-gray-400 bg-gray-800 px-1 rounded">origin/ai-governance</code> status check to the PR
          </p>
          <p>5. With GitHub branch protection enabled, the PR cannot be merged if the check fails</p>
          <p>6. Admin reviews/approves the session in Origin → check updates to ✅ → merge unblocked</p>
        </div>
      </div>
    </div>
  );
}
