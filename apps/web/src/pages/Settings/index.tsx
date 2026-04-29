import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import AuditLog from '../AuditLog';
import Reports from '../Reports';
import Trails from '../Trails';
import Compliance from '../Compliance';
import GeneralTab from './GeneralTab';
import IntegrationsTab from './IntegrationsTab';
import AiTab from './AiTab';
import ApiKeys from '../ApiKeys';

type SettingsTab = 'general' | 'keys' | 'integrations' | 'ai' | 'audit' | 'reports' | 'trails' | 'compliance';
const ORG_TABS: SettingsTab[] = ['general', 'keys', 'integrations', 'ai', 'audit', 'reports', 'trails', 'compliance'];
const DEV_TABS: SettingsTab[] = ['general', 'keys', 'integrations', 'ai'];


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

  // Handle GitHub App / GitLab OAuth callback URL params — switch to integrations tab
  useEffect(() => {
    const githubAppResult = searchParams.get('github_app');
    const gitlabOAuthResult = searchParams.get('gitlab_oauth');
    if (githubAppResult === 'success' || githubAppResult === 'error' || githubAppResult === 'requested') {
      setActiveTabState('integrations');
    }
    if (gitlabOAuthResult === 'success' || gitlabOAuthResult === 'error') {
      setActiveTabState('integrations');
    }
  }, []);

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
        <button
          onClick={() => setActiveTab('keys')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'keys'
              ? (isDev ? 'border-emerald-500 text-emerald-400' : 'border-indigo-500 text-indigo-400')
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          API Keys
        </button>
        {(isDev || (user?.role === 'ADMIN' || user?.role === 'OWNER')) && (
        <button
          onClick={() => setActiveTab('integrations')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'integrations'
              ? (isDev ? 'border-emerald-500 text-emerald-400' : 'border-indigo-500 text-indigo-400')
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Integrations
        </button>
        )}
        {(isDev || (user?.role === 'ADMIN' || user?.role === 'OWNER')) && (
        <button
          onClick={() => setActiveTab('ai')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'ai'
              ? (isDev ? 'border-emerald-500 text-emerald-400' : 'border-indigo-500 text-indigo-400')
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          AI
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
      </div>

      {activeTab === 'general' && <GeneralTab />}

      {activeTab === 'keys' && <ApiKeys />}

      {activeTab === 'integrations' && <IntegrationsTab />}

      {activeTab === 'ai' && <AiTab />}

      {/* Agent Setup tab removed — content moved to Docs */}


      {/* Team moved to /iam, Budget moved to /budget */}
      {activeTab === 'audit' && <AuditLog />}
      {/* Insights moved to /insights */}
      {activeTab === 'reports' && <Reports />}
      {activeTab === 'trails' && <Trails />}
      {activeTab === 'compliance' && <Compliance />}
      {/* API Keys moved to standalone /api-keys page */}
      {/* Model Comparison moved to /insights */}
      {/* Leaderboard moved to /leaderboard */}
    </div>
  );
}
