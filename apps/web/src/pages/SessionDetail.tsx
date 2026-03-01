import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { Session } from '../api';
import SessionReplay from '../components/SessionReplay';

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

  // Review state
  const [reviewNote, setReviewNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    api
      .getSession(id)
      .then(setSession)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  const handleReview = async (status: string) => {
    if (!id) return;
    setSubmitting(true);
    try {
      const review = await api.reviewSession(id, status, reviewNote || undefined);
      setSession((prev) => (prev ? { ...prev, review } : prev));
      setReviewNote('');
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => navigate('/sessions')}
          className="text-gray-500 hover:text-gray-300 transition-colors text-sm"
        >
          &larr; Sessions
        </button>
        <h1 className="text-2xl font-bold">Session Detail</h1>
        {statusBadge(session.review?.status ?? session.status)}
      </div>

      {/* Split layout */}
      <div className="grid lg:grid-cols-5 gap-6">
        {/* Left panel — metadata */}
        <div className="lg:col-span-2 space-y-4">
          {/* Commit info */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              Commit
            </h3>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-gray-500">Message:</span>{' '}
                <span className="text-gray-200">{session.commitMessage ?? '\u2014'}</span>
              </div>
              <div>
                <span className="text-gray-500">SHA:</span>{' '}
                <code className="text-indigo-400 text-xs bg-indigo-950/30 px-1.5 py-0.5 rounded">
                  {session.commitSha?.slice(0, 8) ?? '\u2014'}
                </code>
              </div>
              <div>
                <span className="text-gray-500">Repo:</span>{' '}
                <span className="text-gray-200">{session.repoName ?? '\u2014'}</span>
              </div>
            </div>
          </div>

          {/* Agent info */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              Agent
            </h3>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-gray-500">Name:</span>{' '}
                <span className="text-gray-200">{session.agentName ?? '\u2014'}</span>
              </div>
              <div>
                <span className="text-gray-500">Model:</span>{' '}
                <span className="badge-blue">{session.model}</span>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              Stats
            </h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-gray-500">Tokens In</p>
                <p className="text-gray-200 font-medium">{session.tokensIn.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-gray-500">Tokens Out</p>
                <p className="text-gray-200 font-medium">{session.tokensOut.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-gray-500">Cost</p>
                <p className="text-gray-200 font-medium">${session.cost.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-500">Duration</p>
                <p className="text-gray-200 font-medium">{formatDuration(session.durationMs)}</p>
              </div>
              <div>
                <p className="text-gray-500">Tool Calls</p>
                <p className="text-gray-200 font-medium">{session.toolCalls}</p>
              </div>
              <div>
                <p className="text-gray-500">Files Changed</p>
                <p className="text-gray-200 font-medium">{session.filesChanged}</p>
              </div>
              <div>
                <p className="text-gray-500">Lines Added</p>
                <p className="text-green-400 font-medium">+{session.linesAdded}</p>
              </div>
              <div>
                <p className="text-gray-500">Lines Removed</p>
                <p className="text-red-400 font-medium">-{session.linesRemoved}</p>
              </div>
            </div>
          </div>

          {/* Existing review */}
          {session.review && (
            <div className="card space-y-3">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                Review
              </h3>
              <div className="text-sm space-y-2">
                <div className="flex items-center gap-2">
                  {statusBadge(session.review.status)}
                  <span className="text-gray-500">
                    by {session.review.reviewerName ?? 'unknown'}
                  </span>
                </div>
                {session.review.note && (
                  <p className="text-gray-300 bg-gray-800/50 rounded-lg p-3">
                    {session.review.note}
                  </p>
                )}
                <p className="text-xs text-gray-600">
                  {new Date(session.review.createdAt).toLocaleString()}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Right panel — transcript */}
        <div className="lg:col-span-3">
          <div className="card p-0 overflow-hidden h-[600px] flex flex-col">
            <div className="px-5 py-3 border-b border-gray-800 flex-shrink-0">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                Session Transcript
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto">
              <SessionReplay transcript={session.transcript ?? []} />
            </div>
          </div>
        </div>
      </div>

      {/* Review bar */}
      {!session.review && (
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Review This Session
          </h3>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder="Optional review note..."
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
