import { useState } from 'react';
import * as api from '../../api';

export default function PasswordChanger() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const canSubmit = currentPassword && newPassword.length >= 8 && newPassword === confirmPassword;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setFeedback(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      setFeedback({ type: 'success', msg: 'Password updated successfully' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setFeedback(null), 3000);
    } catch (err: any) {
      setFeedback({ type: 'error', msg: err.message || 'Failed to change password' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Current Password</label>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full max-w-sm bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">New Password</label>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full max-w-sm bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
          placeholder="Min 8 characters"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Confirm New Password</label>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full max-w-sm bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
        />
        {confirmPassword && newPassword !== confirmPassword && (
          <p className="text-xs text-red-400 mt-1">Passwords don't match</p>
        )}
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
          onClick={handleSubmit}
          disabled={!canSubmit || saving}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Updating...' : 'Update Password'}
        </button>
      </div>
    </div>
  );
}
