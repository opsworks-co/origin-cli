import React, { useState, useEffect } from 'react';
import * as api from '../../../api';

export default function GitLabIntegration() {
  const [integrations, setIntegrations] = useState<api.IntegrationConfig[]>([]);
  const [loadingIntegrations, setLoadingIntegrations] = useState(false);
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [integrationSuccess, setIntegrationSuccess] = useState<string | null>(null);

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

  const fetchIntegrations = async () => {
    setLoadingIntegrations(true);
    try {
      const [data, glOAuthStatus, glOAuthConfig] = await Promise.all([
        api.getIntegrations(),
        api.getGitLabOAuthStatus().catch(() => null),
        api.getGitLabOAuthConfig().catch(() => null),
      ]);
      setIntegrations(data);
      if (glOAuthStatus) setGitlabOAuthStatus(glOAuthStatus);
      if (glOAuthConfig) {
        setGlOAuthConfigSource(glOAuthConfig.source);
        if (glOAuthConfig.clientId) setGlOAuthAppId(glOAuthConfig.clientId);
        if (glOAuthConfig.redirectUri) setGlOAuthRedirectUri(glOAuthConfig.redirectUri);
      }
      // Populate GitLab integration state
      const gl = data.find((i) => i.provider === 'gitlab');
      if (gl) {
        setGlBaseUrl(gl.baseUrl || '');
        setGlPostChecks(gl.settings?.postChecks ?? true);
        setGlPostComments(gl.settings?.postComments ?? true);
        setGlCheckOnReview(gl.settings?.checkOnReview ?? true);
      }
    } catch (err: any) {
      setIntegrationError(err.message);
    } finally {
      setLoadingIntegrations(false);
    }
  };

  useEffect(() => {
    fetchIntegrations();
  }, []);

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
  );
}
