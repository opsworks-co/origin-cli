import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '../../api';
import GitHubIntegration from './integrations/GitHubIntegration';
import GitLabIntegration from './integrations/GitLabIntegration';
import SlackIntegration from './integrations/SlackIntegration';
import WeeklyEmailReport from './integrations/WeeklyEmailReport';
import AIChatIntegration from './integrations/AIChatIntegration';

// Integrations Settings tab — card-grid landing page that mirrors the
// standalone /integrations page. Each summary card shows status at a
// glance; clicking expands the full configuration form for that one
// integration. Single-expand behaviour keeps the page from turning
// into a wall of forms (the regression the user flagged when this was
// just <X /><Y /><Z />).

type Section = 'github' | 'gitlab' | 'slack' | 'email' | 'chat';

export default function IntegrationsTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [callbackMessage, setCallbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [integrations, setIntegrations] = useState<api.IntegrationConfig[]>([]);
  const [chatConfigured, setChatConfigured] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [gitlabOAuthConnected, setGitlabOAuthConnected] = useState(false);
  const [expanded, setExpanded] = useState<Section | null>(null);

  const toggle = (s: Section) => setExpanded((prev) => (prev === s ? null : s));

  const refresh = async () => {
    try {
      const data = await api.getIntegrations();
      setIntegrations(data);
    } catch { /* ignore */ }
    try {
      const res = await fetch('/api/settings/chat', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setChatConfigured(!!(data.configured || data.hasKey));
      }
    } catch { /* ignore */ }
    try {
      const res = await fetch('/api/settings/email', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setEmailEnabled(!!data?.enabled);
      }
    } catch { /* ignore */ }
    try {
      const res = await fetch('/api/integrations/gitlab/oauth/status', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setGitlabOAuthConnected(!!data?.connected);
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    refresh();
  }, []);

  // Handle GitHub App / GitLab OAuth callback URL params
  useEffect(() => {
    const githubAppResult = searchParams.get('github_app');
    if (githubAppResult === 'success') {
      setCallbackMessage({ type: 'success', text: 'GitHub App installed successfully!' });
      setExpanded('github');
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('github_app');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
      refresh();
    } else if (githubAppResult === 'error') {
      const msg = searchParams.get('msg') || 'Unknown error';
      setCallbackMessage({ type: 'error', text: `GitHub App installation failed: ${msg}` });
      setExpanded('github');
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('github_app');
      newParams.delete('msg');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    } else if (githubAppResult === 'requested') {
      setCallbackMessage({ type: 'success', text: 'GitHub App installation requested. Your organization owner needs to approve it.' });
      setExpanded('github');
    }

    const gitlabOAuthResult = searchParams.get('gitlab_oauth');
    if (gitlabOAuthResult === 'success') {
      setCallbackMessage({ type: 'success', text: 'GitLab connected via OAuth successfully!' });
      setExpanded('gitlab');
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('gitlab_oauth');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
      refresh();
    } else if (gitlabOAuthResult === 'error') {
      const msg = searchParams.get('msg') || 'Unknown error';
      setCallbackMessage({ type: 'error', text: `GitLab OAuth failed: ${msg}` });
      setExpanded('gitlab');
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('gitlab_oauth');
      newParams.delete('msg');
      newParams.set('tab', 'integrations');
      setSearchParams(newParams);
    }
  }, []);

  const gh = integrations.find((i) => i.provider === 'github');
  const gl = integrations.find((i) => i.provider === 'gitlab');
  const slack = integrations.find((i) => i.provider === 'slack');
  const githubConnected = !!gh;
  const githubIsApp = (gh as any)?.authType === 'github_app';
  const gitlabConnected = !!gl || gitlabOAuthConnected;
  const slackConnected = !!slack;

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

      {/* Summary card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SummaryCard
          name="GitHub"
          tagline="PR status checks and comments"
          connected={githubConnected}
          statusLabel={githubConnected ? (githubIsApp ? 'App' : 'PAT') : 'Not connected'}
          expanded={expanded === 'github'}
          iconBg={githubConnected ? 'bg-green-900/30' : 'bg-gray-800'}
          icon={
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-gray-200"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
          }
          onClick={() => toggle('github')}
        />
        <SummaryCard
          name="GitLab"
          tagline="MR statuses and comments"
          connected={gitlabConnected}
          statusLabel={gitlabConnected ? 'Connected' : 'Not connected'}
          expanded={expanded === 'gitlab'}
          iconBg={gitlabConnected ? 'bg-green-900/30' : 'bg-gray-800'}
          icon={
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-orange-400"><path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z" /></svg>
          }
          onClick={() => toggle('gitlab')}
        />
        <SummaryCard
          name="Slack"
          tagline="Notifications and alerts"
          connected={slackConnected}
          statusLabel={slackConnected ? 'Connected' : 'Not connected'}
          expanded={expanded === 'slack'}
          iconBg={slackConnected ? 'bg-green-900/30' : 'bg-gray-800'}
          icon={
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-pink-400"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" /></svg>
          }
          onClick={() => toggle('slack')}
        />
        <SummaryCard
          name="Weekly Email Report"
          tagline="Automated weekly summary"
          connected={emailEnabled}
          statusLabel={emailEnabled ? 'Enabled' : 'Disabled'}
          expanded={expanded === 'email'}
          iconBg={emailEnabled ? 'bg-green-900/30' : 'bg-gray-800'}
          icon={
            <svg className="w-5 h-5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          }
          onClick={() => toggle('email')}
        />
        <SummaryCard
          name="AI Provider"
          tagline="Powers Chat + AI session titles"
          connected={chatConfigured}
          statusLabel={chatConfigured ? 'Configured' : 'Not configured'}
          expanded={expanded === 'chat'}
          iconBg={chatConfigured ? 'bg-green-900/30' : 'bg-gray-800'}
          icon={
            <svg className="w-5 h-5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          }
          onClick={() => toggle('chat')}
        />
      </div>

      {/* Detail section for the expanded card. Only render the one
          that's open so the page stays scannable. */}
      <div className="mt-2 space-y-4">
        {expanded === 'github' && <GitHubIntegration />}
        {expanded === 'gitlab' && <GitLabIntegration />}
        {expanded === 'slack' && <SlackIntegration />}
        {expanded === 'email' && <WeeklyEmailReport />}
        {expanded === 'chat' && <AIChatIntegration />}
      </div>
    </>
  );
}

interface SummaryCardProps {
  name: string;
  tagline: string;
  connected: boolean;
  statusLabel: string;
  expanded: boolean;
  iconBg: string;
  icon: React.ReactNode;
  onClick: () => void;
}

function SummaryCard({ name, tagline, connected, statusLabel, expanded, iconBg, icon, onClick }: SummaryCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-4 text-left transition-all hover:border-gray-600 ${
        expanded
          ? 'border-indigo-500/40 bg-indigo-500/[0.05]'
          : connected
            ? 'border-green-800/50 bg-green-900/5'
            : 'border-gray-800 bg-gray-900/40'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-200 truncate">{name}</h3>
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0 ${
              connected
                ? 'bg-green-900/30 text-green-400'
                : 'bg-gray-800 text-gray-500'
            }`}>
              {statusLabel}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{tagline}</p>
        </div>
        <span className="text-gray-600 text-sm">{expanded ? '▾' : '▸'}</span>
      </div>
    </button>
  );
}
