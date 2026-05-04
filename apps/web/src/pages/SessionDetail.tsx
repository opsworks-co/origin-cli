import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import type { Session } from '../api';
import { useAuth } from '../context/AuthContext';
import UnifiedSessionView from '../components/UnifiedSessionView';
import AiBlameView from '../components/AiBlameView';
import AskAuthorPanel from '../components/AskAuthorPanel';
import TurnTimeline from '../components/TurnTimeline';
import { formatCost, formatDuration, getStatusBadgeClass } from '../utils';
import { safeHref } from '../utils/safe-url';
import { useToast } from '../components/Toast';
import { Sparkles, Check, X as XIcon, Flag } from 'lucide-react';

function statusBadge(status: string) {
  return <span className={`${getStatusBadgeClass(status)} text-sm`}>{status}</span>;
}

// Outline-style review action button. Three semantic colors (emerald=approve,
// red=reject, amber=flag) share the same shape so they group visually as
// one disposition cluster — only the trim color differs. Hover fills the
// button with the trim color so the click target is obvious.
function ReviewActionButton({
  label, icon, color, onClick, disabled,
}: {
  label: string;
  icon: React.ReactNode;
  color: 'emerald' | 'red' | 'amber';
  onClick: () => void;
  disabled?: boolean;
}) {
  const palette: Record<typeof color, { text: string; border: string; hoverBg: string; hoverText: string }> = {
    emerald: { text: 'text-emerald-400', border: 'border-emerald-500/30', hoverBg: 'hover:bg-emerald-500/15', hoverText: 'hover:text-emerald-300' },
    red:     { text: 'text-red-400',     border: 'border-red-500/30',     hoverBg: 'hover:bg-red-500/15',     hoverText: 'hover:text-red-300'     },
    amber:   { text: 'text-amber-400',   border: 'border-amber-500/30',   hoverBg: 'hover:bg-amber-500/15',   hoverText: 'hover:text-amber-300'   },
  };
  const c = palette[color];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border ${c.text} ${c.border} ${c.hoverBg} ${c.hoverText} transition-colors disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {icon}
      {label}
    </button>
  );
}

// ── HeaderCommits ──────────────────────────────────────────────────────────
// Shows the commits a session produced. Prefers the rich `commits` list
// (API's sessionCommits union) which carries branch + message; falls back to
// the SHA-only `sessionDiff.commitShas` for older API responses.
// 0 commits → renders nothing.
// 1 commit  → labeled pill linking to the commit (shows branch when non-default).
// N commits → "N commits ▾" pill; click toggles an inline list grouped by branch.
type HeaderCommitEntry = { sha: string; branch?: string | null; message?: string | null };
function HeaderCommits({
  repoId,
  commits,
  shas,
}: {
  repoId: string | null | undefined;
  commits?: Array<{ sha: string; branch: string | null; message: string }> | null;
  shas?: string[];
}) {
  const [open, setOpen] = useState(false);

  // Normalize: prefer rich commits, else synthesize from SHA list.
  const entries: HeaderCommitEntry[] =
    commits && commits.length > 0
      ? commits.map((c) => ({ sha: c.sha, branch: c.branch, message: c.message }))
      : (shas || []).map((sha) => ({ sha }));

  if (entries.length === 0) return null;

  const pillBase =
    'text-[11px] bg-gray-800/60 text-gray-400 px-2 py-0.5 rounded-md inline-flex items-center gap-1.5 border border-gray-700/40';
  const pillInteractive = ' hover:text-gray-200 hover:border-gray-600 transition-colors';

  if (entries.length === 1) {
    const e = entries[0];
    const label = (
      <>
        <span className="text-gray-500">Commit:</span>
        <code className="font-mono">{e.sha.slice(0, 8)}</code>
        {e.branch && (
          <span className="text-gray-500 font-mono">· {e.branch}</span>
        )}
      </>
    );
    return repoId ? (
      <Link to={`/repos/${repoId}/commits/${e.sha}`} className={pillBase + pillInteractive}>
        {label}
      </Link>
    ) : (
      <span className={pillBase}>{label}</span>
    );
  }

  // Group by branch so multi-branch sessions are legible at a glance.
  const byBranch = new Map<string, HeaderCommitEntry[]>();
  for (const e of entries) {
    const key = e.branch || 'unknown';
    if (!byBranch.has(key)) byBranch.set(key, []);
    byBranch.get(key)!.push(e);
  }
  const multiBranch = byBranch.size > 1;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={pillBase + pillInteractive}
      >
        <span className="font-mono">{entries.length}</span>
        <span>commits</span>
        {multiBranch && <span className="text-gray-500">· {byBranch.size} branches</span>}
        <span className="text-gray-500">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 min-w-[320px] rounded-md border border-gray-700/60 bg-gray-900 shadow-lg p-1">
          {[...byBranch.entries()].map(([branch, bEntries]) => (
            <div key={branch}>
              {multiBranch && (
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-gray-500 font-mono">
                  {branch}
                </div>
              )}
              {bEntries.map((e) => {
                const row = (
                  <div className="px-2 py-1 text-[11px] flex items-center gap-2 hover:bg-gray-800/80 rounded">
                    <code className="font-mono text-gray-300">{e.sha.slice(0, 8)}</code>
                    {e.message && (
                      <span className="text-gray-500 truncate max-w-[220px]">
                        {e.message.split('\n')[0]}
                      </span>
                    )}
                  </div>
                );
                return repoId ? (
                  <Link key={e.sha} to={`/repos/${repoId}/commits/${e.sha}`} className="block" onClick={() => setOpen(false)}>
                    {row}
                  </Link>
                ) : (
                  <div key={e.sha}>{row}</div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Console View — formatted agent transcript ──────────────────────────────

interface TranscriptTurn { role: string; content: string }

function ConsoleView({ transcript }: { transcript: string }) {
  if (!transcript) {
    return (
      <div className="text-center py-16">
        <p className="text-sm text-gray-600">No console output captured for this session</p>
      </div>
    );
  }

  // Try parsing as JSON transcript
  let turns: TranscriptTurn[] | null = null;
  try {
    const parsed = JSON.parse(transcript);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].role) {
      turns = parsed;
    } else if (parsed.role && parsed.content) {
      turns = [parsed];
    }
  } catch { /* raw text */ }

  if (turns) {
    return (
      <div className="p-4 space-y-3 overflow-y-auto">
        {turns.map((turn, i) => {
          const isUser = turn.role === 'user' || turn.role === 'human';
          const isSystem = turn.role === 'system';
          const isTool = turn.role === 'tool_use' || turn.role === 'tool_result';
          const content = typeof turn.content === 'string' ? turn.content : JSON.stringify(turn.content, null, 2);
          return (
            <div key={i} className={`rounded-lg px-4 py-3 ${
              isUser
                ? 'bg-indigo-500/10 border border-indigo-500/20'
                : isSystem
                  ? 'bg-gray-800/50 border border-gray-700/30'
                  : isTool
                    ? 'bg-amber-500/5 border border-amber-500/10'
                    : 'bg-gray-900/50 border border-white/[0.05]'
            }`}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`text-[10px] font-bold uppercase tracking-wider ${
                  isUser ? 'text-indigo-400' : isSystem ? 'text-gray-500' : isTool ? 'text-amber-400' : 'text-emerald-400'
                }`}>
                  {isUser ? '▶ You' : isSystem ? '⚙ System' : isTool ? '🔧 Tool' : '◀ Agent'}
                </span>
              </div>
              <div className="text-[12px] text-gray-300 leading-relaxed whitespace-pre-wrap font-mono">
                {content.split('\n').map((line, j) => {
                  let cls = '';
                  if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400/80';
                  else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400/80';
                  else if (line.startsWith('@@')) cls = 'text-indigo-400/80';
                  return <div key={j} className={cls}>{line || '\u00a0'}</div>;
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Raw text fallback
  return (
    <div className="p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-gray-400 overflow-y-auto">
      {transcript.split('\n').map((line, i) => {
        let cls = 'text-gray-400';
        if (line.startsWith('> ') || line.startsWith('$ ')) cls = 'text-emerald-400';
        else if (line.startsWith('Error') || line.startsWith('error')) cls = 'text-red-400';
        else if (line.match(/^(Human|User|human|user):/i)) cls = 'text-indigo-400 font-semibold';
        else if (line.match(/^(Assistant|assistant|Claude|claude):/i)) cls = 'text-cyan-400';
        else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400/70';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400/70';
        return <div key={i} className={cls}>{line || '\u00a0'}</div>;
      })}
    </div>
  );
}

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, activeOrg } = useAuth();
  const { toast } = useToast();
  const isDev = user?.accountType === 'developer';
  // Approve / Reject / Flag / AI Review are admin-level dispositions in
  // a team org — members shouldn't see them. Solo devs already get the
  // bar hidden via isDev below; canReview gates the team-org case.
  const canReview = !isDev && (activeOrg?.role === 'OWNER' || activeOrg?.role === 'ADMIN');
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Tab state
  const [activeTab, setActiveTab] = useState<'session' | 'security' | 'blame' | 'turns'>('session');

  // Stable filesChanged for AiBlameView. Recomputing this inline as `(() => …)()`
  // produced a new array reference on every render, which busted the useMemo
  // and useEffect deps inside AiBlameView and caused an infinite re-fetch loop
  // (the spinner never resolved).
  const blameFilesChanged = useMemo<string[]>(() => {
    if (!session) return [];
    try {
      const top = JSON.parse(session.filesChanged || '[]');
      if (Array.isArray(top) && top.length > 0) return top as string[];
    } catch { /* fall through */ }
    const union = new Set<string>();
    for (const pc of session.promptChanges || []) {
      for (const f of (pc.filesChanged || [])) union.add(f);
    }
    return [...union];
  }, [session?.filesChanged, session?.promptChanges]);

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

  // Annotations
  const [annotations, setAnnotations] = useState<api.SessionAnnotation[]>([]);

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
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);

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

    // Load annotations
    api.getAnnotations(id).then(setAnnotations).catch(() => {});
  }, [id]);

  // Elapsed timer for running sessions — compute from startedAt so it survives refreshes
  useEffect(() => {
    if (!session || (session.status !== 'RUNNING' && session.status !== 'IDLE')) return;
    const startTime = session.startedAt ? new Date(session.startedAt).getTime() : Date.now();
    const update = () => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [session?.status, session?.startedAt]);

  // Deep-link tab + prompt focus from URL params. The commit-detail page
  // passes `?tab=snapshots&prompt=N` / `?tab=blame&prompt=N` to land users on
  // the exact snapshot or blame slice that matches the prompt they clicked.
  const [focusPromptIndex, setFocusPromptIndex] = useState<number | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab === 'blame') setActiveTab('blame');
    else if (tab === 'turns' || tab === 'snapshots') setActiveTab('turns');
    const promptParam = params.get('prompt');
    const parsed = promptParam != null ? Number(promptParam) : NaN;
    if (Number.isFinite(parsed)) setFocusPromptIndex(parsed);
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

  const exportAsGist = async () => {
    if (!session) return;
    const date = new Date(session.createdAt).toISOString().split('T')[0];
    const repo = (session.repoNames && session.repoNames.length > 1 ? session.repoNames.join(', ') : session.repoName) ?? 'Unknown Repo';
    const lines = [
      `# Origin Session: ${session.model} on ${repo} (${date})`,
      '',
      '## Metadata',
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Model | ${session.model} |`,
      `| Cost | ${formatCost(session.costUsd)} |`,
      `| Tokens | ${session.tokensUsed.toLocaleString()} |`,
      `| Duration | ${formatDuration(session.durationMs)} |`,
      `| Files changed | ${(() => { try { return JSON.parse(session.filesChanged).length; } catch { return 0; } })()} |`,
      `| Lines | +${session.linesAdded} / -${session.linesRemoved} |`,
      `| Branch | ${session.branch || '—'} |`,
      `| Agent | ${session.agentName || 'Unknown'} |`,
      '',
    ];
    if (session.promptChanges?.length) {
      lines.push('## Prompts', '');
      session.promptChanges.forEach((p: any, i: number) => {
        lines.push(`### Turn ${i + 1}`, '', p.promptText || '_(empty)_', '');
        if (p.filesChanged) {
          try {
            const files = typeof p.filesChanged === 'string' ? JSON.parse(p.filesChanged) : p.filesChanged;
            if (files.length) lines.push('**Files changed:** ' + files.join(', '), '');
          } catch {}
        }
      });
    }
    lines.push('---', '', '*Exported from [Origin](https://getorigin.io)*');
    const markdown = lines.join('\n');
    try {
      await navigator.clipboard.writeText(markdown);
      window.open('https://gist.github.com', '_blank');
      toast('success', 'Session copied to clipboard — paste into the Gist editor');
    } catch {
      toast('error', 'Failed to copy to clipboard');
    }
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

  // Compute AI attribution from prompt changes
  const aiPct = (() => {
    if (!session.promptChanges || session.promptChanges.length === 0) return null;
    let totalLines = 0;
    let aiLines = 0;
    for (const pc of session.promptChanges) {
      const a = (pc as any).linesAdded || 0;
      const r = (pc as any).linesRemoved || 0;
      const pct = (pc as any).aiPercentage ?? 100;
      totalLines += a + r;
      aiLines += (a + r) * (pct / 100);
    }
    return totalLines > 0 ? Math.round((aiLines / totalLines) * 100) : null;
  })();

  const isRunning = session.status === 'RUNNING';
  // Running sessions: newest turn first (latest activity at top).
  // Completed: oldest first, reads like a transcript.
  const turnsDefaultSort: 'asc' | 'desc' = isRunning ? 'desc' : 'asc';

  // Live-ticking duration display for running sessions, static otherwise.
  const liveDuration = isRunning
    ? (elapsed >= 3600
        ? `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m ${elapsed % 60}s`
        : elapsed >= 60
          ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
          : `${elapsed}s`)
    : formatDuration(session.durationMs);

  return (
    <div className="flex flex-col gap-0 h-full">
      {/* ── Header ── */}
      <div className="flex-shrink-0 px-6 pt-4 pb-3">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500 mb-2.5">
          <button
            onClick={() => navigate('/sessions')}
            className="hover:text-gray-300 transition-colors flex items-center gap-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Sessions
          </button>
          <span className="text-gray-700">/</span>
          <Link
            to={(session.repoId && `/repos/${session.repoId}`) || '/repos'}
            className="hover:text-gray-300 transition-colors"
          >
            {session.repoName ?? 'repo'}
          </Link>
          <span className="text-gray-700">/</span>
          <code className="text-gray-400 font-mono">{session.id.slice(0, 8)}</code>
        </div>

        {/* Title row: repo, status, branch, commit */}
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <h1 className="text-lg font-semibold text-gray-100">{(session.repoNames && session.repoNames.length > 1 ? session.repoNames.join(', ') : session.repoName) ?? 'Session'}</h1>
          {statusBadge(isDev ? session.status.toLowerCase() : (session.review?.status?.toLowerCase() ?? session.status.toLowerCase()))}
          {session.branch && (
            <span className="text-[11px] bg-gray-800/60 text-gray-400 px-2 py-0.5 rounded-md font-mono inline-flex items-center gap-1.5 border border-gray-700/40">
              <svg className="w-3 h-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
              {session.branch}
            </span>
          )}
          <HeaderCommits
            repoId={session.repoId}
            commits={session.commits}
            shas={session.sessionDiff?.commitShas ?? []}
          />
        </div>

        {/* Stats pills row + actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Agent + Model */}
          <div className="flex items-center gap-1.5 bg-gray-800/40 border border-gray-700/40 rounded-lg px-2.5 py-1">
            <span className="text-[11px] text-gray-300">{session.agentName ?? 'Agent'}</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">{session.model}</span>
          </div>

          {(session.userName || session.apiKeyName) && (
            <div className="flex items-center gap-1.5 bg-gray-800/40 border border-gray-700/40 rounded-lg px-2.5 py-1">
              <svg className="w-3 h-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
              <span className="text-[11px] text-gray-300">{session.userName || session.apiKeyName}</span>
            </div>
          )}

          {/* Duration — live-ticking when session is RUNNING, with pulsing dot */}
          <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 border ${
            isRunning
              ? 'bg-purple-500/10 border-purple-500/30'
              : 'bg-gray-800/40 border-gray-700/40'
          }`}>
            {isRunning && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
              </span>
            )}
            <span className={`text-[11px] font-mono tabular-nums ${isRunning ? 'text-purple-300' : 'text-gray-300'}`}>
              {liveDuration}
            </span>
          </div>

          {/* Cost */}
          <div className="bg-gray-800/40 border border-gray-700/40 rounded-lg px-2.5 py-1">
            <span className="text-[11px] text-gray-300 tabular-nums">{formatCost(session.costUsd)}</span>
          </div>

          {/* Tokens */}
          <div className="bg-gray-800/40 border border-gray-700/40 rounded-lg px-2.5 py-1">
            <span className="text-[11px] text-gray-300 tabular-nums">{session.tokensUsed.toLocaleString()}</span>
            <span className="text-[10px] text-gray-600 ml-1">tokens</span>
          </div>

          {/* Lines changed — explicitly labeled */}
          <div className="bg-gray-800/40 border border-gray-700/40 rounded-lg px-2.5 py-1 flex items-center gap-1.5">
            <span className="text-[11px] text-green-400 font-mono">+{session.linesAdded}</span>
            <span className="text-gray-700">/</span>
            <span className="text-[11px] text-red-400 font-mono">-{session.linesRemoved}</span>
            <span className="text-[10px] text-gray-600 ml-0.5">lines</span>
          </div>

          {/* Files + tools */}
          <div className="bg-gray-800/40 border border-gray-700/40 rounded-lg px-2.5 py-1 flex items-center gap-1.5">
            <span className="text-[11px] text-gray-300 tabular-nums">{filesCount}</span>
            <span className="text-[10px] text-gray-600">files</span>
            <span className="text-gray-700">·</span>
            <span className="text-[11px] text-gray-300 tabular-nums">{session.toolCalls}</span>
            <span className="text-[10px] text-gray-600">tools</span>
          </div>

          {/* AI Attribution */}
          {aiPct !== null && (
            <div className={`rounded-lg px-2.5 py-1 flex items-center gap-1.5 border ${
              aiPct >= 90 ? 'bg-blue-500/10 border-blue-500/25' :
              aiPct >= 50 ? 'bg-cyan-500/10 border-cyan-500/25' :
              'bg-green-500/10 border-green-500/25'
            }`}>
              <div className="w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center" style={{
                borderColor: aiPct >= 90 ? 'rgb(96,165,250)' : aiPct >= 50 ? 'rgb(34,211,238)' : 'rgb(74,222,128)',
                background: `conic-gradient(${aiPct >= 90 ? 'rgb(96,165,250)' : aiPct >= 50 ? 'rgb(34,211,238)' : 'rgb(74,222,128)'} ${aiPct}%, transparent ${aiPct}%)`,
              }}>
                <div className="w-1.5 h-1.5 rounded-full bg-gray-900" />
              </div>
              <span className={`text-[11px] font-medium tabular-nums ${
                aiPct >= 90 ? 'text-blue-400' : aiPct >= 50 ? 'text-cyan-400' : 'text-green-400'
              }`}>{aiPct}% AI</span>
            </div>
          )}

          {/* Spacer pushes action buttons to the right */}
          <div className="ml-auto flex items-center gap-1.5">
            {/* Replay — neutral now (purple is reserved for running status) */}
            {session.promptChanges && session.promptChanges.length > 0 && (
              <button
                onClick={() => { setReplayActive(true); setReplayIndex(0); setReplayPlaying(true); }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-gray-700/50 text-gray-200 border border-gray-600/50 hover:bg-gray-700 transition-colors"
                title="Replay session step by step"
              >
                Replay
              </button>
            )}

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
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-gray-700/50 text-gray-200 border border-gray-600/50 hover:bg-gray-700 transition-colors disabled:opacity-50"
                title="Create public share link"
              >
                {sharing ? 'Sharing...' : 'Share'}
              </button>
            )}

            {/* End session — only when RUNNING */}
            {isRunning && (
              <button
                onClick={handleEnd}
                disabled={ending}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/25 hover:bg-amber-500/25 transition-colors disabled:opacity-50"
                title="End session"
              >
                {ending ? 'Ending...' : 'End'}
              </button>
            )}

            {/* Overflow menu: Export, Details, Archive, Delete */}
            <div className="relative">
              <button
                onClick={() => setShowOverflowMenu(v => !v)}
                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-300 bg-gray-700/50 border border-gray-600/50 hover:bg-gray-700 transition-colors"
                title="More actions"
                aria-label="More actions"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" /></svg>
              </button>
              {showOverflowMenu && (
                <>
                  {/* Click-outside catcher */}
                  <div className="fixed inset-0 z-40" onClick={() => setShowOverflowMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 py-1 min-w-[180px]">
                    <button
                      onClick={() => { setShowOverflowMenu(false); exportAsMarkdown(); }}
                      className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
                    >
                      Export as Markdown
                    </button>
                    <button
                      onClick={() => { setShowOverflowMenu(false); exportAsGist(); }}
                      className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
                    >
                      Export as Gist
                    </button>
                    <div className="h-px bg-gray-800 my-1" />
                    <button
                      onClick={() => { setShowOverflowMenu(false); setShowMeta(v => !v); }}
                      className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
                    >
                      {showMeta ? 'Hide details' : 'Show details'}
                    </button>
                    <button
                      onClick={() => { setShowOverflowMenu(false); handleToggleArchive(); }}
                      disabled={archiving}
                      className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-50"
                    >
                      {session.archived ? 'Unarchive' : 'Archive'}
                    </button>
                    <div className="h-px bg-gray-800 my-1" />
                    <button
                      onClick={() => { setShowOverflowMenu(false); handleDelete(); }}
                      disabled={deleting}
                      className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                    >
                      {deleting ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </>
              )}
            </div>
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

      {/* Live session watch card removed — duration pill above now ticks live with a pulsing dot. */}

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
                      href={safeHref(pr.url)}
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

          {/* Session Chain */}
          {session.chainSessions && session.chainSessions.length > 1 && (
            <div className="card space-y-2 flex-1 min-w-[250px]">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                Session Chain ({session.chainSessions.length})
              </h3>
              <div className="text-xs text-gray-400 space-y-1.5">
                {session.chainSessions.map((cs, i) => (
                  <div
                    key={cs.id}
                    className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded ${cs.id === session.id ? 'bg-indigo-500/10 border border-indigo-500/30' : 'bg-gray-800/50 hover:bg-gray-800 cursor-pointer'}`}
                    onClick={() => cs.id !== session.id && navigate(`/sessions/${cs.id}`)}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="text-gray-500 font-mono">#{i + 1}</span>
                      <span className={cs.id === session.id ? 'text-indigo-400 font-medium' : 'text-gray-300'}>
                        {cs.startedAt ? new Date(cs.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cs.status === 'RUNNING' ? 'bg-green-500/20 text-green-400' : cs.status === 'IDLE' ? 'bg-amber-500/20 text-amber-400' : 'bg-gray-700 text-gray-500'}`}>
                        {cs.status === 'RUNNING' ? 'Running' : cs.status === 'IDLE' ? 'Idle' : 'Done'}
                      </span>
                    </span>
                    <span className="text-gray-500">{formatCost(cs.costUsd)}</span>
                  </div>
                ))}
                <div className="flex justify-between pt-1 border-t border-gray-800 text-gray-500">
                  <span>Total</span>
                  <span className="text-gray-300 font-medium">
                    {formatCost(session.chainSessions.reduce((s, c) => s + c.costUsd, 0))}
                    {' · '}
                    {formatDuration(session.chainSessions.reduce((s, c) => s + c.durationMs, 0))}
                  </span>
                </div>
              </div>
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

          {/* Agent System Prompt & Version */}
          {(session.agentSystemPrompt || session.agentVersion) && (
            <div className="card space-y-2 flex-1 min-w-[250px]">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                Agent Context
                {session.agentVersion && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-400 font-normal normal-case tracking-normal">
                    v{session.agentVersion}
                  </span>
                )}
              </h3>
              {session.agentSystemPrompt && (
                <details className="group">
                  <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-300 transition-colors">
                    System Prompt <span className="text-gray-600">({session.agentSystemPrompt.length} chars)</span>
                  </summary>
                  <pre className="mt-2 text-[10px] text-gray-500 bg-gray-900/50 rounded p-2 max-h-48 overflow-auto font-mono whitespace-pre-wrap">
                    {session.agentSystemPrompt.slice(0, 5000)}
                    {session.agentSystemPrompt.length > 5000 && '\n... (truncated)'}
                  </pre>
                </details>
              )}
            </div>
          )}

          {/* Session Git Info */}
          {session.sessionDiff && (
            <div className="card space-y-2 flex-1 min-w-[250px]">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Git State</h3>
              <div className="text-xs space-y-1">
                {session.sessionDiff.headBefore && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">Before:</span>
                    <code className="text-gray-400 font-mono text-[10px] bg-gray-800 px-1.5 py-0.5 rounded">{session.sessionDiff.headBefore.slice(0, 12)}</code>
                  </div>
                )}
                {session.sessionDiff.headAfter && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">After:</span>
                    <code className="text-gray-400 font-mono text-[10px] bg-gray-800 px-1.5 py-0.5 rounded">{session.sessionDiff.headAfter.slice(0, 12)}</code>
                  </div>
                )}
                {session.sessionDiff.commitShas && session.sessionDiff.commitShas.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">Commits:</span>
                    <span className="text-gray-400">{session.sessionDiff.commitShas.length}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Main content — full width ── */}
      <div className="rounded-xl border border-gray-800/60 bg-gray-900/30 overflow-hidden flex-1 min-h-0 flex flex-col mx-6 mb-4">
        {/* Tab bar */}
        <div className="px-4 pt-1 border-b border-gray-800/60 flex-shrink-0 flex items-center gap-0">
          {([
            { key: 'session' as const, label: 'Session' },
            { key: 'blame' as const, label: 'AI Blame' },
            // Snapshots: surface the count so users discover the tab exists.
            // Per-prompt snapshots are auto-captured but the feature is
            // invisible until users notice them — the count on the tab is
            // the cheapest discoverability nudge.
            { key: 'turns' as const, label: 'Snapshots', count: session.snapshots?.length || 0, accent: 'amber' as const },
            { key: 'security' as const, label: 'Security', count: findings.length, accent: 'red' as const },
          ] as const).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`relative px-4 py-2.5 text-[13px] font-medium transition-colors ${
                activeTab === tab.key
                  ? 'text-gray-100'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
              title={tab.key === 'turns' ? 'Per-prompt snapshots — restore any past state with `origin snapshot restore`' : undefined}
            >
              {tab.label}
              {'count' in tab && tab.count > 0 && (
                <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                  ('accent' in tab && tab.accent === 'amber')
                    ? 'bg-amber-500/15 text-amber-400'
                    : 'bg-red-500/20 text-red-400'
                }`}>
                  {tab.count}
                </span>
              )}
              {activeTab === tab.key && (
                <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-indigo-500 rounded-full" />
              )}
            </button>
          ))}

          {/* Ask — positioned as a distinct action, not a tab. Indigo (reading/query accent). */}
          <button
            onClick={() => { setShowAskPanel(!showAskPanel); setAskContext(undefined); }}
            className={`ml-auto my-1 px-3 py-1 text-xs font-medium rounded-md border transition-colors flex items-center gap-1.5 ${
              showAskPanel
                ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                : 'text-gray-400 border-gray-700/40 hover:text-indigo-300 hover:border-indigo-500/30 hover:bg-indigo-500/10'
            }`}
            title="Ask questions about this session"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
            Ask
          </button>
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className={`flex-1 overflow-y-auto min-h-0 ${showAskPanel ? 'min-w-0' : ''}`}>
          {activeTab === 'session' && (
            <UnifiedSessionView
              defaultNewestFirst={true}
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
              commits={session.commits}
              repoId={session.repoId}
              snapshots={session.snapshots}
            />
          )}
          {activeTab === 'blame' && (
            <AiBlameView
              sessionId={session.id}
              filesChanged={blameFilesChanged}
              focusPromptIndex={focusPromptIndex}
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
              annotations={annotations}
              canAnnotate={!!(session.userId === user?.id || ['ADMIN', 'OWNER'].includes((activeOrg?.role || '').toUpperCase()))}
              currentUserId={user?.id}
              focusPromptIndex={focusPromptIndex}
              onAddAnnotation={async (turnIndex, text) => {
                const created = await api.createAnnotation(id!, { turnIndex, text });
                setAnnotations((prev) => [...prev, created]);
              }}
              onDeleteAnnotation={async (annotationId) => {
                await api.deleteAnnotation(id!, annotationId);
                setAnnotations((prev) => prev.filter((a) => a.id !== annotationId));
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
            <div className="w-96 border-l border-gray-800 flex-shrink-0 min-h-0 overflow-hidden">
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
        <div className="bg-green-900/20 border border-green-800/30 rounded-lg px-4 py-3 flex items-center justify-between flex-shrink-0 mx-6 mb-3">
          <p className="text-sm text-green-400">{reviewFeedback}</p>
          <button
            onClick={() => setReviewFeedback('')}
            className="text-green-600 hover:text-green-400 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Review bar — admins of a team org only. Solo devs see no bar
          (own work, no review queue); team members see the session but
          can't dispose — disposition is an admin call. */}
      {canReview && (!session.review || session.review.isAutoReview) && (
        <div className="rounded-xl border border-white/[0.06] bg-gray-900/40 p-3 flex-shrink-0 mx-6 mb-4">
          <div className="flex flex-col lg:flex-row gap-3 lg:items-center">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.12em] whitespace-nowrap">
                {session.review?.isAutoReview ? 'Override AI' : 'Review'}
              </span>
              <input
                type="text"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="Add a note (optional)…"
                className="flex-1 bg-transparent border-0 outline-none text-sm text-gray-200 placeholder-gray-600 focus:placeholder-gray-500 transition-colors"
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* AI Review — primary "smart" action, soft gradient pill */}
              <button
                onClick={handleAIReview}
                disabled={aiReviewLoading || submitting}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3.5 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-400 hover:to-purple-400 text-white shadow-sm shadow-purple-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                title="Run AI scoring on this session"
              >
                {aiReviewLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
                    Scoring…
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    {session.review?.isAutoReview ? 'Re-run AI' : 'AI Review'}
                  </>
                )}
              </button>

              {/* Visual divider between AI and manual actions */}
              <span className="hidden sm:block w-px h-5 bg-white/[0.08] mx-0.5" />

              {/* Manual disposition — outline style with type-tinted border */}
              <ReviewActionButton
                label="Approve"
                icon={<Check className="w-3.5 h-3.5" />}
                color="emerald"
                onClick={() => handleReview('approved')}
                disabled={submitting}
              />
              <ReviewActionButton
                label="Reject"
                icon={<XIcon className="w-3.5 h-3.5" />}
                color="red"
                onClick={() => handleReview('rejected')}
                disabled={submitting}
              />
              <ReviewActionButton
                label="Flag"
                icon={<Flag className="w-3.5 h-3.5" />}
                color="amber"
                onClick={() => handleReview('flagged')}
                disabled={submitting}
              />
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
