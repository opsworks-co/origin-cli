import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LogoMark } from '../components/Logo';
import * as api from '../api';
import { Check, AlertTriangle, Loader2 } from 'lucide-react';

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setError('No verification token provided');
      return;
    }
    api.verifyEmail(token)
      .then(() => setStatus('success'))
      .catch((err) => {
        setStatus('error');
        setError(err.message ?? 'Verification failed');
      });
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="absolute top-0 left-1/3 w-96 h-96 bg-emerald-600/5 rounded-full blur-3xl" />

      <div className="w-full max-w-sm relative">
        <Link to="/" className="flex items-center justify-center gap-2 mb-8 hover:opacity-80 transition-opacity">
          <LogoMark size={40} />
          <span className="text-xl font-semibold">Origin</span>
        </Link>

        <div className="card">
          {status === 'loading' && (
            <div className="text-center py-8">
              <Loader2 className="w-8 h-8 text-emerald-400 animate-spin mx-auto mb-4" />
              <p className="text-sm text-gray-400">Verifying your email...</p>
            </div>
          )}

          {status === 'success' && (
            <div className="text-center py-4">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
                <Check className="w-6 h-6 text-emerald-400" />
              </div>
              <h2 className="text-xl font-semibold mb-2">Email verified!</h2>
              <p className="text-sm text-gray-400 mb-6">
                Your email has been confirmed. You're all set.
              </p>
              <Link
                to="/me"
                className="inline-block w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm text-center transition-colors"
              >
                Go to Dashboard
              </Link>
            </div>
          )}

          {status === 'error' && (
            <div className="text-center py-4">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="w-6 h-6 text-red-400" />
              </div>
              <h2 className="text-xl font-semibold mb-2">Verification failed</h2>
              <p className="text-sm text-gray-400 mb-6">
                {error || 'This verification link is invalid or has expired.'}
              </p>
              <Link
                to="/login"
                className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
