import chalk from 'chalk';
import { loadConfig, requirePlatform } from '../config.js';
import { api } from '../api.js';
import { getGitRoot } from '../session-state.js';
import { describeCondition, describeAction, policyTypeLabel } from '../utils/policy-descriptions.js';

export async function policiesCommand() {
  if (!requirePlatform('policies')) return;
  const config = loadConfig();
  if (!config) return;

  console.log(chalk.bold('\nActive Policies\n'));

  try {
    const data = await api.getPolicies() as any;
    const policies = data.policies ?? data;

    if (!Array.isArray(policies) || policies.length === 0) {
      console.log(chalk.gray('  No active policies found.'));
      console.log(chalk.gray('  Create policies at your Origin dashboard.\n'));
      return;
    }

    // Detect current repo for matching
    let currentRepoId: string | null = null;
    try {
      const cwd = process.cwd();
      const gitRoot = getGitRoot(cwd);
      if (gitRoot) {
        const repos = await api.getRepos() as any;
        const repoList = repos.repos ?? repos;
        if (Array.isArray(repoList)) {
          const match = repoList.find((r: any) => r.path && gitRoot.endsWith(r.path.replace(/^.*\//, '')));
          if (match) currentRepoId = match.id;
        }
      }
    } catch { /* ignore repo detection errors */ }

    // Group by type
    const groups = new Map<string, any[]>();
    for (const policy of policies) {
      const type = policy.type || 'OTHER';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type)!.push(policy);
    }

    let totalRules = 0;
    let repoRules = 0;

    for (const [type, typePolicies] of groups) {
      console.log(chalk.bold.white(`  ${policyTypeLabel(type).toUpperCase()}`));
      console.log('');

      for (const policy of typePolicies) {
        const status = policy.active !== false ? chalk.green('\u25CF') : chalk.red('\u25CB');
        console.log(`  ${status} ${chalk.white.bold(policy.name || policy.id)}`);
        if (policy.description) {
          console.log(chalk.gray(`    ${policy.description}`));
        }
        // Show assigned agents
        const assignedAgents = policy.assignedAgents || [];
        if (assignedAgents.length > 0) {
          const agentNames = assignedAgents.map((a: any) => a.name).join(', ');
          console.log(chalk.blue(`    Agents: ${agentNames}`));
        } else {
          console.log(chalk.gray('    Scope: org-wide'));
        }

        const rules = policy.rules || [];
        for (const rule of rules) {
          totalRules++;
          const desc = describeCondition(type, rule.condition);
          const action = describeAction(rule.action);

          // Color code by action
          let actionStr: string;
          switch (rule.action?.toUpperCase()) {
            case 'BLOCK': actionStr = chalk.red(action); break;
            case 'REQUIRE_REVIEW': actionStr = chalk.yellow(action); break;
            case 'WARN': actionStr = chalk.cyan(action); break;
            default: actionStr = chalk.gray(action);
          }

          const isThisRepo = currentRepoId && rule.repoId === currentRepoId;
          if (isThisRepo) repoRules++;

          const repoTag = isThisRepo ? chalk.magenta(' [THIS REPO]') : '';
          const severityTag = rule.severity ? chalk.gray(` [${rule.severity}]`) : '';

          console.log(`    ${chalk.gray('\u2192')} ${desc.summary}`);
          console.log(`      ${actionStr}${severityTag}${repoTag}`);
        }
        console.log('');
      }
    }

    const repoMsg = currentRepoId ? ` (${repoRules} apply to this repo)` : '';
    console.log(chalk.gray(`  Total: ${policies.length} policies, ${totalRules} rules${repoMsg}\n`));
  } catch (err: any) {
    console.log(chalk.red(`  Failed to fetch policies: ${err.message}\n`));
    process.exit(1);
  }
}
