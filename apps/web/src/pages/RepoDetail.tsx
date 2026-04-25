import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import type { Repo, CommitDiff, RepoHealth } from '../api';
import WebhookSettings from '../components/WebhookSettings';
import ScoreGauge from '../components/ScoreGauge';
import { timeAgo } from '../utils';
import { safeHref } from '../utils/safe-url';
import { PageHeader, Pill, PulseDot, ActionButtonGroup } from '../components/ui';

interface PromptChangeData {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  diff: string;
}

interface Commit {
  id: string;
  repoId: string;
  sha: string;
  message: string;
  author: string;
  branch: string | null;
  aiToolDetected: string | null;
  aiDetectionMethod: string | null;
  additions: number | null;
  deletions: number | null;
  fileCount: number | null;
  committedAt: string;
  createdAt: string;
  session: {
    id: string;
    model: string;
    agent?: { id: string; slug: string; name: string } | null;
    filesChanged: string;
    tokensUsed: number;
    toolCalls: number;
    durationMs: number;
    linesAdded: number;
    linesRemoved: number;
    costUsd: number;
    reviewed?: boolean;
    review?: { status: string } | null;
    promptChanges?: PromptChangeData[];
  } | null;
}

// ─── Diff helpers ──────────────────────────────────────────────

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return <div className="bg-green-950/40 text-green-300 px-4 py-0 font-mono text-xs whitespace-pre">{line}</div>;
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return <div className="bg-red-950/40 text-red-300 px-4 py-0 font-mono text-xs whitespace-pre">{line}</div>;
  }
  if (line.startsWith('@@')) {
    return <div className="bg-indigo-950/30 text-indigo-400 px-4 py-0.5 font-mono text-xs whitespace-pre border-t border-gray-800">{line}</div>;
  }
  return <div className="text-gray-400 px-4 py-0 font-mono text-xs whitespace-pre">{line}</div>;
}

function FileStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    added: 'bg-green-900/30 text-green-400 border-green-800',
    modified: 'bg-yellow-900/30 text-yellow-400 border-yellow-800',
    removed: 'bg-red-900/30 text-red-400 border-red-800',
    renamed: 'bg-blue-900/30 text-blue-400 border-blue-800',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${styles[status] || 'bg-gray-900/30 text-gray-400 border-gray-700'}`}>
      {status}
    </span>
  );
}

// Shorten long file paths
function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-3).join('/');
}

// Count lines added/removed in a diff string
function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

// ─── Prompt Card Component ──────────────────────────────────────────────

function PromptCard({ pc, index }: { pc: PromptChangeData; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const stats = useMemo(() => countDiffStats(pc.diff), [pc.diff]);
  const diffLines = useMemo(() => pc.diff ? pc.diff.split('\n').filter(Boolean) : [], [pc.diff]);
  const hasDiff = diffLines.length > 0;

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      {/* Prompt header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-800/30 transition-colors text-left"
      >
        {/* Number badge */}
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-600/20 text-indigo-400 flex items-center justify-center text-xs font-bold mt-0.5">
          {index + 1}
        </span>

        <div className="flex-1 min-w-0">
          {/* Prompt text */}
          <p className={`text-sm text-gray-200 ${expanded ? '' : 'line-clamp-2'}`}>
            {pc.promptText || '(empty prompt)'}
          </p>

          {/* Quick stats */}
          <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
            <span>{pc.filesChanged.length} file{pc.filesChanged.length !== 1 ? 's' : ''}</span>
            {stats.added > 0 && <span className="text-green-400">+{stats.added}</span>}
            {stats.removed > 0 && <span className="text-red-400">-{stats.removed}</span>}
          </div>
        </div>

        <span className="text-gray-500 text-xs mt-1 flex-shrink-0">
          {expanded ? '▼' : '▶'}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-gray-800">
          {/* Files changed list */}
          {pc.filesChanged.length > 0 && (
            <div className="px-4 py-2 bg-gray-800/20">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">Files changed</p>
              <div className="flex flex-wrap gap-1.5">
                {pc.filesChanged.map((file, i) => (
                  <span key={i} className="text-xs font-mono text-gray-400 bg-gray-800/60 px-2 py-0.5 rounded">
                    {shortenPath(file)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Diff toggle */}
          {hasDiff && (
            <div className="border-t border-gray-800">
              <button
                onClick={(e) => { e.stopPropagation(); setShowDiff(!showDiff); }}
                className="w-full px-4 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800/30 transition-colors text-left flex items-center gap-2"
              >
                <span>{showDiff ? '▼' : '▶'}</span>
                <span>{showDiff ? 'Hide' : 'Show'} code changes</span>
                <span className="text-gray-600">({diffLines.length} lines)</span>
              </button>

              {showDiff && (
                <div className="overflow-x-auto bg-gray-950/30 max-h-[400px] overflow-y-auto">
                  <pre className="text-xs leading-5">
                    {diffLines.map((line, i) => {
                      let className = 'px-4 ';
                      if (line.startsWith('@@')) className += 'bg-blue-900/20 text-blue-400';
                      else if (line.startsWith('+') && !line.startsWith('+++')) className += 'bg-green-900/20 text-green-300';
                      else if (line.startsWith('-') && !line.startsWith('---')) className += 'bg-red-900/20 text-red-300';
                      else className += 'text-gray-500';
                      return <div key={i} className={className}>{line}</div>;
                    })}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Commit Diff Modal ──────────────────────────────────────────────

type ModalTab = 'changes' | 'prompts';

function CommitDiffModal({
  diff,
  loading,
  error,
  onClose,
  commit,
}: {
  diff: CommitDiff | null;
  loading: boolean;
  error: string;
  onClose: () => void;
  commit: Commit;
}) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const promptChanges = commit.session?.promptChanges || [];
  const hasPrompts = promptChanges.length > 0;
  const isAICommit = !!commit.session || !!commit.aiToolDetected;
  const [activeTab, setActiveTab] = useState<ModalTab>(hasPrompts ? 'prompts' : 'changes');

  // Auto-expand first 3 files on load
  useEffect(() => {
    if (diff?.files) {
      const initial = new Set(diff.files.slice(0, 3).map(f => f.filename));
      setExpandedFiles(initial);
    }
  }, [diff]);

  const toggleFile = (filename: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const expandAll = () => {
    if (diff?.files) setExpandedFiles(new Set(diff.files.map(f => f.filename)));
  };

  const collapseAll = () => setExpandedFiles(new Set());

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 px-4">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 mb-1">
              <code className="text-sm text-indigo-400 bg-indigo-950/30 px-2 py-0.5 rounded font-mono">
                {commit.sha.slice(0, 7)}
              </code>
              {commit.session ? (
                <span className="badge-blue text-xs">
                  {commit.session.agent?.slug || commit.session.agent?.name || commit.session.model}
                </span>
              ) : commit.aiToolDetected ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400 border border-dashed border-purple-500/40">
                  {commit.aiToolDetected}
                  <span className="text-[9px] opacity-60">detected</span>
                </span>
              ) : (
                <span className="badge-gray text-xs">Human</span>
              )}
              {diff?.htmlUrl && (
                <a
                  href={safeHref(diff.htmlUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gray-500 hover:text-indigo-400 transition-colors"
                >
                  View on GitHub &rarr;
                </a>
              )}
            </div>
            <p className="text-gray-200 text-sm font-medium truncate">{commit.message}</p>
            <p className="text-xs text-gray-500 mt-1">
              {commit.author} &middot; {new Date(commit.committedAt).toLocaleString()}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors ml-4 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Tab bar — show for all AI commits */}
        {isAICommit && (
          <div className="flex items-center gap-1 px-6 py-2 border-b border-gray-800 flex-shrink-0">
            <button
              onClick={() => setActiveTab('prompts')}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                activeTab === 'prompts'
                  ? 'bg-indigo-600/20 text-indigo-400'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}
            >
              AI Prompts
              {hasPrompts && (
                <span className="ml-1.5 bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded text-[10px]">
                  {promptChanges.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('changes')}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                activeTab === 'changes'
                  ? 'bg-indigo-600/20 text-indigo-400'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}
            >
              Code Changes
              {diff && (
                <span className="ml-1.5 bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded text-[10px]">
                  {diff.files.length}
                </span>
              )}
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* ─── Prompts Tab ─── */}
          {activeTab === 'prompts' && (
            <div className="px-6 py-4 space-y-3">
              {hasPrompts ? (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-500">
                      {promptChanges.length} prompt{promptChanges.length !== 1 ? 's' : ''} produced this commit
                    </p>
                    {commit.session && (
                      <Link
                        to={`/sessions/${commit.session.id}`}
                        className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        Full session &rarr;
                      </Link>
                    )}
                  </div>

                  {promptChanges.map((pc, i) => (
                    <PromptCard key={pc.promptIndex} pc={pc} index={i} />
                  ))}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-4">
                    <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
                  </div>
                  <p className="text-sm text-gray-400 font-medium mb-1">No prompt data available</p>
                  <p className="text-xs text-gray-600 max-w-sm">
                    This commit was detected as AI-generated{commit.aiToolDetected ? ` (${commit.aiToolDetected})` : ''}, but no session was captured.
                    Use the Origin CLI to record sessions and see which prompts produce each commit.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ─── Changes Tab ─── */}
          {activeTab === 'changes' && (
            <>
              {loading && (
                <div className="flex items-center justify-center py-16">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
                </div>
              )}

              {error && (
                <div className="px-6 py-12 text-center">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              {diff && !loading && (
                <>
                  {/* Stats bar */}
                  <div className="px-6 py-3 border-b border-gray-800 flex items-center gap-4 text-xs flex-wrap">
                    <span className="text-gray-400">
                      <span className="font-medium text-gray-200">{diff.files.length}</span> file{diff.files.length !== 1 ? 's' : ''} changed
                    </span>
                    {diff.stats.additions > 0 && (
                      <span className="text-green-400">+{diff.stats.additions}</span>
                    )}
                    {diff.stats.deletions > 0 && (
                      <span className="text-red-400">{'\u2212'}{diff.stats.deletions}</span>
                    )}
                    <div className="flex-1" />
                    <button onClick={expandAll} className="text-gray-500 hover:text-gray-300 transition-colors">
                      Expand all
                    </button>
                    <button onClick={collapseAll} className="text-gray-500 hover:text-gray-300 transition-colors">
                      Collapse all
                    </button>
                  </div>

                  {diff.files.length === 0 && (
                    <div className="px-6 py-12 text-center text-gray-500 text-sm">
                      No file changes available for this commit.
                      {diff.htmlUrl && (
                        <a
                          href={safeHref(diff.htmlUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block mt-2 text-indigo-400 hover:text-indigo-300"
                        >
                          View on GitHub &rarr;
                        </a>
                      )}
                    </div>
                  )}

                  {/* File diffs */}
                  <div className="divide-y divide-gray-800">
                    {diff.files.map((file) => {
                      const isExpanded = expandedFiles.has(file.filename);
                      const lines = file.patch ? file.patch.split('\n') : [];

                      return (
                        <div key={file.filename}>
                          {/* File header */}
                          <button
                            onClick={() => toggleFile(file.filename)}
                            className="w-full flex items-center gap-3 px-6 py-2.5 hover:bg-gray-800/30 transition-colors text-left"
                          >
                            <span className="text-gray-500 text-xs transition-transform" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none' }}>
                              &#9654;
                            </span>
                            <FileStatusBadge status={file.status} />
                            <span className="text-sm text-gray-300 font-mono truncate flex-1">
                              {file.filename}
                              {file.previousFilename && (
                                <span className="text-gray-600"> &larr; {file.previousFilename}</span>
                              )}
                            </span>
                            <span className="text-xs text-gray-500 flex-shrink-0">
                              {file.additions > 0 && <span className="text-green-400">+{file.additions}</span>}
                              {file.additions > 0 && file.deletions > 0 && ' '}
                              {file.deletions > 0 && <span className="text-red-400">{'\u2212'}{file.deletions}</span>}
                            </span>
                          </button>

                          {/* Diff content */}
                          {isExpanded && (
                            <div className="bg-gray-950/50 border-t border-gray-800 overflow-x-auto">
                              {lines.length > 0 ? (
                                lines.map((line, i) => <DiffLine key={i} line={line} />)
                              ) : (
                                <div className="px-4 py-3 text-xs text-gray-600 italic">
                                  {file.status === 'renamed' ? 'File renamed (no content changes)' : 'Binary file or no patch available'}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer with session link */}
        {commit.session && !isAICommit && (
          <div className="px-6 py-3 border-t border-gray-800 flex-shrink-0">
            <Link
              to={`/sessions/${commit.session.id}`}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              View AI session details &rarr;
            </Link>
          </div>
        )}
      </div>
    </div>
  );
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

type RepoTab = 'commits' | 'sessions';

export default function RepoDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [repo, setRepo] = useState<Repo | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [commitSearch, setCommitSearch] = useState('');
  // Repo-level sub-tab. Persists across reloads via localStorage so refreshing
  // on the Sessions view doesn't bounce the user back to Commits.
  const [repoTab, setRepoTab] = useState<RepoTab>(() => {
    try {
      const saved = localStorage.getItem('origin:repo-tab') as RepoTab | null;
      if (saved === 'commits' || saved === 'sessions') return saved;
    } catch { /* ignore */ }
    return 'commits';
  });
  useEffect(() => {
    try { localStorage.setItem('origin:repo-tab', repoTab); } catch { /* ignore */ }
  }, [repoTab]);
  // Sessions tab data — fetched lazily when user opens it.
  const [repoSessions, setRepoSessions] = useState<import('../api').Session[]>([]);
  const [repoSessionsLoading, setRepoSessionsLoading] = useState(false);

  // Branch filter
  const [branches, setBranches] = useState<string[]>([]);
  const [branchFilter, setBranchFilter] = useState<string>('');

  // Sync & rescan states
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [webhookOpen, setWebhookOpen] = useState(false);

  // Health
  const [health, setHealth] = useState<RepoHealth | null>(null);


  // Diff modal states
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null);
  const [diff, setDiff] = useState<CommitDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');

  const fetchData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [repos, commitData, branchData] = await Promise.all([
        api.getRepos(),
        api.getRepoCommits(id, branchFilter || undefined),
        api.getRepoBranches(id),
      ]);
      const found = repos.find((r) => r.id === id) || null;
      setRepo(found);
      setCommits(commitData as Commit[]);
      setBranches(branchData.branches.filter(Boolean));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // Fetch health score and access control separately (non-blocking)
    api.getRepoHealth(id).then(setHealth).catch(() => {});
  }, [id, branchFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-sync on mount if the repo hasn't been synced recently.
  // Provider-backed repos (github/gitlab) re-pull silently in the background.
  useEffect(() => {
    if (!id || !repo) return;
    // Only auto-pull for repos whose integration is actually connected.
    const eff = repo.effectiveProvider ?? repo.provider;
    if (eff !== 'github' && eff !== 'gitlab') return;
    const STALE_MS = 5 * 60 * 1000; // 5 min
    const lastSync = repo.syncedAt ? new Date(repo.syncedAt).getTime() : 0;
    if (Date.now() - lastSync < STALE_MS) return;
    setSyncing(true);
    api
      .syncRepo(id)
      .then(() => fetchData())
      .catch(() => {})
      .finally(() => setSyncing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, repo?.id]);

  const handleSync = async () => {
    if (!id) return;
    setSyncing(true);
    setSyncMsg('');
    try {
      const result = await api.syncRepo(id);
      setSyncMsg(`Synced ${result.synced} new commits (${result.total} total)`);
      fetchData();
    } catch (err: any) {
      setSyncMsg(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleRescan = async () => {
    if (!id) return;
    setRescanning(true);
    setSyncMsg('');
    try {
      const result = await api.rescanRepoCommits(id);
      setSyncMsg(`Rescanned: ${result.updated} commits updated (${result.githubMessages} fetched from GitHub)`);
      fetchData();
    } catch (err: any) {
      setSyncMsg(`Rescan failed: ${err.message}`);
    } finally {
      setRescanning(false);
    }
  };

  const handleImportSessions = async () => {
    if (!id) return;
    setImporting(true);
    setSyncMsg('');
    try {
      const result = await api.importSessionsFromBranch(id);
      setSyncMsg(`Imported ${result.imported} sessions (${result.skipped} skipped, ${result.total} total in branch)`);
      fetchData();
    } catch (err: any) {
      setSyncMsg(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  const openDiff = async (commit: Commit) => {
    if (!id) return;
    setSelectedCommit(commit);
    setDiff(null);
    setDiffError('');
    setDiffLoading(true);
    try {
      const result = await api.getCommitDiff(id, commit.sha);
      setDiff(result);
    } catch (err: any) {
      setDiffError(err.message || 'Failed to load diff');
    } finally {
      setDiffLoading(false);
    }
  };

  const closeDiff = () => {
    setSelectedCommit(null);
    setDiff(null);
    setDiffError('');
  };

  // Close modal on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedCommit) closeDiff();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedCommit]);

  // Lazy-load sessions for this repo when the user opens the Sessions tab.
  // Re-fetches if they switch away and back, since session activity is live.
  useEffect(() => {
    if (repoTab !== 'sessions' || !id) return;
    setRepoSessionsLoading(true);
    api.getSessions({ repoId: id, limit: '100' } as any)
      .then((data) => setRepoSessions(data?.sessions || []))
      .catch(() => setRepoSessions([]))
      .finally(() => setRepoSessionsLoading(false));
  }, [repoTab, id]);

  const isAI = (c: any) => c.session !== null || c.aiToolDetected !== null;

  // Apply free-text search across commit message, sha, and author
  const searchedCommits = useMemo(() => {
    const q = commitSearch.trim().toLowerCase();
    if (!q) return commits;
    return commits.filter((c) =>
      c.message.toLowerCase().includes(q) ||
      c.sha.toLowerCase().includes(q) ||
      c.author.toLowerCase().includes(q)
    );
  }, [commits, commitSearch]);

  // Group commits by local calendar date (today, yesterday, full date)
  const commitsByDate = useMemo(() => {
    const groups = new Map<string, { label: string; items: Commit[] }>();
    const now = new Date();
    const todayKey = now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = yesterday.toDateString();
    for (const c of searchedCommits) {
      const d = new Date(c.committedAt);
      const key = d.toDateString();
      let label: string;
      if (key === todayKey) label = 'Today';
      else if (key === yesterdayKey) label = 'Yesterday';
      else {
        label = d.toLocaleDateString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
          year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
        });
      }
      if (!groups.has(key)) groups.set(key, { label, items: [] });
      groups.get(key)!.items.push(c);
    }
    // Sort groups by most recent date first
    return Array.from(groups.entries())
      .sort((a, b) => new Date(b[1].items[0].committedAt).getTime() - new Date(a[1].items[0].committedAt).getTime())
      .map(([key, value]) => ({ key, ...value }));
  }, [searchedCommits]);

  const aiCount = commits.filter(isAI).length;
  const humanCount = commits.filter((c) => !isAI(c)).length;

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

  // Use server-computed effectiveProvider so a repo whose integration isn't
  // connected (e.g. github.com path but no GitHub token on the org) renders
  // as "local" everywhere in this view — icon, badge, and webhook section.
  const effProvider: 'github' | 'gitlab' | 'local' =
    repo.effectiveProvider ?? (repo.provider as 'github' | 'gitlab' | 'local');

  const providerIcon =
    effProvider === 'github' ? (
      <svg className="w-5 h-5 text-gray-300" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
    ) : effProvider === 'gitlab' ? (
      <svg className="w-5 h-5 text-orange-400" viewBox="0 0 32 32" fill="currentColor">
        <path d="M16 28.896L21.323 12.576H10.677L16 28.896Z" />
        <path d="M16 28.896L10.677 12.576H2.867L16 28.896Z" opacity="0.7" />
        <path d="M2.867 12.576H10.677L7.334 2.279C7.155 1.736 6.393 1.736 6.214 2.279L2.867 12.576Z" />
        <path d="M16 28.896L21.323 12.576H29.133L16 28.896Z" opacity="0.7" />
        <path d="M29.133 12.576H21.323L24.666 2.279C24.845 1.736 25.607 1.736 25.786 2.279L29.133 12.576Z" />
      </svg>
    ) : (
      <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
      </svg>
    );

  const aiPct = health?.aiPercentage ?? (commits.length > 0 ? (aiCount / commits.length) * 100 : 0);

  const handleToggleVerbose = async () => {
    if (!repo) return;
    const next = !repo.verboseCapture;
    try {
      const updated = await api.updateRepo(repo.id, { verboseCapture: next });
      setRepo((r) => (r ? { ...r, verboseCapture: updated.verboseCapture } : r));
      setSyncMsg(next ? 'Verbose capture enabled' : 'Verbose capture disabled');
      setTimeout(() => setSyncMsg(''), 3000);
    } catch {
      setSyncMsg('Failed to update verbose capture');
    }
  };

  const overflowItems = [
    {
      label: syncing ? 'Syncing…' : 'Resync now',
      description: 'Pull the latest commits and branch list from the provider.',
      onClick: handleSync,
      disabled: syncing || rescanning,
    },
    {
      label: rescanning ? 'Rescanning…' : 'Rescan AI attribution',
      description: 'Re-run the AI-vs-human classifier over this repo\u2019s commit history.',
      onClick: handleRescan,
      disabled: syncing || rescanning,
    },
    ...(effProvider === 'github'
      ? [
          {
            label: importing ? 'Importing…' : 'Import sessions from branch',
            description: 'Pull AI sessions recorded on a specific branch into this repo.',
            onClick: handleImportSessions,
            disabled: syncing || rescanning || importing,
          },
          { divider: true },
          {
            label: 'GitHub webhook…',
            description: 'Optional: real-time push updates instead of polling.',
            onClick: () => setWebhookOpen(true),
          },
        ]
      : []),
    { divider: true },
    {
      label: `Verbose capture: ${repo.verboseCapture ? 'on' : 'off'}`,
      description: repo.verboseCapture
        ? 'Click to disable. Full tool inputs + outputs are being stored.'
        : 'Click to enable. Captures full tool inputs and result bodies in session transcripts.',
      onClick: handleToggleVerbose,
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        breadcrumb={[{ label: 'Repositories', to: '/repos' }, { label: repo.name }]}
        title={
          <div className="flex items-center gap-2.5 min-w-0">
            {providerIcon}
            <h1 className="text-xl font-semibold text-gray-100 tracking-tight leading-tight truncate">{repo.name}</h1>
            <Pill variant="neutral" size="sm">{effProvider}</Pill>
          </div>
        }
        subtitle={
          <span className="flex items-center gap-2">
            <span className="font-mono truncate">{repo.path}</span>
            <span>·</span>
            {syncing ? (
              <span className="flex items-center gap-1 text-indigo-400">
                <div className="animate-spin rounded-full h-2 w-2 border-b border-indigo-400" />
                syncing…
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <span className="w-1 h-1 rounded-full bg-emerald-500/80" />
                {repo.syncedAt ? timeAgo(repo.syncedAt) : 'never synced'}
              </span>
            )}
          </span>
        }
        meta={
          <>
            {health && (
              <Pill
                variant={health.healthScore >= 80 ? 'success' : health.healthScore >= 50 ? 'warning' : 'error'}
              >
                Health {health.healthScore}
              </Pill>
            )}
            <Pill variant="neutral">Total {commits.length}</Pill>
            <Pill variant="ai">AI {aiCount} ({aiPct.toFixed(0)}%)</Pill>
            <Pill variant="neutral">Human {humanCount}</Pill>
          </>
        }
        actions={
          <ActionButtonGroup
            secondary={[
              { label: 'Issues', onClick: () => navigate(`/repos/${repo.id}/issues`) },
            ]}
            overflow={overflowItems}
          />
        }
      />

      {/* Authorship is in the header pills; only keep transient sync feedback here. */}
      {syncMsg && (
        <div className={`text-[11px] ${syncMsg.startsWith('Sync failed') ? 'text-red-400' : 'text-emerald-400'}`}>
          {syncMsg}
        </div>
      )}

      {/* Repo-level tabs — Commits / Sessions. */}
      <div className="flex items-center gap-0 border-b border-gray-800/60">
        {([
          { key: 'commits' as const, label: 'Commits', count: commits.length },
          { key: 'sessions' as const, label: 'Sessions' },
        ] as Array<{ key: RepoTab; label: string; count?: number }>).map((t) => (
          <button
            key={t.key}
            onClick={() => setRepoTab(t.key)}
            className={`relative px-4 py-2 text-[13px] font-medium transition-colors ${
              repoTab === t.key
                ? 'text-gray-100'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
            {typeof t.count === 'number' && (
              <span className={`ml-1.5 text-[10px] font-mono ${repoTab === t.key ? 'text-indigo-400' : 'text-gray-600'}`}>
                {t.count}
              </span>
            )}
            {repoTab === t.key && (
              <div className="absolute bottom-[-1px] left-2 right-2 h-[2px] bg-indigo-500 rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Sessions tab — sessions filtered to this repo */}
      {repoTab === 'sessions' && (
        <div className="card p-0 overflow-hidden">
          {repoSessionsLoading ? (
            <div className="p-6 text-center text-gray-500 text-sm">Loading sessions…</div>
          ) : repoSessions.length === 0 ? (
            <div className="p-6 text-center text-gray-500 text-sm">No sessions for this repo yet.</div>
          ) : (
            <div className="divide-y divide-gray-800/40">
              {repoSessions.map((s) => (
                <Link
                  key={s.id}
                  to={`/sessions/${s.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/30 transition-colors"
                >
                  <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${
                    s.status === 'RUNNING' ? 'bg-emerald-500/15 text-emerald-300' :
                    s.status === 'IDLE' ? 'bg-amber-500/15 text-amber-300' :
                    'bg-gray-700/40 text-gray-400'
                  }`}>
                    {s.status?.toLowerCase()}
                  </span>
                  <span className="text-[12px] text-gray-300 truncate flex-1">
                    {s.agentName || s.model}
                  </span>
                  {s.branch && (
                    <span className="text-[10px] font-mono text-gray-500 hidden sm:inline">{s.branch}</span>
                  )}
                  <span className="text-[11px] text-gray-500 font-mono whitespace-nowrap">
                    ${s.costUsd.toFixed(2)}
                  </span>
                  <span className="text-[11px] text-gray-600 whitespace-nowrap">
                    {timeAgo(s.startedAt || s.createdAt)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Commits tab — single list, AI/Human shown inline as tags */}
      {repoTab === 'commits' && (
      <>

      {/* Branch selector */}
      <div className="flex gap-2 flex-wrap items-center">
        {/* Branch filter dropdown */}
        {branches.length > 0 && (
          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="px-2.5 py-1 rounded-lg text-xs font-medium bg-gray-900/50 text-gray-300 border border-gray-800 hover:text-gray-200 transition-colors appearance-none cursor-pointer pr-7"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%239ca3af' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        )}
      </div>


      {/* Commits — Snapshots-style date-grouped list */}
      <div className="card p-0 overflow-hidden">
        {/* Search header */}
        <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-3">
          <div className="relative flex-1 max-w-xl">
            <svg
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 106.15 6.15a7.5 7.5 0 0010.5 10.5z" />
            </svg>
            <input
              type="text"
              value={commitSearch}
              onChange={(e) => setCommitSearch(e.target.value)}
              placeholder="Search commits, SHA, or author…"
              className="w-full bg-transparent border-0 pl-7 pr-2 py-1 text-sm text-gray-200 placeholder-gray-600 focus:outline-none"
            />
          </div>
          <div className="text-[11px] text-gray-600 whitespace-nowrap ml-auto">
            {searchedCommits.length} commit{searchedCommits.length === 1 ? '' : 's'}
          </div>
        </div>

        {/* Date-grouped commits */}
        {searchedCommits.length === 0 ? (
          <div className="px-6 py-16 text-center text-gray-600 text-sm">
            {commitSearch ? 'No commits match your search.' : 'No commits match this filter.'}
          </div>
        ) : (
          <div>
            {commitsByDate.map((group) => (
              <div key={group.key}>
                {/* Date header */}
                <div className="px-4 py-1.5 border-y border-gray-800/80 bg-gray-900/60 flex items-center justify-between sticky top-0 z-10 backdrop-blur">
                  <p className="text-[11px] text-gray-400 font-medium">{group.label}</p>
                  <p className="text-[10px] text-gray-600 tabular-nums">
                    {group.items.length} commit{group.items.length === 1 ? '' : 's'}
                  </p>
                </div>

                {/* Commit rows */}
                <div className="divide-y divide-gray-800/40">
                  {group.items.map((commit) => {
                    const promptCount = commit.session?.promptChanges?.length || 0;
                    const sessionFilesCount = (() => {
                      try {
                        return commit.session ? JSON.parse(commit.session.filesChanged).length : 0;
                      } catch {
                        return 0;
                      }
                    })();
                    const fileCount = commit.fileCount ?? sessionFilesCount ?? 0;
                    const additions = commit.additions ?? commit.session?.linesAdded ?? null;
                    const deletions = commit.deletions ?? commit.session?.linesRemoved ?? null;
                    const firstLine = commit.message.split('\n')[0];
                    const isAiCommit = !!commit.session || !!commit.aiToolDetected;

                    return (
                      <div
                        key={commit.id}
                        onClick={() => navigate(`/repos/${id}/commits/${commit.sha}`)}
                        className="group flex items-center gap-3 px-4 py-1.5 hover:bg-gray-800/30 transition-colors cursor-pointer"
                      >
                        {/* SHA */}
                        <code className="text-[11px] text-gray-500 font-mono w-14 flex-shrink-0 tabular-nums">
                          {commit.sha.slice(0, 7)}
                        </code>

                        {/* Message + badges */}
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <p className="text-sm text-gray-200 truncate group-hover:text-white transition-colors">
                            {firstLine}
                          </p>
                          {isAiCommit && (
                            <span
                              className={`flex-shrink-0 text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                                commit.session
                                  ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/30'
                                  : 'bg-purple-500/10 text-purple-400 border border-dashed border-purple-500/40'
                              }`}
                            >
                              {/* Prefer the agent slug/name over the raw model string —
                                  the model (e.g. "gemini-3-flash-preview") is an
                                  implementation detail; the agent ("claude-code",
                                  "cursor", etc.) is what the user cares about. */}
                              {commit.session
                                ? (commit.session.agent?.slug || commit.session.agent?.name || commit.session.model)
                                : commit.aiToolDetected}
                            </span>
                          )}
                          {promptCount > 0 && (
                            <span
                              className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] text-indigo-400"
                              title={`${promptCount} AI prompts produced this commit`}
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                              </svg>
                              {promptCount}
                            </span>
                          )}
                        </div>

                        {/* +/- stats */}
                        <div className="flex items-center gap-1.5 text-xs font-mono flex-shrink-0 w-24 justify-end">
                          {additions !== null && additions > 0 && (
                            <span className="text-emerald-400">+{additions}</span>
                          )}
                          {additions !== null && deletions !== null && (additions > 0 || deletions > 0) && (
                            <span className="text-gray-700">/</span>
                          )}
                          {deletions !== null && deletions > 0 && (
                            <span className="text-red-400">−{deletions}</span>
                          )}
                          {(additions === null || additions === 0) && (deletions === null || deletions === 0) && (
                            <span className="text-gray-700 text-[10px]">—</span>
                          )}
                        </div>

                        {/* File count */}
                        <div className="text-[11px] text-gray-500 w-14 text-right flex-shrink-0">
                          {fileCount > 0 ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : '—'}
                        </div>

                        {/* Author (hidden on narrow screens) */}
                        <div className="hidden xl:block text-[11px] text-gray-500 truncate w-32 text-right flex-shrink-0">
                          {commit.author}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </>
      )}

      {/* Diff Modal */}
      {selectedCommit && (
        <CommitDiffModal
          diff={diff}
          loading={diffLoading}
          error={diffError}
          onClose={closeDiff}
          commit={selectedCommit}
        />
      )}

      {/* Webhook setup modal — lives in the "⋯" menu so it doesn't eat
          page space when the user isn't configuring it. */}
      {webhookOpen && effProvider === 'github' && id && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setWebhookOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-gray-800 bg-gray-950 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-gray-100">GitHub webhook</h3>
              <button
                onClick={() => setWebhookOpen(false)}
                className="text-gray-500 hover:text-gray-200 text-xs"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="p-4">
              <WebhookSettings repoId={id} defaultExpanded />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
