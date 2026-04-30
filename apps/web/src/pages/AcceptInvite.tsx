import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';

// Extract a token from a pasted string. Accepts:
//   - bare token (hex string)
//   - full URL: https://getorigin.io/accept-invite/<token> or /invite/<token>
//   - URL with ?token=<token>
function extractToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Try URL parse
  try {
    const url = new URL(trimmed);
    const qsToken = url.searchParams.get('token');
    if (qsToken) return qsToken;
    const m = url.pathname.match(/\/(?:accept-invite|invite)\/([^/?#]+)/);
    if (m) return m[1];
  } catch {
    // not a URL — fall through
  }
  // Bare token? Heuristic: hex/base64-ish string of reasonable length.
  if (/^[a-f0-9]{16,}$/i.test(trimmed)) return trimmed;
  // As a last resort, treat the whole thing as a token.
  return trimmed;
}

export default function AcceptInvite() {
  const { token: tokenParam } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const queryToken = searchParams.get('token');
  const token = tokenParam || queryToken || '';

  const navigate = useNavigate();
  const { applyAuthResponse } = useAuth();

  const [inviteInfo, setInviteInfo] = useState<{ orgName: string; role: string; email: string | null } | null>(null);
  const [loading, setLoading] = useState(!!token);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Paste-link form (shown when there's no token in the URL).
  const [pastedLink, setPastedLink] = useState('');
  const [pasteError, setPasteError] = useState('');

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = extractToken(pastedLink);
    if (!t) {
      setPasteError('Could not find an invite token in that link.');
      return;
    }
    navigate(`/accept-invite/${t}`);
  };

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api.getInviteInfo(token)
      .then((info) => {
        setInviteInfo(info);
        if (info.email) setEmail(info.email);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await api.acceptInvite({ token, name, email, password });
      applyAuthResponse(res);
      navigate('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
      </div>
    );
  }

  // No token in URL — show a form to paste the invite link.
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex w-12 h-12 rounded-2xl bg-indigo-500/10 ring-1 ring-indigo-500/30 items-center justify-center mb-1">
              <svg className="w-6 h-6 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-100">Join an organization</h1>
            <p className="text-sm text-gray-400">
              Paste the invite link your team admin sent you.
            </p>
          </div>

          <form onSubmit={handlePasteSubmit} className="space-y-3">
            <input
              autoFocus
              type="text"
              value={pastedLink}
              onChange={(e) => { setPastedLink(e.target.value); setPasteError(''); }}
              placeholder="https://getorigin.io/accept-invite/..."
              className="input w-full"
            />
            {pasteError && <p className="text-xs text-red-400">{pasteError}</p>}
            <button
              type="submit"
              disabled={!pastedLink.trim()}
              className="btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          </form>

          <p className="text-center text-xs text-gray-600">
            Don't have a link? <a href="/login" className="text-indigo-400 hover:text-indigo-300">Log in</a> instead.
          </p>
        </div>
      </div>
    );
  }

  if (!inviteInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
        <div className="w-full max-w-sm text-center space-y-4">
          <div className="inline-flex w-12 h-12 rounded-2xl bg-amber-500/10 ring-1 ring-amber-500/30 items-center justify-center">
            <svg className="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          </div>
          <h1 className="text-xl font-bold text-gray-200">Invalid or Expired Invite</h1>
          <p className="text-sm text-gray-500">{error || 'This invitation link is no longer valid.'}</p>
          <div className="flex items-center justify-center gap-3 text-sm">
            <button onClick={() => navigate('/accept-invite')} className="text-indigo-400 hover:text-indigo-300">
              Try a different link
            </button>
            <span className="text-gray-700">·</span>
            <a href="/login" className="text-indigo-400 hover:text-indigo-300">
              Go to Login
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-gray-100">Join {inviteInfo.orgName}</h1>
          <p className="text-sm text-gray-400">
            You've been invited as <span className="font-medium text-gray-200">{inviteInfo.role}</span>
          </p>
        </div>

        {error && (
          <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your full name"
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="input w-full"
              readOnly={!!inviteInfo.email}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 characters"
              className="input w-full"
            />
            <p className="text-xs text-gray-600 mt-1">
              Already have an account? Use your existing password to join.
            </p>
          </div>
          <button type="submit" disabled={submitting} className="btn-primary w-full">
            {submitting ? 'Joining...' : 'Join'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-600">
          Already have an account? <a href="/login" className="text-indigo-400 hover:text-indigo-300">Log in</a>
        </p>
      </div>
    </div>
  );
}
