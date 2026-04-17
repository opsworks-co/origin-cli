import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';
import type { Repo, GitHubDiscoveredRepo, GitLabDiscoveredRepo, ImportResult, GitLabImportResult, IntegrationConfig } from '../api';
import { timeAgo } from '../utils';
import { Package, Plus, RefreshCw, Archive, Trash2, GitFork } from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { PageHeader, Pill } from '../components/ui';

/**
 * Derive the effective provider for grouping.
 *
 * Prefer the server-computed `effectiveProvider` (which already checks
 * whether the org has a matching integration connected) and fall back to
 * a path-based guess for older API responses that don't include it.
 *
 * The key case this handles: a repo stored with provider='github' and path
 * 'github.com/foo/bar', but the org has never connected a GitHub
 * integration. The server will return effectiveProvider='local' so the UI
 * groups it under "Local" — because without integration credentials we
 * literally cannot pull anything from GitHub for it, so treating it as a
 * remote repo would just produce failing "Sync all" clicks.
 */
function effectiveProvider(repo: Repo): 'github' | 'gitlab' | 'local' {
  if (repo.effectiveProvider) return repo.effectiveProvider;
  const path = repo.path || '';
  if (/github\.com\//.test(path)) return 'github';
  if (/gitlab\.com\//.test(path)) return 'gitlab';
  return 'local';
}

/** Extract org/owner from repo path, e.g. "github.com/dolobanko/origin" → "dolobanko" */
function extractOrg(repo: Repo): string {
  // If the server says this repo is effectively local (e.g. because the
  // GitHub integration isn't connected), group it under "Local" regardless
  // of what the path looks like — otherwise a disconnected github.com/…
  // repo would still show up under the owner group with a broken sync
  // button.
  if (repo.effectiveProvider === 'local') return 'Local';
  const path = repo.path || '';
  // GitHub: "github.com/owner/repo" or "https://github.com/owner/repo"
  const ghMatch = path.match(/github\.com\/([^/]+)/);
  if (ghMatch) return ghMatch[1];
  // GitLab: "gitlab.com/owner/repo" or "https://gitlab.com/owner/repo"
  const glMatch = path.match(/gitlab\.com\/([^/]+)/);
  if (glMatch) return glMatch[1];
  // Anything else (including stale provider=github on session-uploaded repos) → Local
  return 'Local';
}

interface OrgGroup {
  org: string;
  provider: string;
  repos: Repo[];
  totalCommits: number;
  totalSessions: number;
}

function groupByOrg(repos: Repo[]): OrgGroup[] {
  const map = new Map<string, OrgGroup>();
  for (const repo of repos) {
    const org = extractOrg(repo);
    const provider = effectiveProvider(repo);
    if (!map.has(org)) {
      map.set(org, {
        org,
        provider,
        repos: [],
        totalCommits: 0,
        totalSessions: 0,
      });
    }
    const group = map.get(org)!;
    group.repos.push(repo);
    group.totalCommits += repo._count?.commits ?? 0;
    group.totalSessions += repo._count?.sessions ?? 0;
  }
  // Sort: github/gitlab orgs first, then local
  return Array.from(map.values()).sort((a, b) => {
    if (a.provider === 'local' && b.provider !== 'local') return 1;
    if (a.provider !== 'local' && b.provider === 'local') return -1;
    return a.org.localeCompare(b.org);
  });
}

export default function Repos() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSolo = user?.accountType === 'developer';
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add form state
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formPath, setFormPath] = useState('');
  const [formProvider, setFormProvider] = useState('local');
  const [submitting, setSubmitting] = useState(false);

  // Sync states
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [syncResult, setSyncResult] = useState<Record<string, string>>({});

  // Delete state
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const { toast } = useToast();

  // Archive state
  const [archiving, setArchiving] = useState<Record<string, boolean>>({});
  const [showArchived, setShowArchived] = useState(false);
  const [archivedRepos, setArchivedRepos] = useState<Repo[]>([]);

  // GitHub import state
  const [hasGitHub, setHasGitHub] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [githubRepos, setGithubRepos] = useState<GitHubDiscoveredRepo[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [searchFilter, setSearchFilter] = useState('');

  // GitLab import state
  const [hasGitLab, setHasGitLab] = useState(false);
  const [showGitLabImport, setShowGitLabImport] = useState(false);
  const [discoveringGitLab, setDiscoveringGitLab] = useState(false);
  const [gitlabRepos, setGitlabRepos] = useState<GitLabDiscoveredRepo[]>([]);
  const [selectedGitLabRepos, setSelectedGitLabRepos] = useState<Set<string>>(new Set());
  const [importingGitLab, setImportingGitLab] = useState(false);
  const [gitlabImportResults, setGitlabImportResults] = useState<GitLabImportResult[]>([]);
  const [gitlabSearchFilter, setGitlabSearchFilter] = useState('');

  // Inline connect state (shown when GitHub App / GitLab OAuth not configured)
  const [showGitHubPat, setShowGitHubPat] = useState(false);
  const [showGitLabOAuth, setShowGitLabOAuth] = useState(false);
  const [ghPatToken, setGhPatToken] = useState('');
  const [glOAuthAppId, setGlOAuthAppId] = useState('');
  const [glOAuthSecret, setGlOAuthSecret] = useState('');
  const [savingPat, setSavingPat] = useState(false);
  const [savingGlOAuth, setSavingGlOAuth] = useState(false);

  const handleConnectGitHub = async () => {
    try {
      const { installUrl } = await api.getGitHubAppInstallUrl();
      window.location.href = installUrl;
    } catch {
      // GitHub App not configured — show PAT form
      setShowGitHubPat(true);
      setShowGitLabOAuth(false);
    }
  };

  const handleConnectGitLab = async () => {
    try {
      const { authorizeUrl } = await api.getGitLabOAuthInstallUrl();
      window.location.href = authorizeUrl;
    } catch {
      // GitLab OAuth not configured — show OAuth setup form
      setShowGitLabOAuth(true);
      setShowGitHubPat(false);
    }
  };

  const handleSaveGhPat = async () => {
    if (!ghPatToken.trim()) return;
    setSavingPat(true);
    try {
      await api.createIntegration({ provider: 'github', token: ghPatToken.trim() });
      setHasGitHub(true);
      setShowGitHubPat(false);
      setGhPatToken('');
      toast('success', 'GitHub connected');
      handleDiscover();
    } catch (err: any) {
      toast('error', err.message || 'Failed to connect GitHub');
    } finally {
      setSavingPat(false);
    }
  };

  const handleSaveGlOAuth = async () => {
    if (!glOAuthAppId.trim() || !glOAuthSecret.trim()) return;
    setSavingGlOAuth(true);
    try {
      await api.saveGitLabOAuthConfig({
        clientId: glOAuthAppId.trim(),
        clientSecret: glOAuthSecret.trim(),
        redirectUri: `${window.location.origin}/api/gitlab-oauth/callback`,
      });
      // Now redirect to GitLab OAuth
      const { authorizeUrl } = await api.getGitLabOAuthInstallUrl();
      window.location.href = authorizeUrl;
    } catch (err: any) {
      toast('error', err.message || 'Failed to configure GitLab OAuth');
      setSavingGlOAuth(false);
    }
  };

  const fetchRepos = useCallback(() => {
    setLoading(true);
    api
      .getRepos()
      .then(setRepos)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchRepos();
    api.getIntegrations().then((configs) => {
      const gh = configs.find((c: IntegrationConfig) => c.provider === 'github' && c.hasToken);
      setHasGitHub(!!gh);
      const gl = configs.find((c: IntegrationConfig) => c.provider === 'gitlab' && c.hasToken);
      setHasGitLab(!!gl);

      // Auto-discover after OAuth callback
      const params = new URLSearchParams(window.location.search);
      if (params.get('github_app') === 'success' && gh) {
        handleDiscover();
        window.history.replaceState({}, '', '/repos');
      }
      if (params.get('gitlab_oauth') === 'success' && gl) {
        handleDiscoverGitLab();
        window.history.replaceState({}, '', '/repos');
      }
    }).catch(() => {});
  }, [fetchRepos]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.createRepo({ name: formName, path: formPath, provider: formProvider });
      setFormName('');
      setFormPath('');
      setFormProvider('local');
      setShowForm(false);
      fetchRepos();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleteTarget(null);
    setDeleting((prev) => ({ ...prev, [id]: true }));
    try {
      await api.deleteRepo(id);
      toast('success', 'Repository deleted');
      fetchRepos();
      if (showArchived) fetchArchivedRepos();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setDeleting((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handleArchive = async (id: string, archived: boolean) => {
    setArchiving((prev) => ({ ...prev, [id]: true }));
    try {
      await api.archiveRepo(id, archived);
      fetchRepos();
      if (showArchived) fetchArchivedRepos();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setArchiving((prev) => ({ ...prev, [id]: false }));
    }
  };

  const fetchArchivedRepos = useCallback(() => {
    api.getRepos({ archived: true }).then((all) => {
      setArchivedRepos(all.filter((r) => r.archived));
    }).catch(() => {});
  }, []);

  const handleSync = async (id: string) => {
    setSyncing((prev) => ({ ...prev, [id]: true }));
    setSyncResult((prev) => ({ ...prev, [id]: '' }));
    try {
      const result = await api.syncRepo(id);
      setSyncResult((prev) => ({
        ...prev,
        [id]: result.synced > 0
          ? `+${result.synced} new`
          : result.total > 0
            ? 'Up to date'
            : 'No commits',
      }));
      fetchRepos();
    } catch (err: any) {
      setSyncResult((prev) => ({ ...prev, [id]: `Failed` }));
    } finally {
      setSyncing((prev) => ({ ...prev, [id]: false }));
    }
  };

  // Sync all repos in an org group
  const handleSyncAll = async (group: OrgGroup) => {
    for (const repo of group.repos) {
      await handleSync(repo.id);
    }
  };

  // GitHub import handlers
  const handleDiscover = async () => {
    setShowImport(true);
    setShowForm(false);
    setDiscovering(true);
    setError('');
    setImportResults([]);
    setSelectedRepos(new Set());
    setSearchFilter('');
    try {
      const result = await api.discoverGitHubRepos();
      setGithubRepos(result.repos);
    } catch (err: any) {
      setError(err.message);
      setShowImport(false);
    } finally {
      setDiscovering(false);
    }
  };

  const toggleSelect = (fullName: string) => {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const available = filteredGhRepos.filter((r) => !r.alreadyImported);
    if (selectedRepos.size === available.length) {
      setSelectedRepos(new Set());
    } else {
      setSelectedRepos(new Set(available.map((r) => r.fullName)));
    }
  };

  const handleImport = async () => {
    if (selectedRepos.size === 0) return;
    setImporting(true);
    setError('');
    try {
      const result = await api.importGitHubRepos(
        Array.from(selectedRepos).map((fullName) => ({ fullName })),
      );
      setImportResults(result.results);
      setSelectedRepos(new Set());
      // Kick off a sync for every newly imported repo so the commit history
      // and AI detection metadata show up without the user having to click
      // "Sync" manually. Fire-and-forget — sync can take a while on big
      // repos and we don't want to block the UI.
      const newRepoIds = result.results
        .filter((r) => r.success && r.repoId)
        .map((r) => r.repoId as string);
      for (const id of newRepoIds) {
        api.syncRepo(id).catch(() => { /* background best-effort */ });
      }
      fetchRepos();
      const updated = await api.discoverGitHubRepos();
      setGithubRepos(updated.repos);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const filteredGhRepos = githubRepos.filter((r) =>
    r.fullName.toLowerCase().includes(searchFilter.toLowerCase()),
  );

  const availableCount = filteredGhRepos.filter((r) => !r.alreadyImported).length;

  // GitLab import handlers
  const handleDiscoverGitLab = async () => {
    setShowGitLabImport(true);
    setShowImport(false);
    setShowForm(false);
    setDiscoveringGitLab(true);
    setError('');
    setGitlabImportResults([]);
    setSelectedGitLabRepos(new Set());
    setGitlabSearchFilter('');
    try {
      const result = await api.discoverGitLabRepos();
      setGitlabRepos(result.repos);
    } catch (err: any) {
      setError(err.message);
      setShowGitLabImport(false);
    } finally {
      setDiscoveringGitLab(false);
    }
  };

  const toggleGitLabSelect = (fullPath: string) => {
    setSelectedGitLabRepos((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  };

  const filteredGlRepos = gitlabRepos.filter((r) =>
    r.fullPath.toLowerCase().includes(gitlabSearchFilter.toLowerCase()),
  );
  const availableGlCount = filteredGlRepos.filter((r) => !r.alreadyImported).length;

  const toggleGitLabSelectAll = () => {
    const available = filteredGlRepos.filter((r) => !r.alreadyImported);
    if (selectedGitLabRepos.size === available.length) {
      setSelectedGitLabRepos(new Set());
    } else {
      setSelectedGitLabRepos(new Set(available.map((r) => r.fullPath)));
    }
  };

  const handleGitLabImport = async () => {
    if (selectedGitLabRepos.size === 0) return;
    setImportingGitLab(true);
    setError('');
    try {
      const result = await api.importGitLabRepos(
        Array.from(selectedGitLabRepos).map((fullPath) => ({ fullPath })),
      );
      setGitlabImportResults(result.results);
      setSelectedGitLabRepos(new Set());
      // Auto-sync each freshly imported repo in the background (see the
      // GitHub handler above for rationale).
      const newRepoIds = result.results
        .filter((r) => r.success && r.repoId)
        .map((r) => r.repoId as string);
      for (const id of newRepoIds) {
        api.syncRepo(id).catch(() => { /* background best-effort */ });
      }
      fetchRepos();
      const updated = await api.discoverGitLabRepos();
      setGitlabRepos(updated.repos);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setImportingGitLab(false);
    }
  };

  const orgGroups = groupByOrg(repos);
  const totalCommits = repos.reduce((sum, r) => sum + (r._count?.commits ?? 0), 0);
  const totalSessions = repos.reduce((sum, r) => sum + (r._count?.sessions ?? 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Repositories"
        subtitle={`${repos.length} ${repos.length === 1 ? 'repo' : 'repos'} \u00B7 ${totalCommits} commits \u00B7 ${totalSessions} sessions`}
        actions={repos.length > 0 ? (
          <div className="flex items-center gap-2 flex-wrap">
            {hasGitHub && !showImport && (
              <button
                onClick={() => { handleDiscover(); setShowGitLabImport(false); setShowForm(false); }}
                className="btn-primary text-sm"
              >
                Import from GitHub
              </button>
            )}
            {!hasGitHub && (
              <button
                onClick={() => handleConnectGitHub()}
                className="text-sm px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-white transition-colors"
              >
                Connect GitHub
              </button>
            )}
            {!hasGitLab && (
              <button
                onClick={() => handleConnectGitLab()}
                className="text-sm px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-white transition-colors"
              >
                Connect GitLab
              </button>
            )}
            {hasGitLab && !showGitLabImport && (
              <button
                onClick={() => { handleDiscoverGitLab(); setShowImport(false); setShowForm(false); }}
                className="btn-primary text-sm"
                style={{ background: '#FC6D26' }}
              >
                Import from GitLab
              </button>
            )}
            <button
              onClick={() => { setShowForm(!showForm); setShowImport(false); setShowGitLabImport(false); }}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-700 hover:border-indigo-500/50 text-gray-300 hover:text-white transition-colors"
            >
              {showForm ? 'Close' : '+ Add Repo'}
            </button>
          </div>
        ) : undefined}
      />

      {error && (
        <div className="card bg-red-900/20 border-red-800 text-red-400 text-sm">{error}</div>
      )}

      {/* GitHub Import Panel */}
      {showImport && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2">
              <svg className="w-5 h-5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Import from GitHub
            </h3>
            {!discovering && githubRepos.length > 0 && (
              <span className="text-sm text-gray-400">
                {githubRepos.length} repos found
              </span>
            )}
          </div>

          {discovering ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center gap-3 text-gray-400">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-indigo-400" />
                Fetching repos from GitHub...
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  className="input flex-1"
                  placeholder="Filter repos..."
                />
                <button
                  onClick={toggleSelectAll}
                  className="text-sm text-indigo-400 hover:text-indigo-300 whitespace-nowrap"
                >
                  {selectedRepos.size === availableCount && availableCount > 0
                    ? 'Deselect All'
                    : `Select All (${availableCount})`}
                </button>
              </div>

              <div className="max-h-80 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800">
                {filteredGhRepos.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    {searchFilter ? 'No repos match your filter' : 'No repos found'}
                  </div>
                ) : (
                  filteredGhRepos.map((repo) => (
                    <label
                      key={repo.fullName}
                      className={`flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/50 transition-colors ${
                        repo.alreadyImported ? 'opacity-50' : 'cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={repo.alreadyImported || selectedRepos.has(repo.fullName)}
                        disabled={repo.alreadyImported}
                        onChange={() => toggleSelect(repo.fullName)}
                        className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 bg-gray-800"
                      />
                      <span className="text-sm text-gray-200 truncate flex-1">{repo.fullName}</span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {repo.private && <span className="badge badge-amber text-xs">private</span>}
                        {repo.alreadyImported && <span className="badge badge-green text-xs">imported</span>}
                      </div>
                    </label>
                  ))
                )}
              </div>

              {importResults.length > 0 && (
                <div className="space-y-1">
                  {importResults.map((r) => (
                    <div
                      key={r.fullName}
                      className={`text-xs px-3 py-1.5 rounded ${
                        r.success ? 'bg-green-900/20 text-green-400' : 'bg-red-900/20 text-red-400'
                      }`}
                    >
                      {r.success ? '\u2713' : '\u2717'} {r.fullName}
                      {r.error && ` — ${r.error}`}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">Webhooks created automatically</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowImport(false);
                      setSelectedRepos(new Set());
                      setImportResults([]);
                      setSearchFilter('');
                    }}
                    disabled={importing}
                    className="btn-secondary text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleImport}
                    disabled={selectedRepos.size === 0 || importing}
                    className="btn-primary text-sm"
                  >
                    {importing ? (
                      <span className="flex items-center gap-2">
                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
                        Importing...
                      </span>
                    ) : (
                      `Import ${selectedRepos.size} Selected`
                    )}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* GitLab Import Panel */}
      {showGitLabImport && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2">
              <svg className="w-5 h-5" viewBox="0 0 32 32" fill="#FC6D26">
                <path d="M16 28.896L21.323 12.576H10.677L16 28.896Z" />
                <path d="M16 28.896L10.677 12.576H2.867L16 28.896Z" fill="#FC6D26" opacity="0.7" />
                <path d="M2.867 12.576L1.164 17.821C1.005 18.31 1.172 18.847 1.578 19.142L16 28.896L2.867 12.576Z" fill="#FC6D26" opacity="0.5" />
                <path d="M2.867 12.576H10.677L7.334 2.279C7.155 1.736 6.393 1.736 6.214 2.279L2.867 12.576Z" />
                <path d="M16 28.896L21.323 12.576H29.133L16 28.896Z" fill="#FC6D26" opacity="0.7" />
                <path d="M29.133 12.576L30.836 17.821C30.995 18.31 30.828 18.847 30.422 19.142L16 28.896L29.133 12.576Z" fill="#FC6D26" opacity="0.5" />
                <path d="M29.133 12.576H21.323L24.666 2.279C24.845 1.736 25.607 1.736 25.786 2.279L29.133 12.576Z" />
              </svg>
              Import from GitLab
            </h3>
            {!discoveringGitLab && gitlabRepos.length > 0 && (
              <span className="text-sm text-gray-400">
                {gitlabRepos.length} repos found
              </span>
            )}
          </div>

          {discoveringGitLab ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center gap-3 text-gray-400">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-orange-400" />
                Fetching repos from GitLab...
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={gitlabSearchFilter}
                  onChange={(e) => setGitlabSearchFilter(e.target.value)}
                  className="input flex-1"
                  placeholder="Filter repos..."
                />
                <button
                  onClick={toggleGitLabSelectAll}
                  className="text-sm text-orange-400 hover:text-orange-300 whitespace-nowrap"
                >
                  {selectedGitLabRepos.size === availableGlCount && availableGlCount > 0
                    ? 'Deselect All'
                    : `Select All (${availableGlCount})`}
                </button>
              </div>

              <div className="max-h-80 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800">
                {filteredGlRepos.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    {gitlabSearchFilter ? 'No repos match your filter' : 'No repos found'}
                  </div>
                ) : (
                  filteredGlRepos.map((repo) => (
                    <label
                      key={repo.fullPath}
                      className={`flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/50 transition-colors ${
                        repo.alreadyImported ? 'opacity-50' : 'cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={repo.alreadyImported || selectedGitLabRepos.has(repo.fullPath)}
                        disabled={repo.alreadyImported}
                        onChange={() => toggleGitLabSelect(repo.fullPath)}
                        className="rounded border-gray-600 text-orange-500 focus:ring-orange-500 bg-gray-800"
                      />
                      <span className="text-sm text-gray-200 truncate flex-1">{repo.fullPath}</span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {repo.private && <span className="badge badge-amber text-xs">private</span>}
                        {repo.alreadyImported && <span className="badge badge-green text-xs">imported</span>}
                      </div>
                    </label>
                  ))
                )}
              </div>

              {gitlabImportResults.length > 0 && (
                <div className="space-y-1">
                  {gitlabImportResults.map((r) => (
                    <div
                      key={r.fullPath}
                      className={`text-xs px-3 py-1.5 rounded ${
                        r.success ? 'bg-green-900/20 text-green-400' : 'bg-red-900/20 text-red-400'
                      }`}
                    >
                      {r.success ? '\u2713' : '\u2717'} {r.fullPath}
                      {r.error && ` — ${r.error}`}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">Webhooks created automatically</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowGitLabImport(false);
                      setSelectedGitLabRepos(new Set());
                      setGitlabImportResults([]);
                      setGitlabSearchFilter('');
                    }}
                    disabled={importingGitLab}
                    className="btn-secondary text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleGitLabImport}
                    disabled={selectedGitLabRepos.size === 0 || importingGitLab}
                    className="btn-primary text-sm"
                    style={{ background: '#FC6D26' }}
                  >
                    {importingGitLab ? (
                      <span className="flex items-center gap-2">
                        <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
                        Importing...
                      </span>
                    ) : (
                      `Import ${selectedGitLabRepos.size} Selected`
                    )}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Add Repo Form */}
      {showForm && (
        <form onSubmit={handleCreate} className="card space-y-4">
          <h3 className="font-semibold">Connect Repository</h3>
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name</label>
              <input
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="input"
                placeholder="my-project"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Path or URL</label>
              <input
                required
                value={formPath}
                onChange={(e) => setFormPath(e.target.value)}
                className="input"
                placeholder="/home/user/project or github.com/org/repo"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Provider</label>
              <select
                value={formProvider}
                onChange={(e) => setFormProvider(e.target.value)}
                className="select w-full"
              >
                <option value="local">Local</option>
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </select>
            </div>
          </div>
          <button type="submit" disabled={submitting} className="btn-primary text-sm">
            {submitting ? 'Connecting...' : 'Connect Repository'}
          </button>
        </form>
      )}

      {/* Repos List */}
      {repos.length === 0 && !showImport && !showGitLabImport && !showForm ? (
        <div className="card py-14 space-y-8">
          <div className="text-center">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 flex items-center justify-center mx-auto mb-3">
              <Package className="w-6 h-6 text-indigo-400" />
            </div>
            <p className="text-lg font-medium text-gray-200 mb-1">No repositories yet</p>
            {!isSolo && (
              <p className="text-sm text-gray-500">
                Agents can only run sessions in registered repositories.
              </p>
            )}
          </div>

          <div className="grid sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
            {/* GitHub import option */}
            <button
              onClick={() => {
                if (hasGitHub) {
                  handleDiscover();
                } else {
                  handleConnectGitHub();
                }
              }}
              className="flex flex-col items-center gap-3 p-6 rounded-xl border border-gray-700 hover:border-indigo-500/50 hover:bg-gray-800/50 transition-all group text-left"
            >
              <svg className="w-8 h-8 text-gray-400 group-hover:text-white transition-colors" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <div className="text-center">
                <p className="font-medium text-gray-200 group-hover:text-white transition-colors">
                  {hasGitHub ? 'Import from GitHub' : 'Connect GitHub'}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {hasGitHub
                    ? 'Select repos from your GitHub org'
                    : 'Connect GitHub to import repos'}
                </p>
              </div>
            </button>

            {/* GitLab import option */}
            <button
              onClick={() => {
                if (hasGitLab) {
                  handleDiscoverGitLab();
                } else {
                  handleConnectGitLab();
                }
              }}
              className="flex flex-col items-center gap-3 p-6 rounded-xl border border-gray-700 hover:border-orange-500/50 hover:bg-gray-800/50 transition-all group text-left"
            >
              <svg className="w-8 h-8 text-gray-400 group-hover:text-orange-400 transition-colors" viewBox="0 0 32 32" fill="currentColor">
                <path d="M16 28.896L21.323 12.576H10.677L16 28.896Z" />
                <path d="M16 28.896L10.677 12.576H2.867L16 28.896Z" opacity="0.7" />
                <path d="M2.867 12.576L1.164 17.821C1.005 18.31 1.172 18.847 1.578 19.142L16 28.896L2.867 12.576Z" opacity="0.5" />
                <path d="M2.867 12.576H10.677L7.334 2.279C7.155 1.736 6.393 1.736 6.214 2.279L2.867 12.576Z" />
                <path d="M16 28.896L21.323 12.576H29.133L16 28.896Z" opacity="0.7" />
                <path d="M29.133 12.576L30.836 17.821C30.995 18.31 30.828 18.847 30.422 19.142L16 28.896L29.133 12.576Z" opacity="0.5" />
                <path d="M29.133 12.576H21.323L24.666 2.279C24.845 1.736 25.607 1.736 25.786 2.279L29.133 12.576Z" />
              </svg>
              <div className="text-center">
                <p className="font-medium text-gray-200 group-hover:text-white transition-colors">
                  {hasGitLab ? 'Import from GitLab' : 'Connect GitLab'}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {hasGitLab
                    ? 'Select repos from your GitLab'
                    : 'Connect GitLab to import repos'}
                </p>
              </div>
            </button>

            {/* Manual add option */}
            <button
              onClick={() => { setShowForm(true); setShowImport(false); setShowGitLabImport(false); }}
              className="flex flex-col items-center gap-3 p-6 rounded-xl border border-gray-700 hover:border-indigo-500/50 hover:bg-gray-800/50 transition-all group text-left"
            >
              <svg className="w-8 h-8 text-gray-400 group-hover:text-white transition-colors" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              <div className="text-center">
                <p className="font-medium text-gray-200 group-hover:text-white transition-colors">Add Manually</p>
                <p className="text-xs text-gray-500 mt-1">
                  Enter a repository path or URL directly
                </p>
              </div>
            </button>
          </div>

          {/* Inline GitHub PAT form */}
          {showGitHubPat && (
            <div className="max-w-lg mx-auto mt-4 p-4 rounded-lg border border-gray-700 bg-gray-800/50 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-200">Enter GitHub Personal Access Token</p>
                <button onClick={() => { setShowGitHubPat(false); setGhPatToken(''); }} className="text-gray-500 hover:text-gray-300">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={ghPatToken}
                  onChange={(e) => setGhPatToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveGhPat()}
                  className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                  placeholder="ghp_xxxxxxxxxxxx"
                  autoFocus
                />
                <button onClick={handleSaveGhPat} disabled={savingPat || !ghPatToken.trim()} className="btn-primary text-sm disabled:opacity-50">
                  {savingPat ? 'Connecting...' : 'Connect'}
                </button>
              </div>
              <p className="text-xs text-gray-500">Requires <code className="text-gray-400">repo</code> scope</p>
            </div>
          )}

          {/* Inline GitLab OAuth setup form */}
          {showGitLabOAuth && (
            <div className="max-w-lg mx-auto mt-4 p-4 rounded-lg border border-gray-700 bg-gray-800/50 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-200">Connect GitLab</p>
                <button onClick={() => { setShowGitLabOAuth(false); setGlOAuthAppId(''); setGlOAuthSecret(''); }} className="text-gray-500 hover:text-gray-300">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Create an OAuth Application at <strong className="text-gray-400">GitLab &rarr; Preferences &rarr; Applications</strong> with redirect URI: <code className="text-gray-400">{window.location.origin}/api/gitlab-oauth/callback</code>
              </p>
              <input
                value={glOAuthAppId}
                onChange={(e) => setGlOAuthAppId(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                placeholder="Application ID"
                autoFocus
              />
              <input
                type="password"
                value={glOAuthSecret}
                onChange={(e) => setGlOAuthSecret(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveGlOAuth()}
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                placeholder="Secret"
              />
              <button onClick={handleSaveGlOAuth} disabled={savingGlOAuth || !glOAuthAppId.trim() || !glOAuthSecret.trim()} className="btn-primary text-sm disabled:opacity-50">
                {savingGlOAuth ? 'Connecting...' : 'Connect to GitLab'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {orgGroups.map((group) => (
            <div key={group.org} className="card p-0 overflow-hidden">
              {/* Org Header */}
              <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between bg-gray-900/80">
                <div className="flex items-center gap-3">
                  {group.provider === 'github' ? (
                    <svg className="w-4 h-4 text-gray-400" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                  ) : group.provider === 'gitlab' ? (
                    <svg className="w-4 h-4 text-orange-400" viewBox="0 0 32 32" fill="currentColor">
                      <path d="M16 28.896L21.323 12.576H10.677L16 28.896Z" />
                      <path d="M16 28.896L10.677 12.576H2.867L16 28.896Z" opacity="0.7" />
                      <path d="M2.867 12.576H10.677L7.334 2.279C7.155 1.736 6.393 1.736 6.214 2.279L2.867 12.576Z" />
                      <path d="M16 28.896L21.323 12.576H29.133L16 28.896Z" opacity="0.7" />
                      <path d="M29.133 12.576H21.323L24.666 2.279C24.845 1.736 25.607 1.736 25.786 2.279L29.133 12.576Z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
                    </svg>
                  )}
                  <span className="font-semibold text-gray-200 text-sm">{group.org}</span>
                  {group.provider === 'local' && (
                    <Pill variant="success">Local</Pill>
                  )}
                  <span className="text-xs text-gray-500">
                    {group.repos.length} {group.repos.length === 1 ? 'repo' : 'repos'}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span>{group.totalCommits} commits</span>
                  <span>{group.totalSessions} sessions</span>
                  <button
                    onClick={() => handleSyncAll(group)}
                    className="text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    Sync all
                  </button>
                </div>
              </div>

              {/* Repo Rows */}
              <div className="divide-y divide-gray-800/50">
                {group.repos.map((repo) => (
                  <div
                    key={repo.id}
                    className="flex items-center gap-4 px-5 py-2.5 hover:bg-gray-800/30 transition-colors cursor-pointer group"
                    onClick={() => navigate(`/repos/${repo.id}`)}
                  >
                    {/* Name */}
                    <div className="min-w-0 flex-1">
                      <span className="text-sm text-gray-200 group-hover:text-indigo-400 transition-colors font-medium">
                        {repo.name}
                      </span>
                    </div>

                    {/* Stats - compact inline */}
                    <div className="flex items-center gap-4 text-xs text-gray-500 flex-shrink-0">
                      <span className="w-16 text-right" title="Commits">
                        <span className="text-gray-300">{repo._count?.commits ?? 0}</span> commits
                      </span>
                      <span className="w-16 text-right" title="Sessions">
                        <span className="text-gray-300">{repo._count?.sessions ?? 0}</span> sessions
                      </span>
                      <span className="w-14 text-right text-gray-600" title="Last synced">
                        {timeAgo(repo.syncedAt)}
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSync(repo.id);
                        }}
                        disabled={syncing[repo.id]}
                        className="text-xs text-gray-400 hover:text-indigo-400 transition-colors px-2 py-1 rounded hover:bg-gray-800"
                        title="Fetch commits"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${syncing[repo.id] ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleArchive(repo.id, true);
                        }}
                        disabled={archiving[repo.id]}
                        className="text-xs text-gray-400 hover:text-amber-400 transition-colors px-2 py-1 rounded hover:bg-gray-800"
                        title="Archive repo"
                      >
                        <Archive className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(repo);
                        }}
                        className="text-xs text-gray-400 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-gray-800"
                        title="Delete repo"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Sync result inline */}
                    {syncResult[repo.id] && (
                      <span
                        className={`text-[10px] flex-shrink-0 ${
                          syncResult[repo.id] === 'Failed' ? 'text-red-400' : 'text-green-400'
                        }`}
                      >
                        {syncResult[repo.id]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Archived Repos Toggle */}
      <div className="pt-2">
        <button
          onClick={() => {
            const next = !showArchived;
            setShowArchived(next);
            if (next) fetchArchivedRepos();
          }}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1.5"
        >
          <svg className={`w-3.5 h-3.5 transition-transform ${showArchived ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          Archived repositories {archivedRepos.length > 0 && `(${archivedRepos.length})`}
        </button>

        {showArchived && archivedRepos.length > 0 && (
          <div className="mt-3 card p-0 overflow-hidden opacity-60">
            <div className="px-5 py-3 border-b border-gray-800 bg-gray-900/80">
              <span className="font-semibold text-gray-400 text-sm">Archived</span>
            </div>
            <div className="divide-y divide-gray-800/50">
              {archivedRepos.map((repo) => (
                <div
                  key={repo.id}
                  className="flex items-center gap-4 px-5 py-2.5 group"
                >
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-gray-400 font-medium">{repo.name}</span>
                    <span className="text-xs text-gray-600 ml-2">{repo.path}</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-500 flex-shrink-0">
                    <span>{repo._count?.commits ?? 0} commits</span>
                    <span>{repo._count?.sessions ?? 0} sessions</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handleArchive(repo.id, false)}
                      disabled={archiving[repo.id]}
                      className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-1"
                      title="Unarchive"
                    >
                      Restore
                    </button>
                    <button
                      onClick={() => setDeleteTarget({ id: repo.id, name: repo.name })}
                      disabled={deleting[repo.id]}
                      className="text-xs text-red-400/60 hover:text-red-400 transition-colors px-2 py-1 flex items-center gap-1"
                      title="Permanently delete"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {showArchived && archivedRepos.length === 0 && (
          <p className="mt-2 text-xs text-gray-600 ml-5">No archived repositories</p>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Repository"
        message={`Delete "${deleteTarget?.name}"? All commits and sessions will be removed.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
