import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from '../components/Logo';
import * as api from '../api';

export default function RegisterDeveloper() {
  const { registerDeveloper, error: authError } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Hide OAuth buttons for providers the server isn't actually configured
  // for (e.g. GOOGLE_CLIENT_ID missing on prod).
  const [providers, setProviders] = useState<Record<string, boolean>>({
    github: true, gitlab: true, google: true,
  });
  React.useEffect(() => {
    api.getOAuthProviders()
      .then((r) => setProviders(r.providers || {}))
      .catch(() => setProviders({ github: true, gitlab: false, google: false }));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Auto-fire the product tour on the first dashboard load after
      // signup, plus a sidebar nudge in case the user closes it early.
      try { localStorage.setItem('origin:auto-start-tour', '1'); } catch { /* private mode */ }
      try { localStorage.setItem('origin:tour-highlight', '1'); } catch { /* private mode */ }
      await registerDeveloper(email, password, name);
      navigate('/onboarding');
    } catch (err: any) {
      setError(err.message ?? 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="absolute top-0 left-1/3 w-96 h-96 bg-emerald-600/5 rounded-full blur-3xl" />

      <div className="w-full max-w-sm relative">
        {/* Logo */}
        <Link to="/" className="flex items-center justify-center gap-2 mb-8 hover:opacity-80 transition-opacity">
          <LogoMark size={40} variant="solo" />
          <span className="text-xl font-semibold">Origin</span>
        </Link>

        <div className="card">
          <div className="text-center mb-6">
            <h2 className="text-xl font-semibold">Origin Solo</h2>
            <p className="text-sm text-gray-500 mt-1">
              Track your AI sessions, stats, and streaks
            </p>
          </div>

          {(error || authError) && (
            <div className="mb-4 p-3 rounded-lg bg-red-900/30 border border-red-800 text-red-400 text-sm">
              {error || authError}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="dev-name" className="block text-sm font-medium text-gray-400 mb-1.5">
                Your name
              </label>
              <input
                id="dev-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input"
                placeholder="Jane Smith"
                autoComplete="name"
              />
            </div>

            <div>
              <label htmlFor="dev-email" className="block text-sm font-medium text-gray-400 mb-1.5">
                Email
              </label>
              <input
                id="dev-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="dev-password" className="block text-sm font-medium text-gray-400 mb-1.5">
                Password
              </label>
              <input
                id="dev-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </div>

            <button type="submit" disabled={loading} className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm transition-colors disabled:opacity-50">
              {loading ? 'Creating account...' : 'Create solo account'}
            </button>
          </form>

          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-700/60" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-gray-900 px-3 text-gray-500">or sign up with</span>
            </div>
          </div>

          {(providers.github || providers.gitlab || providers.google) && (
            <div className="flex gap-2">
              {providers.github && (
                <button
                  onClick={async () => { try { const { url } = await api.getOAuthUrl('github'); window.location.href = url; } catch { setError('GitHub OAuth not available'); } }}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-750 hover:text-white transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
                  GitHub
                </button>
              )}
              {providers.gitlab && (
                <button
                  onClick={async () => { try { const { url } = await api.getOAuthUrl('gitlab'); window.location.href = url; } catch { setError('GitLab OAuth not available'); } }}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-750 hover:text-white transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.452.044 13.587a.924.924 0 00.331 1.023L12 23.054l11.625-8.443a.92.92 0 00.33-1.024"/></svg>
                  GitLab
                </button>
              )}
              {providers.google && (
                <button
                  onClick={async () => { try { const { url } = await api.getOAuthUrl('google'); window.location.href = url; } catch { setError('Google OAuth not available'); } }}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-750 hover:text-white transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                  Google
                </button>
              )}
            </div>
          )}

          <div className="mt-4 p-3 rounded-lg bg-gray-800/50 border border-gray-700/50">
            <p className="text-xs text-gray-500 leading-relaxed">
              A personal workspace is created automatically. You can join an organization later via invite link.
            </p>
          </div>
        </div>

        <div className="mt-6 text-center space-y-2">
          <p className="text-sm text-gray-500">
            Need a team account?{' '}
            <Link to="/register" className="text-indigo-400 hover:text-indigo-300 transition-colors">
              Create organization
            </Link>
          </p>
          <p className="text-sm text-gray-500">
            Already have an account?{' '}
            <Link to="/login" className="text-indigo-400 hover:text-indigo-300 transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
