import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import GitHubIntegration from './integrations/GitHubIntegration';
import GitLabIntegration from './integrations/GitLabIntegration';
import SlackIntegration from './integrations/SlackIntegration';
import WeeklyEmailReport from './integrations/WeeklyEmailReport';
import AIChatIntegration from './integrations/AIChatIntegration';

export default function IntegrationsTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [callbackMessage, setCallbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Handle GitHub App / GitLab OAuth callback URL params
  useEffect(() => {
    const githubAppResult = searchParams.get('github_app');
    if (githubAppResult === 'success') {
      setCallbackMessage({ type: 'success', text: 'GitHub App installed successfully!' });
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('github_app');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    } else if (githubAppResult === 'error') {
      const msg = searchParams.get('msg') || 'Unknown error';
      setCallbackMessage({ type: 'error', text: `GitHub App installation failed: ${msg}` });
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('github_app');
      newParams.delete('msg');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    } else if (githubAppResult === 'requested') {
      setCallbackMessage({ type: 'success', text: 'GitHub App installation requested. Your organization owner needs to approve it.' });
    }

    const gitlabOAuthResult = searchParams.get('gitlab_oauth');
    if (gitlabOAuthResult === 'success') {
      setCallbackMessage({ type: 'success', text: 'GitLab connected via OAuth successfully!' });
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('gitlab_oauth');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    } else if (gitlabOAuthResult === 'error') {
      const msg = searchParams.get('msg') || 'Unknown error';
      setCallbackMessage({ type: 'error', text: `GitLab OAuth failed: ${msg}` });
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('gitlab_oauth');
      newParams.delete('msg');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    }
  }, []);

  return (
    <>
      {callbackMessage && (
        <div
          className={`rounded-lg p-3 text-sm ${
            callbackMessage.type === 'success'
              ? 'bg-green-900/20 border border-green-800 text-green-400'
              : 'bg-red-900/20 border border-red-800 text-red-400'
          }`}
        >
          {callbackMessage.text}
        </div>
      )}
      <GitHubIntegration />
      <GitLabIntegration />
      <SlackIntegration />
      <WeeklyEmailReport />
      <AIChatIntegration />
    </>
  );
}
