import chalk from 'chalk';
import { loadConfig, loadAgentConfig, loadRepoConfig, isConnectedMode } from '../config.js';
import { getGitRoot, listActiveSessions } from '../session-state.js';
import { computeAttributionStats } from '../attribution.js';

export async function verifyCommand(opts?: { json?: boolean }) {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  const config = loadConfig();
  const agentConfig = loadAgentConfig();
  const repoConfig = repoPath ? loadRepoConfig(repoPath) : null;
  const connected = isConnectedMode();

  const result: Record<string, any> = {};

  // ── Agent Config ──
  if (agentConfig) {
    result.agent = {
      machineId: agentConfig.machineId,
      hostname: agentConfig.hostname,
      detectedTools: agentConfig.detectedTools,
      agentSlug: agentConfig.agentSlug || null,
      orgId: agentConfig.orgId,
    };
  }

  // ── Mode ──
  result.mode = connected ? 'connected' : 'standalone';
  if (connected && config) {
    result.apiUrl = config.apiUrl;
    result.orgId = config.orgId;
  }

  // ── Repo Config ──
  if (repoPath) {
    result.repo = {
      path: repoPath,
      config: repoConfig || null,
    };
  }

  // ── Active Sessions ──
  if (repoPath) {
    const sessions = listActiveSessions(cwd);
    result.activeSessions = sessions.map(s => ({
      sessionId: s.sessionId,
      model: s.model,
      branch: s.branch,
      startedAt: s.startedAt,
      prompts: s.prompts?.length || 0,
    }));
  }

  // ── Attribution Summary ──
  if (repoPath) {
    try {
      const stats = computeAttributionStats(repoPath);
      const aiPct = stats.totalCommits > 0 ? Math.round((stats.aiCommits / stats.totalCommits) * 100) : 0;
      const aiLinesPct = stats.totalLinesAdded > 0 ? Math.round((stats.aiLinesAdded / stats.totalLinesAdded) * 100) : 0;
      result.attribution = {
        totalCommits: stats.totalCommits,
        aiCommits: stats.aiCommits,
        humanCommits: stats.humanCommits,
        aiCommitsPct: aiPct,
        totalLinesAdded: stats.totalLinesAdded,
        aiLinesAdded: stats.aiLinesAdded,
        humanLinesAdded: stats.humanLinesAdded,
        aiLinesPct: aiLinesPct,
        tools: Object.fromEntries(stats.byTool),
        models: Object.fromEntries(stats.byModel),
      };
    } catch {
      result.attribution = null;
    }
  }

  // ── Output ──
  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.bold('\n  Origin Verify\n'));

  // Mode
  if (connected) {
    console.log(chalk.green(`  ✓ Connected`) + chalk.gray(` to ${config?.apiUrl || 'Origin platform'}`));
  } else {
    console.log(chalk.gray(`  ○ Standalone mode`) + chalk.gray(' — sessions tracked locally in git'));
  }

  // Agent config
  if (agentConfig) {
    console.log(chalk.green(`  ✓ Agent initialized`));
    console.log(chalk.gray(`    Machine:  ${agentConfig.hostname} (${agentConfig.machineId.slice(0, 8)})`));
    console.log(chalk.gray(`    Tools:    ${agentConfig.detectedTools.length > 0 ? agentConfig.detectedTools.join(', ') : 'none detected'}`));
    if (agentConfig.agentSlug) {
      console.log(chalk.gray(`    Agent:    ${agentConfig.agentSlug}`));
    }
  } else {
    console.log(chalk.yellow(`  ⚠ No agent config`) + chalk.gray(' — run `origin init`'));
  }

  // Repo config
  if (repoPath) {
    console.log(chalk.green(`  ✓ Git repo`) + chalk.gray(` ${repoPath}`));
    if (repoConfig) {
      if (repoConfig.agent) {
        console.log(chalk.gray(`    Linked agent: ${repoConfig.agent}`));
      }
      if (repoConfig.ignorePatterns?.length) {
        console.log(chalk.gray(`    Custom ignore patterns: ${repoConfig.ignorePatterns.length}`));
      }
    }
  } else {
    console.log(chalk.yellow(`  ⚠ Not in a git repository`));
  }

  // Active sessions
  if (result.activeSessions?.length > 0) {
    console.log(chalk.green(`  ✓ ${result.activeSessions.length} active session${result.activeSessions.length !== 1 ? 's' : ''}`));
    for (const s of result.activeSessions) {
      const age = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000);
      console.log(chalk.gray(`    ${s.sessionId.slice(0, 8)} — ${s.model} — ${age}m — ${s.branch || 'unknown branch'}`));
    }
  } else if (repoPath) {
    console.log(chalk.gray(`  ○ No active sessions`));
  }

  // Attribution
  if (result.attribution) {
    const a = result.attribution;
    console.log('');
    console.log(chalk.bold('  Attribution (last 50 commits)'));
    console.log('');

    const aiBar = renderBar(a.aiCommitsPct);
    const lineBar = renderBar(a.aiLinesPct);
    console.log(`  ${chalk.gray('AI commits:')}  ${aiBar} ${chalk.white(a.aiCommitsPct + '%')}  ${chalk.gray(`(${a.aiCommits}/${a.totalCommits})`)}`);
    console.log(`  ${chalk.gray('AI lines:')}    ${lineBar} ${chalk.white(a.aiLinesPct + '%')}  ${chalk.gray(`(${a.aiLinesAdded}/${a.totalLinesAdded})`)}`);

    if (Object.keys(a.tools).length > 0) {
      console.log('');
      for (const [tool, data] of Object.entries(a.tools) as [string, any][]) {
        console.log(chalk.gray(`    ${tool}: ${data.commits} commits, ${data.linesAdded} lines`));
      }
    }
  }

  console.log('');
}

function renderBar(pct: number, width: number = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}
