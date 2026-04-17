export type Section =
  | 'overview'
  | 'quick-start'
  | 'workflow'
  | 'integrations'
  | 'gitlab-integration'
  | 'session-tracking'
  | 'repos'
  | 'sessions'
  | 'agents'
  | 'policies'
  | 'settings'
  | 'dashboard'
  | 'cli'
  | 'cli-install'
  | 'cli-sessions'
  | 'cli-config'
  | 'cli-hooks'
  | 'cli-local'
  | 'mcp'
  | 'webhooks'
  | 'rbac'
  | 'api'
  | 'ai-review'
  | 'budget'
  | 'realtime'
  | 'secret-scanning'
  | 'compliance'
  | 'analytics'
  | 'ai-blame'
  | 'ask-author'
  | 'git-notes'
  | 'developer-dashboard'
  | 'pull-requests'
  | 'github-checks'
  | 'trails'
  | 'prompts'
  | 'model-comparison'
  | 'machines'
  | 'solo-setup';

export type DocTab = 'team' | 'solo' | 'cli';

export const TABS: { key: DocTab; label: string; description: string }[] = [
  { key: 'cli', label: 'Origin CLI', description: 'Command-line tool & API' },
  { key: 'solo', label: 'Origin Solo', description: 'Personal developer dashboard' },
  { key: 'team', label: 'Origin Team', description: 'Organization governance & management' },
];

export const SECTIONS: { key: Section; label: string; group?: string; tab: DocTab }[] = [
  // ── Origin Team ──
  { key: 'overview', label: 'Overview', group: 'Getting Started', tab: 'team' },
  { key: 'quick-start', label: 'Quick Start Guide', tab: 'team' },
  { key: 'workflow', label: 'How It Works', tab: 'team' },
  { key: 'session-tracking', label: 'Session Tracking', group: 'Setup & Configuration', tab: 'team' },
  { key: 'integrations', label: 'GitHub Integration', tab: 'team' },
  { key: 'gitlab-integration', label: 'GitLab Integration', tab: 'team' },
  { key: 'repos', label: 'Repositories', tab: 'team' },
  { key: 'agents', label: 'Agents', tab: 'team' },
  { key: 'policies', label: 'Policies', tab: 'team' },
  { key: 'settings', label: 'Settings & API Keys', tab: 'team' },
  { key: 'rbac', label: 'Team & Roles', tab: 'team' },
  { key: 'dashboard', label: 'Organization Dashboard', group: 'Features', tab: 'team' },
  { key: 'sessions', label: 'Sessions & Reviews', tab: 'team' },
  { key: 'ai-review', label: 'AI Auto-Review', tab: 'team' },
  { key: 'budget', label: 'Budget & Cost Controls', tab: 'team' },
  { key: 'realtime', label: 'Real-Time Streaming', tab: 'team' },
  { key: 'secret-scanning', label: 'Secret & PII Scanning', tab: 'team' },
  { key: 'compliance', label: 'Compliance Reports', tab: 'team' },
  { key: 'analytics', label: 'Enhanced Analytics', tab: 'team' },
  { key: 'prompts', label: 'Prompt Library', tab: 'team' },
  { key: 'model-comparison', label: 'Model Comparison', tab: 'team' },
  { key: 'pull-requests', label: 'Pull Requests', tab: 'team' },
  { key: 'github-checks', label: 'GitHub PR Checks', tab: 'team' },
  { key: 'trails', label: 'Trails', tab: 'team' },
  { key: 'machines', label: 'Machines', tab: 'team' },
  { key: 'webhooks', label: 'Webhooks', tab: 'team' },
  // ── Origin Solo ──
  { key: 'solo-setup', label: 'Setup Guide', group: 'Getting Started', tab: 'solo' },
  { key: 'developer-dashboard', label: 'Solo Dashboard', group: 'Your Workspace', tab: 'solo' },
  { key: 'ai-blame', label: 'AI Blame', tab: 'solo' },
  { key: 'ask-author', label: 'Ask the Author', tab: 'solo' },
  { key: 'git-notes', label: 'Git Notes', tab: 'solo' },
  // ── Origin CLI ──
  { key: 'cli', label: 'CLI Overview', group: 'Getting Started', tab: 'cli' },
  { key: 'cli-install', label: 'Installation', tab: 'cli' },
  { key: 'cli-config', label: 'Configuration', tab: 'cli' },
  { key: 'cli-sessions', label: 'Session Tracking', group: 'Usage', tab: 'cli' },
  { key: 'cli-hooks', label: 'Git Hooks', tab: 'cli' },
  { key: 'cli-local', label: 'Local Mode', tab: 'cli' },
  { key: 'mcp', label: 'MCP Server', group: 'Advanced', tab: 'cli' },
  { key: 'api', label: 'API Reference', tab: 'cli' },
];
