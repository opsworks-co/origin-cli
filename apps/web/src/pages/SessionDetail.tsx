import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { Session } from '../api';
import { useAuth } from '../context/AuthContext';
import UnifiedSessionView from '../components/UnifiedSessionView';
import AiBlameView from '../components/AiBlameView';
import AskAuthorPanel from '../components/AskAuthorPanel';
import TurnTimeline from '../components/TurnTimeline';
import { formatCost, formatDuration, getStatusBadgeClass } from '../utils';

function statusBadge(status: string) {
  return <span className={`${getStatusBadgeClass(status)} text-sm`}>{status}</span>;
}

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isDev = user?.accountType === 'developer';
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Tab state
  const [activeTab, setActiveTab] = useState<'session' | 'security' | 'blame' | 'turns'>('session');

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

  // AI Review
  const [aiReviewLoading, setAiReviewLoading] = useState(false);
  const [reviewExpanded, setReviewExpanded] = useState(false);

  // Delete
  const [deleting, setDeleting] = useState(false);

  // End session
  const [ending, setEnding] = useState(false);

  // Share
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  // Export
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Replay
  const [replayActive, setReplayActive] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);

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

  // Elapsed timer for running sessions — use durationMs when available
  useEffect(() => {
    if (!session || session.status !== 'RUNNING') return;
    // If CLI already reported a duration, use it as the starting point
    const baseMs = session.durationMs > 0 ? session.durationMs : 0;
    const timerStart = Date.now();
    const update = () => {
      const sincePageLoad = Date.now() - timerStart;
      setElapsed(Math.floor((baseMs + sincePageLoad) / 1000));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [session?.status, session?.startedAt]);

  // Deep-link tab from URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab === 'blame') setActiveTab('blame');
    else if (tab === 'turns') setActiveTab('turns');
  }, []);

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

  const handleAIReview = async () => {
    if (!id) return;
    setAiReviewLoading(true);
    try {
      const result = await api.triggerAIReview(id);
      if (result.review) {
        setSession((prev) => prev ? { ...prev, review: result.review } : prev);
        setReviewFeedback(`AI Review complete — Score: ${result.score}/100 (${result.riskLevel} risk)`);
        setTimeout(() => setReviewFeedback(''), 8000);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAiReviewLoading(false);
    }
  };

  const handleEnd = async () => {
    if (!id || !confirm('End this running session?')) return;
    setEnding(true);
    try {
      await api.endSession(id);
      // Refresh session data
      const updated = await api.getSession(id);
      setSession(updated);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setEnding(false);
    }
  };

  // Replay auto-advance
  useEffect(() => {
    if (!replayActive || !replayPlaying || !session?.promptChanges?.length) return;
    const timer = setInterval(() => {
      setReplayIndex((prev) => {
        if (prev >= session.promptChanges!.length - 1) { setReplayPlaying(false); return prev; }
        return prev + 1;
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [replayActive, replayPlaying, session?.promptChanges?.length]);

  // Replay keyboard controls
  useEffect(() => {
    if (!replayActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); setReplayPlaying((p) => !p); }
      if (e.key === 'ArrowRight' && session?.promptChanges?.length) {
        setReplayPlaying(false);
        setReplayIndex((p) => Math.min(p + 1, session.promptChanges!.length - 1));
      }
      if (e.key === 'ArrowLeft') { setReplayPlaying(false); setReplayIndex((p) => Math.max(p - 1, 0)); }
      if (e.key === 'Escape') { setReplayActive(false); setReplayPlaying(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [replayActive, session?.promptChanges?.length]);

  const handleShare = async () => {
    if (!id) return;
    setSharing(true);
    try {
      const result = await api.shareSession(id);
      const url = `https://getorigin.io/s/${result.slug}`;
      setShareUrl(url);
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 3000);
    } catch (err: any) {
      setError(err.message);
    }
    setSharing(false);
  };

  const handleUnshare = async () => {
    if (!id) return;
    try {
      await api.unshareSession(id);
      setShareUrl(null);
    } catch {}
  };

  const exportAsMarkdown = () => {
    if (!session) return;
    const date = new Date(session.createdAt).toISOString().split('T')[0];
    const lines = [
      `# Origin Session — ${session.repoName || 'Unknown Repo'}`,
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Agent | ${session.agentName || 'Unknown'} |`,
      `| Model | ${session.model} |`,
      `| Duration | ${formatDuration(session.durationMs)} |`,
      `| Cost | ${formatCost(session.costUsd)} |`,
      `| Tokens | ${session.tokensUsed.toLocaleString()} |`,
      `| Lines | +${session.linesAdded} / -${session.linesRemoved} |`,
      `| Branch | ${session.branch || '—'} |`,
      `| Date | ${new Date(session.createdAt).toLocaleString()} |`,
      '',
    ];
    if (session.promptChanges?.length) {
      lines.push('## Prompts', '');
      session.promptChanges.forEach((p: any, i: number) => {
        lines.push(`### Prompt ${i + 1}`, '', p.promptText || '_(empty)_', '');
        if (p.filesChanged) {
          try {
            const files = typeof p.filesChanged === 'string' ? JSON.parse(p.filesChanged) : p.filesChanged;
            if (files.length) lines.push('**Files:** ' + files.join(', '), '');
          } catch {}
        }
        if (p.diff) {
          lines.push('```diff', p.diff.slice(0, 5000), '```', '');
        }
      });
    }
    lines.push('---', '*Exported from [Origin](https://getorigin.io)*');
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `origin-session-${id?.slice(0, 8)}-${date}.md`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  const [archiving, setArchiving] = useState(false);

  const handleToggleArchive = async () => {
    if (!id || !session) return;
    setArchiving(true);
    try {
      await api.archiveSession(id, !session.archived);
      setSession((prev) => prev ? { ...prev, archived: !prev.archived } : prev);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setArchiving(false);
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
        <h1 className="text-xl font-bold">{(session.repoNames && session.repoNames.length > 1 ? session.repoNames.join(', ') : session.repoName) ?? 'Session'}</h1>
        {statusBadge(isDev ? (session.status === 'RUNNING' ? 'running' : 'ended') : (session.review?.status?.toLowerCase() ?? (session.status === 'RUNNING' ? 'running' : 'ended')))}
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
          {(session.userName || session.apiKeyName) && (
            <span>by {session.userName || session.apiKeyName}</span>
          )}
          <span>{formatDuration(session.durationMs)}</span>
          <span>{session.tokensUsed.toLocaleString()} tokens</span>
          <span>{formatCost(session.costUsd)}</span>
          <span>{session.toolCalls} tools</span>
          <span>{filesCount} files</span>
          <span className="text-green-400">+{session.linesAdded}</span>
          <span className="text-red-400">-{session.linesRemoved}</span>

          {/* Action buttons — pill style */}
          <div className="flex items-center gap-2 ml-2 flex-wrap">
            {/* Replay */}
            {session.promptChanges && session.promptChanges.length > 0 && (
              <button
                onClick={() => { setReplayActive(true); setReplayIndex(0); setReplayPlaying(true); }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-purple-500/15 text-purple-400 border border-purple-500/25 hover:bg-purple-500/25 transition-colors"
                title="Replay session step by step"
              >
                Replay
              </button>
            )}

            {/* Export */}
            <div className="relative">
              <button
                onClick={() => setShowExportMenu(!showExportMenu)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-gray-700/50 text-gray-300 border border-gray-600/50 hover:bg-gray-700 transition-colors"
                title="Export session"
              >
                Export
              </button>
              {showExportMenu && (
                <div className="absolute right-0 top-full mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 py-1 min-w-[160px]">
                  <button
                    onClick={exportAsMarkdown}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
                  >
                    Export as Markdown
                  </button>
                </div>
              )}
            </div>

            {/* Share */}
            {shareUrl ? (
              <span className="inline-flex items-center gap-1">
                <button
                  onClick={() => { navigator.clipboard.writeText(shareUrl); setShareCopied(true); setTimeout(() => setShareCopied(false), 2000); }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors"
                  title="Copy share link"
                >
                  {shareCopied ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  onClick={handleUnshare}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-gray-700/50 text-gray-400 border border-gray-600/50 hover:bg-red-500/15 hover:text-red-400 hover:border-red-500/25 transition-colors"
                  title="Revoke share link"
                >
                  Unshare
                </button>
              </span>
            ) : (
              <button
                onClick={handleShare}
                disabled={sharing}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/25 hover:bg-indigo-500/25 transition-colors disabled:opacity-50"
                title="Create public share link"
              >
                {sharing ? 'Sharing...' : 'Share'}
              </button>
            )}

            {/* Details */}
            <button
              onClick={() => setShowMeta((prev) => !prev)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                showMeta
                  ? 'bg-sky-500/15 text-sky-400 border-sky-500/25'
                  : 'bg-gray-700/50 text-gray-300 border-gray-600/50 hover:bg-gray-700'
              }`}
              title="Show details"
            >
              Details
            </button>

            {/* End session */}
            {session.status === 'RUNNING' && (
              <button
                onClick={handleEnd}
                disabled={ending}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/25 hover:bg-amber-500/25 transition-colors disabled:opacity-50"
                title="End session"
              >
                {ending ? 'Ending...' : 'End'}
              </button>
            )}

            {/* Archive / Unarchive */}
            <button
              onClick={handleToggleArchive}
              disabled={archiving}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 ${
                session.archived
                  ? 'bg-amber-500/15 text-amber-400 border-amber-500/25 hover:bg-amber-500/25'
                  : 'bg-gray-700/50 text-gray-300 border-gray-600/50 hover:bg-gray-700'
              }`}
              title={session.archived ? 'Unarchive session' : 'Archive session'}
            >
              {archiving ? 'Working...' : session.archived ? 'Unarchive' : 'Archive'}
            </button>

            {/* Delete */}
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              title="Delete session"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      </div>

      {/* ── AI Quality Score Card (collapsible) — team only ── */}
      {!isDev && session.review?.score != null && (
        <div className={`rounded-lg flex-shrink-0 border ${
          session.review.score >= 80 ? 'bg-green-900/10 border-green-800/30' :
          session.review.score >= 50 ? 'bg-amber-900/10 border-amber-800/30' :
          'bg-red-900/10 border-red-800/30'
        }`}>
          <button
            onClick={() => setReviewExpanded((prev) => !prev)}
            className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-white/5 transition-colors rounded-lg"
          >
            <div className="flex items-center gap-3">
              <span className={`text-2xl font-bold tabular-nums ${
                session.review.score >= 80 ? 'text-green-400' :
                session.review.score >= 50 ? 'text-amber-400' : 'text-red-400'
              }`}>{session.review.score}</span>
              <span className="text-xs text-gray-500">AI Score</span>
              {session.review.riskLevel && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase ${
                  session.review.riskLevel === 'low' ? 'bg-green-500/20 text-green-400' :
                  session.review.riskLevel === 'medium' ? 'bg-amber-500/20 text-amber-400' :
                  'bg-red-500/20 text-red-400'
                }`}>{session.review.riskLevel} risk</span>
              )}
              {session.review.concerns && session.review.concerns.length > 0 && (
                <span className="text-xs text-gray-500">{session.review.concerns.length} concerns</span>
              )}
            </div>
            <span className="text-gray-500 text-xs">{reviewExpanded ? '▲ Collapse' : '▼ Expand'}</span>
          </button>
          {reviewExpanded && (
          <div className="px-5 pb-4">
          <div className="flex items-start gap-5">
            {/* Big score number */}
            <div className="flex-shrink-0 text-center">
              <div className={`text-4xl font-bold tabular-nums ${
                session.review.score >= 80 ? 'text-green-400' :
                session.review.score >= 50 ? 'text-amber-400' : 'text-red-400'
              }`}>
                {session.review.score}
              </div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-0.5">
                {session.review.isAutoReview ? 'AI Score' : 'Score'}
              </div>
            </div>

            {/* Category breakdown bars */}
            {session.review.categories && (
              <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-2 min-w-0">
                {(['security', 'scope', 'quality', 'cost'] as const).map((cat) => {
                  const val = (session.review!.categories as any)?.[cat] ?? 0;
                  return (
                    <div key={cat}>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs text-gray-400 capitalize">{cat}</span>
                        <span className={`text-xs font-medium tabular-nums ${
                          val >= 80 ? 'text-green-400' : val >= 50 ? 'text-amber-400' : 'text-red-400'
                        }`}>{val}</span>
                      </div>
                      <div className="w-full bg-gray-800 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full transition-all ${
                          val >= 80 ? 'bg-green-500/70' : val >= 50 ? 'bg-amber-500/70' : 'bg-red-500/70'
                        }`} style={{ width: `${val}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Concerns & suggestions */}
            <div className="flex-1 min-w-0 space-y-2">
              {session.review.concerns && session.review.concerns.length > 0 && (
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Concerns</p>
                  <ul className="space-y-0.5">
                    {session.review.concerns.slice(0, 4).map((c: string, i: number) => (
                      <li key={i} className="text-xs text-gray-300 flex items-start gap-1.5">
                        <span className="text-amber-400 mt-0.5 flex-shrink-0">&#8226;</span>
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {session.review.suggestions && session.review.suggestions.length > 0 && (
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Suggestions</p>
                  <ul className="space-y-0.5">
                    {session.review.suggestions.slice(0, 3).map((s: string, i: number) => (
                      <li key={i} className="text-xs text-gray-400 flex items-start gap-1.5">
                        <span className="text-indigo-400 mt-0.5 flex-shrink-0">&#8250;</span>
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {session.review.riskLevel && (
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wider ${
                    session.review.riskLevel === 'low' ? 'bg-green-500/20 text-green-400' :
                    session.review.riskLevel === 'medium' ? 'bg-amber-500/20 text-amber-400' :
                    session.review.riskLevel === 'high' ? 'bg-orange-500/20 text-orange-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>{session.review.riskLevel} risk</span>
                  <span className="text-[10px] text-gray-600">
                    {session.review.isAutoReview ? 'AI review' : `by ${session.review.reviewerName ?? 'unknown'}`}
                    {session.review.createdAt && ` \u00B7 ${new Date(session.review.createdAt).toLocaleString()}`}
                  </span>
                </div>
              )}
            </div>
          </div>
          </div>
          )}
        </div>
      )}

      {/* ── Review Reason Banner (for flagged/rejected without score) — team only ── */}
      {!isDev && session.review && session.review.score == null && ['flagged', 'rejected'].includes(session.review.status?.toLowerCase()) && (
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
                  by {session.review.reviewerName ?? 'unknown'}
                  {session.review.createdAt && ` \u00B7 ${new Date(session.review.createdAt).toLocaleString()}`}
                </span>
              </div>
              {session.review.note ? (
                <div className="text-sm text-gray-300 space-y-1">
                  {session.review.note.split('\n').filter((l: string) => l.trim()).slice(0, 8).map((line: string, i: number) => (
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
            const isAI = session.review.isAutoReview;
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
                    {session.review.score != null && (
                      <span className={`text-xs font-semibold ${
                        session.review.score >= 80 ? 'text-green-400' :
                        session.review.score >= 50 ? 'text-amber-400' : 'text-red-400'
                      }`}>{session.review.score}/100</span>
                    )}
                    <span className="text-gray-500 text-xs">
                      by {isAI ? 'Origin AI' : (session.review.reviewerName ?? 'unknown')}
                    </span>
                  </div>
                  {session.review.note && (
                    <div className="text-gray-400 text-xs bg-gray-800/50 rounded p-2 max-h-24 overflow-y-auto">
                      {session.review.note.split('\n').filter((l: string) => l.trim()).slice(0, 5).map((line: string, i: number) => (
                        <p key={i}>{line.replace(/\*\*/g, '')}</p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* System prompt hidden — available via API but not shown in UI */}
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
            onClick={() => setActiveTab('turns')}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              activeTab === 'turns'
                ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
            }`}
          >
            Turns
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
              transcript={(() => {
                try {
                  const parsed = JSON.parse(session.transcript);
                  if (Array.isArray(parsed) && parsed.length > 0) return parsed;
                } catch { /* empty */ }
                // Synthesize transcript from prompt data when no real transcript exists (Codex, etc.)
                const synth: Array<{ role: string; content: string }> = [];
                // System prompt not injected into synthesized transcript
                if (session.promptChanges) {
                  for (const pc of session.promptChanges) {
                    if (pc.promptText) synth.push({ role: 'user', content: pc.promptText });
                  }
                }
                return synth;
              })()}
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
          {activeTab === 'turns' && session && (
            <TurnTimeline
              promptChanges={session.promptChanges || []}
              model={session.model}
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

      {/* Review bar — team only */}
      {!isDev && (!session.review || session.review.isAutoReview) && (
        <div className="card flex-shrink-0">
          <div className="flex flex-col sm:flex-row gap-3 items-center">
            <span className="text-sm text-gray-400 whitespace-nowrap">
              {session.review?.isAutoReview ? 'Override AI Review' : 'Review'}
            </span>
            <input
              type="text"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder="Optional note..."
              className="input flex-1"
            />
            <div className="flex gap-2">
              {/* AI Review trigger */}
              <button
                onClick={handleAIReview}
                disabled={aiReviewLoading || submitting}
                className="bg-purple-600 hover:bg-purple-500 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {aiReviewLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
                    Scoring...
                  </>
                ) : (
                  <>
                    <span className="text-xs">&#9733;</span>
                    {session.review?.isAutoReview ? 'Re-run AI' : 'AI Review'}
                  </>
                )}
              </button>
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
      {/* ── Session Replay Overlay ── */}
      {replayActive && session.promptChanges && session.promptChanges.length > 0 && (() => {
        const turns = session.promptChanges.sort((a: any, b: any) => a.promptIndex - b.promptIndex);
        const turn = turns[replayIndex] as any;
        const total = turns.length;
        const files = (() => { try { return typeof turn.filesChanged === 'string' ? JSON.parse(turn.filesChanged) : turn.filesChanged; } catch { return []; } })();
        return (
          <div className="fixed inset-0 z-50 bg-gray-950/95 backdrop-blur-sm flex flex-col">
            {/* Top bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-purple-400">Session Replay</span>
                <span className="text-xs text-gray-500">{session.repoName} &middot; {session.agentName || session.model}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Space: play/pause &middot; Arrows: prev/next &middot; Esc: close</span>
                <button onClick={() => { setReplayActive(false); setReplayPlaying(false); }} className="text-gray-500 hover:text-gray-300 ml-2 text-sm">Close</button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6 max-w-4xl mx-auto w-full">
              <div className="mb-4">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">Prompt {replayIndex + 1} of {total}</span>
              </div>
              <div className="card mb-4">
                <div className="text-xs text-gray-500 mb-2">Prompt</div>
                <p className="text-sm text-gray-200 whitespace-pre-wrap">{turn.promptText || '_(empty)_'}</p>
              </div>
              {files.length > 0 && (
                <div className="mb-4">
                  <div className="text-xs text-gray-500 mb-2">Files changed</div>
                  <div className="flex flex-wrap gap-1">
                    {files.map((f: string, i: number) => (
                      <span key={i} className="px-2 py-0.5 rounded text-[10px] bg-gray-800 text-gray-400 font-mono">{f}</span>
                    ))}
                  </div>
                </div>
              )}
              {turn.diff && (
                <div>
                  <div className="text-xs text-gray-500 mb-2">Diff</div>
                  <pre className="bg-gray-900 rounded-lg p-4 text-xs font-mono overflow-x-auto max-h-[400px] overflow-y-auto">
                    {turn.diff.split('\n').map((line: string, i: number) => (
                      <div key={i} className={
                        line.startsWith('+') ? 'text-green-400' :
                        line.startsWith('-') ? 'text-red-400' :
                        line.startsWith('@@') ? 'text-cyan-400' :
                        'text-gray-500'
                      }>{line}</div>
                    ))}
                  </pre>
                </div>
              )}
            </div>

            {/* Progress bar + controls */}
            <div className="border-t border-gray-800 px-6 py-3">
              <div className="flex items-center gap-4 max-w-4xl mx-auto">
                <button
                  onClick={() => { setReplayPlaying(false); setReplayIndex(Math.max(0, replayIndex - 1)); }}
                  disabled={replayIndex === 0}
                  className="text-gray-400 hover:text-gray-200 disabled:text-gray-700 text-sm"
                >
                  Prev
                </button>
                <button
                  onClick={() => setReplayPlaying(!replayPlaying)}
                  className="w-8 h-8 rounded-full bg-purple-600 hover:bg-purple-500 flex items-center justify-center text-white text-sm transition-colors"
                >
                  {replayPlaying ? '||' : '\u25B6'}
                </button>
                <button
                  onClick={() => { setReplayPlaying(false); setReplayIndex(Math.min(total - 1, replayIndex + 1)); }}
                  disabled={replayIndex >= total - 1}
                  className="text-gray-400 hover:text-gray-200 disabled:text-gray-700 text-sm"
                >
                  Next
                </button>
                <div className="flex-1 bg-gray-800 rounded-full h-1.5 mx-2">
                  <div
                    className="h-1.5 rounded-full bg-purple-500 transition-all duration-300"
                    style={{ width: `${((replayIndex + 1) / total) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500 tabular-nums">{replayIndex + 1}/{total}</span>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
