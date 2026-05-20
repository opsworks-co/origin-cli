import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import * as api from '../api';
import type { Repo, CommitDiff, RepoHealth } from '../api';
import WebhookSettings from '../components/WebhookSettings';
import ScoreGauge from '../components/ScoreGauge';
import { timeAgo, displayAgentName } from '../utils';
import { safeHref } from '../utils/safe-url';
import { PageHeader, Pill, PulseDot, ActionButtonGroup } from '../components/ui';
import { useAuth } from '../context/AuthContext';

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
                  {displayAgentName(commit.session.agent?.name) || commit.session.agent?.slug || commit.session.model}
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

type RepoTab = 'commits' | 'files' | 'sessions';

export default function RepoDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Solo / personal-workspace developers don't share repos with anyone —
  // there's nobody to grant access to — so we hide the access-management
  // controls instead of showing them a page that lists only themselves.
  const { user } = useAuth();
  const isSoloAccount = user?.accountType === 'developer';
  // Deep-link param: `/repos/:id?file=<path>` opens that file's blame view
  // on mount. Used by the dashboard's "Most Modified Files" list and any
  // other surface that wants to jump straight into a file.
  const [searchParams, setSearchParams] = useSearchParams();
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

  // Files tab data — fetched lazily on first open and refreshed when the
  // branch filter changes.
  const [repoFiles, setRepoFiles] = useState<import('../api/repos').RepoFileEntry[]>([]);
  const [repoFilesLoading, setRepoFilesLoading] = useState(false);
  // Summary the /files endpoint returns alongside the rows. The
  // header's AI% pill uses this when available so the headline
  // matches the per-file rows exactly — commits whose only
  // filesChanged are deleted from the current snapshot don't
  // appear in any row, and they shouldn't fatten the denominator
  // up here either.
  const [filesSummary, setFilesSummary] = useState<import('../api/repos').RepoFilesSummary | null>(null);
  const [filesQuery, setFilesQuery] = useState('');
  // Folders the user has explicitly collapsed. Default = expanded.
  const [filesCollapsed, setFilesCollapsed] = useState<Set<string>>(new Set());
  // Selected file → opens the inline viewer with per-line authorship.
  // Initial value comes from the `?file=<path>` query param if present so
  // deep-links from the dashboard land directly on the file viewer.
  const [openFilePath, setOpenFilePath] = useState<string | null>(() => {
    const fromUrl = searchParams.get('file');
    return fromUrl && fromUrl.length > 0 ? fromUrl : null;
  });
  // Pin the open file to a known-good SHA so the GitHub Contents fetch
  // can't 404 on a feature-branch-only file when the user has no branch
  // filter set (HEAD = default branch, but file lives on a side branch).
  const [openFileRef, setOpenFileRef] = useState<string | undefined>(undefined);
  const [openFileBlame, setOpenFileBlame] = useState<import('../api/repos').RepoFileBlame | null>(null);
  const [openFileLoading, setOpenFileLoading] = useState(false);
  const [openFileError, setOpenFileError] = useState<string | null>(null);

  // Branch filter — Files tab defaults to "__all__" (union of file
  // trees across every branch) so a fresh repo whose default branch is
  // a README seed but whose real work lives on feature branches shows
  // every file out of the box. The Commits tab keeps a separate filter
  // (defaults to default branch) so they don't share state.
  const [branches, setBranches] = useState<string[]>([]);
  const [branchFilter, setBranchFilter] = useState<string>('__all__');

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

  const fetchData = useCallback(async (silent = false) => {
    if (!id) return;
    if (!silent) setLoading(true);
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
      // Clear any prior error once a fetch succeeds — without this, a
      // transient error during the 20s background poll would stick on
      // screen even after the next tick fixed it.
      setError('');
    } catch (err: any) {
      // Suppress errors on background ticks. The page would briefly flash
      // a "Failed to load …" banner whenever the network blipped during
      // the 20s sync poll, then "fix itself" 20s later — exactly the
      // user-reported "random error that disappears".
      if (!silent) setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
    // Fetch health score and access control separately (non-blocking)
    api.getRepoHealth(id).then(setHealth).catch(() => {});
  }, [id, branchFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-sync loop. Provider-backed repos (github/gitlab) re-pull from the
  // remote every 20s. Local repos can't fetch from a remote, but the page's
  // fetchData() still picks up commits the CLI shadow-syncs in the
  // background, so we keep them on the same loop with a no-op syncRepo call
  // skipped — fetchData alone refreshes the list. Pause when the tab is
  // hidden so a backgrounded dashboard doesn't hammer the API.
  useEffect(() => {
    if (!id || !repo) return;
    const eff = repo.effectiveProvider ?? repo.provider;
    const isProviderBacked = eff === 'github' || eff === 'gitlab';

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, 20_000);
        return;
      }
      try {
        if (isProviderBacked) {
          await api.syncRepo(id).catch(() => {});
        }
        // silent=true so the loading spinner doesn't flash and a
        // transient error doesn't surface during a 20s background tick.
        if (!cancelled) await fetchData(true);
      } finally {
        if (!cancelled) timer = setTimeout(tick, 20_000);
      }
    };

    // First tick honours staleness — don't hammer the provider on mount if
    // we just synced via /sync earlier.
    const STALE_MS = 60 * 1000; // 1 min
    const lastSync = repo.syncedAt ? new Date(repo.syncedAt).getTime() : 0;
    const initialDelay = isProviderBacked && Date.now() - lastSync < STALE_MS
      ? 20_000
      : 0;
    timer = setTimeout(tick, initialDelay);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
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

  // Lazy-load files for this repo when the user opens the Files tab,
  // then poll every 30s while the tab is active *and* the document is
  // visible. Polling stops on tab switch or when the user backgrounds
  // the page so we don't burn GitHub rate limit on idle tabs.
  // Re-fetches when branchFilter changes — different branch = different
  // tree.
  // Eagerly fetch the per-file summary on mount (regardless of which
  // tab is active) so the header's AI% pill matches the per-file rows
  // immediately — including the case where the user lands on
  // Commits and never opens the Files tab.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const { getRepoFiles } = await import('../api/repos');
        const data = await getRepoFiles(id, branchFilter || undefined);
        if (!cancelled && data?.summary) setFilesSummary(data.summary);
      } catch { /* non-fatal — header falls back to commit-based math */ }
    })();
    return () => { cancelled = true; };
  }, [id, branchFilter]);

  useEffect(() => {
    if (repoTab !== 'files' || !id) return;
    let cancelled = false;
    const fetchFiles = async (showSpinner: boolean) => {
      if (showSpinner) setRepoFilesLoading(true);
      try {
        const { getRepoFiles } = await import('../api/repos');
        const data = await getRepoFiles(id, branchFilter || undefined);
        if (!cancelled) {
          setRepoFiles(data?.files || []);
          if (data?.summary) setFilesSummary(data.summary);
        }
      } catch {
        if (!cancelled && showSpinner) setRepoFiles([]);
        // Background-poll failures stay silent — keep showing the last
        // good snapshot instead of blanking the tab on a transient blip.
      } finally {
        if (!cancelled && showSpinner) setRepoFilesLoading(false);
      }
    };
    fetchFiles(true);
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval || cancelled) return;
      interval = setInterval(() => {
        if (document.visibilityState === 'visible') fetchFiles(false);
      }, 30_000);
    };
    const stop = () => { if (interval) { clearInterval(interval); interval = null; } };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchFiles(false);
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [repoTab, id, branchFilter]);

  // Mirror openFilePath into the `?file=` URL param so reloads / shares
  // preserve the open file, and closing the viewer clears it from the URL.
  useEffect(() => {
    const current = searchParams.get('file');
    if (openFilePath === current) return;
    const next = new URLSearchParams(searchParams);
    if (openFilePath) next.set('file', openFilePath);
    else next.delete('file');
    setSearchParams(next, { replace: true });
    // Intentionally omit setSearchParams + searchParams from deps so we only
    // run on openFilePath changes — including them would cause a render loop
    // when other code mutates searchParams.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFilePath]);

  // Lazy-load file contents + blame when a file is clicked. Closing the
  // viewer (openFilePath = null) drops the cached blame so a re-open
  // refetches in case the file changed on disk between visits.
  useEffect(() => {
    if (!openFilePath || !id) return;
    setOpenFileLoading(true);
    setOpenFileError(null);
    setOpenFileBlame(null);
    // Prefer the file's pinned ref (its last-touched SHA from the files
    // list) over the branch filter. If both are absent, GitHub falls back
    // to the repo's default branch on the server side.
    const refToUse = openFileRef || branchFilter || undefined;
    import('../api/repos').then(({ getRepoFile }) =>
      getRepoFile(id, openFilePath, refToUse)
        .then(setOpenFileBlame)
        .catch((err: any) => setOpenFileError(err?.message || 'Failed to load file'))
        .finally(() => setOpenFileLoading(false)),
    );
  }, [openFilePath, openFileRef, id, branchFilter]);

  // ── Files tree builder ────────────────────────────────────────────────
  // Group flat path list into a folder tree. Each folder aggregates its
  // descendants' commit counts so the row still shows useful summary
  // numbers when collapsed (matches GitHub's "Last commit" column feel).
  type TreeNode =
    | { kind: 'file'; name: string; path: string; entry: import('../api/repos').RepoFileEntry }
    | {
        kind: 'dir';
        name: string;
        path: string;
        children: TreeNode[];
        totalCommits: number;
        aiCommits: number;
        humanCommits: number;
        lastCommittedAt: string;
      };
  const filesTree = useMemo<TreeNode[]>(() => {
    const q = filesQuery.trim().toLowerCase();
    const filtered = q ? repoFiles.filter((f) => f.path.toLowerCase().includes(q)) : repoFiles;
    if (filtered.length === 0) return [];
    interface DirAcc {
      kind: 'dir';
      name: string;
      path: string;
      children: Map<string, DirAcc | { kind: 'file'; name: string; path: string; entry: import('../api/repos').RepoFileEntry }>;
      totalCommits: number;
      aiCommits: number;
      humanCommits: number;
      lastCommittedAt: string;
    }
    const root: DirAcc = { kind: 'dir', name: '', path: '', children: new Map(), totalCommits: 0, aiCommits: 0, humanCommits: 0, lastCommittedAt: '' };
    for (const entry of filtered) {
      const parts = entry.path.split('/').filter(Boolean);
      let cur: DirAcc = root;
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        prefix = prefix ? `${prefix}/${seg}` : seg;
        let next = cur.children.get(seg) as DirAcc | undefined;
        if (!next || next.kind !== 'dir') {
          next = { kind: 'dir', name: seg, path: prefix, children: new Map(), totalCommits: 0, aiCommits: 0, humanCommits: 0, lastCommittedAt: '' };
          cur.children.set(seg, next);
        }
        next.totalCommits += entry.totalCommits;
        next.aiCommits += entry.aiCommits;
        next.humanCommits += entry.humanCommits;
        if (entry.lastCommittedAt && (!next.lastCommittedAt || entry.lastCommittedAt > next.lastCommittedAt)) {
          next.lastCommittedAt = entry.lastCommittedAt;
        }
        cur = next;
      }
      const fileName = parts[parts.length - 1];
      cur.children.set(fileName, { kind: 'file', name: fileName, path: entry.path, entry });
    }
    const toArray = (d: DirAcc): TreeNode[] => {
      const arr: TreeNode[] = Array.from(d.children.values()).map((c) => {
        if (c.kind === 'file') return c;
        return {
          kind: 'dir' as const,
          name: c.name,
          path: c.path,
          children: toArray(c),
          totalCommits: c.totalCommits,
          aiCommits: c.aiCommits,
          humanCommits: c.humanCommits,
          lastCommittedAt: c.lastCommittedAt,
        };
      });
      // Folders first, then files; alphabetical inside each group.
      arr.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return arr;
    };
    return toArray(root);
  }, [repoFiles, filesQuery]);

  const toggleFolder = (folderPath: string) => {
    setFilesCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  const isAI = (c: any) => c.session !== null || c.aiToolDetected !== null;
  // Merge commits show up in the commit list but the diff they represent
  // is just the sum of the branch's commits. Calling them "Human"
  // is technically true (the user ran `git merge`) but misleading on a
  // repo where the merged work is AI-generated. Label these as Merge
  // so the counts read cleanly: AI commits + Human commits + Merge
  // commits, not "AI 23, Human 5" where the 5 are mostly merges of AI
  // work. Pattern matches GitHub/GitLab default merge subjects.
  const isMerge = (c: any) =>
    typeof c.message === 'string' && /^Merge (pull request|branch|remote-tracking|tag) /m.test(c.message);

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

  // Commit-list-derived counts. These power the AI/Human/Merge pills
  // when no per-file summary is available yet (fresh page load before
  // /files lands, or for repos without a current snapshot).
  // touchesFiles guards against file-less commits inflating the
  // denominator, matching the per-file aggregator's own filter.
  const touchesFiles = (c: any) => (c.fileCount ?? 0) > 0;
  const aiCountLocal = commits.filter((c) => isAI(c) && touchesFiles(c)).length;
  const mergeCount = commits.filter((c) => !isAI(c) && isMerge(c)).length;
  const humanCountLocal = commits.filter((c) => !isAI(c) && !isMerge(c) && touchesFiles(c)).length;

  // Prefer the server-computed per-file summary. It already joins
  // against the current blob tree, so commits whose only filesChanged
  // were deleted from the repo don't drag the AI% down — which is the
  // case the original bug fixed. Fall back to commit-list math while
  // the summary is in flight or absent.
  const aiCount = filesSummary?.aiCommits ?? aiCountLocal;
  const humanCount = filesSummary?.humanCommits ?? humanCountLocal;

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

  // Compute AI% from the same counts the badges display (aiCount /
  // humanCount / mergeCount), not from the server's health.aiPercentage.
  // The server denominator can include git-notes metadata commits the
  // dashboard hides, which made a repo where every visible commit was
  // AI display "52% AI" alongside per-file "100% AI" rows. Use the
  // filtered counts so the headline matches what's on screen.
  const attributableCommits = aiCount + humanCount; // exclude merge commits
  const aiPct = attributableCommits > 0
    ? (aiCount / attributableCommits) * 100
    : 0;

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
            <Pill variant="neutral" title={`${commits.length} commits scanned`}>Total {commits.length}</Pill>
            <Pill
              variant="ai"
              title={`${aiCount} of ${commits.length} commits attributed to an AI agent (${aiPct.toFixed(1)}%). File-level AI ratios may differ — those are computed from current file content, not commit count.`}
            >
              AI {aiCount} ({aiPct.toFixed(0)}%)
            </Pill>
            {humanCount > 0 && <Pill variant="neutral" title="Commits without an AI session and not matching a merge pattern">Human {humanCount}</Pill>}
            {mergeCount > 0 && <Pill variant="neutral" title="Merge commits — the actual changes are attributed to the commits being merged in">Merge {mergeCount}</Pill>}
          </>
        }
        actions={
          <ActionButtonGroup
            secondary={[
              { label: 'Issues', onClick: () => navigate(`/repos/${repo.id}/issues`) },
              ...(isSoloAccount ? [] : [
                { label: 'Manage access', onClick: () => navigate(`/repos/${repo.id}/access`) },
              ]),
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
          { key: 'files' as const, label: 'Files' },
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

      {/* Files tab — directory tree with per-file attribution. */}
      {repoTab === 'files' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Branch selector — Files tab always fetched the default branch
                before, which hid every file that lived only on a feature
                branch (the typical case for in-flight Codex sessions
                working on origin-restore-…). Drop the filter dropdown here
                so the user can switch to whatever branch they've actually
                been pushing to. */}
            {branches.length > 0 && (
              <select
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="px-2.5 py-1.5 rounded-md text-[12px] font-medium bg-gray-900/50 text-gray-300 border border-gray-800/80 hover:text-gray-200 transition-colors appearance-none cursor-pointer pr-7"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%239ca3af' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}
              >
                <option value="__all__">All branches</option>
                <option value="">Default branch</option>
                {branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            )}
            <input
              type="text"
              placeholder="Filter by path…"
              value={filesQuery}
              onChange={(e) => setFilesQuery(e.target.value)}
              className="flex-1 min-w-0 max-w-md px-3 py-1.5 rounded-md border border-gray-800/80 bg-gray-950/40 text-[12px] text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500/40"
            />
            <span className="text-[11px] text-gray-500 ml-auto">
              {repoFiles.length} file{repoFiles.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="card p-0 overflow-hidden">
            {repoFilesLoading ? (
              <div className="p-6 text-center text-gray-500 text-sm">Loading files…</div>
            ) : repoFiles.length === 0 ? (
              <FilesEmptyState
                hasCommits={commits.length > 0}
                repoId={id || ''}
                onBackfilled={() => {
                  // Re-fetch the files list once backfill has populated
                  // commit.filesChanged on existing rows.
                  setRepoFilesLoading(true);
                  import('../api/repos').then(({ getRepoFiles }) =>
                    getRepoFiles(id || '', branchFilter || undefined)
                      .then((data) => setRepoFiles(data?.files || []))
                      .catch(() => setRepoFiles([]))
                      .finally(() => setRepoFilesLoading(false)),
                  );
                }}
              />
            ) : filesTree.length === 0 ? (
              <div className="p-6 text-center text-gray-500 text-sm">No files match "{filesQuery}".</div>
            ) : (
              <FilesTreeBody
                tree={filesTree}
                collapsed={filesCollapsed}
                onToggle={toggleFolder}
                onPickFile={(p, sha) => { setOpenFilePath(p); setOpenFileRef(sha); }}
                openPath={openFilePath}
              />
            )}
          </div>

          {/* File viewer drawer */}
          {openFilePath && (
            <div
              className="fixed inset-0 bg-black/70 z-40 flex items-stretch justify-end"
              onClick={() => { setOpenFilePath(null); setOpenFileRef(undefined); }}
            >
              <div
                className="bg-[#0a0b14] border-l border-gray-800/80 w-full max-w-4xl flex flex-col shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-800/80">
                  <div className="min-w-0">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">File</p>
                    <h3 className="text-sm font-mono text-gray-100 truncate">{openFilePath}</h3>
                  </div>
                  <button
                    onClick={() => { setOpenFilePath(null); setOpenFileRef(undefined); }}
                    className="text-gray-500 hover:text-gray-200 px-3 py-1 rounded-md border border-gray-800 hover:border-gray-700"
                  >
                    Close
                  </button>
                </div>
                {openFileLoading ? (
                  <div className="p-6 text-center text-gray-500 text-sm">Loading…</div>
                ) : openFileError ? (
                  <div className="p-6 text-center text-amber-400 text-sm">{openFileError}</div>
                ) : openFileBlame ? (
                  <FileBlameView blame={openFileBlame} />
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}

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
                    {displayAgentName(s.agentName) || s.model}
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
                    const isMergeCommit = !isAiCommit && isMerge(commit);

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
                          {isMergeCommit && (
                            <span
                              className="flex-shrink-0 text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-400 border border-amber-500/30"
                              title="Merge commit — the underlying changes are attributed to the commits being merged"
                            >
                              Merge
                            </span>
                          )}
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
                                ? (displayAgentName(commit.session.agent?.name) || commit.session.agent?.slug || commit.session.model)
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

// ── Files-tab helpers ──────────────────────────────────────────────────

// Empty state for the Files tab. Two flavors:
//   • No commits yet — pure "nothing to show" copy.
//   • Commits exist but every commit.filesChanged is empty — that's the
//     post-import / post-snapshot state for repos whose ingestor didn't
//     populate the file list. Offer a one-click "Backfill from GitHub"
//     that hits POST /:id/backfill-files (admin-only on the server; we
//     surface any 403 inline rather than gating the button up-front, so
//     non-admins still see the option and learn what they need to ask).
function FilesEmptyState({
  hasCommits, repoId, onBackfilled,
}: {
  hasCommits: boolean;
  repoId: string;
  onBackfilled: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setRunning(true);
    setErr(null);
    setMsg(null);
    try {
      const { backfillRepoFiles } = await import('../api/repos');
      const r = await backfillRepoFiles(repoId);
      setMsg(`Backfilled ${r.updated} of ${r.scanned} commit${r.scanned === 1 ? '' : 's'}.`);
      onBackfilled();
    } catch (e: any) {
      setErr(e?.message || 'Backfill failed');
    } finally {
      setRunning(false);
    }
  };
  if (!hasCommits) {
    return (
      <div className="p-6 text-center text-gray-500 text-sm">
        No commits yet. Files appear here once commits land in this repo.
      </div>
    );
  }
  return (
    <div className="p-6 text-center space-y-3">
      <p className="text-sm text-gray-300">No file metadata yet for this repo's commits.</p>
      <p className="text-[12px] text-gray-500 max-w-md mx-auto">
        File paths weren't captured at ingest time (common for repos imported via an older webhook
        path). Run a one-shot backfill from GitHub to populate them — files appear here as soon as
        it finishes.
      </p>
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md border border-indigo-500/40 bg-indigo-500/10 text-[12px] text-indigo-300 hover:bg-indigo-500/15 disabled:opacity-50"
      >
        {running ? 'Backfilling…' : 'Backfill from GitHub'}
      </button>
      {msg && <p className="text-[11px] text-emerald-400">{msg}</p>}
      {err && (
        <p className="text-[11px] text-amber-400 max-w-md mx-auto">
          {err}
          {err.toLowerCase().includes('forbidden') && (
            <> · Backfill is admin-only — ask an org admin to run it.</>
          )}
        </p>
      )}
    </div>
  );
}

type RepoFileEntryT = import('../api/repos').RepoFileEntry;
type RepoFileBlameT = import('../api/repos').RepoFileBlame;

interface TreeFile { kind: 'file'; name: string; path: string; entry: RepoFileEntryT }
interface TreeDir {
  kind: 'dir'; name: string; path: string; children: Array<TreeFile | TreeDir>;
  totalCommits: number; aiCommits: number; humanCommits: number; lastCommittedAt: string;
}
type TreeAny = TreeFile | TreeDir;

function FilesTreeBody({
  tree, collapsed, onToggle, onPickFile, openPath,
}: {
  tree: TreeAny[];
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onPickFile: (path: string, ref?: string) => void;
  openPath: string | null;
}) {
  return (
    <div className="py-1">
      {tree.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          collapsed={collapsed}
          onToggle={onToggle}
          onPickFile={onPickFile}
          openPath={openPath}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node, depth, collapsed, onToggle, onPickFile, openPath,
}: {
  node: TreeAny;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onPickFile: (path: string, ref?: string) => void;
  openPath: string | null;
}) {
  // Sidebar-style indentation: 18px per level. Chevron occupies a fixed
  // 16px slot so files (no chevron) line up with folder labels above.
  const indentPx = depth * 18 + 12;
  if (node.kind === 'dir') {
    const isCollapsed = collapsed.has(node.path);
    const aiPct = node.totalCommits > 0 ? Math.round((node.aiCommits / node.totalCommits) * 100) : 0;
    return (
      <>
        <button
          onClick={() => onToggle(node.path)}
          className="w-full grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 pr-4 py-1.5 hover:bg-white/[0.03] transition-colors text-left group"
          style={{ paddingLeft: indentPx }}
        >
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-gray-500 w-4 text-center text-[10px] leading-none inline-block transition-transform group-hover:text-gray-300">
              {isCollapsed ? '›' : '⌄'}
            </span>
            <span className="text-[13px] text-gray-200 truncate">{node.name}</span>
          </div>
          <span className="text-[10.5px] text-gray-500 whitespace-nowrap tabular-nums">
            {node.totalCommits} · {aiPct}% AI
          </span>
          <span className="text-[10.5px] text-gray-600 whitespace-nowrap tabular-nums min-w-[80px] text-right">
            {node.lastCommittedAt ? timeAgo(node.lastCommittedAt) : '—'}
          </span>
        </button>
        {!isCollapsed && node.children.map((c) => (
          <TreeRow
            key={c.path}
            node={c}
            depth={depth + 1}
            collapsed={collapsed}
            onToggle={onToggle}
            onPickFile={onPickFile}
            openPath={openPath}
          />
        ))}
      </>
    );
  }
  const f = node.entry;
  const aiTone = f.aiPct >= 80 ? 'text-indigo-300/90 bg-indigo-500/10 ring-indigo-500/20'
    : f.aiPct >= 30 ? 'text-amber-300/90 bg-amber-500/10 ring-amber-500/20'
    : 'text-gray-400 bg-gray-700/25 ring-gray-600/25';
  const isOpen = openPath === f.path;
  return (
    <button
      onClick={() => onPickFile(f.path, f.lastSha || f.blobSha)}
      className={`w-full grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 pr-4 py-1.5 transition-colors text-left ${
        isOpen ? 'bg-indigo-500/[0.08]' : 'hover:bg-white/[0.03]'
      }`}
      // +16 to account for the chevron column folders use, so file
      // names visually nest under their parent label.
      style={{ paddingLeft: indentPx + 16 }}
    >
      <div className="min-w-0 flex items-center gap-2">
        <span className={`text-[13px] truncate ${isOpen ? 'text-indigo-300' : 'text-gray-200'}`}>{node.name}</span>
      </div>
      <span className={`text-[10px] px-2 py-0.5 rounded-full ring-1 font-medium tabular-nums whitespace-nowrap ${aiTone}`}>
        {f.aiPct}% AI
      </span>
      <span className="text-[10.5px] text-gray-400 whitespace-nowrap min-w-[88px]">
        {f.topAgent ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400/70" />
            {f.topAgent.name}
          </span>
        ) : (
          <span className="text-gray-600">—</span>
        )}
      </span>
      <span className="text-[10.5px] text-gray-400 whitespace-nowrap min-w-[110px] truncate">
        {f.topUser?.name || f.lastAuthor || <span className="text-gray-600">—</span>}
      </span>
      <span className="text-[10.5px] text-gray-500 whitespace-nowrap tabular-nums text-right min-w-[110px]">
        {f.sessionCount > 0 && <>{f.sessionCount}s · </>}
        {f.lastCommittedAt ? timeAgo(f.lastCommittedAt) : '—'}
      </span>
    </button>
  );
}

// Canonical agent groups. We deliberately collapse all variants of a
// vendor (e.g. "claude-code", "claude", "Claude Code", "claude-sonnet")
// into a single key — the legend used to render "Claude Code" three
// times when the same vendor leaked in via different slug spellings.
type AgentKey = 'claude-code' | 'codex' | 'gemini' | 'cursor' | 'copilot' | 'ai' | 'human';

interface AgentVisual {
  key: AgentKey;
  label: string;
  // Solid bar color used in the stacked breakdown + the gutter strip.
  bar: string;
  // Background tint applied when a line is hovered or its cohort is
  // highlighted (subtle; code stays readable).
  tint: string;
  // Tailwind text color for the legend label.
  text: string;
}

const AGENT_VISUALS: Record<AgentKey, AgentVisual> = {
  'claude-code': { key: 'claude-code', label: 'Claude',      bar: 'bg-indigo-500',  tint: 'bg-indigo-500/[0.07]',  text: 'text-indigo-300'  },
  'codex':       { key: 'codex',       label: 'Codex',       bar: 'bg-emerald-500', tint: 'bg-emerald-500/[0.07]', text: 'text-emerald-300' },
  'gemini':      { key: 'gemini',      label: 'Gemini',      bar: 'bg-sky-500',     tint: 'bg-sky-500/[0.07]',     text: 'text-sky-300'     },
  'cursor':      { key: 'cursor',      label: 'Cursor',      bar: 'bg-purple-500',  tint: 'bg-purple-500/[0.07]',  text: 'text-purple-300'  },
  'copilot':     { key: 'copilot',     label: 'Copilot',     bar: 'bg-cyan-500',    tint: 'bg-cyan-500/[0.07]',    text: 'text-cyan-300'    },
  'ai':          { key: 'ai',          label: 'AI',          bar: 'bg-fuchsia-500', tint: 'bg-fuchsia-500/[0.07]', text: 'text-fuchsia-300' },
  'human':       { key: 'human',       label: 'Human',       bar: 'bg-gray-600',    tint: 'bg-gray-500/[0.06]',    text: 'text-gray-300'    },
};

// Map any incoming slug + AI flag to one of the canonical keys. Keep this
// in sync with the LLM-provider patterns in agent-catalog.ts.
function resolveAgentKey(agentSlug: string | null, isAi: boolean): AgentKey {
  if (!isAi) return 'human';
  const slug = (agentSlug || 'ai').toLowerCase();
  if (slug.includes('claude') || slug.includes('sonnet') || slug.includes('opus') || slug.includes('haiku')) return 'claude-code';
  if (slug.includes('codex') || slug.includes('gpt') || slug.includes('o1-') || slug.includes('o3-') || slug.includes('o4-')) return 'codex';
  if (slug.includes('gemini')) return 'gemini';
  if (slug.includes('cursor')) return 'cursor';
  if (slug.includes('copilot')) return 'copilot';
  return 'ai';
}

function FileBlameView({ blame }: { blame: RepoFileBlameT }) {
  // The cohort the user is currently hovering. When set, we tint every
  // line authored by that agent so the spread of one vendor's work jumps
  // out at a glance. Replaces the old "blink and you miss the 2px strip"
  // experience.
  const [hoverKey, setHoverKey] = useState<AgentKey | null>(null);
  // The cohort the user has CLICKED on. Persists across mouse movements so
  // the highlight doesn't disappear the moment the cursor leaves the legend
  // chip. Click the chip again (or any other chip) to clear / switch.
  const [pinKey, setPinKey] = useState<AgentKey | null>(null);
  // Effective active cohort: a pin always wins over a hover, so hovering a
  // different chip while one is pinned doesn't yank the highlight away.
  const activeKey = pinKey ?? hoverKey;

  const breakdown = useMemo(() => {
    const counts = new Map<AgentKey, number>();
    let countedTotal = 0;
    for (const ln of blame.lines) {
      // Skip whitespace-only lines — they're structural padding and
      // shouldn't tilt the AI/Human split. A file where every code line
      // was AI-authored but every other line is a blank separator was
      // showing ~50% AI before this filter.
      if (!ln.content || ln.content.trim().length === 0) continue;
      const k = resolveAgentKey(ln.agentSlug, ln.isAi);
      counts.set(k, (counts.get(k) || 0) + 1);
      countedTotal++;
    }
    const total = countedTotal || 1;
    return Array.from(counts.entries())
      .map(([k, lines]) => ({ ...AGENT_VISUALS[k], lines, pct: (lines / total) * 100 }))
      .sort((a, b) => b.lines - a.lines);
  }, [blame.lines]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Stacked breakdown bar — proportional widths show share at a glance. */}
      <div className="px-5 py-3 border-b border-gray-800/60 space-y-2.5">
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-gray-400 font-medium uppercase tracking-wider">Authorship</span>
          <span className="text-gray-600 ml-auto">
            {blame.lineCount} lines · {blame.size.toLocaleString()} bytes · ref {blame.ref}
          </span>
        </div>
        <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-800/40">
          {breakdown.map((b) => (
            <div
              key={b.key}
              className={`${b.bar} transition-opacity ${activeKey && activeKey !== b.key ? 'opacity-30' : 'opacity-100'}`}
              style={{ width: `${b.pct}%` }}
              title={`${b.label} — ${b.lines} line${b.lines !== 1 ? 's' : ''} (${b.pct.toFixed(0)}%)`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px]">
          {breakdown.map((b) => {
            const isPinned = pinKey === b.key;
            return (
              <button
                key={b.key}
                type="button"
                onMouseEnter={() => setHoverKey(b.key)}
                onMouseLeave={() => setHoverKey(null)}
                onClick={() => setPinKey((prev) => (prev === b.key ? null : b.key))}
                aria-pressed={isPinned}
                title={isPinned ? 'Click to clear filter' : `Click to pin ${b.label} highlighting`}
                className={`inline-flex items-center gap-1.5 transition-opacity rounded px-1 -mx-1 ${
                  activeKey && activeKey !== b.key ? 'opacity-40' : 'opacity-100'
                } ${
                  isPinned ? 'ring-1 ring-gray-600 bg-gray-800/40' : 'hover:bg-gray-800/30'
                }`}
              >
                <span className={`w-2 h-2 rounded-sm ${b.bar}`} />
                <span className={b.text}>{b.label}</span>
                <span className="text-gray-500 tabular-nums">{b.lines}</span>
                <span className="text-gray-600 tabular-nums">({b.pct.toFixed(0)}%)</span>
              </button>
            );
          })}
          {pinKey && (
            <button
              type="button"
              onClick={() => setPinKey(null)}
              className="text-gray-500 hover:text-gray-300 underline-offset-2 hover:underline"
              title="Clear pinned cohort"
            >
              clear
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto font-mono text-[12px] leading-[18px] tabular-nums">
        {blame.lines.map((ln) => {
          const key = resolveAgentKey(ln.agentSlug, ln.isAi);
          const v = AGENT_VISUALS[key];
          const cohorted = activeKey === key;
          const promptLabel = ln.isAi && ln.promptIndex !== null
            ? ` · prompt #${ln.promptIndex + 1}`
            : '';
          const promptTextSuffix = ln.isAi && ln.promptText
            ? `\n"${ln.promptText.slice(0, 120)}${ln.promptText.length > 120 ? '…' : ''}"`
            : '';
          const tooltip = ln.isAi
            ? `${v.label}${ln.userName ? ' · ' + ln.userName : ''}${ln.sessionId ? ' · session ' + ln.sessionId.slice(0, 8) : ''}${promptLabel}${promptTextSuffix}`
            : ln.userName ? `Human · ${ln.userName}` : 'Human';
          // Deep-link to the prompt's AI Blame view when we know which
          // prompt added this line; otherwise to the session.
          const linkable = ln.isAi && ln.sessionId;
          const Wrapper: any = linkable ? Link : 'div';
          const sessionHref = ln.sessionId
            ? (ln.promptIndex !== null
                ? `/sessions/${ln.sessionId}?tab=blame&prompt=${ln.promptIndex}`
                : `/sessions/${ln.sessionId}`)
            : '';
          const wrapperProps: any = linkable ? { to: sessionHref } : {};
          // Cohort tint dominates over hover tint so highlighting one
          // agent visually subdues the others.
          const rowBg = cohorted
            ? v.tint
            : activeKey
              ? '' // explicitly muted — keep neutral
              : `hover:${v.tint}`;
          return (
            <Wrapper
              key={ln.lineNumber}
              {...wrapperProps}
              title={tooltip}
              // Don't let line-row hovering override a pinned cohort —
              // otherwise moving the mouse off a pinned chip into the code
              // area would silently switch the highlight to whatever line
              // happened to be under the cursor.
              onMouseEnter={() => { if (!pinKey) setHoverKey(key); }}
              onMouseLeave={() => { if (!pinKey) setHoverKey(null); }}
              className={`grid grid-cols-[3px_56px_1fr] items-stretch transition-colors ${rowBg} ${linkable ? 'cursor-pointer' : ''}`}
            >
              <span className={`${v.bar} ${activeKey && !cohorted ? 'opacity-25' : 'opacity-80'}`} />
              <span className="px-2 text-right text-gray-600 select-none border-r border-gray-800/40">
                {ln.lineNumber}
              </span>
              <pre className="px-3 whitespace-pre overflow-x-auto text-gray-200 m-0">
                {ln.content || ' '}
              </pre>
            </Wrapper>
          );
        })}
      </div>
    </div>
  );
}
