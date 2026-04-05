import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Building2, User, Copy, Check, Terminal } from 'lucide-react';
import * as api from '../api';
import { LogoMark } from '../components/Logo';

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

type AccountType = 'team' | 'developer';

export default function Register() {
  const { register, registerDeveloper, error: authError } = useAuth();
  const navigate = useNavigate();
  const [accountType, setAccountType] = useState<AccountType>('team');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleOrgNameChange = (v: string) => {
    setOrgName(v);
    if (!slugEdited) setOrgSlug(slugify(v));
  };

  const copyKey = () => {
    if (generatedKey) {
      navigator.clipboard.writeText(generatedKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (accountType === 'developer') {
        const apiKey = await registerDeveloper(email, password, name);
        if (apiKey) {
          setGeneratedKey(apiKey);
          // Don't navigate yet — show the API key first
        } else {
          navigate('/me');
        }
      } else {
        await register(email, password, name, orgName, orgSlug);
        navigate('/dashboard');
      }
    } catch (err: any) {
      setError(err.message ?? 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const isTeam = accountType === 'team';

  // Show API key screen after successful developer registration
  if (generatedKey) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12">
        <div className="absolute top-0 left-1/3 w-96 h-96 bg-emerald-600/5 rounded-full blur-3xl" />

        <div className="w-full max-w-md relative">
          <div className="flex items-center justify-center gap-2 mb-8">
            <LogoMark size={40} />
            <span className="text-xl font-semibold">Origin</span>
          </div>

          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <Check className="w-4 h-4 text-emerald-400" />
              </div>
              <h2 className="text-xl font-semibold">Account created!</h2>
            </div>

            <p className="text-sm text-gray-400 mb-5">
              Your personal API key has been generated. Save it now — you won't be able to see it again.
            </p>

            {/* API Key display */}
            <div className="relative">
              <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 pr-12 font-mono text-sm text-emerald-400 break-all select-all">
                {generatedKey}
              </div>
              <button
                onClick={copyKey}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-md hover:bg-gray-700 transition-colors"
                title="Copy to clipboard"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-gray-400" />}
              </button>
            </div>

            {/* Quick start */}
            <div className="mt-5 p-3 rounded-lg bg-gray-800/50 border border-gray-700/50">
              <div className="flex items-center gap-2 mb-2">
                <Terminal className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-300">Quick start</span>
              </div>
              <div className="space-y-1.5 font-mono text-xs text-gray-400">
                <p>$ npm i -g @anthropic/origin-cli</p>
                <p>$ origin login --key {generatedKey.slice(0, 16)}...</p>
                <p>$ origin init</p>
              </div>
            </div>

            <button
              onClick={() => navigate('/me')}
              className="w-full mt-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm transition-colors"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className={`absolute top-0 w-96 h-96 rounded-full blur-3xl transition-colors duration-500 ${isTeam ? 'right-1/3 bg-purple-600/5' : 'left-1/3 bg-emerald-600/5'}`} />

      <div className="w-full max-w-sm relative">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold transition-colors duration-300 ${isTeam ? 'bg-indigo-600' : 'bg-emerald-600'}`}>
            O
          </div>
          <span className="text-xl font-semibold">Origin</span>
        </div>

        <div className="card">
          <h2 className="text-xl font-semibold text-center mb-5">Create your account</h2>

          {/* Account type toggle */}
          <div className="grid grid-cols-2 gap-2 mb-6">
            <button
              type="button"
              onClick={() => setAccountType('team')}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 border ${
                isTeam
                  ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-400 shadow-sm shadow-indigo-500/5'
                  : 'bg-transparent border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'
              }`}
            >
              <Building2 className="w-4 h-4" />
              Team
            </button>
            <button
              type="button"
              onClick={() => setAccountType('developer')}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 border ${
                !isTeam
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 shadow-sm shadow-emerald-500/5'
                  : 'bg-transparent border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'
              }`}
            >
              <User className="w-4 h-4" />
              Developer
            </button>
          </div>

          {/* Description */}
          <p className="text-xs text-gray-500 text-center mb-5 -mt-2">
            {isTeam
              ? 'Full platform with team management, policies, and compliance'
              : 'Personal dashboard to track your AI sessions and stats'}
          </p>

          {(error || authError) && (
            <div className="mb-4 p-3 rounded-lg bg-red-900/30 border border-red-800 text-red-400 text-sm">
              {error || authError}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-400 mb-1.5">
                Your name
              </label>
              <input
                id="name"
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
              <label htmlFor="reg-email" className="block text-sm font-medium text-gray-400 mb-1.5">
                Email
              </label>
              <input
                id="reg-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                placeholder={isTeam ? 'you@company.com' : 'you@example.com'}
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="reg-password" className="block text-sm font-medium text-gray-400 mb-1.5">
                Password
              </label>
              <input
                id="reg-password"
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

            {/* Team-only fields */}
            {isTeam && (
              <>
                <div>
                  <label htmlFor="orgName" className="block text-sm font-medium text-gray-400 mb-1.5">
                    Organization name
                  </label>
                  <input
                    id="orgName"
                    type="text"
                    required
                    value={orgName}
                    onChange={(e) => handleOrgNameChange(e.target.value)}
                    className="input"
                    placeholder="Acme Corp"
                  />
                </div>

                <div>
                  <label htmlFor="orgSlug" className="block text-sm font-medium text-gray-400 mb-1.5">
                    Organization slug
                  </label>
                  <input
                    id="orgSlug"
                    type="text"
                    required
                    value={orgSlug}
                    onChange={(e) => {
                      setOrgSlug(e.target.value);
                      setSlugEdited(true);
                    }}
                    className="input"
                    placeholder="acme-corp"
                    pattern="[a-z0-9-]+"
                    title="Lowercase letters, numbers, and dashes only"
                  />
                  <p className="text-xs text-gray-600 mt-1">Used in URLs. Auto-generated from org name.</p>
                </div>
              </>
            )}

            <button
              type="submit"
              disabled={loading}
              className={`w-full py-2.5 rounded-lg text-white font-medium text-sm transition-colors disabled:opacity-50 ${
                isTeam
                  ? 'bg-indigo-600 hover:bg-indigo-500'
                  : 'bg-emerald-600 hover:bg-emerald-500'
              }`}
            >
              {loading
                ? 'Creating account...'
                : isTeam
                ? 'Create team account'
                : 'Create developer account'}
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

          <div className="flex gap-2">
            <button
              onClick={async () => { try { localStorage.setItem('origin_oauth_account_type', accountType); const { url } = await api.getOAuthUrl('github'); window.location.href = url; } catch { setError('GitHub OAuth not available'); } }}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-750 hover:text-white transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
              GitHub
            </button>
            <button
              onClick={async () => { try { localStorage.setItem('origin_oauth_account_type', accountType); const { url } = await api.getOAuthUrl('gitlab'); window.location.href = url; } catch { setError('GitLab OAuth not available'); } }}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-750 hover:text-white transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.452.044 13.587a.924.924 0 00.331 1.023L12 23.054l11.625-8.443a.92.92 0 00.33-1.024"/></svg>
              GitLab
            </button>
            <button
              onClick={async () => { try { localStorage.setItem('origin_oauth_account_type', accountType); const { url } = await api.getOAuthUrl('google'); window.location.href = url; } catch { setError('Google OAuth not available'); } }}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-750 hover:text-white transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              Google
            </button>
          </div>

          {/* Developer info note */}
          {!isTeam && (
            <div className="mt-4 p-3 rounded-lg bg-gray-800/50 border border-gray-700/50">
              <p className="text-xs text-gray-500 leading-relaxed">
                A personal workspace is created automatically. You can join an organization later via invite link.
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 text-center">
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
