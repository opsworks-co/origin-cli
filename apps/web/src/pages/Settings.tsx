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

type SettingsTab = 'general' | 'keys' | 'integrations' | 'audit' | 'reports' | 'trails' | 'compliance' | 'models';
const ORG_TABS: SettingsTab[] = ['general', 'integrations', 'audit', 'reports', 'trails', 'compliance', 'models'];
const DEV_TABS: SettingsTab[] = ['general', 'models'];

function ProfileEditor() {
  const { user, updateUser } = useAuth();
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
      updateUser(updated);
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
            {user?.accountType === 'developer' ? 'Solo' : user?.role}
          </span>
        </div>

        {/* Form fields */}
        <div className="flex-1 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
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

function PasswordChanger() {
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

export default function Settings() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Active tab — read from URL ?tab= param, default to 'general'
  const isDev = user?.accountType === 'developer';
  const VALID_TABS = isDev ? DEV_TABS : ORG_TABS;
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
  const [forecastData, setForecastData] = useState<api.ForecastData | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);

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
    // Also fetch forecast
    setForecastLoading(true);
    try {
      const forecast = await api.getForecast();
      setForecastData(forecast);
    } catch {
      // ignore
    } finally {
      setForecastLoading(false);
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
  // Handle GitHub App / GitLab OAuth callback URL params
  useEffect(() => {
    const githubAppResult = searchParams.get('github_app');
    if (githubAppResult === 'success') {
      setIntegrationSuccess('GitHub App installed successfully!');
      setActiveTabState('integrations');
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

    const gitlabOAuthResult = searchParams.get('gitlab_oauth');
    if (gitlabOAuthResult === 'success') {
      setIntegrationSuccess('GitLab connected via OAuth successfully!');
      setActiveTabState('integrations');
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('gitlab_oauth');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    } else if (gitlabOAuthResult === 'error') {
      const msg = searchParams.get('msg') || 'Unknown error';
      setIntegrationError(`GitLab OAuth failed: ${msg}`);
      setActiveTabState('integrations');
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('gitlab_oauth');
      newParams.delete('msg');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'integrations') {
      fetchIntegrations();
      fetchWebhookEvents();
      fetchChatConfig();
      fetchEmailSettings();
    }
    if ((activeTab as string) === 'budget') {
      fetchBudget();
    }
  }, [activeTab, fetchBudget]);

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

  // ---- Email Report Handlers ----
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
        <p className="text-sm text-gray-500 mt-1">
          {isDev ? 'Manage your profile and settings' : 'Manage team, integrations, and organization'}
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-gray-800">
        <button
          onClick={() => setActiveTab('general')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'general'
              ? (isDev ? 'border-emerald-500 text-emerald-400' : 'border-indigo-500 text-indigo-400')
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          General
        </button>
        {/* API Keys moved to standalone /api-keys page */}
        {!isDev && (user?.role === 'ADMIN' || user?.role === 'OWNER') && (
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
        )}
        {!isDev && (
        <>
        <div className="w-px h-5 bg-gray-800 self-center mx-1" />
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
        </>
        )}
        <button
          onClick={() => setActiveTab('models')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'models'
              ? (isDev ? 'border-emerald-500 text-emerald-400' : 'border-indigo-500 text-indigo-400')
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          ⚡ Models
        </button>
      </div>

      {activeTab === 'general' && (
        <>
          {/* Profile section — both solo and team */}
          <section className="card space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Profile</h2>
              <p className="text-sm text-gray-500 mt-0.5">Manage your account details</p>
            </div>
            <ProfileEditor />
          </section>

          {/* Change Password — only for email/password accounts */}
          {user && !user.provider && (
          <section className="card space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Change Password</h2>
              <p className="text-sm text-gray-500 mt-0.5">Update your account password</p>
            </div>
            <PasswordChanger />
          </section>
          )}

          {/* Connected Accounts */}
          {user?.provider && (
          <section className="card space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Connected Account</h2>
              <p className="text-sm text-gray-500 mt-0.5">Your account is linked to an external provider</p>
            </div>
            <div className="flex items-center gap-3 bg-gray-800/50 rounded-lg px-4 py-3">
              <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
                {user.provider === 'github' && (
                  <svg viewBox="0 0 24 24" className="w-4 h-4 fill-gray-300"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
                )}
                {user.provider === 'gitlab' && (
                  <svg viewBox="0 0 24 24" className="w-4 h-4 fill-orange-400"><path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z" /></svg>
                )}
              </div>
              <div>
                <span className="text-sm text-gray-200 capitalize">{user.provider}</span>
                <span className="text-xs text-gray-500 block">Signed in via OAuth</span>
              </div>
            </div>
          </section>
          )}

          {/* Danger Zone */}
          <section className="card space-y-4 border-red-900/30">
            <div>
              <h2 className="text-lg font-semibold text-red-400">Danger Zone</h2>
              <p className="text-sm text-gray-500 mt-0.5">Irreversible actions for your account</p>
            </div>
            <div className="flex items-center justify-between bg-red-900/10 border border-red-900/30 rounded-lg px-4 py-3">
              <div>
                <p className="text-sm text-gray-200">Delete Account</p>
                <p className="text-xs text-gray-500">Permanently delete your account and all associated data</p>
              </div>
              <button
                className="text-xs font-medium text-red-400 hover:text-red-300 border border-red-800 hover:border-red-700 px-3 py-1.5 rounded-lg transition-colors"
                onClick={() => {
                  if (window.confirm('Are you sure? This will permanently delete your account, all sessions, and all data. This cannot be undone.')) {
                    alert('Please contact support@getorigin.io to delete your account.');
                  }
                }}
              >
                Delete Account
              </button>
            </div>
          </section>

          {/* REMOVED: old API Keys inline section — now in /api-keys */}
          {false && (
          <section className="card space-y-4 hidden">
            <div>
              <h2 className="text-lg font-semibold">API Keys (legacy)</h2>
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
          )}

          {/* Team Section - moved to /iam */}
          {false && (
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
                    onClick={() => { navigator.clipboard.writeText(inviteLink!); }}
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
          )}

          {/* Org Section — hidden for developer accounts */}
          {!isDev && (
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
          )}
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

          {/* GitLab Integration */}
          <section className="card space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" className="w-6 h-6 fill-orange-400">
                    <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold">GitLab</h2>
                  <p className="text-sm text-gray-500">Post commit statuses and comments on merge requests</p>
                </div>
              </div>
              {gitlabOAuthStatus?.connected ? (
                <span className="badge-green text-xs">Connected (OAuth)</span>
              ) : integrations.find((i) => i.provider === 'gitlab') ? (
                <span className="badge-green text-xs">Connected (PAT)</span>
              ) : (
                <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">Not Connected</span>
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
                        Register a GitLab OAuth Application at <strong className="text-gray-400">GitLab → Preferences → Applications</strong>, then enter the credentials below.
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

          {/* Email Reports */}
          <section className="card space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center text-xl">📧</div>
                <div>
                  <h2 className="text-lg font-semibold">Weekly Email Report</h2>
                  <p className="text-sm text-gray-500">Automated weekly summary sent to your team</p>
                </div>
              </div>
              <span className={`badge ${emailEnabled ? 'badge-green' : 'badge-gray'}`}>{emailEnabled ? 'Enabled' : 'Disabled'}</span>
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
          <section className="card space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center text-xl">
                  <svg viewBox="0 0 24 24" className="w-6 h-6 fill-gray-200">
                    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold">AI Chat</h2>
                  <p className="text-sm text-gray-500">Configure the AI assistant for your organization</p>
                </div>
              </div>
              {chatLoading ? (
                <span className="badge-gray text-xs">Loading...</span>
              ) : chatConfigured ? (
                <span className="badge-green text-xs">
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
        </>
      )}

      {false && (activeTab as string) === 'budget' && (
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
                          ${budgetData!.currentSpend.monthly.toFixed(2)}
                          {budgetData!.config.monthlyLimit > 0 && (
                            <span className="text-gray-500"> / ${budgetData!.config.monthlyLimit.toFixed(2)}</span>
                          )}
                        </span>
                      </div>
                      {budgetData!.config.monthlyLimit > 0 && (
                        <div className="w-full bg-gray-800 rounded-full h-3">
                          <div
                            className={`h-3 rounded-full transition-all ${
                              budgetData!.currentSpend.percentage >= 100
                                ? 'bg-red-500'
                                : budgetData!.currentSpend.percentage >= 80
                                  ? 'bg-amber-500'
                                  : 'bg-green-500'
                            }`}
                            style={{ width: `${Math.min(budgetData!.currentSpend.percentage, 100)}%` }}
                          />
                        </div>
                      )}
                    </div>

                    {/* Spend by Model */}
                    {budgetData!.currentSpend.byModel.length > 0 && (
                      <div>
                        <h3 className="text-sm font-medium text-gray-400 mb-2">By Model (This Month)</h3>
                        <div className="space-y-1.5">
                          {budgetData!.currentSpend.byModel
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
                    {budgetData!.currentSpend.byUser.length > 0 && (
                      <div>
                        <h3 className="text-sm font-medium text-gray-400 mb-2">By User (This Month)</h3>
                        <div className="space-y-1.5">
                          {budgetData!.currentSpend.byUser
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
                    {budgetData!.currentSpend.dailySpend.length > 0 && (
                      <div>
                        <h3 className="text-sm font-medium text-gray-400 mb-2">Daily Spend (Last 30 Days)</h3>
                        <div className="flex items-end gap-0.5 h-24">
                          {(() => {
                            const maxCost = Math.max(...budgetData!.currentSpend.dailySpend.map(d => d.cost), 0.01);
                            return budgetData!.currentSpend.dailySpend.slice(-30).map((d) => (
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

                {/* Cost Forecast */}
                {forecastData && (
                  <div className="space-y-4 pt-4 border-t border-gray-800">
                    <h3 className="text-sm font-medium text-gray-300">Cost Forecast</h3>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="card p-3">
                        <div className="text-xs text-gray-500">Projected Monthly</div>
                        <div className="text-xl font-bold text-gray-100">${forecastData!.projectedMonthly.toFixed(2)}</div>
                      </div>
                      <div className="card p-3">
                        <div className="text-xs text-gray-500">Trend</div>
                        <div className={`text-xl font-bold ${forecastData!.trend === 'up' ? 'text-red-400' : forecastData!.trend === 'down' ? 'text-green-400' : 'text-gray-400'}`}>
                          {forecastData!.trend === 'up' ? '📈 Up' : forecastData!.trend === 'down' ? '📉 Down' : '→ Flat'}
                        </div>
                      </div>
                      <div className="card p-3">
                        <div className="text-xs text-gray-500">Confidence</div>
                        <div className="text-xl font-bold text-gray-100">{Math.round(forecastData!.confidence * 100)}%</div>
                      </div>
                    </div>

                    {/* Actual + Projected daily chart */}
                    {forecastData!.daily.length > 0 && (
                      <div>
                        <h4 className="text-xs text-gray-500 mb-2">Daily Spend: Actual + Projected (14 days)</h4>
                        <div className="flex items-end gap-0.5 h-24">
                          {(() => {
                            const allValues = forecastData!.daily.map(d => d.actual ?? d.projected ?? 0);
                            const maxVal = Math.max(...allValues, 0.01);
                            return forecastData!.daily.map((d) => {
                              const val = d.actual ?? d.projected ?? 0;
                              const isProjected = d.actual === null;
                              return (
                                <div
                                  key={d.date}
                                  className={`flex-1 rounded-t transition-colors group relative ${isProjected ? 'bg-indigo-500/30 border border-dashed border-indigo-500/50' : 'bg-indigo-500/60 hover:bg-indigo-400/60'}`}
                                  style={{ height: `${(val / maxVal) * 100}%`, minHeight: val > 0 ? '2px' : '0' }}
                                  title={`${d.date}: $${val.toFixed(2)}${isProjected ? ' (projected)' : ''}`}
                                >
                                  <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-xs text-gray-200 px-2 py-1 rounded hidden group-hover:block whitespace-nowrap z-10">
                                    {d.date.slice(5)}: ${val.toFixed(2)}{isProjected ? ' ⟶' : ''}
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                        <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                          <span>30 days ago</span>
                          <span>today</span>
                          <span>+14 days</span>
                        </div>
                      </div>
                    )}

                    {/* Per-model forecast */}
                    {forecastData!.byModel.length > 0 && (
                      <div>
                        <h4 className="text-xs text-gray-500 mb-2">By Model</h4>
                        <div className="space-y-2">
                          {forecastData!.byModel.map((m) => (
                            <div key={m.model} className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">{m.model}</span>
                              <div className="text-gray-400">
                                <span className="text-gray-500">${m.currentMonthly.toFixed(2)} →</span>{' '}
                                <span className="text-gray-200 font-medium">${m.projectedMonthly.toFixed(2)}/mo</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {forecastLoading && (
                  <div className="text-sm text-gray-500 py-2">Loading forecast...</div>
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


      {/* Team moved to /iam, Budget moved to /budget */}
      {activeTab === 'audit' && <AuditLog />}
      {/* Insights moved to /insights */}
      {activeTab === 'reports' && <Reports />}
      {activeTab === 'trails' && <Trails />}
      {activeTab === 'compliance' && <Compliance />}
      {/* API Keys moved to standalone /api-keys page */}
      {activeTab === 'models' && <ModelComparison />}
      {/* Leaderboard moved to /leaderboard */}
    </div>
  );
}
