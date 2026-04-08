import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '../api';

export default function Integrations() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Integrations
  const [integrations, setIntegrations] = useState<api.IntegrationConfig[]>([]);
  const [loadingIntegrations, setLoadingIntegrations] = useState(false);
  const [ghToken, setGhToken] = useState('');
  const [ghBaseUrl, setGhBaseUrl] = useState('');
  const [ghPostChecks, setGhPostChecks] = useState(true);
  const [ghPostComments, setGhPostComments] = useState(true);
  const [ghCheckOnReview, setGhCheckOnReview] = useState(true);
  const [savingIntegration, setSavingIntegration] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; login?: string; error?: string } | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [integrationSuccess, setIntegrationSuccess] = useState<string | null>(null);
  const [webhookEvents, setWebhookEvents] = useState<api.AuditEntry[]>([]);

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

  // GitLab
  const [glToken, setGlToken] = useState('');
  const [glBaseUrl, setGlBaseUrl] = useState('');
  const [glPostChecks, setGlPostChecks] = useState(true);
  const [glPostComments, setGlPostComments] = useState(true);
  const [glCheckOnReview, setGlCheckOnReview] = useState(true);
  const [savingGitlab, setSavingGitlab] = useState(false);
  const [testingGitlab, setTestingGitlab] = useState(false);
  const [glTestResult, setGlTestResult] = useState<{ success: boolean; login?: string; error?: string } | null>(null);

  // GitLab OAuth
  const [gitlabOAuthStatus, setGitlabOAuthStatus] = useState<{
    connected: boolean;
    authType: string | null;
    serverConfigured: boolean;
    username?: string;
  } | null>(null);
  const [connectingGitlabOAuth, setConnectingGitlabOAuth] = useState(false);
  const [glOAuthAppId, setGlOAuthAppId] = useState('');
  const [glOAuthAppSecret, setGlOAuthAppSecret] = useState('');
  const [glOAuthRedirectUri, setGlOAuthRedirectUri] = useState('');
  const [glOAuthConfigSource, setGlOAuthConfigSource] = useState<'none' | 'environment' | 'database'>('none');
  const [savingGlOAuthConfig, setSavingGlOAuthConfig] = useState(false);

  // GitHub App
  const [githubAppStatus, setGithubAppStatus] = useState<{
    installed: boolean;
    serverConfigured: boolean;
    installationId?: string;
    appSlug?: string;
  } | null>(null);
  const [installingApp, setInstallingApp] = useState(false);
  const [showLinkExisting, setShowLinkExisting] = useState(false);
  const [linkGithubAccount, setLinkGithubAccount] = useState('');

  // Email report
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState('');
  const [emailSendDay, setEmailSendDay] = useState('monday');
  const [savingEmail, setSavingEmail] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // AI Chat config
  const [chatApiKey, setChatApiKey] = useState('');
  const [chatModel, setChatModel] = useState('claude-sonnet-4-20250514');
  const [chatProvider, setChatProvider] = useState<'anthropic' | 'openai' | 'google'>('anthropic');
  const [chatConfigured, setChatConfigured] = useState(false);
  const [chatSource, setChatSource] = useState<'none' | 'environment' | 'org'>('none');
  const [chatLoading, setChatLoading] = useState(false);
  const [savingChat, setSavingChat] = useState(false);
  const [testingChat, setTestingChat] = useState(false);
  const [chatTestResult, setChatTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [chatMsg, setChatMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Collapsible sections — click card to expand, click again to collapse
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const toggleSection = (section: string) => setExpandedSection(prev => prev === section ? null : section);

  // Handle GitHub App / GitLab OAuth callback URL params
  useEffect(() => {
    const githubAppResult = searchParams.get('github_app');
    if (githubAppResult === 'success') {
      setIntegrationSuccess('GitHub App installed successfully!');
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('github_app');
      setSearchParams(newParams);
    } else if (githubAppResult === 'error') {
      const msg = searchParams.get('msg') || 'Unknown error';
      setIntegrationError(`GitHub App installation failed: ${msg}`);
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('github_app');
      newParams.delete('msg');
      setSearchParams(newParams);
    } else if (githubAppResult === 'requested') {
      setIntegrationSuccess('GitHub App installation requested. Your organization owner needs to approve it.');
    }

    const gitlabOAuthResult = searchParams.get('gitlab_oauth');
    if (gitlabOAuthResult === 'success') {
      setIntegrationSuccess('GitLab connected via OAuth successfully!');
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('gitlab_oauth');
      setSearchParams(newParams);
    } else if (gitlabOAuthResult === 'error') {
      const msg = searchParams.get('msg') || 'Unknown error';
      setIntegrationError(`GitLab OAuth failed: ${msg}`);
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('gitlab_oauth');
      newParams.delete('msg');
      setSearchParams(newParams);
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchIntegrations();
    fetchWebhookEvents();
    fetchChatConfig();
    fetchEmailSettings();
  }, []);

  const fetchIntegrations = async () => {
    setLoadingIntegrations(true);
    try {
      const [data, appStatus, glOAuthStatus, glOAuthConfig] = await Promise.all([
        api.getIntegrations(),
        api.getGitHubAppStatus().catch(() => null),
        api.getGitLabOAuthStatus().catch(() => null),
        api.getGitLabOAuthConfig().catch(() => null),
      ]);
      setIntegrations(data);
      if (appStatus) setGithubAppStatus(appStatus);
      if (glOAuthStatus) setGitlabOAuthStatus(glOAuthStatus);
      if (glOAuthConfig) {
        setGlOAuthConfigSource(glOAuthConfig.source);
        if (glOAuthConfig.clientId) setGlOAuthAppId(glOAuthConfig.clientId);
        if (glOAuthConfig.redirectUri) setGlOAuthRedirectUri(glOAuthConfig.redirectUri);
      }
      // Populate form with existing GitHub integration
      const gh = data.find((i) => i.provider === 'github');
      if (gh) {
        setGhBaseUrl(gh.baseUrl || '');
        setGhPostChecks(gh.settings?.postChecks ?? true);
        setGhPostComments(gh.settings?.postComments ?? true);
        setGhCheckOnReview(gh.settings?.checkOnReview ?? true);
      }
      // Populate GitLab integration state
      const gl = data.find((i) => i.provider === 'gitlab');
      if (gl) {
        setGlBaseUrl(gl.baseUrl || '');
        setGlPostChecks(gl.settings?.postChecks ?? true);
        setGlPostComments(gl.settings?.postComments ?? true);
        setGlCheckOnReview(gl.settings?.checkOnReview ?? true);
      }
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
    } finally {
      setLoadingIntegrations(false);
    }
  };

  const fetchWebhookEvents = async () => {
    try {
      const data = await api.getAuditLogs({ action: 'WEBHOOK_RECEIVED', limit: 5 });
      const prData = await api.getAuditLogs({ action: 'WEBHOOK_PR_RECEIVED', limit: 5 });
      const all = [...data.entries, ...prData.entries]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10);
      setWebhookEvents(all);
    } catch { /* ignore */ }
  };

  const fetchChatConfig = async () => {
    setChatLoading(true);
    try {
      const res = await fetch('/api/settings/chat', { headers: { Authorization: `Bearer ${localStorage.getItem('origin_token')}` } });
      const data = await res.json();
      setChatConfigured(data.configured || data.hasKey);
      setChatProvider(data.llmProvider || 'anthropic');
      setChatModel(data.model || 'claude-sonnet-4-20250514');
      setChatSource(data.source || 'none');
    } catch { /* ignore */ }
    setChatLoading(false);
  };

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

  const handleSaveChatConfig = async () => {
    if (!chatApiKey) { setChatMsg({ type: 'error', text: 'API key is required' }); return; }
    setSavingChat(true);
    setChatMsg(null);
    try {
      const res = await fetch('/api/settings/chat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('origin_token')}` },
        body: JSON.stringify({ apiKey: chatApiKey, model: chatModel, llmProvider: chatProvider }),
      });
      const data = await res.json();
      if (res.ok) {
        setChatMsg({ type: 'success', text: 'AI Chat configuration saved' });
        setChatConfigured(true);
        setChatSource('org');
        setChatApiKey('');
      } else {
        setChatMsg({ type: 'error', text: data.error || 'Failed to save' });
      }
    } catch (err: any) {
      setChatMsg({ type: 'error', text: err.message });
    }
    setSavingChat(false);
  };

  const handleTestChat = async () => {
    setTestingChat(true);
    setChatTestResult(null);
    try {
      const res = await fetch('/api/settings/chat/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('origin_token')}` },
        body: JSON.stringify({ apiKey: chatApiKey || undefined, llmProvider: chatProvider }),
      });
      const data = await res.json();
      setChatTestResult(data);
    } catch (err: any) {
      setChatTestResult({ success: false, error: err.message });
    }
    setTestingChat(false);
  };

  const handleSaveIntegration = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingIntegration(true);
    setIntegrationError(null);
    setIntegrationSuccess(null);

    const existing = integrations.find((i) => i.provider === 'github');
    const settings = { postChecks: ghPostChecks, postComments: ghPostComments, checkOnReview: ghCheckOnReview };

    try {
      if (existing) {
        const updateData: any = { settings, baseUrl: ghBaseUrl };
        if (ghToken) updateData.token = ghToken;
        await api.updateIntegration(existing.id, updateData);
        setIntegrationSuccess('GitHub integration updated');
      } else {
        if (!ghToken) {
          setIntegrationError('Token is required to create a new integration');
          setSavingIntegration(false);
          return;
        }
        await api.createIntegration({
          provider: 'github',
          token: ghToken,
          baseUrl: ghBaseUrl,
          settings,
        });
        setIntegrationSuccess('GitHub integration connected');
      }
      setGhToken('');
      await fetchIntegrations();
    } catch (err: any) {
      setIntegrationError(err.message);
    } finally {
      setSavingIntegration(false);
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

  const handleTestConnection = async (id: string) => {
    setTestingConnection(true);
    setTestResult(null);
    try {
      const result = await api.testIntegration(id);
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleSaveGitlab = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingGitlab(true);
    setIntegrationError(null);
    setIntegrationSuccess(null);

    const existing = integrations.find((i) => i.provider === 'gitlab');
    const settings = { postChecks: glPostChecks, postComments: glPostComments, checkOnReview: glCheckOnReview };

    try {
      if (existing) {
        const updateData: any = { settings, baseUrl: glBaseUrl };
        if (glToken) updateData.token = glToken;
        await api.updateIntegration(existing.id, updateData);
        setIntegrationSuccess('GitLab integration updated');
      } else {
        if (!glToken) {
          setIntegrationError('Token is required to create a new integration');
          setSavingGitlab(false);
          return;
        }
        await api.createIntegration({
          provider: 'gitlab',
          token: glToken,
          baseUrl: glBaseUrl || 'https://gitlab.com/api/v4',
          settings,
        });
        setIntegrationSuccess('GitLab integration connected');
      }
      setGlToken('');
      await fetchIntegrations();
    } catch (err: any) {
      setIntegrationError(err.message);
    } finally {
      setSavingGitlab(false);
    }
  };

  const handleTestGitlab = async (id: string) => {
    setTestingGitlab(true);
    setGlTestResult(null);
    try {
      const result = await api.testIntegration(id);
      setGlTestResult(result);
    } catch (err: any) {
      setGlTestResult({ success: false, error: err.message });
    } finally {
      setTestingGitlab(false);
    }
  };

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

  const handleInstallGitHubApp = async () => {
    setInstallingApp(true);
    setIntegrationError(null);
    try {
      const { installUrl } = await api.getGitHubAppInstallUrl();
      window.location.href = installUrl;
    } catch (err: any) {
      setIntegrationError(err.message || 'Failed to start GitHub App installation');
      setInstallingApp(false);
    }
  };

  const handleLinkGitHubAccount = async () => {
    if (!linkGithubAccount.trim()) return;
    setInstallingApp(true);
    setIntegrationError(null);
    try {
      const result = await api.detectGitHubApp({ githubAccount: linkGithubAccount.trim() });
      if (result.linked) {
        setIntegrationSuccess(`Connected to GitHub account "${result.account || linkGithubAccount}"`);
        const [status, intgs] = await Promise.all([
          api.getGitHubAppStatus(),
          api.getIntegrations(),
        ]);
        setGithubAppStatus(status);
        setIntegrations(intgs || []);
        setShowLinkExisting(false);
        setLinkGithubAccount('');
      }
    } catch (err: any) {
      setIntegrationError(err.message || 'Failed to link GitHub account');
    } finally {
      setInstallingApp(false);
    }
  };

  const handleTestGitHubApp = async () => {
    setTestingConnection(true);
    setTestResult(null);
    try {
      const result = await api.testGitHubApp();
      setTestResult({
        success: result.success,
        login: result.account ? `${result.appSlug} (installed on @${result.account})` : result.appSlug,
        error: result.error,
      });
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setTestingConnection(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-sm text-gray-500 mt-1">Connect your tools and services</p>
      </div>

      {/* Global messages */}
      {integrationError && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-400 text-sm flex items-center justify-between">
          {integrationError}
          <button onClick={() => setIntegrationError(null)} className="text-red-600 hover:text-red-400 ml-2">&times;</button>
        </div>
      )}
      {integrationSuccess && (
        <div className="bg-green-900/20 border border-green-800 rounded-lg p-3 text-green-400 text-sm flex items-center justify-between">
          {integrationSuccess}
          <button onClick={() => setIntegrationSuccess(null)} className="text-green-600 hover:text-green-400 ml-2">&times;</button>
        </div>
      )}

      {/* Integration cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* GitHub summary card */}
        {(() => {
          const gh = integrations.find((i) => i.provider === 'github');
          const isConnected = !!gh;
          const isApp = gh?.authType === 'github_app';
          return (
            <div
              className={`rounded-xl border p-4 cursor-pointer transition-all hover:border-gray-600 ${isConnected ? 'border-green-800/50 bg-green-900/5' : 'border-gray-800 bg-gray-900/50'}`}
              onClick={() => toggleSection('github')}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isConnected ? 'bg-green-900/30' : 'bg-gray-800'}`}>
                  <svg viewBox="0 0 24 24" className="w-5 h-5 fill-gray-200"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-200">GitHub</h3>
                    {isConnected ? (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-900/30 text-green-400">{isApp ? 'App' : 'PAT'}</span>
                    ) : (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-800 text-gray-500">Not connected</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">PR status checks and comments</p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* GitLab summary card */}
        {(() => {
          const gl = integrations.find((i) => i.provider === 'gitlab');
          const isConnected = !!gl || gitlabOAuthStatus?.connected;
          return (
            <div
              className={`rounded-xl border p-4 cursor-pointer transition-all hover:border-gray-600 ${isConnected ? 'border-green-800/50 bg-green-900/5' : 'border-gray-800 bg-gray-900/50'}`}
              onClick={() => toggleSection('gitlab')}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isConnected ? 'bg-green-900/30' : 'bg-gray-800'}`}>
                  <svg viewBox="0 0 24 24" className="w-5 h-5 fill-orange-400"><path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-200">GitLab</h3>
                    {isConnected ? (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-900/30 text-green-400">Connected</span>
                    ) : (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-800 text-gray-500">Not connected</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">MR statuses and comments</p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Slack summary card */}
        {(() => {
          const slack = integrations.find((i) => i.provider === 'slack');
          return (
            <div
              className={`rounded-xl border p-4 cursor-pointer transition-all hover:border-gray-600 ${slack ? 'border-green-800/50 bg-green-900/5' : 'border-gray-800 bg-gray-900/50'}`}
              onClick={() => toggleSection('slack')}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${slack ? 'bg-green-900/30' : 'bg-gray-800'}`}>
                  <svg viewBox="0 0 24 24" className="w-5 h-5 fill-pink-400"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-200">Slack</h3>
                    {slack ? (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-900/30 text-green-400">Connected</span>
                    ) : (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-800 text-gray-500">Not connected</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">Notifications and alerts</p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* AI Chat summary card */}
        <div
          className={`rounded-xl border p-4 cursor-pointer transition-all hover:border-gray-600 ${chatConfigured ? 'border-green-800/50 bg-green-900/5' : 'border-gray-800 bg-gray-900/50'}`}
          onClick={() => toggleSection('chat')}
        >
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${chatConfigured ? 'bg-green-900/30' : 'bg-gray-800'}`}>
              <svg className="w-5 h-5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-200">AI Chat</h3>
                {chatConfigured ? (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-900/30 text-green-400">Configured</span>
                ) : (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-800 text-gray-500">Not configured</span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">AI assistant for your org</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Detailed configuration sections (collapsible) ── */}

      {/* GitHub Integration */}
      {expandedSection === 'github' && (
      <section className="card space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-gray-200"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold">GitHub</h2>
              <p className="text-xs text-gray-500">Post status checks and comments on pull requests</p>
            </div>
          </div>
          {(() => {
            const gh = integrations.find((i) => i.provider === 'github');
            if (!gh) return <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-gray-800 text-gray-500">Not Connected</span>;
            if (gh.authType === 'github_app') return <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-green-900/30 text-green-400 border border-green-800/50">GitHub App</span>;
            return <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-green-900/30 text-green-400 border border-green-800/50">Connected (PAT)</span>;
          })()}
        </div>

        {loadingIntegrations ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <div className="space-y-6">
            {/* GitHub App (Recommended) */}
            {githubAppStatus?.serverConfigured && (
              <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-200">GitHub App</span>
                  <span className="text-xs bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full">Recommended</span>
                </div>
                <div className="text-xs text-gray-400 space-y-1">
                  <p>One-click install. Status checks appear under the "Origin" bot identity.</p>
                  <p>Automatic webhook setup — no per-repo configuration needed.</p>
                </div>

                {(() => {
                  const gh = integrations.find((i) => i.provider === 'github');
                  const isApp = gh?.authType === 'github_app';

                  if (isApp) {
                    return (
                      <div className="space-y-3">
                        <div className="bg-green-900/20 border border-green-800/50 rounded-lg p-3 text-sm text-green-400 flex items-center gap-2">
                          <span>GitHub App installed</span>
                          {githubAppStatus?.installationId && (
                            <span className="text-green-600 text-xs">(Installation #{githubAppStatus.installationId})</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={handleTestGitHubApp}
                            disabled={testingConnection}
                            className="btn-secondary text-sm"
                          >
                            {testingConnection ? 'Testing...' : 'Test Connection'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteIntegration(gh!.id)}
                            className="text-sm text-red-400 hover:text-red-300"
                          >
                            Disconnect
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-3">
                      <button
                        type="button"
                        onClick={handleInstallGitHubApp}
                        disabled={installingApp}
                        className="btn-primary text-sm"
                      >
                        {installingApp ? 'Checking...' : 'Install GitHub App'}
                      </button>
                      {showLinkExisting ? (
                        <div className="space-y-2 pt-1">
                          <p className="text-sm text-gray-400">
                            Enter your GitHub username or organization:
                          </p>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={linkGithubAccount}
                              onChange={(e) => setLinkGithubAccount(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleLinkGitHubAccount()}
                              placeholder="e.g. dolobanko"
                              className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={handleLinkGitHubAccount}
                              disabled={installingApp || !linkGithubAccount.trim()}
                              className="btn-primary text-sm"
                            >
                              {installingApp ? 'Linking...' : 'Link'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowLinkExisting(true)}
                          className="block text-sm text-gray-500 hover:text-gray-400"
                        >
                          Already installed? Link existing installation
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Divider */}
            {githubAppStatus?.serverConfigured && (
              <div className="flex items-center gap-3">
                <div className="flex-1 border-t border-gray-700" />
                <span className="text-xs text-gray-500">or use a Personal Access Token</span>
                <div className="flex-1 border-t border-gray-700" />
              </div>
            )}

            {/* PAT Section */}
            {(() => {
              const gh = integrations.find((i) => i.provider === 'github');
              const isApp = gh?.authType === 'github_app';

              // If GitHub App is connected, collapse PAT section
              if (isApp) {
                return (
                  <div className="text-xs text-gray-500">
                    GitHub App is active. PAT configuration is disabled while the App is connected.
                  </div>
                );
              }

              return (
                <form onSubmit={handleSaveIntegration} className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">
                      Personal Access Token {gh && (
                        <span className="text-gray-600">(leave blank to keep current)</span>
                      )}
                    </label>
                    <input
                      type="password"
                      value={ghToken}
                      onChange={(e) => setGhToken(e.target.value)}
                      className="input"
                      placeholder={gh ? 'ghp_****... (saved)' : 'ghp_xxxxxxxxxxxx'}
                    />
                    <p className="text-xs text-gray-600 mt-1">
                      Requires <code className="text-gray-500">repo</code> scope for status checks and PR comments
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-1">
                      API Base URL <span className="text-gray-600">(optional, for GitHub Enterprise)</span>
                    </label>
                    <input
                      value={ghBaseUrl}
                      onChange={(e) => setGhBaseUrl(e.target.value)}
                      className="input"
                      placeholder="https://api.github.com (default)"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      type="submit"
                      disabled={savingIntegration}
                      className="btn-primary text-sm"
                    >
                      {savingIntegration ? 'Saving...' : gh ? 'Update' : 'Connect GitHub'}
                    </button>

                    {gh && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleTestConnection(gh.id)}
                          disabled={testingConnection}
                          className="btn-secondary text-sm"
                        >
                          {testingConnection ? 'Testing...' : 'Test Connection'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteIntegration(gh.id)}
                          className="text-sm text-red-400 hover:text-red-300"
                        >
                          Disconnect
                        </button>
                      </>
                    )}
                  </div>
                </form>
              );
            })()}

            {/* Feature Toggles (shared between App and PAT) */}
            {integrations.find((i) => i.provider === 'github') && (
              <div className="space-y-3 border-t border-gray-700 pt-4">
                <p className="text-sm font-medium text-gray-300">Features</p>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ghPostChecks}
                    onChange={(e) => {
                      setGhPostChecks(e.target.checked);
                      const gh = integrations.find((i) => i.provider === 'github');
                      if (gh) {
                        api.updateIntegration(gh.id, {
                          settings: { postChecks: e.target.checked, postComments: ghPostComments, checkOnReview: ghCheckOnReview },
                        });
                      }
                    }}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="text-sm text-gray-200">Post status checks on PRs</span>
                    <p className="text-xs text-gray-500">Shows pass/fail based on AI session review status</p>
                  </div>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ghPostComments}
                    onChange={(e) => {
                      setGhPostComments(e.target.checked);
                      const gh = integrations.find((i) => i.provider === 'github');
                      if (gh) {
                        api.updateIntegration(gh.id, {
                          settings: { postChecks: ghPostChecks, postComments: e.target.checked, checkOnReview: ghCheckOnReview },
                        });
                      }
                    }}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="text-sm text-gray-200">Post session summary comments</span>
                    <p className="text-xs text-gray-500">Adds an AI governance report comment to each PR</p>
                  </div>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ghCheckOnReview}
                    onChange={(e) => {
                      setGhCheckOnReview(e.target.checked);
                      const gh = integrations.find((i) => i.provider === 'github');
                      if (gh) {
                        api.updateIntegration(gh.id, {
                          settings: { postChecks: ghPostChecks, postComments: ghPostComments, checkOnReview: e.target.checked },
                        });
                      }
                    }}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="text-sm text-gray-200">Update checks on review</span>
                    <p className="text-xs text-gray-500">Refreshes PR status when sessions are approved/rejected in Origin</p>
                  </div>
                </label>
              </div>
            )}

            {testResult && (
              <div
                className={`rounded-lg p-3 text-sm ${
                  testResult.success
                    ? 'bg-green-900/20 border border-green-800 text-green-400'
                    : 'bg-red-900/20 border border-red-800 text-red-400'
                }`}
              >
                {testResult.success
                  ? `Connected as @${testResult.login}`
                  : `Connection failed: ${testResult.error}`}
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {/* GitLab Integration */}
      {expandedSection === 'gitlab' && (
      <section className="card space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-orange-400">
                <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold">GitLab</h2>
              <p className="text-xs text-gray-500">Post commit statuses and comments on merge requests</p>
            </div>
          </div>
          {gitlabOAuthStatus?.connected ? (
            <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-green-900/30 text-green-400 border border-green-800/50">Connected (OAuth)</span>
          ) : integrations.find((i) => i.provider === 'gitlab') ? (
            <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-green-900/30 text-green-400 border border-green-800/50">Connected (PAT)</span>
          ) : (
            <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-gray-800 text-gray-500">Not Connected</span>
          )}
        </div>

        {loadingIntegrations ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <div className="space-y-6">
            {/* GitLab OAuth Section */}
            <div className="space-y-3 pb-4 border-b border-gray-700">
              <p className="text-sm font-medium text-gray-300">OAuth App</p>
              {gitlabOAuthStatus?.connected ? (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-300">
                    Connected as <strong className="text-white">@{gitlabOAuthStatus.username || 'unknown'}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const result = await api.testGitLabOAuth();
                        setGlTestResult(result);
                      } catch (err: any) {
                        setGlTestResult({ success: false, error: err.message });
                      }
                    }}
                    className="btn-secondary text-sm"
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await api.disconnectGitLabOAuth();
                        setGitlabOAuthStatus({ ...gitlabOAuthStatus, connected: false, username: undefined });
                        await fetchIntegrations();
                        setIntegrationSuccess('GitLab OAuth disconnected.');
                      } catch (err: any) {
                        setIntegrationError(err.message);
                      }
                    }}
                    className="text-sm text-red-400 hover:text-red-300"
                  >
                    Disconnect
                  </button>
                </div>
              ) : gitlabOAuthStatus?.serverConfigured ? (
                <div>
                  <button
                    type="button"
                    disabled={connectingGitlabOAuth}
                    onClick={async () => {
                      setConnectingGitlabOAuth(true);
                      try {
                        const { authorizeUrl } = await api.getGitLabOAuthInstallUrl();
                        window.location.href = authorizeUrl;
                      } catch (err: any) {
                        setIntegrationError(err.message);
                        setConnectingGitlabOAuth(false);
                      }
                    }}
                    className="btn-primary text-sm"
                  >
                    {connectingGitlabOAuth ? 'Redirecting...' : 'Connect with GitLab'}
                  </button>
                  <p className="text-xs text-gray-600 mt-1">Authorize via GitLab OAuth — no PAT needed</p>
                  {glOAuthConfigSource === 'database' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await api.deleteGitLabOAuthConfig();
                          setGlOAuthConfigSource('none');
                          setGlOAuthAppId('');
                          setGlOAuthAppSecret('');
                          setGlOAuthRedirectUri('');
                          setGitlabOAuthStatus((prev) => prev ? { ...prev, serverConfigured: false } : null);
                          setIntegrationSuccess('GitLab OAuth app config removed.');
                        } catch (err: any) {
                          setIntegrationError(err.message);
                        }
                      }}
                      className="text-xs text-gray-500 hover:text-gray-400 mt-2 underline"
                    >
                      Remove OAuth app config
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-gray-500">
                    Register a GitLab OAuth Application at <strong className="text-gray-400">GitLab &rarr; Preferences &rarr; Applications</strong>, then enter the credentials below.
                  </p>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Application ID</label>
                    <input
                      value={glOAuthAppId}
                      onChange={(e) => setGlOAuthAppId(e.target.value)}
                      className="input w-full"
                      placeholder="GitLab Application ID"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Secret</label>
                    <input
                      type="password"
                      value={glOAuthAppSecret}
                      onChange={(e) => setGlOAuthAppSecret(e.target.value)}
                      className="input w-full"
                      placeholder="GitLab Application Secret"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Redirect URI</label>
                    <input
                      value={glOAuthRedirectUri}
                      onChange={(e) => setGlOAuthRedirectUri(e.target.value)}
                      className="input w-full"
                      placeholder={`${window.location.origin}/api/gitlab-oauth/callback`}
                    />
                    <p className="text-xs text-gray-600 mt-1">Must match the redirect URI in your GitLab application</p>
                  </div>
                  <button
                    type="button"
                    disabled={savingGlOAuthConfig || !glOAuthAppId || !glOAuthAppSecret || !glOAuthRedirectUri}
                    onClick={async () => {
                      setSavingGlOAuthConfig(true);
                      try {
                        await api.saveGitLabOAuthConfig({
                          clientId: glOAuthAppId,
                          clientSecret: glOAuthAppSecret,
                          redirectUri: glOAuthRedirectUri,
                        });
                        setGlOAuthConfigSource('database');
                        setGitlabOAuthStatus((prev) => prev ? { ...prev, serverConfigured: true } : { connected: false, authType: null, serverConfigured: true });
                        setIntegrationSuccess('GitLab OAuth app configured! Click "Connect with GitLab" to authorize.');
                      } catch (err: any) {
                        setIntegrationError(err.message);
                      } finally {
                        setSavingGlOAuthConfig(false);
                      }
                    }}
                    className="btn-primary text-sm"
                  >
                    {savingGlOAuthConfig ? 'Saving...' : 'Save OAuth App Config'}
                  </button>
                </div>
              )}
            </div>

            {/* PAT Section (hidden when OAuth is active) */}
            {!gitlabOAuthStatus?.connected && (
            <form onSubmit={handleSaveGitlab} className="space-y-4">
              {gitlabOAuthStatus?.serverConfigured && (
                <p className="text-xs text-gray-500">Or connect with a Personal Access Token:</p>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1">
                  Personal Access Token {integrations.find((i) => i.provider === 'gitlab') && (
                    <span className="text-gray-600">(leave blank to keep current)</span>
                  )}
                </label>
                <input
                  type="password"
                  value={glToken}
                  onChange={(e) => setGlToken(e.target.value)}
                  className="input"
                  placeholder={integrations.find((i) => i.provider === 'gitlab') ? 'glpat-****... (saved)' : 'glpat-xxxxxxxxxxxx'}
                />
                <p className="text-xs text-gray-600 mt-1">
                  Requires <code className="text-gray-500">api</code> scope for commit statuses, MR comments, and webhook management
                </p>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">
                  API Base URL <span className="text-gray-600">(optional, for self-hosted GitLab)</span>
                </label>
                <input
                  value={glBaseUrl}
                  onChange={(e) => setGlBaseUrl(e.target.value)}
                  className="input"
                  placeholder="https://gitlab.com/api/v4 (default)"
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={savingGitlab}
                  className="btn-primary text-sm"
                >
                  {savingGitlab ? 'Saving...' : integrations.find((i) => i.provider === 'gitlab') ? 'Update' : 'Connect GitLab'}
                </button>

                {integrations.find((i) => i.provider === 'gitlab') && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleTestGitlab(integrations.find((i) => i.provider === 'gitlab')!.id)}
                      disabled={testingGitlab}
                      className="btn-secondary text-sm"
                    >
                      {testingGitlab ? 'Testing...' : 'Test Connection'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteIntegration(integrations.find((i) => i.provider === 'gitlab')!.id)}
                      className="text-sm text-red-400 hover:text-red-300"
                    >
                      Disconnect
                    </button>
                  </>
                )}
              </div>
            </form>
            )}

            {/* Feature Toggles */}
            {integrations.find((i) => i.provider === 'gitlab') && (
              <div className="space-y-3 border-t border-gray-700 pt-4">
                <p className="text-sm font-medium text-gray-300">Features</p>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={glPostChecks}
                    onChange={(e) => {
                      setGlPostChecks(e.target.checked);
                      const gl = integrations.find((i) => i.provider === 'gitlab');
                      if (gl) {
                        api.updateIntegration(gl.id, {
                          settings: { postChecks: e.target.checked, postComments: glPostComments, checkOnReview: glCheckOnReview },
                        });
                      }
                    }}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="text-sm text-gray-200">Post commit statuses on MRs</span>
                    <p className="text-xs text-gray-500">Shows pass/fail based on AI session review status</p>
                  </div>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={glPostComments}
                    onChange={(e) => {
                      setGlPostComments(e.target.checked);
                      const gl = integrations.find((i) => i.provider === 'gitlab');
                      if (gl) {
                        api.updateIntegration(gl.id, {
                          settings: { postChecks: glPostChecks, postComments: e.target.checked, checkOnReview: glCheckOnReview },
                        });
                      }
                    }}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="text-sm text-gray-200">Post session summary comments</span>
                    <p className="text-xs text-gray-500">Adds an AI governance report comment to each MR</p>
                  </div>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={glCheckOnReview}
                    onChange={(e) => {
                      setGlCheckOnReview(e.target.checked);
                      const gl = integrations.find((i) => i.provider === 'gitlab');
                      if (gl) {
                        api.updateIntegration(gl.id, {
                          settings: { postChecks: glPostChecks, postComments: glPostComments, checkOnReview: e.target.checked },
                        });
                      }
                    }}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="text-sm text-gray-200">Update checks on review</span>
                    <p className="text-xs text-gray-500">Refreshes MR status when sessions are approved/rejected in Origin</p>
                  </div>
                </label>
              </div>
            )}

            {glTestResult && (
              <div
                className={`rounded-lg p-3 text-sm ${
                  glTestResult.success
                    ? 'bg-green-900/20 border border-green-800 text-green-400'
                    : 'bg-red-900/20 border border-red-800 text-red-400'
                }`}
              >
                {glTestResult.success
                  ? `Connected as @${glTestResult.login}`
                  : `Connection failed: ${glTestResult.error}`}
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {/* Slack Integration */}
      {expandedSection === 'slack' && (
      <section className="card space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current">
                <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="#E01E5A"/>
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold">Slack</h2>
              <p className="text-xs text-gray-500">Get notified about policy violations and reviews</p>
            </div>
          </div>
          {integrations.find((i) => i.provider === 'slack') ? (
            <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-green-900/30 text-green-400 border border-green-800/50">Connected</span>
          ) : (
            <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-gray-800 text-gray-500">Not Connected</span>
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
            &rarr; Incoming Webhooks
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
      )}

      {/* Email Reports — always visible (simple toggle, not a full integration) */}
      <section className="card space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center">
              <svg className="w-5 h-5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold">Weekly Email Report</h2>
              <p className="text-xs text-gray-500">Automated weekly summary sent to your team</p>
            </div>
          </div>
          {emailEnabled ? (
            <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-green-900/30 text-green-400 border border-green-800/50">Enabled</span>
          ) : (
            <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-gray-800 text-gray-500">Disabled</span>
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

      {/* AI Chat Configuration */}
      {expandedSection === 'chat' && (
      <section className="card space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center">
              <svg className="w-5 h-5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold">AI Chat</h2>
              <p className="text-xs text-gray-500">Configure the AI assistant for your organization</p>
            </div>
          </div>
          {chatLoading ? (
            <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-gray-800 text-gray-500">Loading...</span>
          ) : chatConfigured ? (
            <span className="text-[10px] font-medium px-2.5 py-1 rounded-full bg-green-900/30 text-green-400 border border-green-800/50">
              {chatSource === 'org' ? 'Org Key' : chatSource === 'environment' ? 'Server Key' : 'Configured'}
            </span>
          ) : (
            <span className="badge-gray text-xs">Not Configured</span>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Provider</label>
            <select
              value={chatProvider}
              onChange={(e) => {
                const p = e.target.value as 'anthropic' | 'openai' | 'google';
                setChatProvider(p);
                // Reset model to default for selected provider
                const defaults: Record<string, string> = {
                  anthropic: 'claude-sonnet-4-20250514',
                  openai: 'gpt-4o',
                  google: 'gemini-2.5-flash',
                };
                setChatModel(defaults[p] || 'claude-sonnet-4-20250514');
                setChatApiKey('');
              }}
              className="select w-full"
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google AI</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              {chatProvider === 'anthropic' ? 'Anthropic' : chatProvider === 'openai' ? 'OpenAI' : 'Google AI'} API Key
            </label>
            <input
              type="password"
              value={chatApiKey}
              onChange={(e) => setChatApiKey(e.target.value)}
              className="input w-full"
              placeholder={chatConfigured ? '••••••••••••••••••' : chatProvider === 'anthropic' ? 'sk-ant-...' : chatProvider === 'openai' ? 'sk-...' : 'AIza...'}
            />
            <p className="text-xs text-gray-500 mt-1">
              {chatSource === 'environment' && 'Server environment key is active. Add an org key to override it.'}
              {chatSource === 'org' && 'Organization key is configured. Enter a new key to update it.'}
              {chatSource === 'none' && 'Required for the in-app AI assistant and AI-powered session reviews.'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Model</label>
            <select value={chatModel} onChange={(e) => setChatModel(e.target.value)} className="select w-full">
              {chatProvider === 'anthropic' && (
                <>
                  <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
                  <option value="claude-opus-4-20250514">Claude Opus 4</option>
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                </>
              )}
              {chatProvider === 'openai' && (
                <>
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="gpt-4o-mini">GPT-4o Mini</option>
                  <option value="gpt-4.1">GPT-4.1</option>
                  <option value="gpt-4.1-mini">GPT-4.1 Mini</option>
                  <option value="gpt-4.1-nano">GPT-4.1 Nano</option>
                  <option value="o3">o3</option>
                  <option value="o3-mini">o3-mini</option>
                  <option value="o4-mini">o4-mini</option>
                </>
              )}
              {chatProvider === 'google' && (
                <>
                  <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                  <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                </>
              )}
            </select>
          </div>

          {chatMsg && (
            <div className={`text-sm px-3 py-2 rounded-lg ${chatMsg.type === 'success' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
              {chatMsg.text}
            </div>
          )}

          {chatTestResult && (
            <div className={`text-sm px-3 py-2 rounded-lg ${chatTestResult.success ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
              {chatTestResult.success ? 'Connection successful' : `Connection failed: ${chatTestResult.error}`}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button onClick={handleSaveChatConfig} disabled={savingChat} className="btn-primary">
              {savingChat ? 'Saving...' : 'Save'}
            </button>
            <button onClick={handleTestChat} disabled={testingChat} className="btn-secondary">
              {testingChat ? 'Testing...' : 'Test Connection'}
            </button>
          </div>
        </div>
      </section>
      )}
    </div>
  );
}
