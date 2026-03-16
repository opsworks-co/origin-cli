import chalk from 'chalk';
import { loadConfig, loadAgentConfig, loadRepoConfig } from '../config.js';
import { api } from '../api.js';
import { loadSessionState, getGitRoot, getBranch, getHeadSha } from '../session-state.js';
import { execSync } from 'child_process';

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export async function statusCommand() {
  const config = loadConfig();
  const agentConfig = loadAgentConfig();

  console.log(chalk.bold('\n  Origin Status\n'));

  // Login status
  if (!config) {
    console.log(chalk.red('  ✗ Not logged in'));
    console.log(chalk.gray('    Run: origin login'));
    return;
  }
  console.log(chalk.green('  ✓ Logged in'));
  console.log(chalk.gray(`    API: ${config.apiUrl}`));
  console.log(chalk.gray(`    Org: ${config.orgId || 'unknown'}`));

  // Agent status
  if (!agentConfig) {
    console.log(chalk.yellow('\n  ⚠ Agent not initialized'));
    console.log(chalk.gray('    Run: origin init'));
  } else {
    console.log(chalk.green('\n  ✓ Agent initialized'));
    console.log(chalk.gray(`    Machine: ${agentConfig.hostname} (${agentConfig.machineId.slice(0, 8)}...)`));
    console.log(chalk.gray(`    Tools: ${agentConfig.detectedTools.length > 0 ? agentConfig.detectedTools.join(', ') : 'none'}`));
  }

  // ── Active Session ──────────────────────────────────────────────
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  const state = loadSessionState(cwd);

  if (state) {
    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    const branch = state.branch || getBranch(cwd);
    const headSha = getHeadSha(cwd);

    console.log(chalk.magenta('\n  ● Active Session'));
    console.log(chalk.gray(`    Session ID:  ${chalk.white(state.sessionId)}`));
    console.log(chalk.gray(`    Model:       ${chalk.cyan(state.model)}`));
    console.log(chalk.gray(`    Duration:    ${chalk.white(formatDuration(durationMs))}`));
    if (branch) {
      console.log(chalk.gray(`    Branch:      ${chalk.yellow(branch)}`));
    }
    if (headSha) {
      console.log(chalk.gray(`    HEAD:        ${chalk.white(headSha.slice(0, 8))}`));
    }
    if (state.headShaAtStart) {
      console.log(chalk.gray(`    Start HEAD:  ${chalk.white(state.headShaAtStart.slice(0, 8))}`));
    }
    console.log(chalk.gray(`    Prompts:     ${chalk.white(String(state.prompts.length))}`));
    console.log(chalk.gray(`    Repo:        ${chalk.white(state.repoPath)}`));

    if (state.transcriptPath) {
      console.log(chalk.gray(`    Transcript:  ${chalk.white(state.transcriptPath)}`));
    }

    // Show new commits since session started
    if (state.headShaAtStart && headSha && state.headShaAtStart !== headSha) {
      try {
        const commitCount = execSync(
          `git rev-list --count ${state.headShaAtStart}..${headSha}`,
          { encoding: 'utf-8', cwd: repoPath || cwd, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        console.log(chalk.gray(`    New commits: ${chalk.green(commitCount)}`));
      } catch { /* ignore */ }
    }

    // Origin dashboard link
    const apiUrl = config?.apiUrl || 'https://getorigin.io';
    console.log(chalk.gray(`    Dashboard:   ${chalk.blue(`${apiUrl}/sessions/${state.sessionId}`)}`));
  } else if (repoPath) {
    console.log(chalk.gray('\n  No active session in this repo'));
  }

  // ── Repo Context ────────────────────────────────────────────────
  if (repoPath) {
    const repoConfig = loadRepoConfig(repoPath);
    const branch = getBranch(cwd);

    console.log(chalk.bold('\n  Repository'));
    console.log(chalk.gray(`    Path:        ${chalk.white(repoPath)}`));
    if (branch) {
      console.log(chalk.gray(`    Branch:      ${chalk.yellow(branch)}`));
    }
    if (repoConfig?.agent) {
      console.log(chalk.gray(`    Agent link:  ${chalk.cyan(repoConfig.agent)}`));
    }

    // Check for origin-sessions branch (entrypoints)
    try {
      const entrypointCount = execSync(
        'git log origin-sessions --oneline 2>/dev/null | wc -l',
        { encoding: 'utf-8', cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (parseInt(entrypointCount) > 0) {
        console.log(chalk.gray(`    Entrypoints: ${chalk.green(entrypointCount)} sessions on origin-sessions branch`));
      }
    } catch { /* ignore */ }

    // Check for git notes
    try {
      const noteCount = execSync(
        'git notes --ref=origin list 2>/dev/null | wc -l',
        { encoding: 'utf-8', cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (parseInt(noteCount) > 0) {
        console.log(chalk.gray(`    Git notes:   ${chalk.green(noteCount)} commits annotated`));
      }
    } catch { /* ignore */ }
  }

  // ── Policies & API Health ───────────────────────────────────────
  try {
    const data = await api.getPolicies() as any;
    const policies = data.policies ?? data;
    const count = Array.isArray(policies) ? policies.length : 0;
    console.log(chalk.green(`\n  ✓ ${count} active ${count === 1 ? 'policy' : 'policies'}`));
  } catch (err: any) {
    console.log(chalk.yellow(`\n  ⚠ Could not fetch policies: ${err.message}`));
  }

  try {
    const res = await fetch(`${config.apiUrl}/api/mcp/policies`, {
      headers: { 'X-API-Key': config.apiKey },
    });
    if (res.ok) {
      console.log(chalk.green('  ✓ API connection healthy'));
    } else {
      console.log(chalk.red(`  ✗ API returned ${res.status}`));
    }
  } catch {
    console.log(chalk.red('  ✗ Cannot reach Origin API'));
  }

  console.log('');
}
