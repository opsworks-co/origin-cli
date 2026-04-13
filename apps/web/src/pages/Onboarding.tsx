import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from '../components/Logo';
import { request } from '../api/_client';
import * as api from '../api';

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

const TOTAL_STEPS = 4;

// ── Step indicator ──────────────────────────────────────────────────────────
function Steps({ current }: { current: number }) {
  const steps = ['AI Tools', 'Connect Repos', 'Install CLI', 'First Session'];
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
function GitHubIcon() {
  return <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>;
}

function GitLabIcon() {
  return <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.452.044 13.587a.924.924 0 00.331 1.023L12 23.054l11.625-8.443a.92.92 0 00.33-1.024"/></svg>;
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
    if (step !== 3 || !polling) return;
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
                onClick={() => setStep(2)}
                className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                {githubConnected || gitlabConnected ? 'Continue' : 'Skip for now'} &rarr;
              </button>
            </div>
          </div>
        )}

        {/* ─── STEP 3: Install & Connect ──────────────────────────────────── */}
        {step === 2 && (
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
              <button onClick={() => setStep(1)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                &larr; Back
              </button>
              <button
                onClick={() => { setStep(3); setPolling(true); }}
                className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                I've run the commands &rarr;
              </button>
            </div>
          </div>
        )}

        {/* ─── STEP 4: Waiting for first session ──────────────────────────── */}
        {step === 3 && (
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
                onClick={() => { setPolling(false); setStep(2); }}
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
