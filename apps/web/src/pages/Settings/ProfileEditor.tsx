import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import * as api from '../../api';

export default function ProfileEditor() {
  const { user, activeOrg, applyAuthResponse } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl || '');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const isDirty = name !== (user?.name || '') || email !== (user?.email || '') || avatarUrl !== (user?.avatarUrl || '');

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const updated = await api.updateProfile({
        ...(name !== user?.name ? { name } : {}),
        ...(email !== user?.email ? { email } : {}),
        ...(avatarUrl !== (user?.avatarUrl || '') ? { avatarUrl } : {}),
      });
      applyAuthResponse(updated);
      setFeedback({ type: 'success', msg: 'Profile updated' });
      setTimeout(() => setFeedback(null), 3000);
    } catch (err: any) {
      setFeedback({ type: 'error', msg: err.message || 'Failed to update profile' });
    } finally {
      setSaving(false);
    }
  };

  const [verificationSent, setVerificationSent] = useState(false);
  const [sendingVerification, setSendingVerification] = useState(false);

  const handleSendVerification = async () => {
    setSendingVerification(true);
    try {
      await api.sendVerificationEmail();
      setVerificationSent(true);
    } catch (err: any) {
      setFeedback({ type: 'error', msg: err.message || 'Failed to send verification email' });
    } finally {
      setSendingVerification(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Email verification banner */}
      {user && !user.emailVerified && !user.provider && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-900/20 border border-amber-800/50">
          <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <p className="text-sm text-amber-300 flex-1">
            {verificationSent
              ? 'Verification email sent! Check your inbox.'
              : 'Your email is not verified.'}
          </p>
          {!verificationSent && (
            <button
              onClick={handleSendVerification}
              disabled={sendingVerification}
              className="text-xs font-medium text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-50"
            >
              {sendingVerification ? 'Sending...' : 'Verify now'}
            </button>
          )}
        </div>
      )}

      <div className="flex items-start gap-5">
        {/* Avatar — click to upload */}
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => document.getElementById('avatar-upload')?.click()}
            className="relative group w-16 h-16 rounded-full overflow-hidden ring-2 ring-gray-700 hover:ring-indigo-500/50 transition-all cursor-pointer"
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-indigo-500/20 to-indigo-600/20 flex items-center justify-center text-indigo-400 text-2xl font-medium">
                {name?.charAt(0).toUpperCase() ?? '?'}
              </div>
            )}
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </div>
          </button>
          <input
            id="avatar-upload"
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 512 * 1024) {
                setFeedback({ type: 'error', msg: 'Image must be under 512KB' });
                return;
              }
              const reader = new FileReader();
              reader.onloadend = () => {
                setAvatarUrl(reader.result as string);
              };
              reader.readAsDataURL(file);
            }}
          />
          <span className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700">
            {user?.accountType === 'developer' ? 'Solo' : activeOrg?.role}
          </span>
        </div>

        {/* Form fields */}
        <div className="flex-1 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Name</label>
            <input
              type="text"
              name="full-name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input w-full text-sm"
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Email</label>
            <input
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input w-full text-sm"
              placeholder="you@example.com"
            />
          </div>
        </div>
      </div>

      {feedback && (
        <div className={`text-sm px-3 py-2 rounded-lg ${
          feedback.type === 'success' ? 'bg-emerald-900/20 text-emerald-400 border border-emerald-800' : 'bg-red-900/20 text-red-400 border border-red-800'
        }`}>
          {feedback.msg}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
