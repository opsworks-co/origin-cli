import React, { useState, useEffect, useCallback } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';

/* ------------------------------------------------------------------ */
/*  Types & data                                                       */
/* ------------------------------------------------------------------ */

interface Step {
  title: string;
  caption: string;
  browserTitle: string;
  content: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Shared presentational helpers                                      */
/* ------------------------------------------------------------------ */

function BrowserChrome({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden w-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/80">
        <div className="w-3 h-3 rounded-full bg-red-500/80" />
        <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
        <div className="w-3 h-3 rounded-full bg-green-500/80" />
        <span className="text-xs text-gray-500 ml-2 font-mono truncate">{title}</span>
      </div>
      <div className="p-6 min-h-[340px]">{children}</div>
    </div>
  );
}

function MockInput({ value, className = '' }: { value: string; className?: string }) {
  return (
    <div className={`bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-400 ${className}`}>
      {value}
    </div>
  );
}

function MockButton({ children, variant = 'primary', className = '' }: { children: React.ReactNode; variant?: 'primary' | 'secondary' | 'danger'; className?: string }) {
  const base = 'rounded-lg px-4 py-2 text-sm font-medium text-center cursor-default select-none';
  const styles = {
    primary: 'bg-indigo-600 text-white',
    secondary: 'bg-gray-700 text-gray-300 border border-gray-600',
    danger: 'bg-red-600/20 text-red-400 border border-red-500/30',
  };
  return <div className={`${base} ${styles[variant]} ${className}`}>{children}</div>;
}

function Badge({ children, color = 'indigo' }: { children: React.ReactNode; color?: 'indigo' | 'green' | 'yellow' | 'red' | 'gray' }) {
  const colors = {
    indigo: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
    green: 'bg-green-500/20 text-green-400 border-green-500/30',
    yellow: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    red: 'bg-red-500/20 text-red-400 border-red-500/30',
    gray: 'bg-gray-700 text-gray-400 border-gray-600',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${colors[color]}`}>
      {children}
    </span>
  );
}

function SidebarItem({ icon, label, active = false }: { icon: string; label: string; active?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs ${active ? 'bg-indigo-600/20 text-indigo-400' : 'text-gray-500'}`}>
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function Checkbox({ checked = false, label }: { checked?: boolean; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-default">
      <div className={`w-4 h-4 rounded border flex items-center justify-center ${checked ? 'bg-indigo-600 border-indigo-500' : 'border-gray-600 bg-gray-800'}`}>
        {checked && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
      </div>
      <span className="text-sm text-gray-300">{label}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  Step content renderers                                             */
/* ------------------------------------------------------------------ */

function Step1Content() {
  return (
    <div className="flex gap-4">
      {/* sidebar */}
      <div className="hidden sm:block w-40 border-r border-gray-800 pr-4 space-y-1">
        <SidebarItem icon="⚙" label="General" />
        <SidebarItem icon="🔗" label="Integrations" active />
        <SidebarItem icon="🔑" label="API Keys" />
        <SidebarItem icon="👥" label="Team" />
      </div>
      {/* main */}
      <div className="flex-1 space-y-4">
        <div className="text-sm font-semibold text-gray-200">Integrations</div>
        <div className="border border-gray-700 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gray-800 rounded-lg flex items-center justify-center text-lg">
              <svg className="w-5 h-5 text-gray-300" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-gray-200">GitHub App</div>
              <div className="text-xs text-gray-500">Connect your GitHub organization</div>
            </div>
            <Badge color="gray">Not connected</Badge>
          </div>
          <div className="border-t border-gray-800 pt-3 space-y-2">
            <div className="text-xs text-gray-500">Origin requests read access to repository metadata, commits, and pull requests. It can also post commit statuses and PR checks.</div>
            <MockButton>Install GitHub App</MockButton>
          </div>
        </div>
        <div className="border border-gray-700 rounded-lg p-4 opacity-40">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gray-800 rounded-lg flex items-center justify-center text-lg">
              <svg className="w-5 h-5 text-orange-400" viewBox="0 0 24 24" fill="currentColor"><path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z"/></svg>
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium text-gray-200">GitLab</div>
              <div className="text-xs text-gray-500">Connect via Personal Access Token</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Step2Content() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-200">Repositories</div>
        <MockButton>Import from GitHub</MockButton>
      </div>
      {/* import dialog */}
      <div className="border border-indigo-500/40 rounded-lg bg-indigo-950/20 p-4 space-y-3">
        <div className="text-sm font-medium text-gray-200">Import repositories</div>
        <div className="text-xs text-gray-500">Select repositories from your GitHub organization to track with Origin.</div>
        <div className="space-y-2">
          <Checkbox checked label="acme/backend" />
          <Checkbox checked label="acme/frontend" />
          <Checkbox label="acme/infra" />
          <Checkbox checked label="acme/api-gateway" />
          <Checkbox label="acme/design-system" />
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-gray-800">
          <span className="text-xs text-gray-500">3 repositories selected</span>
          <MockButton>Import selected</MockButton>
        </div>
      </div>
    </div>
  );
}

function Step3Content() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-200">AI Agents</div>
        <MockButton>+ New Agent</MockButton>
      </div>
      {/* create form */}
      <div className="border border-gray-700 rounded-lg p-4 space-y-3">
        <div className="text-sm font-medium text-gray-200">Register a new agent</div>
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Name</span>
            <MockInput value="Claude Code" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Model</span>
            <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-300 flex items-center justify-between">
              <span>claude-sonnet-4</span>
              <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </div>
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Description</span>
            <MockInput value="Anthropic's AI coding assistant for VS Code and CLI" />
          </label>
        </div>
        <div className="flex gap-2 pt-2">
          <MockButton>Create Agent</MockButton>
          <MockButton variant="secondary">Cancel</MockButton>
        </div>
      </div>
      {/* existing agents table hint */}
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-gray-800 bg-gray-800/50 text-gray-400"><th className="text-left px-3 py-2">Agent</th><th className="text-left px-3 py-2">Model</th><th className="text-left px-3 py-2">Sessions</th></tr></thead>
          <tbody>
            <tr className="border-b border-gray-800"><td className="px-3 py-2 text-gray-300">Cursor</td><td className="px-3 py-2 text-gray-400">gpt-4o</td><td className="px-3 py-2 text-gray-400">142</td></tr>
            <tr><td className="px-3 py-2 text-gray-300">Copilot</td><td className="px-3 py-2 text-gray-400">gpt-4o</td><td className="px-3 py-2 text-gray-400">87</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Step4Content() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-200">API Keys</div>
        <MockButton>+ Create Key</MockButton>
      </div>
      <div className="border border-gray-700 rounded-lg p-4 space-y-3">
        <div className="text-sm font-medium text-gray-200">New API key</div>
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Name</span>
            <MockInput value="alice-dev-key" />
          </label>
          <div>
            <span className="text-xs text-gray-500 mb-1 block">Repository scopes</span>
            <div className="flex flex-wrap gap-2">
              <Badge color="indigo">acme/backend</Badge>
              <Badge color="gray">+ Add repo</Badge>
            </div>
          </div>
          <div>
            <span className="text-xs text-gray-500 mb-1 block">Agent scopes</span>
            <div className="flex flex-wrap gap-2">
              <Badge color="indigo">Claude Code</Badge>
              <Badge color="gray">+ Add agent</Badge>
            </div>
          </div>
        </div>
        <MockButton className="mt-2">Generate Key</MockButton>
      </div>
      {/* existing key */}
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-gray-800 bg-gray-800/50 text-gray-400"><th className="text-left px-3 py-2">Name</th><th className="text-left px-3 py-2">Repos</th><th className="text-left px-3 py-2">Agents</th><th className="text-left px-3 py-2">Created</th></tr></thead>
          <tbody>
            <tr className="border-b border-gray-800"><td className="px-3 py-2 text-gray-300">bob-staging-key</td><td className="px-3 py-2 text-gray-400">acme/frontend</td><td className="px-3 py-2 text-gray-400">Cursor</td><td className="px-3 py-2 text-gray-400">2 days ago</td></tr>
            <tr><td className="px-3 py-2 text-gray-300">ci-pipeline</td><td className="px-3 py-2 text-gray-400">all</td><td className="px-3 py-2 text-gray-400">all</td><td className="px-3 py-2 text-gray-400">5 days ago</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Step5Content() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-200">Governance Policies</div>
        <MockButton>+ New Policy</MockButton>
      </div>
      <div className="border border-gray-700 rounded-lg p-4 space-y-3">
        <div className="text-sm font-medium text-gray-200">Create policy</div>
        <div className="space-y-2">
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Policy type</span>
            <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-300 flex items-center justify-between">
              <span>FILE_RESTRICTION</span>
              <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </div>
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">File patterns</span>
            <MockInput value="*.env, secrets/*, .credentials" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Action</span>
            <div className="flex gap-2">
              <div className="bg-red-600/20 border border-red-500/40 rounded-lg px-4 py-2 text-sm text-red-400 font-medium">BLOCK</div>
              <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-500">WARN</div>
              <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-500">LOG</div>
            </div>
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block">Message</span>
            <MockInput value="AI agents cannot modify environment or secret files" />
          </label>
        </div>
        <MockButton className="mt-2">Create Policy</MockButton>
      </div>
      {/* existing policies */}
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-gray-800 bg-gray-800/50 text-gray-400"><th className="text-left px-3 py-2">Policy</th><th className="text-left px-3 py-2">Type</th><th className="text-left px-3 py-2">Action</th></tr></thead>
          <tbody>
            <tr className="border-b border-gray-800"><td className="px-3 py-2 text-gray-300">Max cost per session</td><td className="px-3 py-2 text-gray-400">COST_LIMIT</td><td className="px-3 py-2"><Badge color="yellow">WARN</Badge></td></tr>
            <tr><td className="px-3 py-2 text-gray-300">Require human review</td><td className="px-3 py-2 text-gray-400">HUMAN_REVIEW</td><td className="px-3 py-2"><Badge color="red">BLOCK</Badge></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Step6Content() {
  return (
    <div className="space-y-4">
      <div className="text-sm font-semibold text-gray-200">Active Sessions</div>
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-gray-800 bg-gray-800/50 text-gray-400"><th className="text-left px-3 py-2">Agent</th><th className="text-left px-3 py-2">Repo</th><th className="text-left px-3 py-2">Status</th><th className="text-left px-3 py-2">Duration</th><th className="text-left px-3 py-2">Cost</th></tr></thead>
          <tbody>
            <tr className="border-b border-gray-800 bg-indigo-950/20">
              <td className="px-3 py-2 text-gray-200 font-medium">Claude Code</td>
              <td className="px-3 py-2 text-gray-400">acme/backend</td>
              <td className="px-3 py-2"><Badge color="green">active</Badge></td>
              <td className="px-3 py-2 text-gray-400">12m</td>
              <td className="px-3 py-2 text-gray-400">$0.34</td>
            </tr>
            <tr className="border-b border-gray-800">
              <td className="px-3 py-2 text-gray-300">Cursor</td>
              <td className="px-3 py-2 text-gray-400">acme/frontend</td>
              <td className="px-3 py-2"><Badge color="green">active</Badge></td>
              <td className="px-3 py-2 text-gray-400">8m</td>
              <td className="px-3 py-2 text-gray-400">$0.21</td>
            </tr>
            <tr>
              <td className="px-3 py-2 text-gray-300">Copilot</td>
              <td className="px-3 py-2 text-gray-400">acme/api-gateway</td>
              <td className="px-3 py-2"><Badge color="gray">completed</Badge></td>
              <td className="px-3 py-2 text-gray-400">4m</td>
              <td className="px-3 py-2 text-gray-400">$0.09</td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* session detail */}
      <div className="border border-indigo-500/30 rounded-lg p-4 space-y-3 bg-indigo-950/10">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-gray-200">Session detail — Claude Code</div>
          <Badge color="green">live</Badge>
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div><span className="text-gray-500">Files changed</span><div className="text-gray-200 font-medium mt-0.5">3</div></div>
          <div><span className="text-gray-500">Tokens</span><div className="text-gray-200 font-medium mt-0.5">12,480</div></div>
          <div><span className="text-gray-500">Policy violations</span><div className="text-green-400 font-medium mt-0.5">0</div></div>
        </div>
        <div className="bg-gray-900 rounded border border-gray-800 p-3 font-mono text-xs leading-relaxed overflow-x-auto">
          <div className="text-gray-500">src/services/auth.ts</div>
          <div className="text-red-400">- const token = jwt.sign(payload, SECRET);</div>
          <div className="text-green-400">+ const token = jwt.sign(payload, SECRET, {'{'} expiresIn: '1h' {'}'});</div>
          <div className="text-green-400">+ logger.info('Token generated', {'{'} userId {'}'});</div>
        </div>
      </div>
    </div>
  );
}

function Step7Content() {
  return (
    <div className="space-y-4">
      {/* PR header */}
      <div className="flex items-center gap-3">
        <svg className="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
        <div>
          <div className="text-sm font-medium text-gray-200">feat: add token expiry to auth service <span className="text-gray-500 font-normal">#247</span></div>
          <div className="text-xs text-gray-500">acme/backend &middot; opened 3 minutes ago by Claude Code</div>
        </div>
      </div>
      {/* checks section */}
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        <div className="bg-gray-800/50 px-4 py-2 text-xs font-medium text-gray-300 border-b border-gray-800">Status Checks</div>
        <div className="p-4 space-y-3">
          {/* passed check */}
          <div className="flex items-start gap-3">
            <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center mt-0.5">
              <svg className="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            </div>
            <div className="flex-1">
              <div className="text-sm text-gray-200 font-medium">origin/governance — All checks passed</div>
              <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                <div className="flex items-center gap-4">
                  <span>3 files changed by <strong className="text-gray-400">Claude Code</strong></span>
                  <span>0 policy violations</span>
                  <span>Cost: $0.34</span>
                </div>
              </div>
            </div>
            <Badge color="green">Passed</Badge>
          </div>
          <div className="border-t border-gray-800" />
          {/* detail rows */}
          <div className="space-y-2 text-xs pl-8">
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              <span className="text-gray-400">File restrictions — no restricted files modified</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              <span className="text-gray-400">Secret scanning — no secrets detected</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              <span className="text-gray-400">Cost limit — $0.34 within $5.00 budget</span>
            </div>
          </div>
          <div className="border-t border-gray-800" />
          {/* CI check */}
          <div className="flex items-start gap-3">
            <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center mt-0.5">
              <svg className="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            </div>
            <div className="flex-1">
              <div className="text-sm text-gray-300">ci/tests — 142 passed, 0 failed</div>
            </div>
            <Badge color="green">Passed</Badge>
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <MockButton>Merge pull request</MockButton>
        <MockButton variant="secondary">Request changes</MockButton>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Steps data                                                         */
/* ------------------------------------------------------------------ */

const STEPS: Step[] = [
  {
    title: 'Connect your GitHub account',
    caption: 'One-click GitHub App installation. Origin gets read access to your repos and can post PR status checks.',
    browserTitle: 'getorigin.io/settings/integrations',
    content: <Step1Content />,
  },
  {
    title: 'Import your repositories',
    caption: 'Select which repos to track. Origin monitors AI-authored commits and enforces your governance policies.',
    browserTitle: 'getorigin.io/repos',
    content: <Step2Content />,
  },
  {
    title: 'Register your AI agents',
    caption: 'Define which AI coding tools your team uses. Each agent gets its own tracking, cost analytics, and policy controls.',
    browserTitle: 'getorigin.io/agents',
    content: <Step3Content />,
  },
  {
    title: 'Create API keys with scoped permissions',
    caption: 'Generate API keys scoped to specific repos and agents. Each developer gets their own key with fine-grained access control.',
    browserTitle: 'getorigin.io/iam',
    content: <Step4Content />,
  },
  {
    title: 'Set governance policies',
    caption: 'Enforce rules on AI-generated code — restrict file access, require human review, set cost limits, scan for secrets.',
    browserTitle: 'getorigin.io/policies',
    content: <Step5Content />,
  },
  {
    title: 'Monitor live sessions',
    caption: 'Watch AI coding sessions in real-time. See every prompt, every file changed, every token spent.',
    browserTitle: 'getorigin.io/sessions',
    content: <Step6Content />,
  },
  {
    title: 'Review PR checks',
    caption: 'Origin posts status checks on every PR. Block merges that violate policies, flag sessions for human review.',
    browserTitle: 'github.com/acme/backend/pull/247',
    content: <Step7Content />,
  },
];

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function PlatformTour({ embedded = false }: { embedded?: boolean }) {
  const [current, setCurrent] = useState(0);
  const [autoPlay, setAutoPlay] = useState(true);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [transitioning, setTransitioning] = useState(false);

  const goTo = useCallback(
    (idx: number, dir?: 'next' | 'prev') => {
      if (idx < 0 || idx >= STEPS.length || idx === current) return;
      setDirection(dir ?? (idx > current ? 'next' : 'prev'));
      setTransitioning(true);
      setTimeout(() => {
        setCurrent(idx);
        setTransitioning(false);
      }, 200);
    },
    [current],
  );

  const next = useCallback(() => goTo((current + 1) % STEPS.length, 'next'), [current, goTo]);
  const prev = useCallback(() => goTo((current - 1 + STEPS.length) % STEPS.length, 'prev'), [current, goTo]);

  useEffect(() => {
    if (!autoPlay) return;
    const id = setInterval(next, 5000);
    return () => clearInterval(id);
  }, [autoPlay, next]);

  const step = STEPS[current];

  return (
    <>
      {!embedded && (
        <Helmet>
          <title>Platform Demo — Origin | See AI Code Governance in Action</title>
          <meta
            name="description"
            content="Interactive walkthrough of Origin's AI code governance platform. See how to track, review, and enforce policies on AI-authored code."
          />
          <link rel="canonical" href="https://getorigin.io/demo" />
        </Helmet>
      )}

      <div className={embedded ? 'text-gray-100' : 'min-h-screen bg-[#0a0b14] text-gray-100'}>
        <div className={embedded ? '' : 'max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-20'}>
          {!embedded && (
            <div className="text-center mb-12">
              <h1 className="text-3xl sm:text-4xl font-bold mb-3">See Origin in action</h1>
              <p className="text-gray-400 max-w-2xl mx-auto text-sm sm:text-base">
                A step-by-step walkthrough of the Origin platform. Click through or sit back and watch.
              </p>
            </div>
          )}

          {/* ── Step indicators ────────────────────────────── */}
          <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
            {STEPS.map((s, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`h-2 rounded-full transition-all duration-300 ${
                  i === current
                    ? 'w-8 bg-indigo-500'
                    : 'w-2 bg-gray-700 hover:bg-gray-600'
                }`}
                aria-label={`Step ${i + 1}: ${s.title}`}
              />
            ))}
          </div>

          {/* ── Step title + number ───────────────────────── */}
          <div className="text-center mb-6">
            <span className="text-xs text-indigo-400 font-medium tracking-wider uppercase">
              Step {current + 1} of {STEPS.length}
            </span>
            <h2 className="text-xl sm:text-2xl font-semibold mt-1">{step.title}</h2>
          </div>

          {/* ── Browser mockup ────────────────────────────── */}
          <div
            className="transition-all duration-200 ease-in-out"
            style={{
              opacity: transitioning ? 0 : 1,
              transform: transitioning
                ? `translateX(${direction === 'next' ? '24px' : '-24px'})`
                : 'translateX(0)',
            }}
          >
            <BrowserChrome title={step.browserTitle}>{step.content}</BrowserChrome>
          </div>

          {/* ── Caption ───────────────────────────────────── */}
          <p
            className="text-center text-sm text-gray-400 mt-6 max-w-2xl mx-auto transition-opacity duration-200"
            style={{ opacity: transitioning ? 0 : 1 }}
          >
            {step.caption}
          </p>

          {/* ── Controls ──────────────────────────────────── */}
          <div className="flex items-center justify-center gap-4 mt-8">
            <button
              onClick={prev}
              className="p-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
              aria-label="Previous step"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>

            <button
              onClick={() => setAutoPlay(!autoPlay)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                autoPlay
                  ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-400'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
              }`}
            >
              {autoPlay ? (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6" /></svg>
                  Pause
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  Auto-play
                </>
              )}
            </button>

            <button
              onClick={next}
              className="p-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
              aria-label="Next step"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>

          {/* ── CTA ───────────────────────────────────────── */}
          {!embedded && (
          <div className="mt-20 text-center border border-gray-800 rounded-2xl p-8 sm:p-12 bg-gradient-to-b from-gray-900/50 to-transparent">
            <h2 className="text-2xl sm:text-3xl font-bold mb-3">Ready to get started?</h2>
            <p className="text-gray-400 mb-8 max-w-lg mx-auto text-sm sm:text-base">
              Set up AI code governance for your team in under 5 minutes. Free to start, no credit card required.
            </p>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <Link
                to="/register"
                className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-6 py-3 rounded-lg transition-colors"
              >
                Create free account
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
              </Link>
              <Link
                to="/docs"
                className="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium px-6 py-3 rounded-lg border border-gray-700 transition-colors"
              >
                View documentation
              </Link>
            </div>
          </div>
          )}
        </div>
      </div>
    </>
  );
}

export default function DemoPlatformPage() {
  return <PlatformTour />;
}
