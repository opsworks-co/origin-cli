import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import type { Repo, CommitDiff } from '../api';
import WebhookSettings from '../components/WebhookSettings';

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
    promptChanges?: PromptChangeData[];
  } | null;
}

type Filter = 'all' | 'ai' | 'human' | 'unreviewed';

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
                <span className="badge-blue text-xs">{commit.session.model}</span>
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
                  href={diff.htmlUrl}
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
                          href={diff.htmlUrl}
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

  // Branch filter
  const [branches, setBranches] = useState<string[]>([]);
  const [branchFilter, setBranchFilter] = useState<string>('');

  // Sync & rescan states
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const [importing, setImporting] = useState(false);

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
  }, [id, branchFilter]);

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

  const isAI = (c: any) => c.session !== null || c.aiToolDetected !== null;

  const filteredCommits = commits.filter((c) => {
    switch (filter) {
      case 'ai':
        return isAI(c);
      case 'human':
        return !isAI(c);
      case 'unreviewed':
        return c.session !== null && !c.session.review;
      default:
        return true;
    }
  });

  const aiCount = commits.filter(isAI).length;
  const humanCount = commits.filter((c) => !isAI(c)).length;
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
          <button onClick={handleSync} disabled={syncing || rescanning} className="btn-primary text-sm">
            {syncing ? (
              <span className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
                Syncing...
              </span>
            ) : (
              'Sync Now'
            )}
          </button>
          <button onClick={handleRescan} disabled={syncing || rescanning} className="text-sm px-3 py-1.5 rounded-lg bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 border border-purple-500/30 transition-colors">
            {rescanning ? (
              <span className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-purple-400" />
                Scanning...
              </span>
            ) : (
              'Rescan AI'
            )}
          </button>
          {repo?.provider === 'github' && (
            <button
              onClick={handleImportSessions}
              disabled={syncing || rescanning || importing}
              className="text-sm px-3 py-1.5 rounded-lg bg-green-600/20 text-green-400 hover:bg-green-600/30 border border-green-500/30 transition-colors"
            >
              {importing ? (
                <span className="flex items-center gap-2">
                  <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-green-400" />
                  Importing...
                </span>
              ) : (
                'Import Sessions'
              )}
            </button>
          )}
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
      <div className="flex gap-2 flex-wrap items-center">
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

        {/* Branch filter dropdown */}
        {branches.length > 0 && (
          <>
            <div className="w-px h-6 bg-gray-700 mx-1" />
            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-800 text-gray-300 border border-gray-700 hover:text-gray-200 transition-colors appearance-none cursor-pointer pr-8"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%239ca3af' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Webhooks Section */}
      {repo.provider === 'github' && (
        <div className="card">
          <WebhookSettings repoId={id!} />
        </div>
      )}

      {/* Commits List */}
      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-800 flex items-center justify-between">
          <p className="text-xs text-gray-500">Click any commit to view code changes and AI prompts</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">SHA</th>
                <th className="px-6 py-3 font-medium">Message</th>
                <th className="px-6 py-3 font-medium">Branch</th>
                <th className="px-6 py-3 font-medium">Author</th>
                <th className="px-6 py-3 font-medium text-center">Prompts</th>
                <th className="px-6 py-3 font-medium text-right">Files</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium text-center">Session</th>
                <th className="px-6 py-3 font-medium text-right">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {filteredCommits.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-6 py-12 text-center text-gray-500">
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
                  const promptCount = commit.session?.promptChanges?.length || 0;

                  return (
                    <tr
                      key={commit.id}
                      onClick={() => openDiff(commit)}
                      className="hover:bg-gray-800/30 transition-colors cursor-pointer"
                    >
                      <td className="px-6 py-3">
                        {commit.session ? (
                          <span className="badge-blue text-xs">{commit.session.model}</span>
                        ) : commit.aiToolDetected ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400 border border-dashed border-purple-500/40">
                            {commit.aiToolDetected}
                            <span className="text-[9px] opacity-60">detected</span>
                          </span>
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
                      <td className="px-6 py-3">
                        {commit.branch ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 max-w-[120px] truncate">
                            {commit.branch}
                          </span>
                        ) : (
                          <span className="text-gray-600 text-xs">{'\u2014'}</span>
                        )}
                      </td>
                      <td className="px-6 py-3 text-gray-400">{commit.author}</td>
                      <td className="px-6 py-3 text-center">
                        {promptCount > 0 ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">
                            {promptCount}
                          </span>
                        ) : (
                          <span className="text-gray-600 text-xs">{'\u2014'}</span>
                        )}
                      </td>
                      <td className="px-6 py-3 text-right text-gray-400">
                        {commit.session ? filesCount : '\u2014'}
                      </td>
                      <td className="px-6 py-3">
                        {commit.session
                          ? statusBadge(commit.session.review?.status ?? null)
                          : <span className="text-gray-600 text-xs">{'\u2014'}</span>}
                      </td>
                      <td className="px-6 py-3 text-center">
                        {commit.session ? (
                          <Link
                            to={`/sessions/${commit.session.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 border border-indigo-500/30 transition-colors"
                          >
                            View &rarr;
                          </Link>
                        ) : (
                          <span className="text-gray-600 text-xs">{'\u2014'}</span>
                        )}
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
    </div>
  );
}
