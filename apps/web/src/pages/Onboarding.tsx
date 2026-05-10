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
// `labels` lets the caller pass a slimmed step list for invited members
// (who skip the admin-only Connect / Import / AI Summaries steps). Falls
// back to the full solo-signup labels when not provided.
function Steps({ current, labels }: { current: number; labels?: string[] }) {
  const steps = labels ?? ['AI Tools', 'Connect', 'Import Repos', 'AI Summaries', 'Install CLI', 'First Session'];
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

  // `?from=invite` slims the wizard to the steps relevant to a brand-new
  // team member: AI Tools → Install CLI → First Session. Connect / Import
  // / AI Summaries are admin-only, so we route around them. Drives both
  // the step indicator and the next/back navigation below.
  const fromInvite = searchParams.get('from') === 'invite';
  // Team-admin mode: the wizard takes the same shape but inserts a
  // team-only "Invite teammates" step between Import Repos and AI
  // Summaries. Branding swaps to "Origin Team" so the admin doesn't
  // walk through a flow titled "Origin Solo." Step 7 is the new invite
  // step (lazily numbered to avoid renumbering existing branches).
  const fromTeam = searchParams.get('from') === 'team';
  // Invited members run a slim 3-step flow. We used to tack on a
  // "First Session" polling page after Install CLI, but that doubled
  // the perceived CLI setup work — Install CLI already lists the three
  // commands they need; the polling page added no new instructions, just
  // a wait. Drop it; they land on /me where the same listener lives if
  // they want to confirm.
  const inviteLabels = ['AI Tools', 'Your Access', 'Install CLI'];
  // Team admins finish at AI Summaries — Install CLI / First Session
  // are individual-developer steps that the invited teammates each run
  // through in their own (`?from=invite`) onboarding. Forcing them on
  // the org admin just blocks them from reaching the dashboard for a
  // task they don't need to do as admin.
  const teamLabels = ['AI Tools', 'Connect', 'Import Repos', 'Invite Team', 'AI Summaries'];
  // Map a real step (0..7) to its position in whichever progress
  // indicator we're rendering. Solo and team share most steps; team
  // injects step 7 (Invite Team) between 2 and 3.
  const visualStep = (s: number) => {
    if (fromInvite) {
      if (s === 0) return 0; // AI Tools
      if (s === 6) return 1; // Your Access
      if (s === 4) return 2; // Install CLI (final step for invitees)
      return 0;
    }
    if (fromTeam) {
      if (s === 0) return 0; // AI Tools
      if (s === 1) return 1; // Connect
      if (s === 2) return 2; // Import Repos
      if (s === 7) return 3; // Invite Team
      if (s === 3) return 4; // AI Summaries (final step for team admins)
      return 0;
    }
    return s;
  };

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
  // Per-provider discovery results so failures from one provider don't disappear silently
  const [providerStatus, setProviderStatus] = useState<{
    github?: { count: number; error?: string };
    gitlab?: { count: number; error?: string };
  }>({});

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

    // Handle GitLab OAuth return — both success and error. Previously a
    // failed callback silently dropped the user back on /settings; now
    // the OAuth handler routes onboarding errors back here, so we have
    // to actually render the message.
    const glResult = searchParams.get('gitlab_oauth');
    if (glResult === 'success') {
      setGitlabConnected(true);
      const p = new URLSearchParams(searchParams);
      p.delete('gitlab_oauth');
      p.delete('msg');
      setSearchParams(p, { replace: true });
    } else if (glResult === 'error') {
      const msg = searchParams.get('msg') || 'GitLab connection failed';
      setConnectError(`GitLab: ${msg}`);
      setGitlabConnected(false);
      const p = new URLSearchParams(searchParams);
      p.delete('gitlab_oauth');
      p.delete('msg');
      setSearchParams(p, { replace: true });
    }
  }, []);

  // Redirect non-developers — except when arriving from an invite
  // (`?from=invite`) or as a brand-new team admin (`?from=team`). Both
  // intentionally route org-account users through the wizard:
  // invite-mode runs the slimmed AI Tools → Your Access → Install CLI →
  // First Session flow; team-mode runs the full 6-step setup an admin
  // needs after creating a fresh team org.
  useEffect(() => {
    if (user && user.accountType !== 'developer' && !fromInvite && !fromTeam) {
      navigate('/dashboard', { replace: true });
    }
  }, [user, navigate, fromInvite, fromTeam]);

  // Recovery — mint a fresh CLI key when the local one's been invalidated.
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [mintingKey, setMintingKey] = useState(false);
  const [freshKeyError, setFreshKeyError] = useState<string | null>(null);

  // Diagnostic snapshot rendered under "Listening for your first session…"
  // so the user can see *why* nothing's appearing yet (no API key vs. no
  // repo vs. session attributed to a different user) instead of just an
  // unbounded spinner.
  const [debugSnapshot, setDebugSnapshot] = useState<{
    repoCount: number;
    apiKeyCount: number;
    sessionsForUser: number;
    sessionsInOrg: number;
    attributionMismatch: boolean;
    latestSession: { id: string; model: string; status: string; userId: string | null; createdAt: string } | null;
    latestApiKey: { id: string; name: string; userId: string | null; createdAt: string } | null;
  } | null>(null);

  // Poll for first session on the "First Session" step. We hit the
  // diagnostic endpoint instead of /stats/me so the UI can react to
  // partial progress (CLI talked to us but session attributed to a
  // different user, repo registered but no session yet, etc.) on the
  // same poll cycle that detects success.
  //
  // Auto-claim policy: if the diagnostic reports an attribution mismatch
  // (sessions exist in the org but tied to a deleted/previous user), we
  // silently POST /onboarding-claim once per onboarding step rather than
  // surfacing a scary red banner. The endpoint already gates this to
  // personal workspaces with the caller as OWNER, so it can't leak
  // teammate data — and on a single-user workspace there's no privacy
  // boundary to surface anyway. The user just sees the spinner flip to
  // "First session detected!" once the claim lands and the next poll
  // tick picks up sessionsForUser > 0.
  const claimAttemptedRef = useRef(false);
  useEffect(() => {
    if (step !== 5 || !polling) return;
    claimAttemptedRef.current = false; // reset when re-entering step
    const check = async () => {
      try {
        const dbg = await request<{
          repoCount: number;
          apiKeyCount: number;
          sessionsForUser: number;
          sessionsInOrg: number;
          attributionMismatch: boolean;
          latestSession: { id: string; model: string; status: string; userId: string | null; createdAt: string } | null;
          latestApiKey: { id: string; name: string; userId: string | null; createdAt: string } | null;
        }>('/api/stats/onboarding-debug');
        setDebugSnapshot(dbg);

        // Self-heal: auto-claim orphaned sessions on this poll cycle
        // instead of asking the user to click a button. We only try
        // once per step entry; if the claim 403s (e.g. team org) we
        // stop trying and the diagnostic strip falls back to a
        // neutral hint.
        if (dbg.attributionMismatch && !claimAttemptedRef.current) {
          claimAttemptedRef.current = true;
          try {
            await request<{ claimedSessions: number; claimedApiKeys: number }>(
              '/api/stats/onboarding-claim',
              { method: 'POST' },
            );
          } catch { /* claim refused — leave the diagnostic counters as-is */ }
        }

        if (dbg.sessionsForUser > 0) {
          setSessionFound(true);
          setPolling(false);
          try { sessionStorage.removeItem('origin:onboarding-key'); } catch { /* ignore */ }
        }
      } catch { /* ignore — keep polling */ }
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
    // Team admins land on the org dashboard; everyone else (solo /
    // invited developers) on the personal `/me` view.
    navigate(fromTeam ? '/dashboard' : '/me', { replace: true });
  };

  // Discover repos from connected providers. Errors from each provider are
  // captured into `providerStatus` so the import UI can surface them
  // (instead of the previous silent-swallow that made GitLab failures look
  // identical to GitHub-only success).
  const discoverRepos = async () => {
    setDiscovering(true);
    setDiscoveredRepos([]);
    setProviderStatus({});
    const all: any[] = [];
    const status: { github?: { count: number; error?: string }; gitlab?: { count: number; error?: string } } = {};

    if (githubConnected) {
      try {
        const gh = await api.discoverGitHubRepos();
        const repos = (gh.repos || []).map((r: any) => ({ ...r, _provider: 'github', _key: r.fullName }));
        all.push(...repos);
        status.github = { count: repos.length };
      } catch (err: any) {
        console.error('[onboarding] GitHub discovery failed:', err);
        status.github = { count: 0, error: err?.message || 'Failed to fetch GitHub repositories' };
      }
    }
    if (gitlabConnected) {
      try {
        const gl = await api.discoverGitLabRepos();
        const repos = (gl.repos || []).map((r: any) => ({ ...r, _provider: 'gitlab', _key: r.fullPath }));
        all.push(...repos);
        status.gitlab = { count: repos.length };
      } catch (err: any) {
        console.error('[onboarding] GitLab discovery failed:', err);
        status.gitlab = { count: 0, error: err?.message || 'Failed to fetch GitLab repositories' };
      }
    }

    setDiscoveredRepos(all);
    setProviderStatus(status);
    // Auto-select repos that aren't already imported
    const notImported = new Set(all.filter((r: any) => !r.alreadyImported).map((r: any) => r._key));
    setSelectedRepos(notImported);
    setDiscovering(false);
  };

  const importSelectedRepos = async () => {
    setImporting(true);
    let count = 0;
    const importErrors: string[] = [];
    const ghRepos = discoveredRepos.filter((r: any) => r._provider === 'github' && selectedRepos.has(r._key) && !r.alreadyImported);
    const glRepos = discoveredRepos.filter((r: any) => r._provider === 'gitlab' && selectedRepos.has(r._key) && !r.alreadyImported);

    if (ghRepos.length > 0) {
      try {
        const res = await api.importGitHubRepos(ghRepos.map((r: any) => ({ fullName: r.fullName, name: r.name })));
        count += (res.results || []).filter((r: any) => r.success).length;
        const failed = (res.results || []).filter((r: any) => !r.success);
        if (failed.length) importErrors.push(`GitHub: ${failed.length} failed (${failed[0]?.error || 'unknown'})`);
        for (const r of (res.results || [])) {
          if (r.success && r.repoId) api.syncRepo(r.repoId).catch(() => {});
        }
      } catch (err: any) {
        console.error('[onboarding] GitHub import failed:', err);
        importErrors.push(`GitHub: ${err?.message || 'import request failed'}`);
      }
    }
    if (glRepos.length > 0) {
      try {
        const res = await api.importGitLabRepos(glRepos.map((r: any) => ({ fullPath: r.fullPath, name: r.name })));
        count += (res.results || []).filter((r: any) => r.success).length;
        const failed = (res.results || []).filter((r: any) => !r.success);
        if (failed.length) importErrors.push(`GitLab: ${failed.length} failed (${failed[0]?.error || 'unknown'})`);
        for (const r of (res.results || [])) {
          if (r.success && r.repoId) api.syncRepo(r.repoId).catch(() => {});
        }
      } catch (err: any) {
        console.error('[onboarding] GitLab import failed:', err);
        importErrors.push(`GitLab: ${err?.message || 'import request failed'}`);
      }
    }
    setImportedCount(count);
    if (importErrors.length) {
      setProviderStatus(prev => ({
        ...prev,
        gitlab: prev.gitlab ? { ...prev.gitlab, error: importErrors.find(e => e.startsWith('GitLab')) || prev.gitlab.error } : prev.gitlab,
        github: prev.github ? { ...prev.github, error: importErrors.find(e => e.startsWith('GitHub')) || prev.github.error } : prev.github,
      }));
    }
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
      const flavor = fromTeam ? 'team' : fromInvite ? 'invite' : '';
      const { installUrl } = await api.getGitHubAppInstallUrl({ from: 'onboarding', flavor });
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
      const flavor = fromTeam ? 'team' : fromInvite ? 'invite' : '';
      const { authorizeUrl } = await api.getGitLabOAuthInstallUrl({ from: 'onboarding', flavor });
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
          <span className="text-lg font-semibold">{fromTeam ? 'Origin Team' : fromInvite ? 'Origin Member' : 'Origin Solo'}</span>
        </div>

        <Steps current={visualStep(step)} labels={fromInvite ? inviteLabels : (fromTeam ? teamLabels : undefined)} />

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
                onClick={() => setStep(fromInvite ? 6 : 1)}
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
                  Just run <code className="text-indigo-400 bg-indigo-500/10 px-1 py-0.5 rounded text-[11px]">origin enable</code> in
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
                    // Skip import if nothing connected. Team admins jump
                    // to Invite Team (7) so they don't lose the team-only
                    // step; solo / dev jumps straight to AI Summaries (3).
                    setStep(fromTeam ? 7 : 3);
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

            {/* Per-provider status banners — make GitHub-only / GitLab-only failures
                visible instead of silently dropping them. */}
            {!discovering && (providerStatus.github || providerStatus.gitlab) && (
              <div className="space-y-2">
                {providerStatus.github && (
                  <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                    providerStatus.github.error
                      ? 'border-red-500/30 bg-red-500/5 text-red-300'
                      : providerStatus.github.count === 0
                        ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
                        : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
                  }`}>
                    <GitHubIcon className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-medium">GitHub:</span>
                    <span>
                      {providerStatus.github.error
                        ? providerStatus.github.error
                        : providerStatus.github.count === 0
                          ? 'No repositories found for this account'
                          : `${providerStatus.github.count} repo${providerStatus.github.count === 1 ? '' : 's'}`}
                    </span>
                  </div>
                )}
                {providerStatus.gitlab && (
                  <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                    providerStatus.gitlab.error
                      ? 'border-red-500/30 bg-red-500/5 text-red-300'
                      : providerStatus.gitlab.count === 0
                        ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
                        : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
                  }`}>
                    <GitLabIcon className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-medium">GitLab:</span>
                    <span>
                      {providerStatus.gitlab.error
                        ? providerStatus.gitlab.error
                        : providerStatus.gitlab.count === 0
                          ? 'No repositories found for this account'
                          : `${providerStatus.gitlab.count} repo${providerStatus.gitlab.count === 1 ? '' : 's'}`}
                    </span>
                  </div>
                )}
              </div>
            )}

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
                  onClick={() => setStep(fromTeam ? 7 : 3)}
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
          <AiSummariesStep
            onContinue={fromTeam ? goToDashboard : () => setStep(4)}
            onBack={() => setStep(fromTeam ? 7 : 2)}
            isFinalStep={fromTeam}
          />
        )}

        {/* ─── STEP (team-only): Invite teammates ────────────────────────── */}
        {step === 7 && fromTeam && (
          <InviteTeamStep
            onContinue={() => setStep(3)}
            onBack={() => setStep(2)}
          />
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
                <CopyBlock text="cd ~/your-project && origin enable" />
                <p className="text-xs text-gray-600 mt-2">
                  Auto-detects {selectedAgents.length > 0
                    ? selectedAgents.map(id => AGENTS.find(a => a.id === id)?.name).filter(Boolean).join(', ')
                    : 'Claude Code, Cursor, Copilot, Gemini'
                  } and installs git hooks.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button onClick={() => setStep(fromInvite ? 6 : 3)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                &larr; Back
              </button>
              <button
                onClick={() => {
                  // Invitees finish here — they don't need a separate
                  // First Session polling step. /me has the same listener
                  // if they want to confirm. Solo flow still walks
                  // through step 5 since they self-installed top-to-bottom.
                  if (fromInvite) { goToDashboard(); return; }
                  setStep(5);
                  setPolling(true);
                }}
                className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                {fromInvite ? "I've run the commands — finish" : "I've run the commands →"}
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
                    Open a project where you ran <code className="text-indigo-400 text-xs bg-indigo-500/10 px-1.5 py-0.5 rounded">origin enable</code> and start coding with any AI agent.
                  </p>
                </>
              )}
            </div>

            {!sessionFound && (
              <>
                <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-5 space-y-4">
                  <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider">What to do now</p>
                  <div className="space-y-3">
                    {[
                      { n: '1', title: 'Open your project in terminal', sub: 'Make sure you ran origin enable in this project' },
                      { n: '2', title: 'Start any AI coding agent', sub: 'Claude Code, Cursor, Gemini CLI, Codex — any will work' },
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

                {/* Optional soft hint — only when something's clearly
                    wrong on the user's side (no API key / no repo) and
                    the auto-claim above can't help. Attribution mismatch
                    is handled silently by the auto-claim, so we don't
                    surface a red warning the user has to act on. */}
                {debugSnapshot && (() => {
                  const noKey = debugSnapshot.apiKeyCount === 0;
                  const noRepo = debugSnapshot.repoCount === 0 && debugSnapshot.sessionsInOrg === 0;
                  if (!noKey && !noRepo) return null;
                  const line = noKey
                    ? 'No CLI yet — run `origin login` in your terminal once with the key from earlier.'
                    : 'CLI is set up, but it hasn\'t talked to Origin yet. Run `origin enable` inside a project, then start any AI agent.';
                  return (
                    <div className="rounded-xl border border-white/[0.06] bg-gray-900/40 px-4 py-3 text-xs text-gray-400">
                      {line}
                    </div>
                  );
                })()}

                {/* Recovery — mint a fresh CLI key. Catches the case where
                    the local CLI is still configured against a deleted /
                    rotated API key (every hook silently 401's) so the
                    diagnostic counters stay frozen at "sessions exist but
                    nothing new is coming in". A single click here gets the
                    user a new key + the exact `origin login` command, so
                    they don't have to navigate to Settings. */}
                <details className="rounded-xl border border-white/[0.06] bg-gray-900/40 group">
                  <summary className="px-4 py-3 text-xs text-gray-400 cursor-pointer select-none hover:text-gray-200 transition-colors">
                    Still nothing? Reset the CLI key
                  </summary>
                  <div className="px-4 pb-4 pt-1 space-y-3 text-xs text-gray-400">
                    <p>
                      If your terminal was logged in to a previous account, your CLI is sending an API key the server no longer recognises and every hook silently fails. Generate a fresh key here and run the command — sessions will start flowing within seconds.
                    </p>
                    {freshKey ? (
                      <>
                        <CopyBlock text={`origin login --key ${freshKey}`} />
                        <p className="text-emerald-400">New key created. Paste the command above into your terminal, then start any AI agent — the screen here will flip on its own.</p>
                      </>
                    ) : (
                      <button
                        onClick={async () => {
                          setFreshKeyError(null);
                          setMintingKey(true);
                          try {
                            const res = await api.createApiKey({ name: 'CLI (onboarding reset)' });
                            setFreshKey(res.key);
                          } catch (err: any) {
                            setFreshKeyError(err?.message || 'Failed to create key');
                          } finally {
                            setMintingKey(false);
                          }
                        }}
                        disabled={mintingKey}
                        className="px-3 py-1.5 rounded-md bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-indigo-200 transition-colors disabled:opacity-50"
                      >
                        {mintingKey ? 'Generating…' : 'Generate fresh CLI key'}
                      </button>
                    )}
                    {freshKeyError && (
                      <p className="text-red-300">{freshKeyError}</p>
                    )}
                  </div>
                </details>
              </>
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

        {/* ─── STEP 6 (invite-only): Your Access ──────────────────────────
            Shown only for invited team members. Surfaces the repos +
            agents the admin granted via pendingGrants on accept-invite,
            so the new member sees what they have BEFORE they install the
            CLI and find out by trial. Empty state nudges them to ask the
            admin instead of silently failing later. */}
        {step === 6 && fromInvite && (
          <YourAccessStep onContinue={() => setStep(4)} onBack={() => setStep(0)} />
        )}
      </div>
    </div>
  );
}

// Reads /api/me/repos + /api/me/agents (or /api/agents/my as fallback)
// and renders what the admin granted. Pure read view — no actions.
function YourAccessStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const [repos, setRepos] = useState<Array<{ id: string; name: string; org?: { name: string } | null }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.getMeRepos(), api.getAgents()])
      .then(([reposRes, agentsRes]) => {
        if (cancelled) return;
        if (reposRes.status === 'fulfilled') {
          setRepos(reposRes.value.repos.map((r) => ({ id: r.id, name: r.name, org: r.org })));
        }
        if (agentsRes.status === 'fulfilled') {
          const list = (agentsRes.value as any)?.agents ?? agentsRes.value ?? [];
          setAgents(list.map((a: any) => ({ id: a.id, name: a.name, slug: a.slug })));
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="animate-fade-in space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white">Your access</h1>
        <p className="text-sm text-gray-400 mt-2">
          What your admin granted you. Sessions you run will show up against these repos and agents.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-white/[0.06] bg-gray-900/40 p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-200">Repositories</h3>
            <span className="text-[11px] text-gray-500 tabular-nums">{repos.length}</span>
          </div>
          {loading ? (
            <div className="text-xs text-gray-500">Loading…</div>
          ) : repos.length === 0 ? (
            <p className="text-xs text-gray-500">
              No repos granted yet. Ask your admin to add you to the repos you'll work in (Settings → IAM → Manage access).
            </p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {repos.slice(0, 50).map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-sm text-gray-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/80" />
                  <span className="truncate flex-1">{r.name}</span>
                  {r.org && <span className="text-[10px] text-gray-500 truncate">{r.org.name}</span>}
                </li>
              ))}
              {repos.length > 50 && (
                <li className="text-[11px] text-gray-600 italic">+ {repos.length - 50} more</li>
              )}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-gray-900/40 p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-200">Agents</h3>
            <span className="text-[11px] text-gray-500 tabular-nums">{agents.length}</span>
          </div>
          {loading ? (
            <div className="text-xs text-gray-500">Loading…</div>
          ) : agents.length === 0 ? (
            <p className="text-xs text-gray-500">
              No agents granted yet. Ask your admin which agent to use.
            </p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {agents.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-sm text-gray-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500/80" />
                  <span className="truncate flex-1">{a.name}</span>
                  <span className="text-[10px] font-mono text-gray-500 truncate">{a.slug}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
          &larr; Back
        </button>
        <button
          onClick={onContinue}
          className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
        >
          Install the CLI &rarr;
        </button>
      </div>
    </div>
  );
}

// ─── Invite teammates step (team-only) ────────────────────────────────────
//
// Starts with a single email field; admins can click "+ Add another" to
// invite more. Each filled row is sent as a MEMBER-role invitation via
// api.createInvite. Skipping is fine — admins can invite from /iam later.
// We don't surface roles or per-repo grants here; the goal is "get one
// teammate in the door so the team has more than one person on day 1."
// Anything richer belongs in IAM.
function InviteTeamStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const [emails, setEmails] = React.useState<string[]>(['']);
  const [sending, setSending] = React.useState(false);
  const [sentCount, setSentCount] = React.useState(0);
  const [error, setError] = React.useState('');
  // Per-row outcome — surfaced inline so an admin can see exactly which
  // invite failed and why. Previous behavior swallowed errors and
  // advanced to the next step, which left admins thinking they'd
  // invited people who weren't actually in IAM.
  type RowStatus = { ok: boolean; message?: string };
  const [rowStatus, setRowStatus] = React.useState<Record<number, RowStatus>>({});

  const setEmail = (i: number, v: string) => {
    setEmails((prev) => prev.map((e, idx) => (idx === i ? v : e)));
    setRowStatus((prev) => {
      if (!prev[i]) return prev;
      const next = { ...prev };
      delete next[i];
      return next;
    });
  };
  const addRow = () => setEmails((prev) => [...prev, '']);
  const removeRow = (i: number) => {
    setEmails((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
    setRowStatus((prev) => {
      const next: Record<number, RowStatus> = {};
      Object.entries(prev).forEach(([k, v]) => {
        const idx = Number(k);
        if (idx === i) return;
        next[idx > i ? idx - 1 : idx] = v;
      });
      return next;
    });
  };

  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const validEmails = emails
    .map((e, i) => ({ email: e.trim(), index: i }))
    .filter((r) => isValidEmail(r.email));

  const sendInvites = async () => {
    setError('');
    setRowStatus({});
    if (validEmails.length === 0) { onContinue(); return; }
    setSending(true);
    try {
      let ok = 0;
      const status: Record<number, RowStatus> = {};
      for (const { email, index } of validEmails) {
        try {
          await api.createInvite({ email, role: 'MEMBER' });
          status[index] = { ok: true };
          ok++;
        } catch (err: any) {
          // Surface the per-row error so the admin knows which invite
          // failed and why (409 already-member, 403 wrong-role, etc.).
          status[index] = { ok: false, message: err?.message || 'Failed' };
        }
      }
      setRowStatus(status);
      setSentCount(ok);
      // Only auto-advance when at least one invite succeeded. Otherwise
      // keep the admin on this step so they can read the errors and
      // either fix the emails or skip explicitly.
      if (ok > 0) setTimeout(onContinue, 800);
    } catch (err: any) {
      setError(err?.message || 'Failed to send invites');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="animate-fade-in space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white">Invite your teammates</h1>
        <p className="text-sm text-gray-400 mt-2">
          Send invite links now or add more later from IAM.
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-900/30 border border-red-800 text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {emails.map((value, i) => {
          const status = rowStatus[i];
          const borderClass = status?.ok
            ? 'border-emerald-500/40'
            : status && !status.ok
              ? 'border-red-500/40'
              : 'border-white/[0.08] focus-within:border-indigo-500/60';
          return (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <input
                  type="email"
                  value={value}
                  onChange={(e) => setEmail(i, e.target.value)}
                  placeholder="teammate@yourcompany.com"
                  className={`flex-1 px-4 py-2.5 rounded-lg border bg-gray-900/40 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none ${borderClass}`}
                />
                {emails.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    aria-label="Remove invitee"
                    className="shrink-0 w-9 h-9 rounded-lg border border-white/[0.06] text-gray-500 hover:text-gray-300 hover:border-white/[0.12] transition-colors"
                  >
                    ×
                  </button>
                )}
              </div>
              {status?.ok && (
                <p className="text-[11px] text-emerald-400 pl-1">Invite sent</p>
              )}
              {status && !status.ok && (
                <p className="text-[11px] text-red-400 pl-1">{status.message}</p>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={addRow}
          className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          + Add another
        </button>
        <p className="text-[11px] text-gray-600 pt-1">
          Each invitee gets an email with a link to join your org. They'll arrive at a 4-step setup of their own — no admin work needed on their end.
        </p>
      </div>

      <div className="flex items-center justify-between pt-2">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
          &larr; Back
        </button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onContinue}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={sendInvites}
            disabled={sending || validEmails.length === 0}
            className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {sending
              ? 'Sending…'
              : sentCount > 0
                ? `Sent ${sentCount} ✓`
                : `Invite ${validEmails.length || ''}${validEmails.length > 0 ? ' →' : ''}`}
          </button>
        </div>
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
function AiSummariesStep({ onContinue, onBack, isFinalStep }: { onContinue: () => void; onBack: () => void; isFinalStep?: boolean }) {
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
      // Going through the shared `request()` helper (instead of raw
      // fetch) makes sure the X-Origin-Org header is sent, so the key
      // lands in the same org the user is currently viewing — without
      // it the API would fall back to lastOrgId, which can drift if the
      // user has more than one membership.
      await request('/api/settings/chat', {
        method: 'PUT',
        body: JSON.stringify({ apiKey, llmProvider: provider }),
      });
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
              {p === 'anthropic' ? 'Anthropic' : 'OpenAI'}
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
            {isFinalStep ? 'Skip — go to dashboard' : 'Skip for now'}
          </button>
          <button
            onClick={save}
            disabled={saving || apiKey.trim().length < 10}
            className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : isFinalStep ? 'Save & finish' : 'Save & continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
