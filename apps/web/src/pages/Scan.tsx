import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';

// ── Types ────────────────────────────────────────────────────────────────

interface ScanResult {
  token: string;
  repoUrl: string;
  status: 'running' | 'complete' | 'failed';
  commitCount: number;
  aiCommitCount: number;
  aiPercentage: number;
  topModel: string | null;
  estimatedCost: number;
  totalLines: number;
  topAuthors: Array<{ name: string; aiCount: number; humanCount: number }>;
  modelBreakdown: Record<string, number>;
  signalsFound: string[];
  errorMessage?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatModel(m: string | null): string {
  if (!m) return '—';
  const map: Record<string, string> = {
    claude: 'Claude',
    gpt: 'GPT / Codex',
    gemini: 'Gemini',
    cursor: 'Cursor',
    copilot: 'GitHub Copilot',
    aider: 'Aider',
  };
  return map[m] || m;
}

function shortRepo(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//i, '');
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function Scan() {
  const { token } = useParams<{ token?: string }>();

  if (token) {
    return <ScanReport token={token} />;
  }
  return <ScanLanding />;
}

// ── Landing (form) ───────────────────────────────────────────────────────

function ScanLanding() {
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!repoUrl.trim() || !email.trim()) {
      setError('Both fields are required.');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch('/api/public-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: repoUrl.trim(), email: email.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || 'Scan failed to start');
      }
      navigate(`/scan/${data.token}`);
    } catch (err: any) {
      setError(err.message || 'Failed to start scan');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Helmet>
        <title>Free AI Codebase Audit — Origin</title>
        <meta name="description" content="Paste a public GitHub repo. Get a free report: what % of commits are AI-generated, which model wrote them, estimated cost. No signup." />
        <link rel="canonical" href="https://getorigin.io/scan" />
      </Helmet>

      <div className="min-h-[calc(100vh-200px)] flex flex-col items-center justify-center px-6 py-16">
        <div className="max-w-2xl w-full text-center">
          <span className="inline-block text-[11px] uppercase tracking-[0.12em] font-semibold text-emerald-400 mb-4">
            Free · No signup
          </span>
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-100 tracking-tight leading-[1.1] mb-4">
            How much of this repo was written by AI?
          </h1>
          <p className="text-lg text-gray-400 mb-10 leading-relaxed max-w-xl mx-auto">
            Paste a public GitHub URL. We scan the last 100 commits for AI signals — Co-Authored-By trailers, model mentions, commit patterns — and send you a free report.
          </p>

          <form onSubmit={handleSubmit} className="space-y-3 text-left">
            <div>
              <label htmlFor="repoUrl" className="block text-[11px] uppercase tracking-wider font-medium text-gray-500 mb-1.5">
                GitHub repo
              </label>
              <input
                id="repoUrl"
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="github.com/facebook/react"
                autoComplete="off"
                className="w-full px-4 py-3 bg-gray-900 border border-gray-800 rounded-lg text-gray-100 placeholder-gray-600 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 transition"
                disabled={submitting}
              />
            </div>
            <div>
              <label htmlFor="email" className="block text-[11px] uppercase tracking-wider font-medium text-gray-500 mb-1.5">
                Email (we'll send you the report link)
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                className="w-full px-4 py-3 bg-gray-900 border border-gray-800 rounded-lg text-gray-100 placeholder-gray-600 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 transition"
                disabled={submitting}
              />
            </div>

            {error && (
              <div className="text-sm text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full mt-2 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition shadow-lg shadow-emerald-500/20"
            >
              {submitting ? 'Starting scan...' : 'Run free audit →'}
            </button>

            <p className="text-[11px] text-gray-600 text-center pt-2">
              Works on any public GitHub repo. Takes 20–40 seconds. 5 scans per hour per IP.
            </p>
          </form>

          <div className="mt-16 grid sm:grid-cols-3 gap-6 text-left">
            {[
              {
                title: 'Attribution',
                body: 'Per-commit AI vs human classification based on trailers, model mentions, and commit structure.',
              },
              {
                title: 'Model breakdown',
                body: 'Claude, GPT, Gemini, Cursor, Copilot — each commit tagged with the model that signed it.',
              },
              {
                title: 'Cost estimate',
                body: 'Rough $ figure for the AI-authored portion, calibrated against real Origin session data.',
              },
            ].map((f) => (
              <div key={f.title}>
                <h3 className="text-sm font-semibold text-gray-200 mb-1.5">{f.title}</h3>
                <p className="text-[13px] text-gray-500 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>

          <p className="mt-16 text-sm text-gray-500">
            You just used Origin's tools on someone else's repo. Imagine what it'd tell you about yours.{' '}
            <Link to="/register" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-4 decoration-emerald-500/40">
              Track your own team &rarr;
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}

// ── Report (polling + display) ───────────────────────────────────────────

function ScanReport({ token }: { token: string }) {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchOnce() {
      try {
        const resp = await fetch(`/api/public-scan/${token}`);
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({ error: 'Scan not found' }));
          throw new Error(data.error || 'Scan not found');
        }
        const data: ScanResult = await resp.json();
        if (cancelled) return;
        setScan(data);
        if (data.status !== 'running') {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message || 'Failed to load scan');
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }

    fetchOnce();
    pollRef.current = window.setInterval(fetchOnce, 3000);
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [token]);

  if (error) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center px-6 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-100 mb-2">Scan not found</h1>
        <p className="text-gray-500 mb-6">{error}</p>
        <Link to="/scan" className="text-emerald-400 hover:text-emerald-300">Start a new scan &rarr;</Link>
      </div>
    );
  }

  if (!scan) {
    return <ScanLoading message="Loading scan..." />;
  }

  if (scan.status === 'running') {
    return <ScanLoading message={`Scanning ${shortRepo(scan.repoUrl)}...`} subtitle="Fetching commits, checking trailers, scoring signals. 20–40 seconds." />;
  }

  if (scan.status === 'failed') {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center px-6 py-16 text-center max-w-xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-100 mb-2">Scan failed</h1>
        <p className="text-gray-500 mb-6">{scan.errorMessage || 'Unknown error. The repo may be private or deleted.'}</p>
        <Link to="/scan" className="text-emerald-400 hover:text-emerald-300">Try another repo &rarr;</Link>
      </div>
    );
  }

  return <ScanResultView scan={scan} />;
}

function ScanLoading({ message, subtitle }: { message: string; subtitle?: string }) {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="w-10 h-10 rounded-full border-2 border-emerald-500/30 border-t-emerald-400 animate-spin mb-5" />
      <p className="text-gray-200 font-medium">{message}</p>
      {subtitle && <p className="text-sm text-gray-500 mt-2 max-w-md">{subtitle}</p>}
    </div>
  );
}

function ScanResultView({ scan }: { scan: ScanResult }) {
  const modelEntries = Object.entries(scan.modelBreakdown).sort((a, b) => b[1] - a[1]);
  const aiPct = scan.aiPercentage;
  const aiColor = aiPct >= 50 ? 'text-emerald-400' : aiPct >= 20 ? 'text-amber-400' : 'text-gray-400';

  const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}/scan/${scan.token}` : '';
  const [copied, setCopied] = useState(false);

  return (
    <>
      <Helmet>
        <title>{`${shortRepo(scan.repoUrl)}: ${aiPct}% AI-generated — Origin`}</title>
        <meta name="description" content={`${scan.aiCommitCount}/${scan.commitCount} commits of ${shortRepo(scan.repoUrl)} are AI-generated. Top model: ${formatModel(scan.topModel)}.`} />
      </Helmet>

      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="mb-10">
          <p className="text-[11px] uppercase tracking-[0.12em] font-semibold text-emerald-400 mb-2">
            Codebase audit
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-100 tracking-tight mb-2">
            <a href={scan.repoUrl} target="_blank" rel="noreferrer" className="hover:text-emerald-300 transition underline decoration-gray-700 underline-offset-4 hover:decoration-emerald-500/50">
              {shortRepo(scan.repoUrl)}
            </a>
          </h1>
          <p className="text-sm text-gray-500">
            Based on the last {scan.commitCount} commits. Generated {scan.completedAt ? new Date(scan.completedAt).toLocaleString() : 'just now'}.
          </p>
        </div>

        {/* Headline stat */}
        <div className="rounded-2xl border border-gray-800 bg-gradient-to-br from-gray-900 to-gray-950 p-8 mb-6">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-gray-500 mb-3">
            AI-authored
          </p>
          <div className="flex items-baseline gap-4 flex-wrap">
            <span className={`text-7xl font-bold tabular-nums tracking-tight ${aiColor}`}>
              {aiPct}%
            </span>
            <span className="text-lg text-gray-400">
              of the last {scan.commitCount} commits
            </span>
          </div>
          <p className="mt-3 text-sm text-gray-500">
            {scan.aiCommitCount} of {scan.commitCount} commits match AI-authorship signals.
          </p>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
          <StatCard label="Top model" value={formatModel(scan.topModel)} />
          <StatCard label="Estimated AI cost" value={`$${scan.estimatedCost.toFixed(2)}`} sub="rough, based on observed prompt costs" />
          <StatCard label="AI-authored lines" value={scan.totalLines.toLocaleString()} sub="extrapolated from sampled commits" />
        </div>

        {/* Model breakdown */}
        {modelEntries.length > 0 && (
          <Section title="Model breakdown">
            <div className="space-y-2">
              {modelEntries.map(([model, count]) => {
                const pct = Math.round((count / Math.max(1, scan.aiCommitCount)) * 100);
                return (
                  <div key={model} className="flex items-center gap-4">
                    <div className="w-32 text-sm text-gray-300">{formatModel(model)}</div>
                    <div className="flex-1 h-6 bg-gray-900 border border-gray-800 rounded-md overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-500 to-emerald-600"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-sm text-gray-400 tabular-nums w-16 text-right">
                      {count} · {pct}%
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* Top authors */}
        {scan.topAuthors.length > 0 && (
          <Section title="Top committers">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                  <th className="text-left py-2 font-medium">Author</th>
                  <th className="text-right py-2 font-medium">AI commits</th>
                  <th className="text-right py-2 font-medium">Human commits</th>
                </tr>
              </thead>
              <tbody>
                {scan.topAuthors.map((a) => (
                  <tr key={a.name} className="border-b border-gray-900 last:border-0">
                    <td className="py-2.5 text-gray-300">{a.name}</td>
                    <td className="py-2.5 text-right text-emerald-400 tabular-nums">{a.aiCount}</td>
                    <td className="py-2.5 text-right text-gray-500 tabular-nums">{a.humanCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {/* Signals */}
        {scan.signalsFound.length > 0 && (
          <Section title="Signals detected">
            <div className="flex flex-wrap gap-2">
              {scan.signalsFound.map((s) => (
                <span key={s} className="text-[11px] px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20">
                  {s}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* CTA */}
        <div className="mt-12 rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 to-transparent p-8">
          <h2 className="text-xl font-bold text-gray-100 mb-2">
            You just used Origin's tools on someone else's repo.
          </h2>
          <p className="text-gray-400 mb-5">
            Imagine what it'd tell you about yours. Origin tracks AI coding sessions in real time — line-level attribution, cost per prompt, full session replay. Free forever for individual developers.
          </p>
          <div className="flex gap-3 flex-wrap">
            <Link to="/register" className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-white font-semibold px-5 py-2.5 rounded-lg transition">
              Get your free account →
            </Link>
            <Link to="/scan" className="inline-flex items-center gap-2 text-emerald-400 hover:text-emerald-300 font-medium px-5 py-2.5">
              Scan another repo
            </Link>
            <button
              onClick={() => {
                navigator.clipboard.writeText(shareUrl).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="inline-flex items-center gap-2 text-gray-400 hover:text-gray-200 font-medium px-5 py-2.5"
            >
              {copied ? 'Copied!' : 'Copy share link'}
            </button>
          </div>
        </div>

        <p className="mt-8 text-xs text-gray-600 leading-relaxed">
          This is a heuristic scan, not a forensic one. It matches on commit trailers (Co-Authored-By, Origin-Session), model mentions, and commit structure. Uncommitted signals (sessions never pushed, IDE-only assistance) are invisible. Origin's CLI does the full analysis locally on your repo — private, accurate, and free.
        </p>
      </div>
    </>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-5 py-4">
      <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-500 mb-2">
        {label}
      </p>
      <p className="text-2xl font-bold text-gray-100 tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-[11px] uppercase tracking-[0.12em] font-semibold text-gray-500 mb-4">
        {title}
      </h2>
      {children}
    </div>
  );
}
