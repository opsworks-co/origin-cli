import React, { useState, useEffect } from 'react';
import * as api from '../../../api';

export default function WeeklyEmailReport() {
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState('');
  const [emailSendDay, setEmailSendDay] = useState('monday');
  const [savingEmail, setSavingEmail] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchEmailSettings = async () => {
    try {
      const data = await api.getEmailSettings();
      setEmailEnabled(data.enabled);
      setEmailRecipients((data.recipients || []).join(', '));
      setEmailSendDay(data.sendDay || 'monday');
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchEmailSettings();
  }, []);

  const handleSaveEmail = async () => {
    setSavingEmail(true);
    setEmailMsg(null);
    try {
      const recipients = emailRecipients.split(',').map(e => e.trim()).filter(Boolean);
      await api.updateEmailSettings({ enabled: emailEnabled, recipients, sendDay: emailSendDay });
      setEmailMsg({ type: 'success', text: 'Email settings saved' });
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err.message });
    } finally {
      setSavingEmail(false);
    }
  };

  const handleTestEmail = async () => {
    setTestingEmail(true);
    setEmailMsg(null);
    try {
      const result = await api.testEmail();
      setEmailMsg(result.success
        ? { type: 'success', text: 'Test email sent! Check your inbox.' }
        : { type: 'error', text: result.error || 'Failed to send' }
      );
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err.message });
    } finally {
      setTestingEmail(false);
    }
  };

  return (
    <section className="card space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
            <svg className="w-6 h-6 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold">Weekly Email Report</h2>
            <p className="text-sm text-gray-500">Automated weekly summary sent to your team</p>
          </div>
        </div>
        {emailEnabled ? (
          <span className="badge-green text-xs">Enabled</span>
        ) : (
          <span className="badge-gray text-xs">Disabled</span>
        )}
      </div>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={emailEnabled}
          onChange={(e) => setEmailEnabled(e.target.checked)}
          className="rounded bg-gray-700 border-gray-600"
        />
        <div>
          <div className="text-sm font-medium text-gray-200">Enable weekly email reports</div>
          <div className="text-xs text-gray-500">Sends every Monday at 9 AM with session/cost summary</div>
        </div>
      </label>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Recipients (comma-separated)</label>
        <input
          type="text"
          value={emailRecipients}
          onChange={(e) => setEmailRecipients(e.target.value)}
          className="input"
          placeholder="cto@company.com, lead@company.com (leave empty for all admins)"
        />
        <p className="text-xs text-gray-600 mt-1">Leave empty to send to all org admins</p>
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-1">Send day</label>
        <select
          value={emailSendDay}
          onChange={(e) => setEmailSendDay(e.target.value)}
          className="select"
        >
          <option value="monday">Monday</option>
          <option value="tuesday">Tuesday</option>
          <option value="wednesday">Wednesday</option>
          <option value="thursday">Thursday</option>
          <option value="friday">Friday</option>
        </select>
      </div>

      <div className="flex items-center gap-3 border-t border-gray-700/50 pt-4">
        <button onClick={handleSaveEmail} disabled={savingEmail} className="btn-primary text-sm">
          {savingEmail ? 'Saving...' : 'Save'}
        </button>
        <button onClick={handleTestEmail} disabled={testingEmail} className="btn-secondary text-sm">
          {testingEmail ? 'Sending...' : 'Send Test Email'}
        </button>
      </div>

      {emailMsg && (
        <div className={`text-sm p-3 rounded-lg ${emailMsg.type === 'success' ? 'bg-green-900/20 text-green-400 border border-green-800/30' : 'bg-red-900/20 text-red-400 border border-red-800/30'}`}>
          {emailMsg.text}
        </div>
      )}

      <p className="text-xs text-gray-600">Requires RESEND_API_KEY environment variable on the server.</p>
    </section>
  );
}
