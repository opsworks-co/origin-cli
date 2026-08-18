// Human-facing MCP commands: `origin mcp install` / `origin mcp status`.
//
// Kept OUT of commands/mcp.ts on purpose. That file holds `mcp serve`, whose
// stdout is the JSON-RPC channel — a single console.log there breaks the client
// handshake — and a test asserts the whole file is free of stdout writes. These
// commands legitimately print, so they live here where that rule doesn't apply.
import chalk from 'chalk';
import fs from 'fs';
import { execFileSync } from 'child_process';
import {
  MCP_SUPPORTED_AGENTS,
  installMcpForAgent,
  uninstallMcpForAgent,
  mcpConfigPath,
  mcpServerCommand,
  mcpCapable,
  type McpAgentSlug,
} from '../mcp/install.js';

function gitRootOrCwd(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
}

function parseAgents(raw?: string): McpAgentSlug[] {
  if (!raw) return MCP_SUPPORTED_AGENTS;
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.filter((w) => !MCP_SUPPORTED_AGENTS.includes(w as McpAgentSlug));
  if (unknown.length) {
    throw new Error(
      `Unknown agent(s): ${unknown.join(', ')}. Supported: ${MCP_SUPPORTED_AGENTS.join(', ')}`,
    );
  }
  return wanted as McpAgentSlug[];
}

/**
 * `origin mcp install` — point each agent's MCP config at `origin mcp serve`.
 *
 * Only agents whose config location is verified against a real install are
 * touched. Writing a file an agent never reads is worse than writing nothing:
 * it reports success and changes no behaviour, which is precisely how the old
 * standalone MCP package sat unused for a month.
 */
export async function mcpInstallCommand(opts: { agent?: string; uninstall?: boolean; force?: boolean } = {}): Promise<void> {
  let agents: McpAgentSlug[];
  try {
    agents = parseAgents(opts.agent);
  } catch (err: any) {
    console.log(chalk.red(`  ✗ ${err.message}`));
    process.exitCode = 1;
    return;
  }

  const gitRoot = gitRootOrCwd();
  const { command, args } = mcpServerCommand();
  const verb = opts.uninstall ? 'Removing' : 'Registering';
  console.log(chalk.bold(`\n  ${verb} Origin's MCP server\n`));
  if (!opts.uninstall) {
    console.log(chalk.gray(`  ${command} ${args.join(' ')}\n`));

    // Refuse to record a binary that can't serve MCP. Writing it anyway
    // produces a config the agent spawns and watches die — present, broken,
    // and silent. Better to fail here, loudly, having changed nothing.
    if (!opts.force && !mcpCapable(command)) {
      console.log(chalk.red('  ✗ That binary does not support `mcp serve`.\n'));
      console.log(chalk.gray('    It is most likely an older release than the one you are running'));
      console.log(chalk.gray('    from source. Registering it would give your agent a server that'));
      console.log(chalk.gray('    exits the moment it starts.\n'));
      console.log(chalk.gray('    Upgrade the installed CLI, then re-run:\n'));
      console.log('      origin upgrade\n');
      console.log(chalk.gray('    (or re-run with --force if you know the path is right)\n'));
      process.exitCode = 1;
      return;
    }
    if (command === 'origin') {
      console.log(chalk.yellow(
        "  ! Couldn't resolve an absolute path to the origin binary; using the bare\n" +
        '    name. If your agent starts without your shell PATH, the server will\n' +
        '    fail to spawn. Re-run after `origin` is on PATH to bake in a full path.\n',
      ));
    }
  }

  let changed = 0;
  for (const agent of agents) {
    const r = opts.uninstall ? uninstallMcpForAgent(agent, gitRoot) : installMcpForAgent(agent, gitRoot);
    const where = r.file.replace(process.env.HOME || '~', '~');
    switch (r.status) {
      case 'installed':
      case 'updated':
        changed++;
        console.log(`  ${chalk.green('✓')} ${agent.padEnd(7)} ${chalk.gray(where)}`);
        break;
      case 'unchanged':
        console.log(`  ${chalk.gray('·')} ${agent.padEnd(7)} ${chalk.gray(`${where} (already current)`)}`);
        break;
      case 'failed':
        console.log(`  ${chalk.red('✗')} ${agent.padEnd(7)} ${chalk.gray(where)} — ${r.detail}`);
        process.exitCode = 1;
        break;
      default:
        console.log(`  ${chalk.gray('-')} ${agent.padEnd(7)} ${chalk.gray('skipped')}`);
    }
    if (r.legacy) {
      const lw = r.legacy.file.replace(process.env.HOME || '~', '~');
      const what = r.legacy.action === 'removed-file' ? 'removed' : 'entry removed';
      console.log(`  ${chalk.gray(' ')} ${''.padEnd(7)} ${chalk.gray(`↳ ${what} superseded ${lw}`)}`);
    }
  }

  if (!opts.uninstall && changed > 0) {
    // Devin reads the SAME project-scoped .mcp.json Claude Code does, so the
    // claude writer covers it with no entry of its own. Say so — otherwise a
    // Devin user sees no `devin` row and hand-adds a duplicate.
    if (agents.includes('claude')) {
      console.log(chalk.gray('\n  .mcp.json also serves Devin (`devin mcp list` to confirm).'));
    }
    console.log(chalk.gray('\n  Restart the agent to pick this up. Claude Code and Cursor will'));
    console.log(chalk.gray('  ask you to approve the server before its tools become available.'));
  }
  console.log();
}

/** `origin mcp status` — what's registered where, without changing anything. */
export async function mcpStatusCommand(): Promise<void> {
  const gitRoot = gitRootOrCwd();
  const { command, args } = mcpServerCommand();
  console.log(chalk.bold('\n  Origin MCP registration\n'));
  console.log(chalk.gray(`  server: ${command} ${args.join(' ')}\n`));

  for (const agent of MCP_SUPPORTED_AGENTS) {
    const file = mcpConfigPath(agent, gitRoot);
    const where = file.replace(process.env.HOME || '~', '~');
    if (!fs.existsSync(file)) {
      console.log(`  ${chalk.gray('·')} ${agent.padEnd(7)} ${chalk.gray('no config file')}`);
      continue;
    }
    const body = fs.readFileSync(file, 'utf-8');
    const registered = agent === 'codex'
      ? body.includes('[mcp_servers.origin]')
      : (() => { try { return !!JSON.parse(body)?.mcpServers?.origin; } catch { return false; } })();
    console.log(registered
      ? `  ${chalk.green('✓')} ${agent.padEnd(7)} ${chalk.gray(where)}`
      : `  ${chalk.gray('·')} ${agent.padEnd(7)} ${chalk.gray(`${where} (not registered)`)}`);
  }
  console.log(chalk.gray('\n  origin mcp install    register    ·    origin mcp install --uninstall    remove\n'));
}
