import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { Session } from '../api';
import UnifiedSessionView from '../components/UnifiedSessionView';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    approved: 'badge-green',
    rejected: 'badge-red',
    flagged: 'badge-amber',
    pending: 'badge-gray',
    completed: 'badge-blue',
    running: 'badge-purple',
  };
  return <span className={`${map[status] ?? 'badge-gray'} text-sm`}>{status}</span>;
}

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Tab state
  const [activeTab, setActiveTab] = useState<'session' | 'security'>('session');

  // Review state
  const [reviewNote, setReviewNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reviewFeedback, setReviewFeedback] = useState('');

  // Security findings
  const [findings, setFindings] = useState<api.SecretFinding[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(false);

  // Metadata panel
  const [showMeta, setShowMeta] = useState(false);

  useEffect(() => {
    if (!id) return;
    api
      .getSession(id)
      .then(setSession)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    // Load security findings
    setFindingsLoading(true);
    api
      .getSessionFindings(id)
      .then(setFindings)
      .catch(() => {}) // Silently fail — new feature
      .finally(() => setFindingsLoading(false));
  }, [id]);

  const handleReview = async (status: string) => {
    if (!id) return;
    setSubmitting(true);
    setReviewFeedback('');
    try {
      const review = await api.reviewSession(id, status, reviewNote || undefined);
      setSession((prev) => (prev ? { ...prev, review } : prev));
      setReviewNote('');
      // Show feedback
      const statusLabel = status.charAt(0) + status.slice(1).toLowerCase();
      if (review.githubUpdated && review.prsUpdated > 0) {
        setReviewFeedback(`Session ${statusLabel.toLowerCase()}. Updated ${review.prsUpdated} PR${review.prsUpdated !== 1 ? 's' : ''} on GitHub.`);
      } else {
        setReviewFeedback(`Session ${statusLabel.toLowerCase()}.`);
      }
      // Auto-dismiss after 5s
      setTimeout(() => setReviewFeedback(''), 5000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="card text-center py-12">
        <p className="text-red-400 mb-2">Failed to load session</p>
        <p className="text-sm text-gray-500">{error}</p>
        <button onClick={() => navigate('/sessions')} className="btn-secondary mt-4 text-sm">
          Back to Sessions
        </button>
      </div>
    );
  }

  const filesCount = (() => { try { return JSON.parse(session.filesChanged).length; } catch { return 0; } })();

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* ── Header row ── */}
      <div className="flex items-center gap-3 flex-wrap flex-shrink-0">
        <button
          onClick={() => navigate('/sessions')}
          className="text-gray-500 hover:text-gray-300 transition-colors text-sm"
        >
          &larr; Sessions
        </button>
        <h1 className="text-xl font-bold">{session.repoName ?? 'Session'}</h1>
        {statusBadge(session.review?.status?.toLowerCase() ?? 'pending')}
        <span className="text-xs text-gray-600 font-mono">{session.commitSha?.slice(0, 8)}</span>

        {/* Quick stats */}
        <div className="ml-auto flex items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="text-gray-400">{session.agentName ?? 'Agent'}</span>
            <span className="badge-blue text-[10px] py-0">{session.model}</span>
          </span>
          {session.userName && (
            <span>by {session.userName}</span>
          )}
          <span>{formatDuration(session.durationMs)}</span>
          <span>{session.tokensUsed.toLocaleString()} tokens</span>
          <span>${session.costUsd.toFixed(2)}</span>
          <span>{session.toolCalls} tools</span>
          <span>{filesCount} files</span>
          <span className="text-green-400">+{session.linesAdded}</span>
          <span className="text-red-400">-{session.linesRemoved}</span>

          {/* Toggle details */}
          <button
            onClick={() => setShowMeta((prev) => !prev)}
            className="text-gray-600 hover:text-gray-400 transition-colors ml-1"
            title="Show details"
          >
            {showMeta ? 'Hide details' : 'Details'}
          </button>
        </div>
      </div>

      {/* ── Collapsible metadata panel ── */}
      {showMeta && (
        <div className="flex flex-wrap gap-4 flex-shrink-0">
          {/* PR info */}
          {session.pullRequests && session.pullRequests.length > 0 && (
            <div className="card space-y-2 flex-1 min-w-[250px]">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Pull Requests</h3>
              {session.pullRequests.map((pr) => (
                <div key={pr.id} className="text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
                    >
                      #{pr.number}
                    </a>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        pr.state === 'merged'
                          ? 'bg-purple-500/20 text-purple-400'
                          : pr.state === 'open'
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-gray-700 text-gray-400'
                      }`}
                    >
                      {pr.state}
                    </span>
                    {pr.checkStatus && (
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          pr.checkStatus === 'success'
                            ? 'bg-green-500/20 text-green-400'
                            : pr.checkStatus === 'failure'
                              ? 'bg-red-500/20 text-red-400'
                              : 'bg-amber-500/20 text-amber-400'
                        }`}
                      >
                        {pr.checkStatus}
                      </span>
                    )}
                  </div>
                  <p className="text-gray-300 text-xs">{pr.title}</p>
                  <p className="text-gray-600 text-xs">
                    {pr.headBranch} &rarr; {pr.baseBranch} &middot; by {pr.author}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Review */}
          {session.review && (() => {
            const isAI = session.review.note?.includes('**AI Auto-Review**') ?? false;
            return (
              <div className={`card space-y-2 flex-1 min-w-[250px] ${isAI ? 'border border-purple-500/30' : ''}`}>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                  Review
                  {isAI && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400 font-normal normal-case tracking-normal">
                      AI
                    </span>
                  )}
                </h3>
                <div className="text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    {statusBadge(session.review.status)}
                    <span className="text-gray-500 text-xs">
                      by {isAI ? 'Origin AI' : (session.review.reviewerName ?? 'unknown')}
                    </span>
                  </div>
                  {session.review.note && (
                    <div className="text-gray-400 text-xs bg-gray-800/50 rounded p-2 max-h-24 overflow-y-auto">
                      {session.review.note.split('\n').filter(l => l.trim()).slice(0, 5).map((line, i) => (
                        <p key={i}>{line.replace(/\*\*/g, '')}</p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* System prompt */}
          {session.agentSystemPrompt && (
            <div className="card space-y-2 flex-1 min-w-[250px]">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">System Prompt</h3>
              <pre className="text-xs text-gray-400 bg-gray-900 rounded p-2 overflow-auto whitespace-pre-wrap max-h-24">
                {session.agentSystemPrompt}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* ── Main content — full width ── */}
      <div className="card p-0 overflow-hidden flex-1 min-h-0 flex flex-col">
        {/* Tab bar */}
        <div className="px-5 py-2.5 border-b border-gray-800 flex-shrink-0 flex items-center gap-1">
          <button
            onClick={() => setActiveTab('session')}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              activeTab === 'session'
                ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
            }`}
          >
            Session
            {(session.promptChanges?.length ?? 0) > 0 && (
              <span className="ml-1.5 text-xs bg-indigo-600/30 text-indigo-400 px-1.5 py-0.5 rounded-full">
                {session.promptChanges!.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              activeTab === 'security'
                ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
            }`}
          >
            Security
            {findings.length > 0 && (
              <span className="ml-1.5 text-xs bg-red-600/30 text-red-400 px-1.5 py-0.5 rounded-full">
                {findings.length}
              </span>
            )}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'session' && (
            <UnifiedSessionView
              transcript={(() => { try { return JSON.parse(session.transcript); } catch { return []; } })()}
              promptChanges={session.promptChanges || []}
              sessionDiff={session.sessionDiff}
            />
          )}
          {activeTab === 'security' && (
            <div className="p-5 space-y-4">
              {findingsLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500" />
                </div>
              ) : findings.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-3xl mb-2">&#9989;</div>
                  <p className="text-green-400 font-medium">No secrets detected</p>
                  <p className="text-sm text-gray-500 mt-1">
                    No API keys, credentials, or PII found in this session's code changes.
                  </p>
                </div>
              ) : (
                <>
                  <div className="bg-red-900/20 border border-red-800/30 rounded-lg p-3 flex items-center gap-2">
                    <span className="text-red-400 text-lg">&#9888;</span>
                    <p className="text-sm text-red-300">
                      {findings.length} secret{findings.length !== 1 ? 's' : ''}/PII finding{findings.length !== 1 ? 's' : ''} detected in this session.
                    </p>
                  </div>
                  <div className="space-y-2">
                    {findings.map((f) => (
                      <div
                        key={f.id}
                        className="bg-gray-800/50 rounded-lg p-3 flex items-start gap-3"
                      >
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 mt-0.5 ${
                            f.severity === 'critical'
                              ? 'bg-red-600/20 text-red-400'
                              : f.severity === 'high'
                                ? 'bg-orange-600/20 text-orange-400'
                                : f.severity === 'medium'
                                  ? 'bg-amber-600/20 text-amber-400'
                                  : 'bg-gray-600/20 text-gray-400'
                          }`}
                        >
                          {f.severity}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-200">
                              {f.ruleName}
                            </span>
                            <span className="text-xs bg-indigo-900/30 text-indigo-400 px-1.5 py-0.5 rounded">
                              {f.type}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mt-1">
                            {f.filePath}
                            {f.lineNumber > 0 && `:${f.lineNumber}`}
                          </p>
                          <code className="text-xs text-gray-400 bg-gray-900 px-2 py-1 rounded mt-1 block font-mono">
                            {f.match}
                          </code>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Review feedback banner */}
      {reviewFeedback && (
        <div className="bg-green-900/20 border border-green-800/30 rounded-lg px-4 py-3 flex items-center justify-between flex-shrink-0">
          <p className="text-sm text-green-400">{reviewFeedback}</p>
          <button
            onClick={() => setReviewFeedback('')}
            className="text-green-600 hover:text-green-400 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Review bar */}
      {(!session.review || session.review.note?.includes('**AI Auto-Review**')) && (
        <div className="card flex-shrink-0">
          <div className="flex flex-col sm:flex-row gap-3 items-center">
            <span className="text-sm text-gray-400 whitespace-nowrap">
              {session.review?.note?.includes('**AI Auto-Review**') ? 'Override AI Review' : 'Review'}
            </span>
            <input
              type="text"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder="Optional note..."
              className="input flex-1"
            />
            <div className="flex gap-2">
              <button
                onClick={() => handleReview('approved')}
                disabled={submitting}
                className="bg-green-600 hover:bg-green-500 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() => handleReview('rejected')}
                disabled={submitting}
                className="btn-danger"
              >
                Reject
              </button>
              <button
                onClick={() => handleReview('flagged')}
                disabled={submitting}
                className="bg-amber-600 hover:bg-amber-500 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
              >
                Flag
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
