import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { Session } from '../api';
import UnifiedSessionView from '../components/UnifiedSessionView';
import AiBlameView from '../components/AiBlameView';
import AskAuthorPanel from '../components/AskAuthorPanel';
import { formatCost, formatDuration, getStatusBadgeClass } from '../utils';

function statusBadge(status: string) {
  return <span className={`${getStatusBadgeClass(status)} text-sm`}>{status}</span>;
}

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Tab state
  const [activeTab, setActiveTab] = useState<'session' | 'security' | 'blame'>('session');

  // Review state
  const [reviewNote, setReviewNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reviewFeedback, setReviewFeedback] = useState('');

  // Security findings
  const [findings, setFindings] = useState<api.SecretFinding[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(false);

  // Metadata panel
  const [showMeta, setShowMeta] = useState(false);

  // Ask the Author panel
  const [showAskPanel, setShowAskPanel] = useState(false);
  const [askContext, setAskContext] = useState<{ file?: string; lineNumber?: number; lineContent?: string; promptIndex?: number } | undefined>();

  // Delete
  const [deleting, setDeleting] = useState(false);

  // Real-time watch
  const [elapsed, setElapsed] = useState(0);

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

  // Elapsed timer for running sessions
  useEffect(() => {
    if (!session || session.status !== 'RUNNING') return;
    const update = () => {
      if (session.startedAt) {
        setElapsed(Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000));
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [session?.status, session?.startedAt]);

  // Poll for updates when session is running
  useEffect(() => {
    if (!id || !session || session.status !== 'RUNNING') return;
    const poll = setInterval(() => {
      api.getSession(id).then((updated) => {
        setSession(updated);
        if (updated.status !== 'RUNNING') clearInterval(poll);
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(poll);
  }, [id, session?.status]);

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

  const handleDelete = async () => {
    if (!id || !confirm('Delete this session? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await api.deleteSession(id);
      navigate('/sessions');
    } catch (err: any) {
      setError(err.message);
      setDeleting(false);
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
        {statusBadge(session.review?.status?.toLowerCase() ?? (session.status === 'RUNNING' ? 'running' : 'ended'))}
        <span className="text-xs text-gray-600 font-mono">{session.commitSha?.slice(0, 8)}</span>
        {session.branch && (
          <span className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full font-mono inline-flex items-center gap-1">
            <svg className="w-3 h-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
            {session.branch}
          </span>
        )}

        {/* Quick stats */}
        <div className="ml-auto flex items-center gap-4 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="text-gray-400">{session.agentName ?? 'Agent'}</span>
            {session.agentVersion && (
              <span className="text-[10px] text-gray-600">v{session.agentVersion}</span>
            )}
            <span className="badge-blue text-[10px] py-0">{session.model}</span>
          </span>
          {session.userName && (
            <span>by {session.userName}</span>
          )}
          <span>{formatDuration(session.durationMs)}</span>
          <span>{session.tokensUsed.toLocaleString()} tokens</span>
          <span>{formatCost(session.costUsd)}</span>
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
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-red-500/60 hover:text-red-400 transition-colors ml-1 disabled:opacity-50"
            title="Delete session"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>

      {/* ── Review Reason Banner (always visible for flagged/rejected) ── */}
      {session.review && ['flagged', 'rejected'].includes(session.review.status?.toLowerCase()) && (
        <div className={`rounded-lg px-4 py-3 flex-shrink-0 border ${
          session.review.status?.toLowerCase() === 'rejected'
            ? 'bg-red-900/20 border-red-800/40'
            : 'bg-amber-900/20 border-amber-800/40'
        }`}>
          <div className="flex items-start gap-3">
            <span className={`text-lg flex-shrink-0 mt-0.5 ${
              session.review.status?.toLowerCase() === 'rejected' ? 'text-red-400' : 'text-amber-400'
            }`}>
              {session.review.status?.toLowerCase() === 'rejected' ? '\u2718' : '\u26A0'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-sm font-medium ${
                  session.review.status?.toLowerCase() === 'rejected' ? 'text-red-300' : 'text-amber-300'
                }`}>
                  Session {session.review.status?.toLowerCase() === 'rejected' ? 'Rejected' : 'Flagged'}
                </span>
                <span className="text-xs text-gray-500">
                  by {session.review.note?.includes('**AI Auto-Review**') ? 'Origin AI' : (session.review.reviewerName ?? 'unknown')}
                  {session.review.createdAt && ` \u00B7 ${new Date(session.review.createdAt).toLocaleString()}`}
                </span>
              </div>
              {session.review.note ? (
                <div className="text-sm text-gray-300 space-y-1">
                  {session.review.note.split('\n').filter((l: string) => l.trim() && !l.includes('**AI Auto-Review**')).slice(0, 8).map((line: string, i: number) => (
                    <p key={i} className="leading-relaxed">{line.replace(/\*\*/g, '')}</p>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 italic">No reason provided</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Live Session Watch ── */}
      {session.status === 'RUNNING' && (
        <div className="card border-purple-500/30 bg-purple-500/5 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-purple-500" />
              </span>
              <span className="text-sm font-medium text-purple-300">Session Running</span>
              <span className="text-lg font-mono text-purple-200">
                {elapsed >= 3600
                  ? `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m ${elapsed % 60}s`
                  : elapsed >= 60
                    ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                    : `${elapsed}s`}
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-400">
              {session.toolCalls > 0 && (
                <span className="flex items-center gap-1">
                  <span className="text-purple-400 font-medium">{session.toolCalls}</span> tool calls
                </span>
              )}
              {session.tokensUsed > 0 && (
                <span className="flex items-center gap-1">
                  <span className="text-purple-400 font-medium">{session.tokensUsed.toLocaleString()}</span> tokens
                </span>
              )}
              {session.costUsd > 0 && (
                <span className="flex items-center gap-1">
                  <span className="text-purple-400 font-medium">{formatCost(session.costUsd)}</span>
                </span>
              )}
              {(() => {
                try {
                  const files = JSON.parse(session.filesChanged);
                  return files.length > 0 ? (
                    <span className="flex items-center gap-1">
                      <span className="text-purple-400 font-medium">{files.length}</span> files modified
                    </span>
                  ) : null;
                } catch { return null; }
              })()}
            </div>
          </div>
        </div>
      )}

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
            onClick={() => setActiveTab('blame')}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              activeTab === 'blame'
                ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
            }`}
          >
            AI Blame
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

          {/* Ask the Author button */}
          <button
            onClick={() => { setShowAskPanel(!showAskPanel); setAskContext(undefined); }}
            className={`ml-auto px-3 py-1.5 text-sm rounded-lg transition-colors flex items-center gap-1.5 ${
              showAskPanel
                ? 'bg-purple-600/20 text-purple-400 font-medium'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
            }`}
          >
            <span className="text-xs">&#128172;</span>
            Ask
          </button>
        </div>
        <div className="flex-1 overflow-y-auto flex">
          <div className={`flex-1 overflow-y-auto ${showAskPanel ? 'min-w-0' : ''}`}>
          {activeTab === 'session' && (
            <UnifiedSessionView
              transcript={(() => { try { return JSON.parse(session.transcript); } catch { return []; } })()}
              promptChanges={session.promptChanges || []}
              sessionDiff={session.sessionDiff}
            />
          )}
          {activeTab === 'blame' && (
            <AiBlameView
              sessionId={session.id}
              filesChanged={(() => { try { return JSON.parse(session.filesChanged); } catch { return []; } })()}
              onAskAboutLine={(file, lineNumber, content) => {
                setAskContext({ file, lineNumber, lineContent: content });
                setShowAskPanel(true);
              }}
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

          {/* Ask the Author side panel */}
          {showAskPanel && (
            <div className="w-96 border-l border-gray-800 flex-shrink-0">
              <AskAuthorPanel
                sessionId={session.id}
                onClose={() => setShowAskPanel(false)}
                initialContext={askContext}
              />
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
