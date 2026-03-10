import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';

export default function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { setSession } = useAuth();

  const [inviteInfo, setInviteInfo] = useState<{ orgName: string; role: string; email: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!token) return;
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
      setSession(res.token, res.user);
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

  if (!inviteInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-center space-y-4">
          <div className="text-4xl">🔗</div>
          <h1 className="text-xl font-bold text-gray-200">Invalid or Expired Invite</h1>
          <p className="text-sm text-gray-500">{error || 'This invitation link is no longer valid.'}</p>
          <a href="/login" className="text-sm text-indigo-400 hover:text-indigo-300">
            Go to Login →
          </a>
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
