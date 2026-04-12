import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';

export default function OAuthCallback() {
  const { provider } = useParams<{ provider: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const [error, setError] = useState('');

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    if (!code || !state || !provider) {
      setError('Missing authorization code or state');
      return;
    }

    let accountType: string | undefined;
    try {
      accountType = localStorage.getItem('origin_oauth_account_type') || undefined;
      localStorage.removeItem('origin_oauth_account_type');
    } catch { accountType = undefined; }

    api.oauthCallback(provider, code, state, accountType)
      .then((res) => {
        setSession(res.token, res.user);
        navigate(res.user.accountType === 'developer' ? '/me' : '/dashboard', { replace: true });
      })
      .catch((err) => {
        setError(err.message || 'OAuth authentication failed');
      });
  }, [provider, searchParams, setSession, navigate]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="card p-6">
            <div className="text-red-400 text-lg font-medium mb-2">Authentication Failed</div>
            <p className="text-sm text-gray-400 mb-4">{error}</p>
            <a href="/login" className="text-indigo-400 hover:text-indigo-300 text-sm">
              Back to login
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mx-auto mb-4" />
        <p className="text-sm text-gray-400">Signing in with {provider}...</p>
      </div>
    </div>
  );
}
