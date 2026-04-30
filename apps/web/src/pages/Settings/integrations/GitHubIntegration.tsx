import React, { useState, useEffect } from 'react';
import * as api from '../../../api';

export default function GitHubIntegration() {
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
  const [integrations, setIntegrations] = useState<api.IntegrationConfig[]>([]);
  const [loadingIntegrations, setLoadingIntegrations] = useState(false);
  const [webhookEvents, setWebhookEvents] = useState<api.AuditEntry[]>([]);

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

  useEffect(() => {
    fetchIntegrations();
    fetchWebhookEvents();
  }, []);

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

  const handleInstallGitHubApp = async () => {
    setInstallingApp(true);
    setIntegrationError(null);
    try {
      const { installUrl } = await api.getGitHubAppInstallUrl({ from: 'settings' });
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
  );
}
