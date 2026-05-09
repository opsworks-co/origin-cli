import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { useParams } from 'react-router-dom';
import ChatWidget from '../../components/ChatWidget';
import { Section, DocTab, TABS, SECTIONS } from './shared/types';

import OverviewSection from './sections/overview';
import QuickStartSection from './sections/quick-start';
import WorkflowSection from './sections/workflow';
import SessionTrackingSection from './sections/session-tracking';
import IntegrationsSection from './sections/integrations';
import GitlabIntegrationSection from './sections/gitlab-integration';
import ReposSection from './sections/repos';
import AgentsSection from './sections/agents';
import PoliciesSection from './sections/policies';
import SettingsSection from './sections/settings';
import RbacSection from './sections/rbac';
import DashboardSection from './sections/dashboard';
import SessionsSection from './sections/sessions';
import AiBlameSection from './sections/ai-blame';
import AskAuthorSection from './sections/ask-author';
import GitNotesSection from './sections/git-notes';
import AiReviewSection from './sections/ai-review';
import BudgetSection from './sections/budget';
import RealtimeSection from './sections/realtime';
import SecretScanningSection from './sections/secret-scanning';
import ComplianceSection from './sections/compliance';
import AnalyticsSection from './sections/analytics';
import PromptsSection from './sections/prompts';
import ModelComparisonSection from './sections/model-comparison';
import PullRequestsSection from './sections/pull-requests';
import GithubChecksSection from './sections/github-checks';
import TrailsSection from './sections/trails';
import MachinesSection from './sections/machines';
import SoloSetupSection from './sections/solo-setup';
import DeveloperDashboardSection from './sections/developer-dashboard';
import WebhooksSection from './sections/webhooks';
import CliSection from './sections/cli';
import CliInstallSection from './sections/cli-install';
import CliConfigSection from './sections/cli-config';
import CliSessionsSection from './sections/cli-sessions';
import CliHooksSection from './sections/cli-hooks';
import CliBlameSection from './sections/cli-blame';
import CliLocalSection from './sections/cli-local';
import McpSection from './sections/mcp';
import ApiSection from './sections/api';

export default function Docs() {
  const { section: urlSection } = useParams<{ section?: string }>();
  // Default to "Team" — most users land on /docs to set up their org, not
  // to read CLI reference. The hero card on Overview points straight at the
  // team quick-start walkthrough.
  const [activeTab, setActiveTab] = useState<DocTab>('team');
  const [active, setActive] = useState<Section>('overview');

  useEffect(() => {
    // Support /docs/:section URL paths
    if (urlSection) {
      const matched = SECTIONS.find((s) => s.key === urlSection);
      if (matched) {
        setActive(matched.key);
        setActiveTab(matched.tab);
        return;
      }
    }
    if (window.location.hash) {
      const hash = window.location.hash.slice(1);
      // Check if hash matches a tab
      const matchedTab = TABS.find((t) => t.key === hash);
      if (matchedTab) {
        setActiveTab(matchedTab.key);
        const firstSection = SECTIONS.find((s) => s.tab === matchedTab.key);
        if (firstSection) setActive(firstSection.key);
        return;
      }
      // Check if hash matches a section key for sidebar navigation
      const matchedSection = SECTIONS.find((s) => s.key === hash);
      if (matchedSection) {
        setActive(matchedSection.key);
        setActiveTab(matchedSection.tab);
      }
      // Scroll to the element after a short delay to allow render
      setTimeout(() => {
        const el = document.getElementById(hash);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }, [urlSection]);

  const filteredSections = SECTIONS.filter((s) => s.tab === activeTab);
  let lastGroup = '';

  const handleTabChange = (tab: DocTab) => {
    setActiveTab(tab);
    const first = SECTIONS.find((s) => s.tab === tab);
    if (first) setActive(first.key);
    window.history.replaceState(null, '', `#${tab}`);
  };

  return (
    <>
    <Helmet>
      <title>Documentation — Origin | Setup, Features &amp; API Reference</title>
      <meta name="description" content="Complete documentation for the Origin AI code governance platform. Setup guides, feature walkthroughs, CLI reference, API docs, and integration instructions." />
      <link rel="canonical" href="https://getorigin.io/docs" />
    </Helmet>
    <div className="max-w-6xl mx-auto px-6 py-8">

    {/* Tab Navigation */}
    <div className="flex items-center gap-1 mb-8 border-b border-gray-800/60 pb-px">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          onClick={() => handleTabChange(tab.key)}
          className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
            activeTab === tab.key
              ? 'text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {tab.label}
          {activeTab === tab.key && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 rounded-full" />
          )}
        </button>
      ))}
      <span className="ml-3 text-xs text-gray-600 hidden sm:inline">
        {TABS.find((t) => t.key === activeTab)?.description}
      </span>
    </div>

    <div className="flex gap-8">
      {/* Sidebar TOC */}
      <nav className="hidden lg:block w-48 flex-shrink-0 sticky top-20 self-start">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          {TABS.find((t) => t.key === activeTab)?.label}
        </p>
        <div className="space-y-0.5">
          {filteredSections.map((s) => {
            const showGroup = s.group && s.group !== lastGroup;
            if (s.group) lastGroup = s.group;
            return (
              <React.Fragment key={s.key}>
                {showGroup && (
                  <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider pt-4 pb-1 px-3">
                    {s.group}
                  </p>
                )}
                <button
                  onClick={() => { setActive(s.key); window.history.replaceState(null, '', `#${s.key}`); }}
                  className={`block w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    active === s.key
                      ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                      : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                  }`}
                >
                  {s.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </nav>

      {/* Mobile dropdown */}
      <div className="lg:hidden mb-4">
        <select
          value={active}
          onChange={(e) => setActive(e.target.value as Section)}
          className="select w-full text-sm"
        >
          {filteredSections.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 max-w-3xl">
        {active === 'overview' && <OverviewSection setActive={setActive} />}
        {active === 'quick-start' && <QuickStartSection />}
        {active === 'workflow' && <WorkflowSection />}
        {active === 'session-tracking' && <SessionTrackingSection />}
        {active === 'integrations' && <IntegrationsSection />}
        {active === 'gitlab-integration' && <GitlabIntegrationSection />}
        {active === 'repos' && <ReposSection />}
        {active === 'agents' && <AgentsSection />}
        {active === 'policies' && <PoliciesSection />}
        {active === 'settings' && <SettingsSection />}
        {active === 'rbac' && <RbacSection />}
        {active === 'dashboard' && <DashboardSection />}
        {active === 'sessions' && <SessionsSection />}
        {active === 'ai-blame' && <AiBlameSection />}
        {active === 'ask-author' && <AskAuthorSection />}
        {active === 'git-notes' && <GitNotesSection />}
        {active === 'ai-review' && <AiReviewSection />}
        {active === 'budget' && <BudgetSection />}
        {active === 'realtime' && <RealtimeSection />}
        {active === 'secret-scanning' && <SecretScanningSection />}
        {active === 'compliance' && <ComplianceSection />}
        {active === 'analytics' && <AnalyticsSection />}
        {active === 'prompts' && <PromptsSection />}
        {active === 'model-comparison' && <ModelComparisonSection />}
        {active === 'pull-requests' && <PullRequestsSection />}
        {active === 'github-checks' && <GithubChecksSection />}
        {active === 'trails' && <TrailsSection />}
        {active === 'machines' && <MachinesSection />}
        {active === 'solo-setup' && <SoloSetupSection />}
        {active === 'developer-dashboard' && <DeveloperDashboardSection />}
        {active === 'webhooks' && <WebhooksSection />}
        {active === 'cli' && <CliSection />}
        {active === 'cli-install' && <CliInstallSection />}
        {active === 'cli-config' && <CliConfigSection />}
        {active === 'cli-sessions' && <CliSessionsSection />}
        {active === 'cli-hooks' && <CliHooksSection />}
        {active === 'cli-blame' && <CliBlameSection />}
        {active === 'cli-local' && <CliLocalSection />}
        {active === 'mcp' && <McpSection />}
        {active === 'api' && <ApiSection />}
      </div>
    </div>
    </div>
    <ChatWidget
      endpoint="/api/chat/docs"
      title="Docs Assistant"
      placeholder="Ask about Origin setup, policies, CLI..."
      welcomeMessage="Hi! I can help answer questions about the Origin platform. What would you like to know?"
    />
    </>
  );
}
