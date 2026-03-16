import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../api';
import type { BudgetData } from '../api';
import Team from './Team';
import AuditLog from './AuditLog';
import Insights from './Insights';
import Reports from './Reports';
import Trails from './Trails';
import Compliance from './Compliance';
import ModelComparison from './ModelComparison';
import Leaderboard from './Leaderboard';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  userId: string | null;
  role: string | null;
  user: { name: string; email: string } | null;
  repoScopes: { repoId: string; repoName: string }[];
  agentScopes: { agentId: string; agentName: string; agentSlug: string }[];
}

type SettingsTab = 'general' | 'integrations' | 'budget' | 'team' | 'audit' | 'insights' | 'reports' | 'trails' | 'compliance' | 'models' | 'leaderboard';
const VALID_TABS: SettingsTab[] = ['general', 'integrations', 'budget', 'team', 'audit', 'insights', 'reports', 'trails', 'compliance', 'models', 'leaderboard'];

export default function Settings() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Active tab — read from URL ?tab= param, default to 'general'
  const tabParam = searchParams.get('tab') as SettingsTab | null;
  const initialTab: SettingsTab = tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'general';
  const [activeTab, setActiveTabState] = useState<SettingsTab>(initialTab);

  const setActiveTab = (tab: SettingsTab) => {
    setActiveTabState(tab);
    if (tab === 'general') {
      setSearchParams({});
    } else {
      setSearchParams({ tab });
    }
  };

  // API Keys
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyRole, setNewKeyRole] = useState('MEMBER');
  const [newKeyRepoIds, setNewKeyRepoIds] = useState<string[]>([]);
  const [newKeyAgentIds, setNewKeyAgentIds] = useState<string[]>([]);
  const [allRepos, setAllRepos] = useState<{ id: string; name: string }[]>([]);
  const [allAgents, setAllAgents] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Team invite
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviting, setInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [pendingInvites, setPendingInvites] = useState<api.Invitation[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [cancellingInvite, setCancellingInvite] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

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
  const [savingSlack, setSavingSlack] = useState(false);
  const [testingSlack, setTestingSlack] = useState(false);
  const [slackTestResult, setSlackTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // GitHub App
  const [githubAppStatus, setGithubAppStatus] = useState<{
    installed: boolean;
    serverConfigured: boolean;
    installationId?: string;
    appSlug?: string;
  } | null>(null);
  const [installingApp, setInstallingApp] = useState(false);
  const [availableInstallations, setAvailableInstallations] = useState<
    { installationId: string; account: string; accountType: string; avatarUrl: string | null }[]
  >([]);

  // Org settings
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [orgStats, setOrgStats] = useState<{ users: number; repos: number; agents: number; policies: number } | null>(null);
  const [orgCreatedAt, setOrgCreatedAt] = useState('');
  const [orgLoading, setOrgLoading] = useState(false);
  const [savingOrg, setSavingOrg] = useState(false);
  const [orgMsg, setOrgMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Budget state
  const [budgetData, setBudgetData] = useState<BudgetData | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [budgetLimit, setBudgetLimit] = useState('');
  const [budgetBlock, setBudgetBlock] = useState(false);
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetMsg, setBudgetMsg] = useState('');

  const fetchOrg = useCallback(async () => {
    setOrgLoading(true);
    try {
      const data = await api.getOrgSettings();
      setOrgName(data.org.name);
      setOrgSlug(data.org.slug);
      setOrgStats(data.org._count);
      setOrgCreatedAt(data.org.createdAt);
    } catch {
      // ignore
    } finally {
      setOrgLoading(false);
    }
  }, []);

  const handleSaveOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingOrg(true);
    setOrgMsg(null);
    try {
      const data = await api.updateOrgSettings({ name: orgName, slug: orgSlug });
      setOrgName(data.org.name);
      setOrgSlug(data.org.slug);
      setOrgMsg({ type: 'success', text: 'Organization settings saved' });
    } catch (err: any) {
      setOrgMsg({ type: 'error', text: err.message || 'Failed to save' });
    } finally {
      setSavingOrg(false);
    }
  };

  const fetchBudget = useCallback(async () => {
    setBudgetLoading(true);
    try {
      const data = await api.getBudget();
      setBudgetData(data);
      setBudgetLimit(data.config.monthlyLimit > 0 ? String(data.config.monthlyLimit) : '');
      setBudgetBlock(data.config.blockOnExceed);
    } catch {
      // ignore — might not have data yet
    } finally {
      setBudgetLoading(false);
    }
  }, []);

  const fetchInvites = useCallback(async () => {
    if (user?.role !== 'ADMIN' && user?.role !== 'OWNER') return;
    setLoadingInvites(true);
    try {
      const data = await api.getInvites();
      setPendingInvites(data.invites);
    } catch {
      // ignore
    } finally {
      setLoadingInvites(false);
    }
  }, [user?.role]);

  // Fetch API keys and org settings on mount
  useEffect(() => {
    fetchApiKeys();
    fetchOrg();
    fetchInvites();
    api.getRepos().then(repos => setAllRepos(repos.map(r => ({ id: r.id, name: r.name })))).catch(() => {});
    api.getAgents().then(agents => setAllAgents(agents.map(a => ({ id: a.id, name: a.name, slug: a.slug })))).catch(() => {});
  }, [fetchOrg, fetchInvites]);

  // Fetch integrations/budget when tab is active
  // Handle GitHub App callback URL params
  useEffect(() => {
    const githubAppResult = searchParams.get('github_app');
    if (githubAppResult === 'success') {
      setIntegrationSuccess('GitHub App installed successfully!');
      setActiveTabState('integrations');
      // Clean up URL params
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('github_app');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    } else if (githubAppResult === 'error') {
      const msg = searchParams.get('msg') || 'Unknown error';
      setIntegrationError(`GitHub App installation failed: ${msg}`);
      setActiveTabState('integrations');
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('github_app');
      newParams.delete('msg');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    } else if (githubAppResult === 'requested') {
      setIntegrationSuccess('GitHub App installation requested. Your organization owner needs to approve it.');
      setActiveTabState('integrations');
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'integrations') {
      fetchIntegrations();
      fetchWebhookEvents();
    }
    if (activeTab === 'budget') {
      fetchBudget();
    }
  }, [activeTab, fetchBudget]);

  const fetchIntegrations = async () => {
    setLoadingIntegrations(true);
    try {
      const [data, appStatus] = await Promise.all([
        api.getIntegrations(),
        api.getGitHubAppStatus().catch(() => null),
      ]);
      setIntegrations(data);
      if (appStatus) setGithubAppStatus(appStatus);
      // Populate form with existing GitHub integration
      const gh = data.find((i) => i.provider === 'github');
      if (gh) {
        setGhBaseUrl(gh.baseUrl || '');
        setGhPostChecks(gh.settings?.postChecks ?? true);
        setGhPostComments(gh.settings?.postComments ?? true);
        setGhCheckOnReview(gh.settings?.checkOnReview ?? true);
      }
      // Populate Slack integration state
      const slack = data.find((i) => i.provider === 'slack');
      if (slack) {
        setSlackNotifyViolations(slack.settings?.notifyViolations ?? true);
        setSlackNotifyReviews(slack.settings?.notifyReviews ?? true);
        setSlackNotifyBudget(slack.settings?.notifyBudget ?? true);
        setSlackNotifySessionFlags(slack.settings?.notifySessionFlags ?? true);
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

  const handleInstallGitHubApp = async () => {
    setInstallingApp(true);
    setIntegrationError(null);
    try {
      // First, try to auto-detect existing installations
      const detect = await api.detectGitHubApp();
      if (detect.linked) {
        // Already linked — refresh status
        setIntegrationSuccess(`Connected to GitHub account "${detect.account || 'unknown'}"`);
        const [status, intgs] = await Promise.all([
          api.getGitHubAppStatus(),
          api.getIntegrations(),
        ]);
        setGithubAppStatus(status);
        setIntegrations(intgs || []);
        setInstallingApp(false);
        return;
      }
      if (detect.installations && detect.installations.length > 0) {
        // Show picker so admin can choose which GitHub account to link
        setAvailableInstallations(detect.installations);
        setInstallingApp(false);
        return;
      }
      // No existing installation found — redirect to GitHub to install
      const { installUrl } = await api.getGitHubAppInstallUrl();
      window.location.href = installUrl;
    } catch (err: any) {
      setIntegrationError(err.message || 'Failed to start GitHub App installation');
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

  const fetchApiKeys = async () => {
    setLoadingKeys(true);
    setKeyError(null);
    try {
      const keys = await api.getApiKeys();
      setApiKeys(keys);
    } catch (err: any) {
      setKeyError(err.message || 'Failed to load API keys');
    } finally {
      setLoadingKeys(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingKey(true);
    setCreatedKey(null);
    setKeyError(null);
    try {
      const result = await api.createApiKey({
        name: newKeyName || 'Unnamed key',
        role: newKeyRole,
        repoIds: newKeyRepoIds.length > 0 ? newKeyRepoIds : undefined,
        agentIds: newKeyAgentIds.length > 0 ? newKeyAgentIds : undefined,
      });
      setCreatedKey(result.key);
      setNewKeyName('');
      setNewKeyRole('MEMBER');
      setNewKeyRepoIds([]);
      setNewKeyAgentIds([]);
      // Refresh the list to include the new key
      await fetchApiKeys();
    } catch (err: any) {
      setKeyError(err.message || 'Failed to create API key');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleDeleteKey = async (id: string) => {
    setDeletingKeyId(id);
    setKeyError(null);
    try {
      await api.deleteApiKey(id);
      // Refresh the list after deletion
      await fetchApiKeys();
    } catch (err: any) {
      setKeyError(err.message || 'Failed to delete API key');
    } finally {
      setDeletingKeyId(null);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setInviteSuccess('');
    setInviteError('');
    setInviteLink(null);
    try {
      const result = await api.createInvite({
        email: inviteEmail || undefined,
        role: inviteRole.toUpperCase(),
      });
      const link = `${window.location.origin}/accept-invite/${result.token}`;
      setInviteLink(link);
      setInviteSuccess(`Invitation created${inviteEmail ? ` for ${inviteEmail}` : ''}! Share the link below.`);
      setInviteEmail('');
      setInviteRole('member');
      fetchInvites();
    } catch (err: any) {
      setInviteError(err.message || 'Failed to create invitation');
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvite = async (id: string) => {
    setCancellingInvite(id);
    try {
      await api.cancelInvite(id);
      fetchInvites();
    } catch (err: any) {
      setInviteError(err.message || 'Failed to cancel invitation');
    } finally {
      setCancellingInvite(null);
    }
  };

  const handleSaveBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBudget(true);
    setBudgetMsg('');
    try {
      const limit = parseFloat(budgetLimit) || 0;
      await api.updateBudget({ monthlyLimit: limit, blockOnExceed: budgetBlock });
      setBudgetMsg('Budget settings saved');
      await fetchBudget();
    } catch (err: any) {
      setBudgetMsg(`Error: ${err.message}`);
    } finally {
      setSavingBudget(false);
    }
  };

  return (
    <div className={`space-y-8 ${['team', 'audit', 'insights', 'reports'].includes(activeTab) ? '' : 'max-w-3xl'}`}>
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Manage API keys, team, and organization</p>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-gray-800">
        <button
          onClick={() => setActiveTab('general')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'general'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          General
        </button>
        <button
          onClick={() => setActiveTab('integrations')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'integrations'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Integrations
        </button>
        <button
          onClick={() => setActiveTab('budget')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'budget'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Budget
        </button>
        <div className="w-px h-5 bg-gray-800 self-center mx-1" />
        <button
          onClick={() => setActiveTab('team')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'team'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Team
        </button>
        <button
          onClick={() => setActiveTab('audit')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'audit'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Audit Log
        </button>
        <button
          onClick={() => setActiveTab('insights')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'insights'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Insights
        </button>
        <button
          onClick={() => setActiveTab('reports')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'reports'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Reports
        </button>
        <div className="w-px h-5 bg-gray-800 self-center mx-1" />
        <button
          onClick={() => setActiveTab('trails')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'trails'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Trails
        </button>
        <button
          onClick={() => setActiveTab('compliance')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'compliance'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Compliance
        </button>
        <button
          onClick={() => setActiveTab('models')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'models'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          ⚡ Models
        </button>
        <button
          onClick={() => setActiveTab('leaderboard')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'leaderboard'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Leaderboard
        </button>
      </div>

      {activeTab === 'general' && (
        <>
          {/* API Keys Section */}
          <section className="card space-y-4">
            <div>
              <h2 className="text-lg font-semibold">API Keys</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Create API keys for integrating agents with Origin
              </p>
            </div>

            {/* Error message */}
            {keyError && (
              <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-400 text-sm">
                {keyError}
              </div>
            )}

            {/* Loading state */}
            {loadingKeys && (
              <div className="text-sm text-gray-500">Loading API keys...</div>
            )}

            {/* Existing keys */}
            {!loadingKeys && apiKeys.length > 0 && (
              <div className="space-y-2">
                {apiKeys.map((key) => (
                  <div
                    key={key.id}
                    className="flex items-center justify-between bg-gray-800/50 rounded-lg px-4 py-3"
                  >
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-200">{key.name}</span>
                        {key.role && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-900/50 text-indigo-300 uppercase">
                            {key.role}
                          </span>
                        )}
                      </div>
                      <code className="text-xs text-indigo-400">{key.keyPrefix}...</code>
                      <div className="mt-1.5 space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-500 uppercase tracking-wider w-12">Agents</span>
                          <div className="flex flex-wrap gap-1.5">
                            {allAgents.map((a) => {
                              const assigned = key.agentScopes?.some((s) => s.agentId === a.id);
                              return (
                                <label key={a.id} className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded cursor-pointer transition-colors border ${assigned ? 'bg-indigo-900/40 text-indigo-300 border-indigo-700' : 'bg-gray-800/50 text-gray-600 border-gray-700 hover:border-gray-600'}`}>
                                  <input
                                    type="checkbox"
                                    checked={assigned}
                                    onChange={async () => {
                                      const currentIds = (key.agentScopes || []).map((s) => s.agentId);
                                      const newIds = assigned
                                        ? currentIds.filter((id) => id !== a.id)
                                        : [...currentIds, a.id];
                                      try {
                                        await api.updateApiKey(key.id, { agentIds: newIds });
                                        await fetchApiKeys();
                                      } catch (err: any) {
                                        setKeyError(err.message || 'Failed to update key');
                                      }
                                    }}
                                    className="sr-only"
                                  />
                                  {assigned ? '✓ ' : ''}{a.name}
                                </label>
                              );
                            })}
                            {allAgents.length === 0 && (
                              <span className="text-[10px] text-gray-600 italic">No agents configured</span>
                            )}
                            {allAgents.length > 0 && !key.agentScopes?.length && (
                              <span className="text-[10px] text-red-400">No access</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-500 uppercase tracking-wider w-12">Repos</span>
                          <div className="flex flex-wrap gap-1.5">
                            {allRepos.map((r) => {
                              const assigned = key.repoScopes?.some((s) => s.repoId === r.id);
                              return (
                                <label key={r.id} className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded cursor-pointer transition-colors border ${assigned ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700' : 'bg-gray-800/50 text-gray-600 border-gray-700 hover:border-gray-600'}`}>
                                  <input
                                    type="checkbox"
                                    checked={assigned}
                                    onChange={async () => {
                                      const currentIds = (key.repoScopes || []).map((s) => s.repoId);
                                      const newIds = assigned
                                        ? currentIds.filter((id) => id !== r.id)
                                        : [...currentIds, r.id];
                                      try {
                                        await api.updateApiKey(key.id, { repoIds: newIds });
                                        await fetchApiKeys();
                                      } catch (err: any) {
                                        setKeyError(err.message || 'Failed to update key');
                                      }
                                    }}
                                    className="sr-only"
                                  />
                                  {assigned ? '✓ ' : ''}{r.name}
                                </label>
                              );
                            })}
                            {allRepos.length === 0 && (
                              <span className="text-[10px] text-gray-600 italic">No repos added</span>
                            )}
                            {allRepos.length > 0 && !key.repoScopes?.length && (
                              <span className="text-[10px] text-red-400">No access</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {key.user ? (
                        <span className="text-xs text-gray-400">{key.user.name}</span>
                      ) : key.role ? (
                        <span className="text-xs text-gray-500 italic">Standalone</span>
                      ) : null}
                      <span className="text-xs text-gray-500">
                        Created {new Date(key.createdAt).toLocaleDateString()}
                      </span>
                      <button
                        onClick={() => handleDeleteKey(key.id)}
                        disabled={deletingKeyId === key.id}
                        className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {deletingKeyId === key.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Empty state */}
            {!loadingKeys && apiKeys.length === 0 && !keyError && (
              <div className="text-sm text-gray-500">No API keys yet. Create one below.</div>
            )}

            {/* Created key warning */}
            {createdKey && (
              <div className="bg-amber-900/20 border border-amber-800 rounded-lg p-4">
                <p className="text-sm text-amber-400 font-medium mb-1">
                  Copy your API key now. You won&apos;t be able to see it again.
                </p>
                <code className="text-sm text-gray-200 bg-gray-800 px-3 py-1.5 rounded block break-all">
                  {createdKey}
                </code>
              </div>
            )}

            {/* Create new key */}
            <form onSubmit={handleCreateKey} className="space-y-3">
              <div className="flex gap-3">
                <input
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  className="input flex-1"
                  placeholder="Key name (e.g. CI Pipeline, Bob)"
                />
                <select
                  value={newKeyRole}
                  onChange={(e) => setNewKeyRole(e.target.value)}
                  className="input w-32"
                >
                  <option value="VIEWER">Viewer</option>
                  <option value="MEMBER">Member</option>
                  <option value="ADMIN">Admin</option>
                </select>
                <button type="submit" disabled={creatingKey} className="btn-primary text-sm whitespace-nowrap">
                  {creatingKey ? 'Creating...' : 'Create New'}
                </button>
              </div>
              {allAgents.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1.5">Assign to agents (required — key won't work without agents):</p>
                  <div className="flex flex-wrap gap-2">
                    {allAgents.map((a) => (
                      <label key={a.id} className="inline-flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newKeyAgentIds.includes(a.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setNewKeyAgentIds([...newKeyAgentIds, a.id]);
                            } else {
                              setNewKeyAgentIds(newKeyAgentIds.filter((id) => id !== a.id));
                            }
                          }}
                          className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500"
                        />
                        {a.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {allRepos.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1.5">Restrict to repos (optional — empty = all repos):</p>
                  <div className="flex flex-wrap gap-2">
                    {allRepos.map((r) => (
                      <label key={r.id} className="inline-flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newKeyRepoIds.includes(r.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setNewKeyRepoIds([...newKeyRepoIds, r.id]);
                            } else {
                              setNewKeyRepoIds(newKeyRepoIds.filter((id) => id !== r.id));
                            }
                          }}
                          className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500"
                        />
                        {r.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-600">
                Standalone tokens let users access Origin via CLI without a platform account.
              </p>
            </form>
          </section>

          {/* Team Section */}
          <section className="card space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Team</h2>
              <p className="text-sm text-gray-500 mt-0.5">Invite team members to your organization</p>
            </div>

            {inviteError && (
              <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-400 text-sm">
                {inviteError}
              </div>
            )}

            {inviteSuccess && (
              <div className="bg-green-900/20 border border-green-800 rounded-lg p-3 text-green-400 text-sm">
                {inviteSuccess}
              </div>
            )}

            {inviteLink && (
              <div className="bg-indigo-900/20 border border-indigo-800 rounded-lg p-4 space-y-2">
                <p className="text-sm text-indigo-300 font-medium">Share this invite link:</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-gray-200 bg-gray-800 px-3 py-1.5 rounded block break-all flex-1">
                    {inviteLink}
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(inviteLink); }}
                    className="btn-secondary text-xs whitespace-nowrap"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-xs text-gray-500">Link expires in 7 days</p>
              </div>
            )}

            {(user?.role === 'ADMIN' || user?.role === 'OWNER') && (
              <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="input flex-1"
                  placeholder="colleague@company.com (optional)"
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="select text-sm"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button type="submit" disabled={inviting} className="btn-primary text-sm whitespace-nowrap">
                  {inviting ? 'Creating...' : 'Create Invite'}
                </button>
              </form>
            )}

            {/* Pending invitations */}
            {(user?.role === 'ADMIN' || user?.role === 'OWNER') && pendingInvites.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-400">Pending Invitations</h3>
                {pendingInvites.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between bg-gray-800/50 rounded-lg px-4 py-2.5"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm text-gray-200">
                        {inv.email || 'Open invite link'}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">
                          Role: {inv.role}
                        </span>
                        <span className="text-xs text-gray-600">
                          Expires {new Date(inv.expiresAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          const link = `${window.location.origin}/accept-invite/${inv.token}`;
                          navigator.clipboard.writeText(link);
                        }}
                        className="text-xs text-indigo-400 hover:text-indigo-300"
                      >
                        Copy Link
                      </button>
                      <button
                        onClick={() => handleCancelInvite(inv.id)}
                        disabled={cancellingInvite === inv.id}
                        className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                      >
                        {cancellingInvite === inv.id ? 'Cancelling...' : 'Cancel'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Org Section */}
          <section className="card space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Organization</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Manage your organization settings
                {user?.role !== 'OWNER' && user?.role !== 'ADMIN' && (
                  <span className="text-gray-600 ml-1">(read-only for your role)</span>
                )}
              </p>
            </div>

            {orgMsg && (
              <div
                className={`rounded-lg p-3 text-sm ${
                  orgMsg.type === 'success'
                    ? 'bg-green-900/20 border border-green-800 text-green-400'
                    : 'bg-red-900/20 border border-red-800 text-red-400'
                }`}
              >
                {orgMsg.text}
              </div>
            )}

            {orgLoading ? (
              <div className="text-sm text-gray-500">Loading organization...</div>
            ) : (
              <form onSubmit={handleSaveOrg} className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Organization Name</label>
                    {user?.role === 'OWNER' || user?.role === 'ADMIN' ? (
                      <input
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        className="input"
                        placeholder="Your organization"
                        required
                      />
                    ) : (
                      <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
                        {orgName || '\u2014'}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Slug</label>
                    {user?.role === 'OWNER' || user?.role === 'ADMIN' ? (
                      <>
                        <input
                          value={orgSlug}
                          onChange={(e) => setOrgSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                          className="input"
                          placeholder="my-org"
                          required
                          pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                          minLength={2}
                          maxLength={48}
                        />
                        <p className="text-xs text-gray-600 mt-1">
                          Used in URLs. Lowercase letters, numbers, and hyphens only.
                        </p>
                      </>
                    ) : (
                      <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
                        {orgSlug || '\u2014'}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-500 mb-1">Your Role</label>
                    <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
                      {user?.role ?? '\u2014'}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-500 mb-1">Your Email</label>
                    <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm">
                      {user?.email ?? '\u2014'}
                    </div>
                  </div>
                </div>

                {/* Org stats */}
                {orgStats && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                    <div className="bg-gray-800/30 rounded-lg px-3 py-2 text-center">
                      <div className="text-lg font-semibold text-gray-100">{orgStats.users}</div>
                      <div className="text-xs text-gray-500">Members</div>
                    </div>
                    <div className="bg-gray-800/30 rounded-lg px-3 py-2 text-center">
                      <div className="text-lg font-semibold text-gray-100">{orgStats.repos}</div>
                      <div className="text-xs text-gray-500">Repos</div>
                    </div>
                    <div className="bg-gray-800/30 rounded-lg px-3 py-2 text-center">
                      <div className="text-lg font-semibold text-gray-100">{orgStats.agents}</div>
                      <div className="text-xs text-gray-500">Agents</div>
                    </div>
                    <div className="bg-gray-800/30 rounded-lg px-3 py-2 text-center">
                      <div className="text-lg font-semibold text-gray-100">{orgStats.policies}</div>
                      <div className="text-xs text-gray-500">Policies</div>
                    </div>
                  </div>
                )}

                {orgCreatedAt && (
                  <p className="text-xs text-gray-600">
                    Organization created {new Date(orgCreatedAt).toLocaleDateString()}
                  </p>
                )}

                {(user?.role === 'OWNER' || user?.role === 'ADMIN') && (
                  <button
                    type="submit"
                    disabled={savingOrg}
                    className="btn-primary text-sm"
                  >
                    {savingOrg ? 'Saving...' : 'Save Changes'}
                  </button>
                )}
              </form>
            )}
          </section>
        </>
      )}

      {activeTab === 'integrations' && (
        <>
          {/* GitHub Integration */}
          <section className="card space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center text-xl">
                  <svg viewBox="0 0 24 24" className="w-6 h-6 fill-gray-200">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold">GitHub</h2>
                  <p className="text-sm text-gray-500">Post status checks and comments on pull requests</p>
                </div>
              </div>
              {(() => {
                const gh = integrations.find((i) => i.provider === 'github');
                if (!gh) return <span className="badge-gray text-xs">Not Connected</span>;
                if (gh.authType === 'github_app') return <span className="badge-green text-xs">GitHub App</span>;
                return <span className="badge-green text-xs">Connected (PAT)</span>;
              })()}
            </div>

            {integrationError && (
              <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-red-400 text-sm">
                {integrationError}
              </div>
            )}
            {integrationSuccess && (
              <div className="bg-green-900/20 border border-green-800 rounded-lg p-3 text-green-400 text-sm">
                {integrationSuccess}
              </div>
            )}

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
                          {availableInstallations.length > 0 ? (
                            <>
                              <p className="text-sm text-gray-400">Select a GitHub account to connect:</p>
                              <div className="space-y-2">
                                {availableInstallations.map((inst) => (
                                  <button
                                    key={inst.installationId}
                                    type="button"
                                    onClick={async () => {
                                      setInstallingApp(true);
                                      try {
                                        const result = await api.detectGitHubApp(inst.installationId);
                                        if (result.linked) {
                                          setIntegrationSuccess(`Connected to GitHub account "${result.account || inst.account}"`);
                                          const [status, intgs] = await Promise.all([
                                            api.getGitHubAppStatus(),
                                            api.getIntegrations(),
                                          ]);
                                          setGithubAppStatus(status);
                                          setIntegrations(intgs || []);
                                          setAvailableInstallations([]);
                                        }
                                      } catch (err: any) {
                                        setIntegrationError(err.message);
                                      } finally {
                                        setInstallingApp(false);
                                      }
                                    }}
                                    disabled={installingApp}
                                    className="flex items-center gap-3 w-full p-3 rounded-lg border border-gray-700 hover:border-indigo-500/50 hover:bg-gray-800/50 transition-all text-left"
                                  >
                                    {inst.avatarUrl && (
                                      <img src={inst.avatarUrl} alt="" className="w-8 h-8 rounded-full" />
                                    )}
                                    <div>
                                      <span className="text-sm font-medium text-gray-200">{inst.account}</span>
                                      <span className="text-xs text-gray-500 ml-2">{inst.accountType}</span>
                                    </div>
                                  </button>
                                ))}
                              </div>
                              <button
                                type="button"
                                onClick={async () => {
                                  setAvailableInstallations([]);
                                  const { installUrl } = await api.getGitHubAppInstallUrl();
                                  window.location.href = installUrl;
                                }}
                                className="text-sm text-indigo-400 hover:text-indigo-300"
                              >
                                + Install on a different GitHub account
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={handleInstallGitHubApp}
                              disabled={installingApp}
                              className="btn-primary text-sm"
                            >
                              {installingApp ? 'Checking...' : 'Install GitHub App'}
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

          {/* Slack Integration */}
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

          {/* GitLab — coming soon */}
          <section className="card opacity-60">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" className="w-6 h-6 fill-orange-400">
                    <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold">GitLab</h2>
                  <p className="text-sm text-gray-500">Merge request integration</p>
                </div>
              </div>
              <span className="badge-amber text-xs">Coming Soon</span>
            </div>
          </section>

          {/* Branch Protection Setup */}
          {integrations.find((i) => i.provider === 'github') && (
            <section className="card space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Branch Protection</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  Block merges to protected branches when AI sessions have policy violations
                </p>
              </div>

              <div className="bg-gray-800/50 rounded-lg p-4 space-y-4">
                <div className="flex items-start gap-3">
                  <span className="text-xl mt-0.5">🛡️</span>
                  <div className="space-y-3 text-sm text-gray-300">
                    <p>
                      Origin posts a <code className="bg-gray-700 px-1.5 py-0.5 rounded text-xs text-indigo-300">origin/ai-governance</code> status
                      check on every PR. Configure GitHub to require this check before merging:
                    </p>

                    <ol className="list-decimal list-inside space-y-2 text-gray-400">
                      <li>Go to your GitHub repository → <strong className="text-gray-300">Settings</strong> → <strong className="text-gray-300">Branches</strong></li>
                      <li>Click <strong className="text-gray-300">Add branch protection rule</strong> (or edit existing)</li>
                      <li>Set <strong className="text-gray-300">Branch name pattern</strong> to <code className="bg-gray-700 px-1 rounded text-xs">main</code> (or your default branch)</li>
                      <li>Enable <strong className="text-gray-300">"Require status checks to pass before merging"</strong></li>
                      <li>Search for <code className="bg-gray-700 px-1 rounded text-xs text-indigo-300">origin/ai-governance</code> and select it</li>
                      <li>Click <strong className="text-gray-300">Create</strong> (or <strong className="text-gray-300">Save changes</strong>)</li>
                    </ol>

                    <div className="bg-indigo-900/20 border border-indigo-800/30 rounded-lg p-3 text-xs text-indigo-300">
                      <strong>Result:</strong> PRs with flagged or rejected AI sessions will show a failing check and
                      cannot be merged until an admin approves the session in Origin.
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <a
                  href="/pull-requests"
                  className="text-sm text-indigo-400 hover:text-indigo-300"
                >
                  View PR Checks Dashboard →
                </a>
              </div>
            </section>
          )}

          {/* Webhook Activity */}
          {webhookEvents.length > 0 && (
            <section className="card space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Recent Webhook Activity</h2>
                <p className="text-sm text-gray-500 mt-0.5">Last 10 webhook events received</p>
              </div>
              <div className="space-y-2">
                {webhookEvents.map((evt) => {
                  let meta: Record<string, any> = {};
                  try { meta = JSON.parse(evt.metadata); } catch { /* ignore */ }
                  const isPR = evt.action === 'WEBHOOK_PR_RECEIVED';
                  return (
                    <div key={evt.id} className="flex items-center justify-between bg-gray-800/50 rounded-lg px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${isPR ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>
                          {isPR ? 'pull_request' : 'push'}
                        </span>
                        <span className="text-sm text-gray-300">
                          {meta.repository || '—'}
                          {isPR && meta.prNumber ? ` #${meta.prNumber}` : ''}
                          {!isPR && meta.commitsCreated ? ` (${meta.commitsCreated} commits)` : ''}
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">
                        {new Date(evt.createdAt).toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}

      {activeTab === 'budget' && (
        <>
          {/* Budget Overview */}
          <section className="card space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Cost Controls & Budget</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Set monthly spending limits and get alerts when approaching budget
              </p>
            </div>

            {budgetLoading ? (
              <p className="text-sm text-gray-500">Loading budget data...</p>
            ) : (
              <>
                {/* Current Spend Summary */}
                {budgetData && (
                  <div className="space-y-4">
                    {/* Budget Bar */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-400">Monthly Spend</span>
                        <span className="text-gray-200 font-medium">
                          ${budgetData.currentSpend.monthly.toFixed(2)}
                          {budgetData.config.monthlyLimit > 0 && (
                            <span className="text-gray-500"> / ${budgetData.config.monthlyLimit.toFixed(2)}</span>
                          )}
                        </span>
                      </div>
                      {budgetData.config.monthlyLimit > 0 && (
                        <div className="w-full bg-gray-800 rounded-full h-3">
                          <div
                            className={`h-3 rounded-full transition-all ${
                              budgetData.currentSpend.percentage >= 100
                                ? 'bg-red-500'
                                : budgetData.currentSpend.percentage >= 80
                                  ? 'bg-amber-500'
                                  : 'bg-green-500'
                            }`}
                            style={{ width: `${Math.min(budgetData.currentSpend.percentage, 100)}%` }}
                          />
                        </div>
                      )}
                    </div>

                    {/* Spend by Model */}
                    {budgetData.currentSpend.byModel.length > 0 && (
                      <div>
                        <h3 className="text-sm font-medium text-gray-400 mb-2">By Model (This Month)</h3>
                        <div className="space-y-1.5">
                          {budgetData.currentSpend.byModel
                            .sort((a, b) => b.cost - a.cost)
                            .map((m) => (
                              <div key={m.model} className="flex items-center justify-between bg-gray-800/50 rounded px-3 py-2 text-sm">
                                <div className="flex items-center gap-2">
                                  <span className="badge-blue text-xs">{m.model}</span>
                                  <span className="text-gray-500">{m.sessions} sessions</span>
                                </div>
                                <span className="text-gray-200 font-medium">${m.cost.toFixed(2)}</span>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}

                    {/* Spend by User */}
                    {budgetData.currentSpend.byUser.length > 0 && (
                      <div>
                        <h3 className="text-sm font-medium text-gray-400 mb-2">By User (This Month)</h3>
                        <div className="space-y-1.5">
                          {budgetData.currentSpend.byUser
                            .sort((a, b) => b.cost - a.cost)
                            .map((u) => (
                              <div key={u.userId} className="flex items-center justify-between bg-gray-800/50 rounded px-3 py-2 text-sm">
                                <div className="flex items-center gap-2">
                                  <span className="text-gray-200">{u.name}</span>
                                  <span className="text-gray-500">{u.sessions} sessions</span>
                                </div>
                                <span className="text-gray-200 font-medium">${u.cost.toFixed(2)}</span>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}

                    {/* Daily Spend Chart (simple bar) */}
                    {budgetData.currentSpend.dailySpend.length > 0 && (
                      <div>
                        <h3 className="text-sm font-medium text-gray-400 mb-2">Daily Spend (Last 30 Days)</h3>
                        <div className="flex items-end gap-0.5 h-24">
                          {(() => {
                            const maxCost = Math.max(...budgetData.currentSpend.dailySpend.map(d => d.cost), 0.01);
                            return budgetData.currentSpend.dailySpend.slice(-30).map((d) => (
                              <div
                                key={d.date}
                                className="flex-1 bg-indigo-500/60 rounded-t hover:bg-indigo-400/60 transition-colors group relative"
                                style={{ height: `${(d.cost / maxCost) * 100}%`, minHeight: d.cost > 0 ? '2px' : '0' }}
                                title={`${d.date}: $${d.cost.toFixed(2)}`}
                              >
                                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-xs text-gray-200 px-2 py-1 rounded hidden group-hover:block whitespace-nowrap z-10">
                                  {d.date.slice(5)}: ${d.cost.toFixed(2)}
                                </div>
                              </div>
                            ));
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Budget Settings Form */}
                <form onSubmit={handleSaveBudget} className="space-y-4 pt-4 border-t border-gray-800">
                  <h3 className="text-sm font-medium text-gray-300">Budget Settings</h3>

                  {budgetMsg && (
                    <div className={`text-sm rounded-lg p-3 ${budgetMsg.startsWith('Error') ? 'bg-red-900/20 border border-red-800 text-red-400' : 'bg-green-900/20 border border-green-800 text-green-400'}`}>
                      {budgetMsg}
                    </div>
                  )}

                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Monthly Budget Limit (USD)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={budgetLimit}
                      onChange={(e) => setBudgetLimit(e.target.value)}
                      className="input"
                      placeholder="0 = unlimited"
                    />
                    <p className="text-xs text-gray-600 mt-1">Set to 0 to disable budget limits</p>
                  </div>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={budgetBlock}
                      onChange={(e) => setBudgetBlock(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div>
                      <span className="text-sm text-gray-200">Block new sessions when over budget</span>
                      <p className="text-xs text-gray-500">Prevents agents from starting new sessions if monthly limit is exceeded</p>
                    </div>
                  </label>

                  <div className="text-xs text-gray-500 bg-gray-800/50 rounded-lg p-3 space-y-1">
                    <p className="font-medium text-gray-400">Alert thresholds</p>
                    <p>Notifications are sent to admins when spending reaches 50%, 80%, 90%, and 100% of the budget limit.</p>
                  </div>

                  <button
                    type="submit"
                    disabled={savingBudget}
                    className="btn-primary text-sm"
                  >
                    {savingBudget ? 'Saving...' : 'Save Budget Settings'}
                  </button>
                </form>
              </>
            )}
          </section>
        </>
      )}

      {/* Agent Setup tab removed — content moved to Docs */}


      {activeTab === 'team' && <Team />}
      {activeTab === 'audit' && <AuditLog />}
      {activeTab === 'insights' && <Insights />}
      {activeTab === 'reports' && <Reports />}
      {activeTab === 'trails' && <Trails />}
      {activeTab === 'compliance' && <Compliance />}
      {activeTab === 'models' && <ModelComparison />}
      {activeTab === 'leaderboard' && <Leaderboard />}
    </div>
  );
}
