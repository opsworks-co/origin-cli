// /cli-link?code=USER-CODE
//
// Browser counterpart to `origin login`'s device-code flow. The CLI prints a
// URL pointing here; the user opens it (logging in if needed via the
// returnTo query param), sees who's authenticating and which workspace
// they're authenticating against, and clicks Approve. The server mints a
// fresh API key and the CLI's poll loop on the other end picks it up and
// writes it to ~/.origin/config.json.
import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { request } from '../api/_client';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from '../components/Logo';

interface LookupResp {
  userCode: string;
  status: 'pending' | 'approved' | 'denied';
  expiresAt: string;
}

export default function CliLink() {
  const [searchParams] = useSearchParams();
  const code = (searchParams.get('code') || '').toUpperCase().trim();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [lookup, setLookup] = useState<LookupResp | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);

  // Bounce unauthenticated users through /login with returnTo so they
  // come straight back here after sign-in instead of landing on the
  // dashboard and having to re-open the CLI link from terminal.
  useEffect(() => {
    if (user === undefined) return; // still loading
    if (user === null) {
      const returnTo = encodeURIComponent(location.pathname + location.search);
      navigate(`/login?returnTo=${returnTo}`, { replace: true });
    }
  }, [user, location, navigate]);

  // Look up the pending request so we can render an approval card with
  // real timing context. The lookup endpoint is unauthenticated — the
  // userCode itself is the one-shot handle — but approval is gated.
  useEffect(() => {
    if (!code) return;
    (async () => {
      try {
        const r = await request<LookupResp>(`/api/cli-auth/lookup?code=${encodeURIComponent(code)}`);
        setLookup(r);
      } catch (err: any) {
        setLookupErr(err?.message || 'This login link is invalid or has expired. Re-run `origin login` in your terminal.');
      }
    })();
  }, [code]);

  const handleApprove = async () => {
    if (!code) return;
    setSubmitErr(null);
    setSubmitting('approve');
    try {
      await request<{ success: boolean }>('/api/cli-auth/approve', {
        method: 'POST',
        body: JSON.stringify({ userCode: code }),
      });
      setDone('approved');
    } catch (err: any) {
      setSubmitErr(err?.message || 'Approval failed');
    } finally {
      setSubmitting(null);
    }
  };

  const handleDeny = async () => {
    if (!code) return;
    setSubmitErr(null);
    setSubmitting('deny');
    try {
      await request<{ success: boolean }>('/api/cli-auth/deny', {
        method: 'POST',
        body: JSON.stringify({ userCode: code }),
      });
      setDone('denied');
    } catch (err: any) {
      setSubmitErr(err?.message || 'Deny failed');
    } finally {
      setSubmitting(null);
    }
  };

  if (!code) {
    return <PageShell><BadCode message="Missing ?code=… parameter. Re-run `origin login`." /></PageShell>;
  }
  if (lookupErr) {
    return <PageShell><BadCode message={lookupErr} /></PageShell>;
  }

  if (done === 'approved') {
    return (
      <PageShell>
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center mx-auto text-2xl">
            ✓
          </div>
          <h1 className="text-xl font-semibold text-gray-100">CLI authenticated</h1>
          <p className="text-sm text-gray-400">
            Your terminal is now logged in. You can close this tab and head back to <code className="text-indigo-300 bg-indigo-500/10 px-1 py-0.5 rounded text-[12px]">origin login</code> — it will pick up the new key on its next poll.
          </p>
          <Link to="/me" className="inline-block mt-2 text-sm text-indigo-400 hover:text-indigo-300">Go to my dashboard →</Link>
        </div>
      </PageShell>
    );
  }
  if (done === 'denied') {
    return (
      <PageShell>
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-full bg-red-500/10 ring-1 ring-red-500/30 flex items-center justify-center mx-auto text-2xl">
            ✕
          </div>
          <h1 className="text-xl font-semibold text-gray-100">Login denied</h1>
          <p className="text-sm text-gray-400">
            The CLI request has been rejected. If this wasn't you, no further action is needed — the request is dead.
          </p>
        </div>
      </PageShell>
    );
  }

  if (!user) {
    return <PageShell><div className="text-center text-sm text-gray-500">Redirecting to sign in…</div></PageShell>;
  }

  return (
    <PageShell>
      <div className="space-y-5">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-semibold text-gray-100">Authenticate Origin CLI</h1>
          <p className="text-sm text-gray-400">
            A terminal on this machine asked Origin to mint a new API key. Approve only if you started this from <code className="text-indigo-300 bg-indigo-500/10 px-1 py-0.5 rounded text-[12px]">origin login</code> just now.
          </p>
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-gray-900/40 p-4 space-y-3">
          <Row label="Code">
            <span className="font-mono tracking-widest text-gray-100">{lookup?.userCode || code}</span>
          </Row>
          <Row label="Account">
            <span className="text-gray-200">{user.email}</span>
          </Row>
          {lookup?.expiresAt && (
            <Row label="Expires">
              <span className="text-gray-500 text-xs">
                {new Date(lookup.expiresAt).toLocaleTimeString()}
              </span>
            </Row>
          )}
        </div>

        {submitErr && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {submitErr}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={handleDeny}
            disabled={submitting !== null}
            className="flex-1 px-4 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-white/[0.08] text-sm text-gray-300 transition-colors disabled:opacity-50"
          >
            {submitting === 'deny' ? 'Denying…' : 'Deny'}
          </button>
          <button
            onClick={handleApprove}
            disabled={submitting !== null}
            className="flex-1 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {submitting === 'approve' ? 'Approving…' : 'Approve & sign in CLI'}
          </button>
        </div>
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gray-950">
      <Helmet>
        <title>Authenticate Origin CLI</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center mb-6 gap-2">
          <LogoMark size={28} />
          <span className="text-base font-semibold text-gray-100">Origin</span>
        </div>
        <div className="rounded-2xl border border-white/[0.06] bg-gray-900/60 backdrop-blur-sm p-6 shadow-2xl shadow-black/40">
          {children}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      {children}
    </div>
  );
}

function BadCode({ message }: { message: string }) {
  return (
    <div className="text-center space-y-3">
      <div className="w-14 h-14 rounded-full bg-amber-500/10 ring-1 ring-amber-500/30 flex items-center justify-center mx-auto text-xl">
        ⚠
      </div>
      <h1 className="text-lg font-semibold text-gray-100">Login link can't be used</h1>
      <p className="text-sm text-gray-400">{message}</p>
    </div>
  );
}
