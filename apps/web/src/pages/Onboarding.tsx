import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from '../components/Logo';
import { request } from '../api/_client';
import * as api from '../api';
import type { GitHubDiscoveredRepo, GitLabDiscoveredRepo } from '../api/repos';

// ── Agent configs ───────────────────────────────────────────────────────────
const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', icon: '🟣', color: 'border-purple-500/40 bg-purple-500/10' },
  { id: 'cursor', name: 'Cursor', icon: '🔵', color: 'border-blue-500/40 bg-blue-500/10' },
  { id: 'gemini-cli', name: 'Gemini CLI', icon: '🟡', color: 'border-amber-500/40 bg-amber-500/10' },
  { id: 'codex', name: 'Codex', icon: '🟢', color: 'border-green-500/40 bg-green-500/10' },
  { id: 'copilot', name: 'GitHub Copilot', icon: '⚪', color: 'border-gray-500/40 bg-gray-500/10' },
  { id: 'windsurf', name: 'Windsurf', icon: '🌊', color: 'border-cyan-500/40 bg-cyan-500/10' },
  { id: 'aider', name: 'Aider', icon: '🔧', color: 'border-orange-500/40 bg-orange-500/10' },
  { id: 'other', name: 'Other', icon: '➕', color: 'border-gray-600/40 bg-gray-600/10' },
];

const TOTAL_STEPS = 5;

// ── Step indicator ──────────────────────────────────────────────────────────
function Steps({ current }: { current: number }) {
  const steps = ['AI Tools', 'Connect', 'Import Repos', 'AI Summaries', 'Install CLI', 'First Session'];
  return (
    <div className="flex items-center justify-center gap-1.5 mb-8">
      {steps.map((label, i) => (
        <React.Fragment key={i}>
          <div className="flex items-center gap-1.5">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
              i < current ? 'bg-emerald-600 text-white' :
              i === current ? 'bg-indigo-600 text-white ring-2 ring-indigo-400/30' :
              'bg-gray-800 text-gray-500'
            }`}>
              {i < current ? '✓' : i + 1}
            </div>
            <span className={`text-xs font-medium hidden sm:inline ${
              i === current ? 'text-gray-200' : 'text-gray-500'
            }`}>{label}</span>
          </div>
          {i < steps.length - 1 && <div className={`w-6 h-px ${i < current ? 'bg-emerald-600' : 'bg-gray-800'}`} />}
        </React.Fragment>
      ))}
    </div>
  );
}

// ── Copy button ─────────────────────────────────────────────────────────────
function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div
      onClick={copy}
      className="group flex items-center gap-3 bg-gray-950 border border-white/[0.06] rounded-lg px-4 py-3 cursor-pointer hover:border-white/[0.12] transition-colors"
    >
      <span className="text-indigo-400 font-mono text-xs">$</span>
      <code className="text-sm font-mono text-gray-300 flex-1 select-all break-all">{text}</code>
      <span className={`text-xs shrink-0 transition-colors ${copied ? 'text-emerald-400' : 'text-gray-600 group-hover:text-gray-400'}`}>
        {copied ? 'Copied!' : 'Copy'}
      </span>
    </div>
  );
}

// ── GitHub / GitLab SVGs ────────────────────────────────────────────────────
function GitHubIcon({ className }: { className?: string }) {
  return <svg className={className || 'w-6 h-6'} viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>;
}

function GitLabIcon({ className }: { className?: string }) {
  return <svg className={className || 'w-6 h-6'} viewBox="0 0 24 24" fill="currentColor"><path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.452.044 13.587a.924.924 0 00.331 1.023L12 23.054l11.625-8.443a.92.92 0 00.33-1.024"/></svg>;
}

// ═══════════════════════════════════════════════════════════════════════════════
export default function Onboarding() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Determine initial step — if returning from GitHub/GitLab OAuth, jump to step 1 (connect repos)
  const [step, setStep] = useState(() => {
    const s = searchParams.get('step');
    if (s) return parseInt(s, 10);
    if (searchParams.get('github_app') || searchParams.get('gitlab_oauth')) return 1;
    return 0;
  });

  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [apiKey] = useState(() => {
    try { return sessionStorage.getItem('origin:onboarding-key') || ''; } catch { return ''; }
  });
  const [polling, setPolling] = useState(false);
  const [sessionFound, setSessionFound] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  // GitHub/GitLab connection state
  const [githubConnected, setGithubConnected] = useState(false);
  const [gitlabConnected, setGitlabConnected] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Repo import state
  const [discoveredRepos, setDiscoveredRepos] = useState<(GitHubDiscoveredRepo | GitLabDiscoveredRepo & { _provider: string })[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importDone, setImportDone] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [repoSearch, setRepoSearch] = useState('');

  // Check integrations on mount + handle OAuth return params
  useEffect(() => {
    const checkIntegrations = async () => {
      try {
        const integrations = await api.getIntegrations();
        setGithubConnected(integrations.some((i: any) => i.provider === 'github'));
        setGitlabConnected(integrations.some((i: any) => i.provider === 'gitlab'));
      } catch { /* ignore */ }
    };
    checkIntegrations();

    // Handle GitHub App return
    const ghResult = searchParams.get('github_app');
    if (ghResult === 'success') {
      setGithubConnected(true);
      const p = new URLSearchParams(searchParams);
      p.delete('github_app');
      p.delete('installation_id');
      setSearchParams(p, { replace: true });
    }

    // Handle GitLab OAuth return
    const glResult = searchParams.get('gitlab_oauth');
    if (glResult === 'success') {
      setGitlabConnected(true);
      const p = new URLSearchParams(searchParams);
      p.delete('gitlab_oauth');
      setSearchParams(p, { replace: true });
    }
  }, []);

  // Redirect non-developers
  useEffect(() => {
    if (user && user.accountType !== 'developer') {
      navigate('/dashboard', { replace: true });
    }
  }, [user, navigate]);

  // Poll for first session in step 3
  useEffect(() => {
    if (step !== 5 || !polling) return;
    const check = async () => {
      try {
        const stats = await request<{ totalSessions: number }>('/api/stats/me');
        if (stats && stats.totalSessions > 0) {
          setSessionFound(true);
          setPolling(false);
          try { sessionStorage.removeItem('origin:onboarding-key'); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    };
    check();
    pollRef.current = setInterval(check, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [step, polling]);

  const toggleAgent = (id: string) => {
    setSelectedAgents(prev =>
      prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]
    );
  };

  const goToDashboard = () => {
    try {
      sessionStorage.removeItem('origin:onboarding-key');
      localStorage.setItem('origin:hide-guide', '1');
    } catch { /* ignore */ }
    navigate('/me', { replace: true });
  };

  // Discover repos from connected providers
  const discoverRepos = async () => {
    setDiscovering(true);
    setDiscoveredRepos([]);
    try {
      const all: any[] = [];
      if (githubConnected) {
        try {
          const gh = await api.discoverGitHubRepos();
          all.push(...(gh.repos || []).map((r: any) => ({ ...r, _provider: 'github', _key: r.fullName })));
        } catch { /* ignore */ }
      }
      if (gitlabConnected) {
        try {
          const gl = await api.discoverGitLabRepos();
          all.push(...(gl.repos || []).map((r: any) => ({ ...r, _provider: 'gitlab', _key: r.fullPath })));
        } catch { /* ignore */ }
      }
      setDiscoveredRepos(all);
      // Auto-select repos that aren't already imported
      const notImported = new Set(all.filter((r: any) => !r.alreadyImported).map((r: any) => r._key));
      setSelectedRepos(notImported);
    } catch { /* ignore */ }
    setDiscovering(false);
  };

  const importSelectedRepos = async () => {
    setImporting(true);
    let count = 0;
    try {
      const ghRepos = discoveredRepos.filter((r: any) => r._provider === 'github' && selectedRepos.has(r._key) && !r.alreadyImported);
      const glRepos = discoveredRepos.filter((r: any) => r._provider === 'gitlab' && selectedRepos.has(r._key) && !r.alreadyImported);

      if (ghRepos.length > 0) {
        const res = await api.importGitHubRepos(ghRepos.map((r: any) => ({ fullName: r.fullName, name: r.name })));
        count += (res.results || []).filter((r: any) => r.success).length;
        // Trigger sync for imported repos (fire and forget)
        for (const r of (res.results || [])) {
          if (r.success && r.repoId) api.syncRepo(r.repoId).catch(() => {});
        }
      }
      if (glRepos.length > 0) {
        const res = await api.importGitLabRepos(glRepos.map((r: any) => ({ fullPath: r.fullPath, name: r.name })));
        count += (res.results || []).filter((r: any) => r.success).length;
        for (const r of (res.results || [])) {
          if (r.success && r.repoId) api.syncRepo(r.repoId).catch(() => {});
        }
      }
    } catch { /* ignore */ }
    setImportedCount(count);
    setImportDone(true);
    setImporting(false);
  };

  const toggleRepo = (key: string) => {
    setSelectedRepos(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllRepos = () => {
    const importable = discoveredRepos.filter((r: any) => !r.alreadyImported);
    if (selectedRepos.size === importable.length) {
      setSelectedRepos(new Set());
    } else {
      setSelectedRepos(new Set(importable.map((r: any) => r._key)));
    }
  };

  const handleConnectGitHub = async () => {
    setConnecting('github');
    setConnectError(null);
    try {
      // Save onboarding state so we resume after redirect
      sessionStorage.setItem('origin:onboarding-step', '1');
      const { installUrl } = await api.getGitHubAppInstallUrl({ from: 'onboarding' });
      window.location.href = installUrl;
    } catch (err: any) {
      setConnectError(err.message || 'Failed to start GitHub connection');
      setConnecting(null);
    }
  };

  const handleConnectGitLab = async () => {
    setConnecting('gitlab');
    setConnectError(null);
    try {
      sessionStorage.setItem('origin:onboarding-step', '1');
      const { authorizeUrl } = await api.getGitLabOAuthInstallUrl({ from: 'onboarding' });
      window.location.href = authorizeUrl;
    } catch (err: any) {
      setConnectError(err.message || 'Failed to start GitLab connection');
      setConnecting(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-8 md:py-12">
      {/* Decorative background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-indigo-600/[0.04] rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-[400px] h-[400px] bg-emerald-600/[0.04] rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-xl">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <LogoMark size={36} variant="solo" />
          <span className="text-lg font-semibold">Origin Solo</span>
        </div>

        <Steps current={step} />

        {/* ─── STEP 1: AI Tools ───────────────────────────────────────────── */}
        {step === 0 && (
          <div className="animate-fade-in space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-white">Which AI tools do you use?</h1>
              <p className="text-sm text-gray-400 mt-2">
                Select the agents you code with. Origin will track sessions from all of them.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {AGENTS.map(agent => {
                const selected = selectedAgents.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    onClick={() => toggleAgent(agent.id)}
                    className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border text-left transition-all ${
                      selected
                        ? `${agent.color} ring-1 ring-white/[0.1]`
                        : 'border-white/[0.06] bg-gray-900/40 hover:border-white/[0.12] hover:bg-gray-900/60'
                    }`}
                  >
                    <span className="text-xl">{agent.icon}</span>
                    <span className={`text-sm font-medium ${selected ? 'text-white' : 'text-gray-300'}`}>{agent.name}</span>
                    {selected && <span className="ml-auto text-emerald-400 text-sm">✓</span>}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button onClick={goToDashboard} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                Skip setup
              </button>
              <button
                onClick={() => setStep(1)}
                className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                Continue &rarr;
              </button>
            </div>
          </div>
        )}

        {/* ─── STEP 2: Connect Repos ──────────────────────────────────────── */}
        {step === 1 && (
          <div className="animate-fade-in space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-white">Connect your repositories</h1>
              <p className="text-sm text-gray-400 mt-2">
                Link GitHub or GitLab to automatically import repos and sync commits.
              </p>
            </div>

            {connectError && (
              <div className="p-3 rounded-lg bg-red-900/30 border border-red-800 text-red-400 text-sm">
                {connectError}
              </div>
            )}

            <div className="space-y-3">
              {/* GitHub */}
              <div className={`rounded-xl border p-5 transition-all ${
                githubConnected
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-white/[0.08] bg-gray-900/40'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                      githubConnected ? 'bg-emerald-500/15 text-emerald-400' : 'bg-gray-800 text-gray-300'
                    }`}>
                      <GitHubIcon />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-200">GitHub</p>
                      <p className="text-xs text-gray-500">
                        {githubConnected ? 'Connected — repos will sync automatically' : 'Connect to import repos and enable PR checks'}
                      </p>
                    </div>
                  </div>
                  {githubConnected ? (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Connected
                    </span>
                  ) : (
                    <button
                      onClick={handleConnectGitHub}
                      disabled={connecting === 'github'}
                      className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 border border-white/[0.08] text-sm font-medium text-white transition-colors disabled:opacity-50"
                    >
                      {connecting === 'github' ? 'Connecting...' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>

              {/* GitLab */}
              <div className={`rounded-xl border p-5 transition-all ${
                gitlabConnected
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-white/[0.08] bg-gray-900/40'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                      gitlabConnected ? 'bg-emerald-500/15 text-emerald-400' : 'bg-gray-800 text-orange-400'
                    }`}>
                      <GitLabIcon />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-200">GitLab</p>
                      <p className="text-xs text-gray-500">
                        {gitlabConnected ? 'Connected — repos will sync automatically' : 'Connect to import repos via OAuth'}
                      </p>
                    </div>
                  </div>
                  {gitlabConnected ? (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Connected
                    </span>
                  ) : (
                    <button
                      onClick={handleConnectGitLab}
                      disabled={connecting === 'gitlab'}
                      className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 border border-white/[0.08] text-sm font-medium text-white transition-colors disabled:opacity-50"
                    >
                      {connecting === 'gitlab' ? 'Connecting...' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>

              {/* No repos / manual note */}
              <div className="rounded-xl border border-white/[0.06] bg-gray-900/20 p-4">
                <p className="text-xs text-gray-500 leading-relaxed">
                  <strong className="text-gray-400">Don't use GitHub or GitLab?</strong> No problem — Origin tracks any local git repo.
                  Just run <code className="text-indigo-400 bg-indigo-500/10 px-1 py-0.5 rounded text-[11px]">origin init</code> in
                  any project. You can always connect a provider later from Settings.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button onClick={() => setStep(0)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                &larr; Back
              </button>
              <button
                onClick={() => {
                  if (githubConnected || gitlabConnected) {
                    setStep(2);
                    // Auto-discover repos when entering import step
                    setTimeout(discoverRepos, 100);
                  } else {
                    setStep(3); // Skip import if nothing connected
                  }
                }}
                className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                {githubConnected || gitlabConnected ? 'Continue' : 'Skip for now'} &rarr;
              </button>
            </div>
          </div>
        )}

        {/* ─── STEP 3: Import Repos ──────────────────────────────────────── */}
        {step === 2 && (
          <div className="animate-fade-in space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-white">Import your repositories</h1>
              <p className="text-sm text-gray-400 mt-2">
                Select repos to track. Sessions started in these repos will auto-link to them.
              </p>
            </div>

            {discovering ? (
              <div className="flex flex-col items-center gap-3 py-12">
                <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-gray-400">Discovering repositories...</p>
              </div>
            ) : discoveredRepos.length === 0 ? (
              <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-8 text-center">
                <p className="text-sm text-gray-400">No repositories found. You can import repos later from the Repos page.</p>
              </div>
            ) : (
              <>
                {/* Search + Select All */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={repoSearch}
                      onChange={e => setRepoSearch(e.target.value)}
                      placeholder="Search repos..."
                      className="w-full bg-gray-950 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500/50"
                    />
                  </div>
                  <button
                    onClick={toggleAllRepos}
                    className="text-xs text-indigo-400 hover:text-indigo-300 whitespace-nowrap"
                  >
                    {selectedRepos.size === discoveredRepos.filter((r: any) => !r.alreadyImported).length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>

                {/* Repo list */}
                <div className="max-h-[340px] overflow-y-auto space-y-1.5 rounded-xl border border-white/[0.06] bg-gray-950/50 p-2">
                  {discoveredRepos
                    .filter((r: any) => {
                      if (!repoSearch) return true;
                      const s = repoSearch.toLowerCase();
                      return (r._key || '').toLowerCase().includes(s) || (r.name || '').toLowerCase().includes(s);
                    })
                    .map((repo: any) => {
                      const isImported = repo.alreadyImported;
                      const isSelected = selectedRepos.has(repo._key);
                      return (
                        <button
                          key={repo._key}
                          onClick={() => !isImported && toggleRepo(repo._key)}
                          disabled={isImported}
                          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
                            isImported
                              ? 'opacity-40 cursor-not-allowed'
                              : isSelected
                                ? 'bg-indigo-500/10 border border-indigo-500/30'
                                : 'hover:bg-gray-900/60 border border-transparent'
                          }`}
                        >
                          {/* Checkbox */}
                          <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                            isImported ? 'border-gray-700 bg-gray-800' :
                            isSelected ? 'border-indigo-500 bg-indigo-600' : 'border-gray-600'
                          }`}>
                            {(isSelected || isImported) && <span className="text-[10px] text-white">✓</span>}
                          </div>
                          {/* Provider icon */}
                          <span className="text-gray-500 shrink-0">
                            {repo._provider === 'github' ? <GitHubIcon className="w-4 h-4" /> : <GitLabIcon className="w-4 h-4" />}
                          </span>
                          {/* Name */}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-200 truncate">{repo._key}</p>
                            {repo.private && <span className="text-[10px] text-gray-600">private</span>}
                          </div>
                          {isImported && (
                            <span className="text-[10px] text-gray-500 shrink-0">already imported</span>
                          )}
                        </button>
                      );
                    })}
                </div>

                {importDone && (
                  <div className="p-3 rounded-lg bg-emerald-900/30 border border-emerald-800 text-emerald-400 text-sm">
                    ✓ Imported {importedCount} repo{importedCount !== 1 ? 's' : ''}. Commits are syncing in the background.
                  </div>
                )}

                {/* Import count */}
                {!importDone && (
                  <p className="text-xs text-gray-500 text-center">
                    {selectedRepos.size} repo{selectedRepos.size !== 1 ? 's' : ''} selected
                  </p>
                )}
              </>
            )}

            <div className="flex items-center justify-between pt-2">
              <button onClick={() => setStep(1)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                &larr; Back
              </button>
              <div className="flex items-center gap-3">
                {!importDone && selectedRepos.size > 0 && discoveredRepos.length > 0 && (
                  <button
                    onClick={importSelectedRepos}
                    disabled={importing}
                    className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {importing ? 'Importing...' : `Import ${selectedRepos.size} repo${selectedRepos.size !== 1 ? 's' : ''}`}
                  </button>
                )}
                <button
                  onClick={() => setStep(3)}
                  className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
                >
                  {importDone ? 'Continue' : discoveredRepos.length === 0 ? 'Continue' : 'Skip'} &rarr;
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── STEP 4: AI Summaries — optional org-level LLM key ─────────── */}
        {step === 3 && (
          <AiSummariesStep onContinue={() => setStep(4)} onBack={() => setStep(2)} />
        )}

        {/* ─── STEP 5: Install & Connect ──────────────────────────────────── */}
        {step === 4 && (
          <div className="animate-fade-in space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-white">Install &amp; Connect the CLI</h1>
              <p className="text-sm text-gray-400 mt-2">
                Three commands and you're tracking every AI session.
              </p>
            </div>

            <div className="space-y-4">
              {/* Install */}
              <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold">1</span>
                  <span className="text-sm font-semibold text-gray-200">Install the CLI</span>
                </div>
                <CopyBlock text="npm i -g https://getorigin.io/cli/origin-cli-latest.tgz" />
                <p className="text-xs text-gray-600 mt-2">macOS, Linux, WSL. Requires Node.js 18+.</p>
              </div>

              {/* Login */}
              <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold">2</span>
                  <span className="text-sm font-semibold text-gray-200">Login with your API key</span>
                </div>
                {apiKey ? (
                  <>
                    <CopyBlock text={`origin login --key ${apiKey}`} />
                    <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <p className="text-xs text-amber-400">
                        <strong>Save this key!</strong> It won't be shown again. Manage keys in{' '}
                        <a href="/api-keys" className="underline hover:text-amber-300">Settings &rarr; API Keys</a>.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-gray-400 mb-2">
                      Go to <a href="/api-keys" className="text-emerald-400 hover:text-emerald-300 underline">API Keys</a> to create a key, then:
                    </p>
                    <CopyBlock text="origin login --key YOUR_API_KEY" />
                  </>
                )}
              </div>

              {/* Init */}
              <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold">3</span>
                  <span className="text-sm font-semibold text-gray-200">Initialize in your project</span>
                </div>
                <CopyBlock text="cd ~/your-project && origin init" />
                <p className="text-xs text-gray-600 mt-2">
                  Auto-detects {selectedAgents.length > 0
                    ? selectedAgents.map(id => AGENTS.find(a => a.id === id)?.name).filter(Boolean).join(', ')
                    : 'Claude Code, Cursor, Copilot, Gemini'
                  } and installs git hooks.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button onClick={() => setStep(3)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                &larr; Back
              </button>
              <button
                onClick={() => { setStep(5); setPolling(true); }}
                className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                I've run the commands &rarr;
              </button>
            </div>
          </div>
        )}

        {/* ─── STEP 6: Waiting for first session ──────────────────────────── */}
        {step === 5 && (
          <div className="animate-fade-in space-y-6">
            <div className="text-center">
              {sessionFound ? (
                <>
                  <div className="w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
                    <span className="text-3xl">🎉</span>
                  </div>
                  <h1 className="text-2xl font-bold text-white">First session detected!</h1>
                  <p className="text-sm text-gray-400 mt-2">
                    Origin is now tracking your AI coding sessions.
                  </p>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center mx-auto mb-4">
                    <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                  <h1 className="text-2xl font-bold text-white">Listening for your first session...</h1>
                  <p className="text-sm text-gray-400 mt-2">
                    Open a project where you ran <code className="text-indigo-400 text-xs bg-indigo-500/10 px-1.5 py-0.5 rounded">origin init</code> and start coding with any AI agent.
                  </p>
                </>
              )}
            </div>

            {!sessionFound && (
              <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-5 space-y-4">
                <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider">What to do now</p>
                <div className="space-y-3">
                  {[
                    { n: '1', title: 'Open your project in terminal', sub: 'Make sure you ran origin init in this project' },
                    { n: '2', title: 'Start any AI coding agent', sub: 'Claude Code, Cursor, Gemini CLI — any will work' },
                    { n: '3', title: 'Make a commit', sub: 'Origin hooks fire on git commit, capturing the session' },
                  ].map(item => (
                    <div key={item.n} className="flex items-start gap-3">
                      <span className="text-emerald-400 mt-0.5">{item.n}.</span>
                      <div>
                        <p className="text-sm text-gray-200">{item.title}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{item.sub}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => { setPolling(false); setStep(4); }}
                className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
              >
                &larr; Back
              </button>
              <button
                onClick={goToDashboard}
                className={`px-6 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  sessionFound
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-white/[0.08]'
                }`}
              >
                {sessionFound ? 'Go to my dashboard 🚀' : 'Skip — go to dashboard'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AI Summaries onboarding step ──────────────────────────────────────────
//
// Optional. The org admin can paste an Anthropic / OpenAI API key here and
// every session in the dashboard gets a real AI-generated label
// ("Refactored auth middleware") instead of the heuristic first-line
// fallback. Skipping is fine — the heuristic still works.
function AiSummariesStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const [provider, setProvider] = React.useState<'anthropic' | 'openai'>('anthropic');
  const [apiKey, setApiKey] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState('');

  const save = async () => {
    setError('');
    setSaving(true);
    try {
      // /api/settings/chat is the canonical LLM-key endpoint — same row
      // backs Chat, AI session titles, and any future LLM features.
      const res = await fetch('/api/settings/chat', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, llmProvider: provider }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      setSaved(true);
      setTimeout(onContinue, 600);
    } catch (err: any) {
      setError(err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="animate-fade-in space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white">AI Summaries (optional)</h1>
        <p className="text-sm text-gray-400 mt-2">
          Drop in an Anthropic or OpenAI key and every session gets a real one-line
          label like "Refactored auth middleware" instead of the first prompt's first line.
        </p>
      </div>

      <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-5 space-y-4">
        {/* Provider toggle */}
        <div className="flex gap-2">
          {(['anthropic', 'openai'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setProvider(p)}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                provider === p
                  ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40'
                  : 'bg-gray-900/40 text-gray-400 border-white/[0.06] hover:text-gray-200'
              }`}
            >
              {p === 'anthropic' ? 'Anthropic (Claude Haiku)' : 'OpenAI (gpt-4o-mini)'}
            </button>
          ))}
        </div>

        {/* Key input */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block">
            {provider === 'anthropic' ? 'Anthropic API key' : 'OpenAI API key'}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
            className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-white/[0.08] text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-indigo-500/50 font-mono"
            autoComplete="off"
          />
          <p className="text-[11px] text-gray-600 mt-1.5">
            Stored on your org. Used only to generate session titles. You can change or remove it later in Settings → AI.
          </p>
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}
        {saved && <div className="text-xs text-emerald-400">Saved — generating titles for past sessions in the background.</div>}
      </div>

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
          &larr; Back
        </button>
        <div className="flex items-center gap-3">
          <button
            onClick={onContinue}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            Skip for now
          </button>
          <button
            onClick={save}
            disabled={saving || apiKey.trim().length < 10}
            className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save & continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
