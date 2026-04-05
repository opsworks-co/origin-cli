import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getSharedSession } from '../api';
import { formatCost, formatDuration, getStatusBadgeClass } from '../utils';
import { LogoMark } from '../components/Logo';

interface SharedSessionData {
  id: string;
  model: string;
  agentName: string | null;
  branch: string | null;
  durationMs: number;
  costUsd: number;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: string;
  repoName: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  userName: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  prompt: string;
  review: {
    status: string;
    note: string | null;
    score: number | null;
    riskLevel: string | null;
    isAutoReview: boolean;
    reviewerName: string | null;
    createdAt: string;
  } | null;
  sessionDiff: {
    diff: string;
    linesAdded: number;
    linesRemoved: number;
    diffTruncated: boolean;
  } | null;
  promptChanges: Array<{
    promptIndex: number;
    promptText: string;
    filesChanged: string[];
    diff: string;
    createdAt: string;
  }>;
  shared: {
    slug: string;
    expiresAt: string | null;
    createdAt: string;
  };
}

export default function SharedSession() {
  const { slug } = useParams<{ slug: string }>();
  const [session, setSession] = useState<SharedSessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedPrompts, setExpandedPrompts] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!slug) return;
    getSharedSession(slug)
      .then((data: SharedSessionData) => setSession(data))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [slug]);

  const togglePrompt = (index: number) => {
    setExpandedPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Session not found</h1>
          <p className="text-gray-400">{error || 'This shared session link may have expired or been removed.'}</p>
        </div>
      </div>
    );
  }

  let filesChanged: string[] = [];
  try {
    filesChanged = JSON.parse(session.filesChanged || '[]');
  } catch { /* ignore */ }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <nav className="border-b border-gray-800/50 sticky top-0 bg-gray-950/90 backdrop-blur-sm z-50">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <LogoMark size={32} />
            <span className="text-lg font-semibold">Origin</span>
          </Link>
          <span className="text-sm text-gray-500">Shared Session</span>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Title */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold">
              {session.commitMessage || `Session ${session.id.slice(0, 8)}`}
            </h1>
            <span className={`${getStatusBadgeClass(session.status)} text-xs px-2 py-0.5 rounded-full`}>
              {session.status}
            </span>
          </div>
          {session.repoName && (
            <p className="text-gray-400 text-sm">
              {session.repoName}
              {session.branch && <span> / {session.branch}</span>}
              {session.commitSha && <span className="text-gray-600"> @ {session.commitSha.slice(0, 7)}</span>}
            </p>
          )}
        </div>

        {/* Metadata grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <MetaCard label="Model" value={session.model} />
          <MetaCard label="Agent" value={session.agentName || 'None'} />
          <MetaCard label="Duration" value={formatDuration(session.durationMs)} />
          <MetaCard label="Cost" value={formatCost(session.costUsd)} />
          <MetaCard label="Tokens" value={session.tokensUsed.toLocaleString()} />
          <MetaCard label="Tool Calls" value={String(session.toolCalls)} />
          <MetaCard label="Lines" value={`+${session.linesAdded} / -${session.linesRemoved}`} />
          <MetaCard label="Author" value={session.userName || session.commitAuthor || 'Unknown'} />
        </div>

        {/* Review status */}
        {session.review && (
          <div className="mb-8 rounded-lg border border-gray-800 bg-gray-900/50 p-4">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-lg font-semibold">Review</h2>
              <span className={`${getStatusBadgeClass(session.review.status)} text-xs px-2 py-0.5 rounded-full`}>
                {session.review.status}
              </span>
              {session.review.score !== null && (
                <span className="text-sm text-gray-400">Score: {session.review.score}/100</span>
              )}
              {session.review.isAutoReview && (
                <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">AI Review</span>
              )}
            </div>
            {session.review.note && (
              <p className="text-gray-300 text-sm">{session.review.note}</p>
            )}
            {session.review.reviewerName && (
              <p className="text-gray-500 text-xs mt-1">by {session.review.reviewerName}</p>
            )}
          </div>
        )}

        {/* Files changed */}
        {filesChanged.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Files Changed ({filesChanged.length})</h2>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 divide-y divide-gray-800/50">
              {filesChanged.map((file, i) => (
                <div key={i} className="px-4 py-2 text-sm font-mono text-gray-300">
                  {file}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Prompts timeline */}
        {session.promptChanges.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Prompts Timeline</h2>
            <div className="space-y-3">
              {session.promptChanges.map((pc) => (
                <div key={pc.promptIndex} className="rounded-lg border border-gray-800 bg-gray-900/50 overflow-hidden">
                  <button
                    onClick={() => togglePrompt(pc.promptIndex)}
                    className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-800/30 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
                        #{pc.promptIndex}
                      </span>
                      <span className="text-sm text-gray-200 line-clamp-1">
                        {pc.promptText.slice(0, 120)}
                        {pc.promptText.length > 120 ? '...' : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500 flex-shrink-0 ml-2">
                      {pc.filesChanged.length > 0 && (
                        <span>{pc.filesChanged.length} file{pc.filesChanged.length !== 1 ? 's' : ''}</span>
                      )}
                      <svg
                        className={`w-4 h-4 transition-transform ${expandedPrompts.has(pc.promptIndex) ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>
                  {expandedPrompts.has(pc.promptIndex) && (
                    <div className="border-t border-gray-800/50 px-4 py-3 space-y-3">
                      <div className="text-sm text-gray-300 whitespace-pre-wrap">{pc.promptText}</div>
                      {pc.filesChanged.length > 0 && (
                        <div>
                          <div className="text-xs text-gray-500 mb-1">Files:</div>
                          <div className="flex flex-wrap gap-1">
                            {pc.filesChanged.map((f, i) => (
                              <span key={i} className="text-xs font-mono bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
                                {f}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {pc.diff && (
                        <div>
                          <div className="text-xs text-gray-500 mb-1">Diff:</div>
                          <pre className="text-xs font-mono bg-gray-950 rounded p-3 overflow-x-auto max-h-96 overflow-y-auto">
                            {pc.diff.split('\n').map((line, i) => (
                              <div
                                key={i}
                                className={
                                  line.startsWith('+') && !line.startsWith('+++')
                                    ? 'text-green-400'
                                    : line.startsWith('-') && !line.startsWith('---')
                                    ? 'text-red-400'
                                    : line.startsWith('@@')
                                    ? 'text-blue-400'
                                    : 'text-gray-500'
                                }
                              >
                                {line}
                              </div>
                            ))}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Full diff */}
        {session.sessionDiff?.diff && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">
              Full Diff
              <span className="text-sm font-normal text-gray-500 ml-2">
                +{session.sessionDiff.linesAdded} -{session.sessionDiff.linesRemoved}
                {session.sessionDiff.diffTruncated && ' (truncated)'}
              </span>
            </h2>
            <pre className="text-xs font-mono bg-gray-900/50 border border-gray-800 rounded-lg p-4 overflow-x-auto max-h-[600px] overflow-y-auto">
              {session.sessionDiff.diff.split('\n').map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith('+') && !line.startsWith('+++')
                      ? 'text-green-400'
                      : line.startsWith('-') && !line.startsWith('---')
                      ? 'text-red-400'
                      : line.startsWith('@@')
                      ? 'text-blue-400'
                      : line.startsWith('diff ')
                      ? 'text-yellow-400 font-bold'
                      : 'text-gray-500'
                  }
                >
                  {line}
                </div>
              ))}
            </pre>
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-gray-800/50 pt-6 mt-12 text-center">
          <p className="text-sm text-gray-500">
            Shared via{' '}
            <a href="https://getorigin.io" className="text-indigo-400 hover:text-indigo-300 transition-colors">
              Origin
            </a>
            {' '} — AI coding session governance
          </p>
          {session.shared.expiresAt && (
            <p className="text-xs text-gray-600 mt-1">
              Link expires {new Date(session.shared.expiresAt).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-sm font-medium text-gray-200 truncate">{value}</div>
    </div>
  );
}
