import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings as SettingsIcon, Key, Plug, ScrollText, FileText, Footprints, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import AuditLog from '../AuditLog';
import Reports from '../Reports';
import Trails from '../Trails';
import Compliance from '../Compliance';
import GeneralTab from './GeneralTab';
import IntegrationsTab from './IntegrationsTab';
import ApiKeys from '../ApiKeys';

type SettingsTab = 'general' | 'keys' | 'integrations' | 'audit' | 'reports' | 'trails' | 'compliance';
const ORG_TABS: SettingsTab[] = ['general', 'keys', 'integrations', 'audit', 'reports', 'trails', 'compliance'];
const DEV_TABS: SettingsTab[] = ['general', 'keys', 'integrations'];

const TAB_META: Record<SettingsTab, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  general:      { label: 'General',      Icon: SettingsIcon },
  keys:         { label: 'API Keys',     Icon: Key },
  integrations: { label: 'Integrations', Icon: Plug },
  audit:        { label: 'Audit Log',    Icon: ScrollText },
  reports:      { label: 'Reports',      Icon: FileText },
  trails:       { label: 'Trails',       Icon: Footprints },
  compliance:   { label: 'Compliance',   Icon: ShieldCheck },
};


export default function Settings() {
  const { user, activeOrg } = useAuth();
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
      {(() => {
        const accent = isDev ? 'emerald' : 'indigo';
        const TabBtn = ({ tab }: { tab: SettingsTab }) => {
          const meta = TAB_META[tab];
          const active = activeTab === tab;
          return (
            <button
              onClick={() => setActiveTab(tab)}
              className={`group relative inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium transition-all ${
                active
                  ? (accent === 'emerald' ? 'text-emerald-400' : 'text-indigo-400')
                  : 'text-gray-500 hover:text-gray-200'
              }`}
            >
              <meta.Icon className={`w-3.5 h-3.5 transition-transform ${active ? '' : 'group-hover:scale-110 opacity-70 group-hover:opacity-100'}`} />
              <span>{meta.label}</span>
              {active && (
                <span
                  className={`absolute left-2 right-2 -bottom-px h-0.5 rounded-full ${
                    accent === 'emerald'
                      ? 'bg-gradient-to-r from-emerald-500/0 via-emerald-500 to-emerald-500/0'
                      : 'bg-gradient-to-r from-indigo-500/0 via-indigo-500 to-indigo-500/0'
                  }`}
                />
              )}
            </button>
          );
        };
        return (
          <div className="relative">
            <div className="flex items-center gap-0.5 border-b border-white/[0.06] flex-wrap">
              <TabBtn tab="general" />
              <TabBtn tab="keys" />
              {(isDev || activeOrg?.role === 'ADMIN' || activeOrg?.role === 'OWNER') && <TabBtn tab="integrations" />}
              {!isDev && (
                <>
                  <span className="mx-1.5 h-4 w-px bg-white/[0.08]" />
                  <TabBtn tab="audit" />
                  <TabBtn tab="reports" />
                  <span className="mx-1.5 h-4 w-px bg-white/[0.08]" />
                  <TabBtn tab="trails" />
                  <TabBtn tab="compliance" />
                </>
              )}
            </div>
          </div>
        );
      })()}

      {activeTab === 'general' && <GeneralTab />}

      {activeTab === 'keys' && <ApiKeys />}

      {activeTab === 'integrations' && <IntegrationsTab />}

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
