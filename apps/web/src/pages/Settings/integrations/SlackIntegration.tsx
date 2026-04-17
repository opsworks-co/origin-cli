import React, { useState, useEffect } from 'react';
import * as api from '../../../api';

export default function SlackIntegration() {
  const [integrations, setIntegrations] = useState<api.IntegrationConfig[]>([]);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [integrationSuccess, setIntegrationSuccess] = useState<string | null>(null);

  // Slack
  const [slackWebhookUrl, setSlackWebhookUrl] = useState('');
  const [slackNotifyViolations, setSlackNotifyViolations] = useState(true);
  const [slackNotifyReviews, setSlackNotifyReviews] = useState(true);
  const [slackNotifyBudget, setSlackNotifyBudget] = useState(true);
  const [slackNotifySessionFlags, setSlackNotifySessionFlags] = useState(true);
  const [slackNotifySessionComplete, setSlackNotifySessionComplete] = useState(false);
  const [slackNotifyWeeklyDigest, setSlackNotifyWeeklyDigest] = useState(true);
  const [savingSlack, setSavingSlack] = useState(false);
  const [testingSlack, setTestingSlack] = useState(false);
  const [slackTestResult, setSlackTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  const fetchIntegrations = async () => {
    try {
      const data = await api.getIntegrations();
      setIntegrations(data);
      // Populate Slack integration state
      const slack = data.find((i) => i.provider === 'slack');
      if (slack) {
        setSlackNotifyViolations(slack.settings?.notifyViolations ?? true);
        setSlackNotifyReviews(slack.settings?.notifyReviews ?? true);
        setSlackNotifyBudget(slack.settings?.notifyBudget ?? true);
        setSlackNotifySessionFlags(slack.settings?.notifySessionFlags ?? true);
        setSlackNotifySessionComplete(slack.settings?.notifySessionComplete ?? false);
        setSlackNotifyWeeklyDigest(slack.settings?.notifyWeeklyDigest ?? true);
      }
    } catch (err: any) {
      setIntegrationError(err.message);
    }
  };

  useEffect(() => {
    fetchIntegrations();
  }, []);

  const handleSaveSlack = async () => {
    setSavingSlack(true);
    setIntegrationError(null);
    setIntegrationSuccess(null);
    setSlackTestResult(null);

    const existing = integrations.find((i) => i.provider === 'slack');
    const settings = {
      notifyViolations: slackNotifyViolations,
      notifyReviews: slackNotifyReviews,
      notifyBudget: slackNotifyBudget,
      notifySessionFlags: slackNotifySessionFlags,
      notifySessionComplete: slackNotifySessionComplete,
      notifyWeeklyDigest: slackNotifyWeeklyDigest,
    };

    try {
      if (existing) {
        const updateData: any = { settings };
        if (slackWebhookUrl) updateData.token = slackWebhookUrl;
        await api.updateIntegration(existing.id, updateData);
        setIntegrationSuccess('Slack integration updated');
      } else {
        if (!slackWebhookUrl) {
          setIntegrationError('Webhook URL is required');
          setSavingSlack(false);
          return;
        }
        await api.createIntegration({
          provider: 'slack',
          token: slackWebhookUrl,
          settings,
        });
        setIntegrationSuccess('Slack integration connected');
      }
      setSlackWebhookUrl('');
      await fetchIntegrations();
    } catch (err: any) {
      setIntegrationError(err.message);
    } finally {
      setSavingSlack(false);
    }
  };

  const handleTestSlack = async () => {
    setTestingSlack(true);
    setSlackTestResult(null);
    const slack = integrations.find((i) => i.provider === 'slack');
    if (!slack) return;
    try {
      const result = await api.testIntegration(slack.id);
      setSlackTestResult(result);
    } catch (err: any) {
      setSlackTestResult({ success: false, error: err.message });
    } finally {
      setTestingSlack(false);
    }
  };

  const handleDeleteIntegration = async (id: string) => {
    try {
      await api.deleteIntegration(id);
      setIntegrationSuccess('Integration removed');
      await fetchIntegrations();
    } catch (err: any) {
      setIntegrationError(err.message);
    }
  };

  return (
    <section className="card space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current">
              <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="#E01E5A"/>
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold">Slack</h2>
            <p className="text-sm text-gray-500">Get notified about policy violations and reviews</p>
          </div>
        </div>
        {integrations.find((i) => i.provider === 'slack') ? (
          <span className="badge-green text-xs">Connected</span>
        ) : (
          <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">Not Connected</span>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Webhook URL</label>
        <input
          type="url"
          value={slackWebhookUrl}
          onChange={(e) => setSlackWebhookUrl(e.target.value)}
          placeholder={integrations.find((i) => i.provider === 'slack') ? '••••••• (saved)' : 'https://hooks.slack.com/services/...'}
          className="input w-full"
        />
        <p className="text-xs text-gray-500 mt-1">
          Create one at{' '}
          <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300">
            api.slack.com/apps
          </a>{' '}
          → Incoming Webhooks
        </p>
      </div>

      <div className="space-y-3 border-t border-gray-700/50 pt-4">
        <h3 className="text-sm font-medium text-gray-300">Notification Events</h3>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={slackNotifyViolations}
            onChange={(e) => setSlackNotifyViolations(e.target.checked)}
            className="mt-0.5 rounded bg-gray-700 border-gray-600"
          />
          <div>
            <div className="text-sm font-medium text-gray-200">Policy violations</div>
            <div className="text-xs text-gray-500">When sessions trigger policy rules or agent limits</div>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={slackNotifySessionFlags}
            onChange={(e) => setSlackNotifySessionFlags(e.target.checked)}
            className="mt-0.5 rounded bg-gray-700 border-gray-600"
          />
          <div>
            <div className="text-sm font-medium text-gray-200">Session flags</div>
            <div className="text-xs text-gray-500">When sessions are auto-flagged for manual review</div>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={slackNotifyReviews}
            onChange={(e) => setSlackNotifyReviews(e.target.checked)}
            className="mt-0.5 rounded bg-gray-700 border-gray-600"
          />
          <div>
            <div className="text-sm font-medium text-gray-200">Review updates</div>
            <div className="text-xs text-gray-500">When sessions are approved, rejected, or need review</div>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={slackNotifyBudget}
            onChange={(e) => setSlackNotifyBudget(e.target.checked)}
            className="mt-0.5 rounded bg-gray-700 border-gray-600"
          />
          <div>
            <div className="text-sm font-medium text-gray-200">Budget alerts</div>
            <div className="text-xs text-gray-500">When spending approaches or exceeds monthly limits</div>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={slackNotifySessionComplete}
            onChange={(e) => setSlackNotifySessionComplete(e.target.checked)}
            className="mt-0.5 rounded bg-gray-700 border-gray-600"
          />
          <div>
            <div className="text-sm font-medium text-gray-200">Session completed</div>
            <div className="text-xs text-gray-500">When an AI coding session finishes (model, cost, files)</div>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={slackNotifyWeeklyDigest}
            onChange={(e) => setSlackNotifyWeeklyDigest(e.target.checked)}
            className="mt-0.5 rounded bg-gray-700 border-gray-600"
          />
          <div>
            <div className="text-sm font-medium text-gray-200">Weekly digest</div>
            <div className="text-xs text-gray-500">Weekly summary of AI sessions, costs, and team activity</div>
          </div>
        </label>
      </div>

      <div className="flex items-center gap-3 border-t border-gray-700/50 pt-4">
        <button
          onClick={handleSaveSlack}
          disabled={savingSlack}
          className="btn-primary text-sm"
        >
          {savingSlack ? 'Saving...' : integrations.find((i) => i.provider === 'slack') ? 'Update' : 'Connect'}
        </button>
        {integrations.find((i) => i.provider === 'slack') && (
          <>
            <button
              onClick={handleTestSlack}
              disabled={testingSlack}
              className="btn-secondary text-sm"
            >
              {testingSlack ? 'Testing...' : 'Test'}
            </button>
            <button
              onClick={() => handleDeleteIntegration(integrations.find((i) => i.provider === 'slack')!.id)}
              className="btn-secondary text-sm text-red-400 hover:text-red-300"
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      {slackTestResult && (
        <div
          className={`text-sm p-3 rounded-lg ${
            slackTestResult.success
              ? 'bg-green-900/20 text-green-400 border border-green-800/30'
              : 'bg-red-900/20 text-red-400 border border-red-800/30'
          }`}
        >
          {slackTestResult.success
            ? 'Test message sent successfully! Check your Slack channel.'
            : `Connection failed: ${slackTestResult.error}`}
        </div>
      )}
    </section>
  );
}
